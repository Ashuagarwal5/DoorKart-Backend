import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createAccountSession } from '../src/modules/accounts/account-session.js';
import { setGoogleVerifier } from '../src/modules/accounts/google.service.js';
import { setMailTransport } from '../src/modules/settings/mailer.js';
import { encryptSecret } from '../src/lib/secrets.js';
import { app, type Fixtures, getStock, historicalGuestOrder, orderPayload, prisma, resetDatabase, seedFixtures } from './helpers.js';

let fixtures: Fixtures;
let owner: { id: string; token: string };
let other: { id: string; token: string };

async function account(email: string) {
  const saved = await prisma.account.create({ data: { email, emailVerifiedAt: new Date() } });
  return { id: saved.id, token: (await createAccountSession(saved.id, new Date())).token };
}

function payload() {
  return orderPayload({ deliveryAreaId: fixtures.areas.standard.id,
    items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] });
}

const list = (token: string) => request(app).get('/api/v1/account/orders').auth(token, { type: 'bearer' });
const place = (token: string, body: object = payload()) => request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body);

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  owner = await account('owner@example.test');
  other = await account('other@example.test');
});

afterEach(() => { setGoogleVerifier(null); setMailTransport(null); });

describe('account order ownership', () => {
  it('links new purchases from a validated session and returns history without credentials', async () => {
    const purchase = await place(owner.token);
    expect(purchase.status).toBe(201);
    const stored = await prisma.order.findUniqueOrThrow({ where: { orderNumber: purchase.body.data.orderNumber } });
    expect(stored.accountId).toBe(owner.id);
    const history = await list(owner.token);
    expect(history.status).toBe(200);
    expect(history.headers['cache-control']).toBe('no-store');
    expect(history.body.data.items).toHaveLength(1);
    expect(history.body.data.items[0].orderNumber).toBe(stored.orderNumber);
    for (const field of ['trackingToken', 'requestFingerprint', 'clientRequestId', 'accountId', 'customerId']) {
      expect(history.body.data.items[0]).not.toHaveProperty(field);
    }
    expect((await list(other.token)).body.data.items).toEqual([]);
  });

  it('restores the same history after logout and sign-in with a new session', async () => {
    const purchase = await place(owner.token);
    expect((await request(app).post('/api/v1/auth/logout').auth(owner.token, { type: 'bearer' })).status).toBe(200);
    expect((await list(owner.token)).status).toBe(401);
    const newSession = await createAccountSession(owner.id, new Date());
    const history = await list(newSession.token);
    expect(history.body.data.items[0].orderNumber).toBe(purchase.body.data.orderNumber);
    const detail = await request(app).get(`/api/v1/account/orders/${purchase.body.data.orderNumber}`).auth(newSession.token, { type: 'bearer' });
    expect(detail.status).toBe(200);
    expect(detail.body.data).not.toHaveProperty('trackingToken');
  });

  it('does not claim guest orders even when the same phone is used', async () => {
    const body = payload();
    const guest = await historicalGuestOrder(body);
    expect(guest.status).toBe(201);
    expect((await list(owner.token)).body.data.items).toEqual([]);
    expect((await place(owner.token, body)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    const purchase = await place(owner.token);
    expect(purchase.status).toBe(201);
    expect(await prisma.customer.count()).toBe(1);
    expect((await list(owner.token)).body.data.items).toHaveLength(1);
    const recovered = await request(app).get(`/api/v1/orders/${guest.body.data.orderNumber}`).set('x-tracking-token', guest.body.data.trackingToken);
    expect(recovered.status).toBe(200);
    expect((await request(app).post('/api/v1/orders').send(body)).status).toBe(401);
  });

  it('rejects owner identifiers in request bodies and list queries', async () => {
    expect((await place(owner.token, { ...payload(), accountId: other.id })).status).toBe(400);
    expect((await request(app).get(`/api/v1/account/orders?accountId=${other.id}`).auth(owner.token, { type: 'bearer' })).status).toBe(400);
    expect(await prisma.order.count()).toBe(0);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
  });

  it('does not disclose or cancel another account or guest order by number', async () => {
    const owned = await place(owner.token);
    const guest = await historicalGuestOrder(payload());
    for (const orderNumber of [owned.body.data.orderNumber, guest.body.data.orderNumber, 'DK-20260101-9999']) {
      const url = `/api/v1/account/orders/${orderNumber}`;
      const detail = await request(app).get(url).auth(other.token, { type: 'bearer' });
      const cancel = await request(app).post(`${url}/cancel`).auth(other.token, { type: 'bearer' });
      expect(detail.status).toBe(404);
      expect(cancel.status).toBe(404);
      expect(detail.body.error.code).toBe('ORDER_NOT_FOUND');
      expect(cancel.body.error.code).toBe('ORDER_NOT_FOUND');
    }
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(2);
    expect(await prisma.inventoryTransaction.count()).toBe(2);
  });

  it('uses the existing cancellation lifecycle for an account order on a new device', async () => {
    const purchase = await place(owner.token);
    const response = await request(app).post(`/api/v1/account/orders/${purchase.body.data.orderNumber}/cancel`).auth(owner.token, { type: 'bearer' });
    expect(response.status).toBe(200);
    expect(response.body.data.orderStatus).toBe('CANCELLED');
    expect(response.body.data).not.toHaveProperty('trackingToken');
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
    expect((await request(app).post(`/api/v1/account/orders/${purchase.body.data.orderNumber}/cancel`).auth(owner.token, { type: 'bearer' })).status).toBe(409);
    expect(await prisma.inventoryTransaction.count({ where: { type: 'RELEASE' } })).toBe(1);
  });

  it('rejects missing, malformed, expired and revoked sessions without guest fallback', async () => {
    expect((await request(app).get('/api/v1/account/orders')).status).toBe(401);
    for (const header of ['Bearer invalid', 'Basic invalid', 'Bearer']) {
      expect((await request(app).post('/api/v1/orders').set('Authorization', header).send(payload())).status).toBe(401);
      expect((await request(app).get('/api/v1/account/orders').set('Authorization', header)).status).toBe(401);
    }
    await prisma.accountSession.updateMany({ where: { accountId: owner.id }, data: { expiresAt: new Date(0) } });
    expect((await place(owner.token)).status).toBe(401);
    expect((await list(owner.token)).status).toBe(401);
    await prisma.accountSession.deleteMany({ where: { accountId: other.id } });
    expect((await place(other.token)).status).toBe(401);
    expect(await prisma.order.count()).toBe(0);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
  });

  it('binds idempotent replays to their original account without reserving twice', async () => {
    const body = payload();
    const first = await place(owner.token, body);
    const anotherSession = await createAccountSession(owner.id, new Date());
    const replay = await place(anotherSession.token, body);
    expect(replay.status).toBe(200);
    expect(replay.body.data).toEqual(first.body.data);
    expect((await place(other.token, body)).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await request(app).post('/api/v1/orders').send(body)).status).toBe(401);
    expect(await prisma.order.count()).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('allows only one account to win concurrent identical request ids', async () => {
    const body = payload();
    const responses = await Promise.all([place(owner.token, body), place(other.token, body)]);
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);
  });

  it('paginates only the caller orders and bounds page size', async () => {
    await place(owner.token);
    await place(owner.token);
    await place(other.token);
    const first = await request(app).get('/api/v1/account/orders?limit=1&page=1').auth(owner.token, { type: 'bearer' });
    const second = await request(app).get('/api/v1/account/orders?limit=1&page=2').auth(owner.token, { type: 'bearer' });
    expect(first.body.data.pagination).toMatchObject({ total: 2, totalPages: 2 });
    expect(first.body.data.items[0].orderNumber).not.toBe(second.body.data.items[0].orderNumber);
    expect((await request(app).get('/api/v1/account/orders?limit=101').auth(owner.token, { type: 'bearer' })).status).toBe(400);
  });

  it('preserves orders and guest credentials on account deletion without linking a recreated account', async () => {
    const purchase = await place(owner.token);
    expect((await request(app).delete('/api/v1/account/me').auth(owner.token, { type: 'bearer' })).status).toBe(200);
    const stored = await prisma.order.findUniqueOrThrow({ where: { orderNumber: purchase.body.data.orderNumber } });
    expect(stored.accountId).toBeNull();
    expect((await list(owner.token)).status).toBe(401);
    const recreated = await account('owner@example.test');
    expect((await list(recreated.token)).body.data.items).toEqual([]);
    expect((await request(app).get(`/api/v1/orders/${stored.orderNumber}`).set('x-tracking-token', purchase.body.data.trackingToken)).status).toBe(200);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('recovers purchases through verified email OTP and Google sign-in to the same account', async () => {
    await prisma.setting.createMany({ data: [
      { key: 'smtp.host', value: 'smtp.example.test' },
      { key: 'smtp.user', value: 'shop@example.test' },
      { key: 'smtp.fromEmail', value: 'shop@example.test' },
      { key: 'smtp.password', value: encryptSecret('test-only-smtp-password'), isSecret: true },
      { key: 'auth.googleEnabled', value: 'true' },
      { key: 'google.webClientId', value: 'test.apps.googleusercontent.com' },
    ] });
    let code = '';
    setMailTransport(async (_config, message) => { code = /\b(\d{6})\b/.exec(message.text)?.[1] ?? ''; });
    expect((await request(app).post('/api/v1/auth/email-otp/request').send({ email: 'new@example.test' })).status).toBe(200);
    const email = await request(app).post('/api/v1/auth/email-otp/verify').send({ email: 'new@example.test', code });
    expect(email.status).toBe(200);
    const purchase = await place(email.body.data.token);
    expect(purchase.status).toBe(201);
    setGoogleVerifier(async () => ({ subject: 'verified-test-subject', email: 'new@example.test', emailVerified: true, name: 'Buyer' }));
    const unlinked = await request(app).post('/api/v1/auth/google').send({ idToken: 'test-only-google-id-token' });
    expect(unlinked.status).toBe(409);
    expect(unlinked.body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    const linked = await request(app).post('/api/v1/account/google/link').auth(email.body.data.token, { type: 'bearer' }).send({ idToken: 'test-only-google-id-token' });
    expect(linked.status).toBe(200);
    await request(app).post('/api/v1/auth/logout').auth(email.body.data.token, { type: 'bearer' });
    const google = await request(app).post('/api/v1/auth/google').send({ idToken: 'test-only-google-id-token' });
    expect(google.status).toBe(200);
    expect(google.body.data.account.id).toBe(email.body.data.account.id);
    expect((await list(google.body.data.token)).body.data.items[0].orderNumber).toBe(purchase.body.data.orderNumber);
  });
});
