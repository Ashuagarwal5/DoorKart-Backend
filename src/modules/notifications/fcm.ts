import { JWT } from 'google-auth-library';

/**
 * Firebase Cloud Messaging HTTP v1 sender. Authentication is a Google service account
 * (OAuth2), never a legacy server key. The transport is replaceable so tests never reach
 * Google. Nothing here logs or returns the private key.
 */

export type ServiceAccount = {
  projectId: string;
  clientEmail: string;
  privateKey: string;
  privateKeyId: string | null;
};

export type PushMessage = {
  token: string;
  title: string;
  body: string;
  imageUrl?: string | null;
  /** String values only: FCM data payloads cannot carry nested JSON. */
  data: Record<string, string>;
};

export type PushFailureCategory =
  | 'UNREGISTERED'
  | 'INVALID_TOKEN'
  | 'SENDER_MISMATCH'
  | 'INVALID_PAYLOAD'
  | 'AUTH'
  | 'QUOTA'
  | 'UNAVAILABLE'
  | 'NETWORK'
  | 'UNKNOWN';

export type PushResult =
  | { ok: true; messageId: string }
  | {
      ok: false;
      category: PushFailureCategory;
      /** Retrying the same message to the same device cannot succeed. */
      permanent: boolean;
      /** The device registration itself is dead and should stop receiving pushes. */
      deviceInvalid: boolean;
      message: string;
    };

export interface PushTransport {
  send(account: ServiceAccount, message: PushMessage): Promise<PushResult>;
  /** Proves the credentials work without delivering anything (FCM validate_only). */
  verify(account: ServiceAccount): Promise<PushResult>;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const REQUEST_TIMEOUT_MS = 10_000;

const clients = new Map<string, JWT>();

function clientFor(account: ServiceAccount): JWT {
  const key = `${account.projectId}:${account.clientEmail}:${account.privateKeyId ?? ''}`;
  let client = clients.get(key);
  if (!client) {
    client = new JWT({ email: account.clientEmail, key: account.privateKey, scopes: [SCOPE] });
    clients.set(key, client);
  }
  return client;
}

type FcmErrorBody = {
  error?: { code?: number; status?: string; message?: string; details?: { errorCode?: string }[] };
};

function classify(status: number, body: FcmErrorBody): PushResult & { ok: false } {
  const error = body.error ?? {};
  const code = error.details?.find((detail) => detail.errorCode)?.errorCode ?? error.status ?? '';
  const text = JSON.stringify(error).slice(0, 2000);
  const base = { message: `${status} ${code || 'ERROR'}` };

  if (code === 'UNREGISTERED' || status === 404) {
    return { ok: false, category: 'UNREGISTERED', permanent: true, deviceInvalid: true, ...base };
  }
  if (code === 'SENDER_ID_MISMATCH') {
    return { ok: false, category: 'SENDER_MISMATCH', permanent: true, deviceInvalid: true, ...base };
  }
  if (code === 'INVALID_ARGUMENT' || status === 400) {
    const tokenProblem = text.includes('message.token') || text.includes('registration token');
    return tokenProblem
      ? { ok: false, category: 'INVALID_TOKEN', permanent: true, deviceInvalid: true, ...base }
      : { ok: false, category: 'INVALID_PAYLOAD', permanent: true, deviceInvalid: false, ...base };
  }
  if (status === 401 || status === 403 || code === 'UNAUTHENTICATED' || code === 'PERMISSION_DENIED') {
    return { ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, ...base };
  }
  if (status === 429 || code === 'QUOTA_EXCEEDED') {
    return { ok: false, category: 'QUOTA', permanent: false, deviceInvalid: false, ...base };
  }
  if (status >= 500 || code === 'UNAVAILABLE' || code === 'INTERNAL') {
    return { ok: false, category: 'UNAVAILABLE', permanent: false, deviceInvalid: false, ...base };
  }
  return { ok: false, category: 'UNKNOWN', permanent: false, deviceInvalid: false, ...base };
}

async function post(account: ServiceAccount, message: Record<string, unknown>, validateOnly: boolean): Promise<PushResult> {
  let accessToken: string | null | undefined;
  try {
    accessToken = (await clientFor(account).getAccessToken()).token;
  } catch {
    // The reason is not logged: it can echo parts of the credential file.
    return { ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, message: 'Could not obtain a Google access token.' };
  }
  if (!accessToken) {
    return { ok: false, category: 'AUTH', permanent: true, deviceInvalid: false, message: 'Could not obtain a Google access token.' };
  }

  try {
    const response = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.projectId)}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ validate_only: validateOnly, message }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = (await response.json().catch(() => ({}))) as FcmErrorBody & { name?: string };
    if (response.ok) {
      return { ok: true, messageId: body.name ?? 'validated' };
    }
    return classify(response.status, body);
  } catch {
    return { ok: false, category: 'NETWORK', permanent: false, deviceInvalid: false, message: 'Could not reach FCM.' };
  }
}

export const httpTransport: PushTransport = {
  send: (account, message) =>
    post(
      account,
      {
        token: message.token,
        notification: { title: message.title, body: message.body, ...(message.imageUrl ? { image: message.imageUrl } : {}) },
        data: message.data,
        android: { priority: 'HIGH', notification: { channel_id: 'default' } },
      },
      false
    ),
  verify: (account) => post(account, { topic: 'doorkart-connection-test', data: { check: '1' } }, true),
};

let transport: PushTransport = httpTransport;

export const getTransport = (): PushTransport => transport;

/** Tests install a fake so no real notification can be sent. Pass null to restore the real one. */
export function setPushTransportForTests(replacement: PushTransport | null): void {
  transport = replacement ?? httpTransport;
}
