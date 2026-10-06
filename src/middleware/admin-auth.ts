import type { RequestHandler, Response } from 'express';

import { env } from '../config/env.js';
import type { AdminRole } from '../generated/prisma/client.js';
import { AppError, forbidden, unauthenticated } from '../lib/errors.js';
import {
  type AdminContext,
  findActiveSession,
  readSessionToken,
} from '../modules/admin/auth/session.js';

/**
 * Lets a request through only with a valid admin session: 401 otherwise. Every admin
 * route sits behind this once, in the admin router, so no handler checks sign-in itself.
 */
export const requireAdmin: RequestHandler = async (req, res, next) => {
  const token = readSessionToken(req);
  const admin = token ? await findActiveSession(token, new Date()) : null;
  if (!admin) {
    throw unauthenticated();
  }
  res.locals['admin'] = admin;
  next();
};

/** The signed-in admin. Only call this behind `requireAdmin`. */
export function getAdmin(res: Response): AdminContext {
  const admin = res.locals['admin'] as AdminContext | undefined;
  if (!admin) {
    throw unauthenticated();
  }
  return admin;
}

/**
 * Restricts a route to some roles: 403 for a signed-in admin without one of them.
 * Nothing needs it yet (every admin may do everything), but it is the single place
 * role rules will go when a second kind of staff account exists.
 */
export function requireRole(...roles: AdminRole[]): RequestHandler {
  return (_req, res, next) => {
    if (!roles.includes(getAdmin(res).role)) {
      throw forbidden();
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF defence on top of SameSite cookies: a browser request that changes something must
 * come from one of the configured admin origins. Requests with no Origin header (curl,
 * server-to-server) are not browser form posts and pass. With CORS_ORIGINS unset,
 * development allows any origin and production allows none.
 */
export const requireTrustedOrigin: RequestHandler = (req, _res, next) => {
  const origin = req.get('origin');
  if (SAFE_METHODS.has(req.method) || !origin) {
    next();
    return;
  }

  const isAllowed = env.corsOrigins.length > 0 ? env.corsOrigins.includes(origin) : !env.isProduction;
  if (!isAllowed) {
    throw new AppError(403, 'ORIGIN_NOT_ALLOWED', 'This request did not come from the admin panel.');
  }
  next();
};
