import { randomUUID } from 'node:crypto';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { encryptSecret } from '../src/lib/secrets.js';
import { runDispatchCycle } from '../src/modules/notifications/dispatcher.js';
import { EVENT_DEFINITIONS } from '../src/modules/notifications/events.js';
import {
  type PushMessage,
  type PushResult,
  type PushTransport,
  setPushTransportForTests,
} from '../src/modules/notifications/fcm.js';
import { type MailMessage, setMailTransport } from '../src/modules/settings/mailer.js';
import {
  advance,
  app,
  createTestAdmin,
  createTestBuyer,
  getStock,
  historicalGuestOrder,
  orderPayload,
  prisma,
  resetDatabase,
  seedFixtures,
  signIn,
  type AdminAgent,
  type Fixtures,
} from './helpers.js';

class FakeTransport implements PushTransport {
  sent: PushMessage[] = [];
  failWith: PushResult | null = null;
  async send(_account: unknown, message: PushMessage): Promise<PushResult> {
    this.sent.push(message);
    return this.failWith ?? { ok: true, messageId: `projects/test/messages/${this.sent.length}` };
  }
  async verify(): Promise<PushResult> {
    return { ok: true, messageId: 'validated' };
  }
}

let transport: FakeTransport;
let admin: AdminAgent;
let fixtures: Fixtures;
let buyer: Awaited<ReturnType<typeof createTestBuyer>>;

const keyFile = `-----BEGIN PRIVATE KEY-----\n${'B'.repeat(220)}\n-----END PRIVATE KEY-----\n`;

/** Push is configured, the buyer has a device, and every event has a simple enabled template. */
async function configurePush(accountId: string) {
  await prisma.notificationProviderConfig.create({
    data: {
      id: 'fcm', isEnabled: true, projectId: 'doorkart-test', clientEmail: 'push@doorkart-test.iam.gserviceaccount.com',
      credentialEncrypted: encryptSecret(keyFile),
    },
  });
  await prisma.deviceRegistration.create({
    data: { accountId, installationId: `install-${randomUUID()}`, token: `token-${randomUUID()}-abcdefghij`, platform: 'ANDROID' },
  });
  await prisma.notificationTemplate.createMany({
    data: EVENT_DEFINITIONS.map((event) => ({
      key: event.key.toLowerCase(), name: event.name, eventKey: event.key, isEnabled: true,
      title: event.name,
      body: 'Dear {username}, {order_number} {order_status} {refund_amount} {product_summary}',
    })),
  });
}

async function eventKeys(): Promise<string[]> {
  return (await prisma.notificationEvent.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })).map((e) => e.eventKey);
}

async function placeFor(account: { token: string }, quantity = 2) {
  const response = await request(app)
    .post('/api/v1/orders')
    .auth(account.token, { type: 'bearer' })
    .send(orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.notebook.id, quantity }] }));
  expect(response.status).toBe(201);
  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: response.body.data.orderNumber } });
  return { id: order.id, orderNumber: order.orderNumber };
}

beforeEach(async () => {
  await resetDatabase();
  transport = new FakeTransport();
  setPushTransportForTests(transport);
  fixtures = await seedFixtures();
  await createTestAdmin();
  admin = await signIn();
  buyer = await createTestBuyer();
});
afterEach(() => setPushTransportForTests(null));

describe('order and payment events', () => {
  it('queues ORDER_PLACED once, even when the same request is replayed', async () => {
    const body = orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] });
    const first = await request(app).post('/api/v1/orders').auth(buyer.token, { type: 'bearer' }).send(body);
    const replay = await request(app).post('/api/v1/orders').auth(buyer.token, { type: 'bearer' }).send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(await eventKeys()).toEqual(['ORDER_PLACED']);
  });

  it('queues one event per real transition and renders it from the stored snapshot', async () => {
    await configurePush(buyer.id);
    const order = await placeFor(buyer);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect((await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({ paymentStatus: 'COLLECTED' })).status).toBe(200);

    expect(await eventKeys()).toEqual([
      'ORDER_PLACED', 'ORDER_CONFIRMED', 'ORDER_PACKED', 'ORDER_OUT_FOR_DELIVERY', 'ORDER_DELIVERED', 'PAYMENT_COLLECTED',
    ]);

    while ((await runDispatchCycle()).notifications > 0) { /* drain */ }
    const delivered = await prisma.notification.findFirstOrThrow({ where: { eventKey: 'ORDER_DELIVERED' } });
    expect(delivered.accountId).toBe(buyer.id);
    expect(delivered.status).toBe('SENT');
    expect(delivered.body).toContain(order.orderNumber);
    expect(delivered.body).toContain('Delivered');
    expect(delivered.targetScreen).toBe('ORDER_DETAIL');
    expect(delivered.targetParams).toEqual({ orderNumber: order.orderNumber });
    expect(await prisma.notification.count()).toBe(6);
  });

  it('notifies on customer cancellation without disturbing stock release', async () => {
    const before = await getStock(fixtures.products.notebook.id);
    const order = await placeFor(buyer, 3);
    const cancelled = await request(app).post(`/api/v1/account/orders/${order.orderNumber}/cancel`).auth(buyer.token, { type: 'bearer' });
    expect(cancelled.status).toBe(200);
    expect(await eventKeys()).toEqual(['ORDER_PLACED', 'ORDER_CANCELLED']);
    expect(await getStock(fixtures.products.notebook.id)).toEqual(before);
  });

  it('queues nothing when the business change is refused or rolled back', async () => {
    const order = await placeFor(buyer);
    const refused = await admin.patch(`/api/v1/admin/orders/${order.id}/status`).send({ status: 'DELIVERED' });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    const early = await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({ paymentStatus: 'COLLECTED' });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(await eventKeys()).toEqual(['ORDER_PLACED']);
  });

  it('does not notify anyone for a legacy order without an account', async () => {
    const response = await historicalGuestOrder(
      orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] })
    );
    const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: response.body.data.orderNumber } });
    await prisma.notificationEvent.deleteMany();
    await advance(admin, order.id, ['CONFIRMED']);
    expect(await prisma.notificationEvent.count()).toBe(0);
  });

  it('keeps one customer’s notifications out of another customer’s inbox', async () => {
    await configurePush(buyer.id);
    const other = await createTestBuyer();
    const order = await placeFor(buyer);
    await advance(admin, order.id, ['CONFIRMED']);
    await runDispatchCycle();

    const mine = await request(app).get('/api/v1/account/notifications').auth(buyer.token, { type: 'bearer' });
    const theirs = await request(app).get('/api/v1/account/notifications').auth(other.token, { type: 'bearer' });
    expect(mine.body.data.items.length).toBe(2);
    expect(theirs.body.data.items).toEqual([]);
  });

  it('never lets a push failure undo a delivery or its stock movement', async () => {
    await configurePush(buyer.id);
    transport.failWith = { ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, message: '401' };
    const order = await placeFor(buyer, 2);
    const stock = await getStock(fixtures.products.notebook.id);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    await runDispatchCycle();

    const after = await getStock(fixtures.products.notebook.id);
    expect(after.reservedQuantity).toBe(stock.reservedQuantity - 2);
    expect(after.stockQuantity).toBe(stock.stockQuantity - 2);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderStatus).toBe('DELIVERED');
    expect((await prisma.notification.findFirstOrThrow({ where: { eventKey: 'ORDER_DELIVERED' } })).status).toBe('FAILED');
  });
});

describe('return and refund events', () => {
  const base = '/api/v1/admin/returns';
  const act = (id: string, body: object, requestId = randomUUID()) =>
    admin.post(`${base}/${id}/actions`).send({ requestId, note: 'Checked with the customer in store', ...body });

  it('announces the request, approval, completion and cash refund, once each', async () => {
    await configurePush(buyer.id);
    const order = await placeFor(buyer, 2);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({ paymentStatus: 'COLLECTED' });
    await prisma.notificationEvent.deleteMany();

    const created = await admin.post(base).send({
      clientRequestId: randomUUID(), orderId: order.id, kind: 'REFUND_ONLY',
      reason: 'Customer reported damaged packaging', requestedAmountPaise: 10000, items: [],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as string;
    expect((await act(id, { action: 'APPROVE', approvedAmountPaise: 10000 })).status).toBe(200);
    const completeId = randomUUID();
    expect((await act(id, { action: 'COMPLETE', payoutReference: 'RCPT-77' }, completeId)).status).toBe(200);
    // The same completion retried must not notify again.
    expect((await act(id, { action: 'COMPLETE', payoutReference: 'RCPT-77' }, completeId)).status).toBe(200);

    expect((await eventKeys()).sort()).toEqual(
      ['REFUND_COMPLETED', 'RETURN_APPROVED', 'RETURN_COMPLETED', 'RETURN_REQUESTED']
    );

    while ((await runDispatchCycle()).notifications > 0) { /* drain */ }
    const refund = await prisma.notification.findFirstOrThrow({ where: { eventKey: 'REFUND_COMPLETED' } });
    expect(refund.accountId).toBe(buyer.id);
    expect(refund.targetScreen).toBe('ORDER_DETAIL');
  });

  it('queues no notification for a refused action', async () => {
    const order = await placeFor(buyer, 1);
    await prisma.notificationEvent.deleteMany();
    const refused = await admin.post(base).send({
      clientRequestId: randomUUID(), orderId: order.id, kind: 'REFUND_ONLY',
      reason: 'Customer reported damaged packaging', requestedAmountPaise: 10000, items: [],
    });
    expect(refused.status).toBe(422);
    expect(await prisma.notificationEvent.count()).toBe(0);
  });
});

describe('account and review events', () => {
  const AUTH = '/api/v1/auth';

  it('queues ACCOUNT_REGISTERED when a new account is verified, and not on later sign-ins', async () => {
    const sent: MailMessage[] = [];
    setMailTransport(async (_config, message) => { sent.push(message); });
    await prisma.setting.createMany({ data: [
      { key: 'smtp.host', value: 'smtp.example.test' },
      { key: 'smtp.user', value: 'shop@example.test' },
      { key: 'smtp.password', value: encryptSecret('test-only-smtp-password'), isSecret: true },
    ] });
    const code = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
    const email = 'newbie@example.test';

    try {
      await request(app).post(`${AUTH}/register`).send({ email, fullName: 'Asha Rao', mobile: '+91 98765 43210', termsAccepted: true });
      const verified = await request(app).post(`${AUTH}/register/verify`).send({ email, code: code() });
      expect(verified.status).toBe(200);
      expect(await eventKeys()).toEqual(['ACCOUNT_REGISTERED']);

      // Clear the resend cooldown so a second sign-in code can be requested straight away.
      await prisma.emailOtp.deleteMany();
      await request(app).post(`${AUTH}/email-otp/request`).send({ email });
      const again = await request(app).post(`${AUTH}/email-otp/verify`).send({ email, code: code() });
      expect(again.status).toBe(200);
      expect(await eventKeys()).toEqual(['ACCOUNT_REGISTERED']);
    } finally {
      setMailTransport(null);
    }
  });

  async function pendingReview() {
    const order = await placeFor(buyer, 1);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    const submitted = await request(app)
      .post(`/api/v1/account/reviews/product/${fixtures.products.notebook.id}`)
      .auth(buyer.token, { type: 'bearer' })
      .send({ rating: 5, title: 'Good quality', content: 'The notebook arrived in good condition.' });
    expect(submitted.status).toBe(201);
    await prisma.notificationEvent.deleteMany();
    return submitted.body.data.id as string;
  }

  it('tells the author when their review is approved or rejected', async () => {
    const approvedId = await pendingReview();
    const approve = await admin.post(`/api/v1/admin/reviews/${approvedId}/moderate`).send({ action: 'approve', note: 'ok' });
    expect(approve.status).toBe(200);
    expect(await eventKeys()).toEqual(['REVIEW_APPROVED']);
    const event = await prisma.notificationEvent.findFirstOrThrow();
    expect(event.accountId).toBe(buyer.id);

    // Rejecting the same review later is a different decision and notifies separately.
    const reject = await admin.post(`/api/v1/admin/reviews/${approvedId}/moderate`).send({ action: 'reject', note: 'no' });
    expect(reject.status).toBe(200);
    expect(await eventKeys()).toEqual(['REVIEW_APPROVED', 'REVIEW_REJECTED']);
  });

  it('does not notify for hide/restore or for shop-entered reviews', async () => {
    const id = await pendingReview();
    await admin.post(`/api/v1/admin/reviews/${id}/moderate`).send({ action: 'approve' });
    await prisma.notificationEvent.deleteMany();
    expect((await admin.post(`/api/v1/admin/reviews/${id}/moderate`).send({ action: 'hide' })).status).toBe(200);
    expect((await admin.post(`/api/v1/admin/reviews/${id}/moderate`).send({ action: 'restore' })).status).toBe(200);
    expect(await prisma.notificationEvent.count()).toBe(0);
  });
});
