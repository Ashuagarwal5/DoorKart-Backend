import type { RequestHandler } from 'express';

/**
 * One line per request: method, path, status and duration. It deliberately logs the path
 * without the query string and never logs headers or bodies, so tracking tokens, phone
 * numbers and addresses stay out of the logs.
 */
export const requestLogger: RequestHandler = (req, res, next) => {
  const startedAt = performance.now();
  res.on('finish', () => {
    const durationMs = Math.round(performance.now() - startedAt);
    // originalUrl keeps the /api/v1 prefix that req.path loses inside a mounted router.
    const path = req.originalUrl.split('?')[0];
    console.log(`${req.method} ${path} ${res.statusCode} ${durationMs}ms`);
  });
  next();
};
