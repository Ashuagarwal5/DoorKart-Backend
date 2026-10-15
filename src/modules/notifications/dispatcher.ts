import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { readSettings, shopInfo } from '../settings/settings.service.js';
import type { NotificationContext } from './context.js';
import { getEvent } from './events.js';
import { getTransport, type PushFailureCategory } from './fcm.js';
import { loadCredential, recordSendOutcome } from './provider-config.service.js';
import { renderNotification } from './render.js';
import { isTargetScreen, resolveTarget } from './targets.js';
import type { StoreInfo } from './variables.js';

/**
 * Turns committed business events into inbox entries and pushes. It is a plain PostgreSQL
 * queue: rows are claimed with FOR UPDATE SKIP LOCKED plus a time lease, so any number of
 * API instances may run it, and a crashed worker's rows are picked up again when the lease
 * expires. FCM acceptance is the most it can know; it never claims a device delivery.
 */

export const MAX_ATTEMPTS = 5;
const LEASE_SECONDS = 120;
const BATCH_SIZE = 25;
const BACKOFF_SECONDS = [30, 120, 600, 3600, 21_600];

const RETENTION_DAYS = { events: 30, notifications: 180, devices: 30 };

export function backoffSeconds(attempt: number): number {
  const base = BACKOFF_SECONDS[Math.min(Math.max(attempt, 1), BACKOFF_SECONDS.length) - 1]!;
  return Math.round(base * (0.8 + Math.random() * 0.4));
}

const later = (seconds: number) => new Date(Date.now() + seconds * 1000);
/** Short and plain ASCII, so storing an error message can never itself fail on an encoding. */
const shorten = (value: unknown) =>
  String(value instanceof Error ? value.message : value)
    .replace(/[^ -~]/g, '?')
    .slice(0, 300);

async function storeInfo(): Promise<StoreInfo> {
  const info = shopInfo(await readSettings());
  return { name: info.name, supportEmail: info.email, supportPhone: info.phone };
}

/** Stage 1: an outbox event becomes (at most) one Notification for its recipient. */
async function claimEvents(limit: number): Promise<string[]> {
  const now = new Date();
  const leaseUntil = later(LEASE_SECONDS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "NotificationEvent"
    SET "status" = 'PROCESSING', "attempts" = "attempts" + 1,
        "lockedUntil" = ${leaseUntil}::timestamp
    WHERE "id" IN (
      SELECT "id" FROM "NotificationEvent"
      WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= ${now}::timestamp)
         OR ("status" = 'PROCESSING' AND "lockedUntil" < ${now}::timestamp)
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;
  return rows.map((row) => row.id);
}

async function processEvent(id: string, store: StoreInfo): Promise<void> {
  const event = await prisma.notificationEvent.findUnique({ where: { id } });
  if (!event) return;

  try {
    await prisma.$transaction(async (tx) => {
      const done = () =>
        tx.notificationEvent.update({
          where: { id },
          data: { status: 'PROCESSED', processedAt: new Date(), lockedUntil: null },
        });

      const definition = getEvent(event.eventKey);
      if (!definition || !event.accountId) return void (await done());

      const setting = await tx.notificationEventSetting.findUnique({ where: { eventKey: event.eventKey } });
      if (setting && !setting.isEnabled) return void (await done());

      const template = await tx.notificationTemplate.findFirst({
        where: { eventKey: event.eventKey, isEnabled: true },
      });
      if (!template) return void (await done());

      const account = await tx.account.findUnique({
        where: { id: event.accountId },
        select: { id: true, isActive: true },
      });
      if (!account?.isActive) return void (await done());

      const context = event.payload as NotificationContext;
      const rendered = renderNotification(template, context, store);
      const screen = template.targetScreen && isTargetScreen(template.targetScreen)
        ? template.targetScreen
        : definition.defaultTarget;
      const target = resolveTarget(screen, context);

      await tx.notification.upsert({
        where: { eventId: event.id },
        update: {},
        create: {
          eventId: event.id,
          accountId: account.id,
          eventKey: event.eventKey,
          templateId: template.id,
          templateKey: template.key,
          templateName: template.name,
          ...rendered,
          imageUrl: template.imageUrl,
          targetScreen: target.screen,
          targetParams: target.params,
          entityType: event.entityType,
          entityId: event.entityId,
          reference: context.order?.number ?? null,
        },
      });
      await done();
    });
  } catch (error) {
    const exhausted = event.attempts >= MAX_ATTEMPTS;
    await prisma.notificationEvent.update({
      where: { id },
      data: {
        status: exhausted ? 'FAILED' : 'PENDING',
        nextAttemptAt: later(backoffSeconds(event.attempts)),
        lockedUntil: null,
        lastError: shorten(error),
      },
    });
  }
}

/** Stage 2: send a Notification to the recipient's devices. */
async function claimNotifications(limit: number): Promise<string[]> {
  const now = new Date();
  const leaseUntil = later(LEASE_SECONDS);
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    UPDATE "Notification"
    SET "status" = 'PROCESSING', "attemptCount" = "attemptCount" + 1,
        "lockedUntil" = ${leaseUntil}::timestamp
    WHERE "id" IN (
      SELECT "id" FROM "Notification"
      WHERE ("status" = 'PENDING' AND "nextAttemptAt" <= ${now}::timestamp)
         OR ("status" = 'PROCESSING' AND "lockedUntil" < ${now}::timestamp)
      ORDER BY "createdAt"
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING "id"
  `;
  return rows.map((row) => row.id);
}

type Finish = Pick<Prisma.NotificationUncheckedUpdateInput, 'status' | 'errorCategory' | 'sentAt' | 'fcmMessageId' | 'nextAttemptAt'>;

async function finish(id: string, data: Finish): Promise<void> {
  await prisma.notification.update({
    where: { id },
    data: { ...data, lockedUntil: null, processedAt: new Date() },
  });
}

async function sendNotification(id: string): Promise<void> {
  const notification = await prisma.notification.findUnique({ where: { id } });
  if (!notification || notification.status !== 'PROCESSING') return;

  const credential = await loadCredential();
  if (!credential) return finish(id, { status: 'SKIPPED', errorCategory: 'NOT_CONFIGURED' });
  if (!credential.enabled) return finish(id, { status: 'SKIPPED', errorCategory: 'PUSH_DISABLED' });

  const devices = await prisma.deviceRegistration.findMany({
    where: { accountId: notification.accountId, invalidatedAt: null },
    orderBy: { lastRegisteredAt: 'desc' },
  });
  if (devices.length === 0) return finish(id, { status: 'SKIPPED', errorCategory: 'NO_DEVICE' });

  // A retry never repeats a device that already accepted this notification.
  const accepted = await prisma.notificationDelivery.findMany({
    where: { notificationId: id, status: 'SENT', deviceId: { not: null } },
    select: { deviceId: true, fcmMessageId: true },
  });
  const alreadySent = new Set(accepted.map((row) => row.deviceId));
  const targets = devices.filter((device) => !alreadySent.has(device.id));

  const params = (notification.targetParams ?? {}) as Record<string, string>;
  const data: Record<string, string> = {
    notificationId: notification.id,
    eventKey: notification.eventKey,
    screen: notification.targetScreen,
    ...params,
  };

  let sent = accepted.length;
  let firstMessageId = accepted[0]?.fcmMessageId ?? null;
  let transient = 0;
  let deadDevices = 0;
  let configFailure = false;
  let lastCategory: PushFailureCategory | null = null;

  for (const device of targets) {
    const result = await getTransport().send(credential.account, {
      token: device.token,
      title: notification.pushTitle,
      body: notification.pushBody,
      imageUrl: notification.imageUrl,
      data,
    });

    if (result.ok) {
      sent += 1;
      firstMessageId ??= result.messageId;
      await recordDelivery(id, device.id, device.token, notification.attemptCount, 'SENT', result.messageId, null, null);
      continue;
    }

    lastCategory = result.category;
    await recordDelivery(id, device.id, device.token, notification.attemptCount, 'FAILED', null, result.category, result.message);
    if (result.deviceInvalid) {
      deadDevices += 1;
      await prisma.deviceRegistration.updateMany({
        where: { id: device.id, invalidatedAt: null },
        data: { invalidatedAt: new Date(), invalidReason: result.category },
      });
    } else if (result.category === 'AUTH') {
      configFailure = true;
      break;
    } else if (!result.permanent) {
      transient += 1;
    }
  }

  if (sent > 0) {
    await recordSendOutcome(true, null);
    return finish(id, { status: 'SENT', errorCategory: null, sentAt: new Date(), fcmMessageId: firstMessageId });
  }
  if (configFailure) {
    await recordSendOutcome(false, 'Google rejected the stored credentials.');
    return finish(id, { status: 'FAILED', errorCategory: 'AUTH' });
  }
  if (transient > 0) {
    await recordSendOutcome(false, `Temporary FCM failure (${lastCategory}).`);
    if (notification.attemptCount < MAX_ATTEMPTS) {
      return finish(id, {
        status: 'PENDING',
        errorCategory: lastCategory,
        nextAttemptAt: later(backoffSeconds(notification.attemptCount)),
      });
    }
    return finish(id, { status: 'FAILED', errorCategory: lastCategory });
  }
  if (deadDevices > 0 && deadDevices === targets.length) {
    return finish(id, { status: 'SKIPPED', errorCategory: 'DEVICE_INVALID' });
  }
  return finish(id, { status: 'FAILED', errorCategory: lastCategory ?? 'UNKNOWN' });
}

function recordDelivery(
  notificationId: string,
  deviceId: string,
  token: string,
  attempt: number,
  status: 'SENT' | 'FAILED',
  fcmMessageId: string | null,
  errorCategory: string | null,
  errorMessage: string | null
) {
  return prisma.notificationDelivery.create({
    data: {
      notificationId,
      deviceId,
      tokenSuffix: token.slice(-6),
      attempt,
      status,
      fcmMessageId,
      errorCategory,
      errorMessage: errorMessage?.slice(0, 200) ?? null,
    },
  });
}

/** One pass over everything that is due. Returns how many rows were handled. */
export async function runDispatchCycle(): Promise<{ events: number; notifications: number }> {
  const store = await storeInfo();
  const eventIds = await claimEvents(BATCH_SIZE);
  for (const id of eventIds) await processEvent(id, store);

  const notificationIds = await claimNotifications(BATCH_SIZE);
  for (const id of notificationIds) {
    try {
      await sendNotification(id);
    } catch (error) {
      // Unexpected: put it back for another attempt rather than leaving it leased.
      const row = await prisma.notification.findUnique({ where: { id }, select: { attemptCount: true } });
      const exhausted = (row?.attemptCount ?? MAX_ATTEMPTS) >= MAX_ATTEMPTS;
      await prisma.notification.update({
        where: { id },
        data: {
          status: exhausted ? 'FAILED' : 'PENDING',
          errorCategory: 'INTERNAL',
          nextAttemptAt: later(backoffSeconds(row?.attemptCount ?? 1)),
          lockedUntil: null,
        },
      });
      console.error('[notifications] dispatch error', shorten(error));
    }
  }
  return { events: eventIds.length, notifications: notificationIds.length };
}

const DAY_MS = 86_400_000;

/** Removes old processed rows. Safe to run from several instances at once. */
export async function runRetentionCleanup(now = new Date()) {
  const before = (days: number) => new Date(now.getTime() - days * DAY_MS);
  const events = await prisma.notificationEvent.deleteMany({
    where: { status: { in: ['PROCESSED', 'FAILED'] }, createdAt: { lt: before(RETENTION_DAYS.events) } },
  });
  const notifications = await prisma.notification.deleteMany({
    where: { status: { not: 'PROCESSING' }, createdAt: { lt: before(RETENTION_DAYS.notifications) } },
  });
  const devices = await prisma.deviceRegistration.deleteMany({
    where: { invalidatedAt: { lt: before(RETENTION_DAYS.devices) } },
  });
  return { events: events.count, notifications: notifications.count, devices: devices.count };
}

const TICK_MS = 5000;
const CLEANUP_EVERY_MS = 6 * 3_600_000;
let timer: NodeJS.Timeout | null = null;
let running = false;
let lastCleanup = 0;

/** Starts the background loop. Calling it twice has no effect. */
export function startNotificationWorker(): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    void (async () => {
      try {
        await runDispatchCycle();
        if (Date.now() - lastCleanup > CLEANUP_EVERY_MS) {
          lastCleanup = Date.now();
          await runRetentionCleanup();
        }
      } catch (error) {
        console.error('[notifications] worker cycle failed', shorten(error));
      } finally {
        running = false;
      }
    })();
  }, TICK_MS);
  timer.unref();
}

export function stopNotificationWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
