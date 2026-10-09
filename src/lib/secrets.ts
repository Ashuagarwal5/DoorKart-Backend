import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from 'node:crypto';

import { env } from '../config/env.js';
import { AppError } from './errors.js';

/**
 * Everything that needs the master key lives here: encrypting saved secrets (the email
 * password) and keyed hashing of sign-in codes. Each use gets its own key derived from the
 * master key, so a leak of one does not expose the other.
 */

const VERSION = 'v1';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function masterKey(): Buffer {
  if (!env.secretsKey) {
    throw new AppError(
      503,
      'SECRETS_NOT_CONFIGURED',
      'The server has no SECRETS_KEY yet. Run "npm run secrets:key" in the Backend folder, add the line to .env, and restart the API.'
    );
  }
  return env.secretsKey;
}

function derive(purpose: string): Buffer {
  return Buffer.from(hkdfSync('sha256', masterKey(), Buffer.alloc(0), `doorkart:${purpose}`, 32));
}

export function isSecretsKeyConfigured(): boolean {
  return env.secretsKey !== null;
}

/** AES-256-GCM. The output is "v1:" plus base64 of iv, auth tag and ciphertext. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', derive('settings'), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `${VERSION}:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
}

/** Returns null if the value was encrypted with a different key or has been altered. */
export function decryptSecret(stored: string): string | null {
  if (!stored.startsWith(`${VERSION}:`)) {
    return null;
  }
  try {
    const raw = Buffer.from(stored.slice(VERSION.length + 1), 'base64');
    const iv = raw.subarray(0, IV_BYTES);
    const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const encrypted = raw.subarray(IV_BYTES + TAG_BYTES);
    const decipher = createDecipheriv('aes-256-gcm', derive('settings'), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

/** A keyed hash for sign-in codes: without the master key a leaked table cannot be brute-forced. */
export function hashOtp(email: string, code: string): string {
  return createHmac('sha256', derive('otp')).update(`${email}\n${code}`).digest('hex');
}
