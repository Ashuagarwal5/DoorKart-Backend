import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import { conflict, notFound, unprocessable } from '../../../lib/errors.js';
import { prisma, type TransactionClient } from '../../../lib/prisma.js';
import { pageArgs, pageResult } from '../../../lib/pagination.js';
import { shopDateRange } from '../../../lib/time.js';
import type { AdminContext } from '../auth/session.js';
import { emitReturnEvents } from '../../notifications/emitters.js';
import { EVENT_KEYS } from '../../notifications/events.js';
import type { CreateReturnInput, ReturnActionInput, ReturnListQuery } from './returns.schemas.js';

const orderSelect = { id: true, orderNumber: true, customerName: true, grandTotalPaise: true, orderStatus: true, paymentStatus: true, paymentMethod: true, deliveredAt: true, paymentCollectedAt: true } satisfies Prisma.OrderSelect;
const include = { order: { select: orderSelect }, items: { include: { components: true, orderItem: { select: { productId: true, productName: true, sku: true, packLabel: true, quantity: true, unitPricePaise: true } } }, orderBy: { id: 'asc' } }, events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } satisfies Prisma.ReturnCaseInclude;
type Case = Prisma.ReturnCaseGetPayload<{ include: typeof include }>;
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fail = (message: string) => conflict('RETURN_CONFLICT', message);
function dto(row: Case) {
  // Request fingerprints and retry keys are internal; audit identity is a durable snapshot.
  return {
    id: row.id, orderId: row.orderId, kind: row.kind, status: row.status, reason: row.reason,
    requestedAmountPaise: row.requestedAmountPaise, approvedAmountPaise: row.approvedAmountPaise,
    payoutReference: row.payoutReference, createdAt: row.createdAt, updatedAt: row.updatedAt,
    approvedAt: row.approvedAt, rejectedAt: row.rejectedAt, receivedAt: row.receivedAt, completedAt: row.completedAt,
    order: row.order, items: row.items,
    events: row.events.map(event => ({ id: event.id, caseId: event.caseId, action: event.action,
      adminId: event.adminId, adminName: event.adminName, note: event.note, details: event.details, createdAt: event.createdAt })),
  };
}
async function lockOrder(tx: TransactionClient, id: string) {
  await tx.$queryRaw`SELECT "id" FROM "Order" WHERE "id" = ${id} FOR UPDATE`;
  const order = await tx.order.findUnique({ where: { id }, select: orderSelect });
  if (!order) throw notFound('ORDER_NOT_FOUND', 'This order does not exist.');
  if (order.orderStatus !== 'DELIVERED' || !order.deliveredAt || order.paymentMethod !== 'COD') throw unprocessable('RETURN_NOT_ALLOWED', 'Only delivered COD orders are eligible.');
  return order;
}
async function moneySummary(tx: TransactionClient, order: Prisma.OrderGetPayload<{ select: typeof orderSelect }>) {
  const totals = await tx.returnCase.groupBy({ by: ['status'], where: { orderId: order.id, status: { in: ['APPROVED','COMPLETED'] } }, _sum: { approvedAmountPaise: true } });
  const completedRefundPaise = totals.find(t => t.status === 'COMPLETED')?._sum.approvedAmountPaise ?? 0;
  const approvedAwaitingPaise = totals.find(t => t.status === 'APPROVED')?._sum.approvedAmountPaise ?? 0;
  const collectedPaise = order.paymentStatus === 'COLLECTED' && order.paymentCollectedAt ? order.grandTotalPaise : 0;
  return { collectedPaise, completedRefundPaise, approvedAwaitingPaise, remainingRefundablePaise: Math.max(0, collectedPaise - completedRefundPaise - approvedAwaitingPaise), netCashRetainedPaise: collectedPaise - completedRefundPaise };
}
async function audit(tx: TransactionClient, caseId: string, requestId: string, hash: string, action: string, note: string, admin: AdminContext, details: Prisma.InputJsonObject) {
  const event = await tx.returnCaseEvent.create({ data: { caseId, requestId, requestFingerprint: hash, action, note, adminId: admin.id, adminName: admin.name, details } });
  return event.id;
}
function translateConflict(error: unknown): never {
  if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') throw fail('This request, open case or payout reference already exists. Refresh before retrying.');
  throw error;
}

export async function createReturn(input: CreateReturnInput, admin: AdminContext) {
  const items = [...input.items].sort((a,b) => a.orderItemId.localeCompare(b.orderItemId));
  const hash = fingerprint({ ...input, items });
  try {
    return await prisma.$transaction(async tx => {
      const order = await lockOrder(tx, input.orderId);
      const prior = await tx.returnCase.findUnique({ where: { clientRequestId: input.clientRequestId }, include });
      if (prior) {
        if (prior.requestFingerprint !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'This retry key was already used for a different return request.');
        return dto(prior);
      }
      if (await tx.returnCase.findFirst({ where: { orderId: order.id, status: { in: ['REQUESTED','APPROVED'] } }, select: { id: true } })) throw fail('Finish or reject the existing open case before recording another.');
      const summary = await moneySummary(tx, order);
      // An unpaid delivered order may have a request, but approval/payment require collection.
      if (input.requestedAmountPaise > order.grandTotalPaise - summary.completedRefundPaise) throw unprocessable('REFUND_LIMIT_EXCEEDED', 'The requested refund exceeds the remaining order value.');
      const purchased = await tx.orderItem.findMany({ where: { orderId: order.id }, include: { components: true } });
      for (const item of items) {
        const line = purchased.find(p => p.id === item.orderItemId);
        if (!line) throw unprocessable('RETURN_NOT_ALLOWED', 'Return items must belong to this order.');
        const used = await tx.returnCaseItem.aggregate({ where: { orderItemId: line.id, case: { status: { not: 'REJECTED' } } }, _sum: { quantity: true } });
        if (item.quantity + (used._sum.quantity ?? 0) > line.quantity) throw unprocessable('RETURN_NOT_ALLOWED', 'Return quantities exceed the purchased quantity remaining after previous returns.');
      }
      const row = await tx.returnCase.create({ data: { orderId: order.id, clientRequestId: input.clientRequestId, requestFingerprint: hash, kind: input.kind, reason: input.reason, requestedAmountPaise: input.requestedAmountPaise, items: { create: items.map(item => {
        const line=purchased.find(p => p.id===item.orderItemId)!;
        const components=line.components.length ? line.components : [{productId:line.productId,productName:line.productName,unitsPerPack:1}];
        return {...item,components:{create:components.map(c => ({productId:c.productId,productName:c.productName,quantity:c.unitsPerPack*item.quantity}))}};
      }) } } });
      const auditId = await audit(tx, row.id, input.clientRequestId, hash, 'REQUEST', input.reason, admin, { requestedAmountPaise: input.requestedAmountPaise, kind: input.kind });
      await emitReturnEvents(tx, order.id, auditId, [EVENT_KEYS.RETURN_REQUESTED], {
        caseId: row.id, status: 'REQUESTED', amountPaise: input.requestedAmountPaise, reference: null,
      });
      return dto(await tx.returnCase.findUniqueOrThrow({ where: { id: row.id }, include }));
    });
  } catch (error) { return translateConflict(error); }
}

export async function actOnReturn(id: string, input: ReturnActionInput, admin: AdminContext) {
  const normalized = input.action === 'RECEIVE' ? { ...input, items: [...input.items].sort((a,b) => a.itemId.localeCompare(b.itemId)) } : input;
  const hash = fingerprint(normalized);
  try {
    return await prisma.$transaction(async tx => {
      const ref = await tx.returnCase.findUnique({ where: { id }, select: { orderId: true } });
      if (!ref) throw notFound('RETURN_NOT_FOUND', 'This return/refund case does not exist.');
      // All case mutations serialize on the order, then touch case/items/products in that order.
      const order = await lockOrder(tx, ref.orderId);
      const row = await tx.returnCase.findUniqueOrThrow({ where: { id }, include });
      const prior = await tx.returnCaseEvent.findUnique({ where: { caseId_requestId: { caseId: id, requestId: input.requestId } } });
      if (prior) {
        if (prior.requestFingerprint !== hash) throw conflict('IDEMPOTENCY_CONFLICT', 'This action key was used for different details.');
        return dto(row);
      }
      const now = new Date();
      let details: Prisma.InputJsonObject = {};
      switch (input.action) {
        case 'APPROVE': {
          if (row.status !== 'REQUESTED') throw fail('Only a requested case can be approved.');
          if (input.approvedAmountPaise > row.requestedAmountPaise || ((row.kind === 'RETURN_ONLY') !== (input.approvedAmountPaise === 0))) throw unprocessable('REFUND_LIMIT_EXCEEDED', 'Approved amount must match the case type and cannot exceed the request.');
          const summary = await moneySummary(tx, order);
          if (input.approvedAmountPaise > summary.remainingRefundablePaise) throw unprocessable('REFUND_LIMIT_EXCEEDED', 'Record cash collection first. Approved and completed refunds cannot exceed collected cash.');
          await tx.returnCase.update({ where: { id }, data: { status: 'APPROVED', approvedAmountPaise: input.approvedAmountPaise, approvedAt: now } });
          details = { approvedAmountPaise: input.approvedAmountPaise }; break;
        }
        case 'REJECT':
          if (!['REQUESTED','APPROVED'].includes(row.status) || row.receivedAt) throw fail('Only an open case without received goods can be rejected.');
          await tx.returnCase.update({ where: { id }, data: { status: 'REJECTED', rejectedAt: now } }); break;
        case 'RECEIVE': {
          if (row.status !== 'APPROVED' || row.kind === 'REFUND_ONLY' || row.receivedAt) throw fail('Only an approved return awaiting receipt can be inspected.');
          if (input.items.length !== row.items.length || new Set(input.items.map(i=>i.itemId)).size !== input.items.length) throw fail('Inspect every listed return item exactly once.');
          for (const item of input.items) {
            const line = row.items.find(i => i.id === item.itemId);
            if (!line || item.receivedQuantity !== line.quantity || item.sellableQuantity > item.receivedQuantity) throw fail('Confirm the listed quantities were physically received; sellable units cannot exceed received units.');
            let sellablePacks=item.sellableQuantity;
            if (line.components.length) {
              const single = line.components.length === 1 && line.components[0]!.quantity === line.quantity;
              if (!item.components && !single) throw fail('Inspect each physical component of the complete returned packs.');
              const inspection = item.components ?? [{componentId:line.components[0]!.id,sellableQuantity:item.sellableQuantity,conditionNote:item.conditionNote}];
              if (inspection.length !== line.components.length || new Set(inspection.map(c=>c.componentId)).size !== inspection.length) throw fail('Inspect every component exactly once.');
              sellablePacks=line.quantity;
              for (const component of inspection) {
                const stored=line.components.find(c=>c.id===component.componentId);
                if (!stored || component.sellableQuantity > stored.quantity) throw fail('Sellable units cannot exceed physically returned units.');
                sellablePacks=Math.min(sellablePacks,Math.floor(component.sellableQuantity/(stored.quantity/line.quantity)));
                await tx.returnCaseItemComponent.update({where:{id:stored.id},data:{sellableQuantity:component.sellableQuantity,conditionNote:component.conditionNote}});
              }
            }
            await tx.returnCaseItem.update({ where: { id: line.id }, data: { receivedQuantity: item.receivedQuantity, sellableQuantity: sellablePacks, componentInspection: line.components.length > 0, conditionNote: item.conditionNote } });
          }
          await tx.returnCase.update({ where: { id }, data: { receivedAt: now } });
          details = { items: input.items }; break;
        }
        case 'RESTOCK': {
          if (!['APPROVED','COMPLETED'].includes(row.status) || !row.receivedAt) throw fail('Inspect received goods before restocking.');
          const item = row.items.find(i => i.id === input.itemId);
          if (!item || item.restockedAt) throw fail('This item has already been restocked or is not eligible.');
          const lines = item.components.length ? item.components.filter(c=>c.sellableQuantity>0).map(c=>({productId:c.productId,quantity:c.sellableQuantity})) : [{productId:item.orderItem.productId,quantity:item.sellableQuantity}].filter(c=>c.quantity>0);
          if (!lines.length) throw fail('No inspected sellable units are eligible for restocking.');
          const movements: string[] = [];
          for (const line of lines.sort((a,b)=>a.productId.localeCompare(b.productId))) {
            const changed=await tx.$executeRaw`UPDATE "Product" SET "stockQuantity" = "stockQuantity" + ${line.quantity}::int, "updatedAt" = NOW() WHERE "id" = ${line.productId} AND "kind" = 'STANDARD' AND "stockQuantity"::bigint + ${line.quantity}::bigint <= 2147483647`;
            if(changed !== 1) throw fail('Stock could not be safely increased.');
            const movement=await tx.inventoryTransaction.create({data:{productId:line.productId,orderId:order.id,type:'ADJUSTMENT',quantity:line.quantity,adminUserId:admin.id,note:`Return ${id}, item ${item.id}: ${input.note}`}});
            movements.push(movement.id);
          }
          await tx.returnCaseItem.update({where:{id:item.id},data:{restockedAt:now}});
          details={itemId:item.id,components:lines,inventoryTransactionIds:movements}; break;
        }
        case 'COMPLETE': {
          if (row.status !== 'APPROVED') throw fail('Only an approved case can be completed. Never pay again after completion.');
          if (row.kind !== 'REFUND_ONLY' && !row.receivedAt) throw fail('Record receipt and inspection of all listed goods before completing this case.');
          const amount = row.approvedAmountPaise ?? 0;
          if ((amount > 0) !== Boolean(input.payoutReference)) throw fail('Cash refunds require a unique receipt/reference. Return-only cases must not record a payout.');
          const summary = await moneySummary(tx, order);
          if (amount > 0 && (summary.collectedPaise === 0 || summary.completedRefundPaise + summary.approvedAwaitingPaise > summary.collectedPaise)) throw unprocessable('REFUND_LIMIT_EXCEEDED', 'Refund exceeds eligible collected cash.');
          await tx.returnCase.update({ where: { id }, data: { status: 'COMPLETED', completedAt: now, payoutReference: input.payoutReference ?? null } });
          details = { paidAmountPaise: amount, payoutReference: input.payoutReference ?? null, method: amount > 0 ? 'CASH' : 'NONE' }; break;
        }
      }
      const auditId = await audit(tx, id, input.requestId, hash, input.action, input.note, admin, details);
      if (input.action === 'APPROVE') {
        await emitReturnEvents(tx, order.id, auditId, [EVENT_KEYS.RETURN_APPROVED], {
          caseId: id, status: 'APPROVED', amountPaise: input.approvedAmountPaise, reference: null,
        });
      } else if (input.action === 'REJECT') {
        await emitReturnEvents(tx, order.id, auditId, [EVENT_KEYS.RETURN_REJECTED], {
          caseId: id, status: 'REJECTED', amountPaise: row.requestedAmountPaise, reference: null,
        });
      } else if (input.action === 'COMPLETE') {
        const paid = row.approvedAmountPaise ?? 0;
        // A cash refund also announces the refund itself; a return with no payout does not.
        await emitReturnEvents(
          tx,
          order.id,
          auditId,
          paid > 0 ? [EVENT_KEYS.RETURN_COMPLETED, EVENT_KEYS.REFUND_COMPLETED] : [EVENT_KEYS.RETURN_COMPLETED],
          { caseId: id, status: 'COMPLETED', amountPaise: paid, reference: input.payoutReference ?? null }
        );
      }
      return dto(await tx.returnCase.findUniqueOrThrow({ where: { id }, include }));
    });
  } catch (error) { return translateConflict(error); }
}

export async function getReturn(id: string) {
  const row = await prisma.returnCase.findUnique({ where: { id }, include });
  if (!row) throw notFound('RETURN_NOT_FOUND', 'This return/refund case does not exist.');
  return dto(row);
}
export async function listReturns(query: ReturnListQuery) {
  const where: Prisma.ReturnCaseWhereInput = { ...(query.status ? { status: query.status } : {}), ...(query.kind ? { kind: query.kind } : {}), ...(query.search ? { OR: [{ reason: { contains: query.search, mode: 'insensitive' } }, { order: { orderNumber: { contains: query.search, mode: 'insensitive' } } }, { order: { customerName: { contains: query.search, mode: 'insensitive' } } }, { payoutReference: { contains: query.search, mode: 'insensitive' } }] } : {}) };
  const [total, rows] = await prisma.$transaction([prisma.returnCase.count({ where }), prisma.returnCase.findMany({ where, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], ...pageArgs(query) })]);
  return pageResult(rows.map(dto), total, query);
}
export async function orderReturns(orderId: string) {
  return prisma.$transaction(async tx => {
    const order = await tx.order.findUnique({ where: { id: orderId }, select: { ...orderSelect, items: { select: { id: true, productName: true, packLabel: true, quantity: true, unitPricePaise: true, components: true } } } });
    if (!order) throw notFound('ORDER_NOT_FOUND', 'This order does not exist.');
    const cases = await tx.returnCase.findMany({ where: { orderId }, include, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
    return { order, summary: await moneySummary(tx, order), cases: cases.map(dto) };
  }, { isolationLevel: 'RepeatableRead' });
}
export async function reconciliation(from?: string, to?: string) {
  const { start, end } = shopDateRange(from, to);
  const range = { ...(start ? { gte: start } : {}), ...(end ? { lt: end } : {}) };
  return prisma.$transaction(async tx => {
    const cash = await tx.order.aggregate({ where: { paymentStatus: 'COLLECTED', paymentCollectedAt: { not: null, ...range } }, _sum: { grandTotalPaise: true } });
    const refunds = await tx.returnCase.aggregate({ where: { status: 'COMPLETED', completedAt: range }, _sum: { approvedAmountPaise: true }, _count: true });
    const pending = await tx.returnCase.aggregate({ where: { status: 'APPROVED' }, _sum: { approvedAmountPaise: true } });
    const collectedPaise = cash._sum.grandTotalPaise ?? 0;
    const refundedPaise = refunds._sum.approvedAmountPaise ?? 0;
    return { from: from ?? null, to: to ?? null, collectedPaise, refundedPaise, netCashMovementPaise: collectedPaise - refundedPaise, approvedAwaitingPaise: pending._sum.approvedAmountPaise ?? 0, completedCases: refunds._count };
  }, { isolationLevel: 'RepeatableRead' });
}
