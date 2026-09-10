import multer, { MulterError } from 'multer';
import type { RequestHandler } from 'express';
import { ApiError } from '../utils/apiError.js';
import { MAX_UPLOAD_BYTES, UPLOAD_FIELD_NAME } from '../config/constants.js';

/**
 * Multipart parsing for the ONE upload route. Deliberately not registered in
 * app.ts beside express.json: a global multipart parser would run on every
 * request and turn any route into an upload target
 * (docs/development.md's multer entry says exactly this).
 *
 * memoryStorage, not diskStorage: the bytes must be hashed and sniffed
 * before anything is persisted, and storageService owns where a file lands.
 * The size cap is what makes buffering in memory safe.
 */
const handler = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 4 },
}).single(UPLOAD_FIELD_NAME);

/** Runs multer and converts its errors into ApiErrors. */
export const singleFileUpload: RequestHandler = (req, res, next) => {
  handler(req, res, (err: unknown) => {
    if (err instanceof MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        next(new ApiError(413, 'File exceeds the 10 MB limit'));
        return;
      }
      if (err.code === 'LIMIT_UNEXPECTED_FILE') {
        next(new ApiError(400, 'Send exactly one file in a field named "file"'));
        return;
      }
      next(new ApiError(400, 'Malformed multipart upload'));
      return;
    }
    if (err) {
      next(err);
      return;
    }
    next();
  });
};
