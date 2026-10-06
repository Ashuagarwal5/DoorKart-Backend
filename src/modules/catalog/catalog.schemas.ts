import { z } from 'zod';

const MAX_PAGE_SIZE = 50;

/** Query-string booleans: only the literal strings "true" and "false" are accepted. */
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

export const listProductsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
  /** Category slug. */
  category: z.string().trim().min(1).max(100).optional(),
  featured: booleanFlag.optional(),
  new: booleanFlag.optional(),
  search: z
    .string()
    .trim()
    .max(100)
    .transform((value) => value.replace(/\s+/g, ' '))
    .optional(),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productIdentifierParamsSchema = z.object({
  identifier: z.string().trim().min(1).max(200),
});
