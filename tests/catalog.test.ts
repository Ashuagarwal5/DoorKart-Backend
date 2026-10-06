import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

import { app, type Fixtures, resetDatabase, seedFixtures } from './helpers.js';

let fixtures: Fixtures;

beforeAll(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
});

describe('GET /health', () => {
  it('reports the API and database as up without leaking configuration', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body.data).toMatchObject({ status: 'ok', database: 'up' });
    expect(JSON.stringify(response.body)).not.toMatch(/postgres|DATABASE_URL/i);
  });
});

describe('GET /api/v1/categories', () => {
  it('returns only active categories, ordered by displayOrder', async () => {
    const response = await request(app).get('/api/v1/categories');

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.map((category: { slug: string }) => category.slug)).toEqual([
      'toys',
      'stationery',
    ]);
  });
});

describe('GET /api/v1/products', () => {
  const names = (body: { data: { items: { name: string }[] } }) =>
    body.data.items.map((item) => item.name).sort();

  it('returns only active products in active categories', async () => {
    const response = await request(app).get('/api/v1/products');

    expect(response.status).toBe(200);
    expect(names(response.body)).toEqual([
      'Classmate Notebook',
      'Pencil Pack',
      'Remote Car',
      'Teddy Bear',
    ]);
    expect(response.body.data.pagination).toEqual({ page: 1, limit: 20, total: 4, totalPages: 1 });
  });

  it('exposes availability but not internal stock bookkeeping', async () => {
    const response = await request(app).get('/api/v1/products?search=notebook');
    const [notebook] = response.body.data.items;

    expect(notebook).toMatchObject({
      sellingPricePaise: 34900,
      availableQuantity: 10,
      inStock: true,
      category: { slug: 'stationery' },
      images: [{ url: 'https://example.test/notebook.jpg' }],
    });
    expect(notebook).not.toHaveProperty('stockQuantity');
    expect(notebook).not.toHaveProperty('reservedQuantity');
    expect(notebook).not.toHaveProperty('lowStockThreshold');
  });

  it('paginates without overlap', async () => {
    const first = await request(app).get('/api/v1/products?page=1&limit=3');
    const second = await request(app).get('/api/v1/products?page=2&limit=3');

    expect(first.body.data.pagination).toMatchObject({ total: 4, totalPages: 2 });
    expect(first.body.data.items).toHaveLength(3);
    expect(second.body.data.items).toHaveLength(1);
    expect(names(first.body)).not.toContain(second.body.data.items[0].name);
  });

  it('filters by category slug, featured, new and search', async () => {
    const byCategory = await request(app).get('/api/v1/products?category=toys');
    expect(names(byCategory.body)).toEqual(['Remote Car', 'Teddy Bear']);

    const featured = await request(app).get('/api/v1/products?featured=true');
    expect(names(featured.body)).toEqual(['Classmate Notebook']);

    const fresh = await request(app).get('/api/v1/products?new=true');
    expect(names(fresh.body)).toEqual(['Pencil Pack']);

    const search = await request(app).get('/api/v1/products?search=%20NOTEBOOK%20');
    expect(names(search.body)).toEqual(['Classmate Notebook']);
  });

  it('rejects invalid query values with a validation error', async () => {
    const response = await request(app).get('/api/v1/products?limit=1000&featured=yes');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
  });
});

describe('GET /api/v1/products/:identifier', () => {
  it('finds a product by slug or by id', async () => {
    const bySlug = await request(app).get('/api/v1/products/classmate-notebook');
    const byId = await request(app).get(`/api/v1/products/${fixtures.products.notebook.id}`);

    expect(bySlug.status).toBe(200);
    expect(bySlug.body.data.id).toBe(fixtures.products.notebook.id);
    expect(byId.body.data.slug).toBe('classmate-notebook');
  });

  it('hides inactive products and unknown slugs behind the same 404', async () => {
    for (const identifier of ['retired-toy', 'hidden-thing', 'does-not-exist']) {
      const response = await request(app).get(`/api/v1/products/${identifier}`);
      expect(response.status).toBe(404);
      expect(response.body.error.code).toBe('PRODUCT_NOT_FOUND');
    }
  });
});

describe('GET /api/v1/delivery-areas', () => {
  it('returns only active areas with their charges', async () => {
    const response = await request(app).get('/api/v1/delivery-areas');

    expect(response.status).toBe(200);
    expect(response.body.data).toEqual([
      {
        id: fixtures.areas.withMinimum.id,
        name: 'Model Town',
        pincode: null,
        deliveryChargePaise: 4000,
        minimumOrderPaise: 20000,
        freeDeliveryThresholdPaise: null,
      },
      {
        id: fixtures.areas.standard.id,
        name: 'Station Road',
        pincode: null,
        deliveryChargePaise: 3000,
        minimumOrderPaise: null,
        freeDeliveryThresholdPaise: 50000,
      },
    ]);
  });
});

describe('unknown routes', () => {
  it('answer with the standard error envelope', async () => {
    const response = await request(app).get('/api/v1/nope');

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({ success: false, error: { code: 'ROUTE_NOT_FOUND' } });
  });

  it('do not expose admin-style write endpoints', async () => {
    const response = await request(app).post('/api/v1/products').send({ name: 'Free stuff' });
    expect(response.status).toBe(404);
  });
});
