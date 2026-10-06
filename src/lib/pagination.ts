import { z } from 'zod';

const MAX_PAGE_SIZE = 100;
const DEFAULT_PAGE_SIZE = 25;

/** `page` and `limit` for any paginated admin list. The limit is capped at 100. */
export const paginationQuery = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
};

export type PageParams = { page: number; limit: number };

export function pageArgs({ page, limit }: PageParams) {
  return { skip: (page - 1) * limit, take: limit };
}

export function pageResult<T>(items: T[], total: number, { page, limit }: PageParams) {
  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Free-text search box input: trimmed, whitespace collapsed, bounded, blank means none. */
export const searchText = z
  .string()
  .trim()
  .max(100)
  .transform((value) => value.replace(/\s+/g, ' '))
  .transform((value) => (value === '' ? undefined : value))
  .optional();

/** A shop calendar day as YYYY-MM-DD, validated as a real date. */
export const shopDay = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use the format YYYY-MM-DD')
  .refine((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
  }, 'Not a real date');

/** Query-string booleans: only the literal strings "true" and "false". */
export const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');
