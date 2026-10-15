import { createHash, randomBytes } from 'node:crypto';

import type { Request } from 'express';

import { prisma, type TransactionClient } from '../../lib/prisma.js';

/** A customer stays signed in on a phone for this long. Signing out or deleting the account ends it sooner. */
export const ACCOUNT_SESSION_DAYS = 30;

export type AccountContext = AccountProfile & { sessionId: string };

/** What the app is told about the signed-in customer. */
export type AccountProfile = {
  id: string;
  email: string;
  fullName: string | null;
  mobile: string | null;
  emailVerified: boolean;
  mobileVerified: boolean;
  googleLinked: boolean;
  isActive: boolean;
};

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A new session. The token goes to the phone once; only its hash is stored. */
export async function createAccountSession(accountId: string, now: Date, database: TransactionClient = prisma) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + ACCOUNT_SESSION_DAYS * 24 * 60 * 60 * 1000);
  await database.accountSession.create({ data: { accountId, tokenHash: hashToken(token), expiresAt } });
  // Old sessions are swept as new ones are made, so the table cannot grow without limit.
  await database.accountSession.deleteMany({ where: { expiresAt: { lt: now } } });
  return { token, expiresAt };
}

export async function findAccountBySession(token: string, now: Date): Promise<AccountContext | null> {
  const session = await prisma.accountSession.findUnique({
    where: { tokenHash: hashToken(token) },
    include: { account: true },
  });
  if (!session || session.expiresAt <= now || !session.account.isActive || !session.account.emailVerifiedAt) {
    return null;
  }
  return {
    ...toProfile(session.account),
    sessionId: session.id,
  };
}

/** The bearer token of a request, or null. */
export function readBearerToken(req: Request): string | null {
  const header = req.get('authorization');
  if (!header) {
    return null;
  }
  // Reject extra fields, unsupported schemes and malformed session-token encodings.
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(header);
  return match?.[1] ?? null;
}

export function toProfile(account: {
  id: string; email: string; fullName: string | null; mobile: string | null;
  emailVerifiedAt: Date | null; mobileVerifiedAt: Date | null; googleSubject: string | null; isActive: boolean;
}): AccountProfile {
  return {
    id: account.id, email: account.email, fullName: account.fullName, mobile: account.mobile,
    emailVerified: account.emailVerifiedAt !== null,
    mobileVerified: account.mobileVerifiedAt !== null,
    googleLinked: account.googleSubject !== null,
    isActive: account.isActive,
  };
}
