import { Router } from 'express';
import { z } from 'zod';

import type { Prisma } from '../../../generated/prisma/client.js';
import { notFound } from '../../../lib/errors.js';
import { phoneSearchDigits } from '../../../lib/mobile.js';
import { sendSuccess } from '../../../lib/http.js';
import { paginationQuery, pageArgs, pageResult, searchText } from '../../../lib/pagination.js';
import { idParamsSchema } from '../../../lib/params.js';
import { prisma } from '../../../lib/prisma.js';

const listQuerySchema = z.object({
  ...paginationQuery,
  /** Name or mobile number. */
  search: searchText,
});

type Stats = { orderCount: number; totalOrderValuePaise: number; lastOrderAt: Date | null };

const NO_ORDERS: Stats = { orderCount: 0, totalOrderValuePaise: 0, lastOrderAt: null };

/**
 * Order figures for some customers in two grouped queries (not one per customer).
 *  - orderCount and lastOrderAt count every order, cancelled ones included.
 *  - totalOrderValuePaise is what the customer has actually bought: cancelled orders are
 *    left out, everything else (placed, in progress, delivered) is counted.
 */
async function loadStats(customerIds: string[]): Promise<Map<string, Stats>> {
  const [everything, bought] = await Promise.all([
    prisma.order.groupBy({
      by: ['customerId'],
      where: { customerId: { in: customerIds } },
      _count: { _all: true },
      _max: { createdAt: true },
    }),
    prisma.order.groupBy({
      by: ['customerId'],
      where: { customerId: { in: customerIds }, orderStatus: { not: 'CANCELLED' } },
      _sum: { grandTotalPaise: true },
    }),
  ]);

  const stats = new Map<string, Stats>();
  for (const row of everything) {
    stats.set(row.customerId, {
      orderCount: row._count._all,
      totalOrderValuePaise: 0,
      lastOrderAt: row._max.createdAt,
    });
  }
  for (const row of bought) {
    const entry = stats.get(row.customerId);
    if (entry) {
      entry.totalOrderValuePaise = row._sum.grandTotalPaise ?? 0;
    }
  }
  return stats;
}

function toAdminCustomer(
  customer: { id: string; fullName: string; mobile: string; createdAt: Date },
  stats: Stats
) {
  return {
    id: customer.id,
    name: customer.fullName,
    mobile: customer.mobile,
    createdAt: customer.createdAt,
    ...stats,
  };
}

export const adminCustomersRouter = Router();

adminCustomersRouter.get('/', async (req, res) => {
  const query = listQuerySchema.parse(req.query);
  const mobileDigits = query.search ? phoneSearchDigits(query.search) : null;

  const where: Prisma.CustomerWhereInput = query.search
    ? {
        OR: [
          { fullName: { contains: query.search, mode: 'insensitive' } },
          ...(mobileDigits ? [{ mobile: { contains: mobileDigits } }] : []),
        ],
      }
    : {};

  const [total, customers] = await Promise.all([
    prisma.customer.count({ where }),
    prisma.customer.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      ...pageArgs(query),
    }),
  ]);
  const stats = await loadStats(customers.map((customer) => customer.id));

  sendSuccess(
    res,
    pageResult(
      customers.map((customer) => toAdminCustomer(customer, stats.get(customer.id) ?? NO_ORDERS)),
      total,
      query
    )
  );
});

adminCustomersRouter.get('/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);

  const customer = await prisma.customer.findUnique({ where: { id } });
  if (!customer) {
    throw notFound('CUSTOMER_NOT_FOUND', 'This customer does not exist.');
  }

  const [stats, recentOrders] = await Promise.all([
    loadStats([id]),
    prisma.order.findMany({
      where: { customerId: id },
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      take: 20,
      select: {
        id: true,
        orderNumber: true,
        orderStatus: true,
        paymentStatus: true,
        grandTotalPaise: true,
        createdAt: true,
      },
    }),
  ]);

  sendSuccess(res, { ...toAdminCustomer(customer, stats.get(id) ?? NO_ORDERS), recentOrders });
});
