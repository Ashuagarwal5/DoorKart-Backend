import { z } from 'zod';
import { paginationQuery, searchText, shopDay } from '../../../lib/pagination.js';

const id = z.string().trim().min(1).max(100);
const money = z.number().int().min(0).max(2147483647);
const note = z.string().trim().min(3).max(1000);
export const createReturnBody = z.strictObject({
  clientRequestId: z.uuid(), orderId: id, kind: z.enum(['RETURN_ONLY', 'REFUND_ONLY', 'RETURN_REFUND']),
  reason: note, requestedAmountPaise: money,
  items: z.array(z.strictObject({ orderItemId: id, quantity: z.number().int().min(1).max(10000) })).max(100),
}).superRefine((value, ctx) => {
  if ((value.kind === 'RETURN_ONLY') !== (value.requestedAmountPaise === 0)) ctx.addIssue({ code: 'custom', path: ['requestedAmountPaise'], message: 'Return-only requires zero; refunds require a positive amount.' });
  if ((value.kind === 'REFUND_ONLY') !== (value.items.length === 0)) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Returns require items; refund-only must not contain return items.' });
  if (new Set(value.items.map(i => i.orderItemId)).size !== value.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Each purchased item may appear once.' });
});
const common = { requestId: z.uuid(), note };
export const returnActionBody = z.discriminatedUnion('action', [
  z.strictObject({ ...common, action: z.literal('APPROVE'), approvedAmountPaise: money }),
  z.strictObject({ ...common, action: z.literal('REJECT') }),
  z.strictObject({ ...common, action: z.literal('RECEIVE'), items: z.array(z.strictObject({ itemId: id, receivedQuantity: z.number().int().min(1).max(10000), sellableQuantity: z.number().int().min(0).max(10000), conditionNote: note, components: z.array(z.strictObject({ componentId: id, sellableQuantity: z.number().int().min(0).max(2147483647), conditionNote: note })).min(1).max(30).optional() })).min(1).max(100) }),
  z.strictObject({ ...common, action: z.literal('RESTOCK'), itemId: id }),
  z.strictObject({ ...common, action: z.literal('COMPLETE'), payoutReference: z.string().trim().min(3).max(100).transform(s => s.toUpperCase()).optional() }),
]);
export const returnListQuery = z.strictObject({ ...paginationQuery, search: searchText, status: z.enum(['REQUESTED','APPROVED','REJECTED','COMPLETED']).optional(), kind: z.enum(['RETURN_ONLY','REFUND_ONLY','RETURN_REFUND']).optional() });
export const reconciliationQuery = z.strictObject({ from: shopDay.optional(), to: shopDay.optional() }).refine(q => !q.from || !q.to || q.from <= q.to, { message: 'Invalid date range' });
export type CreateReturnInput = z.infer<typeof createReturnBody>;
export type ReturnActionInput = z.infer<typeof returnActionBody>;
export type ReturnListQuery = z.infer<typeof returnListQuery>;
