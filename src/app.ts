import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';

import { env } from './config/env.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { DEFAULT_LOGIN_RATE_LIMIT, type LoginRateLimit } from './modules/admin/auth/admin-auth.routes.js';
import { createAdminRouter } from './modules/admin/admin.routes.js';
import { catalogRouter } from './modules/catalog/catalog.routes.js';
import { healthRouter } from './modules/health/health.routes.js';
import { ordersRouter } from './modules/orders/orders.routes.js';
import { TRACKING_TOKEN_HEADER } from './modules/orders/orders.schemas.js';

const API_PREFIX = '/api/v1';

export type AppOptions = {
  /** Overridable so tests can exercise the limit without locking themselves out. */
  loginRateLimit?: LoginRateLimit;
};

export function createApp(options: AppOptions = {}): Express {
  const app = express();

  // Behind a reverse proxy, this makes req.ip the visitor's address (the login rate limit
  // keys on it). Left at 0 when the API is reached directly, so the header cannot be forged.
  app.set('trust proxy', env.trustProxyHops);

  app.use(helmet());
  app.use(
    cors({
      // With no origins configured, development allows any browser origin and production
      // allows none. Native mobile apps send no Origin header and are unaffected by CORS.
      origin: env.corsOrigins.length > 0 ? env.corsOrigins : !env.isProduction,
      // The admin panel signs in with a cookie, which browsers only send cross-origin when
      // the server opts in. The origin above is a list or a reflected value, never "*".
      credentials: true,
      allowedHeaders: ['Content-Type', TRACKING_TOKEN_HEADER],
      exposedHeaders: ['Idempotent-Replayed'],
    })
  );
  // Uploaded product pictures and videos. They are public (customers see them), served read-only
  // by exact file name, with range support so videos can seek. Helmet's default would stop the
  // admin panel and app, which live on other origins, from displaying them.
  app.use(
    '/uploads',
    (_req, res, next) => {
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      next();
    },
    express.static(env.uploadDir, { index: false, dotfiles: 'ignore', maxAge: '7d', immutable: true })
  );
  app.use(express.json({ limit: '100kb' }));

  if (!env.isTest) {
    app.use(requestLogger);
  }

  app.use(healthRouter);
  app.use(API_PREFIX, catalogRouter);
  app.use(API_PREFIX, ordersRouter);
  app.use(`${API_PREFIX}/admin`, createAdminRouter(options.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
