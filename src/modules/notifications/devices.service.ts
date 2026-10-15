import { z } from 'zod';

import { pageArgs, pageResult, paginationQuery } from '../../lib/pagination.js';
import { prisma } from '../../lib/prisma.js';

const MAX_DEVICES_PER_ACCOUNT = 10;

export const registerDeviceBody = z.strictObject({
  /** A random id the app generates once per install; it identifies the device across token refreshes. */
  installationId: z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9._-]+$/),
  token: z.string().trim().min(20).max(4096),
  platform: z.enum(['ANDROID', 'IOS']),
  appVersion: z.string().trim().max(40).nullish().transform((value) => value || null),
});
export const installationParams = z.object({
  installationId: z.string().trim().min(16).max(100).regex(/^[A-Za-z0-9._-]+$/),
});
export const listDevicesQuery = z.strictObject({ ...paginationQuery });

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code: unknown }).code === 'P2002';
}

/**
 * Registers or refreshes this install for the signed-in account. The account always comes
 * from the session. If the install (or its token) was registered to another account, it
 * moves: a phone can never keep receiving the previous owner's notifications.
 */
export async function registerDevice(accountId: string, input: z.infer<typeof registerDeviceBody>) {
  const run = () =>
    prisma.$transaction(async (tx) => {
      await tx.deviceRegistration.deleteMany({
        where: { token: input.token, installationId: { not: input.installationId } },
      });
      const now = new Date();
      const device = await tx.deviceRegistration.upsert({
        where: { installationId: input.installationId },
        create: {
          accountId, installationId: input.installationId, token: input.token,
          platform: input.platform, appVersion: input.appVersion, lastRegisteredAt: now,
        },
        update: {
          accountId, token: input.token, platform: input.platform, appVersion: input.appVersion,
          lastRegisteredAt: now, invalidatedAt: null, invalidReason: null,
        },
        select: { id: true, installationId: true, platform: true, lastRegisteredAt: true },
      });

      const surplus = await tx.deviceRegistration.findMany({
        where: { accountId },
        orderBy: { lastRegisteredAt: 'desc' },
        skip: MAX_DEVICES_PER_ACCOUNT,
        select: { id: true },
      });
      if (surplus.length > 0) {
        await tx.deviceRegistration.deleteMany({ where: { id: { in: surplus.map((row) => row.id) } } });
      }
      return device;
    });

  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) return run(); // two registrations raced; the second pass sees the first
    throw error;
  }
}

/** Idempotent and scoped to the caller: another account's install is never touched. */
export async function unregisterDevice(accountId: string, installationId: string): Promise<void> {
  await prisma.deviceRegistration.deleteMany({ where: { accountId, installationId } });
}

/** Admin view. Tokens are never returned; only a short suffix to tell devices apart. */
export async function listDevices(query: z.infer<typeof listDevicesQuery>) {
  const [total, rows] = await prisma.$transaction([
    prisma.deviceRegistration.count(),
    prisma.deviceRegistration.findMany({
      orderBy: [{ lastRegisteredAt: 'desc' }, { id: 'asc' }],
      ...pageArgs(query),
      select: {
        id: true, platform: true, appVersion: true, token: true, lastRegisteredAt: true,
        invalidatedAt: true, invalidReason: true, createdAt: true,
        account: { select: { id: true, email: true, fullName: true } },
      },
    }),
  ]);
  return pageResult(
    rows.map(({ token, ...row }) => ({ ...row, tokenSuffix: token.slice(-6) })),
    total,
    query
  );
}
