import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

import { env } from '../../../config/env.js';
import { sendSuccess } from '../../../lib/http.js';
import { idParamsSchema } from '../../../lib/params.js';
import { getAdmin, requireRole } from '../../../middleware/admin-auth.js';
import { listDevices, listDevicesQuery } from '../../notifications/devices.service.js';
import {
  getHistoryDetail,
  historyQuery,
  listEvents,
  listHistory,
  listTargets,
  listVariables,
  overview,
  retryNotification,
  setEventEnabled,
} from '../../notifications/history.service.js';
import {
  getProviderConfigView,
  replaceCredentials,
  setProviderEnabled,
  testConnection,
} from '../../notifications/provider-config.service.js';
import {
  createTemplate,
  createTemplateBody,
  deleteTemplate,
  duplicateTemplate,
  getTemplate,
  listTemplates,
  listTemplatesQuery,
  previewBody,
  previewTemplate,
  sendTestNotification,
  setTemplateEnabled,
  testSendBody,
  updateTemplate,
  updateTemplateBody,
} from '../../notifications/templates.service.js';

// Mounted behind requireAdmin and the trusted-origin check. Template and history work is open
// to every staff role; credentials and test sends are SUPER_ADMIN only.
export const adminNotificationsRouter = Router();

adminNotificationsRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

const testLimiter = rateLimit({
  windowMs: 10 * 60_000,
  limit: 10,
  skip: () => env.isTest,
  standardHeaders: true,
  legacyHeaders: false,
});

const enabledBody = z.strictObject({ isEnabled: z.boolean() });

adminNotificationsRouter.get('/overview', async (_req, res) => sendSuccess(res, await overview()));
adminNotificationsRouter.get('/variables', (_req, res) => sendSuccess(res, listVariables()));
adminNotificationsRouter.get('/targets', (_req, res) => sendSuccess(res, listTargets()));

adminNotificationsRouter.get('/events', async (_req, res) => sendSuccess(res, await listEvents()));
adminNotificationsRouter.patch('/events/:key', async (req, res) => {
  const { key } = z.object({ key: z.string().trim().min(1).max(60) }).parse(req.params);
  const { isEnabled } = enabledBody.parse(req.body);
  sendSuccess(res, await setEventEnabled(key, isEnabled, getAdmin(res).id));
});

adminNotificationsRouter.get('/templates', async (req, res) => {
  sendSuccess(res, await listTemplates(listTemplatesQuery.parse(req.query)));
});
adminNotificationsRouter.post('/templates', async (req, res) => {
  sendSuccess(res, await createTemplate(createTemplateBody.parse(req.body), getAdmin(res).id), 201);
});
adminNotificationsRouter.post('/templates/preview', (req, res) => {
  sendSuccess(res, previewTemplate(previewBody.parse(req.body)));
});
adminNotificationsRouter.get('/templates/:id', async (req, res) => {
  sendSuccess(res, await getTemplate(idParamsSchema.parse(req.params).id));
});
adminNotificationsRouter.put('/templates/:id', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  sendSuccess(res, await updateTemplate(id, updateTemplateBody.parse(req.body), getAdmin(res).id));
});
adminNotificationsRouter.delete('/templates/:id', async (req, res) => {
  await deleteTemplate(idParamsSchema.parse(req.params).id);
  sendSuccess(res, { deleted: true });
});
adminNotificationsRouter.post('/templates/:id/duplicate', async (req, res) => {
  sendSuccess(res, await duplicateTemplate(idParamsSchema.parse(req.params).id, getAdmin(res).id), 201);
});
adminNotificationsRouter.post('/templates/:id/enabled', async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const { isEnabled } = enabledBody.parse(req.body);
  sendSuccess(res, await setTemplateEnabled(id, isEnabled, getAdmin(res).id));
});
adminNotificationsRouter.post('/templates/:id/test', requireRole('SUPER_ADMIN'), testLimiter, async (req, res) => {
  const { id } = idParamsSchema.parse(req.params);
  const { accountEmail } = testSendBody.parse(req.body);
  console.log(`[notifications] test send queued by admin ${getAdmin(res).id}`);
  sendSuccess(res, await sendTestNotification(id, accountEmail), 202);
});

adminNotificationsRouter.get('/history', async (req, res) => {
  sendSuccess(res, await listHistory(historyQuery.parse(req.query)));
});
adminNotificationsRouter.get('/history/:id', async (req, res) => {
  sendSuccess(res, await getHistoryDetail(idParamsSchema.parse(req.params).id));
});
adminNotificationsRouter.post('/history/:id/retry', async (req, res) => {
  sendSuccess(res, await retryNotification(idParamsSchema.parse(req.params).id));
});

adminNotificationsRouter.get('/devices', async (req, res) => {
  sendSuccess(res, await listDevices(listDevicesQuery.parse(req.query)));
});

const providerBody = z.strictObject({
  projectId: z.string().trim().min(1).max(100),
  serviceAccountJson: z.string().min(50).max(12_000),
  confirmReplace: z.boolean().default(false),
});

adminNotificationsRouter.use('/provider', requireRole('SUPER_ADMIN'));
adminNotificationsRouter.get('/provider', async (_req, res) => sendSuccess(res, await getProviderConfigView()));
adminNotificationsRouter.put('/provider/credentials', async (req, res) => {
  sendSuccess(res, await replaceCredentials(providerBody.parse(req.body), getAdmin(res).id));
});
adminNotificationsRouter.patch('/provider', async (req, res) => {
  const { isEnabled } = enabledBody.parse(req.body);
  sendSuccess(res, await setProviderEnabled(isEnabled, getAdmin(res).id));
});
adminNotificationsRouter.post('/provider/test', testLimiter, async (_req, res) => {
  sendSuccess(res, await testConnection());
});
