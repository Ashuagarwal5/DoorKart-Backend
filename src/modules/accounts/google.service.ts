import { OAuth2Client } from 'google-auth-library';

import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { emitAccountRegistered } from '../notifications/emitters.js';
import { googleConfig, readSettings } from '../settings/settings.service.js';
import { lockAccountEmail } from './account-lock.js';
import { createAccountSession, toProfile } from './account-session.js';

export type GoogleIdentity = { subject: string; email: string; emailVerified: boolean; name: string | null };

/** Checks a Google ID token (signature, expiry, audience) and returns who it is for, or null. */
export type GoogleVerifier = (idToken: string, audiences: string[]) => Promise<GoogleIdentity | null>;

const client = new OAuth2Client();

const googleVerifier: GoogleVerifier = async (idToken, audiences) => {
  try {
    const ticket = await client.verifyIdToken({ idToken, audience: audiences });
    const payload = ticket.getPayload();
    if (!payload?.sub || !payload.email) {
      return null;
    }
    return {
      subject: payload.sub,
      email: payload.email,
      emailVerified: payload.email_verified === true,
      name: payload.name ?? null,
    };
  } catch {
    // A bad, expired or wrongly-addressed token. Nothing about why is passed on.
    return null;
  }
};

let verifier: GoogleVerifier = googleVerifier;

/** For tests: replace the check so no request goes to Google. Pass null to restore it. */
export function setGoogleVerifier(replacement: GoogleVerifier | null): void {
  verifier = replacement ?? googleVerifier;
}

const REFUSED = 'Google sign-in did not work. Please try again.';

/**
 * Signs a customer in from a Google ID token the app obtained. The token is checked here, on
 * the server, against the client IDs saved in Settings: the app's word is never trusted.
 */
async function verifiedIdentity(idToken: string): Promise<GoogleIdentity> {
  const config = googleConfig(await readSettings());
  if (!config.enabled) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign in with Google is not available right now.');
  }

  const identity = await verifier(idToken, config.clientIds);
  if (!identity || !identity.emailVerified) {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', REFUSED);
  }
  return { ...identity, email: identity.email.trim().toLowerCase() };
}

function linkRequired(): AppError {
  return new AppError(409, 'ACCOUNT_LINK_REQUIRED', 'Sign in to your existing account with an email code, then link Google from Account settings.');
}

export async function signInWithGoogle(idToken: string, now: Date) {
  const identity = await verifiedIdentity(idToken);
  const email = identity.email.trim().toLowerCase();

  return prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, `google:${identity.subject}`);
    await lockAccountEmail(tx, email);
    const bySubject = await tx.account.findUnique({ where: { googleSubject: identity.subject } });
    const byEmail = await tx.account.findUnique({ where: { email } });
    if (bySubject && !bySubject.isActive) throw new AppError(403, 'FORBIDDEN', 'This account is unavailable. Contact support for help.');
    // Email equality alone never attaches a new provider to an existing account.
    if (!bySubject && byEmail) throw linkRequired();
    const account = bySubject
      ? await tx.account.update({ where: { id: bySubject.id }, data: { lastLoginAt: now } })
      : await tx.account.create({
        data: { email, fullName: identity.name, googleSubject: identity.subject, emailVerifiedAt: now, lastLoginAt: now },
      });
    if (!bySubject) await emitAccountRegistered(tx, account);
    const session = await createAccountSession(account.id, now, tx);
    return { token: session.token, expiresAt: session.expiresAt, account: toProfile(account) };
  });
}

/** Both the existing account session and Google's identity proof are required to link. */
export async function linkGoogleAccount(accountId: string, idToken: string) {
  const identity = await verifiedIdentity(idToken);
  return prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, `google:${identity.subject}`);
    await lockAccountEmail(tx, identity.email);
    const account = await tx.account.findUnique({ where: { id: accountId } });
    if (!account?.isActive || !account.emailVerifiedAt || account.email !== identity.email) {
      throw new AppError(403, 'FORBIDDEN', 'Use the Google account with the verified email of your DoorKart account.');
    }
    const existingSubject = await tx.account.findUnique({ where: { googleSubject: identity.subject }, select: { id: true } });
    if ((existingSubject && existingSubject.id !== account.id) || (account.googleSubject && account.googleSubject !== identity.subject)) {
      throw linkRequired();
    }
    if (!account.googleSubject) {
      const linked = await tx.account.updateMany({
        where: { id: account.id, googleSubject: null, isActive: true }, data: { googleSubject: identity.subject },
      });
      if (linked.count !== 1) throw linkRequired();
    }
    return toProfile(await tx.account.findUniqueOrThrow({ where: { id: account.id } }));
  });
}
