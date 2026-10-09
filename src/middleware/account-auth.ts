import type { RequestHandler, Response } from 'express';

import { unauthenticated } from '../lib/errors.js';
import { type AccountContext, findAccountBySession, readBearerToken } from '../modules/accounts/account-session.js';

/** Lets a request through only with a valid customer sign-in token: 401 otherwise. */
export const requireAccount: RequestHandler = async (req, res, next) => {
  const token = readBearerToken(req);
  const account = token ? await findAccountBySession(token, new Date()) : null;
  if (!account) {
    throw unauthenticated();
  }
  res.locals['account'] = account;
  next();
};

/** The signed-in customer. Only call this behind `requireAccount`. */
export function getAccount(res: Response): AccountContext {
  const account = res.locals['account'] as AccountContext | undefined;
  if (!account) {
    throw unauthenticated();
  }
  return account;
}
