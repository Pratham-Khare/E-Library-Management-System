/**
 * ---------------------------------------------------------------------------
 * FILE CONTROLLER
 * ---------------------------------------------------------------------------
 * Uploads, and the streaming ebook reader.
 *
 * `readEbook` is the one handler in this codebase that does NOT return a JSON
 * envelope, because it returns file bytes. It implements HTTP range requests
 * properly — `206 Partial Content` with `Content-Range` — which is what lets a
 * browser PDF viewer jump to page 400 without downloading the first 399.
 *
 * Errors DURING a stream are handled separately from errors before it: once
 * the first byte is written the status code is already sent, so a JSON error
 * body cannot be produced. Those failures destroy the connection instead, so
 * the client sees a truncated transfer rather than JSON appended to a PDF.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import * as fileService from '../services/file.service.js';
import storage from '../services/storage/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created } from '../utils/ApiResponse.js';
import { toBookDetail } from '../serializers/catalog.serializer.js';
import { toSelf } from '../serializers/user.serializer.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';
import { extractBearerToken } from '../utils/tokens.js';

/** Public shape for a digital asset. NEVER includes `storageKey`. */
const toAsset = (asset) => ({
  id: String(asset._id ?? asset.id),
  format: asset.format,
  originalName: asset.originalName,
  sizeBytes: asset.sizeBytes,
  sizeFormatted:
    asset.sizeBytes < 1024 * 1024
      ? `${(asset.sizeBytes / 1024).toFixed(1)} KB`
      : `${(asset.sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
  pageCount: asset.pageCount ?? null,
  isPreview: asset.isPreview ?? false,
  extraction: {
    status: asset.extractionStatus,
    characters: asset.extractedCharCount ?? 0,
    // Surfaced so a librarian can tell "the AI has no text to work with"
    // from "the AI is broken".
    error: asset.extractionError ?? null,
  },
  accessCount: asset.accessCount ?? 0,
  uploadedAt: asset.createdAt,
});

/* ===========================================================================
 * Uploads
 * ======================================================================== */

export const uploadCover = asyncHandler(async (req, res) => {
  const book = await fileService.uploadCover(req.params.bookId, req.file);
  return ok(res, toBookDetail(book), 'Cover image uploaded');
});

export const uploadAvatar = asyncHandler(async (req, res) => {
  const user = await fileService.uploadAvatar(req.user.id, req.file);
  return ok(res, toSelf(user), 'Profile picture updated');
});

export const uploadEbook = asyncHandler(async (req, res) => {
  const { asset, book } = await fileService.uploadEbook(
    req.params.bookId,
    req.file,
    {
      isPreview: req.body.isPreview === 'true' || req.body.isPreview === true,
      concurrentLicenses: req.body.concurrentLicenses
        ? Number(req.body.concurrentLicenses)
        : undefined,
    },
    req.user
  );

  return created(
    res,
    {
      asset: toAsset(asset),
      book: { id: String(book._id), title: book.title, digital: book.digital },
      // Extraction runs in the background, so the response says so rather than
      // reporting a status that is already stale.
      note: 'Text extraction is running in the background and will improve AI summaries for this book.',
    },
    'Ebook uploaded'
  );
});

export const listAssets = asyncHandler(async (req, res) => {
  const { book, assets } = await fileService.listAssets(req.params.bookId);
  return ok(
    res,
    { book: { id: String(book._id), title: book.title, digital: book.digital }, assets: assets.map(toAsset) },
    'Files fetched'
  );
});

export const deleteAsset = asyncHandler(async (req, res) => {
  const result = await fileService.removeAsset(req.params.assetId);
  return ok(res, result, 'File removed');
});

/** Re-run text extraction — after fixing a bad upload, or enabling the feature. */
export const reextract = asyncHandler(async (req, res) => {
  const result = await fileService.extractText(req.params.assetId);
  return ok(res, result, `Extraction finished with status ${result.status}`);
});

/* ===========================================================================
 * The reader
 * ======================================================================== */

/**
 * Stream an ebook to an entitled reader.
 *
 * Access is checked first (active digital loan, staff, or a preview), then the
 * bytes are streamed with full HTTP range support.
 *
 * Why streaming rather than `res.sendFile`: `sendFile` cannot apply the
 * authorisation check per request the way this does, and reading a 50MB PDF
 * into a buffer would occupy 50MB of heap for the duration of every response.
 */
export const readEbook = asyncHandler(async (req, res) => {
  const { asset, reason } = await fileService.getReadableAsset(req.params.assetId, req.user);

  const { sizeBytes, exists } = await storage.stat(asset.storageKey);

  if (!exists) {
    // The database row survived but the file did not — a genuine operational
    // problem worth logging loudly rather than reporting as a plain 404.
    logger.error('An ebook record points at a file that is missing from storage', {
      assetId: String(asset._id),
      storageKey: asset.storageKey,
    });
    throw ApiError.notFound('This file is no longer available', ERROR_CODES.FILE_NOT_FOUND);
  }

  const range = fileService.parseRange(req.headers.range, sizeBytes);

  if (range && !range.satisfiable) {
    // The spec requires Content-Range on a 416, so the client learns the real
    // size and can retry sensibly.
    res.setHeader('Content-Range', `bytes */${sizeBytes}`);
    throw ApiError.rangeNotSatisfiable(
      `The requested range cannot be satisfied. This file is ${sizeBytes} bytes.`
    );
  }

  fileService.recordAccess(asset._id);

  /**
   * Advertise range support on every response. Without `Accept-Ranges`, a
   * browser PDF viewer assumes it must download the entire file before
   * rendering anything.
   */
  res.setHeader('Accept-Ranges', config.upload.streaming.acceptRanges);
  res.setHeader('Content-Type', asset.mimeType);

  // `inline` so a browser renders it in place instead of prompting a download.
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(asset.originalName)}"`
  );

  // Library assets must not be cached by shared proxies — the whole point is
  // that access is checked per request.
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Access-Reason', reason);

  const stream = range
    ? storage.createStream(asset.storageKey, { start: range.start, end: range.end })
    : storage.createStream(asset.storageKey);

  if (range) {
    res.status(HTTP_STATUS.PARTIAL_CONTENT);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${sizeBytes}`);
    res.setHeader('Content-Length', range.end - range.start + 1);
  } else {
    res.status(HTTP_STATUS.OK);
    res.setHeader('Content-Length', sizeBytes);
  }

  /**
   * Once bytes start flowing the status line is already sent, so a mid-stream
   * failure cannot be turned into a JSON error. Destroying the response is the
   * honest outcome: the client sees a truncated transfer rather than an error
   * body appended to a partial PDF.
   */
  stream.on('error', (error) => {
    logger.error('Error while streaming an ebook', {
      assetId: String(asset._id),
      error: error.message,
    });
    if (!res.headersSent) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).end();
    } else {
      res.destroy();
    }
  });

  // A reader closing the tab mid-download should not leave a file handle open.
  req.on('close', () => stream.destroy());

  stream.pipe(res);
});

/**
 * Mint a short-lived signed download URL.
 *
 * For contexts that cannot send an Authorization header — an `<a download>`
 * link, or a native PDF viewer. The token is scoped to one asset and expires
 * in minutes.
 */
export const getDownloadLink = asyncHandler(async (req, res) => {
  const result = await fileService.createDownloadToken(req.params.assetId, req.user);
  return ok(res, result, 'Download link created');
});

/**
 * Serve a file against a signed token.
 *
 * Deliberately NOT behind `authenticate` — the token IS the credential, which
 * is the entire reason this endpoint exists. It is narrower than a session:
 * one asset, a few minutes, no other capability.
 */
export const downloadWithToken = asyncHandler(async (req, res) => {
  const token = req.query.token || extractBearerToken(req);

  if (!token) {
    throw ApiError.unauthorized(
      'A download token is required',
      ERROR_CODES.INVALID_DOWNLOAD_TOKEN
    );
  }

  const asset = await fileService.resolveDownloadToken(token, req.params.assetId);
  const { sizeBytes, exists } = await storage.stat(asset.storageKey);

  if (!exists) {
    throw ApiError.notFound('This file is no longer available', ERROR_CODES.FILE_NOT_FOUND);
  }

  fileService.recordAccess(asset._id);

  res.setHeader('Content-Type', asset.mimeType);
  // `attachment` here, unlike the reader — this endpoint exists to download.
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${encodeURIComponent(asset.originalName)}"`
  );
  res.setHeader('Content-Length', sizeBytes);
  res.setHeader('Cache-Control', 'private, no-store');

  const stream = storage.createStream(asset.storageKey);
  stream.on('error', () => res.destroy());
  req.on('close', () => stream.destroy());
  stream.pipe(res);
});

export default {
  uploadCover,
  uploadAvatar,
  uploadEbook,
  listAssets,
  deleteAsset,
  reextract,
  readEbook,
  getDownloadLink,
  downloadWithToken,
};
