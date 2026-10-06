import { Router } from 'express';

import { OrderStatus } from '../../../generated/prisma/client.js';
import { sendSuccess } from '../../../lib/http.js';
import { prisma } from '../../../lib/prisma.js';
import { shopDayRange } from '../../../lib/time.js';
import { listRecentOrders } from '../orders/admin-orders.service.js';

const RECENT_ORDER_COUNT = 10;
const LOW_STOCK_LIST_SIZE = 10;

type LowStockRow = {
  id: string;
  name: string;
  sku: string;
  stockQuantity: number;
  reservedQuantity: number;
  lowStockThreshold: number;
};

/**
 * Dashboard figures. "Today" is the shop's calendar day in IST (see lib/time.ts); all
 * amounts are integer paise. What each figure means:
 *
 *  todayOrders            orders placed today, whatever became of them
 *  pendingOrders          orders the shop still has to act on: PLACED, CONFIRMED or PACKED
 *  outForDeliveryOrders   orders currently OUT_FOR_DELIVERY
 *  deliveredToday         orders marked DELIVERED today
 *  todayRevenuePaise      the grand total of orders DELIVERED today. Revenue is recognised
 *                         on delivery, and it says nothing about whether the cash was taken
 *  cashCollectedTodayPaise  the grand total of orders whose payment was marked COLLECTED
 *                         today. It can include orders delivered on an earlier day, and
 *                         it is never inferred from delivery
 *  cashPendingPaise       cash still owed on DELIVERED orders whose payment is PENDING
 *  deliveredUnpaidOrders  how many orders that is
 *  lowStockCount          active products whose AVAILABLE stock (stock - reserved) is at or
 *                         below their low-stock threshold
 */
export async function getDashboard(now: Date) {
  const { start, end } = shopDayRange(now);
  const today = { gte: start, lt: end };

  const [
    todayOrders,
    statusCounts,
    deliveredToday,
    revenue,
    cashCollected,
    cashPending,
    lowStockProducts,
    recentOrders,
  ] = await Promise.all([
    prisma.order.count({ where: { createdAt: today } }),
    prisma.order.groupBy({ by: ['orderStatus'], _count: { _all: true } }),
    prisma.order.count({ where: { deliveredAt: today } }),
    prisma.order.aggregate({ where: { deliveredAt: today }, _sum: { grandTotalPaise: true } }),
    prisma.order.aggregate({
      where: { paymentCollectedAt: today },
      _sum: { grandTotalPaise: true },
    }),
    prisma.order.aggregate({
      where: { orderStatus: 'DELIVERED', paymentStatus: 'PENDING' },
      _sum: { grandTotalPaise: true },
      _count: { _all: true },
    }),
    // Compares two columns, which the query builder cannot express, hence raw SQL.
    prisma.$queryRaw<LowStockRow[]>`
      SELECT "id", "name", "sku", "stockQuantity", "reservedQuantity", "lowStockThreshold"
      FROM "Product"
      WHERE "isActive" = true AND ("stockQuantity" - "reservedQuantity") <= "lowStockThreshold"
      ORDER BY ("stockQuantity" - "reservedQuantity") ASC, "name" ASC
    `,
    listRecentOrders(RECENT_ORDER_COUNT),
  ]);

  const ordersByStatus = Object.fromEntries(
    Object.values(OrderStatus).map((status) => [status, 0])
  ) as Record<OrderStatus, number>;
  for (const row of statusCounts) {
    ordersByStatus[row.orderStatus] = row._count._all;
  }

  return {
    generatedAt: now,
    today: { start, end },
    todayOrders,
    pendingOrders: ordersByStatus.PLACED + ordersByStatus.CONFIRMED + ordersByStatus.PACKED,
    outForDeliveryOrders: ordersByStatus.OUT_FOR_DELIVERY,
    deliveredToday,
    todayRevenuePaise: revenue._sum.grandTotalPaise ?? 0,
    cashCollectedTodayPaise: cashCollected._sum.grandTotalPaise ?? 0,
    cashPendingPaise: cashPending._sum.grandTotalPaise ?? 0,
    deliveredUnpaidOrders: cashPending._count._all,
    lowStockCount: lowStockProducts.length,
    ordersByStatus,
    recentOrders,
    lowStockProducts: lowStockProducts.slice(0, LOW_STOCK_LIST_SIZE).map((product) => ({
      ...product,
      availableQuantity: product.stockQuantity - product.reservedQuantity,
    })),
  };
}

export const adminDashboardRouter = Router();

adminDashboardRouter.get('/', async (_req, res) => {
  sendSuccess(res, await getDashboard(new Date()));
});
