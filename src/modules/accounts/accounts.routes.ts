import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { normalizeEmail } from '../../lib/email.js';
import { AppError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';
import { isSecretsKeyConfigured } from '../../lib/secrets.js';
import { getAccount, requireAccount } from '../../middleware/account-auth.js';
import { emailSignInEnabled, googleConfig, readSettings } from '../settings/settings.service.js';
import { type AccountProfile, readBearerToken, hashToken, toProfile } from './account-session.js';
import { signInWithGoogle } from './google.service.js';
import { requestEmailOtp, verifyEmailOtp } from './otp.service.js';

/** Per phone address, on top of the per-email limits. Switched off in tests, which sign in constantly. */
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skip: () => env.isTest,
  handler: (_req, _res, next) => {
    next(new AppError(429, 'TOO_MANY_REQUESTS', 'Too many attempts. Please wait a few minutes and try again.'));
  },
});

const emailSchema = z.string().trim().min(3).max(200).pipe(z.email()).transform(normalizeEmail);
const requestOtpBody = z.strictObject({ email: emailSchema });
const verifyOtpBody = z.strictObject({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
const googleBody = z.strictObject({ idToken: z.string().min(20).max(5000) });
const profileBody = z.strictObject({
  fullName: z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === '' ? null : value)),
});

export const authRouter = Router();
export const accountRouter = Router();

/** What the sign-in screen needs: which methods are on, and the Google web client ID (public, not a secret). */
authRouter.get('/config', async (_req, res) => {
  const settings = await readSettings();
  const google = googleConfig(settings);
  sendSuccess(res, {
    emailEnabled: emailSignInEnabled(settings) && isSecretsKeyConfigured(),
    google: { enabled: google.enabled, webClientId: google.enabled ? google.webClientId : null },
  });
});

authRouter.post('/email-otp/request', authLimiter, async (req, res) => {
  const { email } = requestOtpBody.parse(req.body);
  sendSuccess(res, await requestEmailOtp(email, new Date()));
});

authRouter.post('/email-otp/verify', authLimiter, async (req, res) => {
  const { email, code } = verifyOtpBody.parse(req.body);
  sendSuccess(res, await verifyEmailOtp(email, code, new Date()));
});

authRouter.post('/google', authLimiter, async (req, res) => {
  const { idToken } = googleBody.parse(req.body);
  sendSuccess(res, await signInWithGoogle(idToken, new Date()));
});

authRouter.post('/logout', requireAccount, async (req, res) => {
  const token = readBearerToken(req);
  if (token) {
    await prisma.accountSession.deleteMany({ where: { tokenHash: hashToken(token) } });
  }
  sendSuccess(res, { signedOut: true });
});

accountRouter.use(requireAccount);

accountRouter.get('/me', async (_req, res) => {
  sendSuccess(res, profileOf(getAccount(res)));
});

accountRouter.patch('/me', async (req, res) => {
  const { fullName } = profileBody.parse(req.body);
  const updated = await prisma.account.update({ where: { id: getAccount(res).id }, data: { fullName } });
  sendSuccess(res, toProfile(updated));
});

/** Deletes the account and every sign-in with it. Orders are kept: they belong to the shop's records. */
accountRouter.delete('/me', async (_req, res) => {
  const account = getAccount(res);
  await prisma.$transaction([
    prisma.emailOtp.deleteMany({ where: { email: account.email } }),
    prisma.account.delete({ where: { id: account.id } }),
  ]);
  sendSuccess(res, { deleted: true });
});

function profileOf(account: { id: string; email: string; fullName: string | null }): AccountProfile {
  return toProfile(account);
}
