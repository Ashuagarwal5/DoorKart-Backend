import { type ChildProcess, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

import type EmbeddedPostgres from 'embedded-postgres';

/**
 * Shuts an embedded PostgreSQL down cleanly.
 *
 * On Windows the library's own stop() force-kills the server (`taskkill /f`), which skips
 * PostgreSQL's shutdown checkpoint and can leave orphaned worker processes. `pg_ctl stop`
 * asks the server to shut down properly instead.
 */
export async function stopPostgres(postgres: EmbeddedPostgres, dataDir: string): Promise<void> {
  if (process.platform !== 'win32') {
    await postgres.stop();
    return;
  }

  const require = createRequire(import.meta.url);
  // The package entry point is <package>/dist/index.js; the binaries sit in <package>/native/bin.
  const entryPoint = require.resolve('@embedded-postgres/windows-x64');
  const pgCtl = path.resolve(path.dirname(entryPoint), '..', 'native', 'bin', 'pg_ctl.exe');

  // "fast" disconnects clients and shuts down cleanly; -w waits until it has finished.
  execFileSync(pgCtl, ['stop', '-D', dataDir, '-m', 'fast', '-w'], { stdio: 'ignore' });

  // The library registers an exit hook that calls its own stop(), which would now wait
  // forever for a server that has already exited. It has no public way to say "already
  // stopped", so clear the handle its stop() checks before doing anything.
  (postgres as unknown as { process?: ChildProcess }).process = undefined;
}
