import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

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

const PRODUCTS = '/api/v1/admin/products';
const CATEGORIES = '/api/v1/admin/categories';
const AREAS = '/api/v1/admin/delivery-areas';

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  adminId = (await createTestAdmin()).id;
  admin = await signIn();
});

const newProduct = (overrides: Record<string, unknown> = {}) => ({
  name: 'Gel Pen Set',
  description: 'Ten gel pens in assorted colours.',
  categoryId: fixtures.categories.stationery.id,
  sku: 'N-100',
  mrpPaise: 25000,
  sellingPricePaise: 19900,
  stockQuantity: 12,
  ...overrides,
});

describe('admin products', () => {
  it('creates a product with images and opening stock, and derives the slug', async () => {
    const response = await admin.post(PRODUCTS).send(
      newProduct({
        isFeatured: true,
        images: [
          { url: 'https://example.test/a.jpg', altText: 'Front' },
          { url: 'https://example.test/b.jpg' },
        ],
      })
    );

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'Gel Pen Set',
      slug: 'gel-pen-set',
      sku: 'N-100',
      mrpPaise: 25000,
      sellingPricePaise: 19900,
      stockQuantity: 12,
      reservedQuantity: 0,
      availableQuantity: 12,
      lowStockThreshold: 5,
      isActive: true,
      isFeatured: true,
      isNew: false,
      category: { slug: 'stationery' },
    });
    expect(response.body.data.images.map((image: { url: string; displayOrder: number }) => [image.url, image.displayOrder])).toEqual([
      ['https://example.test/a.jpg', 0],
      ['https://example.test/b.jpg', 1],
    ]);

    // The opening stock is on the audit trail, attributed to the admin.
    const movements = await prisma.inventoryTransaction.findMany({ where: { productId: response.body.data.id } });
    expect(movements).toEqual([
      expect.objectContaining({ type: 'ADJUSTMENT', quantity: 12, note: 'Opening stock', adminUserId: adminId }),
    ]);
  });

  it('appears in the shop straight away, with the stock the customer can actually buy', async () => {
    await admin.post(PRODUCTS).send(newProduct());

    const publicView = await request(app).get('/api/v1/products/gel-pen-set');

    expect(publicView.status).toBe(200);
    expect(publicView.body.data).toMatchObject({ sellingPricePaise: 19900, availableQuantity: 12, inStock: true });
  });

  it('rejects a duplicate SKU or slug, on create and on update', async () => {
    const duplicateSku = await admin.post(PRODUCTS).send(newProduct({ sku: 'T-001', name: 'Another thing' }));
    expect(duplicateSku.status).toBe(409);
    expect(duplicateSku.body.error.code).toBe('DUPLICATE_SKU');

    const duplicateSlug = await admin.post(PRODUCTS).send(newProduct({ slug: 'classmate-notebook' }));
    expect(duplicateSlug.status).toBe(409);
    expect(duplicateSlug.body.error.code).toBe('DUPLICATE_SLUG');

    const created = await admin.post(PRODUCTS).send(newProduct());
    const id = created.body.data.id;
    expect((await admin.patch(`${PRODUCTS}/${id}`).send({ sku: 'T-001' })).body.error.code).toBe('DUPLICATE_SKU');
    expect((await admin.patch(`${PRODUCTS}/${id}`).send({ slug: 'classmate-notebook' })).body.error.code).toBe('DUPLICATE_SLUG');

    // Saving a product with its own SKU and slug is not a duplicate of itself.
    expect((await admin.patch(`${PRODUCTS}/${id}`).send({ sku: 'N-100', slug: 'gel-pen-set' })).status).toBe(200);
    expect(await prisma.product.count({ where: { name: 'Gel Pen Set' } })).toBe(1);
  });

  it('validates money as whole paise, and the selling price against the MRP', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ mrpPaise: 199.5 }, 'a fractional paisa'],
      [{ sellingPricePaise: -1 }, 'a negative price'],
      [{ mrpPaise: '25000' }, 'a string price'],
      [{ mrpPaise: 10000, sellingPricePaise: 19900 }, 'a selling price above the MRP'],
      [{ mrpPaise: 100_000_001 }, 'an absurd price'],
      [{ stockQuantity: -3 }, 'negative stock'],
      [{ stockQuantity: 2.5 }, 'fractional stock'],
      [{ name: '   ' }, 'a blank name'],
      [{ sku: 'has spaces' }, 'a bad SKU'],
      [{ images: [{ url: 'javascript:alert(1)' }] }, 'a non-http image URL'],
      [{ unknownField: true }, 'an unknown field'],
    ];
    for (const [overrides, label] of cases) {
      const response = await admin.post(PRODUCTS).send(newProduct(overrides));
      expect(response.status, label).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
    expect(await prisma.product.count()).toBe(6);
  });

  it('rejects an unknown category', async () => {
    const response = await admin.post(PRODUCTS).send(newProduct({ categoryId: 'no-such-category' }));
    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('CATEGORY_NOT_FOUND');
  });

  it('updates details, and validates a price change against the stored price', async () => {
    const id = fixtures.products.notebook.id; // ₹349 selling, MRP ₹399

    const response = await admin.patch(`${PRODUCTS}/${id}`).send({
      name: 'Classmate Notebook (Pack of 6)',
      sellingPricePaise: 30000,
      isNew: true,
      lowStockThreshold: 3,
      images: [{ url: 'https://example.test/new.jpg' }],
    });

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({
      name: 'Classmate Notebook (Pack of 6)',
      sellingPricePaise: 30000,
      mrpPaise: 39900,
      isNew: true,
      lowStockThreshold: 3,
      slug: 'classmate-notebook',
    });
    // `images` replaces the list, and the image that was there is gone.
    expect(response.body.data.images.map((image: { url: string }) => image.url)).toEqual(['https://example.test/new.jpg']);

    // Raising the price above the unchanged MRP is refused.
    const tooHigh = await admin.patch(`${PRODUCTS}/${id}`).send({ sellingPricePaise: 50000 });
    expect(tooHigh.status).toBe(400);
    // Lowering the MRP below the unchanged selling price is refused too.
    const mrpTooLow = await admin.patch(`${PRODUCTS}/${id}`).send({ mrpPaise: 20000 });
    expect(mrpTooLow.status).toBe(400);
    expect((await prisma.product.findUniqueOrThrow({ where: { id } })).sellingPricePaise).toBe(30000);
  });

  it('refuses to edit stock directly, and an empty update', async () => {
    const id = fixtures.products.notebook.id;

    for (const body of [{ stockQuantity: 500 }, { reservedQuantity: 0 }, {}]) {
      const response = await admin.patch(`${PRODUCTS}/${id}`).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getStock(id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
  });

  it('deactivates a product instead of deleting it, and the shop stops selling it', async () => {
    const id = fixtures.products.notebook.id;
    const order = await placeTestOrder(fixtures, [{ productId: id, quantity: 2 }]);

    const response = await admin.patch(`${PRODUCTS}/${id}`).send({ isActive: false });

    expect(response.status).toBe(200);
    expect(response.body.data.isActive).toBe(false);
    // Gone from the shop...
    expect((await request(app).get('/api/v1/products/classmate-notebook')).status).toBe(404);
    const buy = await request(app).post('/api/v1/orders').send({
      clientRequestId: 'inactive-product-0001',
      customer: { fullName: 'Ravi Kumar', mobile: '9876543210' },
      address: { addressLine1: '1 Road', city: 'Testpur', pincode: '226001' },
      deliveryAreaId: fixtures.areas.standard.id,
      items: [{ productId: id, quantity: 1 }],
      paymentMethod: 'COD',
    });
    expect(buy.status).toBe(409);
    expect(buy.body.error.code).toBe('PRODUCT_UNAVAILABLE');
    // ...but the record, and the order that already bought it, are untouched.
    expect(await prisma.product.count({ where: { id } })).toBe(1);
    expect(await prisma.orderItem.count({ where: { orderId: order.id } })).toBe(1);

    // An order placed before the change can still be completed.
    await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
    expect(await getStock(id)).toEqual({ stockQuantity: 8, reservedQuantity: 0 });
  });

  it('has no way to delete a product', async () => {
    const response = await admin.delete(`${PRODUCTS}/${fixtures.products.notebook.id}`);
    expect(response.status).toBe(404);
    expect(await prisma.product.count()).toBe(6);
  });

  it('lists with search, filters and pagination, and shows stock figures', async () => {
    const response = await admin.get(`${PRODUCTS}?search=notebook`);
    expect(response.body.data.items).toHaveLength(1);
    expect(response.body.data.items[0]).toMatchObject({
      sku: 'T-001',
      stockQuantity: 10,
      reservedQuantity: 0,
      availableQuantity: 10,
      lowStockThreshold: 5,
      isLowStock: false,
    });

    // Search by SKU too, and inactive products are visible to admins.
    expect((await admin.get(`${PRODUCTS}?search=t-005`)).body.data.items[0].name).toBe('Retired Toy');
    expect((await admin.get(`${PRODUCTS}?isActive=false`)).body.data.pagination.total).toBe(1);
    expect((await admin.get(`${PRODUCTS}?categoryId=${fixtures.categories.toys.id}`)).body.data.pagination.total).toBe(3);
    expect((await admin.get(`${PRODUCTS}?page=2&limit=4`)).body.data.items).toHaveLength(2);
    expect((await admin.get(`${PRODUCTS}?limit=101`)).status).toBe(400);
  });

  it('flags and filters low stock by AVAILABLE units, not by stock on hand', async () => {
    // 10 on hand, threshold 5. Reserving 6 leaves 4 available: low.
    await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 6 }]);

    const low = await admin.get(`${PRODUCTS}?lowStock=true`);
    const names = low.body.data.items.map((item: { name: string }) => item.name).sort();

    expect(names).toContain('Classmate Notebook');
    expect(names).toContain('Teddy Bear'); // 0 available
    expect(names).not.toContain('Pencil Pack'); // 100 available
    expect(low.body.data.items.find((item: { name: string }) => item.name === 'Classmate Notebook')).toMatchObject({
      stockQuantity: 10,
      reservedQuantity: 6,
      availableQuantity: 4,
      isLowStock: true,
    });
    expect((await admin.get(`${PRODUCTS}?lowStock=false`)).body.data.items.map((item: { name: string }) => item.name)).toContain('Pencil Pack');
  });

  it('answers 404 for an unknown product', async () => {
    expect((await admin.get(`${PRODUCTS}/nope`)).status).toBe(404);
    expect((await admin.patch(`${PRODUCTS}/nope`).send({ name: 'x' })).status).toBe(404);
  });
});

describe('inventory adjustments', () => {
  const adjust = (productId: string, quantityDelta: number, note = 'New stock received') =>
    admin.post(`${PRODUCTS}/${productId}/inventory-adjustment`).send({ quantityDelta, note });

  it('adds stock and records who, why and how much', async () => {
    const id = fixtures.products.notebook.id;

    const response = await adjust(id, 15, 'Supplier delivery');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ stockQuantity: 25, reservedQuantity: 0, availableQuantity: 25 });

    const [movement] = await prisma.inventoryTransaction.findMany({ where: { productId: id, type: 'ADJUSTMENT' } });
    expect(movement).toMatchObject({ quantity: 15, note: 'Supplier delivery', adminUserId: adminId, orderId: null });
    expect(movement?.createdAt).toBeInstanceOf(Date);
  });

  it('removes stock, recorded as a negative adjustment', async () => {
    const id = fixtures.products.notebook.id;

    const response = await adjust(id, -4, 'Water damage');

    expect(response.body.data.stockQuantity).toBe(6);
    const [movement] = await prisma.inventoryTransaction.findMany({ where: { productId: id, type: 'ADJUSTMENT' } });
    expect(movement).toMatchObject({ quantity: -4, note: 'Water damage' });
  });

  it('cannot take stock below what open orders have reserved', async () => {
    const id = fixtures.products.notebook.id;
    await placeTestOrder(fixtures, [{ productId: id, quantity: 6 }]); // 10 on hand, 6 reserved, 4 free

    const tooMuch = await adjust(id, -5);

    expect(tooMuch.status).toBe(409);
    expect(tooMuch.body.error).toMatchObject({
      code: 'ADJUSTMENT_BELOW_RESERVED',
      details: { stockQuantity: 10, reservedQuantity: 6, requestedDelta: -5, lowestAllowedDelta: -4 },
    });
    expect(await getStock(id)).toEqual({ stockQuantity: 10, reservedQuantity: 6 });
    // The refused attempt leaves no trace in the stock history.
    expect(await prisma.inventoryTransaction.count({ where: { productId: id, type: 'ADJUSTMENT', quantity: -5 } })).toBe(0);

    // Exactly down to the reservation is fine.
    expect((await adjust(id, -4)).status).toBe(200);
    expect(await getStock(id)).toEqual({ stockQuantity: 6, reservedQuantity: 6 });
  });

  it('cannot take stock below zero', async () => {
    const response = await adjust(fixtures.products.soldOut.id, -1);
    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe('ADJUSTMENT_BELOW_RESERVED');
  });

  it('holds the line when adjustments and orders arrive at the same moment', async () => {
    const id = fixtures.products.notebook.id; // 10 on hand
    // 8 orders of 1 unit race a removal of 6. Whatever the order they land in, the stock
    // must never end up below the units reserved, and every success must be accounted for.
    const results = await Promise.all([
      adjust(id, -6),
      ...Array.from({ length: 8 }, (_, index) =>
        request(app).post('/api/v1/orders').send({
          clientRequestId: `race-order-${index}-0001`,
          customer: { fullName: 'Racer', mobile: `98765432${10 + index}` },
          address: { addressLine1: '1 Road', city: 'Testpur', pincode: '226001' },
          deliveryAreaId: fixtures.areas.standard.id,
          items: [{ productId: id, quantity: 1 }],
          paymentMethod: 'COD',
        })
      ),
    ]);

    const stock = await getStock(id);
    expect(stock.reservedQuantity).toBeLessThanOrEqual(stock.stockQuantity);
    expect(stock.reservedQuantity).toBe(results.slice(1).filter((result) => result.status === 201).length);
    expect(stock.stockQuantity).toBe(results[0]?.status === 200 ? 4 : 10);
  });

  it('validates the request: a reason is required and zero is not a change', async () => {
    const id = fixtures.products.notebook.id;
    const bad: Record<string, unknown>[] = [
      { quantityDelta: 0, note: 'nothing' },
      { quantityDelta: 1.5, note: 'half' },
      { quantityDelta: 5 },
      { quantityDelta: 5, note: '   ' },
      { quantityDelta: '5', note: 'text' },
      { quantityDelta: 5, note: 'x', stockQuantity: 100 },
    ];
    for (const body of bad) {
      const response = await admin.post(`${PRODUCTS}/${id}/inventory-adjustment`).send(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
    expect(await getStock(id)).toEqual({ stockQuantity: 10, reservedQuantity: 0 });
    expect((await adjust('nope', 5)).status).toBe(404);
  });
});

describe('admin categories', () => {
  it('lists every category, inactive too, with product counts', async () => {
    const response = await admin.get(CATEGORIES);

    expect(response.status).toBe(200);
    const bySlug = Object.fromEntries(response.body.data.map((category: { slug: string }) => [category.slug, category]));
    expect(Object.keys(bySlug).sort()).toEqual(['hidden', 'stationery', 'toys']);
    expect(bySlug['toys']).toMatchObject({ productCount: 3, isActive: true });
    expect(bySlug['hidden']).toMatchObject({ isActive: false, productCount: 1 });
  });

  it('creates a category, deriving the slug, and the shop lists it', async () => {
    const response = await admin.post(CATEGORIES).send({
      name: 'Sports & Fitness',
      description: 'Balls and bats',
      imageUrl: 'https://example.test/sports.jpg',
      displayOrder: 5,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'Sports & Fitness',
      slug: 'sports-fitness',
      displayOrder: 5,
      isActive: true,
      productCount: 0,
    });
    const publicSlugs = (await request(app).get('/api/v1/categories')).body.data.map((category: { slug: string }) => category.slug);
    expect(publicSlugs).toContain('sports-fitness');
  });

  it('rejects a duplicate slug and bad input', async () => {
    const duplicate = await admin.post(CATEGORIES).send({ name: 'Toys Again', slug: 'toys' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_SLUG');

    const clash = await admin.patch(`${CATEGORIES}/${fixtures.categories.toys.id}`).send({ slug: 'stationery' });
    expect(clash.status).toBe(409);

    for (const body of [{}, { name: '' }, { name: 'X', slug: 'Bad Slug' }, { name: 'X', displayOrder: -1 }, { name: 'X', imageUrl: 'not a url' }]) {
      expect((await admin.post(CATEGORIES).send(body)).status, JSON.stringify(body)).toBe(400);
    }
  });

  it('updates a category and deactivates it instead of deleting, hiding it and its products from the shop', async () => {
    const id = fixtures.categories.toys.id;

    const response = await admin.patch(`${CATEGORIES}/${id}`).send({ name: 'Toys & Games', displayOrder: 9, isActive: false });

    expect(response.body.data).toMatchObject({ name: 'Toys & Games', displayOrder: 9, isActive: false, productCount: 3 });
    const publicSlugs = (await request(app).get('/api/v1/categories')).body.data.map((category: { slug: string }) => category.slug);
    expect(publicSlugs).not.toContain('toys');
    expect((await request(app).get('/api/v1/products?category=toys')).body.data.items).toEqual([]);
    // Nothing was deleted.
    expect(await prisma.product.count({ where: { categoryId: id } })).toBe(3);

    expect((await admin.delete(`${CATEGORIES}/${id}`)).status).toBe(404);
    expect((await admin.patch(`${CATEGORIES}/nope`).send({ name: 'x' })).status).toBe(404);
  });
});

describe('admin delivery areas', () => {
  it('lists every area, inactive ones included', async () => {
    const response = await admin.get(AREAS);

    expect(response.status).toBe(200);
    expect(response.body.data.map((area: { name: string }) => area.name).sort()).toEqual([
      'Industrial Area',
      'Model Town',
      'Station Road',
    ]);
    expect(response.body.data.find((area: { name: string }) => area.name === 'Industrial Area').isActive).toBe(false);
  });

  it('creates an area, and customers see it with its charge', async () => {
    const response = await admin.post(AREAS).send({
      name: 'Gandhi Nagar',
      pincode: '226010',
      deliveryChargePaise: 2000,
      minimumOrderPaise: 10000,
      freeDeliveryThresholdPaise: 40000,
    });

    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({
      name: 'Gandhi Nagar',
      pincode: '226010',
      deliveryChargePaise: 2000,
      minimumOrderPaise: 10000,
      freeDeliveryThresholdPaise: 40000,
      isActive: true,
    });
    const publicAreas = (await request(app).get('/api/v1/delivery-areas')).body.data;
    expect(publicAreas.find((area: { name: string }) => area.name === 'Gandhi Nagar').deliveryChargePaise).toBe(2000);
  });

  it('treats the optional amounts as optional, and null as "none"', async () => {
    const response = await admin.post(AREAS).send({ name: 'Plain Area', deliveryChargePaise: 3000 });
    expect(response.body.data).toMatchObject({ pincode: null, minimumOrderPaise: null, freeDeliveryThresholdPaise: null });

    const cleared = await admin
      .patch(`${AREAS}/${fixtures.areas.withMinimum.id}`)
      .send({ minimumOrderPaise: null });
    expect(cleared.body.data.minimumOrderPaise).toBeNull();
  });

  it('updates charges, and new orders use them while old orders keep theirs', async () => {
    const id = fixtures.areas.standard.id; // ₹30 delivery
    const before = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }]);

    const response = await admin.patch(`${AREAS}/${id}`).send({ deliveryChargePaise: 5000, freeDeliveryThresholdPaise: null });
    expect(response.body.data).toMatchObject({ deliveryChargePaise: 5000, freeDeliveryThresholdPaise: null });

    const after = await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });
    expect(after.grandTotalPaise).toBe(14950 + 5000);
    expect(before.grandTotalPaise).toBe(34900 + 3000);
    expect((await admin.get(`/api/v1/admin/orders/${before.id}`)).body.data.deliveryChargePaise).toBe(3000);
  });

  it('deactivates an area instead of deleting it, and the shop stops accepting orders for it', async () => {
    const id = fixtures.areas.standard.id;

    const response = await admin.patch(`${AREAS}/${id}`).send({ isActive: false });
    expect(response.body.data.isActive).toBe(false);

    const publicAreas = (await request(app).get('/api/v1/delivery-areas')).body.data.map((area: { id: string }) => area.id);
    expect(publicAreas).not.toContain(id);
    const buy = await request(app).post('/api/v1/orders').send({
      clientRequestId: 'inactive-area-0001',
      customer: { fullName: 'Ravi Kumar', mobile: '9876543210' },
      address: { addressLine1: '1 Road', city: 'Testpur', pincode: '226001' },
      deliveryAreaId: id,
      items: [{ productId: fixtures.products.notebook.id, quantity: 1 }],
      paymentMethod: 'COD',
    });
    expect(buy.status).toBe(409);
    expect(buy.body.error.code).toBe('DELIVERY_AREA_UNAVAILABLE');
    expect(await prisma.deliveryArea.count({ where: { id } })).toBe(1);
    expect((await admin.delete(`${AREAS}/${id}`)).status).toBe(404);
  });

  it('validates money as whole paise and refuses duplicates', async () => {
    const bad: Record<string, unknown>[] = [
      { name: 'X' },
      { name: 'X', deliveryChargePaise: 20.5 },
      { name: 'X', deliveryChargePaise: -1 },
      { name: 'X', deliveryChargePaise: 2000, minimumOrderPaise: -5 },
      { name: 'X', deliveryChargePaise: 2000, freeDeliveryThresholdPaise: '40000' },
      { name: 'X', deliveryChargePaise: 2000, pincode: '12' },
      { name: '', deliveryChargePaise: 2000 },
      { name: 'X', deliveryChargePaise: 2000, surprise: true },
    ];
    for (const body of bad) {
      expect((await admin.post(AREAS).send(body)).status, JSON.stringify(body)).toBe(400);
    }

    const duplicate = await admin.post(AREAS).send({ name: 'Station Road', deliveryChargePaise: 2000 });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.code).toBe('DUPLICATE_NAME');
    expect((await admin.patch(`${AREAS}/${fixtures.areas.withMinimum.id}`).send({ name: 'Station Road' })).status).toBe(409);
    expect((await admin.patch(`${AREAS}/nope`).send({ isActive: false })).status).toBe(404);
    expect((await admin.patch(`${AREAS}/${fixtures.areas.standard.id}`).send({})).status).toBe(400);
  });
});

describe('admin customers', () => {
  it('lists customers with order counts, value and last order date', async () => {
    const a = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9876500001' });
    await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 2 }], { mobile: '9876500001' });
    const cancelled = await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9876500001' });
    await admin.patch(`/api/v1/admin/orders/${cancelled.id}/status`).send({ status: 'CANCELLED' });
    await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });

    const response = await admin.get('/api/v1/admin/customers');

    expect(response.status).toBe(200);
    expect(response.body.data.pagination.total).toBe(2);
    const first = response.body.data.items.find((customer: { mobile: string }) => customer.mobile === '9876500001');
    expect(first).toMatchObject({
      name: 'Ravi Kumar',
      orderCount: 3, // all three orders count
      // Cancelled orders are not "value bought": (34900+3000) + (29900+3000) = 70800
      totalOrderValuePaise: 70800,
    });
    expect(first.lastOrderAt).not.toBeNull();
    expect(first.id).toBeTruthy();
    expect(a.orderNumber).toBeTruthy();
  });

  it('searches by name and mobile', async () => {
    await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9876500001' });
    await placeTestOrder(fixtures, [{ productId: fixtures.products.pencil.id, quantity: 1 }], { mobile: '9123456780' });
    const total = async (term: string) =>
      (await admin.get(`/api/v1/admin/customers?search=${encodeURIComponent(term)}`)).body.data.pagination.total;

    expect(await total('ravi')).toBe(2);
    expect(await total('9876500001')).toBe(1);
    expect(await total('+91 98765 00001')).toBe(1);
    expect(await total('987')).toBe(1);
    expect(await total('zzz')).toBe(0);
  });

  it('shows one customer with their recent orders', async () => {
    const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity: 1 }], { mobile: '9876500001' });
    const customer = await prisma.customer.findUniqueOrThrow({ where: { mobile: '9876500001' } });

    const response = await admin.get(`/api/v1/admin/customers/${customer.id}`);

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ id: customer.id, mobile: '9876500001', orderCount: 1, totalOrderValuePaise: 37900 });
    expect(response.body.data.recentOrders).toEqual([
      expect.objectContaining({ orderNumber: order.orderNumber, orderStatus: 'PLACED', grandTotalPaise: 37900 }),
    ]);
    expect(JSON.stringify(response.body)).not.toContain(order.trackingToken);
    expect((await admin.get('/api/v1/admin/customers/nope')).status).toBe(404);
  });

  it('a customer who has not ordered shows zeros rather than disappearing', async () => {
    await prisma.customer.create({ data: { fullName: 'Browser Only', mobile: '9000000001' } });

    const response = await admin.get('/api/v1/admin/customers?search=browser');

    expect(response.body.data.items[0]).toMatchObject({ orderCount: 0, totalOrderValuePaise: 0, lastOrderAt: null });
  });
});
