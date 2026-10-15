import { z } from 'zod';

import { AppError, conflict } from '../../lib/errors.js';
import { prisma } from '../../lib/prisma.js';
import { decryptSecret, encryptSecret, isSecretsKeyConfigured } from '../../lib/secrets.js';
import { getTransport, type ServiceAccount } from './fcm.js';

const CONFIG_ID = 'fcm';

/** What an admin screen may see. The credential itself is never part of it. */
export type ProviderConfigView = {
  secretsKeyConfigured: boolean;
  configured: boolean;
  isEnabled: boolean;
  projectId: string | null;
  clientEmail: string | null;
  /** Last 6 characters of the private key id, enough to recognise which key is installed. */
  privateKeyIdSuffix: string | null;
  lastTestAt: Date | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  lastSuccessAt: Date | null;
  lastFailureAt: Date | null;
  lastFailureMessage: string | null;
  updatedAt: Date | null;
};

export async function getProviderConfigView(): Promise<ProviderConfigView> {
  const row = await prisma.notificationProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  return {
    secretsKeyConfigured: isSecretsKeyConfigured(),
    configured: Boolean(row?.credentialEncrypted),
    isEnabled: row?.isEnabled ?? false,
    projectId: row?.projectId ?? null,
    clientEmail: row?.clientEmail ?? null,
    privateKeyIdSuffix: row?.privateKeyId ? row.privateKeyId.slice(-6) : null,
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestMessage: row?.lastTestMessage ?? null,
    lastSuccessAt: row?.lastSuccessAt ?? null,
    lastFailureAt: row?.lastFailureAt ?? null,
    lastFailureMessage: row?.lastFailureMessage ?? null,
    updatedAt: row?.updatedAt ?? null,
  };
}

const serviceAccountSchema = z.object({
  type: z.literal('service_account'),
  project_id: z.string().min(1).max(100),
  private_key_id: z.string().max(100).optional(),
  private_key: z.string().min(100).max(10_000).startsWith('-----BEGIN PRIVATE KEY-----'),
  client_email: z.email().max(200),
});

function validationError(field: string, message: string): AppError {
  return new AppError(400, 'VALIDATION_ERROR', 'The Firebase credentials are not valid.', [{ field, message }]);
}

/** Parses and checks a pasted service-account file. Returns the credential, or throws a field error. */
export function parseServiceAccount(json: string, expectedProjectId: string): ServiceAccount {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw validationError('serviceAccountJson', 'This is not valid JSON. Paste the whole downloaded file.');
  }
  const parsed = serviceAccountSchema.safeParse(raw);
  if (!parsed.success) {
    throw validationError(
      'serviceAccountJson',
      'This is not a Firebase service account key file (it needs type, project_id, client_email and private_key).'
    );
  }
  if (parsed.data.project_id !== expectedProjectId) {
    throw validationError('projectId', 'The project ID does not match the project in the key file.');
  }
  return {
    projectId: parsed.data.project_id,
    clientEmail: parsed.data.client_email,
    privateKey: parsed.data.private_key,
    privateKeyId: parsed.data.private_key_id ?? null,
  };
}

/** The stored credential, decrypted. Server-side use only; null when unset or unreadable. */
export async function loadCredential(): Promise<{ enabled: boolean; account: ServiceAccount } | null> {
  const row = await prisma.notificationProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (!row?.credentialEncrypted || !row.projectId || !row.clientEmail) return null;
  const privateKey = decryptSecret(row.credentialEncrypted);
  if (!privateKey) return null;
  return {
    enabled: row.isEnabled,
    account: {
      projectId: row.projectId,
      clientEmail: row.clientEmail,
      privateKey,
      privateKeyId: row.privateKeyId,
    },
  };
}

function describeFailure(category: string): string {
  switch (category) {
    case 'AUTH':
      return 'Google rejected the credentials. Check the key file and that the Firebase Cloud Messaging API is enabled.';
    case 'NETWORK':
      return 'Could not reach Firebase. Check the server’s internet access and try again.';
    default:
      return `Firebase did not accept the test (${category}).`;
  }
}

/**
 * Saves new credentials, but only after Google has accepted them. A key that does not work
 * never replaces one that does. Replacing an existing credential must be confirmed.
 */
export async function replaceCredentials(
  input: { projectId: string; serviceAccountJson: string; confirmReplace: boolean },
  adminId: string
): Promise<ProviderConfigView> {
  if (!isSecretsKeyConfigured()) {
    throw new AppError(503, 'SECRETS_NOT_CONFIGURED', 'The server has no SECRETS_KEY yet, so credentials cannot be stored safely.');
  }
  const existing = await prisma.notificationProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (existing?.credentialEncrypted && !input.confirmReplace) {
    throw conflict('PUSH_NOT_CONFIGURED', 'Credentials are already saved. Confirm to replace them.');
  }

  const account = parseServiceAccount(input.serviceAccountJson, input.projectId.trim());
  const result = await getTransport().verify(account);
  if (!result.ok && result.category !== 'INVALID_PAYLOAD') {
    throw validationError('serviceAccountJson', describeFailure(result.category));
  }

  const data = {
    projectId: account.projectId,
    clientEmail: account.clientEmail,
    privateKeyId: account.privateKeyId,
    credentialEncrypted: encryptSecret(account.privateKey),
    lastTestAt: new Date(),
    lastTestOk: true,
    lastTestMessage: 'Credentials accepted when saved.',
    updatedByAdminId: adminId,
  };
  await prisma.notificationProviderConfig.upsert({
    where: { id: CONFIG_ID },
    create: { id: CONFIG_ID, ...data },
    update: data,
  });
  console.log(`[notifications] credentials ${existing?.credentialEncrypted ? 'replaced' : 'saved'} by admin ${adminId}`);
  return getProviderConfigView();
}

export async function setProviderEnabled(isEnabled: boolean, adminId: string): Promise<ProviderConfigView> {
  const row = await prisma.notificationProviderConfig.findUnique({ where: { id: CONFIG_ID } });
  if (isEnabled && !row?.credentialEncrypted) {
    throw conflict('PUSH_NOT_CONFIGURED', 'Save Firebase credentials before enabling push notifications.');
  }
  if (row) {
    await prisma.notificationProviderConfig.update({
      where: { id: CONFIG_ID },
      data: { isEnabled, updatedByAdminId: adminId },
    });
  }
  return getProviderConfigView();
}

/** Re-checks the saved credentials against Google and records the outcome. */
export async function testConnection(): Promise<ProviderConfigView> {
  const credential = await loadCredential();
  if (!credential) {
    throw conflict('PUSH_NOT_CONFIGURED', 'Firebase credentials are not saved, or cannot be read with the current SECRETS_KEY.');
  }
  const result = await getTransport().verify(credential.account);
  const ok = result.ok || result.category === 'INVALID_PAYLOAD';
  await prisma.notificationProviderConfig.update({
    where: { id: CONFIG_ID },
    data: {
      lastTestAt: new Date(),
      lastTestOk: ok,
      lastTestMessage: ok ? 'Connection to Firebase succeeded.' : describeFailure(result.ok ? 'UNKNOWN' : result.category),
    },
  });
  return getProviderConfigView();
}

/** Best-effort bookkeeping from the dispatcher; never allowed to fail a send. */
export async function recordSendOutcome(ok: boolean, message: string | null): Promise<void> {
  try {
    await prisma.notificationProviderConfig.updateMany({
      where: { id: CONFIG_ID },
      data: ok
        ? { lastSuccessAt: new Date() }
        : { lastFailureAt: new Date(), lastFailureMessage: message?.slice(0, 200) ?? null },
    });
  } catch {
    // Status display only.
  }
}
