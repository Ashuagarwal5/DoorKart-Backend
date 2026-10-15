import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { AppError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import { paginationQuery } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';
import { isSecretsKeyConfigured } from '../../lib/secrets.js';
import { getAccount, requireAccount } from '../../middleware/account-auth.js';
import {
  emailSignInEnabled, googleConfig, otpExpiryMinutes, otpMaxAttempts, otpResendCooldownSeconds,
  readSettings, registrationVerificationRequired,
} from '../settings/settings.service.js';
import { orderNumberParamsSchema } from '../orders/orders.schemas.js';
import { cancelAccountOrder, getAccountOrder, listAccountOrders } from '../orders/orders.service.js';
import { type AccountProfile, readBearerToken, hashToken, toProfile } from './account-session.js';
import { accountAddressesRouter } from './account-addresses.routes.js';
import { accountReviewsRouter } from '../reviews/reviews.routes.js';
import { lockAccountEmail } from './account-lock.js';
import { accountEmailSchema, accountMobileSchema, registrationBodySchema } from './accounts.schemas.js';
import { linkGoogleAccount, signInWithGoogle } from './google.service.js';
import { registerAccount, requestEmailOtp, verifyEmailOtp, verifyRegistrationOtp } from './otp.service.js';
import { accountDevicesRouter, accountNotificationsRouter } from '../notifications/notifications.routes.js';

/** Per IP address, on top of the per-email limits. Tests exercise the database limits separately. */
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

const emailSchema = accountEmailSchema;
const requestOtpBody = z.strictObject({ email: emailSchema });
const verifyOtpBody = z.strictObject({ email: emailSchema, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code') });
const googleBody = z.strictObject({ idToken: z.string().min(20).max(5000) });
const profileBody = z.strictObject({
  fullName: z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === '' ? null : value))
    .optional(),
  mobile: accountMobileSchema.nullable().optional(),
}).refine((value) => value.fullName !== undefined || value.mobile !== undefined, 'Enter a name or mobile number to update');

export const authRouter = Router();
export const accountRouter = Router();

/** What the sign-in screen needs: which methods are on, and the Google web client ID (public, not a secret). */
authRouter.get('/config', async (_req, res) => {
  const settings = await readSettings();
  const google = googleConfig(settings);
  const emailEnabled = emailSignInEnabled(settings) && isSecretsKeyConfigured();
  sendSuccess(res, {
    emailEnabled,
    google: { enabled: google.enabled, webClientId: google.enabled ? google.webClientId : null },
    registration: { enabled: emailEnabled, verificationRequired: registrationVerificationRequired(settings) },
    loginMethod: 'email_otp',
    otp: {
      expiresInSeconds: otpExpiryMinutes(settings) * 60,
      resendInSeconds: otpResendCooldownSeconds(settings),
      maxAttempts: otpMaxAttempts(settings),
    },
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

authRouter.post('/register', authLimiter, async (req, res) => {
  sendSuccess(res, await registerAccount(registrationBodySchema.parse(req.body), new Date()));
});

authRouter.post('/register/verify', authLimiter, async (req, res) => {
  const { email, code } = verifyOtpBody.parse(req.body);
  sendSuccess(res, await verifyRegistrationOtp(email, code, new Date()));
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
accountRouter.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
accountRouter.use('/addresses', accountAddressesRouter);
accountRouter.use('/reviews', accountReviewsRouter);
accountRouter.use('/devices', accountDevicesRouter);
accountRouter.use('/notifications', accountNotificationsRouter);

accountRouter.post('/google/link', authLimiter, async (req, res) => {
  const { idToken } = googleBody.parse(req.body);
  sendSuccess(res, await linkGoogleAccount(getAccount(res).id, idToken));
});

accountRouter.use('/orders', (_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

accountRouter.get('/orders', async (req, res) => {
  const page = z.strictObject(paginationQuery).parse(req.query);
  sendSuccess(res, await listAccountOrders(getAccount(res).id, page));
});

accountRouter.get('/orders/:orderNumber', async (req, res) => {
  const { orderNumber } = orderNumberParamsSchema.parse(req.params);
  sendSuccess(res, await getAccountOrder(getAccount(res).id, orderNumber));
});

accountRouter.post('/orders/:orderNumber/cancel', async (req, res) => {
  const { orderNumber } = orderNumberParamsSchema.parse(req.params);
  sendSuccess(res, await cancelAccountOrder(getAccount(res).id, orderNumber));
});

accountRouter.get('/me', async (_req, res) => {
  sendSuccess(res, profileOf(getAccount(res)));
});

accountRouter.patch('/me', async (req, res) => {
  const { fullName, mobile } = profileBody.parse(req.body);
  const account = getAccount(res);
  const updated = await prisma.account.update({ where: { id: account.id }, data: {
    ...(fullName !== undefined ? { fullName } : {}),
    ...(mobile !== undefined ? { mobile, ...(mobile !== account.mobile ? { mobileVerifiedAt: null } : {}) } : {}),
  } });
  sendSuccess(res, toProfile(updated));
});

/** Deletes the account and every sign-in with it. Orders are kept: they belong to the shop's records. */
accountRouter.delete('/me', async (_req, res) => {
  const account = getAccount(res);
  await prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, account.email);
    await tx.emailOtp.deleteMany({ where: { email: account.email } });
    await tx.account.delete({ where: { id: account.id } });
  });
  sendSuccess(res, { deleted: true });
});

function profileOf(account: AccountProfile): AccountProfile {
  return {
    id: account.id, email: account.email, fullName: account.fullName, mobile: account.mobile,
    emailVerified: account.emailVerified, mobileVerified: account.mobileVerified,
    googleLinked: account.googleLinked, isActive: account.isActive,
  };
}
