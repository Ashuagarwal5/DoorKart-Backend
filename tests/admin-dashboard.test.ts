import { beforeEach, describe, expect, it } from 'vitest';

import { shopDateRange, shopDayRange, startOfShopDay } from '../src/lib/time.js';
import { getDashboard } from '../src/modules/admin/dashboard/admin-dashboard.module.js';
import {
  type AdminAgent,
  advance,
  createTestAdmin,
  type Fixtures,
  placeTestOrder,
  prisma,
  resetDatabase,
  seedFixtures,
  signIn,
} from './helpers.js';

let fixtures: Fixtures;
let admin: AdminAgent;

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  await createTestAdmin();
  admin = await signIn();
});

const HOURS = 60 * 60 * 1000;

describe('GET /api/v1/admin/dashboard', () => {
  it('calculates every metric, keeping revenue and cash separate', async () => {
    const pencil = (mobile: string) =>
      placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile });
    const collect = (id: string) => admin.patch(`/api/v1/admin/orders/${id}/payment`).send({ paymentStatus: 'COLLECTED' });
    const deliver = ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED'];
    const longAgo = new Date(Date.now() - 30 * HOURS);

    // A: delivered today and paid today                  ₹149.50 + ₹30 = 17950
    const a = await pencil('9100000001');
    await advance(admin, a.id, deliver);
    await collect(a.id);

    // B: delivered today, cash NOT yet collected         ₹349 + ₹30 = 37900
    const b = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9100000002' });
    await advance(admin, b.id, deliver);

    // C: delivered on an earlier day, but its cash was collected today
    const c = await pencil('9100000003');
    await advance(admin, c.id, deliver);
    await collect(c.id);
    await prisma.order.update({ where: { id: c.id }, data: { createdAt: longAgo, deliveredAt: longAgo } });

    // H: delivered on an earlier day and still unpaid
    const h = await pencil('9100000004');
    await advance(admin, h.id, deliver);
    await prisma.order.update({ where: { id: h.id }, data: { createdAt: longAgo, deliveredAt: longAgo } });

    // D placed, E confirmed, F out for delivery, G cancelled: all placed today
    await pencil('9100000005');
    const e = await pencil('9100000006');
    await advance(admin, e.id, ['CONFIRMED']);
    const f = await pencil('9100000007');
    await advance(admin, f.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY']);
    const g = await pencil('9100000008');
    await advance(admin, g.id, ['CANCELLED']);

    const response = await admin.get('/api/v1/admin/dashboard');

    expect(response.status).toBe(200);
    const data = response.body.data;
    expect(data).toMatchObject({
      todayOrders: 6, // A, B, D, E, F, G (C and H were placed on an earlier day)
      pendingOrders: 2, // D (PLACED) and E (CONFIRMED)
      outForDeliveryOrders: 1, // F
      deliveredToday: 2, // A and B (C and H were delivered earlier)
      todayRevenuePaise: 17950 + 37900, // delivered today, paid or not
      cashCollectedTodayPaise: 17950 + 17950, // A and C: collected today, whenever delivered
      cashPendingPaise: 37900 + 17950, // B and H: delivered, still unpaid
      deliveredUnpaidOrders: 2,
    });
    expect(data.ordersByStatus).toEqual({
      PLACED: 1,
      CONFIRMED: 1,
      PACKED: 0,
      OUT_FOR_DELIVERY: 1,
      DELIVERED: 4,
      CANCELLED: 1,
      DELIVERY_FAILED: 0,
    });
    // Revenue and cash are not the same figure, and neither is derived from the other.
    expect(data.todayRevenuePaise).not.toBe(data.cashCollectedTodayPaise);
  });

  it('counts low stock by available units and lists the lowest first, active products only', async () => {
    const response = await admin.get('/api/v1/admin/dashboard');
    const data = response.body.data;

    // Teddy Bear 0, Remote Car 1, Hidden Thing 5. The retired (inactive) toy is left out.
    expect(data.lowStockCount).toBe(3);
    expect(data.lowStockProducts.map((product: { name: string }) => product.name)).toEqual([
      'Teddy Bear',
      'Remote Car',
      'Hidden Thing',
    ]);
    expect(data.lowStockProducts[0]).toMatchObject({ availableQuantity: 0, lowStockThreshold: 5 });

    // Reserving stock moves a product into the list even though it is still on the shelf.
    await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 6 }]);
    const after = (await admin.get('/api/v1/admin/dashboard')).body.data;
    expect(after.lowStockCount).toBe(4);
    expect(after.lowStockProducts.map((product: { name: string }) => product.name)).toContain('Classmate Notebook');
  });

  it('lists the newest orders, without any secrets', async () => {
    const first = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);
    const second = await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });

    const response = await admin.get('/api/v1/admin/dashboard');

    expect(response.body.data.recentOrders.map((order: { orderNumber: string }) => order.orderNumber)).toEqual([
      second.orderNumber,
      first.orderNumber,
    ]);
    expect(JSON.stringify(response.body)).not.toMatch(/trackingToken|requestFingerprint/);
    expect(JSON.stringify(response.body)).not.toContain(first.trackingToken);
  });

  it('reports zeros, not errors, for an empty shop', async () => {
    await resetDatabase();
    await createTestAdmin();
    const fresh = await signIn();

    const response = await fresh.get('/api/v1/admin/dashboard');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      todayOrders: 0,
      pendingOrders: 0,
      deliveredToday: 0,
      todayRevenuePaise: 0,
      cashCollectedTodayPaise: 0,
      cashPendingPaise: 0,
      lowStockCount: 0,
      recentOrders: [],
      lowStockProducts: [],
    });
  });
});

describe('the shop day is a calendar day in IST', () => {
  it('draws the day boundary at midnight IST (18:30 UTC), not at midnight UTC', () => {
    // 23:59:59 IST on 3 Oct is still 3 Oct; one second later it is 4 Oct.
    expect(startOfShopDay(new Date('2026-10-03T18:29:59Z')).toISOString()).toBe('2026-10-02T18:30:00.000Z');
    expect(startOfShopDay(new Date('2026-10-03T18:30:00Z')).toISOString()).toBe('2026-10-03T18:30:00.000Z');
    // Midnight UTC is 05:30 IST, mid-morning of the same shop day.
    expect(startOfShopDay(new Date('2026-10-04T00:00:00Z')).toISOString()).toBe('2026-10-03T18:30:00.000Z');

    const { start, end } = shopDayRange(new Date('2026-10-04T10:00:00Z'));
    expect(end.getTime() - start.getTime()).toBe(24 * HOURS);
  });

  it('turns inclusive day filters into a half-open UTC range', () => {
    const range = shopDateRange('2026-10-05', '2026-10-06');
    expect(range.start?.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(range.end?.toISOString()).toBe('2026-10-06T18:30:00.000Z');
    expect(shopDateRange(undefined, undefined)).toEqual({ start: undefined, end: undefined });
  });

  it('puts an order delivered at 01:30 IST in the new shop day, and 22:30 IST in the old one', async () => {
    const order = async (mobile: string, deliveredAt: string) => {
      const placed = await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile });
      await prisma.order.update({
        where: { id: placed.id },
        data: { orderStatus: 'DELIVERED', deliveredAt: new Date(deliveredAt), createdAt: new Date(deliveredAt) },
      });
    };
    await order('9100000011', '2026-10-04T20:00:00Z'); // 01:30 IST on 5 Oct
    await order('9100000012', '2026-10-04T17:00:00Z'); // 22:30 IST on 4 Oct

    const onFifth = await getDashboard(new Date('2026-10-05T02:00:00Z')); // 07:30 IST on 5 Oct
    const onFourth = await getDashboard(new Date('2026-10-04T17:30:00Z')); // 23:00 IST on 4 Oct

    expect(onFifth.deliveredToday).toBe(1);
    expect(onFifth.todayOrders).toBe(1);
    expect(onFifth.todayRevenuePaise).toBe(17950);
    expect(onFourth.deliveredToday).toBe(1);
    expect(onFourth.todayRevenuePaise).toBe(17950);
  });
});
