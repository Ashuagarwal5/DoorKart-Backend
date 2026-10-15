import { Router } from 'express';
import { z } from 'zod';

import { sendSuccess } from '../../lib/http.js';
import { getAccount } from '../../middleware/account-auth.js';
import { accountAddressBodySchema, accountAddressParamsSchema } from './account-addresses.schemas.js';
import {
  createAccountAddress, deleteAccountAddress, listAccountAddresses,
  setDefaultAccountAddress, updateAccountAddress,
} from './account-addresses.service.js';

/** Mounted behind accountRouter's requireAccount middleware. */
export const accountAddressesRouter = Router();

accountAddressesRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

accountAddressesRouter.get('/', async (req, res) => {
  z.strictObject({}).parse(req.query);
  sendSuccess(res, await listAccountAddresses(getAccount(res).id));
});

accountAddressesRouter.post('/', async (req, res) => {
  const input = accountAddressBodySchema.parse(req.body);
  sendSuccess(res, await createAccountAddress(getAccount(res).id, input), 201);
});

accountAddressesRouter.patch('/:id', async (req, res) => {
  const { id } = accountAddressParamsSchema.parse(req.params);
  const input = accountAddressBodySchema.parse(req.body);
  sendSuccess(res, await updateAccountAddress(getAccount(res).id, id, input));
});

accountAddressesRouter.delete('/:id', async (req, res) => {
  const { id } = accountAddressParamsSchema.parse(req.params);
  z.strictObject({}).parse(req.body ?? {});
  sendSuccess(res, await deleteAccountAddress(getAccount(res).id, id));
});

accountAddressesRouter.post('/:id/default', async (req, res) => {
  const { id } = accountAddressParamsSchema.parse(req.params);
  z.strictObject({}).parse(req.body ?? {});
  sendSuccess(res, await setDefaultAccountAddress(getAccount(res).id, id));
});
