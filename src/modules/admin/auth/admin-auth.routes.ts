import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';

import { normalizeEmail } from '../../../lib/email.js';
import { AppError } from '../../../lib/errors.js';
import { sendSuccess } from '../../../lib/http.js';
import { prisma } from '../../../lib/prisma.js';
import { getAdmin, requireAdmin } from '../../../middleware/admin-auth.js';
import { verifyAgainstDummy, verifyPassword } from './password.js';
import {
  clearSessionCookie,
  createSession,
  readSessionToken,
  revokeSession,
  setSessionCookie,
} from './session.js';

export type LoginRateLimit = { limit: number; windowMs: number };

/** 10 failed attempts per address per 15 minutes. Successful logins are not counted. */
export const DEFAULT_LOGIN_RATE_LIMIT: LoginRateLimit = { limit: 10, windowMs: 15 * 60 * 1000 };

const loginBodySchema = z.strictObject({
  email: z.string().trim().min(3).max(254),
  // No strength rules here: those apply when a password is chosen, not when it is used.
  password: z.string().min(1).max(200),
});

/** Sign-in failures all look the same, whatever the reason, so they reveal nothing. */
const invalidCredentials = () =>
  new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password.');

export function createAdminAuthRouter(loginRateLimit: LoginRateLimit) {
  const router = Router();

  const loginLimiter = rateLimit({
    windowMs: loginRateLimit.windowMs,
    limit: loginRateLimit.limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: true,
    handler: (_req, _res, next) =>
      next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many sign-in attempts. Try again later.')),
  });

  router.post('/login', loginLimiter, async (req, res) => {
    const body = loginBodySchema.parse(req.body);
    const email = normalizeEmail(body.email);

    const admin = await prisma.adminUser.findUnique({ where: { email } });

    if (!admin) {
      // Spend the same time as a real check, so "no such account" is not detectable by speed.
      await verifyAgainstDummy(body.password);
      throw invalidCredentials();
    }
    const isCorrect = await verifyPassword(body.password, admin.passwordHash);
    // Inactive accounts get exactly the same answer as a wrong password.
    if (!isCorrect || !admin.isActive) {
      throw invalidCredentials();
    }

    const now = new Date();
    // A browser that signs in again replaces its old session instead of piling them up.
    const previousToken = readSessionToken(req);
    if (previousToken) {
      await revokeSession(previousToken);
    }
    await prisma.adminSession.deleteMany({ where: { expiresAt: { lte: now } } });
    await prisma.adminUser.update({ where: { id: admin.id }, data: { lastLoginAt: now } });

    const { token, expiresAt } = await createSession(admin.id, now);
    setSessionCookie(res, token, expiresAt);

    sendSuccess(res, {
      admin: { id: admin.id, name: admin.name, email: admin.email, role: admin.role },
    });
  });

  router.post('/logout', requireAdmin, async (req, res) => {
    const token = readSessionToken(req);
    if (token) {
      await revokeSession(token);
    }
    clearSessionCookie(res);
    sendSuccess(res, { loggedOut: true });
  });

  router.get('/me', requireAdmin, (_req, res) => {
    const { id, name, email, role } = getAdmin(res);
    sendSuccess(res, { admin: { id, name, email, role } });
  });

  return router;
}
