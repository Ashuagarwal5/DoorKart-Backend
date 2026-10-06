import type { OrderStatus, Prisma } from '../../../generated/prisma/client.js';
import { conflict, notFound, unprocessable } from '../../../lib/errors.js';
import { phoneSearchDigits } from '../../../lib/mobile.js';
import { pageArgs, pageResult } from '../../../lib/pagination.js';
import { prisma } from '../../../lib/prisma.js';
import { shopDateRange } from '../../../lib/time.js';
import type { AdminContext } from '../auth/session.js';
import {
  addStatusHistory,
  CASH_COLLECTION_STATUSES,
  claimStatusChange,
  ORDER_TRANSITIONS,
  recordSale,
  releaseReservations,
  statusesThatCanMoveTo,
} from '../../orders/order-lifecycle.js';
import type { ListOrdersQuery } from './admin-orders.schemas.js';

/**
 * Note what is NOT selected anywhere in this file: trackingToken (the customer's access
 * credential), requestFingerprint and clientRequestId. Admin responses never carry them.
 */

const listSelect = {
  id: true,
  orderNumber: true,
  customerName: true,
  customerPhone: true,
  area: true,
  subtotalPaise: true,
  deliveryChargePaise: true,
  discountPaise: true,
  grandTotalPaise: true,
  paymentMethod: true,
  paymentStatus: true,
  orderStatus: true,
  createdAt: true,
  deliveredAt: true,
  items: { select: { quantity: true } },
} satisfies Prisma.OrderSelect;

type ListedOrder = Prisma.OrderGetPayload<{ select: typeof listSelect }>;

function toListItem(order: ListedOrder) {
  const { items, ...rest } = order;
  return { ...rest, itemCount: items.reduce((count, item) => count + item.quantity, 0) };
}

const detailInclude = {
  items: { orderBy: { productName: 'asc' } },
  statusHistory: {
    orderBy: { createdAt: 'asc' },
    include: { adminUser: { select: { id: true, name: true } } },
  },
  paymentHistory: {
    orderBy: { createdAt: 'asc' },
    include: { adminUser: { select: { id: true, name: true } } },
  },
} satisfies Prisma.OrderInclude;

type DetailedOrder = Prisma.OrderGetPayload<{ include: typeof detailInclude }>;

function toDetail(order: DetailedOrder) {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    customerId: order.customerId,
    customerName: order.customerName,
    customerPhone: order.customerPhone,
    deliveryAddress: {
      addressLine1: order.addressLine1,
      addressLine2: order.addressLine2,
      landmark: order.landmark,
      area: order.area,
      city: order.city,
      pincode: order.pincode,
    },
    deliveryAreaId: order.deliveryAreaId,
    items: order.items.map((item) => ({
      productId: item.productId,
      productName: item.productName,
      sku: item.sku,
      productImage: item.productImage,
      unitPricePaise: item.unitPricePaise,
      quantity: item.quantity,
      lineTotalPaise: item.lineTotalPaise,
    })),
    subtotalPaise: order.subtotalPaise,
    deliveryChargePaise: order.deliveryChargePaise,
    discountPaise: order.discountPaise,
    grandTotalPaise: order.grandTotalPaise,
    paymentMethod: order.paymentMethod,
    paymentStatus: order.paymentStatus,
    orderStatus: order.orderStatus,
    // What the admin panel may offer next, straight from the server's rules.
    allowedNextStatuses: ORDER_TRANSITIONS[order.orderStatus],
    canCollectPayment:
      order.paymentStatus === 'PENDING' && CASH_COLLECTION_STATUSES.includes(order.orderStatus),
    statusHistory: order.statusHistory.map((entry) => ({
      status: entry.status,
      note: entry.note,
      createdAt: entry.createdAt,
      changedBy: entry.adminUser,
    })),
    paymentHistory: order.paymentHistory.map((entry) => ({
      fromStatus: entry.fromStatus,
      toStatus: entry.toStatus,
      note: entry.note,
      createdAt: entry.createdAt,
      changedBy: entry.adminUser,
    })),
    createdAt: order.createdAt,
    updatedAt: order.updatedAt,
    cancelledAt: order.cancelledAt,
    deliveredAt: order.deliveredAt,
    paymentCollectedAt: order.paymentCollectedAt,
  };
}

export type AdminOrderDetail = ReturnType<typeof toDetail>;

function buildListWhere(query: ListOrdersQuery): Prisma.OrderWhereInput {
  const { start, end } = shopDateRange(query.from, query.to);
  const phoneDigits = query.search ? phoneSearchDigits(query.search) : null;

  return {
    ...(query.status ? { orderStatus: query.status } : {}),
    ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
    ...(start || end ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {}),
    ...(query.search
      ? {
          OR: [
            { orderNumber: { contains: query.search, mode: 'insensitive' } },
            { customerName: { contains: query.search, mode: 'insensitive' } },
            ...(phoneDigits ? [{ customerPhone: { contains: phoneDigits } }] : []),
          ],
        }
      : {}),
  };
}

export async function listOrders(query: ListOrdersQuery) {
  const where = buildListWhere(query);
  const [total, orders] = await Promise.all([
    prisma.order.count({ where }),
    prisma.order.findMany({
      where,
      select: listSelect,
      // `id` breaks ties so pages never overlap or skip rows.
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      ...pageArgs(query),
    }),
  ]);
  return pageResult(orders.map(toListItem), total, query);
}

/** The newest orders, in the list shape; used by the dashboard. */
export async function listRecentOrders(limit: number) {
  const orders = await prisma.order.findMany({
    select: listSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: limit,
  });
  return orders.map(toListItem);
}

export async function getOrderDetail(id: string): Promise<AdminOrderDetail> {
  const order = await prisma.order.findUnique({ where: { id }, include: detailInclude });
  if (!order) {
    throw notFound('ORDER_NOT_FOUND', 'This order does not exist.');
  }
  return toDetail(order);
}

type Rejection = { orderStatus: OrderStatus; paymentStatus: string } | null;

function rejectStatusChange(to: OrderStatus, current: Rejection) {
  if (!current) {
    return notFound('ORDER_NOT_FOUND', 'This order does not exist.');
  }
  const canNormallyMove = ORDER_TRANSITIONS[current.orderStatus].includes(to);
  if (canNormallyMove && current.paymentStatus !== 'PENDING') {
    // Reaching here means the move was only blocked by cash already taken.
    return conflict(
      'INVALID_ORDER_TRANSITION',
      'Cash has already been collected for this order, and refunds are not supported yet.',
      { from: current.orderStatus, to }
    );
  }
  return conflict(
    'INVALID_ORDER_TRANSITION',
    `An order that is ${current.orderStatus} cannot be changed to ${to}.`,
    { from: current.orderStatus, to, allowed: ORDER_TRANSITIONS[current.orderStatus] }
  );
}

/**
 * Moves an order to `to`. The server decides whether that is allowed: the guard is part of
 * the UPDATE, so simultaneous or repeated requests cannot run a stock movement twice. Every
 * change, with its stock movement, history entry and (for delivery and cancellation) its
 * timestamp, happens in one transaction: all of it or none of it.
 */
export async function changeOrderStatus(
  id: string,
  to: OrderStatus,
  note: string | null,
  admin: AdminContext
): Promise<AdminOrderDetail> {
  await prisma.$transaction(async (tx) => {
    const now = new Date();

    await claimStatusChange(tx, {
      orderId: id,
      allowedFrom: statusesThatCanMoveTo(to),
      to,
      extras:
        to === 'CANCELLED' ? { cancelledAt: now } : to === 'DELIVERED' ? { deliveredAt: now } : {},
      // Giving up on an order whose cash was taken would need a refund, which is not built.
      requirePaymentPending: to === 'CANCELLED' || to === 'DELIVERY_FAILED',
      reject: (current) => rejectStatusChange(to, current),
    });

    if (to === 'CANCELLED' || to === 'DELIVERED') {
      // Read after the claim: from here this transaction owns the order's status.
      const items = await tx.orderItem.findMany({
        where: { orderId: id },
        select: { productId: true, quantity: true },
      });
      if (to === 'CANCELLED') {
        await releaseReservations(tx, id, items, admin.id);
      } else {
        await recordSale(tx, id, items, admin.id);
      }
    }

    await addStatusHistory(tx, id, to, note, admin.id);
  });

  return getOrderDetail(id);
}

/**
 * Records cash collection. It is separate from delivery on purpose: an order can be
 * DELIVERED with payment still PENDING. Only PENDING -> COLLECTED exists, and only once the
 * goods are on the road or delivered.
 */
export async function recordPayment(
  id: string,
  paymentStatus: 'PENDING' | 'COLLECTED' | 'REFUNDED',
  note: string | null,
  admin: AdminContext
): Promise<AdminOrderDetail> {
  if (paymentStatus !== 'COLLECTED') {
    throw conflict(
      'INVALID_PAYMENT_TRANSITION',
      'Only marking a pending payment as COLLECTED is supported.',
      { to: paymentStatus }
    );
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.order.updateMany({
      where: {
        id,
        paymentStatus: 'PENDING',
        orderStatus: { in: [...CASH_COLLECTION_STATUSES] },
      },
      data: { paymentStatus: 'COLLECTED', paymentCollectedAt: new Date() },
    });

    if (count === 0) {
      const current = await tx.order.findUnique({
        where: { id },
        select: { orderStatus: true, paymentStatus: true },
      });
      if (!current) {
        throw notFound('ORDER_NOT_FOUND', 'This order does not exist.');
      }
      if (current.paymentStatus !== 'PENDING') {
        throw conflict(
          'INVALID_PAYMENT_TRANSITION',
          `This order's payment is already ${current.paymentStatus}.`,
          { from: current.paymentStatus, to: paymentStatus }
        );
      }
      throw unprocessable(
        'PAYMENT_NOT_ALLOWED',
        'Cash can only be collected once the order is out for delivery or delivered.',
        { orderStatus: current.orderStatus }
      );
    }

    await tx.paymentStatusHistory.create({
      data: {
        orderId: id,
        fromStatus: 'PENDING',
        toStatus: 'COLLECTED',
        note,
        adminUserId: admin.id,
      },
    });
  });

  return getOrderDetail(id);
}
