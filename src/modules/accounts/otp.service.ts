import { randomInt, timingSafeEqual } from 'node:crypto';

import type { EmailOtpPurpose } from '../../generated/prisma/client.js';
import { AppError } from '../../lib/errors.js';
import { prisma, type TransactionClient } from '../../lib/prisma.js';
import { hashOtp, isSecretsKeyConfigured } from '../../lib/secrets.js';
import { sendMail } from '../settings/mailer.js';
import {
  emailSignInEnabled, otpExpiryMinutes, otpMaxAttempts, otpResendCooldownSeconds,
  readSettings, registrationVerificationRequired,
} from '../settings/settings.service.js';
import { lockAccountEmail } from './account-lock.js';
import { emitAccountRegistered } from '../notifications/emitters.js';
import { createAccountSession, toProfile } from './account-session.js';
import { registrationDataSchema, type RegistrationInput } from './accounts.schemas.js';

/** Defaults retained for existing callers; admin settings determine the effective limits. */
export const MAX_OTP_ATTEMPTS = 5;
export const RESEND_COOLDOWN_SECONDS = 60;
export const MAX_CODES_PER_HOUR = 5;
const HOUR_MS = 60 * 60 * 1000;
const NOT_CORRECT = 'That code is not correct or has expired. Check it, or ask for a new one.';

function unavailable(): AppError {
  return new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign in with email is not available right now.');
}

async function emailSettings() {
  const settings = await readSettings();
  if (!isSecretsKeyConfigured() || !emailSignInEnabled(settings)) throw unavailable();
  return settings;
}

function otpHash(email: string, code: string, purpose: EmailOtpPurpose): string {
  // LOGIN retains the original hash format so outstanding legacy sign-in codes still work.
  return hashOtp(purpose === 'LOGIN' ? email : `${purpose}:${email}`, code);
}

function accountExists(): AppError {
  return new AppError(409, 'ACCOUNT_EXISTS', 'An account already uses this email. Sign in with an email code instead.');
}

async function assertNewAccount(tx: TransactionClient, email: string): Promise<void> {
  if (await tx.account.findUnique({ where: { email }, select: { id: true } })) throw accountExists();
}

/** Request limits and retirement of older codes are protected by a shared per-email lock. */
async function requestCode(email: string, purpose: EmailOtpPurpose, now: Date, registration?: RegistrationInput) {
  const settings = await emailSettings();
  const expiryMinutes = otpExpiryMinutes(settings);
  const cooldown = otpResendCooldownSeconds(settings);
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  const created = await prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, email);
    if (registration) await assertNewAccount(tx, email);
    const recent = await tx.emailOtp.findMany({
      where: { email, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { createdAt: true },
    });
    const last = recent[0];
    const waitMs = last ? cooldown * 1000 - (now.getTime() - last.createdAt.getTime()) : 0;
    if (waitMs > 0) {
      const seconds = Math.ceil(waitMs / 1000);
      throw new AppError(429, 'TOO_MANY_REQUESTS', `Please wait ${seconds} seconds before asking for another code.`, { retryAfterSeconds: seconds });
    }
    if (recent.length >= MAX_CODES_PER_HOUR) {
      throw new AppError(429, 'TOO_MANY_REQUESTS', 'Too many codes were requested for this address. Try again in an hour.', { retryAfterSeconds: 3600 });
    }
    await tx.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: now } });
    return tx.emailOtp.create({ data: {
      email, purpose, codeHash: otpHash(email, code, purpose),
      expiresAt: new Date(now.getTime() + expiryMinutes * 60_000), createdAt: now,
      ...(registration ? { registrationData: {
        fullName: registration.fullName, mobile: registration.mobile, termsAcceptedAt: now.toISOString(),
      } } : {}),
    } });
  });

  const action = purpose === 'REGISTRATION' ? 'registration' : 'sign-in';
  try {
    await sendMail({
      to: email, subject: `Your DoorKart ${action} code`,
      text: `Your DoorKart ${action} code is ${code}.\n\nIt works for ${expiryMinutes} minutes and only once. If you did not ask for it, you can ignore this email.`,
      html: `<p>Your DoorKart ${action} code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p><p>It works for ${expiryMinutes} minutes and only once. If you did not ask for it, you can ignore this email.</p>`,
    });
  } catch (error) {
    await prisma.emailOtp.deleteMany({ where: { id: created.id } });
    if (error instanceof AppError && (error.code === 'EMAIL_SEND_FAILED' || error.code === 'EMAIL_NOT_CONFIGURED')) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'We could not send the code right now. Please try again in a few minutes.');
    }
    throw error;
  }
  await prisma.emailOtp.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * HOUR_MS) } } });
  return { expiresInSeconds: expiryMinutes * 60, resendInSeconds: cooldown };
}

export async function requestEmailOtp(email: string, now: Date) {
  return requestCode(email, 'LOGIN', now);
}

/** Disabling registration verification never issues a session without an ownership proof. */
export async function registerAccount(input: RegistrationInput, now: Date) {
  const settings = await emailSettings();
  if (registrationVerificationRequired(settings)) {
    const timing = await requestCode(input.email, 'REGISTRATION', now, input);
    return { verificationRequired: true, loginRequired: false, ...timing };
  }
  await prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, input.email);
    await assertNewAccount(tx, input.email);
    await tx.account.create({ data: {
      email: input.email, fullName: input.fullName, mobile: input.mobile, termsAcceptedAt: now,
    } });
  });
  return { verificationRequired: false, loginRequired: true };
}

async function verifyCode(email: string, code: string, purpose: EmailOtpPurpose, now: Date) {
  const settings = await emailSettings();
  const maxAttempts = otpMaxAttempts(settings);
  const result = await prisma.$transaction(async (tx) => {
    await lockAccountEmail(tx, email);
    const otp = await tx.emailOtp.findFirst({
      where: { email, purpose, consumedAt: null }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    if (!otp || otp.expiresAt <= now || otp.attempts >= maxAttempts) {
      return new AppError(400, 'INVALID_OTP', NOT_CORRECT);
    }
    const expected = Buffer.from(otp.codeHash, 'hex');
    const given = Buffer.from(otpHash(email, code, purpose), 'hex');
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
      // Return the error so the increment commits; throwing here would roll it back.
      const updated = await tx.emailOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
      return new AppError(400, 'INVALID_OTP', NOT_CORRECT, { attemptsLeft: Math.max(maxAttempts - updated.attempts, 0) });
    }
    await tx.emailOtp.update({ where: { id: otp.id }, data: { consumedAt: now } });
    const existing = await tx.account.findUnique({ where: { email } });
    if (existing && !existing.isActive) return new AppError(403, 'FORBIDDEN', 'This account is unavailable. Contact support for help.');
    if (purpose === 'REGISTRATION' && existing) return accountExists();
    const registration = purpose === 'REGISTRATION' ? registrationDataSchema.safeParse(otp.registrationData) : null;
    if (registration && !registration.success) return new AppError(400, 'INVALID_OTP', NOT_CORRECT);
    const account = existing
      ? await tx.account.update({ where: { id: existing.id }, data: { emailVerifiedAt: now, lastLoginAt: now } })
      : await tx.account.create({ data: {
        email, emailVerifiedAt: now, lastLoginAt: now,
        ...(registration?.success ? {
          fullName: registration.data.fullName, mobile: registration.data.mobile,
          termsAcceptedAt: new Date(registration.data.termsAcceptedAt),
        } : {}),
      } });
    // First time this account is verified (new, or created earlier without verification).
    if (!existing || !existing.emailVerifiedAt) await emitAccountRegistered(tx, account);
    const session = await createAccountSession(account.id, now, tx);
    return { token: session.token, expiresAt: session.expiresAt, account: toProfile(account) };
  });
  if (result instanceof AppError) throw result;
  return result;
}

/** Legacy endpoint remains a verified-email sign-in/signup; it never claims guest purchases. */
export async function verifyEmailOtp(email: string, code: string, now: Date) {
  return verifyCode(email, code, 'LOGIN', now);
}

export async function verifyRegistrationOtp(email: string, code: string, now: Date) {
  return verifyCode(email, code, 'REGISTRATION', now);
}
