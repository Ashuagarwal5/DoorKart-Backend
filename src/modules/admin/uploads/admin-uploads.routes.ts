import { Router, type Request, type Response } from 'express';
import multer from 'multer';

import { AppError } from '../../../lib/errors.js';
import { sendSuccess } from '../../../lib/http.js';
import { saveMedia } from '../../media/media-storage.js';
import {
  detectMedia,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  SUPPORTED_FORMATS_MESSAGE,
} from '../../media/media-types.js';

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

/**
 * One file per request, held in memory (at most MAX_VIDEO_BYTES). The size cap is enforced
 * while the upload streams in, so an oversized file is cut off rather than read in full.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_BYTES, files: 1, fields: 0, parts: 2 },
});

function receiveFile(req: Request, res: Response): Promise<Express.Multer.File> {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (error: unknown) => {
      if (error instanceof multer.MulterError) {
        reject(
          error.code === 'LIMIT_FILE_SIZE'
            ? new AppError(413, 'PAYLOAD_TOO_LARGE', `That file is too large. Videos can be up to ${megabytes(MAX_VIDEO_BYTES)}.`)
            : new AppError(400, 'VALIDATION_ERROR', 'Send exactly one file in the "file" field.')
        );
      } else if (error) {
        reject(error);
      } else if (!req.file) {
        reject(new AppError(400, 'VALIDATION_ERROR', 'Choose a file to upload.'));
      } else {
        resolve(req.file);
      }
    });
  });
}

export const adminUploadsRouter = Router();

/** Sits behind requireAdmin and the origin check (see admin.routes.ts). */
adminUploadsRouter.post('/', async (req, res) => {
  const file = await receiveFile(req, res);

  const media = detectMedia(file.buffer);
  if (media === 'HEIF') {
    throw new AppError(
      415,
      'UNSUPPORTED_MEDIA',
      'HEIC photos cannot be shown on most screens. Save the picture as JPG or PNG first.'
    );
  }
  if (media === null) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA', `That file type is not supported. ${SUPPORTED_FORMATS_MESSAGE}`);
  }
  if (media.kind === 'IMAGE' && file.size > MAX_IMAGE_BYTES) {
    throw new AppError(413, 'PAYLOAD_TOO_LARGE', `Pictures can be up to ${megabytes(MAX_IMAGE_BYTES)}.`);
  }

  const url = await saveMedia(file.buffer, media);
  sendSuccess(res, { url, mediaType: media.kind, sizeBytes: file.size }, 201);
});
