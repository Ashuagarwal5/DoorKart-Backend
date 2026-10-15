import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createAccountSession } from '../src/modules/accounts/account-session.js';
import { app, type Fixtures, getStock, orderPayload, prisma, resetDatabase, seedFixtures } from './helpers.js';

let fixtures: Fixtures;
let owner: { id: string; token: string };
let other: { id: string; token: string };
const base = '/api/v1/account/addresses';

async function account(email: string) {
  const saved = await prisma.account.create({ data: { email, emailVerifiedAt: new Date() } });
  return { id: saved.id, token: (await createAccountSession(saved.id, new Date())).token };
}

function draft(extra: Record<string, unknown> = {}) {
  return {
    label: 'Home', isDefault: false, fullName: 'Asha Rao', phone: '+91 98765 43210',
    addressLine1: '12 Test Street', addressLine2: '', landmark: '', city: 'Testpur',
    pincode: fixtures.areas.standard.pincode, deliveryAreaId: fixtures.areas.standard.id,
    ...extra,
  };
}

const add = (body: object = draft(), token = owner.token) => request(app).post(base).auth(token, { type: 'bearer' }).send(body);
const list = (token = owner.token) => request(app).get(base).auth(token, { type: 'bearer' });

beforeEach(async () => {
  await resetDatabase();
  fixtures = await seedFixtures();
  owner = await account('addresses-owner@example.test');
  other = await account('addresses-other@example.test');
});

describe('account address book', () => {
  it('keeps multiple owned addresses and restores them with a different session', async () => {
    const first = await add();
    const second = await add(draft({ label: 'Work', addressLine1: '24 Work Street' }));
    expect(first.status).toBe(201);
    expect(first.body.data).toMatchObject({ phone: '9876543210', isDefault: true, addressLine2: '', landmark: '' });
    expect(second.body.data.isDefault).toBe(false);
    expect(first.body.data).not.toHaveProperty('accountId');
    expect(first.headers['cache-control']).toBe('no-store');
    expect((await list(other.token)).body.data).toEqual([]);
    await request(app).post('/api/v1/auth/logout').auth(owner.token, { type: 'bearer' });
    const nextSession = await createAccountSession(owner.id, new Date());
    const recovered = await list(nextSession.token);
    expect(recovered.status).toBe(200);
    expect(recovered.body.data.map((address: { id: string }) => address.id)).toEqual([first.body.data.id, second.body.data.id]);
  });

  it('edits contact/address fields and atomically switches the default', async () => {
    const first = await add();
    const second = await add(draft({ label: 'Work' }));
    const edited = await request(app).patch(`${base}/${second.body.data.id}`).auth(owner.token, { type: 'bearer' })
      .send(draft({ label: 'Other', isDefault: true, fullName: 'Asha Kumar', addressLine1: ' New Street ' }));
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ fullName: 'Asha Kumar', addressLine1: 'New Street', label: 'Other', isDefault: true });
    const updated = (await list()).body.data;
    expect(updated.filter((address: { isDefault: boolean }) => address.isDefault)).toHaveLength(1);
    expect(updated.find((address: { id: string }) => address.id === first.body.data.id).isDefault).toBe(false);
  });

  it('promotes a remaining address when deleting the default and permits an empty book', async () => {
    const first = await add();
    const second = await add(draft({ label: 'Other' }));
    expect((await request(app).delete(`${base}/${first.body.data.id}`).auth(owner.token, { type: 'bearer' })).body.data).toEqual({ deleted: true });
    expect((await list()).body.data).toMatchObject([{ id: second.body.data.id, isDefault: true }]);
    expect((await request(app).delete(`${base}/${second.body.data.id}`).auth(owner.token, { type: 'bearer' })).status).toBe(200);
    expect((await list()).body.data).toEqual([]);
  });

  it('returns an updated book when choosing a default', async () => {
    await add();
    const second = await add(draft({ label: 'Work' }));
    const result = await request(app).post(`${base}/${second.body.data.id}/default`).auth(owner.token, { type: 'bearer' }).send({});
    expect(result.status).toBe(200);
    expect(result.body.data).toHaveLength(2);
    expect(result.body.data.find((address: { id: string }) => address.id === second.body.data.id)).toMatchObject({ isDefault: true });
    expect(result.body.data.filter((address: { isDefault: boolean }) => address.isDefault)).toHaveLength(1);
  });

  it('prevents cross-account mutation and rejects forged owner identifiers', async () => {
    const saved = await add();
    const id = saved.body.data.id;
    for (const token of [other.token]) {
      expect((await request(app).patch(`${base}/${id}`).auth(token, { type: 'bearer' }).send(draft())).status).toBe(404);
      expect((await request(app).delete(`${base}/${id}`).auth(token, { type: 'bearer' })).status).toBe(404);
      expect((await request(app).post(`${base}/${id}/default`).auth(token, { type: 'bearer' }).send({})).status).toBe(404);
    }
    expect((await add(draft({ accountId: other.id }))).status).toBe(400);
    expect((await request(app).post(`${base}/${id}/default`).auth(owner.token, { type: 'bearer' }).send({ accountId: other.id })).status).toBe(400);
    expect((await request(app).delete(`${base}/${id}`).auth(owner.token, { type: 'bearer' }).send({ accountId: other.id })).status).toBe(400);
    expect((await request(app).get(`${base}?accountId=${other.id}`).auth(owner.token, { type: 'bearer' })).status).toBe(400);
    expect((await list()).body.data).toEqual([saved.body.data]);
  });

  it('requires a valid active session for every operation', async () => {
    const saved = await add();
    expect((await request(app).get(base)).status).toBe(401);
    await prisma.accountSession.updateMany({ where: { accountId: owner.id }, data: { expiresAt: new Date(0) } });
    expect((await list()).status).toBe(401);
    expect((await add()).status).toBe(401);
    expect((await request(app).patch(`${base}/${saved.body.data.id}`).auth(owner.token, { type: 'bearer' }).send(draft())).status).toBe(401);
    expect((await request(app).delete(`${base}/${saved.body.data.id}`).auth(owner.token, { type: 'bearer' })).status).toBe(401);
    expect((await request(app).post(`${base}/${saved.body.data.id}/default`).auth(owner.token, { type: 'bearer' }).send({})).status).toBe(401);
    await prisma.account.update({ where: { id: other.id }, data: { isActive: false } });
    expect((await list(other.token)).status).toBe(401);
  });

  it.each([undefined, null, '', '12345', '1234567', '012345', 'ABCDEF', 226001])('rejects malformed pincode %s', async (pincode) => {
    expect((await add(draft({ pincode }))).status).toBe(400);
    expect(await prisma.accountAddress.count()).toBe(0);
  });

  it('allows an address before choosing a delivery area, without bypassing checkout validation', async () => {
    const saved = await add(draft({ pincode: '226002', deliveryAreaId: null }));
    expect(saved.status).toBe(201);
    expect(saved.body.data.deliveryAreaId).toBeNull();
    const body = orderPayload({ deliveryAreaId: fixtures.areas.standard.id,
      items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] });
    body.address.pincode = saved.body.data.pincode;
    const purchase = await request(app).post('/api/v1/orders').auth(owner.token, { type: 'bearer' }).send(body);
    expect(purchase.status).toBe(422);
    expect(purchase.body.error.code).toBe('DELIVERY_PINCODE_UNSUPPORTED');
    expect(await prisma.order.count()).toBe(0);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(0);
  });

  it('rejects unsupported, inactive or missing delivery areas without changing a saved default', async () => {
    const saved = await add();
    expect((await add(draft({ pincode: '226002', isDefault: true }))).body.error.code).toBe('DELIVERY_PINCODE_UNSUPPORTED');
    expect((await add(draft({ deliveryAreaId: fixtures.areas.inactive.id }))).body.error.code).toBe('DELIVERY_AREA_UNAVAILABLE');
    expect((await add(draft({ deliveryAreaId: 'missing-area' }))).body.error.code).toBe('DELIVERY_AREA_NOT_FOUND');
    expect((await request(app).patch(`${base}/${saved.body.data.id}`).auth(owner.token, { type: 'bearer' })
      .send(draft({ pincode: '226002' }))).status).toBe(422);
    expect((await list()).body.data).toEqual([saved.body.data]);
  });

  it('serializes concurrent default changes to preserve exactly one default', async () => {
    const first = await add();
    const second = await add(draft({ label: 'Work' }));
    const results = await Promise.all([first, second].map((saved) => request(app).post(`${base}/${saved.body.data.id}/default`)
      .auth(owner.token, { type: 'bearer' }).send({})));
    expect(results.map((result) => result.status)).toEqual([200, 200]);
    expect(await prisma.accountAddress.count({ where: { accountId: owner.id, isDefault: true } })).toBe(1);
  });

  it('enforces the ten-address limit even when additions race', async () => {
    for (let index = 0; index < 9; index++) expect((await add(draft({ addressLine1: `${index} Test Street` }))).status).toBe(201);
    const results = await Promise.all([add(draft({ addressLine1: '10 Test Street' })), add(draft({ addressLine1: '11 Test Street' }))]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    expect(results.find((result) => result.status === 409)?.body.error.code).toBe('ADDRESS_BOOK_FULL');
    expect(await prisma.accountAddress.count({ where: { accountId: owner.id } })).toBe(10);
    expect(await prisma.accountAddress.count({ where: { accountId: owner.id, isDefault: true } })).toBe(1);
  });

  it('uses an account address at checkout and preserves commerce on account deletion', async () => {
    const saved = await add();
    await add(draft(), other.token);
    const body = orderPayload({ deliveryAreaId: saved.body.data.deliveryAreaId,
      items: [{ productId: fixtures.products.notebook.id, quantity: 1 }] });
    body.customer = { fullName: saved.body.data.fullName, mobile: saved.body.data.phone };
    body.address = { addressLine1: saved.body.data.addressLine1, addressLine2: saved.body.data.addressLine2,
      landmark: saved.body.data.landmark, city: saved.body.data.city, pincode: saved.body.data.pincode };
    const purchase = await request(app).post('/api/v1/orders').auth(owner.token, { type: 'bearer' }).send(body);
    expect(purchase.status).toBe(201);
    expect((await request(app).delete('/api/v1/account/me').auth(owner.token, { type: 'bearer' })).status).toBe(200);
    expect(await prisma.accountAddress.count({ where: { accountId: owner.id } })).toBe(0);
    expect(await prisma.accountAddress.count({ where: { accountId: other.id } })).toBe(1);
    const retained = await prisma.order.findUniqueOrThrow({ where: { orderNumber: purchase.body.data.orderNumber } });
    expect(retained.accountId).toBeNull();
    expect(retained.addressLine1).toBe(saved.body.data.addressLine1);
    expect((await getStock(fixtures.products.notebook.id)).reservedQuantity).toBe(1);
    expect((await request(app).get(`/api/v1/orders/${retained.orderNumber}`).set('x-tracking-token', purchase.body.data.trackingToken)).status).toBe(200);
  });
});
