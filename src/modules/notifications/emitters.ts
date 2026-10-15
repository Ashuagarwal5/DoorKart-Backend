import type { OrderStatus } from '../../generated/prisma/client.js';
import type { TransactionClient } from '../../lib/prisma.js';
import { MAX_CONTEXT_ITEMS, type NotificationContext } from './context.js';
import { EVENT_KEYS, type EventKey } from './events.js';
import { enqueueNotificationEvent } from './outbox.js';

/**
 * The one place business code tells the notification system that something happened. Each
 * function is called from inside the transaction that made the change, after the change
 * itself, so the queued event commits or rolls back together with it.
 *
 * Nothing here may break the business operation: building the snapshot is wrapped so a
 * mistake in notification code is logged and skipped rather than failing an order,
 * a payment or a refund. Dedup keys are built from durable history rows, so a replay or a
 * second request for the same change can never queue a second notification.
 */

const ORDER_STATUS_EVENT: Record<OrderStatus, EventKey> = {
  PLACED: EVENT_KEYS.ORDER_PLACED,
  CONFIRMED: EVENT_KEYS.ORDER_CONFIRMED,
  PACKED: EVENT_KEYS.ORDER_PACKED,
  OUT_FOR_DELIVERY: EVENT_KEYS.ORDER_OUT_FOR_DELIVERY,
  DELIVERED: EVENT_KEYS.ORDER_DELIVERED,
  CANCELLED: EVENT_KEYS.ORDER_CANCELLED,
  DELIVERY_FAILED: EVENT_KEYS.ORDER_DELIVERY_FAILED,
};

async function safely(label: string, work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    // Message only: the snapshot holds customer details.
    const message = error instanceof Error ? error.message.slice(0, 200) : 'unknown error';
    console.error(`[notifications] could not queue ${label}: ${message}`);
  }
}

async function orderSnapshot(tx: TransactionClient, orderId: string) {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, accountId: true, orderNumber: true, orderStatus: true, paymentMethod: true, paymentStatus: true,
      subtotalPaise: true, deliveryChargePaise: true, grandTotalPaise: true, createdAt: true, deliveredAt: true,
      customerName: true, customerPhone: true, addressLine1: true, addressLine2: true, landmark: true,
      area: true, city: true, pincode: true,
      account: { select: { fullName: true, email: true } },
      items: {
        select: { productName: true, quantity: true, unitPricePaise: true, packLabel: true },
        orderBy: { productName: 'asc' },
        take: MAX_CONTEXT_ITEMS,
      },
    },
  });
  if (!order) return null;

  const context: NotificationContext = {
    customer: {
      name: order.account?.fullName ?? order.customerName,
      email: order.account?.email ?? null,
      mobile: order.customerPhone,
    },
    order: {
      number: order.orderNumber,
      status: order.orderStatus,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      subtotalPaise: order.subtotalPaise,
      deliveryChargePaise: order.deliveryChargePaise,
      totalPaise: order.grandTotalPaise,
      createdAt: order.createdAt.toISOString(),
      deliveredAt: order.deliveredAt?.toISOString() ?? null,
      address: [order.addressLine1, order.addressLine2, order.landmark, order.area, order.city, order.pincode]
        .filter((part): part is string => Boolean(part))
        .join(', '),
    },
    items: order.items.map((item) => ({
      name: item.productName,
      quantity: item.quantity,
      unitPricePaise: item.unitPricePaise,
      packLabel: item.packLabel,
    })),
  };
  return { accountId: order.accountId, orderId: order.id, context };
}

/** An order moved to `status`. `historyId` is the OrderStatusHistory row written for the move. */
export function emitOrderStatusEvent(tx: TransactionClient, orderId: string, status: OrderStatus, historyId: string) {
  const eventKey = ORDER_STATUS_EVENT[status];
  return safely(eventKey, async () => {
    const snapshot = await orderSnapshot(tx, orderId);
    if (!snapshot) return;
    await enqueueNotificationEvent(tx, {
      eventKey,
      dedupKey: `order-status:${historyId}`,
      accountId: snapshot.accountId,
      entityType: 'ORDER',
      entityId: snapshot.orderId,
      context: snapshot.context,
    });
  });
}

/** Cash was recorded as collected. `historyId` is the PaymentStatusHistory row. */
export function emitPaymentCollected(tx: TransactionClient, orderId: string, historyId: string) {
  return safely(EVENT_KEYS.PAYMENT_COLLECTED, async () => {
    const snapshot = await orderSnapshot(tx, orderId);
    if (!snapshot) return;
    await enqueueNotificationEvent(tx, {
      eventKey: EVENT_KEYS.PAYMENT_COLLECTED,
      dedupKey: `payment:${historyId}`,
      accountId: snapshot.accountId,
      entityType: 'ORDER',
      entityId: snapshot.orderId,
      context: snapshot.context,
    });
  });
}

export type ReturnEventDetails = {
  caseId: string;
  status: string;
  /** The amount the customer should read: requested, approved or paid, depending on the step. */
  amountPaise: number | null;
  reference: string | null;
};

/**
 * A return/refund case moved. `eventId` is the ReturnCaseEvent audit row for the action, so
 * the same action replayed with the same request id cannot notify twice.
 */
export function emitReturnEvents(
  tx: TransactionClient,
  orderId: string,
  eventId: string,
  keys: readonly EventKey[],
  details: ReturnEventDetails
) {
  return safely(keys.join('+'), async () => {
    const snapshot = await orderSnapshot(tx, orderId);
    if (!snapshot) return;
    const context: NotificationContext = {
      ...snapshot.context,
      return: {
        id: details.caseId,
        status: details.status,
        refundAmountPaise: details.amountPaise,
        reference: details.reference,
      },
    };
    for (const eventKey of keys) {
      await enqueueNotificationEvent(tx, {
        eventKey,
        dedupKey: `return-event:${eventId}:${eventKey}`,
        accountId: snapshot.accountId,
        entityType: 'RETURN',
        entityId: details.caseId,
        context,
      });
    }
  });
}

/** A customer account was created and verified (or became verified for the first time). */
export function emitAccountRegistered(
  tx: TransactionClient,
  account: { id: string; fullName: string | null; email: string; mobile: string | null }
) {
  return safely(EVENT_KEYS.ACCOUNT_REGISTERED, () =>
    enqueueNotificationEvent(tx, {
      eventKey: EVENT_KEYS.ACCOUNT_REGISTERED,
      dedupKey: `account-registered:${account.id}`,
      accountId: account.id,
      entityType: 'ACCOUNT',
      entityId: account.id,
      context: { customer: { name: account.fullName, email: account.email, mobile: account.mobile } },
    })
  );
}

/** An admin approved or rejected a customer's own review. */
export function emitReviewDecision(
  tx: TransactionClient,
  review: { id: string; accountId: string | null; productId: string; productName: string; reviewerName: string },
  decision: 'approve' | 'reject',
  decidedAt: Date
) {
  const eventKey = decision === 'approve' ? EVENT_KEYS.REVIEW_APPROVED : EVENT_KEYS.REVIEW_REJECTED;
  return safely(eventKey, async () => {
    if (!review.accountId) return;
    const account = await tx.account.findUnique({
      where: { id: review.accountId },
      select: { fullName: true, email: true, mobile: true },
    });
    await enqueueNotificationEvent(tx, {
      eventKey,
      dedupKey: `review:${review.id}:${decision}:${decidedAt.getTime()}`,
      accountId: review.accountId,
      entityType: 'REVIEW',
      entityId: review.id,
      context: {
        customer: {
          name: account?.fullName ?? review.reviewerName,
          email: account?.email ?? null,
          mobile: account?.mobile ?? null,
        },
        items: [{ name: review.productName, quantity: 1, unitPricePaise: null, packLabel: null }],
        productId: review.productId,
      },
    });
  });
}
