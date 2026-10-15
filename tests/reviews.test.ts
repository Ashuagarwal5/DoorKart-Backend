import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, app, createTestAdmin, createTestBuyer, getStock, orderPayload, prisma, resetDatabase, seedFixtures, signIn, type Fixtures, type AdminAgent } from './helpers.js';

let fixtures: Fixtures;
let admin: AdminAgent;
let buyer: Awaited<ReturnType<typeof createTestBuyer>>;
const body = { rating: 5, title: 'Good quality', content: 'The notebook arrived in good condition.' };
const own = '/api/v1/account/reviews';
const admins = '/api/v1/admin/reviews';
const productPath = () => `${own}/product/${fixtures.products.notebook.id}`;
const publicPath = () => `/api/v1/products/${fixtures.products.notebook.id}/reviews`;
const submit = (input: object = body, token = buyer.token) => request(app).post(productPath()).auth(token, { type: 'bearer' }).send(input);
const setting = (key: string, value: string) => prisma.setting.upsert({ where: { key: `reviews.${key}` }, create: { key: `reviews.${key}`, value }, update: { value } });
async function delivered(account = buyer, productId = fixtures.products.notebook.id) {
  const result = await request(app).post('/api/v1/orders').auth(account.token, { type: 'bearer' }).send(orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId, quantity: 1 }] }));
  expect(result.status).toBe(201);
  const order = await prisma.order.findUniqueOrThrow({ where: { orderNumber: result.body.data.orderNumber } });
  await advance(admin, order.id, ['CONFIRMED', 'PACKED', 'OUT_FOR_DELIVERY', 'DELIVERED']);
  return order.id;
}
const moderate = (id: string, action: string) => admin.post(`${admins}/${id}/moderate`).send({ action, note: 'Reviewed by shop' });

beforeEach(async () => {
  await resetDatabase(); fixtures = await seedFixtures(); await createTestAdmin({ role: 'SUPER_ADMIN' });
  admin = await signIn(); buyer = await createTestBuyer();
});

describe('review authentication and verified purchases', () => {
  it('requires authentication for all customer mutations and own history', async () => {
    expect((await request(app).post(productPath()).send(body)).status).toBe(401);
    expect((await request(app).get(own)).status).toBe(401);
    expect((await request(app).patch(`${own}/unknown`).send(body)).status).toBe(401);
    expect((await request(app).delete(`${own}/unknown`)).status).toBe(401);
    expect(await prisma.review.count()).toBe(0);
  });
  it('uses a delivered account purchase and leaves orders, histories and stock untouched', async () => {
    await delivered();
    const stock = await getStock(fixtures.products.notebook.id);
    const orders = await prisma.order.findMany();
    const history = await prisma.orderStatusHistory.count();
    const response = await submit();
    expect(response.status).toBe(201);
    expect(response.body.data).toMatchObject({ verifiedPurchase: true, origin: 'CUSTOMER', status: 'PENDING', rating: 5 });
    expect(response.body.data).not.toHaveProperty('purchaseItemId');
    expect(response.body.data).not.toHaveProperty('accountId');
    expect(await getStock(fixtures.products.notebook.id)).toEqual(stock);
    expect(await prisma.order.findMany()).toEqual(orders);
    expect(await prisma.orderStatusHistory.count()).toBe(history);
    expect((await request(app).get(publicPath())).body.data.summary.count).toBe(0);
  });
  it('rejects no purchase, another account purchase and another product purchase', async () => {
    expect((await submit()).body.error.code).toBe('REVIEW_NOT_ELIGIBLE');
    await delivered(await createTestBuyer());
    await delivered(buyer, fixtures.products.pencil.id);
    expect((await submit()).status).toBe(403);
  });
  it('does not claim historical guest purchases', async () => {
    const id = await delivered();
    await prisma.order.update({ where: { id }, data: { accountId: null } });
    expect((await submit()).status).toBe(403);
  });
  it('does not accept an undelivered order', async () => {
    await request(app).post('/api/v1/orders').auth(buyer.token, { type: 'bearer' }).send(orderPayload({ deliveryAreaId: fixtures.areas.standard.id, items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] }));
    expect((await submit()).status).toBe(403);
  });
  it('enforces delivery age and optional collected payment', async () => {
    const id = await delivered();
    await setting('requireCollectedPayment', 'true');
    expect((await submit()).status).toBe(403);
    await prisma.order.update({ where: { id }, data: { paymentStatus: 'COLLECTED' } });
    await setting('purchaseWindowDays', '7');
    await prisma.order.update({ where: { id }, data: { deliveredAt: new Date(Date.now() - 8 * 86400000) } });
    expect((await submit()).status).toBe(403);
    await setting('purchaseWindowDays', '0');
    expect((await submit()).body.data.verifiedPurchase).toBe(true);
  });
  it.each(['accountId', 'purchaseItemId', 'verifiedPurchase', 'origin', 'status', 'reviewerName'])('rejects forged %s', async (field) => {
    await setting('verifiedOnly', 'false');
    expect((await submit({ ...body, [field]: 'forged' })).status).toBe(400);
    expect(await prisma.review.count()).toBe(0);
  });
  it('supports explicitly permitted unverified customers, never auto-assigning proof later', async () => {
    await setting('verifiedOnly', 'false'); await setting('requireApproval', 'false');
    const review = await submit();
    expect(review.body.data).toMatchObject({ verifiedPurchase: false, status: 'PUBLISHED' });
    await delivered();
    expect((await request(app).get(publicPath())).body.data.items[0].verifiedPurchase).toBe(false);
    await setting('verifiedOnly', 'true');
    expect((await request(app).get(publicPath())).body.data.summary.count).toBe(0);
  });
  it('prevents concurrent duplicate reviews and duplicate recreation after deletion', async () => {
    await setting('verifiedOnly', 'false');
    const responses = await Promise.all([submit(), submit()]);
    expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
    const review = await prisma.review.findFirstOrThrow();
    expect((await request(app).delete(`${own}/${review.id}`).auth(buyer.token, { type: 'bearer' })).status).toBe(200);
    expect((await submit()).status).toBe(409);
    const eligibility = await request(app).get(productPath()).auth(buyer.token, { type: 'bearer' });
    expect(eligibility.body.data).toMatchObject({ existing: null, previouslyDeleted: true });
  });
  it.each([0, 6, 1.5, '5'])('rejects invalid rating %s', async (rating) => {
    expect((await submit({ ...body, rating })).status).toBe(400);
  });
  it('enforces text limits and required title/content', async () => {
    await setting('verifiedOnly', 'false'); await setting('maxContentLength', '50');
    expect((await submit({ ...body, content: 'x'.repeat(51) })).status).toBe(400);
    expect((await submit({ ...body, title: ' ' })).status).toBe(400);
    expect((await submit({ ...body, content: ' ' })).status).toBe(400);
    expect((await submit({ ...body, title: 'x'.repeat(121) })).status).toBe(400);
  });
});

describe('review ownership, editing and moderation', () => {
  beforeEach(async () => { await setting('verifiedOnly', 'false'); });
  it('keeps history private and rejects another account editing/deleting', async () => {
    const id = (await submit()).body.data.id;
    const other = await createTestBuyer();
    expect((await request(app).get(own).auth(other.token, { type: 'bearer' })).body.data.items).toEqual([]);
    expect((await request(app).patch(`${own}/${id}`).auth(other.token, { type: 'bearer' }).send(body)).status).toBe(404);
    expect((await request(app).delete(`${own}/${id}`).auth(other.token, { type: 'bearer' })).status).toBe(404);
    expect((await request(app).get(`${own}?accountId=${buyer.id}`).auth(other.token, { type: 'bearer' })).status).toBe(400);
    expect((await request(app).get(own).auth(buyer.token, { type: 'bearer' })).body.data.items).toHaveLength(1);
  });
  it('approves, hides, preserves hidden status on edits, restores and rejects', async () => {
    const id = (await submit()).body.data.id;
    expect((await moderate(id, 'approve')).body.data.status).toBe('PUBLISHED');
    expect((await request(app).get(publicPath())).body.data.summary.count).toBe(1);
    expect((await moderate(id, 'hide')).body.data.status).toBe('HIDDEN');
    expect((await request(app).get(publicPath())).body.data.summary.count).toBe(0);
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send({ ...body, rating: 4 })).body.data.status).toBe('HIDDEN');
    expect((await moderate(id, 'approve')).status).toBe(403);
    expect((await moderate(id, 'restore')).body.data.status).toBe('PUBLISHED');
    expect((await moderate(id, 'reject')).body.data.status).toBe('REJECTED');
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send(body)).body.data.status).toBe('PENDING');
  });
  it('returns published edits to approval and removes deleted reviews from aggregates', async () => {
    const id = (await submit()).body.data.id; await moderate(id, 'approve');
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send(body)).body.data.status).toBe('PENDING');
    await moderate(id, 'approve');
    await request(app).delete(`${own}/${id}`).auth(buyer.token, { type: 'bearer' });
    expect((await request(app).get(publicPath())).body.data.summary.count).toBe(0);
    expect((await moderate(id, 'restore')).status).toBe(404);
  });
  it('enforces editing and deletion policy windows', async () => {
    const id = (await submit()).body.data.id;
    await setting('allowEditing', 'false');
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send(body)).status).toBe(403);
    await setting('allowEditing', 'true'); await setting('editWindowDays', '1');
    await prisma.review.update({ where: { id }, data: { createdAt: new Date(Date.now() - 2 * 86400000) } });
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send(body)).status).toBe(403);
    expect((await request(app).delete(`${own}/${id}`).auth(buyer.token, { type: 'bearer' })).status).toBe(403);
  });
  it('disables public ratings and submission/editing while retaining own history and deletion', async () => {
    const id = (await submit()).body.data.id; await moderate(id, 'approve'); await setting('enabled', 'false');
    const data = (await request(app).get(publicPath())).body.data;
    expect(data).toMatchObject({ enabled: false, items: [], summary: { count: 0, average: 0 } });
    expect((await submit()).body.error.code).toBe('REVIEWS_DISABLED');
    expect((await request(app).patch(`${own}/${id}`).auth(buyer.token, { type: 'bearer' }).send(body)).status).toBe(403);
    expect((await request(app).get(own).auth(buyer.token, { type: 'bearer' })).body.data.items).toHaveLength(1);
    expect((await request(app).delete(`${own}/${id}`).auth(buyer.token, { type: 'bearer' })).status).toBe(200);
  });
  it('labels manually entered/imported reviews truthfully and prevents forged verification', async () => {
    for (const origin of ['ADMIN_ENTERED', 'IMPORTED']) {
      const input = { ...body, productId: fixtures.products.notebook.id, origin, sourceLabel: 'Permission-based shop feedback archive' };
      expect((await admin.post(admins).send({ ...input, verifiedPurchase: true })).status).toBe(400);
      expect((await admin.post(admins).send({ ...input, reviewerName: 'Pretend customer' })).status).toBe(400);
      const response = await admin.post(admins).send(input);
      expect(response.status).toBe(201);
      expect(response.body.data).toMatchObject({ origin, verifiedPurchase: false, status: 'PENDING', sourceLabel: input.sourceLabel });
      await moderate(response.body.data.id, 'approve');
    }
    const data = (await request(app).get(publicPath())).body.data;
    expect(data.summary.originCounts).toEqual({ CUSTOMER: 0, ADMIN_ENTERED: 1, IMPORTED: 1 });
    expect(data.items.map((r: { reviewerName: string }) => r.reviewerName).sort()).toEqual(['Imported review', 'Shop-entered review']);
  });
  it('calculates averages/distribution from published only with sorting and pagination', async () => {
    for (const rating of [1, 3, 5]) {
      const token = (await createTestBuyer()).token;
      const id = (await submit({ ...body, rating }, token)).body.data.id;
      await moderate(id, 'approve');
    }
    await submit({ ...body, rating: 2 }); // pending, excluded
    const high = (await request(app).get(`${publicPath()}?sort=highest&limit=2`)).body.data;
    expect(high.summary).toMatchObject({ average: 3, count: 3, distribution: [{ rating: 5, count: 1 }, { rating: 4, count: 0 }, { rating: 3, count: 1 }, { rating: 2, count: 0 }, { rating: 1, count: 1 }] });
    expect(high.items.map((r: { rating: number }) => r.rating)).toEqual([5, 3]);
    expect(high.pagination.totalPages).toBe(2);
    expect((await request(app).get(`${publicPath()}?sort=lowest&limit=1`)).body.data.items[0].rating).toBe(1);
    expect((await request(app).get(`${publicPath()}?sort=highest&limit=2&page=2`)).body.data.items[0].rating).toBe(1);
    expect((await admin.get(`${admins}?search=Notebook&status=PENDING&limit=1`)).body.data.pagination.total).toBe(1);
  });
  it('protects admin moderation, trusted origins and settings roles', async () => {
    const id = (await submit()).body.data.id;
    expect((await request(app).get(admins)).status).toBe(401);
    expect((await request(app).post(`${admins}/${id}/moderate`).send({ action: 'approve' })).status).toBe(401);
    expect((await admin.post(`${admins}/${id}/moderate`).set('Origin', 'https://hostile.example').send({ action: 'approve' })).status).toBe(403);
    expect((await admin.patch('/api/v1/admin/settings').send({ changes: { 'reviews.maxContentLength': '10001' } })).status).toBe(400);
    await createTestAdmin({ email: 'moderator@example.test', role: 'ADMIN' });
    const moderator = await signIn('moderator@example.test');
    expect((await moderator.patch('/api/v1/admin/settings').send({ changes: { 'reviews.enabled': 'false' } })).status).toBe(403);
  });
});
