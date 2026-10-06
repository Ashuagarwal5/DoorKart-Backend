import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { ORDER_TRANSITIONS } from '../src/modules/orders/order-lifecycle.js';
import {
  type AdminAgent,
  advance,
  app,
  createTestAdmin,
  type Fixtures,
  getStock,
  placeTestOrder,
  prisma,
  resetDatabase,
  seedFixtures,
  signIn,
} from './helpers.js';

let fixtures: Fixtures;
let admin: AdminAgent;
let adminId: string;

const status = (orderId: string, to: string, note?: string) =>
  admin.patch(`/api/v1/admin/orders/${orderId}/status`).send({ status: to, note });
const payment = (orderId: string, to: string, note?: string) =>
  admin.patch(`/api/v1/admin/orders/${orderId}/payment`).send({ paymentStatus: to, note });

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  adminId = (await createTestAdmin()).id;
  admin = await signIn();
});

describe('order status transitions', () => {
  it('walks an order through the normal path, one valid step at a time', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);

    for (const next of ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']) {
      const response = await status(order.id, next);
      expect(response.status, next).toBe(200);
      expect(response.body.data.orderStatus).toBe(next);
    }
  });

  it('refuses every move that is not in the rulebook', async () => {
    const all = Object.keys(ORDER_TRANSITIONS);
    const invalid: [string, string][] = [];
    for (const from of all) {
      for (const to of all) {
        if (!ORDER_TRANSITIONS[from as keyof typeof ORDER_TRANSITIONS].includes(to as never)) {
          invalid.push([from, to]);
        }
      }
    }
    expect(invalid.length).toBeGreaterThan(30);

    // Check a representative spread through the API, including the ones that matter most.
    const cases: [string[], string][] = [
      [['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'], 'PACKED'], // DELIVERED -> PACKED
      [['CANCELLED'], 'CONFIRMED'], // CANCELLED -> CONFIRMED
      [[], 'PACKED'], // PLACED -> PACKED (skipping a step)
      [[], 'DELIVERED'], // PLACED -> DELIVERED
      [[], 'PLACED'], // nothing moves back to PLACED
      [['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY'], 'CANCELLED'], // goods are on the road
      [['CONFIRMED'], 'OUT_FOR_DELIVERY'], // CONFIRMED -> OUT (skipping PACKED)
    ];
    for (const [path, target] of cases) {
      const order = await placeTestOrder(
        fixtures,
        [{ productId: fixtures.products.pencil.id, quantity: 1 }],
        { mobile: `98765432${String(10 + cases.length).slice(-2)}` }
      );
      await advance(admin, order.id, path);
      const before = (await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderStatus;

      const response = await status(order.id, target);

      expect(response.status, `${before} -> ${target}`).toBe(409);
      expect(response.body.error.code).toBe('INVALID_ORDER_TRANSITION');
      expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderStatus).toBe(before);
    }
  });

  it('records every change in the status history, with who made it and any note', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);

    await status(order.id, 'CONFIRMED', 'Called the customer');
    await status(order.id, 'PACKED');

    const detail = await admin.get(`/api/v1/admin/orders/${order.id}`);
    const history = detail.body.data.statusHistory;

    expect(history.map((entry: { status: string }) => entry.status)).toEqual(['PLACED', 'CONFIRMED', 'PACKED']);
    // Placing the order was the customer's doing; the rest are the admin's.
    expect(history[0].changedBy).toBeNull();
    expect(history[1]).toMatchObject({ note: 'Called the customer', changedBy: { id: adminId, name: 'Test Admin' } });
    expect(history[2].changedBy.id).toBe(adminId);
    expect(new Date(history[2].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(history[1].createdAt).getTime());
  });

  it('writes no history when a change is refused', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);

    await status(order.id, 'DELIVERED');

    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('says what an order may do next, straight from the server rules', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    await advance(admin, order.id, ['CONFIRMED']);

    const detail = await admin.get(`/api/v1/admin/orders/${order.id}`);

    expect(detail.body.data.allowedNextStatuses).toEqual(['PACKED', 'CANCELLED']);
    expect(detail.body.data.canCollectPayment).toBe(false);
  });

  it('answers 404 for an order that does not exist, and 400 for nonsense', async () => {
    expect((await status('no-such-order', 'CONFIRMED')).status).toBe(404);
    expect((await admin.patch('/api/v1/admin/orders/x/status').send({ status: 'SHIPPED' })).status).toBe(400);
    expect((await admin.patch('/api/v1/admin/orders/x/status').send({})).status).toBe(400);
  });

  it('allows a failed delivery to go out again, keeping the stock reserved meanwhile', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 2 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERY_FAILED']);

    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 2 });

    await advance(admin, order.id, ['OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 8, reservedQuantity: 0 });
  });
});

describe('inventory through the order lifecycle', () => {
  it('reserves stock when the order is placed, without selling it', async () => {
    await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 3 }]);

    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 3 });
  });

  it('keeps stock untouched at OUT_FOR_DELIVERY and sells it on DELIVERED', async () => {
    const order = await placeTestOrder(fixtures, [
      { productId: fixtures.products.notebook.id, quantity: 3 },
      { productId: fixtures.products.pencil.id, quantity: 4 },
    ]);

    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 3 });

    await status(order.id, 'DELIVERED');

    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 7, reservedQuantity: 0 });
    expect(await getStock(fixtures.products.pencil.id)).toEqual({ stockQuantity: 96, reservedQuantity: 0 });

    const sales = await prisma.inventoryTransaction.findMany({
      where: { orderId: order.id, type: 'SALE' },
      orderBy: { quantity: 'asc' },
    });
    expect(sales.map((sale) => sale.quantity)).toEqual([3, 4]);
    expect(sales.every((sale) => sale.adminUserId === adminId)).toBe(true);
  });

  it('cannot deliver twice: the second attempt changes nothing', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 3 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);

    const again = await status(order.id, 'DELIVERED');

    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('INVALID_ORDER_TRANSITION');
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 7, reservedQuantity: 0 });
    expect(await prisma.inventoryTransaction.count({ where: { orderId: order.id, type: 'SALE' } })).toBe(1);
  });

  it('delivers once even when the same request arrives many times at once', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 3 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);

    const responses = await Promise.all(Array.from({ length: 6 }, () => status(order.id, 'DELIVERED')));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409, 409]);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 7, reservedQuantity: 0 });
    expect(await prisma.inventoryTransaction.count({ where: { orderId: order.id, type: 'SALE' } })).toBe(1);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: order.id, status: 'DELIVERED' } })).toBe(1);
  });

  it('releases the reservation when an admin cancels, and keeps the order and its totals', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 4 }]);
    await advance(admin, order.id, ['CONFIRMED']);

    const response = await status(order.id, 'CANCELLED', 'Customer called to cancel');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      orderStatus: 'CANCELLED',
      grandTotalPaise: order.grandTotalPaise,
      paymentStatus: 'PENDING',
    });
    expect(response.body.data.cancelledAt).not.toBeNull();
    expect(response.body.data.items).toHaveLength(1);

    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
    const releases = await prisma.inventoryTransaction.findMany({ where: { orderId: order.id, type: 'RELEASE' } });
    expect(releases).toHaveLength(1);
    expect(releases[0]).toMatchObject({ quantity: 4, adminUserId: adminId });
    expect(await prisma.order.count()).toBe(1);
  });

  it('can cancel an order that has been packed', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 2 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED']);

    expect((await status(order.id, 'CANCELLED')).status).toBe(200);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
  });

  it('cannot release the reservation twice, even when the cancel is retried or doubled', async () => {
    const other = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9123456780' });
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 4 }]);

    const responses = await Promise.all(Array.from({ length: 5 }, () => status(order.id, 'CANCELLED')));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409]);

    const retry = await status(order.id, 'CANCELLED');
    expect(retry.status).toBe(409);

    // Only this order's 4 units came back; the other order's 1 is still held.
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 1 });
    expect(await prisma.inventoryTransaction.count({ where: { orderId: order.id, type: 'RELEASE' } })).toBe(1);
    expect(other.orderNumber).not.toBe(order.orderNumber);
  });

  it('cancelling and delivering at the same moment: exactly one wins, stock stays consistent', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 3 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);

    // A cancel is not valid from OUT_FOR_DELIVERY at all, so it must lose to delivery.
    const [delivered, cancelled] = await Promise.all([status(order.id, 'DELIVERED'), status(order.id, 'CANCELLED')]);

    expect(delivered.status).toBe(200);
    expect(cancelled.status).toBe(409);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 7, reservedQuantity: 0 });
  });

  it('keeps the customer-facing cancel working and consistent with the admin one', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 2 }]);
    await advance(admin, order.id, ['CONFIRMED']);

    // The customer may only cancel a PLACED order, so this is refused once confirmed.
    const refused = await request(app)
      .post(`/api/v1/orders/${order.orderNumber}/cancel`)
      .set('x-tracking-token', order.trackingToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error.code).toBe('ORDER_CANNOT_BE_CANCELLED');
    expect(await getStock(fixtures.products.notebook.id)).toEqual({ stockQuantity: 10, reservedQuantity: 2 });
  });

  it('shows the customer the new status through the public order API', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED']);

    const publicView = await request(app)
      .get(`/api/v1/orders/${order.orderNumber}`)
      .set('x-tracking-token', order.trackingToken);

    expect(publicView.body.data.orderStatus).toBe('PACKED');
    expect(publicView.body.data.statusHistory.map((entry: { status: string }) => entry.status)).toEqual([
      'PLACED',
      'CONFIRMED',
      'PACKED',
    ]);
    // The customer never sees which admin did it.
    expect(JSON.stringify(publicView.body)).not.toContain('Test Admin');
  });
});

describe('cash on delivery payment', () => {
  const placeAndSendOut = async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);
    return order;
  };

  it('starts PENDING and stays PENDING through delivery', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    expect((await admin.get(`/api/v1/admin/orders/${order.id}`)).body.data.paymentStatus).toBe('PENDING');

    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);

    const delivered = await admin.get(`/api/v1/admin/orders/${order.id}`);
    // Delivered is not paid: the cash is still owed until someone records it.
    expect(delivered.body.data).toMatchObject({ orderStatus: 'DELIVERED', paymentStatus: 'PENDING', canCollectPayment: true });
    expect(delivered.body.data.paymentCollectedAt).toBeNull();
  });

  it('records collection after delivery, with who and when', async () => {
    const order = await placeAndSendOut();
    await status(order.id, 'DELIVERED');

    const response = await payment(order.id, 'COLLECTED', 'Paid in cash at the door');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ orderStatus: 'DELIVERED', paymentStatus: 'COLLECTED', canCollectPayment: false });
    expect(response.body.data.paymentCollectedAt).not.toBeNull();
    expect(response.body.data.paymentHistory).toEqual([
      expect.objectContaining({
        fromStatus: 'PENDING',
        toStatus: 'COLLECTED',
        note: 'Paid in cash at the door',
        changedBy: { id: adminId, name: 'Test Admin' },
      }),
    ]);
  });

  it('also allows collecting while the order is out for delivery, and delivering afterwards', async () => {
    const order = await placeAndSendOut();

    expect((await payment(order.id, 'COLLECTED')).status).toBe(200);
    expect((await status(order.id, 'DELIVERED')).status).toBe(200);
  });

  it('refuses to collect twice, and never moves a payment backwards', async () => {
    const order = await placeAndSendOut();
    await payment(order.id, 'COLLECTED');

    for (const target of ['COLLECTED', 'PENDING', 'REFUNDED']) {
      const response = await payment(order.id, target);
      expect(response.status, target).toBe(409);
      expect(response.body.error.code).toBe('INVALID_PAYMENT_TRANSITION');
    }
    expect(await prisma.paymentStatusHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('refuses a refund or a reset on a payment that was never collected', async () => {
    const order = await placeAndSendOut();

    for (const target of ['PENDING', 'REFUNDED']) {
      const response = await payment(order.id, target);
      expect(response.status, target).toBe(409);
      expect(response.body.error.code).toBe('INVALID_PAYMENT_TRANSITION');
    }
  });

  it('refuses to collect cash before the goods are on the road, or for a cancelled order', async () => {
    const early = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    await advance(admin, early.id, ['CONFIRMED', 'PACKED']);
    const tooEarly = await payment(early.id, 'COLLECTED');
    expect(tooEarly.status).toBe(422);
    expect(tooEarly.body.error.code).toBe('PAYMENT_NOT_ALLOWED');

    const cancelled = await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });
    await status(cancelled.id, 'CANCELLED');
    expect((await payment(cancelled.id, 'COLLECTED')).body.error.code).toBe('PAYMENT_NOT_ALLOWED');

    expect(await prisma.paymentStatusHistory.count()).toBe(0);
  });

  it('records the payment exactly once when the request is doubled', async () => {
    const order = await placeAndSendOut();

    const responses = await Promise.all(Array.from({ length: 5 }, () => payment(order.id, 'COLLECTED')));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409, 409, 409, 409]);
    expect(await prisma.paymentStatusHistory.count({ where: { orderId: order.id } })).toBe(1);
  });

  it('will not cancel or fail an order whose cash was already taken (no refunds yet)', async () => {
    const order = await placeAndSendOut();
    await payment(order.id, 'COLLECTED');

    const failed = await status(order.id, 'DELIVERY_FAILED');

    expect(failed.status).toBe(409);
    expect(failed.body.error.message).toMatch(/refund/i);
    expect((await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).orderStatus).toBe('OUT_FOR_DELIVERY');
  });

  it('lets the customer see the payment status through the public order API', async () => {
    const order = await placeAndSendOut();
    await status(order.id, 'DELIVERED');
    await payment(order.id, 'COLLECTED');

    const publicView = await request(app)
      .get(`/api/v1/orders/${order.orderNumber}`)
      .set('x-tracking-token', order.trackingToken);
    expect(publicView.body.data).toMatchObject({ orderStatus: 'DELIVERED', paymentStatus: 'COLLECTED' });
  });
});

describe('admin order list and detail', () => {
  it('lists orders newest first with the fields an admin needs, and no secrets', async () => {
    const first = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    const second = await placeTestOrder(
      fixtures,
      [
        { productId: fixtures.products.notebook.id, quantity: 2 },
        { productId: fixtures.products.pencil.id, quantity: 1 },
      ],
      { mobile: '9123456780' }
    );

    const response = await admin.get('/api/v1/admin/orders');

    expect(response.status).toBe(200);
    expect(response.body.data.items.map((item: { orderNumber: string }) => item.orderNumber)).toEqual([
      second.orderNumber,
      first.orderNumber,
    ]);
    expect(response.body.data.items[0]).toMatchObject({
      id: second.id,
      customerName: 'Ravi Kumar',
      customerPhone: '9123456780',
      itemCount: 3,
      subtotalPaise: 84750,
      deliveryChargePaise: 0,
      grandTotalPaise: 84750,
      orderStatus: 'PLACED',
      paymentStatus: 'PENDING',
    });
    expect(response.body.data.pagination).toEqual({ page: 1, limit: 25, total: 2, totalPages: 1 });

    const everything = JSON.stringify(response.body);
    expect(everything).not.toContain(first.trackingToken);
    expect(everything).not.toContain(second.trackingToken);
    expect(everything).not.toMatch(/trackingToken|requestFingerprint|clientRequestId/);
  });

  it('never exposes the tracking token or request fingerprint on an order detail either', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);

    const detail = await admin.get(`/api/v1/admin/orders/${order.id}`);

    expect(detail.status).toBe(200);
    expect(JSON.stringify(detail.body)).not.toMatch(/trackingToken|requestFingerprint|clientRequestId/);
    expect(JSON.stringify(detail.body)).not.toContain(order.trackingToken);
    expect(detail.body.data).toMatchObject({
      orderNumber: order.orderNumber,
      deliveryAddress: { addressLine1: '12 Shastri Street', city: 'Testpur', area: 'Station Road' },
      items: [expect.objectContaining({ sku: 'T-001', unitPricePaise: 34900, quantity: 1 })],
    });
  });

  it('filters by status and payment status', async () => {
    const a = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });
    await advance(admin, a.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    await payment(a.id, 'COLLECTED');

    const delivered = await admin.get('/api/v1/admin/orders?status=DELIVERED');
    expect(delivered.body.data.items.map((item: { id: string }) => item.id)).toEqual([a.id]);

    const unpaid = await admin.get('/api/v1/admin/orders?paymentStatus=PENDING');
    expect(unpaid.body.data.pagination.total).toBe(1);

    const both = await admin.get('/api/v1/admin/orders?status=DELIVERED&paymentStatus=PENDING');
    expect(both.body.data.pagination.total).toBe(0);
  });

  it('searches by order number, customer name and phone', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9876500001' });
    await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });
    const find = async (term: string) =>
      (await admin.get(`/api/v1/admin/orders?search=${encodeURIComponent(term)}`)).body.data.pagination.total;

    expect(await find(order.orderNumber)).toBe(1);
    expect(await find(order.orderNumber.slice(-4))).toBe(1); // a partial number matches too
    expect(await find('BN-')).toBe(2);
    expect(await find('ravi')).toBe(2);
    expect(await find('9876500001')).toBe(1);
    expect(await find('+91 98765 00001')).toBe(1);
    expect(await find('nobody-by-this-name')).toBe(0);
  });

  it('filters by shop-day date range, in IST', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    // 20:00 UTC on 4 Oct is 01:30 IST on 5 Oct: a different shop day from the UTC date.
    await prisma.order.update({ where: { id: order.id }, data: { createdAt: new Date('2026-10-04T20:00:00Z') } });
    const count = async (query: string) =>
      (await admin.get(`/api/v1/admin/orders?${query}`)).body.data.pagination.total;

    expect(await count('from=2026-10-05&to=2026-10-05')).toBe(1);
    expect(await count('from=2026-10-04&to=2026-10-04')).toBe(0);
    expect(await count('from=2026-10-04&to=2026-10-05')).toBe(1);
    expect(await count('from=2026-10-06')).toBe(0);
    expect(await count('to=2026-10-04')).toBe(0);
  });

  it('paginates with a capped page size', async () => {
    for (let i = 0; i < 3; i += 1) {
      await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: `912345678${i}` });
    }

    const page = await admin.get('/api/v1/admin/orders?page=2&limit=2');
    expect(page.body.data.items).toHaveLength(1);
    expect(page.body.data.pagination).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2 });

    const tooBig = await admin.get('/api/v1/admin/orders?limit=100000');
    expect(tooBig.status).toBe(400);
    expect(tooBig.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects bad filters', async () => {
    for (const query of ['status=SHIPPED', 'from=yesterday', 'from=2026-02-31', 'from=2026-10-05&to=2026-10-01', 'page=0']) {
      const response = await admin.get(`/api/v1/admin/orders?${query}`);
      expect(response.status, query).toBe(400);
    }
  });
});
