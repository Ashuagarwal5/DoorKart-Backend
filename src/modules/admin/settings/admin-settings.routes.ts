import { Router } from 'express';
import { z } from 'zod';

import { sendSuccess } from '../../../lib/http.js';
import { normalizeEmail } from '../../../lib/email.js';
import { isSecretsKeyConfigured } from '../../../lib/secrets.js';
import { getAdmin, requireRole } from '../../../middleware/admin-auth.js';
import { sendMail } from '../../settings/mailer.js';
import { getSettingsView, updateSettings } from '../../settings/settings.service.js';

export const adminSettingsRouter = Router();

// Settings include credentials, so only a super admin may read or change them.
adminSettingsRouter.use(requireRole('SUPER_ADMIN'));

adminSettingsRouter.get('/', async (_req, res) => {
  sendSuccess(res, await getSettingsView(isSecretsKeyConfigured()));
});

const updateBodySchema = z.strictObject({
  // key -> new value. null clears it. A key that is left out is not touched.
  changes: z.record(z.string().min(1).max(100), z.string().max(500).nullable()),
});

adminSettingsRouter.patch('/', async (req, res) => {
  const { changes } = updateBodySchema.parse(req.body);
  const admin = getAdmin(res);
  const changed = await updateSettings(changes, admin.id);
  // Which settings changed, and who changed them. Never the values.
  console.log(`[settings] ${admin.email} changed: ${changed.join(', ') || 'nothing'}`);
  sendSuccess(res, await getSettingsView(isSecretsKeyConfigured()));
});

const testEmailBodySchema = z.strictObject({
  to: z.email().max(200).optional(),
});

/** Sends a short message with the saved settings, so a wrong password shows up now, not at a customer's sign-in. */
adminSettingsRouter.post('/email/test', async (req, res) => {
  const body = testEmailBodySchema.parse(req.body ?? {});
  const admin = getAdmin(res);
  const to = normalizeEmail(body.to ?? admin.email);
  await sendMail({
    to,
    subject: 'DoorKart test email',
    text: 'This is a test email from the DoorKart admin panel. Your email settings work.',
  });
  sendSuccess(res, { sentTo: to });
});
