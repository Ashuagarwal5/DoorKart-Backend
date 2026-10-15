import { z } from 'zod';

import { notFound } from '../../lib/errors.js';
import { pageArgs, pageResult, paginationQuery } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';

export const inboxQuery = z.strictObject({ ...paginationQuery });

const inboxSelect = {
  id: true, eventKey: true, title: true, body: true, imageUrl: true, targetScreen: true,
  targetParams: true, readAt: true, createdAt: true,
} as const;

/** Every query is scoped by the signed-in account id; there is no way to name another account. */
export async function listInbox(accountId: string, page: z.infer<typeof inboxQuery>) {
  const where = { accountId };
  const [total, unread, rows] = await prisma.$transaction([
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { accountId, readAt: null } }),
    prisma.notification.findMany({
      where, select: inboxSelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(page),
    }),
  ]);
  return { ...pageResult(rows, total, page), unreadCount: unread };
}

export async function unreadCount(accountId: string): Promise<{ unreadCount: number }> {
  return { unreadCount: await prisma.notification.count({ where: { accountId, readAt: null } }) };
}

export async function markRead(accountId: string, id: string) {
  const { count } = await prisma.notification.updateMany({
    where: { id, accountId, readAt: null },
    data: { readAt: new Date() },
  });
  if (count === 0) {
    const exists = await prisma.notification.findFirst({ where: { id, accountId }, select: { id: true } });
    if (!exists) throw notFound('NOTIFICATION_NOT_FOUND', 'This notification does not exist.');
  }
  return prisma.notification.findFirstOrThrow({ where: { id, accountId }, select: inboxSelect });
}

export async function markAllRead(accountId: string): Promise<{ updated: number }> {
  const { count } = await prisma.notification.updateMany({
    where: { accountId, readAt: null },
    data: { readAt: new Date() },
  });
  return { updated: count };
}
