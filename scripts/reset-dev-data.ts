/**
 * DEVELOPMENT ONLY: deletes every order, customer and stock movement, and releases all
 * reserved stock, so a developer can start testing the order flow from a clean slate.
 * Categories, products, images, delivery areas and stock levels are left as they are.
 *
 *   npm run db:reset-dev -- --yes
 *
 * It refuses to run unless the database is on this machine and NODE_ENV is not
 * "production". It cannot be pointed at a hosted database by accident.
 */

import 'dotenv/config';

import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from '../src/generated/prisma/client.js';

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '::1', '[::1]'];

/** Throws unless it is safe to wipe orders in the database `databaseUrl` points to. */
export function assertSafeToReset(databaseUrl: string | undefined, nodeEnv: string | undefined) {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to reset data: NODE_ENV is "production".');
  }
  if (!databaseUrl) {
    throw new Error('Refusing to reset data: DATABASE_URL is not set.');
  }

  let host: string;
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    throw new Error('Refusing to reset data: DATABASE_URL is not a valid URL.');
  }
  if (!LOCAL_HOSTS.includes(host)) {
    // The host is named so the developer can see what they pointed at, but nothing else
    // from the URL (it contains the password).
    throw new Error(`Refusing to reset data: the database host "${host}" is not on this machine.`);
  }
}

/** Removes order data and releases reservations. Returns how many orders were removed. */
export async function resetOrderData(prisma: PrismaClient): Promise<number> {
  const orderCount = await prisma.order.count();

  await prisma.$transaction([
    prisma.$executeRaw`
      TRUNCATE "InventoryTransaction", "OrderStatusHistory", "OrderItem", "Order", "OrderCounter", "Customer"
      CASCADE
    `,
    // With every order gone nothing is holding stock any more.
    prisma.$executeRaw`UPDATE "Product" SET "reservedQuantity" = 0, "updatedAt" = NOW() WHERE "reservedQuantity" <> 0`,
  ]);

  return orderCount;
}

async function main() {
  const databaseUrl = process.env['DATABASE_URL'];
  assertSafeToReset(databaseUrl, process.env['NODE_ENV']);

  if (!process.argv.includes('--yes')) {
    console.log('This deletes ALL orders and customers in the local development database.');
    console.log('Run again with --yes to confirm:  npm run db:reset-dev -- --yes');
    return;
  }

  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: databaseUrl }),
  });
  try {
    const removed = await resetOrderData(prisma);
    console.log(`Removed ${removed} order(s) and released all reserved stock.`);
  } finally {
    await prisma.$disconnect();
  }
}

const isRunDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isRunDirectly) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
