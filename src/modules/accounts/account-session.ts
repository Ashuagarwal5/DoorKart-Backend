import { createHash, randomBytes } from 'node:crypto';

import type { Request } from 'express';

import { prisma } from '../../lib/prisma.js';

/** A customer stays signed in on a phone for this long. Signing out or deleting the account ends it sooner. */
export const ACCOUNT_SESSION_DAYS = 30;

export type AccountContext = { id: string; email: string; fullName: string | null; sessionId: string };

/** What the app is told about the signed-in customer. */
export type AccountProfile = { id: string; email: string; fullName: string | null };

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new session. The token goes to the phone once; only its hash is stored. */
export async function createAccountSession(accountId: string, now: Date) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ACCOUNT_SESSION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.accountSession.create({ data: { accountId, tokenHash: hashToken(token), expiresAt } });
  // Old sessions are swept as new ones are made, so the table cannot grow without limit.
  await prisma.accountSession.deleteMany({ where: { expiresAt: { lt: now } } });
  return { token, expiresAt };
}

export async function findAccountBySession(token: string, now: Date): Promise<AccountContext | null> {
  const session = await prisma.accountSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: true },
  });
  if (!session || session.expiresAt <= now) {
    return null;
  }
  return {
    id: session.account.id,
    email: session.account.email,
    fullName: session.account.fullName,
    sessionId: session.id,
  };
}

/** The bearer token of a request, or null. */
export function readBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) {
    return null;
  }
  const [scheme, token] = header.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : null;
}

export function toProfile(account: { id: string; email: string; fullName: string | null }): AccountProfile {
  return { id: account.id, email: account.email, fullName: account.fullName };
}
