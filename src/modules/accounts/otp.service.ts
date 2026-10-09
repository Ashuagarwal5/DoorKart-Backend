import { randomInt, timingSafeEqual } from 'node:crypto';

import { AppError } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { hashOtp, isSecretsKeyConfigured } from '../../lib/secrets.js';
import { sendMail } from '../settings/mailer.js';
import { emailSignInEnabled, otpExpiryMinutes, readSettings } from '../settings/settings.service.js';
import { createAccountSession, toProfile } from './account-session.js';

/** Wrong guesses allowed per code. After this the code is dead, so 6 digits cannot be brute-forced. */
export const MAX_OTP_ATTEMPTS = 5;
/** Minimum wait between two codes for the same address. */
export const RESEND_COOLDOWN_SECONDS = 60;
/** Codes sent to one address in an hour, so nobody can flood an inbox through us. */
export const MAX_CODES_PER_HOUR = 5;

const HOUR_MS = 60 * 60 * 1000;

const NOT_CORRECT = 'That code is not correct or has expired. Check it, or ask for a new one.';

function newCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

function tooMany(message: string, retryAfterSeconds: number): AppError {
  return new AppError(429, 'TOO_MANY_REQUESTS', message, { retryAfterSeconds });
}

/** Without the master key no code can be made or checked. The customer hears a plain "not available". */
function assertCanUseCodes(): void {
  if (!isSecretsKeyConfigured()) {
    console.error('[auth] SECRETS_KEY is not set, so email sign-in is unavailable.');
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign in with email is not available right now.');
  }
}

/**
 * Emails a one-time code. It answers the same way whether or not the address already has an
 * account, so it cannot be used to find out who is a customer.
 */
export async function requestEmailOtp(email: string, now: Date) {
  assertCanUseCodes();
  const settings = await readSettings();
  if (!emailSignInEnabled(settings)) {
    // The reason (no email server, switched off) is the admin's business, not the customer's.
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'Sign in with email is not available right now.');
  }

  const recent = await prisma.emailOtp.findMany({
    where: { email, createdAt: { gt: new Date(now.getTime() - HOUR_MS) } },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  const last = recent[0];
  if (last) {
    const waitMs = RESEND_COOLDOWN_SECONDS * 1000 - (now.getTime() - last.createdAt.getTime());
    if (waitMs > 0) {
      throw tooMany(`Please wait ${Math.ceil(waitMs / 1000)} seconds before asking for another code.`, Math.ceil(waitMs / 1000));
    }
  }
  if (recent.length >= MAX_CODES_PER_HOUR) {
    throw tooMany('Too many codes were requested for this address. Try again in an hour.', 3600);
  }

  const expiryMinutes = otpExpiryMinutes(settings);
  const code = newCode();
  const created = await prisma.$transaction(async (tx) => {
    // Only the newest code works: asking again retires the earlier ones.
    await tx.emailOtp.updateMany({ where: { email, consumedAt: null }, data: { consumedAt: now } });
    return tx.emailOtp.create({
      data: { email, codeHash: hashOtp(email, code), expiresAt: new Date(now.getTime() + expiryMinutes * 60_000) },
    });
  });

  try {
    await sendMail({
      to: email,
      subject: `Your DoorKart sign-in code: ${code}`,
      text:
        `Your DoorKart sign-in code is ${code}.\n\n` +
        `It works for ${expiryMinutes} minutes and only once. If you did not ask for it, you can ignore this email.`,
      html:
        `<p>Your DoorKart sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:4px">${code}</p>` +
        `<p>It works for ${expiryMinutes} minutes and only once. If you did not ask for it, you can ignore this email.</p>`,
    });
  } catch (error) {
    // A code nobody received must not count against the cooldown or the hourly limit.
    await prisma.emailOtp.delete({ where: { id: created.id } });
    if (error instanceof AppError && (error.code === 'EMAIL_SEND_FAILED' || error.code === 'EMAIL_NOT_CONFIGURED')) {
      throw new AppError(503, 'SERVICE_UNAVAILABLE', 'We could not send the code right now. Please try again in a few minutes.');
    }
    throw error;
  }

  // Housekeeping: codes are useless after a day.
  await prisma.emailOtp.deleteMany({ where: { createdAt: { lt: new Date(now.getTime() - 24 * HOUR_MS) } } });

  return { expiresInSeconds: expiryMinutes * 60, resendInSeconds: RESEND_COOLDOWN_SECONDS };
}

/** Checks a code. On success the code is used up, and the customer gets an account (if new) and a session. */
export async function verifyEmailOtp(email: string, code: string, now: Date) {
  assertCanUseCodes();
  const otp = await prisma.emailOtp.findFirst({
    where: { email, consumedAt: null },
    orderBy: { createdAt: 'desc' },
  });

  if (!otp || otp.expiresAt <= now || otp.attempts >= MAX_OTP_ATTEMPTS) {
    throw new AppError(400, 'INVALID_OTP', NOT_CORRECT);
  }

  const expected = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hashOtp(email, code), 'hex');
  const matches = expected.length === given.length && timingSafeEqual(expected, given);

  if (!matches) {
    const updated = await prisma.emailOtp.update({ where: { id: otp.id }, data: { attempts: { increment: 1 } } });
    const attemptsLeft = Math.max(MAX_OTP_ATTEMPTS - updated.attempts, 0);
    throw new AppError(400, 'INVALID_OTP', NOT_CORRECT, { attemptsLeft });
  }

  // Used up atomically: two requests with the same right code cannot both succeed.
  const used = await prisma.emailOtp.updateMany({
    where: { id: otp.id, consumedAt: null, attempts: { lt: MAX_OTP_ATTEMPTS } },
    data: { consumedAt: now },
  });
  if (used.count !== 1) {
    throw new AppError(400, 'INVALID_OTP', NOT_CORRECT);
  }

  const account = await prisma.account.upsert({
    where: { email },
    create: { email, emailVerifiedAt: now, lastLoginAt: now },
    update: { emailVerifiedAt: now, lastLoginAt: now },
  });
  const session = await createAccountSession(account.id, now);
  return { token: session.token, expiresAt: session.expiresAt, account: toProfile(account) };
}
