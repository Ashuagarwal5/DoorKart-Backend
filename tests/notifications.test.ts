import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prisma as db } from '../src/lib/prisma.js';
import { runDispatchCycle } from '../src/modules/notifications/dispatcher.js';
import { EVENT_KEYS } from '../src/modules/notifications/events.js';
import {
  type PushMessage,
  type PushResult,
  type PushTransport,
  setPushTransportForTests,
} from '../src/modules/notifications/fcm.js';
import { formatInr, formatIstDate } from '../src/modules/notifications/format.js';
import { enqueueNotificationEvent } from '../src/modules/notifications/outbox.js';
import { renderNotification, validateTemplateText } from '../src/modules/notifications/render.js';
import { SAMPLE_CONTEXT, SAMPLE_STORE } from '../src/modules/notifications/variables.js';
import { app, createTestAdmin, createTestBuyer, resetDatabase, signIn } from './helpers.js';

const ADMIN = '/api/v1/admin/notifications';

/** Not a real credential: a structurally valid file the fake transport accepts. */
const FAKE_KEY = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(220)}\n-----END PRIVATE KEY-----\n`;
function credentialFile(projectId = 'doorkart-test') {
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'abcdef1234567890',
    private_key: FAKE_KEY,
    client_email: 'push@doorkart-test.iam.gserviceaccount.com',
  });
}

class FakeTransport implements PushTransport {
  sent: PushMessage[] = [];
  nextResults: PushResult[] = [];
  verifyResult: PushResult = { ok: true, messageId: 'validated' };

  async send(_account: unknown, message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return this.nextResults.shift() ?? { ok: true, messageId: `projects/doorkart-test/messages/${this.sent.length}` };
  }
  async verify(): Promise<PushResult> {
    return this.verifyResult;
  }
}

let transport: FakeTransport;

beforeEach(async () => {
  await resetDatabase();
  transport = new FakeTransport();
  setPushTransportForTests(transport);
});
afterEach(() => setPushTransportForTests(null));

describe('variable validation and rendering', () => {
  it('accepts known variables and rejects unknown, unavailable and expression-like text', () => {
    expect(validateTemplateText('Hi {username}, {order_number}', EVENT_KEYS.ORDER_DELIVERED)).toEqual([]);
    expect(validateTemplateText('{nope}', EVENT_KEYS.ORDER_DELIVERED)).toEqual(['Unknown variable {nope}.']);
    expect(validateTemplateText('{refund_amount}', EVENT_KEYS.ORDER_PLACED)[0]).toMatch(/not available for this event/);
    expect(validateTemplateText('{{1+1}}', EVENT_KEYS.ORDER_PLACED).join(' ')).toMatch(/placeholders only/);
    expect(validateTemplateText('${process.env.X}', EVENT_KEYS.ORDER_PLACED).join(' ')).toMatch(/placeholders only/);
  });

  it('substitutes with INR and IST formatting and a multi-product summary', () => {
    const rendered = renderNotification(
      { title: 'Order {order_status}!', body: 'Dear {username}, {order_number} ({product_summary}) {order_total} on {delivery_date}.' },
      SAMPLE_CONTEXT,
      SAMPLE_STORE
    );
    expect(rendered.title).toBe('Order Delivered!');
    expect(rendered.body).toBe('Dear Rahul, DK-20261015-0001 (Gel Pen Set and 1 more) ₹749.00 on 16 Oct 2026.');
    expect(formatInr(14950)).toBe('₹149.50');
    expect(formatInr(123456789)).toBe('₹12,34,567.89');
    expect(formatIstDate('2026-10-15T20:00:00.000Z')).toBe('16 Oct 2026');
  });

  it('keeps sensitive values out of the push text but in the inbox text', () => {
    const rendered = renderNotification(
      { title: 'Delivered', body: 'To {delivery_address} for {customer_email}' },
      SAMPLE_CONTEXT,
      SAMPLE_STORE
    );
    expect(rendered.body).toContain('12 Park Road');
    expect(rendered.pushBody).toBe('To your delivery address for your registered email');
  });

  it('never leaves a raw placeholder or "undefined" when data is missing', () => {
    const rendered = renderNotification(
      { title: '{refund_amount} {delivery_date}', body: 'Order {order_number} {product_price}' },
      {},
      SAMPLE_STORE
    );
    expect(rendered.title + rendered.body).not.toMatch(/[{}]|undefined|null/);
  });
});

describe('admin template management', () => {
  async function admins() {
    await createTestAdmin({ email: 'staff@example.test' });
    await createTestAdmin({ email: 'owner@example.test', role: 'SUPER_ADMIN' });
    return { staff: await signIn('staff@example.test'), owner: await signIn('owner@example.test') };
  }

  const body = (overrides: Record<string, unknown> = {}) => ({
    key: 'order_delivered',
    name: 'Order delivered',
    eventKey: EVENT_KEYS.ORDER_DELIVERED,
    title: 'Order Delivered!',
    body: 'Dear {username}, your order {order_number} has been delivered.',
    ...overrides,
  });

  it('requires an admin session', async () => {
    expect((await request(app).get(`${ADMIN}/templates`)).status).toBe(401);
    expect((await request(app).get(`${ADMIN}/provider`)).status).toBe(401);
  });

  it('creates, previews, rejects bad variables and a duplicate identifier', async () => {
    const { staff } = await admins();
    const created = await staff.post(`${ADMIN}/templates`).send(body());
    expect(created.status).toBe(201);
    expect(created.body.data.isEnabled).toBe(false);

    const duplicate = await staff.post(`${ADMIN}/templates`).send(body());
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_TEMPLATE_KEY');

    const unknown = await staff.post(`${ADMIN}/templates`).send(body({ key: 'bad_one', body: 'Hi {secret_thing}' }));
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.details[0].message).toMatch(/Unknown variable/);

    const preview = await staff
      .post(`${ADMIN}/templates/preview`)
      .send({ eventKey: EVENT_KEYS.ORDER_DELIVERED, title: 'Hi {username}', body: '{order_number}' });
    expect(preview.body.data.rendered.title).toBe('Hi Rahul');
    expect(preview.body.data.problems).toEqual([]);
  });

  it('keeps one enabled template per event and keeps history after deletion', async () => {
    const { staff } = await admins();
    const first = (await staff.post(`${ADMIN}/templates`).send(body({ isEnabled: true }))).body.data;
    const second = (await staff.post(`${ADMIN}/templates`).send(body({ key: 'order_delivered_v2', isEnabled: true }))).body.data;
    expect((await staff.get(`${ADMIN}/templates/${first.id}`)).body.data.isEnabled).toBe(false);
    expect(second.isEnabled).toBe(true);

    const buyer = await createTestBuyer();
    const note = await db.notification.create({
      data: { accountId: buyer.id, eventKey: 'ORDER_DELIVERED', templateId: second.id, templateKey: second.key,
        templateName: second.name, title: 'T', body: 'B', pushTitle: 'T', pushBody: 'B', targetScreen: 'HOME' },
    });
    expect((await staff.delete(`${ADMIN}/templates/${second.id}`)).status).toBe(200);
    const kept = await db.notification.findUniqueOrThrow({ where: { id: note.id } });
    expect(kept.templateId).toBeNull();
    expect(kept.templateName).toBe(second.name);
  });

  it('duplicates a template disabled with a new identifier', async () => {
    const { staff } = await admins();
    const source = (await staff.post(`${ADMIN}/templates`).send(body({ isEnabled: true }))).body.data;
    const copy = (await staff.post(`${ADMIN}/templates/${source.id}/duplicate`)).body.data;
    expect(copy.key).toBe('order_delivered_copy');
    expect(copy.isEnabled).toBe(false);
  });
});

describe('Firebase credentials', () => {
  const save = (agent: Awaited<ReturnType<typeof signIn>>, extra: Record<string, unknown> = {}) =>
    agent.put(`${ADMIN}/provider/credentials`).send({
      projectId: 'doorkart-test', serviceAccountJson: credentialFile(), confirmReplace: false, ...extra,
    });

  it('is restricted to a super admin', async () => {
    await createTestAdmin({ email: 'staff@example.test' });
    const staff = await signIn('staff@example.test');
    expect((await staff.get(`${ADMIN}/provider`)).status).toBe(403);
    expect((await save(staff)).status).toBe(403);
  });

  it('stores credentials encrypted and never returns them', async () => {
    await createTestAdmin({ role: 'SUPER_ADMIN' });
    const owner = await signIn();
    const saved = await save(owner);
    expect(saved.status).toBe(200);
    expect(saved.body.data).toMatchObject({ configured: true, isEnabled: false, projectId: 'doorkart-test' });
    expect(JSON.stringify(saved.body)).not.toContain('AAAAAAAA');

    const row = await db.notificationProviderConfig.findUniqueOrThrow({ where: { id: 'fcm' } });
    expect(row.credentialEncrypted).toMatch(/^v1:/);
    expect(row.credentialEncrypted).not.toContain('AAAAAAAA');

    // Replacing needs explicit confirmation; accidental overwrite is refused.
    expect((await save(owner)).status).toBe(409);
    expect((await save(owner, { confirmReplace: true })).status).toBe(200);
  });

  it('rejects malformed files, a mismatched project and keys Google refuses', async () => {
    await createTestAdmin({ role: 'SUPER_ADMIN' });
    const owner = await signIn();
    expect((await save(owner, { serviceAccountJson: 'x'.repeat(60) })).status).toBe(400);
    expect((await save(owner, { projectId: 'other-project' })).status).toBe(400);

    transport.verifyResult = { ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, message: 'x' };
    expect((await save(owner)).status).toBe(400);
    expect(await db.notificationProviderConfig.count()).toBe(0);
  });

  it('refuses to enable push before credentials exist', async () => {
    await createTestAdmin({ role: 'SUPER_ADMIN' });
    const owner = await signIn();
    expect((await owner.patch(`${ADMIN}/provider`).send({ isEnabled: true })).status).toBe(409);
  });
});

describe('outbox and dispatcher', () => {
  async function setup(options: { provider?: boolean; device?: boolean; template?: boolean } = {}) {
    const { provider = true, device = true, template = true } = options;
    const buyer = await createTestBuyer();
    if (provider) {
      await db.notificationProviderConfig.create({
        data: {
          id: 'fcm', isEnabled: true, projectId: 'doorkart-test', clientEmail: 'push@doorkart-test.iam.gserviceaccount.com',
          credentialEncrypted: (await import('../src/lib/secrets.js')).encryptSecret(FAKE_KEY),
        },
      });
    }
    if (device) {
      await db.deviceRegistration.create({
        data: { accountId: buyer.id, installationId: `install-${randomUUID()}`, token: `token-${randomUUID()}-abcdefghij`, platform: 'ANDROID' },
      });
    }
    if (template) {
      await db.notificationTemplate.create({
        data: { key: 'delivered', name: 'Delivered', eventKey: EVENT_KEYS.ORDER_DELIVERED, isEnabled: true,
          title: 'Order Delivered!', body: 'Dear {username}, your order {order_number} has been delivered.' },
      });
    }
    return buyer;
  }

  const enqueue = (accountId: string | null, dedupKey = 'history:1') =>
    db.$transaction((tx) =>
      enqueueNotificationEvent(tx, {
        eventKey: EVENT_KEYS.ORDER_DELIVERED, dedupKey, accountId, entityType: 'ORDER', entityId: 'order-1',
        context: SAMPLE_CONTEXT,
      })
    );

  it('renders from the stored snapshot, sends once and records provider acceptance as SENT', async () => {
    const buyer = await setup();
    await enqueue(buyer.id);
    await runDispatchCycle();

    const note = await db.notification.findFirstOrThrow({ where: { accountId: buyer.id }, include: { deliveries: true } });
    expect(note.status).toBe('SENT');
    expect(note.body).toBe('Dear Rahul, your order DK-20261015-0001 has been delivered.');
    expect(note.deliveries).toHaveLength(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]!.data).toMatchObject({ screen: 'ORDER_DETAIL', orderNumber: 'DK-20261015-0001' });
    expect(JSON.stringify(transport.sent[0])).not.toMatch(/₹|Park Road|rahul@/);
  });

  it('does not queue the same business occurrence twice', async () => {
    const buyer = await setup();
    await enqueue(buyer.id);
    await enqueue(buyer.id);
    await runDispatchCycle();
    await runDispatchCycle();
    expect(await db.notificationEvent.count()).toBe(1);
    expect(await db.notification.count()).toBe(1);
    expect(transport.sent).toHaveLength(1);
  });

  it('leaves nothing behind when the business transaction rolls back', async () => {
    const buyer = await setup();
    await expect(
      db.$transaction(async (tx) => {
        await enqueueNotificationEvent(tx, {
          eventKey: EVENT_KEYS.ORDER_DELIVERED, dedupKey: 'rolled-back', accountId: buyer.id,
          entityType: 'ORDER', entityId: 'o', context: SAMPLE_CONTEXT,
        });
        throw new Error('business failure');
      })
    ).rejects.toThrow('business failure');
    expect(await db.notificationEvent.count()).toBe(0);
  });

  it('queues nothing for a legacy order without an account', async () => {
    await setup();
    await enqueue(null);
    expect(await db.notificationEvent.count()).toBe(0);
  });

  it('keeps the inbox entry but skips the push without a device', async () => {
    const buyer = await setup({ device: false });
    await enqueue(buyer.id);
    await runDispatchCycle();
    const note = await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(note).toMatchObject({ status: 'SKIPPED', errorCategory: 'NO_DEVICE' });
    expect(transport.sent).toHaveLength(0);
  });

  it('skips pushes while push is disabled but still creates the inbox entry', async () => {
    const buyer = await setup();
    await db.notificationProviderConfig.update({ where: { id: 'fcm' }, data: { isEnabled: false } });
    await enqueue(buyer.id);
    await runDispatchCycle();
    expect(await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } })).toMatchObject({
      status: 'SKIPPED', errorCategory: 'PUSH_DISABLED',
    });
  });

  it('creates nothing when the event or its template is disabled', async () => {
    const buyer = await setup();
    await db.notificationEventSetting.create({ data: { eventKey: EVENT_KEYS.ORDER_DELIVERED, isEnabled: false } });
    await enqueue(buyer.id);
    await runDispatchCycle();
    expect(await db.notification.count()).toBe(0);
    expect((await db.notificationEvent.findFirstOrThrow()).status).toBe('PROCESSED');
  });

  it('retries a temporary FCM failure with backoff, then succeeds', async () => {
    const buyer = await setup();
    transport.nextResults = [{ ok: false, category: 'UNAVAILABLE', permanent: false, deviceInvalid: false, message: '503' }];
    await enqueue(buyer.id);
    await runDispatchCycle();

    let note = await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(note.status).toBe('PENDING');
    expect(note.attemptCount).toBe(1);
    expect(note.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());

    await runDispatchCycle();
    expect(transport.sent).toHaveLength(1); // not yet due

    await db.notification.update({ where: { id: note.id }, data: { nextAttemptAt: new Date(Date.now() - 1000) } });
    await runDispatchCycle();
    note = await db.notification.findUniqueOrThrow({ where: { id: note.id } });
    expect(note.status).toBe('SENT');
    expect(transport.sent).toHaveLength(2);
  });

  it('gives up after bounded attempts', async () => {
    const buyer = await setup();
    await enqueue(buyer.id);
    transport.nextResults = Array.from({ length: 6 }, () => ({
      ok: false as const, category: 'UNAVAILABLE' as const, permanent: false, deviceInvalid: false, message: '503',
    }));
    for (let i = 0; i < 6; i += 1) {
      await db.notification.updateMany({ data: { nextAttemptAt: new Date(Date.now() - 1000) } });
      await runDispatchCycle();
    }
    const note = await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(note).toMatchObject({ status: 'FAILED', attemptCount: 5, errorCategory: 'UNAVAILABLE' });
  });

  it('deactivates an unregistered device instead of retrying it', async () => {
    const buyer = await setup();
    transport.nextResults = [{ ok: false, category: 'UNREGISTERED', permanent: true, deviceInvalid: true, message: '404' }];
    await enqueue(buyer.id);
    await runDispatchCycle();
    const device = await db.deviceRegistration.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(device.invalidatedAt).not.toBeNull();
    expect(await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } })).toMatchObject({
      status: 'SKIPPED', errorCategory: 'DEVICE_INVALID',
    });
  });

  it('marks credential failures FAILED, and an admin retry re-queues them', async () => {
    const buyer = await setup();
    transport.nextResults = [{ ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, message: '401' }];
    await enqueue(buyer.id);
    await runDispatchCycle();
    const note = await db.notification.findFirstOrThrow({ where: { accountId: buyer.id } });
    expect(note).toMatchObject({ status: 'FAILED', errorCategory: 'AUTH' });

    await createTestAdmin();
    const admin = await signIn();
    const retried = await admin.post(`${ADMIN}/history/${note.id}/retry`);
    expect(retried.status).toBe(200);
    await runDispatchCycle();
    expect((await db.notification.findUniqueOrThrow({ where: { id: note.id } })).status).toBe('SENT');

    const again = await admin.post(`${ADMIN}/history/${note.id}/retry`);
    expect(again.status).toBe(409);
  });

  it('recovers events left leased by a crashed worker', async () => {
    const buyer = await setup();
    await enqueue(buyer.id);
    await db.notificationEvent.updateMany({
      data: { status: 'PROCESSING', lockedUntil: new Date(Date.now() - 60_000), attempts: 1 },
    });
    await runDispatchCycle();
    expect((await db.notificationEvent.findFirstOrThrow()).status).toBe('PROCESSED');
    expect(await db.notification.count()).toBe(1);
  });
});

describe('devices and inbox (customer API)', () => {
  const installation = () => `install-${randomUUID()}`;
  const token = () => `fcm-${randomUUID()}-${randomUUID()}`;

  it('requires sign-in', async () => {
    expect((await request(app).put('/api/v1/account/devices').send({})).status).toBe(401);
    expect((await request(app).get('/api/v1/account/notifications')).status).toBe(401);
  });

  it('registers, refreshes and moves a device between accounts', async () => {
    const first = await createTestBuyer();
    const second = await createTestBuyer();
    const id = installation();
    const put = (buyer: { token: string }, fcmToken: string) =>
      request(app).put('/api/v1/account/devices').auth(buyer.token, { type: 'bearer' })
        .send({ installationId: id, token: fcmToken, platform: 'ANDROID', appVersion: '1.0.0' });

    expect((await put(first, token())).status).toBe(200);
    const refreshed = token();
    expect((await put(first, refreshed)).status).toBe(200);
    expect(await db.deviceRegistration.count()).toBe(1);

    // Same install signs in as someone else: ownership moves, the old account loses it.
    expect((await put(second, refreshed)).status).toBe(200);
    const row = await db.deviceRegistration.findFirstOrThrow();
    expect(row.accountId).toBe(second.id);
  });

  it('only unregisters the caller’s own device and tolerates repeats', async () => {
    const owner = await createTestBuyer();
    const other = await createTestBuyer();
    const id = installation();
    await request(app).put('/api/v1/account/devices').auth(owner.token, { type: 'bearer' })
      .send({ installationId: id, token: token(), platform: 'ANDROID' });

    await request(app).delete(`/api/v1/account/devices/${id}`).auth(other.token, { type: 'bearer' });
    expect(await db.deviceRegistration.count()).toBe(1);
    const removed = await request(app).delete(`/api/v1/account/devices/${id}`).auth(owner.token, { type: 'bearer' });
    expect(removed.status).toBe(200);
    expect((await request(app).delete(`/api/v1/account/devices/${id}`).auth(owner.token, { type: 'bearer' })).status).toBe(200);
    expect(await db.deviceRegistration.count()).toBe(0);
  });

  it('lists only the caller’s notifications and scopes read actions to them', async () => {
    const mine = await createTestBuyer();
    const theirs = await createTestBuyer();
    const make = (accountId: string, title: string) =>
      db.notification.create({
        data: { accountId, eventKey: 'ORDER_PLACED', title, body: 'b', pushTitle: title, pushBody: 'b', targetScreen: 'HOME', status: 'SENT' },
      });
    const a = await make(mine.id, 'Mine 1');
    await make(mine.id, 'Mine 2');
    const foreign = await make(theirs.id, 'Theirs');

    const list = await request(app).get('/api/v1/account/notifications').auth(mine.token, { type: 'bearer' });
    expect(list.body.data.items.map((n: { title: string }) => n.title).sort()).toEqual(['Mine 1', 'Mine 2']);
    expect(list.body.data.unreadCount).toBe(2);

    const cross = await request(app).post(`/api/v1/account/notifications/${foreign.id}/read`).auth(mine.token, { type: 'bearer' });
    expect(cross.status).toBe(404);
    expect((await db.notification.findUniqueOrThrow({ where: { id: foreign.id } })).readAt).toBeNull();

    expect((await request(app).post(`/api/v1/account/notifications/${a.id}/read`).auth(mine.token, { type: 'bearer' })).status).toBe(200);
    const all = await request(app).post('/api/v1/account/notifications/read-all').auth(mine.token, { type: 'bearer' });
    expect(all.body.data.updated).toBe(1);
    expect((await db.notification.findUniqueOrThrow({ where: { id: foreign.id } })).readAt).toBeNull();
  });

  it('removes devices and inbox entries when the account is deleted', async () => {
    const buyer = await createTestBuyer();
    await request(app).put('/api/v1/account/devices').auth(buyer.token, { type: 'bearer' })
      .send({ installationId: installation(), token: token(), platform: 'ANDROID' });
    await db.notification.create({
      data: { accountId: buyer.id, eventKey: 'ORDER_PLACED', title: 't', body: 'b', pushTitle: 't', pushBody: 'b', targetScreen: 'HOME' },
    });
    expect((await request(app).delete('/api/v1/account/me').auth(buyer.token, { type: 'bearer' })).status).toBe(200);
    expect(await db.deviceRegistration.count()).toBe(0);
    expect(await db.notification.count()).toBe(0);
  });
});
