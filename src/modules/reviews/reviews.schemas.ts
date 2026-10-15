import { z } from 'zod';
import { paginationQuery, searchText, booleanFlag } from '../../lib/pagination.js';

export const reviewBody = z.strictObject({ rating: z.number().int().min(1).max(5), title: z.string().trim().min(1).max(120), content: z.string().trim().min(1).max(10000) });
export const productParams = z.strictObject({ productId: z.string().trim().min(1).max(100) });
export const publicQuery = z.strictObject({ ...paginationQuery, limit: paginationQuery.limit.default(10), sort: z.enum(['recent', 'highest', 'lowest']).default('recent') });
export const ownQuery = z.strictObject(paginationQuery);
export const adminQuery = z.strictObject({ ...paginationQuery, search: searchText, productId: z.string().min(1).max(100).optional(), status: z.enum(['PENDING', 'PUBLISHED', 'REJECTED', 'HIDDEN']).optional(), origin: z.enum(['CUSTOMER', 'ADMIN_ENTERED', 'IMPORTED']).optional(), verified: booleanFlag.optional(), deleted: booleanFlag.optional() });
export const manualBody = reviewBody.extend({ productId: z.string().trim().min(1).max(100), origin: z.enum(['ADMIN_ENTERED', 'IMPORTED']), sourceLabel: z.string().trim().min(2).max(200) });
export const moderationBody = z.strictObject({ action: z.enum(['approve', 'reject', 'hide', 'restore']), note: z.string().trim().max(500).optional() });
export type ReviewInput = z.infer<typeof reviewBody>;
export type PublicQuery = z.infer<typeof publicQuery>;
export type AdminQuery = z.infer<typeof adminQuery>;
