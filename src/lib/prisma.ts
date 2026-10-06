import { PrismaPg } from '@prisma/adapter-pg';

import { env } from '../config/env.js';
import { PrismaClient } from '../generated/prisma/client.js';

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: env.databaseUrl }),
});

/** The client inside `prisma.$transaction(async (tx) => ...)`. */
export type TransactionClient = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];
