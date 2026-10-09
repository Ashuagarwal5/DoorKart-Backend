import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { decryptSecret, encryptSecret } from '../src/lib/secrets.js';
import { setGoogleVerifier } from '../src/modules/accounts/google.service.js';
import { MAX_OTP_ATTEMPTS, RESEND_COOLDOWN_SECONDS } from '../src/modules/accounts/otp.service.js';
import { type MailMessage, setMailTransport } from '../src/modules/settings/mailer.js';
import {
  type AdminAgent,
  app,
  createTestAdmin,
  prisma,
  resetDatabase,
  signIn,
} from './helpers.js';

const SETTINGS = '/api/v1/admin/settings';
const SMTP_PASSWORD = 'smtp-secret-do-not-leak-123';

let sent: MailMessage[];
let admin: AdminAgent;

/** The six digits in the latest email, the way a customer would read them. */
const lastCode = () => /\b(\d{6})\b/.exec(sent.at(-1)?.text ?? '')?.[1] ?? '';

async function configureEmail(agent: AdminAgent = admin) {
  const response = await agent.patch(SETTINGS).send({
    changes: {
      'smtp.host': 'smtp.example.test',
      'smtp.user': 'shop@example.test',
      'smtp.password': SMTP_PASSWORD,
      'smtp.fromEmail': 'shop@example.test',
    },
  });
  expect(response.status).toBe(200);
}

beforeEach(async () => {
  await resetDatabase();
  await createTestAdmin({ role: 'SUPER_ADMIN' });
  admin = await signIn();
  sent = [];
  setMailTransport(async (_config, message) => {
    sent.push(message);
  });
  setGoogleVerifier(null);
});

afterEach(() => {
  setMailTransport(null);
  setGoogleVerifier(null);
});

describe('secret encryption', () => {
  it('round-trips, never stores plain text, and uses a fresh IV each time', () => {
    const first = encryptSecret('hunter2');
    const second = encryptSecret('hunter2');

    expect(first).not.toContain('hunter2');
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe('hunter2');
  });

  it('refuses to decrypt something that was altered', () => {
    const stored = encryptSecret('hunter2');
    const tampered = `${stored.slice(0, -4)}AAAA`;

    expect(decryptSecret(tampered)).toBeNull();
    expect(decryptSecret('not-encrypted')).toBeNull();
  });
});

describe('admin settings', () => {
  it('saves values, encrypts secrets in the database, and never returns them', async () => {
    await configureEmail();

    const response = await admin.get(SETTINGS);
    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).not.toContain(SMTP_PASSWORD);

    const smtp = response.body.data.groups
      .flatMap((group: { settings: { key: string }[] }) => group.settings)
      .find((setting: { key: string }) => setting.key === 'smtp.password');
    expect(smtp).toMatchObject({ secret: true, isSet: true, value: null });

    const row = await prisma.setting.findUniqueOrThrow({ where: { key: 'smtp.password' } });
    expect(row.isSecret).toBe(true);
    expect(row.value).not.toContain(SMTP_PASSWORD);
    expect(decryptSecret(row.value)).toBe(SMTP_PASSWORD);
  });

  it('leaves a secret alone when it is not sent, replaces it when it is, and clears it with null', async () => {
    await configureEmail();
    await admin.patch(SETTINGS).send({ changes: { 'smtp.host': 'other.example.test' } });
    expect(decryptSecret((await prisma.setting.findUniqueOrThrow({ where: { key: 'smtp.password' } })).value)).toBe(SMTP_PASSWORD);

    await admin.patch(SETTINGS).send({ changes: { 'smtp.password': 'a-new-password' } });
    expect(decryptSecret((await prisma.setting.findUniqueOrThrow({ where: { key: 'smtp.password' } })).value)).toBe('a-new-password');

    await admin.patch(SETTINGS).send({ changes: { 'smtp.password': null } });
    expect(await prisma.setting.findUnique({ where: { key: 'smtp.password' } })).toBeNull();
  });

  it('validates values and rejects unknown settings', async () => {
    const badPort = await admin.patch(SETTINGS).send({ changes: { 'smtp.port': '99999' } });
    expect(badPort.status).toBe(400);
    expect(badPort.body.error.details[0].field).toBe('smtp.port');

    const badHost = await admin.patch(SETTINGS).send({ changes: { 'smtp.host': 'https://mail.example.test/' } });
    expect(badHost.status).toBe(400);

    const unknown = await admin.patch(SETTINGS).send({ changes: { 'something.else': 'x' } });
    expect(unknown.status).toBe(400);
  });

  it('is for super admins only', async () => {
    await createTestAdmin({ email: 'staff@example.test', role: 'ADMIN' });
    const staff = await signIn('staff@example.test');

    expect((await staff.get(SETTINGS)).status).toBe(403);
    expect((await staff.patch(SETTINGS).send({ changes: { 'smtp.host': 'x.example.test' } })).status).toBe(403);
    expect((await request(app).get(SETTINGS)).status).toBe(401);
  });

  it('sends a test email, and explains a failure without revealing credentials', async () => {
    await configureEmail();
    const ok = await admin.post(`${SETTINGS}/email/test`).send({ to: 'Me@Example.test' });
    expect(ok.status).toBe(200);
    expect(sent.at(-1)?.to).toBe('me@example.test');

    setMailTransport(async () => {
      throw Object.assign(new Error(`login failed for ${SMTP_PASSWORD}`), { code: 'EAUTH' });
    });
    const failed = await admin.post(`${SETTINGS}/email/test`).send({});
    expect(failed.status).toBe(502);
    expect(failed.body.error.code).toBe('EMAIL_SEND_FAILED');
    expect(JSON.stringify(failed.body)).not.toContain(SMTP_PASSWORD);
    expect(failed.body.error.message).toMatch(/app password/i);
  });

  it('refuses to send when email is not set up', async () => {
    const response = await admin.post(`${SETTINGS}/email/test`).send({});

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('EMAIL_NOT_CONFIGURED');
  });
});

describe('email sign-in codes', () => {
  const EMAIL = '/api/v1/auth/email-otp';
  const email = 'customer@example.test';

  it('is unavailable until email is set up, and says nothing about why', async () => {
    const response = await request(app).post(`${EMAIL}/request`).send({ email });

    expect(response.status).toBe(503);
    expect(JSON.stringify(response.body)).not.toMatch(/smtp|SECRETS_KEY/i);
  });

  it('emails a code, stores only its hash, and signs the customer in with it', async () => {
    await configureEmail();
    const requested = await request(app).post(`${EMAIL}/request`).send({ email: ' Customer@Example.test ' });
    expect(requested.status).toBe(200);
    expect(requested.body.data.resendInSeconds).toBe(RESEND_COOLDOWN_SECONDS);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe(email);

    const code = lastCode();
    expect(code).toMatch(/^\d{6}$/);
    const row = await prisma.emailOtp.findFirstOrThrow({ where: { email } });
    expect(row.codeHash).not.toContain(code);
    expect(JSON.stringify(row)).not.toContain(code);

    const verified = await request(app).post(`${EMAIL}/verify`).send({ email, code });
    expect(verified.status).toBe(200);
    expect(verified.body.data.account).toMatchObject({ email, fullName: null });

    const me = await request(app).get('/api/v1/account/me').set('Authorization', `Bearer ${verified.body.data.token}`);
    expect(me.status).toBe(200);
    expect(me.body.data.email).toBe(email);

    // Only a hash of the session token is stored.
    const sessions = await prisma.accountSession.findMany();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.tokenHash).not.toBe(verified.body.data.token);
  });

  it('works only once', async () => {
    await configureEmail();
    await request(app).post(`${EMAIL}/request`).send({ email });
    const code = lastCode();

    expect((await request(app).post(`${EMAIL}/verify`).send({ email, code })).status).toBe(200);
    const again = await request(app).post(`${EMAIL}/verify`).send({ email, code });

    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe('INVALID_OTP');
  });

  it('is only good for the address it was sent to', async () => {
    await configureEmail();
    await request(app).post(`${EMAIL}/request`).send({ email });

    const response = await request(app).post(`${EMAIL}/verify`).send({ email: 'someone.else@example.test', code: lastCode() });

    expect(response.status).toBe(400);
  });

  it('is destroyed by too many wrong guesses, even if the right code follows', async () => {
    await configureEmail();
    await request(app).post(`${EMAIL}/request`).send({ email });
    const right = lastCode();
    const wrong = right === '000000' ? '111111' : '000000';

    let last;
    for (let attempt = 0; attempt < MAX_OTP_ATTEMPTS; attempt += 1) {
      last = await request(app).post(`${EMAIL}/verify`).send({ email, code: wrong });
      expect(last.status).toBe(400);
    }
    expect(last?.body.error.details.attemptsLeft).toBe(0);

    const tooLate = await request(app).post(`${EMAIL}/verify`).send({ email, code: right });
    expect(tooLate.status).toBe(400);
    expect(await prisma.accountSession.count()).toBe(0);
  });

  it('expires', async () => {
    await configureEmail();
    await request(app).post(`${EMAIL}/request`).send({ email });
    const code = lastCode();
    await prisma.emailOtp.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const response = await request(app).post(`${EMAIL}/verify`).send({ email, code });

    expect(response.status).toBe(400);
  });

  it('makes a new code replace the old one, after the resend wait', async () => {
    await configureEmail();
    await request(app).post(`${EMAIL}/request`).send({ email });
    const first = lastCode();

    const tooSoon = await request(app).post(`${EMAIL}/request`).send({ email });
    expect(tooSoon.status).toBe(429);
    expect(tooSoon.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
    expect(sent).toHaveLength(1);

    // Move the first code back in time so the cooldown has passed.
    await prisma.emailOtp.updateMany({ data: { createdAt: new Date(Date.now() - 120_000) } });
    expect((await request(app).post(`${EMAIL}/request`).send({ email })).status).toBe(200);
    const second = lastCode();

    if (second !== first) {
      expect((await request(app).post(`${EMAIL}/verify`).send({ email, code: first })).status).toBe(400);
    }
    expect((await request(app).post(`${EMAIL}/verify`).send({ email, code: second })).status).toBe(200);
  });

  it('limits how many codes one address can ask for in an hour', async () => {
    await configureEmail();
    for (let count = 0; count < 5; count += 1) {
      await prisma.emailOtp.create({
        data: { email, codeHash: 'x', expiresAt: new Date(Date.now() + 60_000), createdAt: new Date(Date.now() - 300_000 - count * 1000) },
      });
    }

    const response = await request(app).post(`${EMAIL}/request`).send({ email });

    expect(response.status).toBe(429);
    expect(sent).toHaveLength(0);
  });

  it('does not count a code that could not be sent', async () => {
    await configureEmail();
    setMailTransport(async () => {
      throw Object.assign(new Error('down'), { code: 'ETIMEDOUT' });
    });

    const response = await request(app).post(`${EMAIL}/request`).send({ email });

    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('SERVICE_UNAVAILABLE');
    expect(await prisma.emailOtp.count()).toBe(0);
  });

  it('validates the input', async () => {
    await configureEmail();

    expect((await request(app).post(`${EMAIL}/request`).send({ email: 'not-an-email' })).status).toBe(400);
    expect((await request(app).post(`${EMAIL}/verify`).send({ email, code: '12ab56' })).status).toBe(400);
    expect((await request(app).post(`${EMAIL}/verify`).send({ email, code: '123456', extra: 1 })).status).toBe(400);
  });

  it('can be switched off in settings', async () => {
    await configureEmail();
    await admin.patch(SETTINGS).send({ changes: { 'auth.emailEnabled': 'false' } });

    expect((await request(app).post(`${EMAIL}/request`).send({ email })).status).toBe(503);
    expect((await request(app).get('/api/v1/auth/config')).body.data.emailEnabled).toBe(false);
  });
});

describe('Google sign-in', () => {
  const GOOGLE = '/api/v1/auth/google';
  const token = 'x'.repeat(40);
  const identity = { subject: 'google-sub-1', email: 'Person@Gmail.test', emailVerified: true, name: 'Pat Person' };

  async function enableGoogle() {
    await admin.patch(SETTINGS).send({
      changes: { 'auth.googleEnabled': 'true', 'google.webClientId': 'web-id.apps.googleusercontent.com' },
    });
  }

  it('is unavailable until it is turned on and has a client ID', async () => {
    setGoogleVerifier(async () => identity);

    expect((await request(app).post(GOOGLE).send({ idToken: token })).status).toBe(503);

    await admin.patch(SETTINGS).send({ changes: { 'auth.googleEnabled': 'true' } });
    expect((await request(app).post(GOOGLE).send({ idToken: token })).status).toBe(503);
  });

  it('tells the app which client ID to use only when Google is on', async () => {
    expect((await request(app).get('/api/v1/auth/config')).body.data.google).toEqual({ enabled: false, webClientId: null });

    await enableGoogle();
    expect((await request(app).get('/api/v1/auth/config')).body.data.google).toEqual({
      enabled: true,
      webClientId: 'web-id.apps.googleusercontent.com',
    });
  });

  it('checks the token against the saved client IDs, then creates the account', async () => {
    await enableGoogle();
    await admin.patch(SETTINGS).send({ changes: { 'google.androidClientId': 'android-id.apps.googleusercontent.com' } });
    let audiences: string[] = [];
    setGoogleVerifier(async (_token, allowed) => {
      audiences = allowed;
      return identity;
    });

    const response = await request(app).post(GOOGLE).send({ idToken: token });

    expect(response.status).toBe(200);
    expect(audiences).toEqual(['web-id.apps.googleusercontent.com', 'android-id.apps.googleusercontent.com']);
    expect(response.body.data.account).toMatchObject({ email: 'person@gmail.test', fullName: 'Pat Person' });
    const me = await request(app).get('/api/v1/account/me').set('Authorization', `Bearer ${response.body.data.token}`);
    expect(me.status).toBe(200);
  });

  it('refuses a token Google does not vouch for, and an unverified email', async () => {
    await enableGoogle();

    setGoogleVerifier(async () => null);
    const forged = await request(app).post(GOOGLE).send({ idToken: token });
    expect(forged.status).toBe(401);
    expect(forged.body.error.code).toBe('INVALID_GOOGLE_TOKEN');

    setGoogleVerifier(async () => ({ ...identity, emailVerified: false }));
    expect((await request(app).post(GOOGLE).send({ idToken: token })).status).toBe(401);
    expect(await prisma.account.count()).toBe(0);
  });

  it('joins an existing email-code account instead of creating a second one', async () => {
    await enableGoogle();
    const existing = await prisma.account.create({ data: { email: 'person@gmail.test' } });
    setGoogleVerifier(async () => identity);

    const response = await request(app).post(GOOGLE).send({ idToken: token });

    expect(response.status).toBe(200);
    expect(response.body.data.account.id).toBe(existing.id);
    expect(await prisma.account.count()).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: existing.id } })).googleSubject).toBe('google-sub-1');
  });

  it('recognises a returning Google user even if their Google email changed', async () => {
    await enableGoogle();
    setGoogleVerifier(async () => identity);
    const first = await request(app).post(GOOGLE).send({ idToken: token });

    setGoogleVerifier(async () => ({ ...identity, email: 'new.address@gmail.test' }));
    const second = await request(app).post(GOOGLE).send({ idToken: token });

    expect(second.body.data.account.id).toBe(first.body.data.account.id);
  });
});

describe('customer accounts', () => {
  async function signedIn() {
    await configureEmail();
    await request(app).post('/api/v1/auth/email-otp/request').send({ email: 'me@example.test' });
    const response = await request(app).post('/api/v1/auth/email-otp/verify').send({ email: 'me@example.test', code: lastCode() });
    return response.body.data.token as string;
  }

  it('requires a valid token', async () => {
    expect((await request(app).get('/api/v1/account/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/account/me').set('Authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await request(app).get('/api/v1/account/me').set('Authorization', 'Basic abc')).status).toBe(401);
  });

  it('stops working when the session has expired', async () => {
    const token = await signedIn();
    await prisma.accountSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get('/api/v1/account/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('signs out', async () => {
    const token = await signedIn();

    expect((await request(app).post('/api/v1/auth/logout').set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await request(app).get('/api/v1/account/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('updates the name', async () => {
    const token = await signedIn();

    const response = await request(app).patch('/api/v1/account/me').set('Authorization', `Bearer ${token}`).send({ fullName: '  Asha Rao ' });

    expect(response.body.data.fullName).toBe('Asha Rao');
  });

  it('deletes the account and ends every sign-in', async () => {
    const token = await signedIn();

    const response = await request(app).delete('/api/v1/account/me').set('Authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(await prisma.account.count()).toBe(0);
    expect(await prisma.accountSession.count()).toBe(0);
    expect((await request(app).get('/api/v1/account/me').set('Authorization', `Bearer ${token}`)).status).toBe(401);
  });
});

describe('shop details', () => {
  it('shows nothing until the admin fills them in, then shows only what was set', async () => {
    const empty = await request(app).get('/api/v1/shop');
    expect(empty.status).toBe(200);
    expect(empty.body.data).toEqual({
      name: 'DoorKart',
      phone: null,
      whatsapp: null,
      email: null,
      address: null,
      hours: null,
      privacyPolicyUrl: null,
      termsUrl: null,
    });

    const saved = await admin.patch(SETTINGS).send({
      changes: {
        'shop.phone': '98765 43210',
        'shop.email': 'help@example.test',
        'shop.privacyPolicyUrl': 'https://example.test/privacy',
      },
    });
    expect(saved.status).toBe(200);

    const filled = await request(app).get('/api/v1/shop');
    expect(filled.body.data).toMatchObject({
      phone: '98765 43210',
      email: 'help@example.test',
      privacyPolicyUrl: 'https://example.test/privacy',
      whatsapp: null,
    });
  });

  it('never exposes anything else, such as the email password', async () => {
    await configureEmail();

    const response = await request(app).get('/api/v1/shop');

    expect(JSON.stringify(response.body)).not.toMatch(/smtp|password|secret/i);
  });

  it('refuses a bad phone number and a web address that is not https', async () => {
    const phone = await admin.patch(SETTINGS).send({ changes: { 'shop.phone': 'call me' } });
    expect(phone.status).toBe(400);
    expect(phone.body.error.details[0].field).toBe('shop.phone');

    for (const url of ['http://example.test/privacy', 'javascript:alert(1)', 'example.test/privacy']) {
      const response = await admin.patch(SETTINGS).send({ changes: { 'shop.termsUrl': url } });
      expect(response.status, url).toBe(400);
    }
  });

  it('can be cleared again', async () => {
    await admin.patch(SETTINGS).send({ changes: { 'shop.hours': 'Every day, 9 to 9' } });
    await admin.patch(SETTINGS).send({ changes: { 'shop.hours': null } });

    expect((await request(app).get('/api/v1/shop')).body.data.hours).toBeNull();
  });
});
