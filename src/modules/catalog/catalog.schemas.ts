import { z } from 'zod';

const MAX_PAGE_SIZE = 50;

/** Query-string booleans: only the literal strings "true" and "false" are accepted. */
const booleanFlag = z.enum(['true', 'false']).transform((value) => value === 'true');

/** How the product list is ordered. Newest first is the default. */
export const PRODUCT_SORTS = ['newest', 'price_asc', 'price_desc', 'name_asc'] as const;

/** Prices are whole paise, like everywhere else. The ceiling catches a stray extra zero. */
const paise = z.coerce.number().int().min(0).max(100_000_000);

export const listProductsQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(20),
    /** Category slug. */
    category: z.string().trim().min(1).max(100).optional(),
    featured: booleanFlag.optional(),
    /**
     * Comma-separated product ids: fetches exactly those products (the app's wishlist uses it).
     * Inactive or unknown ids are simply left out of the answer.
     */
    ids: z
      .string()
      .trim()
      .max(5000)
      .transform((value) => [...new Set(value.split(',').map((id) => id.trim()).filter(Boolean))])
      .pipe(z.array(z.string().max(100)).min(1).max(MAX_PAGE_SIZE))
      .optional(),
    new: booleanFlag.optional(),
    search: z
      .string()
      .trim()
      .max(100)
      .transform((value) => value.replace(/\s+/g, ' '))
      .optional(),
    sort: z.enum(PRODUCT_SORTS).default('newest'),
    /** Selling price range in paise, both ends included. */
    minPrice: paise.optional(),
    maxPrice: paise.optional(),
    /** true: only products with units available to order right now. */
    inStock: booleanFlag.optional(),
  })
  .refine(
    (query) => query.minPrice === undefined || query.maxPrice === undefined || query.minPrice <= query.maxPrice,
    { message: 'The lowest price cannot be above the highest price', path: ['minPrice'] }
  );

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const productIdentifierParamsSchema = z.object({
  identifier: z.string().trim().min(1).max(200),
});
