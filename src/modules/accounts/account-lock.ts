import type { TransactionClient } from '../../lib/prisma.js';

/** Serialize account creation and OTP limits for one email, including before an account exists. */
export async function lockAccountEmail(tx: TransactionClient, email: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${email}))::text`;
}
