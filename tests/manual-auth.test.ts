import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { env } from '../src/config/env.js';
import { encryptSecret, hashOtp } from '../src/lib/secrets.js';
import { createAccountSession } from '../src/modules/accounts/account-session.js';
import { setGoogleVerifier } from '../src/modules/accounts/google.service.js';
import { type MailMessage, setMailTransport } from '../src/modules/settings/mailer.js';
import { app, prisma, resetDatabase } from './helpers.js';

const AUTH = '/api/v1/auth';
const signup = { email: 'buyer@example.test', fullName: 'Asha Rao', mobile: '+91 98765 43210', termsAccepted: true };
let sent: MailMessage[];
const code = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';
const register = (body: object = signup) => request(app).post(`${AUTH}/register`).send(body);
const verifyRegistration = (value = code()) => request(app).post(`${AUTH}/register/verify`).send({ email: signup.email, code: value });

async function setting(key: string, value: string) {
  await prisma.setting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function emailConfigured() {
  await prisma.setting.createMany({ data: [
    { key: 'smtp.host', value: 'smtp.example.test' },
    { key: 'smtp.user', value: 'shop@example.test' },
    { key: 'smtp.password', value: encryptSecret('test-only-smtp-password'), isSecret: true },
  ] });
}

async function registered() {
  expect((await register()).status).toBe(200);
  const response = await verifyRegistration();
  expect(response.status).toBe(200);
  return response.body.data as { token: string; account: { id: string } };
}

async function login(email = signup.email) {
  expect((await request(app).post(`${AUTH}/email-otp/request`).send({ email })).status).toBe(200);
  return request(app).post(`${AUTH}/email-otp/verify`).send({ email, code: code() });
}

beforeEach(async () => {
  await resetDatabase();
  sent = [];
  setMailTransport(async (_config, message) => { sent.push(message); });
  setGoogleVerifier(null);
  await emailConfigured();
});
afterEach(() => { setMailTransport(null); setGoogleVerifier(null); });

describe('manual registration', () => {
  it('stages details, then atomically verifies and creates an account with a secure session', async () => {
    const requested = await register({ ...signup, email: ' Buyer@Example.Test ' });
    expect(requested.status).toBe(200);
    expect(requested.body.data).toEqual({ verificationRequired: true, loginRequired: false, expiresInSeconds: 600, resendInSeconds: 60 });
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.accountSession.count()).toBe(0);
    const challenge = await prisma.emailOtp.findFirstOrThrow();
    expect(challenge.purpose).toBe('REGISTRATION');
    expect(challenge.codeHash).not.toContain(code());
    const result = await verifyRegistration();
    expect(result.status).toBe(200);
    expect(result.body.data.account).toMatchObject({
      email: signup.email, fullName: signup.fullName, mobile: '+919876543210',
      emailVerified: true, mobileVerified: false, googleLinked: false, isActive: true,
    });
    const stored = await prisma.account.findUniqueOrThrow({ where: { email: signup.email } });
    expect(stored.termsAcceptedAt).toBeInstanceOf(Date);
    expect(stored.mobileVerifiedAt).toBeNull();
    expect(result.body.data.account).not.toHaveProperty('googleSubject');
    expect(result.body.data.account).not.toHaveProperty('passwordHash');
    expect((await prisma.accountSession.findFirstOrThrow()).tokenHash).not.toBe(result.body.data.token);
    expect((await request(app).get('/api/v1/account/me').auth(result.body.data.token, { type: 'bearer' })).status).toBe(200);
    expect((await verifyRegistration()).body.error.code).toBe('INVALID_OTP');
  });

  it('rejects an existing email without changing its verified profile or provider', async () => {
    const original = await registered();
    const result = await register({ ...signup, fullName: 'Someone Else', mobile: '+441234567890' });
    expect(result.status).toBe(409);
    expect(result.body.error.code).toBe('ACCOUNT_EXISTS');
    expect(await prisma.account.count()).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: original.account.id } })).fullName).toBe(signup.fullName);
  });

  it('rejects missing name, country code, email, consent and forged verification flags', async () => {
    const invalid = [
      { ...signup, fullName: '' }, { ...signup, mobile: '9876543210' },
      { ...signup, email: 'invalid' }, { ...signup, termsAccepted: false },
      { ...signup, emailVerified: true }, { ...signup, isActive: true },
    ];
    for (const body of invalid) expect((await register(body)).status).toBe(400);
    expect(await prisma.account.count()).toBe(0);
    expect(sent).toHaveLength(0);
  });

  it('never lets a registration challenge sign in through the legacy login endpoint', async () => {
    await register();
    const response = await request(app).post(`${AUTH}/email-otp/verify`).send({ email: signup.email, code: code() });
    expect(response.body.error.code).toBe('INVALID_OTP');
    expect(await prisma.accountSession.count()).toBe(0);
    expect((await verifyRegistration()).status).toBe(200);
  });

  it('never lets a login challenge create a registration profile', async () => {
    await request(app).post(`${AUTH}/email-otp/request`).send({ email: signup.email });
    const response = await verifyRegistration();
    expect(response.body.error.code).toBe('INVALID_OTP');
    expect(await prisma.account.count()).toBe(0);
  });

  it('rejects an expired registration challenge without account or session writes', async () => {
    await register();
    await prisma.emailOtp.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await verifyRegistration()).body.error.code).toBe('INVALID_OTP');
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.accountSession.count()).toBe(0);
  });

  it('creates an unverified account without a session only when both registration requirements are disabled', async () => {
    await setting('auth.registrationOtpEnabled', 'false');
    await setting('auth.requireEmailVerification', 'false');
    const response = await register();
    expect(response.body.data).toEqual({ verificationRequired: false, loginRequired: true });
    expect(response.body.data).not.toHaveProperty('token');
    expect(sent).toHaveLength(0);
    const account = await prisma.account.findUniqueOrThrow({ where: { email: signup.email } });
    expect(account.emailVerifiedAt).toBeNull();
    expect(await prisma.accountSession.count()).toBe(0);
    const forgedSession = await createAccountSession(account.id, new Date());
    expect((await request(app).get('/api/v1/account/me').auth(forgedSession.token, { type: 'bearer' })).status).toBe(401);
    const signedIn = await login();
    expect(signedIn.status).toBe(200);
    expect(signedIn.body.data.account.id).toBe(account.id);
    expect(signedIn.body.data.account.emailVerified).toBe(true);
    expect(signedIn.body.data.account.fullName).toBe(signup.fullName);
  });

  it.each([
    ['false', 'true'], ['true', 'false'], ['true', 'true'],
  ])('keeps registration verification when flags are %s/%s', async (otpEnabled, verificationRequired) => {
    await setting('auth.registrationOtpEnabled', otpEnabled);
    await setting('auth.requireEmailVerification', verificationRequired);
    expect((await register()).body.data.verificationRequired).toBe(true);
    expect(await prisma.account.count()).toBe(0);
  });

  it('fails safely when SMTP is missing even when registration verification is disabled', async () => {
    await prisma.setting.deleteMany({ where: { key: 'smtp.password' } });
    await setting('auth.registrationOtpEnabled', 'false');
    await setting('auth.requireEmailVerification', 'false');
    expect((await register()).status).toBe(503);
    const config = (await request(app).get(`${AUTH}/config`)).body.data;
    expect(config.registration.enabled).toBe(false);
    expect(config.emailEnabled).toBe(false);
    expect(config.loginMethod).toBe('email_otp');
    expect(await prisma.account.count()).toBe(0);
  });

  it('serializes concurrent signup requests and valid verification to issue one account/session', async () => {
    const requests = await Promise.all([register(), register()]);
    expect(requests.map((result) => result.status).sort()).toEqual([200, 429]);
    expect(sent).toHaveLength(1);
    const results = await Promise.all([verifyRegistration(), verifyRegistration()]);
    expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
    expect(await prisma.account.count()).toBe(1);
    expect(await prisma.accountSession.count()).toBe(1);
  });
});

describe('secure manual sign-in and profile', () => {
  it('rate limits invalid authentication requests by IP before any mail or database writes', async () => {
    const wasTest = env.isTest;
    env.isTest = false;
    try {
      for (let attempt = 0; attempt < 40; attempt += 1) {
        expect((await request(app).post(`${AUTH}/email-otp/request`).send({ email: 'invalid' })).status).toBe(400);
      }
      const limited = await request(app).post(`${AUTH}/email-otp/request`).send({ email: 'invalid' });
      expect(limited.status).toBe(429);
      expect(limited.body.error.code).toBe('TOO_MANY_REQUESTS');
      expect(sent).toHaveLength(0);
      expect(await prisma.emailOtp.count()).toBe(0);
      expect(await prisma.accountSession.count()).toBe(0);
    } finally {
      env.isTest = wasTest;
    }
  });

  it('applies configured attempt limits to concurrent wrong guesses and consumes no session', async () => {
    await setting('auth.otpMaxAttempts', '2');
    await register();
    const right = code();
    const wrong = right === '000000' ? '111111' : '000000';
    const guesses = await Promise.all([verifyRegistration(wrong), verifyRegistration(wrong), verifyRegistration(wrong)]);
    expect(guesses.every((result) => result.status === 400)).toBe(true);
    expect((await prisma.emailOtp.findFirstOrThrow()).attempts).toBe(2);
    expect((await verifyRegistration(right)).body.error.code).toBe('INVALID_OTP');
    expect(await prisma.accountSession.count()).toBe(0);
  });

  it('uses configured expiry/cooldown and exposes only safe auth configuration', async () => {
    await setting('auth.otpExpiryMinutes', '3');
    await setting('auth.otpResendCooldownSeconds', '90');
    await setting('auth.otpMaxAttempts', '3');
    const requested = await register();
    expect(requested.body.data).toMatchObject({ expiresInSeconds: 180, resendInSeconds: 90 });
    await prisma.emailOtp.updateMany({ data: { createdAt: new Date(Date.now() - 70_000) } });
    expect((await register()).status).toBe(429);
    const config = (await request(app).get(`${AUTH}/config`)).body.data;
    expect(config.otp).toEqual({ expiresInSeconds: 180, resendInSeconds: 90, maxAttempts: 3 });
    expect(JSON.stringify(config)).not.toContain('test-only-smtp-password');
  });

  it('refuses outstanding OTPs after email login is disabled by an admin', async () => {
    await register();
    await setting('auth.emailEnabled', 'false');
    expect((await verifyRegistration()).status).toBe(503);
    expect(await prisma.accountSession.count()).toBe(0);
  });

  it('invalid codes and email alone never authenticate', async () => {
    await request(app).post(`${AUTH}/email-otp/request`).send({ email: signup.email });
    const wrong = code() === '000000' ? '111111' : '000000';
    expect((await request(app).post(`${AUTH}/email-otp/verify`).send({ email: signup.email, code: wrong })).status).toBe(400);
    expect((await request(app).post(`${AUTH}/email-otp/verify`).send({ email: signup.email })).status).toBe(400);
    expect(await prisma.accountSession.count()).toBe(0);
  });

  it('inactive accounts cannot use existing sessions or obtain new ones from a valid OTP', async () => {
    const signedIn = await registered();
    await prisma.account.update({ where: { id: signedIn.account.id }, data: { isActive: false } });
    expect((await request(app).get('/api/v1/account/me').auth(signedIn.token, { type: 'bearer' })).status).toBe(401);
    await prisma.emailOtp.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    const result = await login();
    expect(result.status).toBe(403);
    expect(await prisma.accountSession.count()).toBe(1);
  });

  it('edits only the signed-in profile and never lets a mobile change retain verification', async () => {
    const signedIn = await registered();
    const other = await prisma.account.create({ data: { email: 'other@example.test', fullName: 'Other', emailVerifiedAt: new Date() } });
    await prisma.account.update({ where: { id: signedIn.account.id }, data: { mobileVerifiedAt: new Date() } });
    const edited = await request(app).patch('/api/v1/account/me').auth(signedIn.token, { type: 'bearer' })
      .send({ fullName: 'Asha Updated', mobile: '+44 1234567890' });
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ fullName: 'Asha Updated', mobile: '+441234567890', mobileVerified: false });
    expect((await prisma.account.findUniqueOrThrow({ where: { id: other.id } })).fullName).toBe('Other');
    expect((await request(app).patch('/api/v1/account/me').auth(signedIn.token, { type: 'bearer' }).send({ email: other.email })).status).toBe(400);
  });

  it('accepts a legacy LOGIN code hash after migration', async () => {
    await prisma.emailOtp.create({ data: { email: signup.email, codeHash: hashOtp(signup.email, '654321'), expiresAt: new Date(Date.now() + 60_000) } });
    const result = await request(app).post(`${AUTH}/email-otp/verify`).send({ email: signup.email, code: '654321' });
    expect(result.status).toBe(200);
    expect(result.body.data.account.emailVerified).toBe(true);
  });
});

describe('explicit Google linking', () => {
  const googleToken = 'test-only-google-token-for-linking';
  const identity = { subject: 'google-manual-subject', email: signup.email, emailVerified: true, name: signup.fullName };
  async function enableGoogle() {
    await setting('auth.googleEnabled', 'true');
    await setting('google.webClientId', 'test.apps.googleusercontent.com');
    setGoogleVerifier(async () => identity);
  }

  it('requires both identity proofs, then permits returning Google sign-in without duplicate accounts', async () => {
    const signedIn = await registered();
    await enableGoogle();
    expect((await request(app).post(`${AUTH}/google`).send({ idToken: googleToken })).body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    expect((await request(app).post('/api/v1/account/google/link').send({ idToken: googleToken })).status).toBe(401);
    const linked = await request(app).post('/api/v1/account/google/link').auth(signedIn.token, { type: 'bearer' }).send({ idToken: googleToken });
    expect(linked.status).toBe(200);
    expect(linked.body.data.googleLinked).toBe(true);
    const google = await request(app).post(`${AUTH}/google`).send({ idToken: googleToken });
    expect(google.status).toBe(200);
    expect(google.body.data.account.id).toBe(signedIn.account.id);
    expect(await prisma.account.count()).toBe(1);
  });

  it('refuses a different email and never replaces an existing Google subject', async () => {
    const signedIn = await registered();
    await enableGoogle();
    const link = () => request(app).post('/api/v1/account/google/link').auth(signedIn.token, { type: 'bearer' }).send({ idToken: googleToken });
    setGoogleVerifier(async () => ({ ...identity, email: 'other@example.test' }));
    expect((await link()).status).toBe(403);
    setGoogleVerifier(async () => identity);
    expect((await link()).status).toBe(200);
    setGoogleVerifier(async () => ({ ...identity, subject: 'different-subject' }));
    expect((await link()).body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
    expect((await prisma.account.findUniqueOrThrow({ where: { id: signedIn.account.id } })).googleSubject).toBe(identity.subject);
    expect((await request(app).post(`${AUTH}/google`).send({ idToken: googleToken })).body.error.code).toBe('ACCOUNT_LINK_REQUIRED');
  });
});
