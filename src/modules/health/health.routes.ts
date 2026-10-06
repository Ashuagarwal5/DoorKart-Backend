import { Router } from 'express';

import { AppError } from '../../lib/errors.js';
import { sendSuccess } from '../../lib/http.js';
import { prisma } from '../../lib/prisma.js';

export const healthRouter = Router();

healthRouter.get('/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch (error) {
    console.error('[health] Database check failed', error);
    throw new AppError(503, 'SERVICE_UNAVAILABLE', 'The database is not reachable.');
  }

  sendSuccess(res, {
    status: 'ok',
    database: 'up',
    uptimeSeconds: Math.round(process.uptime()),
  });
});
