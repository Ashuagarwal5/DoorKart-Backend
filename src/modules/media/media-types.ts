/**
 * What an uploaded file really is, decided from its first bytes. The file name and the
 * Content-Type the browser sent are chosen by the sender, so neither is trusted: a text file
 * renamed to "photo.jpg" is refused here.
 */

export type MediaKind = 'IMAGE' | 'VIDEO';

export type DetectedMedia = {
  kind: MediaKind;
  /** The extension the file is stored under, always chosen here and never taken from the upload. */
  extension: 'jpg' | 'png' | 'gif' | 'webp' | 'mp4' | 'mov' | 'webm';
};

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 50 * 1024 * 1024;

export const SUPPORTED_FORMATS_MESSAGE = 'Use a JPG, PNG, WebP or GIF picture, or an MP4, MOV or WebM video.';

const ascii = (bytes: Uint8Array, start: number, end: number) =>
  String.fromCharCode(...bytes.subarray(start, end));

/** Phone photos in these formats are common but most browsers and apps cannot show them. */
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'mif1', 'msf1']);

export function detectMedia(bytes: Uint8Array): DetectedMedia | 'HEIF' | null {
  if (bytes.length < 12) {
    return null;
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'IMAGE', extension: 'jpg' };
  }
  if (
    bytes[0] === 0x89 &&
    ascii(bytes, 1, 4) === 'PNG' &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { kind: 'IMAGE', extension: 'png' };
  }
  const gifHeader = ascii(bytes, 0, 6);
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { kind: 'IMAGE', extension: 'gif' };
  }
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 12) === 'WEBP') {
    return { kind: 'IMAGE', extension: 'webp' };
  }
  // WebM and Matroska containers start with the EBML marker.
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return { kind: 'VIDEO', extension: 'webm' };
  }
  // MP4, MOV and HEIF all use the "ftyp" box; the brand after it tells them apart.
  if (ascii(bytes, 4, 8) === 'ftyp') {
    const brand = ascii(bytes, 8, 12);
    if (HEIF_BRANDS.has(brand)) {
      return 'HEIF';
    }
    return brand === 'qt  '
      ? { kind: 'VIDEO', extension: 'mov' }
      : { kind: 'VIDEO', extension: 'mp4' };
  }

  return null;
}

export const CONTENT_TYPES: Record<DetectedMedia['extension'], string> = {
  jpg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
};

/**
 * The only shape of a stored file name: a random id and one of our own extensions.
 * It is also what makes a path safe to serve or to accept back from a client.
 */
export const STORED_FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp|mp4|mov|webm)$/;

export const UPLOAD_URL_PREFIX = '/uploads/';
