/**
 * Runs a local PostgreSQL for development without Docker or a system install.
 * `embedded-postgres` ships real PostgreSQL binaries through npm; data lives in ./.pgdata.
 *
 * This is a convenience only. The API just needs DATABASE_URL, so Docker, a system
 * PostgreSQL or a hosted database work equally well.
 */

import { existsSync } from 'node:fs';
import path from 'node:path';

import EmbeddedPostgres from 'embedded-postgres';

import { stopPostgres } from './postgres-control.js';

const PORT = Number(process.env['DEV_DB_PORT'] ?? 5433);
const DATABASE = 'buynest';
// Local-only credentials for a database that listens on localhost.
const USER = 'postgres';
const PASSWORD = 'postgres';

// DEV_DB_DIR lets a second, throwaway database run beside the normal one (with DEV_DB_PORT).
const dataDir = process.env['DEV_DB_DIR']
  ? path.resolve(process.env['DEV_DB_DIR'])
  : path.resolve(import.meta.dirname, '..', '.pgdata');

const postgres = new EmbeddedPostgres({
  databaseDir: dataDir,
  user: USER,
  password: PASSWORD,
  port: PORT,
  persistent: true,
  onLog: () => {},
  onError: (error) => console.error('[dev-db]', error),
});

if (!existsSync(path.join(dataDir, 'PG_VERSION'))) {
  console.log(`[dev-db] Creating a new database cluster in ${dataDir} ...`);
  await postgres.initialise();
}

await postgres.start();

const client = postgres.getPgClient();
await client.connect();
const existing = await client.query('SELECT 1 FROM pg_database WHERE datname = $1', [DATABASE]);
if (existing.rowCount === 0) {
  await client.query(`CREATE DATABASE ${DATABASE}`);
}
await client.end();

console.log(`[dev-db] PostgreSQL is running on localhost:${PORT} (database "${DATABASE}")`);
console.log(`[dev-db] DATABASE_URL=postgresql://${USER}:${PASSWORD}@localhost:${PORT}/${DATABASE}`);
console.log('[dev-db] Press Ctrl+C to stop.');

let isStopping = false;
const stop = async () => {
  if (isStopping) {
    return;
  }
  isStopping = true;
  console.log('\n[dev-db] Stopping PostgreSQL ...');
  await stopPostgres(postgres, dataDir);
  process.exit(0);
};

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
