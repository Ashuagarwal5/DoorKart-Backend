import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { app, createTestBuyer, type Fixtures, getStock, orderPayload, prisma, resetDatabase, seedFixtures } from './helpers.js';

let fixtures: Fixtures;
let token: string;

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  token = (await createTestBuyer()).token;
});

function payload() {
  return orderPayload({
    deliveryAreaId: fixtures.areas.standard.id,
    items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
  });
}

async function expectNoPurchaseWrites() {
  expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
  for (const count of await Promise.all([
    prisma.order.count(), prisma.orderItem.count(), prisma.orderStatusHistory.count(),
    prisma.paymentStatusHistory.count(), prisma.inventoryTransaction.count(),
    prisma.customer.count(), prisma.orderCounter.count(),
  ])) {
    expect(count).toBe(0);
  }
}

describe('delivery pincode serviceability', () => {
  it('accepts matching pincodes for authenticated checkout', async () => {
    const purchase = request(app).post('/api/v1/orders').auth(token, { type: 'bearer' });
    const body = payload();
    body.address.pincode = ` ${fixtures.areas.standard.pincode} `;
    const response = await purchase.send(body);
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      paymentMethod: 'COD', paymentStatus: 'PENDING',
      deliveryAddress: { pincode: fixtures.areas.standard.pincode },
      deliveryChargePaise: 3000, grandTotalPaise: 37900,
    });
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 1 });
  });

  it.each([undefined, null, '', '12345', '1234567', '012345', 'ABCDEF', 226001])(
    'rejects malformed or missing pincode %s without purchase writes', async (pincode) => {
      const body = payload();
      const response = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send({
        ...body, address: { ...body.address, pincode },
      });
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
      await expectNoPurchaseWrites();
    }
  );

  it('rejects a pincode supported by another area but not the selected area', async () => {
    await prisma.deliveryArea.update({ where: { id: fixtures.areas.withMinimum.id }, data: { pincode: '226002' } });
    const body = payload();
    body.address.pincode = '226002';
    const response = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body);
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('DELIVERY_PINCODE_UNSUPPORTED');
    await expectNoPurchaseWrites();
  });

  it('uses current database configuration rather than a fixed list', async () => {
    await prisma.deliveryArea.update({ where: { id: fixtures.areas.standard.id }, data: { pincode: '226002' } });
    const body = payload();
    expect((await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body)).status).toBe(422);
    await expectNoPurchaseWrites();
    body.address.pincode = '226002';
    expect((await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body)).status).toBe(201);
  });

  it('rejects areas without a configured pincode', async () => {
    await prisma.deliveryArea.update({ where: { id: fixtures.areas.standard.id }, data: { pincode: null } });
    const response = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(payload());
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('DELIVERY_PINCODE_UNSUPPORTED');
    await expectNoPurchaseWrites();
  });

  it('rejects an inactive area even when its pincode matches', async () => {
    await prisma.deliveryArea.update({ where: { id: fixtures.areas.standard.id }, data: { isActive: false } });
    const response = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(payload());
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('DELIVERY_AREA_UNAVAILABLE');
    await expectNoPurchaseWrites();
  });

  it('preserves successful replays after area configuration changes', async () => {
    const body = payload();
    const first = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body);
    expect(first.status).toBe(201);
    await prisma.deliveryArea.update({ where: { id: fixtures.areas.standard.id }, data: { pincode: null, isActive: false } });
    const replay = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send(body);
    expect(replay.status).toBe(200);
    expect(replay.headers['idempotent-replayed']).toBe('true');
    expect(replay.body.data).toEqual(first.body.data);
    expect(await prisma.order.count()).toBe(1);
    expect(await prisma.inventoryTransaction.count()).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
    const changed = await request(app).post('/api/v1/orders').auth(token, { type: 'bearer' }).send({ ...body, address: { ...body.address, pincode: '226002' } });
    expect(changed.status).toBe(409);
    expect(changed.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
  });
});
