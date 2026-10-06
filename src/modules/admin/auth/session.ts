import { createHash, randomBytes } from 'node:crypto';

import type { CookieOptions, Request, Response } from 'express';

import { env } from '../../../config/env.js';
import type { AdminRole } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

/**
 * Admin sessions. The browser holds a random token in an HttpOnly cookie; the database
 * holds only its SHA-256, so a leaked database cannot be used to sign in. The token is
 * 256 bits of randomness, so a plain hash (no salt, no slow function) is sufficient.
 *
 * Signing out, or deactivating the admin, takes effect on the very next request because
 * every request looks the session up. That is the reason for sessions rather than JWTs.
 */

export const SESSION_COOKIE = 'bn_admin_session';
/** The cookie is only sent to admin routes, never to the public API. */
const COOKIE_PATH = '/api/v1/admin';
/** `lastUsedAt` is refreshed at most this often, so reads do not become writes. */
const LAST_USED_REFRESH_MS = 5 * 60 * 1000;

export type AdminContext = {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  sessionId: string;
};

export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(adminUserId: string, now: Date) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + env.adminSessionTtlMs);

  await prisma.adminSession.create({
    data: { adminUserId, tokenHash: hashSessionToken(token), expiresAt },
  });
  return { token, expiresAt };
}

/** The signed-in admin for this token, or null if it is unknown, expired, or the admin is inactive. */
export async function findActiveSession(token: string, now: Date): Promise<AdminContext | null> {
  const session = await prisma.adminSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { adminUser: true },
  });
  if (!session) {
    return null;
  }

  if (session.expiresAt <= now) {
    await prisma.adminSession.deleteMany({ where: { id: session.id } });
    return null;
  }
  if (!session.adminUser.isActive) {
    return null;
  }

  if (now.getTime() - session.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    await prisma.adminSession.update({ where: { id: session.id }, data: { lastUsedAt: now } });
  }

  const { adminUser } = session;
  return {
    id: adminUser.id,
    name: adminUser.name,
    email: adminUser.email,
    role: adminUser.role,
    sessionId: session.id,
  };
}

export async function revokeSession(token: string): Promise<void> {
  await prisma.adminSession.deleteMany({ where: { tokenHash: hashSessionToken(token) } });
}

export async function revokeAllSessions(adminUserId: string): Promise<void> {
  await prisma.adminSession.deleteMany({ where: { adminUserId } });
}

function cookieOptions(): CookieOptions {
  return {
    httpOnly: true, // script on the page can never read it
    secure: env.isProduction, // only over HTTPS in production
    sameSite: 'lax', // not sent on cross-site POSTs; the admin and API share a site
    path: COOKIE_PATH,
  };
}

export function setSessionCookie(res: Response, token: string, expiresAt: Date): void {
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions(), expires: expiresAt });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, cookieOptions());
}

/** The session token from the Cookie header, or undefined. Parsed by hand: it is one cookie. */
export function readSessionToken(req: Request): string | undefined {
  const header = req.headers.cookie;
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator !== -1 && part.slice(0, separator).trim() === SESSION_COOKIE) {
      const value = part.slice(separator + 1).trim();
      return value === '' ? undefined : value;
    }
  }
  return undefined;
}
