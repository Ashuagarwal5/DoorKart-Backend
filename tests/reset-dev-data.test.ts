import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { assertSafeToReset, resetOrderData } from '../scripts/reset-dev-data.js';
import { app, getStock, orderPayload, prisma, resetDatabase, seedFixtures } from './helpers.js';

describe('assertSafeToReset', () => {
  it('allows a database on this machine', () => {
    for (const url of [
      'postgresql://postgres:pw@localhost:5433/buynest',
      'postgresql://postgres:pw@127.0.0.1:5432/buynest',
      'postgresql://postgres:pw@[::1]:5432/buynest',
    ]) {
      expect(() => assertSafeToReset(url, 'development')).not.toThrow();
    }
  });

  it('refuses a remote database, naming the host but never the password', () => {
    const attempt = () =>
      assertSafeToReset('postgresql://admin:s3cret@db.example.com:5432/buynest', 'development');

    expect(attempt).toThrow(/db\.example\.com/);
    expect(attempt).not.toThrow(/s3cret/);
  });

  it('refuses production even for a local database', () => {
    expect(() =>
      assertSafeToReset('postgresql://postgres:pw@localhost:5433/buynest', 'production')
    ).toThrow(/production/);
  });

  it('refuses a missing or invalid DATABASE_URL', () => {
    expect(() => assertSafeToReset(undefined, 'development')).toThrow();
    expect(() => assertSafeToReset('not a url', 'development')).toThrow();
  });
});

describe('resetOrderData', () => {
  beforeEach(async () => {
    await resetDatabase();
  });

  it('removes orders and releases reservations but keeps the catalogue', async () => {
    const fixtures = await seedFixtures();
    await request(app)
      .post('/api/v1/orders')
      .send(
        orderPayload({
          deliveryAreaId: fixtures.areas.standard.id,
          items: [{ productId: fixtures.products.notebook.id, quantity: 3 }],
        })
      );
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(3);

    const removed = await resetOrderData(prisma);

    expect(removed).toBe(1);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({
      stockQuantity: 10,
      reservedQuantity: 0,
    });
    expect(await prisma.product.count()).toBe(6);
    expect(await prisma.deliveryArea.count()).toBe(3);

    // Order numbers start again from the first of the day.
    const next = await request(app)
      .post('/api/v1/orders')
      .send(
        orderPayload({
          deliveryAreaId: fixtures.areas.standard.id,
          items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
        })
      );
    expect(next.body.data.orderNumber).toMatch(/-1001$/);
  });
});
