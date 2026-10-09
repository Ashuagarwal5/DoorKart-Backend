import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  app,
  type Fixtures,
  getStock,
  orderPayload,
  prisma,
  resetDatabase,
  seedFixtures,
} from './helpers.js';

const TOKEN_HEADER = 'x-tracking-token';

let fixtures: Fixtures;

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
});

const placeOrder = (body: unknown) => request(app).post('/api/v1/orders').send(body as object);

/** One notebook (₹349) delivered to Station Road (₹30). */
const simpleOrder = (overrides: { clientRequestId?: string; mobile?: string } = {}) =>
  orderPayload({
    deliveryAreaId: fixtures.areas.standard.id,
    items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
    ...overrides,
  });

describe('POST /api/v1/orders', () => {
  it('creates a PLACED, payment-pending COD order with server-calculated totals', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [
          { productId: fixtures.products.notebook.id, quantity: 1 },
          { productId: fixtures.products.pencil.id, quantity: 1 },
        ],
      })
    );

    expect(response.status).toBe(201);
    expect(response.body.success).toBe(true);
    const order = response.body.data;

    // 34900 + 14950 = 49850, one paisa-level step below the ₹500 free-delivery threshold.
    expect(order).toMatchObject({
      orderStatus: 'PLACED',
      paymentMethod: 'COD',
      paymentStatus: 'PENDING',
      subtotalPaise: 49850,
      deliveryChargePaise: 3000,
      discountPaise: 0,
      grandTotalPaise: 52850,
      customerName: 'Ravi Kumar',
      customerPhone: '9876543210',
      deliveryAddress: { area: 'Station Road', city: 'Testpur', addressLine2: null },
    });
    expect(order.orderNumber).toMatch(/^DK-\d{8}-1001$/);
    expect(order.trackingToken).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(order.statusHistory.map((entry: { status: string }) => entry.status)).toEqual(['PLACED']);
    expect(order.items).toHaveLength(2);
    expect(order.items.find((item: { sku: string }) => item.sku === 'T-001')).toMatchObject({
      productName: 'Classmate Notebook',
      productImage: 'https://example.test/notebook.jpg',
      unitPricePaise: 34900,
      quantity: 1,
      lineTotalPaise: 34900,
    });
  });

  it('gives free delivery once the subtotal reaches the area threshold', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [{ productId: fixtures.products.notebook.id, quantity: 2 }],
      })
    );

    expect(response.body.data).toMatchObject({
      subtotalPaise: 69800,
      deliveryChargePaise: 0,
      grandTotalPaise: 69800,
    });
  });

  it('reserves stock without reducing it, and records the movement', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [{ productId: fixtures.products.notebook.id, quantity: 3 }],
      })
    );
    expect(response.status).toBe(201);

    expect(await getStock(fixtures.products.notebook.id)).toEqual({
      stockQuantity: 10,
      reservedQuantity: 3,
    });

    const transactions = await prisma.inventoryTransaction.findMany();
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({
      productId: fixtures.products.notebook.id,
      type: 'RESERVE',
      quantity: 3,
    });

    const listing = await request(app).get('/api/v1/products/classmate-notebook');
    expect(listing.body.data.availableQuantity).toBe(7);
  });

  it('rejects any client-supplied price, total or delivery charge', async () => {
    const tampered = [
      { ...simpleOrder(), grandTotalPaise: 100 },
      { ...simpleOrder(), deliveryChargePaise: 0 },
      {
        ...simpleOrder(),
        items: [{ productId: fixtures.products.notebook.id, quantity: 1, unitPricePaise: 1 }],
      },
    ];

    for (const body of tampered) {
      const response = await placeOrder(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.order.count()).toBe(0);
  });

  it('validates the customer, address and cart', async () => {
    const valid = simpleOrder();
    const invalid = [
      { ...valid, customer: { ...valid.customer, mobile: '12345' } },
      { ...valid, customer: { ...valid.customer, fullName: ' ' } },
      { ...valid, address: { ...valid.address, pincode: '1234' } },
      { ...valid, address: { ...valid.address, addressLine1: '' } },
      { ...valid, items: [] },
      { ...valid, items: [{ productId: fixtures.products.notebook.id, quantity: 0 }] },
      { ...valid, items: [{ productId: fixtures.products.notebook.id, quantity: 1.5 }] },
      { ...valid, paymentMethod: 'UPI' },
    ];

    for (const body of invalid) {
      const response = await placeOrder(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects an order above the available stock', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [{ productId: fixtures.products.notebook.id, quantity: 11 }],
      })
    );

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'OUT_OF_STOCK',
      details: { requestedQuantity: 11, availableQuantity: 10 },
    });
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
  });

  it('rolls everything back when one line of several cannot be fulfilled', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [
          { productId: fixtures.products.notebook.id, quantity: 2 },
          { productId: fixtures.products.soldOut.id, quantity: 1 },
        ],
      })
    );

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('OUT_OF_STOCK');

    // No partial order: the notebook reservation made before the failure is undone too.
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
    expect(await prisma.order.count()).toBe(0);
    expect(await prisma.inventoryTransaction.count()).toBe(0);
    expect(await prisma.customer.count()).toBe(0);
    expect(await prisma.orderCounter.count()).toBe(0);
  });

  it('rejects inactive and unknown products', async () => {
    const order = (productId: string) =>
      placeOrder(
        orderPayload({
          deliveryAreaId: fixtures.areas.standard.id,
          items: [{ productId, quantity: 1 }],
        })
      );

    const inactive = await order(fixtures.products.inactive.id);
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('PRODUCT_UNAVAILABLE');

    const hidden = await order(fixtures.products.inHiddenCategory.id);
    expect(hidden.status).toBe(409);
    expect(hidden.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    expect((await getStock(fixtures.products.inHiddenCategory.id)).reservedQuantity).toBe(0);

    const unknown = await order('does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('PRODUCT_NOT_FOUND');

    expect(await prisma.order.count()).toBe(0);
  });

  it('rejects inactive and unknown delivery areas', async () => {
    const order = (deliveryAreaId: string) =>
      placeOrder(
        orderPayload({
          deliveryAreaId,
          items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
        })
      );

    const inactive = await order(fixtures.areas.inactive.id);
    expect(inactive.status).toBe(409);
    expect(inactive.body.error.code).toBe('DELIVERY_AREA_UNAVAILABLE');

    const unknown = await order('does-not-exist');
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe('DELIVERY_AREA_NOT_FOUND');
  });

  it('enforces the delivery area minimum order and releases the reservation', async () => {
    const response = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.withMinimum.id,
        items: [{ productId: fixtures.products.pencil.id, quantity: 1 }],
      })
    );

    expect(response.status).toBe(422);
    expect(response.body.error).toMatchObject({
      code: 'MINIMUM_ORDER_NOT_MET',
      details: { minimumOrderPaise: 20000, subtotalPaise: 14950, shortfallPaise: 5050 },
    });
    expect((await getStock(fixtures.products.pencil.id)).reservedQuantity).toBe(0);
  });

  it('reuses the customer for a repeat order from the same mobile number', async () => {
    await placeOrder(simpleOrder({ mobile: '9876543210' }));
    await placeOrder(simpleOrder({ mobile: '+91 98765 43210' }));

    expect(await prisma.customer.count()).toBe(1);
    expect(await prisma.order.count()).toBe(2);
  });
});

describe('order idempotency', () => {
  it('returns the original order for a repeated clientRequestId', async () => {
    const body = simpleOrder();
    const first = await placeOrder(body);
    const second = await placeOrder(body);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
    expect(second.body.data.trackingToken).toBe(first.body.data.trackingToken);

    expect(await prisma.order.count()).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('treats an equivalent payload as the same request', async () => {
    const clientRequestId = 'equivalent-request-0001';
    const items = [
      { productId: fixtures.products.notebook.id, quantity: 1 },
      { productId: fixtures.products.pencil.id, quantity: 2 },
    ];
    const first = await placeOrder(
      orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items, clientRequestId })
    );

    // Same purchase, written differently: items reordered, mobile in another format.
    const second = await placeOrder(
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [...items].reverse(),
        clientRequestId,
        mobile: '+91 98765 43210',
      })
    );

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.data.orderNumber).toBe(first.body.data.orderNumber);
    expect(await prisma.order.count()).toBe(1);
  });

  it('rejects a repeated clientRequestId whose payload is different', async () => {
    const clientRequestId = 'conflicting-request-0001';
    const original = orderPayload({
      deliveryAreaId: fixtures.areas.standard.id,
      items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
      clientRequestId,
    });
    const first = await placeOrder(original);
    expect(first.status).toBe(201);
    const originalToken: string = first.body.data.trackingToken;

    const variants = {
      'a larger quantity': {
        ...original,
        items: [{ productId: fixtures.products.notebook.id, quantity: 2 }],
      },
      'an extra product': {
        ...original,
        items: [...original.items, { productId: fixtures.products.pencil.id, quantity: 1 }],
      },
      'another delivery area': { ...original, deliveryAreaId: fixtures.areas.withMinimum.id },
      'another address': { ...original, address: { ...original.address, addressLine1: 'Elsewhere' } },
      'another name': { ...original, customer: { ...original.customer, fullName: 'Someone Else' } },
      'another mobile': { ...original, customer: { ...original.customer, mobile: '9123456780' } },
    };

    for (const [label, body] of Object.entries(variants)) {
      const response = await placeOrder(body);

      expect(response.status, label).toBe(409);
      expect(response.body.error.code, label).toBe('IDEMPOTENCY_CONFLICT');
      // The conflicting caller learns nothing about the original order.
      expect(JSON.stringify(response.body), label).not.toContain(originalToken);
      expect(JSON.stringify(response.body), label).not.toContain(first.body.data.orderNumber);
    }

    // Still exactly the first order and its reservation.
    expect(await prisma.order.count()).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
    expect((await getStock(fixtures.products.pencil.id)).reservedQuantity).toBe(0);
  });

  it('creates separate orders for different request ids with the same contents', async () => {
    const first = await placeOrder(simpleOrder({ clientRequestId: 'separate-request-0001' }));
    const second = await placeOrder(simpleOrder({ clientRequestId: 'separate-request-0002' }));

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.data.orderNumber).not.toBe(first.body.data.orderNumber);
    expect(await prisma.order.count()).toBe(2);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(2);
  });

  it('cannot confirm a replay of an order that has no stored fingerprint', async () => {
    const body = simpleOrder({ clientRequestId: 'legacy-request-0001' });
    const first = await placeOrder(body);
    await prisma.order.update({
      where: { orderNumber: first.body.data.orderNumber },
      data: { requestFingerprint: null },
    });

    const replay = await placeOrder(body);

    expect(replay.status).toBe(409);
    expect(replay.body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect(JSON.stringify(replay.body)).not.toContain(first.body.data.trackingToken);
  });

  it('lets only one of two conflicting requests with the same id create an order', async () => {
    const clientRequestId = 'racing-request-0001';
    const make = (quantity: number) =>
      orderPayload({
        deliveryAreaId: fixtures.areas.standard.id,
        items: [{ productId: fixtures.products.notebook.id, quantity }],
        clientRequestId,
      });

    const responses = await Promise.all([placeOrder(make(1)), placeOrder(make(2))]);

    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect(responses.find((response) => response.status === 409)?.body.error.code).toBe(
      'IDEMPOTENCY_CONFLICT'
    );
    expect(await prisma.order.count()).toBe(1);
    const created = responses.find((response) => response.status === 201)?.body.data;
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(
      created.items[0].quantity
    );
  });

  it('creates one order when the same request arrives several times at once', async () => {
    const body = orderPayload({
      deliveryAreaId: fixtures.areas.standard.id,
      // The last unit: a losing duplicate also hits "out of stock" and must still replay.
      items: [{ productId: fixtures.products.lastOne.id, quantity: 1 }],
    });

    const responses = await Promise.all(Array.from({ length: 5 }, () => placeOrder(body)));

    expect(responses.map((response) => response.status).sort()).toEqual([200, 200, 200, 200, 201]);
    expect(new Set(responses.map((response) => response.body.data.orderNumber)).size).toBe(1);
    expect(await prisma.order.count()).toBe(1);
    expect((await getStock(fixtures.products.lastOne.id)).reservedQuantity).toBe(1);
  });
});

describe('concurrent orders', () => {
  it('lets exactly one of several customers buy the last unit', async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, (_, index) =>
        placeOrder(
          orderPayload({
            deliveryAreaId: fixtures.areas.standard.id,
            items: [{ productId: fixtures.products.lastOne.id, quantity: 1 }],
            mobile: `987654321${index}`,
          })
        )
      )
    );

    const statuses = responses.map((response) => response.status).sort();
    expect(statuses).toEqual([201, 409, 409, 409, 409, 409]);
    expect(await prisma.order.count()).toBe(1);
    expect(await getStock(fixtures.products.lastOne.id)).toEqual({
      stockQuantity: 1,
      reservedQuantity: 1,
    });
  });

  it('never reserves more than the stock when many orders compete', async () => {
    // 10 notebooks, 8 simultaneous orders of 3 each: only 3 orders (9 units) can fit.
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        placeOrder(
          orderPayload({
            deliveryAreaId: fixtures.areas.standard.id,
            items: [{ productId: fixtures.products.notebook.id, quantity: 3 }],
            mobile: `987654322${index}`,
          })
        )
      )
    );

    expect(responses.filter((response) => response.status === 201)).toHaveLength(3);
    expect(responses.filter((response) => response.status === 409)).toHaveLength(5);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(9);
  });

  it('issues unique, consecutive order numbers under load', async () => {
    const responses = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        placeOrder(
          orderPayload({
            deliveryAreaId: fixtures.areas.standard.id,
            items: [{ productId: fixtures.products.pencil.id, quantity: 1 }],
            mobile: `987654323${index}`,
          })
        )
      )
    );

    expect(responses.every((response) => response.status === 201)).toBe(true);
    const sequences = responses
      .map((response) => Number(response.body.data.orderNumber.split('-')[2]))
      .sort((a, b) => a - b);
    expect(sequences).toEqual([1001, 1002, 1003, 1004, 1005, 1006, 1007, 1008]);
  });
});

describe('GET /api/v1/orders/:orderNumber', () => {
  it('returns the order to the holder of its tracking token', async () => {
    const placed = (await placeOrder(simpleOrder())).body.data;

    const response = await request(app)
      .get(`/api/v1/orders/${placed.orderNumber}`)
      .set(TOKEN_HEADER, placed.trackingToken);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      orderNumber: placed.orderNumber,
      grandTotalPaise: 37900,
      paymentStatus: 'PENDING',
      deliveryAddress: { addressLine1: '12 Shastri Street', landmark: 'Near the temple' },
    });
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.statusHistory).toHaveLength(1);
    // The token is handed out once, at creation; lookups never echo it back.
    expect(response.body.data).not.toHaveProperty('trackingToken');
  });

  it('refuses a wrong or missing token, and another order’s token', async () => {
    const mine = (await placeOrder(simpleOrder())).body.data;
    const theirs = (await placeOrder(simpleOrder({ mobile: '9123456780' }))).body.data;
    const url = `/api/v1/orders/${mine.orderNumber}`;

    const wrong = await request(app).get(url).set(TOKEN_HEADER, 'not-the-token');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVALID_TRACKING_TOKEN');

    const crossed = await request(app).get(url).set(TOKEN_HEADER, theirs.trackingToken);
    expect(crossed.status).toBe(403);

    const missing = await request(app).get(url);
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('INVALID_TRACKING_TOKEN');

    // A token in the query string is not accepted either.
    const inQuery = await request(app).get(`${url}?token=${mine.trackingToken}`);
    expect(inQuery.status).toBe(401);

    for (const response of [wrong, crossed, missing, inQuery]) {
      expect(JSON.stringify(response.body)).not.toContain('Ravi Kumar');
    }
  });

  it('answers 404 for an order number that does not exist', async () => {
    const response = await request(app)
      .get('/api/v1/orders/BN-20200101-9999')
      .set(TOKEN_HEADER, 'anything');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('ORDER_NOT_FOUND');
  });

  it('keeps the purchase-time name and price after the product changes', async () => {
    const placed = (await placeOrder(simpleOrder())).body.data;

    await prisma.product.update({
      where: { id: fixtures.products.notebook.id },
      data: { name: 'Renamed Notebook', sellingPricePaise: 99900 },
    });

    const response = await request(app)
      .get(`/api/v1/orders/${placed.orderNumber}`)
      .set(TOKEN_HEADER, placed.trackingToken);

    expect(response.body.data.items[0]).toMatchObject({
      productName: 'Classmate Notebook',
      unitPricePaise: 34900,
      lineTotalPaise: 34900,
    });
    expect(response.body.data.grandTotalPaise).toBe(37900);
  });
});

describe('POST /api/v1/orders/:orderNumber/cancel', () => {
  const cancel = (orderNumber: string, token: string) =>
    request(app).post(`/api/v1/orders/${orderNumber}/cancel`).set(TOKEN_HEADER, token);

  it('cancels a PLACED order, releases the stock and keeps the totals', async () => {
    const placed = (
      await placeOrder(
        orderPayload({
          deliveryAreaId: fixtures.areas.standard.id,
          items: [{ productId: fixtures.products.notebook.id, quantity: 4 }],
        })
      )
    ).body.data;
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(4);

    const response = await cancel(placed.orderNumber, placed.trackingToken);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      orderStatus: 'CANCELLED',
      // Nothing was collected for a COD order, so there is nothing to refund.
      paymentStatus: 'PENDING',
      subtotalPaise: placed.subtotalPaise,
      grandTotalPaise: placed.grandTotalPaise,
    });
    expect(response.body.data.cancelledAt).not.toBeNull();
    expect(response.body.data.statusHistory.map((entry: { status: string }) => entry.status)).toEqual(
      ['PLACED', 'CANCELLED']
    );

    expect(await getStock(fixtures.products.notebook.id)).toEqual({
      stockQuantity: 10,
      reservedQuantity: 0,
    });
    const types = (await prisma.inventoryTransaction.findMany({ orderBy: { createdAt: 'asc' } })).map(
      (transaction) => `${transaction.type}:${transaction.quantity}`
    );
    expect(types).toEqual(['RESERVE:4', 'RELEASE:4']);
    expect(await prisma.order.count()).toBe(1);
  });

  it('rejects a second cancellation without releasing stock twice', async () => {
    const other = (await placeOrder(simpleOrder({ mobile: '9123456780' }))).body.data;
    const placed = (await placeOrder(simpleOrder())).body.data;
    await cancel(placed.orderNumber, placed.trackingToken);

    const again = await cancel(placed.orderNumber, placed.trackingToken);

    expect(again.status).toBe(409);
    expect(again.body.error).toMatchObject({
      code: 'ORDER_CANNOT_BE_CANCELLED',
      details: { orderStatus: 'CANCELLED' },
    });
    // The other customer's reservation is still held.
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
    expect(other.orderNumber).not.toBe(placed.orderNumber);
  });

  it('releases stock once when the same cancellation is sent twice at the same time', async () => {
    const placed = (await placeOrder(simpleOrder())).body.data;

    const responses = await Promise.all([
      cancel(placed.orderNumber, placed.trackingToken),
      cancel(placed.orderNumber, placed.trackingToken),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
    expect(await prisma.inventoryTransaction.count({ where: { type: 'RELEASE' } })).toBe(1);
  });

  it('rejects cancellation once the shop has moved the order past PLACED', async () => {
    const placed = (await placeOrder(simpleOrder())).body.data;
    await prisma.order.update({
      where: { orderNumber: placed.orderNumber },
      data: { orderStatus: 'CONFIRMED' },
    });

    const response = await cancel(placed.orderNumber, placed.trackingToken);

    expect(response.status).toBe(409);
    expect(response.body.error).toMatchObject({
      code: 'ORDER_CANNOT_BE_CANCELLED',
      details: { orderStatus: 'CONFIRMED' },
    });
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });

  it('refuses to cancel without the right tracking token', async () => {
    const placed = (await placeOrder(simpleOrder())).body.data;

    const wrong = await cancel(placed.orderNumber, 'not-the-token');
    expect(wrong.status).toBe(403);
    expect(wrong.body.error.code).toBe('INVALID_TRACKING_TOKEN');

    const missing = await request(app).post(`/api/v1/orders/${placed.orderNumber}/cancel`);
    expect(missing.status).toBe(401);

    const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: placed.orderNumber } });
    expect(order.orderStatus).toBe('PLACED');
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
  });
});

describe('database guarantees', () => {
  it('refuses to let reserved stock exceed stock even for a direct write', async () => {
    await expect(
      prisma.product.update({
        where: { id: fixtures.products.lastOne.id },
        data: { reservedQuantity: 2 },
      })
    ).rejects.toThrow();
  });
});
