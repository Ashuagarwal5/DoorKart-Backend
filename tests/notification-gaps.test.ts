import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encryptSecret } from '../src/lib/secrets.js';
import { runDispatchCycle, runRetentionCleanup } from '../src/modules/notifications/dispatcher.js';
import { EVENT_DEFINITIONS, EVENT_KEYS, getEvent } from '../src/modules/notifications/events.js';
import {
  type PushMessage,
  type PushResult,
  type PushTransport,
  setPushTransportForTests,
} from '../src/modules/notifications/fcm.js';
import { validateTemplateText } from '../src/modules/notifications/render.js';
import { isTargetScreen } from '../src/modules/notifications/targets.js';
import { VARIABLES } from '../src/modules/notifications/variables.js';
import { app, createTestAdmin, createTestBuyer, orderPayload, prisma, resetDatabase, seedFixtures, signIn, type Fixtures } from './helpers.js';

class FakeTransport implements PushTransport {
  sent: PushMessage[] = [];
  /** Lets two concurrent workers overlap inside a send. */
  delayMs = 0;
  async send(_account: unknown, message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    if (this.delayMs) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    return { ok: true, messageId: `projects/test/messages/${this.sent.length}` };
  }
  async verify(): Promise<PushResult> {
    return { ok: true, messageId: 'validated' };
  }
}

const keyFile = `-----BEGIN PRIVATE KEY-----\n${'C'.repeat(220)}\n-----END PRIVATE KEY-----\n`;
let transport: FakeTransport;

beforeEach(async () => {
  await resetDatabase();
  transport = new FakeTransport();
  setPushTransportForTests(transport);
});
afterEach(() => setPushTransportForTests(null));

async function pushReady(accountId: string) {
  await prisma.notificationProviderConfig.create({
    data: {
      id: 'fcm', isEnabled: true, projectId: 'doorkart-test', clientEmail: 'push@doorkart-test.iam.gserviceaccount.com',
      credentialEncrypted: encryptSecret(keyFile),
    },
  });
  await prisma.deviceRegistration.create({
    data: { accountId, installationId: `install-${randomUUID()}`, token: `token-${randomUUID()}-abcdefghij`, platform: 'ANDROID' },
  });
}

async function queuedNotification(accountId: string, overrides: Record<string, unknown> = {}) {
  return prisma.notification.create({
    data: {
      accountId, eventKey: 'ORDER_PLACED', title: 'T', body: 'B', pushTitle: 'T', pushBody: 'B', targetScreen: 'HOME',
      ...overrides,
    },
  });
}

describe('event registry', () => {
  it('has unique keys, valid destinations and only known variable groups', () => {
    const keys = EVENT_DEFINITIONS.map((event) => event.key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys.sort()).toEqual(Object.values(EVENT_KEYS).sort());
    const groups = new Set(VARIABLES.map((variable) => variable.group));
    for (const event of EVENT_DEFINITIONS) {
      expect(isTargetScreen(event.defaultTarget)).toBe(true);
      expect(event.variableGroups.every((group) => groups.has(group))).toBe(true);
      expect(getEvent(event.key)).toBe(event);
    }
  });

  it('only offers variables that every template of an event can resolve safely', () => {
    for (const variable of VARIABLES) {
      expect(variable.key).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(variable.fallback).not.toMatch(/[{}]/);
    }
    expect(VARIABLES.map((v) => v.key)).not.toContain('variant_name');
    expect(validateTemplateText('{store_name}', EVENT_KEYS.ACCOUNT_REGISTERED)).toEqual([]);
    expect(validateTemplateText('{order_number}', EVENT_KEYS.ACCOUNT_REGISTERED)).toHaveLength(1);
  });
});

describe('business rollback leaves no notification', () => {
  let fixtures: Fixtures;

  it('queues nothing when an order is refused for stock', async () => {
    fixtures = await seedFixtures();
    const buyer = await createTestBuyer();
    const response = await request(app)
      .post('/api/v1/orders')
      .auth(buyer.token, { type: 'bearer' })
      .send(orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.soldOut.id, quantity: 1 }] }));
    expect(response.status).toBe(409);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.notificationEvent.count()).toBe(0);
  });
});

describe('dispatch concurrency and recovery', () => {
  it('sends a queued notification once when two workers run at the same time', async () => {
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    await queuedNotification(buyer.id);
    transport.delayMs = 150;

    await Promise.all([runDispatchCycle(), runDispatchCycle(), runDispatchCycle()]);

    expect(transport.sent).toHaveLength(1);
    const note = await prisma.notification.findFirstOrThrow({ where: { accountId: buyer.id }, include: { deliveries: true } });
    expect(note.status).toBe('SENT');
    expect(note.deliveries).toHaveLength(1);
  });

  it('picks up a notification abandoned by a crashed worker after its lease expires', async () => {
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    await queuedNotification(buyer.id, { status: 'PROCESSING', attemptCount: 1, lockedUntil: new Date(Date.now() - 60_000) });
    await runDispatchCycle();
    expect((await prisma.notification.findFirstOrThrow()).status).toBe('SENT');
  });

  it('leaves a notification that another worker is still holding alone', async () => {
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    await queuedNotification(buyer.id, { status: 'PROCESSING', attemptCount: 1, lockedUntil: new Date(Date.now() + 60_000) });
    await runDispatchCycle();
    expect(transport.sent).toHaveLength(0);
    expect((await prisma.notification.findFirstOrThrow()).status).toBe('PROCESSING');
  });

  it('does not repeat a device that already accepted the message on a retry', async () => {
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    const note = await queuedNotification(buyer.id, { status: 'FAILED', attemptCount: 3 });
    const device = await prisma.deviceRegistration.findFirstOrThrow();
    await prisma.notificationDelivery.create({
      data: { notificationId: note.id, deviceId: device.id, tokenSuffix: 'abcdef', attempt: 1, status: 'SENT', fcmMessageId: 'earlier' },
    });
    await createTestAdmin();
    const admin = await signIn();
    expect((await admin.post(`/api/v1/admin/notifications/history/${note.id}/retry`)).status).toBe(200);
    await runDispatchCycle();
    expect(transport.sent).toHaveLength(0);
    expect(await prisma.notification.findUniqueOrThrow({ where: { id: note.id } })).toMatchObject({ status: 'SENT' });
  });
});

describe('retention cleanup', () => {
  it('removes old processed rows and keeps recent and unprocessed ones', async () => {
    const buyer = await createTestBuyer();
    const old = new Date(Date.now() - 400 * 86_400_000);
    await prisma.notificationEvent.createMany({
      data: [
        { eventKey: 'ORDER_PLACED', dedupKey: 'old-done', entityType: 'ORDER', entityId: 'o', payload: {}, status: 'PROCESSED', createdAt: old },
        { eventKey: 'ORDER_PLACED', dedupKey: 'old-pending', entityType: 'ORDER', entityId: 'o', payload: {}, status: 'PENDING', createdAt: old },
        { eventKey: 'ORDER_PLACED', dedupKey: 'fresh-done', entityType: 'ORDER', entityId: 'o', payload: {}, status: 'PROCESSED' },
      ],
    });
    await queuedNotification(buyer.id, { status: 'SENT', createdAt: old });
    await queuedNotification(buyer.id, { status: 'SENT' });

    const removed = await runRetentionCleanup();
    expect(removed.events).toBe(1);
    expect(removed.notifications).toBe(1);
    expect((await prisma.notificationEvent.findMany()).map((event) => event.dedupKey).sort()).toEqual(['fresh-done', 'old-pending']);
    expect(await prisma.notification.count()).toBe(1);
  });
});

describe('admin event and template safety', () => {
  async function agents() {
    await createTestAdmin({ email: 'staff@example.test' });
    await createTestAdmin({ email: 'owner@example.test', role: 'SUPER_ADMIN' });
    return { staff: await signIn('staff@example.test'), owner: await signIn('owner@example.test') };
  }
  const base = '/api/v1/admin/notifications';
  const template = (extra: object = {}) => ({
    key: 'delivered_msg', name: 'Delivered message', eventKey: 'ORDER_DELIVERED', title: 'Delivered', body: 'Hi {username}', ...extra,
  });

  it('turns an event off and stops its notifications without deleting templates', async () => {
    const { staff } = await agents();
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    await staff.post(`${base}/templates`).send(template({ isEnabled: true }));
    expect((await staff.patch(`${base}/events/ORDER_DELIVERED`).send({ isEnabled: false })).body.data.isEnabled).toBe(false);

    await prisma.notificationEvent.create({
      data: { eventKey: 'ORDER_DELIVERED', dedupKey: 'x1', accountId: buyer.id, entityType: 'ORDER', entityId: 'o', payload: {} },
    });
    await runDispatchCycle();
    expect(await prisma.notification.count()).toBe(0);
    expect(await prisma.notificationTemplate.count()).toBe(1);
  });

  it('rejects unknown events, unsafe destinations and non-https images', async () => {
    const { staff } = await agents();
    for (const bad of [
      { eventKey: 'NOT_AN_EVENT' },
      { targetScreen: 'https://evil.example' },
      { targetScreen: '/admin' },
      { imageUrl: 'http://insecure.example/a.png' },
      { imageUrl: 'javascript:alert(1)' },
      { key: 'Has Spaces' },
      { unexpected: 'field' },
    ]) {
      const response = await staff.post(`${base}/templates`).send(template(bad));
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    expect(await prisma.notificationTemplate.count()).toBe(0);
  });

  it('restricts test sends to a super admin and queues a marked test for the chosen account', async () => {
    const { staff, owner } = await agents();
    const created = await staff.post(`${base}/templates`).send(template());
    const id = created.body.data.id as string;
    const buyer = await createTestBuyer();
    const account = await prisma.account.findUniqueOrThrow({ where: { id: buyer.id } });

    expect((await staff.post(`${base}/templates/${id}/test`).send({ accountEmail: account.email })).status).toBe(403);
    expect((await owner.post(`${base}/templates/${id}/test`).send({ accountEmail: 'nobody@example.test' })).status).toBe(404);

    const sent = await owner.post(`${base}/templates/${id}/test`).send({ accountEmail: account.email });
    expect(sent.status).toBe(202);
    const note = await prisma.notification.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(note).toMatchObject({ isTest: true, targetScreen: 'NOTIFICATIONS' });
    expect(note.title).toMatch(/^\[Test\]/);
  });

  it('never returns stored credentials or device tokens from any admin endpoint', async () => {
    const { owner } = await agents();
    const buyer = await createTestBuyer();
    await pushReady(buyer.id);
    const device = await prisma.deviceRegistration.findFirstOrThrow();
    const responses = await Promise.all([
      owner.get(`${base}/provider`),
      owner.get(`${base}/devices`),
      owner.get(`${base}/overview`),
    ]);
    const text = JSON.stringify(responses.map((response) => response.body));
    expect(text).not.toContain(device.token);
    expect(text).not.toContain('CCCCCCCC');
    expect(text).not.toContain('v1:');
  });
});
