import { createApp } from './app.js';
import { env } from './config/env.js';
import { prisma } from './lib/prisma.js';

const server = createApp().listen(env.port, () => {
  console.log(`BuyNest API listening on http://localhost:${env.port} (${env.nodeEnv})`);
});

server.on('error', (error) => {
  console.error('The API server could not start', error);
  process.exit(1);
});

let isShuttingDown = false;

/** Stop accepting requests, let in-flight ones finish, then release database connections. */
function shutdown(signal: string): void {
  if (isShuttingDown) {
    return;
  }
  isShuttingDown = true;
  console.log(`${signal} received, shutting down`);

  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
