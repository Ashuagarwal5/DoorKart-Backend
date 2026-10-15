import { z } from 'zod';

import type { Prisma } from '../../generated/prisma/client.js';
import { conflict, notFound } from '../../lib/errors.js';
import { pageArgs, pageResult, paginationQuery, searchText, shopDay } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { shopDateRange } from '../../lib/time.js';
import { EVENT_DEFINITIONS, getEvent } from './events.js';
import { variablesForEvent } from './render.js';
import { TARGET_SCREENS } from './targets.js';
import { VARIABLES } from './variables.js';

export const historyQuery = z.strictObject({
  ...paginationQuery,
  search: searchText,
  status: z.enum(['PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SKIPPED']).optional(),
  eventKey: z.string().max(60).optional(),
  from: shopDay.optional(),
  to: shopDay.optional(),
});

const historySelect = {
  id: true, eventKey: true, templateKey: true, templateName: true, title: true, body: true, pushTitle: true,
  pushBody: true, targetScreen: true, status: true, errorCategory: true, attemptCount: true, nextAttemptAt: true,
  createdAt: true, processedAt: true, sentAt: true, fcmMessageId: true, reference: true, entityType: true,
  entityId: true, isTest: true, readAt: true,
  account: { select: { id: true, email: true, fullName: true } },
} satisfies Prisma.NotificationSelect;

export async function listHistory(query: z.infer<typeof historyQuery>) {
  const { start, end } = shopDateRange(query.from, query.to);
  const where: Prisma.NotificationWhereInput = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.eventKey ? { eventKey: query.eventKey } : {}),
    ...(start || end ? { createdAt: { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) } } : {}),
    ...(query.search
      ? {
          OR: [
            { reference: { contains: query.search, mode: 'insensitive' } },
            { title: { contains: query.search, mode: 'insensitive' } },
            { templateName: { contains: query.search, mode: 'insensitive' } },
            { account: { email: { contains: query.search, mode: 'insensitive' } } },
          ],
        }
      : {}),
  };
  const [total, rows] = await prisma.$transaction([
    prisma.notification.count({ where }),
    prisma.notification.findMany({
      where, select: historySelect, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], ...pageArgs(query),
    }),
  ]);
  return pageResult(rows, total, query);
}

export async function getHistoryDetail(id: string) {
  const row = await prisma.notification.findUnique({
    where: { id },
    select: {
      ...historySelect,
      targetParams: true,
      deliveries: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true, attempt: true, status: true, fcmMessageId: true, errorCategory: true,
          errorMessage: true, tokenSuffix: true, createdAt: true,
        },
      },
    },
  });
  if (!row) throw notFound('NOTIFICATION_NOT_FOUND', 'This notification does not exist.');
  return row;
}

/** Re-queues a failed or skipped notification. Only devices that never accepted it are tried. */
export async function retryNotification(id: string) {
  const { count } = await prisma.notification.updateMany({
    where: { id, status: { in: ['FAILED', 'SKIPPED'] } },
    data: { status: 'PENDING', attemptCount: 0, errorCategory: null, nextAttemptAt: new Date(), lockedUntil: null },
  });
  if (count === 0) {
    const exists = await prisma.notification.findUnique({ where: { id }, select: { status: true } });
    if (!exists) throw notFound('NOTIFICATION_NOT_FOUND', 'This notification does not exist.');
    throw conflict('NOTIFICATION_NOT_RETRYABLE', `A ${exists.status.toLowerCase()} notification cannot be retried.`);
  }
  return getHistoryDetail(id);
}

export async function listEvents() {
  const [settings, templates] = await Promise.all([
    prisma.notificationEventSetting.findMany(),
    prisma.notificationTemplate.findMany({
      select: { id: true, key: true, name: true, eventKey: true, isEnabled: true },
      orderBy: { name: 'asc' },
    }),
  ]);
  const disabled = new Set(settings.filter((setting) => !setting.isEnabled).map((setting) => setting.eventKey));
  return EVENT_DEFINITIONS.map((event) => ({
    key: event.key,
    name: event.name,
    description: event.description,
    group: event.group,
    defaultTarget: event.defaultTarget,
    recipient: event.recipient,
    isEnabled: !disabled.has(event.key),
    variables: variablesForEvent(event.key).map((variable) => variable.key),
    templates: templates.filter((template) => template.eventKey === event.key),
  }));
}

export async function setEventEnabled(eventKey: string, isEnabled: boolean, adminId: string) {
  if (!getEvent(eventKey)) throw notFound('NOTIFICATION_NOT_FOUND', 'This event does not exist.');
  await prisma.notificationEventSetting.upsert({
    where: { eventKey },
    create: { eventKey, isEnabled, updatedByAdminId: adminId },
    update: { isEnabled, updatedByAdminId: adminId },
  });
  return (await listEvents()).find((event) => event.key === eventKey)!;
}

export function listVariables() {
  return VARIABLES.map(({ resolve: _resolve, ...variable }) => variable);
}

export function listTargets() {
  return Object.entries(TARGET_SCREENS).map(([key, value]) => ({ key, label: value.label }));
}

export async function overview() {
  const since = new Date(Date.now() - 7 * 86_400_000);
  const [byStatus, activeDevices, templates, enabledTemplates, unprocessed] = await prisma.$transaction([
    prisma.notification.groupBy({
      by: ['status'], where: { createdAt: { gte: since } }, _count: { _all: true }, orderBy: { status: 'asc' },
    }),
    prisma.deviceRegistration.count({ where: { invalidatedAt: null } }),
    prisma.notificationTemplate.count(),
    prisma.notificationTemplate.count({ where: { isEnabled: true } }),
    prisma.notificationEvent.count({ where: { status: { in: ['PENDING', 'PROCESSING'] } } }),
  ]);
  const counts = Object.fromEntries(byStatus.map((row) => [row.status, row._count._all]));
  return {
    last7Days: { PENDING: 0, PROCESSING: 0, SENT: 0, FAILED: 0, SKIPPED: 0, ...counts },
    activeDevices,
    templates,
    enabledTemplates,
    queuedEvents: unprocessed,
  };
}

