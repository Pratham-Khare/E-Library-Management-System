/**
 * ---------------------------------------------------------------------------
 * FILE UPLOAD MIDDLEWARE
 * ---------------------------------------------------------------------------
 * Multer configured per upload category (cover, ebook, avatar), followed by a
 * MAGIC-NUMBER verification step.
 *
 * TWO LAYERS OF TYPE CHECKING, because either alone is insufficient:
 *
 *   1. `fileFilter` checks the DECLARED Content-Type against the allow-list.
 *      Cheap, runs before any bytes are written, and catches honest mistakes.
 *      But the declared type is supplied by the CLIENT and can say anything.
 *
 *   2. `verifyFileSignature` reads the first bytes off disk and checks them
 *      against the format's real signature. This is what stops someone
 *      renaming `payload.exe` to `book.pdf`, declaring `application/pdf`, and
 *      having the library store and later serve it.
 *
 * Layer 1 without layer 2 is a checkbox. Layer 2 is the one that matters.
 *
 * Files land in a TEMP directory first and are only moved into permanent
 * storage after verification passes — so a rejected upload never occupies a
 * path anything else can reach.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import multer from 'multer';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

/* ===========================================================================
 * Magic-number verification
 * ======================================================================== */

/**
 * Read the first `length` bytes of a file.
 * A stream with a byte range, so verifying a 50MB PDF reads 12 bytes rather
 * than the whole thing.
 */
const readHeader = (filePath, length = 16) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, { start: 0, end: length - 1 });
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });

/**
 * Does the file's actual content match the type it claims to be?
 *
 * @param {string} filePath
 * @param {string} declaredMimeType
 * @returns {Promise<boolean>}
 */
export const matchesSignature = async (filePath, declaredMimeType) => {
  const signatures = config.upload.magicNumbers[declaredMimeType];

  // No signature on file for this type: nothing to check against, so accept.
  // Every type currently on an allow-list does have one.
  if (!signatures) return true;

  const header = await readHeader(filePath, 16);

  const prefixMatches = signatures.some((signature) =>
    signature.every((byte, index) => header[index] === byte)
  );

  if (!prefixMatches) return false;

  /**
   * Container formats need a second check at an offset. WEBP is a RIFF
   * container, and RIFF alone also identifies WAV and AVI — so the prefix
   * check would pass an audio file declared as an image. The "WEBP" tag at
   * byte 8 is what actually distinguishes it.
   */
  const offsetCheck = config.upload.magicNumberOffsets[declaredMimeType];
  if (offsetCheck) {
    return offsetCheck.bytes.every((byte, index) => header[offsetCheck.offset + index] === byte);
  }

  return true;
};

/* ===========================================================================
 * Multer configuration
 * ======================================================================== */

/**
 * Disk storage into a temp directory.
 *
 * Disk rather than memory: an in-memory buffer of a 50MB ebook is 50MB of
 * heap, and a handful of concurrent uploads would exhaust the process.
 *
 * The filename is a UUID, never anything derived from the client's. A
 * client-supplied name invites path traversal, collisions between two files
 * called `book.pdf`, and encoding trouble with non-ASCII names on Windows.
 */
const tempStorage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(config.upload.paths.temp, { recursive: true });
      cb(null, config.upload.paths.temp);
    } catch (error) {
      cb(error);
    }
  },
  filename: (req, file, cb) => {
    const extension = config.upload.extensionFor[file.mimetype] ?? path.extname(file.originalname);
    cb(null, `${crypto.randomUUID()}${extension}`);
  },
});

/**
 * Reject a disallowed declared type BEFORE any bytes are written.
 *
 * Rejecting in `fileFilter` rather than after the upload means a 50MB file of
 * the wrong type never touches the disk at all.
 */
const buildFileFilter = (category) => (req, file, cb) => {
  const rules = config.upload.categories[category];

  if (!rules.allowedTypes.includes(file.mimetype)) {
    return cb(
      ApiError.unsupportedMediaType(
        `${file.mimetype} is not accepted here. Allowed types: ${rules.allowedTypes.join(', ')}`,
        ERROR_CODES.UNSUPPORTED_FILE_TYPE
      )
    );
  }

  return cb(null, true);
};

/**
 * Build the multer middleware for a category.
 * @param {'cover'|'ebook'|'avatar'} category
 */
export const uploadFor = (category) => {
  const rules = config.upload.categories[category];

  if (!rules) throw new Error(`Unknown upload category: ${category}`);

  return multer({
    storage: tempStorage,
    fileFilter: buildFileFilter(category),
    limits: {
      fileSize: rules.maxSizeBytes,
      files: 1,
      // Bound the non-file parts too — an unbounded field count is its own
      // denial-of-service vector.
      fields: 20,
      fieldSize: 1024 * 100,
    },
  }).single(rules.field);
};

/* ===========================================================================
 * Signature verification middleware
 * ======================================================================== */

/**
 * Verify the uploaded file's real signature, and delete it if it lies.
 *
 * Runs AFTER multer. If the content contradicts the declared type the temp
 * file is removed immediately — leaving a rejected upload on disk would be a
 * slow accumulation of exactly the files we refused to accept.
 *
 * @param {'cover'|'ebook'|'avatar'} category
 */
export const verifyFileSignature = (category) => async (req, res, next) => {
  if (!req.file) return next();

  try {
    const valid = await matchesSignature(req.file.path, req.file.mimetype);

    if (!valid) {
      await fs.unlink(req.file.path).catch(() => {});

      logger.warn('Rejected an upload whose content did not match its declared type', {
        requestId: req.id,
        userId: req.user?.id,
        declaredType: req.file.mimetype,
        originalName: req.file.originalname,
        ip: req.ip,
      });

      return next(
        ApiError.unsupportedMediaType(
          `This file's contents do not match its declared type (${req.file.mimetype}). It may be corrupted, or renamed from another format.`,
          ERROR_CODES.FILE_SIGNATURE_MISMATCH
        )
      );
    }

    req.uploadCategory = category;
    return next();
  } catch (error) {
    await fs.unlink(req.file.path).catch(() => {});
    return next(error);
  }
};

/** Require that a file was actually attached. */
export const requireFile = (fieldName) => (req, res, next) => {
  if (!req.file) {
    return next(
      ApiError.badRequest(
        `No file was uploaded. Send it as multipart/form-data in the "${fieldName}" field.`,
        ERROR_CODES.FILE_REQUIRED
      )
    );
  }
  return next();
};

/**
 * The full upload chain for a category: multer, then signature verification,
 * then a presence check.
 *
 *     router.post('/cover', ...uploadChain('cover'), handler);
 */
export const uploadChain = (category) => [
  uploadFor(category),
  verifyFileSignature(category),
  requireFile(config.upload.categories[category].field),
];

/**
 * Remove a leftover temp file.
 *
 * Called when a handler fails AFTER a successful upload — the file was
 * accepted but the database write did not happen, and leaving it behind is a
 * slow leak of orphaned bytes nothing references.
 */
export const cleanupTempFile = async (file) => {
  if (!file?.path) return;
  await fs.unlink(file.path).catch((error) => {
    logger.warn('Could not remove a temporary upload', { path: file.path, error: error.message });
  });
};

export default { uploadFor, verifyFileSignature, requireFile, uploadChain, cleanupTempFile, matchesSignature };
