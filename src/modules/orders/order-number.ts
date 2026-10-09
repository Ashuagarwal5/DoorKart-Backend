import { randomBytes, timingSafeEqual } from 'node:crypto';

import type { TransactionClient } from '../../lib/prisma.js';

const FIRST_DAILY_SEQUENCE = 1001;

/** Calendar day in India (the shop's timezone) as YYYYMMDD. */
export function getOrderDay(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

/**
 * Issues the next order number for today, e.g. DK-20261003-1001.
 *
 * The sequence lives in the database, not in memory: a single INSERT ... ON CONFLICT
 * statement locks today's counter row and increments it, so two concurrent orders can
 * never receive the same number, across any number of server processes. It runs inside
 * the order transaction; if the order fails, the increment rolls back with it.
 */
export async function issueOrderNumber(tx: TransactionClient, now: Date): Promise<string> {
  const day = getOrderDay(now);
  const rows = await tx.$queryRaw<{ lastSequence: number }[]>`
    INSERT INTO "OrderCounter" ("day", "lastSequence")
    VALUES (${day}, ${FIRST_DAILY_SEQUENCE})
    ON CONFLICT ("day") DO UPDATE SET "lastSequence" = "OrderCounter"."lastSequence" + 1
    RETURNING "lastSequence"
  `;

  const sequence = rows[0]?.lastSequence;
  if (sequence === undefined) {
    throw new Error('Could not issue an order number');
  }
  return `DK-${day}-${sequence}`;
}

/** 192 bits of randomness, URL-safe. Unguessable, unlike the sequential order number. */
export function generateTrackingToken(): string {
  return randomBytes(24).toString('base64url');
}

/** Constant-time comparison so response timing reveals nothing about the real token. */
export function isSameToken(provided: string, expected: string): boolean {
  const providedBytes = Buffer.from(provided);
  const expectedBytes = Buffer.from(expected);
  return providedBytes.length === expectedBytes.length && timingSafeEqual(providedBytes, expectedBytes);
}
