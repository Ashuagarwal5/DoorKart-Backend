/**
 * The rules for moving an order through its life, and the stock movements that go with
 * it. Customer cancellation and every admin action use these same functions, so there is
 * one definition of "valid transition" and one implementation of reserving, releasing and
 * selling stock.
 *
 * Stock model: placing an order RESERVES units (reservedQuantity goes up, stockQuantity is
 * untouched). Cancelling RELEASES them. Delivering SELLS them: both reservedQuantity and
 * stockQuantity go down by the ordered quantity. Available stock = stockQuantity - reservedQuantity.
 */

import type { OrderStatus } from '../../generated/prisma/client.js';
import { type AppError, conflict } from '../../lib/errors.js';
import type { TransactionClient } from '../../lib/prisma.js';

/**
 * Which status an order may move to from each status. This table is the whole rulebook.
 *
 *  - PACKED can still be cancelled: nothing irreversible has happened yet. Stock is only
 *    reserved, not deducted, and no cash has been taken.
 *  - OUT_FOR_DELIVERY cannot be cancelled: the goods are on the road. If the customer is
 *    not there or refuses, the order becomes DELIVERY_FAILED.
 *  - DELIVERY_FAILED keeps its reservation (the goods are back on the shelf, the order is
 *    not over). It can go out again, or be cancelled, which releases the stock.
 *  - DELIVERED and CANCELLED are final.
 */
export const ORDER_TRANSITIONS: Record<OrderStatus, readonly OrderStatus[]> = {
  PLACED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['PACKED', 'CANCELLED'],
  PACKED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'DELIVERY_FAILED'],
  DELIVERY_FAILED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Every status an order may be in just before moving to `to`. */
export function statusesThatCanMoveTo(to: OrderStatus): OrderStatus[] {
  return (Object.keys(ORDER_TRANSITIONS) as OrderStatus[]).filter((from) =>
    canTransition(from, to)
  );
}

/** Cash can only be taken once the goods are with the customer or on their way. */
export const CASH_COLLECTION_STATUSES: readonly OrderStatus[] = ['OUT_FOR_DELIVERY', 'DELIVERED'];

type StatusChangeExtras = { cancelledAt?: Date; deliveredAt?: Date };

/**
 * Moves an order to `to`, but only if it is currently in one of `allowedFrom`. The check is
 * part of the UPDATE itself, so of two simultaneous requests exactly one matches the row;
 * the other changes nothing and is rejected by `reject`. That is what stops a stock
 * movement from running twice.
 *
 * `extraWhere` adds further conditions that must hold in that same instant.
 */
export async function claimStatusChange(
  tx: TransactionClient,
  options: {
    orderId: string;
    allowedFrom: readonly OrderStatus[];
    to: OrderStatus;
    extras?: StatusChangeExtras;
    requirePaymentPending?: boolean;
    reject: (current: { orderStatus: OrderStatus; paymentStatus: string } | null) => AppError;
  }
): Promise<void> {
  const { count } = await tx.order.updateMany({
    where: {
      id: options.orderId,
      orderStatus: { in: [...options.allowedFrom] },
      ...(options.requirePaymentPending ? { paymentStatus: 'PENDING' as const } : {}),
    },
    data: { orderStatus: options.to, ...options.extras },
  });

  if (count === 0) {
    const current = await tx.order.findUnique({
      where: { id: options.orderId },
      select: { orderStatus: true, paymentStatus: true },
    });
    throw options.reject(current);
  }
}

type OrderLine = { productId: string; quantity: number };

/** Lines in a fixed order, so concurrent operations on shared products cannot deadlock. */
function inLockOrder(items: OrderLine[]): OrderLine[] {
  return [...items].sort((a, b) => a.productId.localeCompare(b.productId));
}

/**
 * Gives reserved units back: reservedQuantity goes down, nothing else moves, and a RELEASE
 * is recorded per product. Throws if a reservation is smaller than expected, which would
 * mean the books are already wrong; the transaction then rolls back.
 */
export async function releaseReservations(
  tx: TransactionClient,
  orderId: string,
  items: OrderLine[],
  adminUserId?: string
): Promise<void> {
  const lines = inLockOrder(items);
  for (const item of lines) {
    const releasedRows = await tx.$executeRaw`
      UPDATE "Product"
      SET "reservedQuantity" = "reservedQuantity" - ${item.quantity}::int, "updatedAt" = NOW()
      WHERE "id" = ${item.productId} AND "reservedQuantity" >= ${item.quantity}::int
    `;
    if (releasedRows !== 1) {
      throw conflict(
        'INVENTORY_MISMATCH',
        'The reserved stock for this order does not add up, so it was not changed.',
        { productId: item.productId }
      );
    }
  }

  await tx.inventoryTransaction.createMany({
    data: lines.map((item) => ({
      productId: item.productId,
      orderId,
      type: 'RELEASE' as const,
      quantity: item.quantity,
      adminUserId,
    })),
  });
}

/**
 * Turns reserved units into sold units for a delivered order: stockQuantity AND
 * reservedQuantity both go down by the ordered quantity, and a SALE is recorded per product.
 * The WHERE clause refuses to take either below zero.
 */
export async function recordSale(
  tx: TransactionClient,
  orderId: string,
  items: OrderLine[],
  adminUserId?: string
): Promise<void> {
  const lines = inLockOrder(items);
  for (const item of lines) {
    const soldRows = await tx.$executeRaw`
      UPDATE "Product"
      SET "stockQuantity" = "stockQuantity" - ${item.quantity}::int,
          "reservedQuantity" = "reservedQuantity" - ${item.quantity}::int,
          "updatedAt" = NOW()
      WHERE "id" = ${item.productId}
        AND "reservedQuantity" >= ${item.quantity}::int
        AND "stockQuantity" >= ${item.quantity}::int
    `;
    if (soldRows !== 1) {
      throw conflict(
        'INVENTORY_MISMATCH',
        'The reserved stock for this order does not add up, so it was not changed.',
        { productId: item.productId }
      );
    }
  }

  await tx.inventoryTransaction.createMany({
    data: lines.map((item) => ({
      productId: item.productId,
      orderId,
      type: 'SALE' as const,
      quantity: item.quantity,
      adminUserId,
    })),
  });
}

export function addStatusHistory(
  tx: TransactionClient,
  orderId: string,
  status: OrderStatus,
  note: string | null,
  adminUserId?: string
) {
  return tx.orderStatusHistory.create({ data: { orderId, status, note, adminUserId } });
}
