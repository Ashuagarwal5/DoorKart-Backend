import { Router } from 'express';

import { sendSuccess } from '../../lib/http.js';
import { idParamsSchema } from '../../lib/params.js';
import { getAccount } from '../../middleware/account-auth.js';
import {
  installationParams,
  registerDeviceBody,
  registerDevice,
  unregisterDevice,
} from './devices.service.js';
import { inboxQuery, listInbox, markAllRead, markRead, unreadCount } from './inbox.service.js';

/** Mounted under /api/v1/account, behind requireAccount: the account is always the caller. */
export const accountDevicesRouter = Router();

accountDevicesRouter.put('/', async (req, res) => {
  const input = registerDeviceBody.parse(req.body);
  sendSuccess(res, await registerDevice(getAccount(res).id, input));
});

accountDevicesRouter.delete('/:installationId', async (req, res) => {
  const { installationId } = installationParams.parse(req.params);
  await unregisterDevice(getAccount(res).id, installationId);
  sendSuccess(res, { removed: true });
});

export const accountNotificationsRouter = Router();

accountNotificationsRouter.get('/', async (req, res) => {
  sendSuccess(res, await listInbox(getAccount(res).id, inboxQuery.parse(req.query)));
});

accountNotificationsRouter.get('/unread-count', async (_req, res) => {
  sendSuccess(res, await unreadCount(getAccount(res).id));
});

accountNotificationsRouter.post('/read-all', async (_req, res) => {
  sendSuccess(res, await markAllRead(getAccount(res).id));
});

accountNotificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await markRead(getAccount(res).id, id));
});
