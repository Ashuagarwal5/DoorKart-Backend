import { z } from 'zod';

import { slugSchema } from '../../../lib/slug.js';

const nullableText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((value) => (value ? value : null));

const categoryFields = {
  name: z.string().trim().min(1).max(100),
  slug: slugSchema,
  description: nullableText(500),
  imageUrl: z
    .url({ protocol: /^https?$/ })
    .max(2000)
    .nullish()
    .transform((value) => value ?? null),
  displayOrder: z.number().int().min(0).max(100_000),
  isActive: z.boolean(),
};

export const createCategoryBodySchema = z.strictObject({
  name: categoryFields.name,
  // Left out, it is derived from the name.
  slug: categoryFields.slug.optional(),
  description: categoryFields.description,
  imageUrl: categoryFields.imageUrl,
  displayOrder: categoryFields.displayOrder.default(0),
  isActive: categoryFields.isActive.default(true),
});

export const updateCategoryBodySchema = z
  .strictObject({
    name: categoryFields.name,
    slug: categoryFields.slug,
    description: categoryFields.description,
    imageUrl: categoryFields.imageUrl,
    displayOrder: categoryFields.displayOrder,
    isActive: categoryFields.isActive,
  })
  .partial()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one field to change' });

export type CreateCategoryBody = z.infer<typeof createCategoryBodySchema>;
export type UpdateCategoryBody = z.infer<typeof updateCategoryBodySchema>;
