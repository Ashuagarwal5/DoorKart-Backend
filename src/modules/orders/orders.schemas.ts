import { z } from 'zod';

import { normalizeIndianMobile } from '../../lib/mobile.js';

const MAX_LINES_PER_ORDER = 50;
const MAX_QUANTITY_PER_LINE = 999;

const mobileSchema = z.string().transform((value, context) => {
  const normalized = normalizeIndianMobile(value);
  if (normalized === null) {
    context.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
    return z.NEVER;
  }
  return normalized;
});

/** Optional free text: blank becomes null so the database never stores empty strings. */
const optionalText = (maxLength: number) =>
  z
    .string()
    .trim()
    .max(maxLength)
    .nullish()
    .transform((value) => (value ? value : null));

/**
 * Every object is strict: unknown keys are rejected. That is what stops a client from
 * sending its own prices, totals or delivery charge. Those are only ever computed here,
 * from database values.
 */
export const createOrderBodySchema = z.strictObject({
  clientRequestId: z
    .string()
    .trim()
    .min(8)
    .max(100)
    .regex(/^[A-Za-z0-9._:-]+$/, 'Use only letters, digits, dot, underscore, colon and dash'),
  customer: z.strictObject({
    fullName: z.string().trim().min(2).max(100),
    mobile: mobileSchema,
  }),
  address: z.strictObject({
    addressLine1: z.string().trim().min(1).max(200),
    addressLine2: optionalText(200),
    landmark: optionalText(200),
    city: z.string().trim().min(1).max(100),
    pincode: z
      .string()
      .trim()
      .regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits'),
  }),
  deliveryAreaId: z.string().trim().min(1).max(100),
  items: z
    .array(
      z.strictObject({
        productId: z.string().trim().min(1).max(100),
        quantity: z.number().int().min(1).max(MAX_QUANTITY_PER_LINE),
      })
    )
    .min(1, 'The cart is empty')
    .max(MAX_LINES_PER_ORDER)
    .refine(
      (items) => new Set(items.map((item) => item.productId)).size === items.length,
      'Each product may appear only once'
    ),
  paymentMethod: z.enum(['COD']),
});

export type CreateOrderInput = z.infer<typeof createOrderBodySchema>;

export const orderNumberParamsSchema = z.object({
  orderNumber: z
    .string()
    .trim()
    .regex(/^BN-\d{8}-\d{4,}$/, 'Not a valid order number'),
});

/** The tracking token travels in a header so it never ends up in URLs or access logs. */
export const TRACKING_TOKEN_HEADER = 'x-tracking-token';

export const trackingTokenSchema = z.string().min(1).max(200);
