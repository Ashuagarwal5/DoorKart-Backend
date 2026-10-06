/**
 * Creates the first admin (or resets one's password). Run it on the machine that has the
 * database; there is deliberately no API for it.
 *
 *   ADMIN_SEED_EMAIL=owner@example.com ADMIN_SEED_PASSWORD=... ADMIN_SEED_NAME="Owner" \
 *     npm run admin:create
 *
 * The values come from the environment (or Backend/.env), never from the repository, and
 * there is no default password. If the account already exists nothing changes, unless
 * `--reset-password` is given: then the password is replaced and the admin is signed out
 * everywhere. The password is never printed.
 */

import 'dotenv/config';

import { PrismaPg } from '@prisma/adapter-pg';
import { z } from 'zod';

import { PrismaClient } from '../src/generated/prisma/client.js';
import { normalizeEmail } from '../src/lib/email.js';
import { hashPassword, validateNewPassword } from '../src/modules/admin/auth/password.js';

const inputSchema = z.object({
  ADMIN_SEED_EMAIL: z.email('ADMIN_SEED_EMAIL must be a valid email address'),
  ADMIN_SEED_PASSWORD: z.string().min(1, 'ADMIN_SEED_PASSWORD is required'),
  ADMIN_SEED_NAME: z.string().trim().min(1, 'ADMIN_SEED_NAME is required').max(100),
});

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set.');
  }

  const parsed = inputSchema.safeParse(process.env);
  if (!parsed.success) {
    throw new Error(parsed.error.issues.map((issue) => issue.message).join('\n'));
  }
  const { ADMIN_SEED_EMAIL, ADMIN_SEED_PASSWORD, ADMIN_SEED_NAME } = parsed.data;

  const passwordProblem = validateNewPassword(ADMIN_SEED_PASSWORD);
  if (passwordProblem) {
    throw new Error(passwordProblem);
  }

  const email = normalizeEmail(ADMIN_SEED_EMAIL);
  const shouldReset = process.argv.includes('--reset-password');
  const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });

  try {
    const existing = await prisma.adminUser.findUnique({ where: { email } });

    if (existing && !shouldReset) {
      console.log(`An admin with the email ${email} already exists. Nothing was changed.`);
      console.log('To replace its password, run again with --reset-password.');
      return;
    }

    const passwordHash = await hashPassword(ADMIN_SEED_PASSWORD);

    if (existing) {
      await prisma.$transaction([
        prisma.adminUser.update({
          where: { id: existing.id },
          data: { passwordHash, isActive: true },
        }),
        prisma.adminSession.deleteMany({ where: { adminUserId: existing.id } }),
      ]);
      console.log(`Password reset for ${email}. Every session for this account was signed out.`);
      return;
    }

    await prisma.adminUser.create({
      data: { email, name: ADMIN_SEED_NAME, passwordHash, role: 'SUPER_ADMIN' },
    });
    console.log(`Created the admin ${email} (SUPER_ADMIN).`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
