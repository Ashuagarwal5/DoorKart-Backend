/**
 * Starts a throwaway PostgreSQL for the test run and applies the real migrations to it,
 * so tests exercise the same schema, constraints and locking as production. Nothing here
 * touches the development database.
 */

import { execSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import os from 'node:os';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

import { stopPostgres } from '../scripts/postgres-control.js';

const DATABASE = 'buynest_test';

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => {
        if (address && typeof address === 'object') {
          resolve(address.port);
        } else {
          reject(new Error('Could not find a free port'));
        }
      });
    });
  });
}

export default async function setup() {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'buynest-test-pg-'));
  const port = await getFreePort();

  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: 'postgres',
    password: 'postgres',
    port,
    // Teardown below stops the server and removes the folder itself.
    persistent: true,
    onLog: () => {},
    onError: () => {},
  });

  await postgres.initialise();
  await postgres.start();
  await postgres.createDatabase(DATABASE);

  // Set before the test workers start, so the app under test connects to this database.
  process.env['DATABASE_URL'] = `postgresql://postgres:postgres@localhost:${port}/${DATABASE}`;
  process.env['NODE_ENV'] = 'test';
  // One allowed admin origin, so tests can check that other origins are refused.
  process.env['CORS_ORIGINS'] = 'http://localhost:3000';
  // Uploaded files go to a throwaway folder, never the real uploads directory.
  const uploadDir = mkdtempSync(path.join(os.tmpdir(), 'buynest-test-uploads-'));
  process.env['UPLOAD_DIR'] = uploadDir;

  execSync('npx prisma migrate deploy', {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: process.env,
    stdio: 'pipe',
  });

  return async () => {
    await stopPostgres(postgres, dataDir);
    // Windows keeps the data files locked for a moment after PostgreSQL exits, so retry.
    await rm(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(uploadDir, { recursive: true, force: true });
  };
}
