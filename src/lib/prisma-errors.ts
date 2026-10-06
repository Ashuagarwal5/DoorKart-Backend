import { Prisma } from '../generated/prisma/client.js';

/**
 * True when `error` is a unique-constraint violation (Prisma code P2002) that mentions
 * `field`. Services pre-check uniqueness to give a friendly message; this catches the rare
 * race where two requests pass the check at once and the database refuses the second.
 *
 * With the pg driver adapter the constrained column is reported inside `meta`, in a shape
 * that has changed between Prisma versions, so the whole of `meta` is searched.
 */
export function isUniqueViolation(error: unknown, field: string): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  return JSON.stringify(error.meta ?? {})
    .toLowerCase()
    .includes(field.toLowerCase());
}
