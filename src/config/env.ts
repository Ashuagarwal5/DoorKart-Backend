import 'dotenv/config';

import path from 'node:path';

import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4000),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  CORS_ORIGINS: z.string().default(''),
  /** How long an admin stays signed in. There is no sliding extension: after this, sign in again. */
  ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(168).default(12),
  /**
   * How many reverse proxies sit in front of the API (0 when none). Needed so the login
   * rate limit sees each visitor's address rather than the proxy's.
   */
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  /** Where uploaded product pictures and videos are stored. Relative paths start at the Backend folder. */
  UPLOAD_DIR: z.string().trim().min(1).default('uploads'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Only variable names and reasons are printed, never the values themselves.
  const problems = parsed.error.issues.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`);
  console.error(`Invalid environment configuration:\n${problems.join('\n')}`);
  process.exit(1);
}

export const env = {
  nodeEnv: parsed.data.NODE_ENV,
  isProduction: parsed.data.NODE_ENV === 'production',
  isTest: parsed.data.NODE_ENV === 'test',
  port: parsed.data.PORT,
  databaseUrl: parsed.data.DATABASE_URL,
  corsOrigins: parsed.data.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  adminSessionTtlMs: parsed.data.ADMIN_SESSION_TTL_HOURS * 60 * 60 * 1000,
  trustProxyHops: parsed.data.TRUST_PROXY_HOPS,
  uploadDir: path.resolve(parsed.data.UPLOAD_DIR),
};
