import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing with scrypt from Node's own crypto module: an established, memory-hard
 * algorithm, not a home-made one. The cost parameters travel inside each stored hash:
 *
 *   scrypt$N$r$p$salt$hash      (salt and hash are base64)
 *
 * so the cost can be raised later and old hashes keep verifying. The defaults are OWASP's
 * recommended scrypt settings (N=2^17, r=8, p=1: about 128 MiB of memory per hash).
 */

export type ScryptParams = { N: number; r: number; p: number };

export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 2 ** 17, r: 8, p: 1 };

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
// scrypt needs about 128 * N * r bytes; the limit just has to be comfortably above that.
const MAX_MEMORY_BYTES = 512 * 1024 * 1024;

export const MIN_PASSWORD_LENGTH = 10;
export const MAX_PASSWORD_LENGTH = 128;

function deriveKey(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { N: params.N, r: params.r, p: params.p, maxmem: MAX_MEMORY_BYTES },
      (error, key) => (error ? reject(error) : resolve(key))
    );
  });
}

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS
): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const key = await deriveKey(password, salt, params);
  return ['scrypt', params.N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join(
    '$'
  );
}

function parseHash(stored: string) {
  const [scheme, n, r, p, salt, key] = stored.split('$');
  if (scheme !== 'scrypt' || !n || !r || !p || !salt || !key) {
    return null;
  }
  const params = { N: Number(n), r: Number(r), p: Number(p) };
  const isSane =
    Number.isInteger(params.N) &&
    params.N >= 2 ** 10 &&
    params.N <= 2 ** 20 &&
    (params.N & (params.N - 1)) === 0 &&
    Number.isInteger(params.r) &&
    params.r >= 1 &&
    params.r <= 16 &&
    Number.isInteger(params.p) &&
    params.p >= 1 &&
    params.p <= 4;
  return isSane ? { params, salt: Buffer.from(salt, 'base64'), key: Buffer.from(key, 'base64') } : null;
}

/** True only for the right password. A malformed stored hash is simply a failed check. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parsed = parseHash(stored);
  if (!parsed) {
    return false;
  }
  const candidate = await deriveKey(password, parsed.salt, parsed.params);
  return candidate.length === parsed.key.length && timingSafeEqual(candidate, parsed.key);
}

let dummyHash: Promise<string> | undefined;

/**
 * Checks `password` against a throwaway hash. Used when the email does not exist, so that
 * "no such account" takes as long as "wrong password" and cannot be told apart by timing.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

/** Rules for a NEW password (login does not apply them, so older passwords still work). */
export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `The password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return `The password must be at most ${MAX_PASSWORD_LENGTH} characters.`;
  }
  if (new Set(password).size < 5) {
    return 'The password is too repetitive.';
  }
  return null;
}
