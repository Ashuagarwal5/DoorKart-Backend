import { z } from 'zod';

import { normalizeIndianMobile } from '../../lib/mobile.js';

export const MAX_ACCOUNT_ADDRESSES = 10;

const optionalText = (maximum: number) => z.string().trim().max(maximum).nullish()
  .transform((value) => value || null);

/** Account ownership is always supplied by the session, never by an address body. */
export const accountAddressBodySchema = z.strictObject({
  label: z.enum(['Home', 'Work', 'Other']),
  isDefault: z.boolean(),
  fullName: z.string().trim().min(2).max(100),
  phone: z.string().max(30).transform((value, context) => {
    const normalized = normalizeIndianMobile(value);
    if (normalized === null) {
      context.addIssue({ code: 'custom', message: 'Enter a valid 10-digit Indian mobile number' });
      return z.NEVER;
    }
    return normalized;
  }),
  addressLine1: z.string().trim().min(1).max(200),
  addressLine2: optionalText(200),
  landmark: optionalText(200),
  city: z.string().trim().min(1).max(100),
  pincode: z.string().trim().regex(/^[1-9]\d{5}$/, 'Pincode must be 6 digits'),
  deliveryAreaId: z.string().trim().min(1).max(100).nullish().transform((value) => value ?? null),
});

export const accountAddressParamsSchema = z.strictObject({
  id: z.string().trim().min(1).max(100),
});

export type AccountAddressInput = z.infer<typeof accountAddressBodySchema>;
