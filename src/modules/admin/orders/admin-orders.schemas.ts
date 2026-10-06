import { z } from 'zod';

import { OrderStatus, PaymentStatus } from '../../../generated/prisma/client.js';
import { paginationQuery, searchText, shopDay } from '../../../lib/pagination.js';

/** Optional free text: blank becomes null so the database never stores empty strings. */
export const optionalNote = z
  .string()
  .trim()
  .max(500)
  .nullish()
  .transform((value) => (value ? value : null));

export const listOrdersQuerySchema = z
  .object({
    ...paginationQuery,
    status: z.enum(OrderStatus).optional(),
    paymentStatus: z.enum(PaymentStatus).optional(),
    /** Order number, customer name or phone. */
    search: searchText,
    /** First and last shop day (IST), YYYY-MM-DD, both inclusive. */
    from: shopDay.optional(),
    to: shopDay.optional(),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '"from" must not be after "to"',
    path: ['from'],
  });

export type ListOrdersQuery = z.infer<typeof listOrdersQuerySchema>;

export const changeOrderStatusBodySchema = z.strictObject({
  status: z.enum(OrderStatus),
  note: optionalNote,
});

export const recordPaymentBodySchema = z.strictObject({
  paymentStatus: z.enum(PaymentStatus),
  note: optionalNote,
});
