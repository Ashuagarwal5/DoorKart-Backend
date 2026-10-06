import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { errorHandler } from '../src/middleware/error-handler.js';
import { requireRole } from '../src/middleware/admin-auth.js';
import {
  hashPassword,
  validateNewPassword,
  verifyPassword,
} from '../src/modules/admin/auth/password.js';
import { hashSessionToken, SESSION_COOKIE } from '../src/modules/admin/auth/session.js';
import {
  app,
  createTestAdmin,
  prisma,
  resetDatabase,
  signIn,
  TEST_ADMIN_EMAIL,
  TEST_PASSWORD,
} from './helpers.js';

const LOGIN = '/api/v1/admin/auth/login';
const ME = '/api/v1/admin/auth/me';
const LOGOUT = '/api/v1/admin/auth/logout';

const login = (email: string, password: string) => request(app).post(LOGIN).send({ email, password });

/** The Set-Cookie header for the session, as one string. */
function sessionCookieHeader(response: request.Response): string {
  const header = response.headers['set-cookie'];
  const list = Array.isArray(header) ? header : header ? [header] : [];
  return list.find((cookie) => cookie.startsWith(`${SESSION_COOKIE}=`)) ?? '';
}

beforeEach(async () => {
  await resetDatabase();
  await createTestAdmin();
});

describe('POST /api/v1/admin/auth/login', () => {
  it('signs in with the right password and sets a locked-down session cookie', async () => {
    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);

    expect(response.status).toBe(200);
    expect(response.body.data.admin).toMatchObject({ email: TEST_ADMIN_EMAIL, name: 'Test Admin', role: 'ADMIN' });

    const cookie = sessionCookieHeader(response);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    // Only sent to admin routes, never to the public API.
    expect(cookie).toMatch(/Path=\/api\/v1\/admin/);
    expect(cookie).toMatch(/Expires=/);
    // Secure is only set in production, where HTTPS is guaranteed.
    expect(cookie).not.toMatch(/Secure/i);
  });

  it('never returns the password hash or the session token in the body', async () => {
    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);
    const body = JSON.stringify(response.body);
    const token = sessionCookieHeader(response).split(';')[0]?.split('=')[1] ?? '';

    expect(body).not.toMatch(/passwordHash|scrypt\$/);
    expect(token.length).toBeGreaterThan(30);
    expect(body).not.toContain(token);
  });

  it('accepts the email in any case and with stray spaces', async () => {
    const response = await login('  ADMIN@Example.TEST ', TEST_PASSWORD);
    expect(response.status).toBe(200);
  });

  it('rejects a wrong password', async () => {
    const response = await login(TEST_ADMIN_EMAIL, 'definitely-not-it');

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe('INVALID_CREDENTIALS');
    expect(sessionCookieHeader(response)).toBe('');
  });

  it('rejects an account that does not exist, with the same answer as a wrong password', async () => {
    const wrongPassword = await login(TEST_ADMIN_EMAIL, 'definitely-not-it');
    const noSuchAccount = await login('nobody@example.test', TEST_PASSWORD);

    expect(noSuchAccount.status).toBe(401);
    expect(noSuchAccount.body).toEqual(wrongPassword.body);
  });

  it('rejects an inactive admin even with the right password, and says nothing different', async () => {
    await prisma.adminUser.update({ where: { email: TEST_ADMIN_EMAIL }, data: { isActive: false } });

    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);

    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({
      code: 'INVALID_CREDENTIALS',
      message: 'Incorrect email or password.',
    });
  });

  it('rejects malformed requests without touching the database', async () => {
    for (const body of [{}, { email: 'a@b.test' }, { email: 'a@b.test', password: '' }, { email: 'a@b.test', password: 'x', extra: 1 }]) {
      const response = await request(app).post(LOGIN).send(body);
      expect(response.status).toBe(400);
      expect(response.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('records the sign-in time', async () => {
    await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: TEST_ADMIN_EMAIL } });
    expect(admin.lastLoginAt).not.toBeNull();
  });

  it('stores only a hash of the session token, and a salted hash of the password', async () => {
    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);
    const token = decodeURIComponent(sessionCookieHeader(response).split(';')[0]?.split('=')[1] ?? '');

    const session = await prisma.adminSession.findFirstOrThrow();
    expect(session.tokenHash).toBe(hashSessionToken(token));
    expect(session.tokenHash).not.toContain(token);

    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: TEST_ADMIN_EMAIL } });
    expect(admin.passwordHash).toMatch(/^scrypt\$/);
    expect(admin.passwordHash).not.toContain(TEST_PASSWORD);
  });

  it('limits repeated failed attempts, and does not count successful sign-ins', async () => {
    const limited = createApp({ loginRateLimit: { limit: 3, windowMs: 60_000 } });
    const attempt = (password: string) =>
      request(limited).post(LOGIN).send({ email: TEST_ADMIN_EMAIL, password });

    // Successful sign-ins do not use up the allowance.
    for (let i = 0; i < 5; i += 1) {
      expect((await attempt(TEST_PASSWORD)).status).toBe(200);
    }

    for (let i = 0; i < 3; i += 1) {
      expect((await attempt('wrong-password')).status).toBe(401);
    }
    const blocked = await attempt('wrong-password');
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('TOO_MANY_REQUESTS');
    // Even the right password waits once the limit is reached.
    expect((await attempt(TEST_PASSWORD)).status).toBe(429);
  });
});

describe('admin session', () => {
  it('lets a signed-in admin reach a protected endpoint', async () => {
    const agent = await signIn();
    const response = await agent.get(ME);

    expect(response.status).toBe(200);
    expect(response.body.data.admin.email).toBe(TEST_ADMIN_EMAIL);
    expect(JSON.stringify(response.body)).not.toMatch(/passwordHash/);
  });

  it('refuses protected endpoints with no session, whatever they are', async () => {
    for (const [method, path] of [
      ['get', ME],
      ['post', LOGOUT],
      ['get', '/api/v1/admin/orders'],
      ['get', '/api/v1/admin/dashboard'],
      ['get', '/api/v1/admin/products'],
      ['post', '/api/v1/admin/products'],
      ['get', '/api/v1/admin/categories'],
      ['get', '/api/v1/admin/delivery-areas'],
      ['get', '/api/v1/admin/customers'],
      ['patch', '/api/v1/admin/orders/anything/status'],
      // Even a route that does not exist answers 401, not 404: nothing leaks to strangers.
      ['get', '/api/v1/admin/nothing-here'],
    ] as const) {
      const response = await request(app)[method](path).send({});
      expect(response.status, `${method} ${path}`).toBe(401);
      expect(response.body.error.code).toBe('UNAUTHENTICATED');
    }
  });

  it('refuses a made-up or tampered cookie', async () => {
    const forged = await request(app).get(ME).set('Cookie', `${SESSION_COOKIE}=not-a-real-token`);
    expect(forged.status).toBe(401);

    const agent = await signIn();
    const real = (await agent.get(ME)).status;
    expect(real).toBe(200);
  });

  it('signs out for good: the old cookie stops working', async () => {
    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);
    const cookie = sessionCookieHeader(response).split(';')[0] ?? '';

    expect((await request(app).get(ME).set('Cookie', cookie)).status).toBe(200);

    const logout = await request(app).post(LOGOUT).set('Cookie', cookie);
    expect(logout.status).toBe(200);
    // The cookie is cleared in the browser...
    expect(sessionCookieHeader(logout)).toMatch(/Expires=Thu, 01 Jan 1970/);

    // ...and, more importantly, the session no longer exists on the server, so even a
    // copy of the old cookie someone kept is useless.
    expect((await request(app).get(ME).set('Cookie', cookie)).status).toBe(401);
    expect(await prisma.adminSession.count()).toBe(0);
  });

  it('rejects an expired session and removes it', async () => {
    const response = await login(TEST_ADMIN_EMAIL, TEST_PASSWORD);
    const cookie = sessionCookieHeader(response).split(';')[0] ?? '';
    await prisma.adminSession.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    expect((await request(app).get(ME).set('Cookie', cookie)).status).toBe(401);
    expect(await prisma.adminSession.count()).toBe(0);
  });

  it('stops working the moment the admin is deactivated', async () => {
    const agent = await signIn();
    expect((await agent.get(ME)).status).toBe(200);

    await prisma.adminUser.update({ where: { email: TEST_ADMIN_EMAIL }, data: { isActive: false } });

    expect((await agent.get(ME)).status).toBe(401);
  });

  it('signing in again replaces the browser’s previous session', async () => {
    const agent = await signIn();
    await agent.post(LOGIN).send({ email: TEST_ADMIN_EMAIL, password: TEST_PASSWORD });

    expect(await prisma.adminSession.count()).toBe(1);
    expect((await agent.get(ME)).status).toBe(200);
  });

});

describe('browser protections', () => {
  it('refuses a state-changing request from an origin that is not the admin panel', async () => {
    const agent = await signIn();
    const response = await agent
      .post(LOGOUT)
      .set('Origin', 'https://evil.example');

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('ORIGIN_NOT_ALLOWED');
    // Nothing happened: the session is still there.
    expect(await prisma.adminSession.count()).toBe(1);
  });

  it('accepts the configured admin origin and reads from any origin', async () => {
    const agent = await signIn();
    const fromPanel = await agent.get(ME).set('Origin', 'http://localhost:3000');
    expect(fromPanel.status).toBe(200);

    const logout = await agent.post(LOGOUT).set('Origin', 'http://localhost:3000');
    expect(logout.status).toBe(200);
  });

  it('answers a browser preflight with credentials allowed for the admin origin only', async () => {
    const allowed = await request(app)
      .options('/api/v1/admin/orders/x/status')
      .set('Origin', 'http://localhost:3000')
      .set('Access-Control-Request-Method', 'PATCH')
      .set('Access-Control-Request-Headers', 'content-type');
    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:3000');
    expect(allowed.headers['access-control-allow-credentials']).toBe('true');
    expect(allowed.headers['access-control-allow-methods']).toMatch(/PATCH/);

    const stranger = await request(app)
      .options('/api/v1/admin/orders/x/status')
      .set('Origin', 'https://evil.example')
      .set('Access-Control-Request-Method', 'PATCH');
    expect(stranger.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('sends the usual security headers', async () => {
    const response = await request(app).get('/health');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('requireRole', () => {
  it('answers 403 to a signed-in admin without the role, and lets the right role through', async () => {
    const probe = express();
    probe.use((req, res, next) => {
      res.locals['admin'] = { id: 'x', name: 'x', email: 'x', role: req.get('x-role'), sessionId: 'x' };
      next();
    });
    probe.get('/only-super', requireRole('SUPER_ADMIN'), (_req, res) => {
      res.json({ success: true });
    });
    probe.use(errorHandler);

    const ordinary = await request(probe).get('/only-super').set('x-role', 'ADMIN');
    expect(ordinary.status).toBe(403);
    expect(ordinary.body.error.code).toBe('FORBIDDEN');

    const superAdmin = await request(probe).get('/only-super').set('x-role', 'SUPER_ADMIN');
    expect(superAdmin.status).toBe(200);
  });
});

describe('password hashing', () => {
  it('verifies the right password and rejects others', async () => {
    const hash = await hashPassword('a-long-enough-password', { N: 2 ** 12, r: 8, p: 1 });

    expect(await verifyPassword('a-long-enough-password', hash)).toBe(true);
    expect(await verifyPassword('a-long-enough-passworD', hash)).toBe(false);
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('salts every hash and keeps its cost parameters inside it', async () => {
    const params = { N: 2 ** 12, r: 8, p: 1 };
    const first = await hashPassword('same-password-twice', params);
    const second = await hashPassword('same-password-twice', params);

    expect(first).not.toBe(second);
    expect(first.split('$').slice(0, 4)).toEqual(['scrypt', '4096', '8', '1']);
  });

  it('treats a malformed stored hash as a failed check, not an error', async () => {
    for (const stored of ['', 'plaintext', 'scrypt$1$1$1$a$b', 'bcrypt$x$y']) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('enforces the rules for a new password', () => {
    expect(validateNewPassword('short')).toMatch(/at least/);
    expect(validateNewPassword('aaaaaaaaaaaa')).toMatch(/repetitive/);
    expect(validateNewPassword('x'.repeat(200))).toMatch(/at most/);
    expect(validateNewPassword('a reasonable passphrase')).toBeNull();
  });
});
