import multer from 'multer';

import { badRequest, payloadTooLarge, unsupportedMediaType } from '../errors.js';

/**
 * The multipart gate for the import endpoint.
 *
 * Two limits, both enforced before a byte reaches the CSV parser:
 *
 *   - **size** (2 MB) is a memory limit, not a business rule. `memoryStorage`
 *     holds the file so the parser can read it, which means an unbounded file is
 *     an unbounded allocation - exactly the shape of a denial-of-service bug.
 *   - **one file, one field** keeps a request from smuggling a second part past
 *     the checks, and pins the field name the contract promises (`file`).
 *
 * Multer's own errors are translated here so the API answers in its own
 * vocabulary (`413 FILE_TOO_LARGE`) rather than leaking a library's code.
 */

export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/**
 * Browsers are inconsistent about CSV: Chrome says `text/csv`, Edge on Windows
 * often says `application/vnd.ms-excel`, and some clients say `application/csv`.
 */
export const CSV_MEDIA_TYPES = ['text/csv', 'application/csv', 'application/vnd.ms-excel'];

export function createCsvUpload({ maxBytes = MAX_UPLOAD_BYTES } = {}) {
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: maxBytes, files: 1, fields: 10, parts: 12 },
  });
  const single = upload.single('file');

  return function csvUpload(req, res, next) {
    single(req, res, (error) => {
      if (!error) return next();

      if (error.code === 'LIMIT_FILE_SIZE') {
        return next(payloadTooLarge('FILE_TOO_LARGE', `The file must be ${maxBytes / 1024 / 1024} MB or smaller.`));
      }
      if (error.code === 'LIMIT_UNEXPECTED_FILE') {
        return next(badRequest('VALIDATION_FAILED', 'Send exactly one file, in a field named "file".', { field: 'file' }));
      }
      return next(error);
    });
  };
}

/** Presence and type, checked after the guards so an anonymous caller learns nothing. */
export function assertUploadedCsv(file) {
  if (!file) {
    throw badRequest('VALIDATION_FAILED', 'Send the CSV as a single form field named "file".', { field: 'file' });
  }
  if (!CSV_MEDIA_TYPES.includes(file.mimetype)) {
    throw unsupportedMediaType('UNSUPPORTED_MEDIA_TYPE', 'Only CSV files are accepted.');
  }
  return file;
}
