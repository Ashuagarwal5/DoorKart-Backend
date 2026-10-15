import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { advance, app, createTestAdmin, createTestBuyer, getStock, placeTestOrder, prisma, resetDatabase, seedFixtures, signIn, type AdminAgent, type Fixtures } from './helpers.js';

let admin: AdminAgent;
let fixtures: Fixtures;
const base = '/api/v1/admin/returns';
beforeEach(async () => { await resetDatabase(); fixtures = await seedFixtures(); await createTestAdmin(); admin = await signIn(); });
async function delivered(collected = true, quantity = 2) {
  const order = await placeTestOrder(fixtures, [{ productId: fixtures.products.notebook.id, quantity }]);
  await advance(admin, order.id, ['CONFIRMED','PACKED','OUT_FOR_DELIVERY','DELIVERED']);
  if (collected) expect((await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({ paymentStatus: 'COLLECTED' })).status).toBe(200);
  const item = await prisma.orderItem.findFirstOrThrow({ where: { orderId: order.id } });
  return { ...order, item };
}
function draft(orderId: string, amount = 10000, extra: object = {}) {
  return { clientRequestId: randomUUID(), orderId, kind: 'REFUND_ONLY', reason: 'Customer reported damaged packaging', requestedAmountPaise: amount, items: [], ...extra };
}
const create = (body: object) => admin.post(base).send(body);
const action = (id: string, body: object) => admin.post(`${base}/${id}/actions`).send({ requestId: randomUUID(), note: 'Checked with the customer in store', ...body });
async function approved(orderId: string, amount = 10000, extra: object = {}) {
  const response = await create(draft(orderId, amount, extra)); expect(response.status).toBe(201);
  expect((await action(response.body.data.id, { action: 'APPROVE', approvedAmountPaise: amount })).status).toBe(200);
  return response.body.data.id as string;
}

describe('COD return/refund eligibility and authorization', () => {
  it('requires a valid staff session, rejects customer tokens and untrusted browser origins', async () => {
    const order = await delivered();
    const input = draft(order.id);
    expect((await request(app).post(base).send(input)).status).toBe(401);
    expect((await request(app).get(base)).status).toBe(401);
    const buyer = await createTestBuyer();
    expect((await request(app).post(base).auth(buyer.token, { type:'bearer' }).send(input)).status).toBe(401);
    expect((await admin.post(base).set('Origin','https://hostile.example').send(input)).status).toBe(403);
    expect(await prisma.returnCase.count()).toBe(0);
  });
  it('rejects non-delivered orders without moving stock or changing payment', async () => {
    const order = await placeTestOrder(fixtures,[{ productId:fixtures.products.notebook.id,quantity:1 }]);
    const before = await getStock(fixtures.products.notebook.id);
    expect((await create(draft(order.id))).status).toBe(422);
    await advance(admin,order.id,['CANCELLED']);
    expect((await create(draft(order.id))).status).toBe(422);
    expect(await prisma.returnCase.count()).toBe(0);
    expect(before.reservedQuantity).toBe(1);
    expect((await getStock(fixtures.products.notebook.id)).stockQuantity).toBe(before.stockQuantity);
  });
  it('records unpaid delivered requests but blocks refund approval until collection', async () => {
    const order = await delivered(false);
    const response = await create(draft(order.id)); expect(response.status).toBe(201);
    const id = response.body.data.id;
    expect((await action(id,{ action:'APPROVE',approvedAmountPaise:10000 })).body.error.code).toBe('REFUND_LIMIT_EXCEEDED');
    expect((await action(id,{ action:'COMPLETE',payoutReference:'UNPAID-1' })).status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({ paymentStatus:'COLLECTED' })).status).toBe(200);
    expect((await action(id,{ action:'APPROVE',approvedAmountPaise:10000 })).status).toBe(200);
  });
  it.each([-1,1.5,2147483648,'100'])('rejects invalid amount %s', async amount => {
    const order = await delivered();
    expect((await create({ ...draft(order.id),requestedAmountPaise:amount })).status).toBe(400);
  });
  it('rejects invalid kinds, forged admin/completion fields and incoherent item/amount input', async () => {
    const order = await delivered();
    for (const extra of [{ adminId:'forged' },{ status:'COMPLETED' },{ completedAt:new Date().toISOString() },{ kind:'RETURN_ONLY' },{ kind:'RETURN_REFUND' },{ requestedAmountPaise:0 },{ reason:' ' }]) {
      expect((await create({ ...draft(order.id), ...extra })).status).toBe(400);
    }
    expect(await prisma.returnCase.count()).toBe(0);
  });
  it('rejects items from another order, repeated item IDs and excess quantities', async () => {
    const first = await delivered(); const other = await delivered();
    expect((await create(draft(first.id,0,{ kind:'RETURN_ONLY',items:[{ orderItemId:other.item.id,quantity:1 }] }))).status).toBe(422);
    expect((await create(draft(first.id,0,{ kind:'RETURN_ONLY',items:[{ orderItemId:first.item.id,quantity:3 }] }))).status).toBe(422);
    expect((await create(draft(first.id,0,{ kind:'RETURN_ONLY',items:[{ orderItemId:first.item.id,quantity:1 },{ orderItemId:first.item.id,quantity:1 }] }))).status).toBe(400);
  });
});

describe('refund limits, retries and cash reconciliation', () => {
  it('handles full cash refund while preserving fulfillment/payment snapshots and inventory', async () => {
    const order = await delivered();
    const snapshot = await prisma.order.findUniqueOrThrow({ where:{ id:order.id } });
    const paymentHistory = await prisma.paymentStatusHistory.findMany({ where:{ orderId:order.id } });
    const statusHistory = await prisma.orderStatusHistory.findMany({ where:{ orderId:order.id } });
    const stock = await getStock(fixtures.products.notebook.id);
    const id = await approved(order.id,order.grandTotalPaise);
    const done = await action(id,{ action:'COMPLETE',payoutReference:'CASH-FULL-1' });
    expect(done.status).toBe(200);
    expect(done.body.data).toMatchObject({ status:'COMPLETED',approvedAmountPaise:order.grandTotalPaise,payoutReference:'CASH-FULL-1' });
    expect(done.body.data.events.map((event: {action:string})=>event.action)).toEqual(['REQUEST','APPROVE','COMPLETE']);
    expect(done.body.data.events[2]).toMatchObject({ adminName:'Test Admin',details:{ paidAmountPaise:order.grandTotalPaise,method:'CASH' } });
    expect(done.body.data).not.toHaveProperty('requestFingerprint');
    expect(done.body.data.order).not.toHaveProperty('trackingToken');
    expect(await prisma.order.findUniqueOrThrow({ where:{ id:order.id } })).toEqual(snapshot);
    expect(await prisma.paymentStatusHistory.findMany({ where:{ orderId:order.id } })).toEqual(paymentHistory);
    expect(await prisma.orderStatusHistory.findMany({ where:{ orderId:order.id } })).toEqual(statusHistory);
    expect(await getStock(fixtures.products.notebook.id)).toEqual(stock);
    const summary = (await admin.get(`${base}/order/${order.id}`)).body.data.summary;
    expect(summary).toMatchObject({ collectedPaise:order.grandTotalPaise,completedRefundPaise:order.grandTotalPaise,remainingRefundablePaise:0,netCashRetainedPaise:0 });
    expect((await create(draft(order.id,1))).body.error.code).toBe('REFUND_LIMIT_EXCEEDED');
  });
  it('supports multiple completed partial refunds and caps the cumulative total', async () => {
    const order = await delivered();
    const first = await approved(order.id,10000);
    const waiting = (await admin.get(`${base}/order/${order.id}`)).body.data.summary;
    expect(waiting.approvedAwaitingPaise).toBe(10000);
    expect(waiting.remainingRefundablePaise).toBe(order.grandTotalPaise-10000);
    await action(first,{ action:'COMPLETE',payoutReference:'PART-A' });
    const remaining = order.grandTotalPaise-10000;
    expect((await create(draft(order.id,remaining+1))).status).toBe(422);
    const second = await approved(order.id,remaining);
    await action(second,{ action:'COMPLETE',payoutReference:'PART-B' });
    const summary = (await admin.get(`${base}/reconciliation`)).body.data;
    expect(summary).toMatchObject({ collectedPaise:order.grandTotalPaise,refundedPaise:order.grandTotalPaise,netCashMovementPaise:0,approvedAwaitingPaise:0 });
  });
  it('allows approving less than requested, but not more or zero for a refund', async () => {
    const order = await delivered(); const row = await create(draft(order.id,10000)); const id = row.body.data.id;
    expect((await action(id,{ action:'APPROVE',approvedAmountPaise:10001 })).status).toBe(422);
    expect((await action(id,{ action:'APPROVE',approvedAmountPaise:0 })).status).toBe(422);
    expect((await action(id,{ action:'APPROVE',approvedAmountPaise:5000 })).status).toBe(200);
    await action(id,{ action:'COMPLETE',payoutReference:'SMALLER' });
    expect((await admin.get(`${base}/order/${order.id}`)).body.data.summary.completedRefundPaise).toBe(5000);
  });
  it('serializes concurrent creation and replays identical request IDs', async () => {
    const order = await delivered(); const input = draft(order.id);
    const retries = await Promise.all([create(input),create(input),create(input)]);
    expect(retries.map(r=>r.status)).toEqual([201,201,201]);
    expect(new Set(retries.map(r=>r.body.data.id)).size).toBe(1);
    expect(await prisma.returnCase.count()).toBe(1);
    expect(await prisma.returnCaseEvent.count()).toBe(1);
    expect((await create({ ...input,requestedAmountPaise:9999 })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await create(draft(order.id))).status).toBe(409);
  });
  it('allows only one concurrently created open case with different request IDs', async () => {
    const order = await delivered();
    const results = await Promise.all([create(draft(order.id)),create(draft(order.id))]);
    expect(results.map(r=>r.status).sort()).toEqual([201,409]);
  });
  it('records a payout once even with concurrent retries, and rejects changed retry payloads', async () => {
    const order = await delivered(); const id = await approved(order.id);
    const input = { requestId:randomUUID(),action:'COMPLETE',payoutReference:'EXACT-RETRY' };
    const results = await Promise.all([action(id,input),action(id,input),action(id,input)]);
    expect(results.map(r=>r.status)).toEqual([200,200,200]);
    expect(await prisma.returnCaseEvent.count({ where:{ caseId:id,action:'COMPLETE' } })).toBe(1);
    expect((await action(id,{ ...input,payoutReference:'CHANGED' })).body.error.code).toBe('IDEMPOTENCY_CONFLICT');
    expect((await action(id,{ action:'COMPLETE',payoutReference:'NEW-KEY' })).status).toBe(409);
    expect((await action(id,{ action:'REJECT' })).status).toBe(409);
  });
  it('requires a unique payout reference across orders and rolls back duplicate payout attempts', async () => {
    const first = await delivered(); const other = await delivered();
    const a = await approved(first.id); const b = await approved(other.id);
    expect((await action(a,{ action:'COMPLETE' })).status).toBe(409);
    await action(a,{ action:'COMPLETE',payoutReference:'RECEIPT-ONE' });
    expect((await action(b,{ action:'COMPLETE',payoutReference:'receipt-one' })).status).toBe(409);
    expect((await prisma.returnCase.findUniqueOrThrow({ where:{id:b} })).status).toBe('APPROVED');
    expect(await prisma.returnCaseEvent.count({ where:{caseId:b,action:'COMPLETE'} })).toBe(0);
  });
  it('releases approved commitments on rejection while retaining immutable action history', async () => {
    const order = await delivered(); const id = await approved(order.id);
    expect((await action(id,{action:'REJECT'})).status).toBe(200);
    expect((await action(id,{action:'APPROVE',approvedAmountPaise:10000})).status).toBe(409);
    expect((await admin.get(`${base}/order/${order.id}`)).body.data.summary.remainingRefundablePaise).toBe(order.grandTotalPaise);
    expect((await create(draft(order.id))).status).toBe(201);
  });
  it('reconciles by collection and payout IST dates independently of order date', async () => {
    const order = await delivered(); const id = await approved(order.id);
    await action(id,{action:'COMPLETE',payoutReference:'DATE-TEST'});
    await prisma.order.update({where:{id:order.id},data:{paymentCollectedAt:new Date('2026-10-12T18:29:59.000Z')}});
    await prisma.returnCase.update({where:{id},data:{completedAt:new Date('2026-10-12T18:30:00.000Z')}});
    const previous = (await admin.get(`${base}/reconciliation?from=2026-10-12&to=2026-10-12`)).body.data;
    const today = (await admin.get(`${base}/reconciliation?from=2026-10-13&to=2026-10-13`)).body.data;
    expect(previous).toMatchObject({collectedPaise:order.grandTotalPaise,refundedPaise:0});
    expect(today).toMatchObject({collectedPaise:0,refundedPaise:10000,netCashMovementPaise:-10000});
    expect((await admin.get(`${base}/reconciliation?from=2026-10-14&to=2026-10-13`)).status).toBe(400);
  });
});

describe('physical returns and explicit audited restocking', () => {
  async function returning(kind='RETURN_REFUND',collected=true) {
    const order = await delivered(collected);
    const id = await approved(order.id,kind==='RETURN_ONLY'?0:10000,{kind,items:[{orderItemId:order.item.id,quantity:2}]});
    const item = await prisma.returnCaseItem.findFirstOrThrow({where:{caseId:id}});
    return {order,id,item};
  }
  it('never changes stock on request, approval or inspection, and requires receipt before completion', async () => {
    const {id,item} = await returning();
    const stock = await getStock(fixtures.products.notebook.id);
    expect(stock).toEqual({stockQuantity:8,reservedQuantity:0});
    expect((await action(id,{action:'RESTOCK',itemId:item.id})).status).toBe(409);
    expect((await action(id,{action:'COMPLETE',payoutReference:'TOO-SOON'})).status).toBe(409);
    const received = await action(id,{action:'RECEIVE',items:[{itemId:item.id,receivedQuantity:2,sellableQuantity:1,conditionNote:'One good; one broken and quarantined'}]});
    expect(received.status).toBe(200);
    expect(await getStock(fixtures.products.notebook.id)).toEqual(stock);
    expect((await action(id,{action:'REJECT'})).status).toBe(409);
    expect((await action(id,{action:'COMPLETE',payoutReference:'AFTER-INSPECTION'})).status).toBe(200);
    expect(await getStock(fixtures.products.notebook.id)).toEqual(stock);
  });
  it('restocks only inspected sellable units once with linked order/admin audit', async () => {
    const {order,id,item} = await returning();
    await action(id,{action:'RECEIVE',items:[{itemId:item.id,receivedQuantity:2,sellableQuantity:1,conditionNote:'One unit still sealed'}]});
    const input = {requestId:randomUUID(),action:'RESTOCK',itemId:item.id};
    expect((await Promise.all([action(id,input),action(id,input)])).map(r=>r.status)).toEqual([200,200]);
    expect(await getStock(fixtures.products.notebook.id)).toEqual({stockQuantity:9,reservedQuantity:0});
    expect((await action(id,{action:'RESTOCK',itemId:item.id})).status).toBe(409);
    const movements=await prisma.inventoryTransaction.findMany({where:{orderId:order.id,type:'ADJUSTMENT'}});
    expect(movements).toHaveLength(1); expect(movements[0]).toMatchObject({quantity:1,productId:fixtures.products.notebook.id});
    expect(movements[0]?.adminUserId).toBeTruthy(); expect(movements[0]?.note).toContain(id);
  });
  it('rejects forged receipt quantities, unrelated items, duplicate inspections and non-sellable restock', async () => {
    const {id,item}=await returning();
    for(const line of [ {itemId:'forged',receivedQuantity:2,sellableQuantity:1,conditionNote:'Checked'}, {itemId:item.id,receivedQuantity:1,sellableQuantity:1,conditionNote:'Checked'}, {itemId:item.id,receivedQuantity:2,sellableQuantity:3,conditionNote:'Checked'} ]) {
      expect((await action(id,{action:'RECEIVE',items:[line]})).status).toBe(409);
    }
    const inspection={action:'RECEIVE',items:[{itemId:item.id,receivedQuantity:2,sellableQuantity:0,conditionNote:'Both damaged, do not sell'}]};
    expect((await action(id,inspection)).status).toBe(200);
    expect((await action(id,inspection)).status).toBe(409);
    expect((await action(id,{action:'RESTOCK',itemId:item.id})).status).toBe(409);
  });
  it('completes return-only without cash collection or payout, and prevents returning the same units again', async () => {
    const {order,id,item}=await returning('RETURN_ONLY',false);
    await action(id,{action:'RECEIVE',items:[{itemId:item.id,receivedQuantity:2,sellableQuantity:0,conditionNote:'Defective units retained'}]});
    expect((await action(id,{action:'COMPLETE',payoutReference:'NOT-A-PAYOUT'})).status).toBe(409);
    expect((await action(id,{action:'COMPLETE'})).status).toBe(200);
    expect((await create(draft(order.id,0,{kind:'RETURN_ONLY',items:[{orderItemId:order.item.id,quantity:1}]}))).status).toBe(422);
    expect((await admin.get(`${base}/order/${order.id}`)).body.data.summary.completedRefundPaise).toBe(0);
  });
  it('rolls stock and audit back on an unsafe inventory increase', async () => {
    const {id,item}=await returning();
    await action(id,{action:'RECEIVE',items:[{itemId:item.id,receivedQuantity:2,sellableQuantity:2,conditionNote:'Both sellable'}]});
    await prisma.product.update({where:{id:fixtures.products.notebook.id},data:{stockQuantity:2147483647}});
    expect((await action(id,{action:'RESTOCK',itemId:item.id})).status).toBe(409);
    expect((await prisma.returnCaseItem.findUniqueOrThrow({where:{id:item.id}})).restockedAt).toBeNull();
    expect(await prisma.returnCaseEvent.count({where:{caseId:id,action:'RESTOCK'}})).toBe(0);
  });
  it('supports searchable paginated admin records without changing existing cancellation rules', async () => {
    const order=await delivered(); const id=await approved(order.id);
    expect((await admin.get(`${base}?search=${order.orderNumber}&status=APPROVED&limit=1`)).body.data.pagination.total).toBe(1);
    expect((await admin.get(`${base}?page=2&limit=1`)).body.data.items).toEqual([]);
    expect((await admin.get(`${base}/${id}`)).status).toBe(200);
    expect((await admin.patch(`/api/v1/admin/orders/${order.id}/status`).send({status:'CANCELLED'})).status).toBe(409);
    expect((await admin.patch(`/api/v1/admin/orders/${order.id}/payment`).send({paymentStatus:'REFUNDED'})).status).toBe(409);
  });
});
