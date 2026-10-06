import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';

import { verifyPassword } from '../src/modules/admin/auth/password.js';
import { app, prisma, resetDatabase } from './helpers.js';

const run = promisify(execFile);
const backendDir = path.resolve(import.meta.dirname, '..');
const tsxCli = path.join(backendDir, 'node_modules', 'tsx', 'dist', 'cli.mjs');

/** Runs the real script as a separate process, against the test database. */
async function createAdmin(
  env: Record<string, string | undefined>,
  args: string[] = []
): Promise<{ code: number; output: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [tsxCli, 'scripts/create-admin.ts', ...args], {
      cwd: backendDir,
      env: { ...process.env, ADMIN_SEED_EMAIL: '', ADMIN_SEED_PASSWORD: '', ADMIN_SEED_NAME: '', ...env },
    });
    return { code: 0, output: stdout + stderr };
  } catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    return { code: failure.code ?? 1, output: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

const SEED = {
  ADMIN_SEED_EMAIL: 'Owner@Shop.Example',
  ADMIN_SEED_PASSWORD: 'a-test-only-passphrase',
  ADMIN_SEED_NAME: 'Shop Owner',
};

beforeEach(async () => {
  await resetDatabase();
});

describe('npm run admin:create', () => {
  it('creates the first admin as SUPER_ADMIN, who can then sign in', async () => {
    const result = await createAdmin(SEED);

    expect(result.code).toBe(0);
    expect(result.output).toMatch(/Created the admin owner@shop\.example/);
    // The password is never printed.
    expect(result.output).not.toContain(SEED.ADMIN_SEED_PASSWORD);

    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@shop.example' } });
    expect(admin).toMatchObject({ name: 'Shop Owner', role: 'SUPER_ADMIN', isActive: true });
    expect(admin.passwordHash).not.toContain(SEED.ADMIN_SEED_PASSWORD);
    expect(await verifyPassword(SEED.ADMIN_SEED_PASSWORD, admin.passwordHash)).toBe(true);

    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'owner@shop.example', password: SEED.ADMIN_SEED_PASSWORD });
    expect(login.status).toBe(200);
  });

  it('leaves an existing admin alone when run again', async () => {
    await createAdmin(SEED);
    const before = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@shop.example' } });

    const again = await createAdmin({ ...SEED, ADMIN_SEED_PASSWORD: 'a-different-passphrase', ADMIN_SEED_NAME: 'Someone Else' });

    expect(again.code).toBe(0);
    expect(again.output).toMatch(/already exists/);
    const after = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@shop.example' } });
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.name).toBe('Shop Owner');
  });

  it('resets a password only when asked, and signs the admin out everywhere', async () => {
    await createAdmin(SEED);
    const login = await request(app)
      .post('/api/v1/admin/auth/login')
      .send({ email: 'owner@shop.example', password: SEED.ADMIN_SEED_PASSWORD });
    expect(login.status).toBe(200);
    expect(await prisma.adminSession.count()).toBe(1);

    const reset = await createAdmin({ ...SEED, ADMIN_SEED_PASSWORD: 'a-brand-new-passphrase' }, ['--reset-password']);

    expect(reset.code).toBe(0);
    expect(reset.output).toMatch(/Password reset/);
    expect(await prisma.adminSession.count()).toBe(0);
    const admin = await prisma.adminUser.findUniqueOrThrow({ where: { email: 'owner@shop.example' } });
    expect(await verifyPassword('a-brand-new-passphrase', admin.passwordHash)).toBe(true);
    expect(await verifyPassword(SEED.ADMIN_SEED_PASSWORD, admin.passwordHash)).toBe(false);
  });

  it('refuses weak, missing or invalid input and creates nothing', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ ...SEED, ADMIN_SEED_PASSWORD: 'short' }, /at least/],
      [{ ...SEED, ADMIN_SEED_PASSWORD: 'aaaaaaaaaaaaaaa' }, /repetitive/],
      [{ ...SEED, ADMIN_SEED_PASSWORD: '' }, /ADMIN_SEED_PASSWORD is required/],
      [{ ...SEED, ADMIN_SEED_EMAIL: 'not-an-email' }, /valid email/],
      [{ ...SEED, ADMIN_SEED_NAME: '' }, /ADMIN_SEED_NAME is required/],
    ];
    for (const [env, message] of cases) {
      const result = await createAdmin(env);
      expect(result.code, JSON.stringify(env)).not.toBe(0);
      expect(result.output).toMatch(message);
      expect(result.output).not.toContain(SEED.ADMIN_SEED_PASSWORD);
    }
    expect(await prisma.adminUser.count()).toBe(0);
  });
});
