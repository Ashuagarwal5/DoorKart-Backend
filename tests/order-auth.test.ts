import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createOrderBodySchema } from '../src/modules/orders/orders.schemas.js';
import { createOrder } from '../src/modules/orders/orders.service.js';
import { app, createTestBuyer, type Fixtures, getStock, orderPayload, prisma, resetDatabase, seedFixtures } from './helpers.js';

let fixtures: Fixtures;
let buyer: Awaited<ReturnType<typeof createTestBuyer>>;
const payload = () => orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] });
const place = (body: object = payload()) => request(app).post('/api/v1/orders').auth(buyer.token, { type: 'bearer' }).send(body);

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  buyer = await createTestBuyer();
});

async function noPurchaseWrites() {
  expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
  for (const count of await Promise.all([
    prisma.order.count(), prisma.orderItem.count(), prisma.customer.count(), prisma.orderCounter.count(),
    prisma.inventoryTransaction.count(), prisma.orderStatusHistory.count(), prisma.paymentStatusHistory.count(),
  ])) expect(count).toBe(0);
}

describe('mandatory customer authentication for order creation', () => {
  it('keeps catalog browsing available without a session', async () => {
    for (const endpoint of ['products', 'categories', 'delivery-areas', 'products/classmate-notebook']) {
      expect((await request(app).get(`/api/v1/${endpoint}`)).status).toBe(200);
    }
    await noPurchaseWrites();
  });

  it.each(['valid', 'invalid'])('rejects a guest %s payload before validation or purchase writes', async (kind) => {
    const response = await request(app).post('/api/v1/orders').send(kind === 'valid' ? payload() : {});
    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('UNAUTHENTICATED');
    await noPurchaseWrites();
  });

  it.each(['invalid', 'extra-field', 'padding', 'scheme', 'missing-token', 'multiple-tokens'])('rejects malformed authorization: %s', async (kind) => {
    const headers: Record<string, string> = {
      invalid: 'Bearer invalid', 'extra-field': `Bearer ${buyer.token} extra`, padding: `Bearer ${buyer.token}=`,
      scheme: `Basic ${buyer.token}`, 'missing-token': 'Bearer', 'multiple-tokens': `Bearer ${buyer.token}, Bearer ${buyer.token}`,
    };
    const response = await request(app).post('/api/v1/orders').set('Authorization', headers[kind]!).send(payload());
    expect(response.status).toBe(401);
    await noPurchaseWrites();
  });

  it.each(['expired', 'revoked', 'inactive', 'unverified'])('rejects a %s customer session', async (kind) => {
    if (kind === 'expired') await prisma.accountSession.updateMany({ where: { accountId: buyer.id }, data: { expiresAt: new Date(0) } });
    if (kind === 'revoked') await prisma.accountSession.deleteMany({ where: { accountId: buyer.id } });
    if (kind === 'inactive') await prisma.account.update({ where: { id: buyer.id }, data: { isActive: false } });
    if (kind === 'unverified') await prisma.account.update({ where: { id: buyer.id }, data: { emailVerifiedAt: null } });
    expect((await place()).status).toBe(401);
    await noPurchaseWrites();
  });

  it.each(['accountId', 'customerId'])('rejects client-supplied %s as an identity', async (field) => {
    const another = await createTestBuyer();
    expect((await place({ ...payload(), [field]: another.id })).status).toBe(400);
    expect((await place({ ...payload(), customer: { ...payload().customer, [field]: another.id } })).status).toBe(400);
    await noPurchaseWrites();
  });

  it('links the order to the verified session regardless of contact-name or phone matches', async () => {
    const another = await createTestBuyer();
    const response = await place();
    expect(response.status).toBe(201);
    const saved = await prisma.order.findUniqueOrThrow({ where: { orderNumber: response.body.data.orderNumber } });
    expect(saved.accountId).toBe(buyer.id);
    expect(saved.accountId).not.toBe(another.id);
    expect((await request(app).get('/api/v1/account/orders').auth(another.token, { type: 'bearer' })).body.data.items).toEqual([]);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('requires authentication even when replaying an existing request id', async () => {
    const body = payload();
    expect((await place(body)).status).toBe(201);
    expect((await request(app).post('/api/v1/orders').send(body)).status).toBe(401);
    expect((await place(body)).status).toBe(200);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('does not provide an unauthenticated service-level creation default', async () => {
    await expect(createOrder(createOrderBodySchema.parse(payload()), '')).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    await noPurchaseWrites();
  });
});
