import { z } from 'zod';

import { booleanFlag, paginationQuery, searchText } from '../../../lib/pagination.js';
import { slugSchema } from '../../../lib/slug.js';
import { STORED_FILE_NAME, UPLOAD_URL_PREFIX } from '../../media/media-types.js';

/** ₹10,00,000 in paise: a sanity ceiling that catches a stray extra zero, not a business limit. */
const MAX_PAISE = 100_000_000;
const MAX_UNITS = 1_000_000;

/** Integer paise, never a float and never negative. */
const paise = z.number().int().min(0).max(MAX_PAISE);

/** A full web address, or the path this server returned when a file was uploaded. */
const mediaUrl = z.union([
  z.url({ protocol: /^https?$/ }).max(2000),
  z
    .string()
    .startsWith(UPLOAD_URL_PREFIX)
    .refine((value) => STORED_FILE_NAME.test(value.slice(UPLOAD_URL_PREFIX.length)), 'Not an uploaded file'),
]);

const imageSchema = z.strictObject({
  url: mediaUrl,
  mediaType: z.enum(['IMAGE', 'VIDEO']).default('IMAGE'),
  altText: z
    .string()
    .trim()
    .max(200)
    .nullish()
    .transform((value) => (value ? value : null)),
});

const productFields = {
  name: z.string().trim().min(1).max(200),
  slug: slugSchema,
  description: z.string().trim().min(1).max(5000),
  categoryId: z.string().trim().min(1).max(100),
  sku: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9._-]+$/, 'Use only letters, digits, dot, underscore and dash'),
  mrpPaise: paise,
  sellingPricePaise: paise,
  lowStockThreshold: z.number().int().min(0).max(MAX_UNITS),
  isFeatured: z.boolean(),
  isNew: z.boolean(),
  isActive: z.boolean(),
  /** The full list of pictures and videos: on update it replaces the existing ones. The first picture is the main one. */
  images: z
    .array(imageSchema)
    .max(10)
    .refine((items) => items.filter((item) => item.mediaType === 'VIDEO').length <= 3, 'Add at most 3 videos'),
};

/** A selling price above the MRP is almost always a typo, so it is rejected. */
const sellingPriceWithinMrp = {
  message: 'The selling price cannot be higher than the MRP',
  path: ['sellingPricePaise'],
};

export const createProductBodySchema = z
  .strictObject({
    name: productFields.name,
    // Left out, it is derived from the name.
    slug: productFields.slug.optional(),
    description: productFields.description,
    categoryId: productFields.categoryId,
    sku: productFields.sku,
    mrpPaise: productFields.mrpPaise,
    sellingPricePaise: productFields.sellingPricePaise,
    // The opening stock. Later changes go through inventory adjustments, which are audited.
    stockQuantity: z.number().int().min(0).max(MAX_UNITS).default(0),
    lowStockThreshold: productFields.lowStockThreshold.default(5),
    isFeatured: productFields.isFeatured.default(false),
    isNew: productFields.isNew.default(false),
    isActive: productFields.isActive.default(true),
    images: productFields.images.default([]),
  })
  .refine((body) => body.sellingPricePaise <= body.mrpPaise, sellingPriceWithinMrp);

/**
 * Stock is deliberately absent: `stockQuantity` and `reservedQuantity` cannot be edited
 * here, and the schema is strict so sending them is an error, not silently ignored.
 */
export const updateProductBodySchema = z
  .strictObject({
    name: productFields.name,
    slug: productFields.slug,
    description: productFields.description,
    categoryId: productFields.categoryId,
    sku: productFields.sku,
    mrpPaise: productFields.mrpPaise,
    sellingPricePaise: productFields.sellingPricePaise,
    lowStockThreshold: productFields.lowStockThreshold,
    isFeatured: productFields.isFeatured,
    isNew: productFields.isNew,
    isActive: productFields.isActive,
    images: productFields.images,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' })
  .refine(
    (body) =>
      body.mrpPaise === undefined ||
      body.sellingPricePaise === undefined ||
      body.sellingPricePaise <= body.mrpPaise,
    sellingPriceWithinMrp
  );

export type CreateProductBody = z.infer<typeof createProductBodySchema>;
export type UpdateProductBody = z.infer<typeof updateProductBodySchema>;

export const listProductsQuerySchema = z.object({
  ...paginationQuery,
  /** Name or SKU. */
  search: searchText,
  categoryId: z.string().trim().min(1).max(100).optional(),
  isActive: booleanFlag.optional(),
  /** Only products whose available stock has reached their low-stock threshold. */
  lowStock: booleanFlag.optional(),
});

export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

export const inventoryAdjustmentBodySchema = z.strictObject({
  /** Positive adds stock (a delivery from the supplier), negative removes it (damage, loss). */
  quantityDelta: z
    .number()
    .int()
    .min(-MAX_UNITS)
    .max(MAX_UNITS)
    .refine((value) => value !== 0, 'The change cannot be zero'),
  /** Required: an adjustment with no reason is exactly what an audit trail exists to prevent. */
  note: z.string().trim().min(1, 'Say why the stock is changing').max(500),
});

export type InventoryAdjustmentBody = z.infer<typeof inventoryAdjustmentBodySchema>;
