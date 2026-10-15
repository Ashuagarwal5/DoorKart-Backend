import type { TransactionClient } from '../../lib/prisma.js';
import type { NotificationContext } from './context.js';
import type { EventKey } from './events.js';

export type NotificationEventInput = {
  eventKey: EventKey;
  /**
   * Stable identity of this business occurrence, built from a durable row (a status-history
   * id, a payment-history id, a return event id...). The same occurrence can never be
   * queued twice, whatever retries or replays reach the code that calls this.
   */
  dedupKey: string;
  /** The customer account to notify. Null (a legacy guest order) queues nothing. */
  accountId: string | null;
  entityType: string;
  entityId: string;
  context: NotificationContext;
};

/**
 * Records that something notifiable happened, inside the same transaction as the change
 * itself: if the change rolls back so does this row, and if it commits the row cannot be
 * lost. It only inserts, with a duplicate-tolerant statement, so it cannot abort the
 * surrounding transaction. Delivery happens later, in the worker, never here.
 */
export async function enqueueNotificationEvent(tx: TransactionClient, input: NotificationEventInput): Promise<void> {
  if (!input.accountId) return;
  await tx.notificationEvent.createMany({
    data: [
      {
        eventKey: input.eventKey,
        dedupKey: input.dedupKey,
        accountId: input.accountId,
        entityType: input.entityType,
        entityId: input.entityId,
        payload: input.context as object,
      },
    ],
    skipDuplicates: true,
  });
}
