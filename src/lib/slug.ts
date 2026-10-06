import { z } from 'zod';

/** URL-safe slug: lower-case letters and digits separated by single dashes. */
export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lower-case letters, digits and single dashes');

/** "Gift Items & Toys!" -> "gift-items-toys". Empty if the text has no letters or digits. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
}
