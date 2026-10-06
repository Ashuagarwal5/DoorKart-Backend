import { randomUUID } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { env } from '../../config/env.js';
import { STORED_FILE_NAME, UPLOAD_URL_PREFIX, type DetectedMedia } from './media-types.js';

/**
 * Where files live. Everything about the disk is in this file, so moving uploads to cloud
 * storage later means replacing these functions and nothing that calls them.
 */

export async function ensureUploadDirectory(): Promise<void> {
  await mkdir(env.uploadDir, { recursive: true });
}

/** Saves the bytes under a fresh random name and returns the URL path clients should store. */
export async function saveMedia(bytes: Buffer, media: DetectedMedia): Promise<string> {
  await ensureUploadDirectory();
  const fileName = `${randomUUID()}.${media.extension}`;
  // `wx` refuses to overwrite, so a (practically impossible) name clash cannot replace a file.
  await writeFile(path.join(env.uploadDir, fileName), bytes, { flag: 'wx' });
  return `${UPLOAD_URL_PREFIX}${fileName}`;
}

/** True for a URL path this server issued, whose file is still on disk. */
export async function uploadedFileExists(urlPath: string): Promise<boolean> {
  if (!urlPath.startsWith(UPLOAD_URL_PREFIX)) {
    return false;
  }
  const fileName = urlPath.slice(UPLOAD_URL_PREFIX.length);
  if (!STORED_FILE_NAME.test(fileName)) {
    return false;
  }
  try {
    await access(path.join(env.uploadDir, fileName));
    return true;
  } catch {
    return false;
  }
}
