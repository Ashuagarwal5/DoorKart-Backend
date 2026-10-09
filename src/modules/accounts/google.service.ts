import { OAuth2Client } from 'google-auth-library';

import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { googleConfig, readSettings } from '../settings/settings.service.js';
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
export async function signInWithGoogle(idToken: string, now: Date) {
  const config = googleConfig(await readSettings());
  if (!config.enabled) {
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign in with Google is not available right now.');
  }

  const identity = await verifier(idToken, config.clientIds);
  if (!identity || !identity.emailVerified) {
    throw new AppError(401, 'INVALID_GOOGLE_TOKEN', REFUSED);
  }
  const email = identity.email.trim().toLowerCase();

  const account = await prisma.$transaction(async (tx) => {
    const bySubject = await tx.account.findUnique({ where: { googleSubject: identity.subject } });
    if (bySubject) {
      return tx.account.update({ where: { id: bySubject.id }, data: { lastLoginAt: now } });
    }
    // Same verified email, first time with Google: it is the same person, so the accounts join.
    const byEmail = await tx.account.findUnique({ where: { email } });
    if (byEmail) {
      return tx.account.update({
        where: { id: byEmail.id },
        data: {
          googleSubject: identity.subject,
          emailVerifiedAt: byEmail.emailVerifiedAt ?? now,
          fullName: byEmail.fullName ?? identity.name,
          lastLoginAt: now,
        },
      });
    }
    return tx.account.create({
      data: { email, fullName: identity.name, googleSubject: identity.subject, emailVerifiedAt: now, lastLoginAt: now },
    });
  });

  const session = await createAccountSession(account.id, now);
  return { token: session.token, expiresAt: session.expiresAt, account: toProfile(account) };
}
