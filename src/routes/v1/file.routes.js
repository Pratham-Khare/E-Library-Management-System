/**
 * ---------------------------------------------------------------------------
 * FILE ROUTES  —  /api/v1/files
 * ---------------------------------------------------------------------------
 * Cover images and avatars are served STATICALLY (mounted in app.js) because
 * they are public by nature. Ebooks are not — every read goes through
 * `GET /files/ebooks/:assetId/read`, which verifies an active digital loan and
 * then streams the bytes.
 *
 * That distinction is the whole design: a static mount for ebooks would mean
 * anyone with a URL could take the library's collection without borrowing.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import * as fileController from '../../controllers/file.controller.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimiter } from '../../middlewares/rateLimiter.js';
import { uploadChain } from '../../middlewares/upload.js';
import { objectId } from '../../validators/common.js';
import { bookIdParam } from '../../validators/catalog.validator.js';
import { z } from 'zod';

const router = Router();

const assetIdParam = z.object({ assetId: objectId });

/* ===========================================================================
 * Uploads
 * ======================================================================== */

/**
 * @openapi
 * /files/books/{bookId}/cover:
 *   post:
 *     tags: [Files]
 *     summary: Upload a book cover (staff only)
 *     description: >
 *       Accepts JPEG, PNG or WebP up to the configured size cap.
 *       The file's MAGIC NUMBER is verified against its declared type, so an
 *       executable renamed to `cover.jpg` is rejected rather than stored.
 *       Replaces any existing cover, deleting the old file afterwards.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               cover: { type: string, format: binary }
 *     responses:
 *       200: { description: 'Uploaded; the book now carries a cover URL.' }
 *       413: { description: 'File exceeds the size cap (FILE_TOO_LARGE).' }
 *       415: { description: 'Disallowed type, or content that contradicts it (FILE_SIGNATURE_MISMATCH).' }
 */
router.post(
  '/books/:bookId/cover',
  authenticate,
  requireStaff,
  rateLimiter('upload'),
  ...uploadChain('cover'),
  validate({ params: bookIdParam }),
  fileController.uploadCover
);

/**
 * @openapi
 * /files/books/{bookId}/ebook:
 *   post:
 *     tags: [Files]
 *     summary: Upload an ebook (staff only)
 *     description: >
 *       Accepts PDF or EPUB. The file is DEDUPLICATED by SHA-256 — uploading
 *       the same file twice reuses the bytes already on disk.
 *       Text extraction runs in the BACKGROUND to feed AI summaries; the
 *       response returns immediately rather than waiting on it. Extraction
 *       failure is not fatal — summaries fall back to catalogue metadata.
 *       Marking the upload as a preview makes it readable WITHOUT a loan, as a
 *       sample chapter.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               ebook:     { type: string, format: binary }
 *               isPreview: { type: boolean, description: 'Readable without borrowing.' }
 *               concurrentLicenses: { type: integer, description: 'Simultaneous readers allowed.' }
 *     responses:
 *       201: { description: 'Uploaded. The book is now digitally lendable.' }
 *       415: { description: 'Not a genuine PDF or EPUB.' }
 */
router.post(
  '/books/:bookId/ebook',
  authenticate,
  requireStaff,
  rateLimiter('upload'),
  ...uploadChain('ebook'),
  validate({ params: bookIdParam }),
  fileController.uploadEbook
);

/**
 * @openapi
 * /files/avatar:
 *   post:
 *     tags: [Files]
 *     summary: Upload your profile picture
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               avatar: { type: string, format: binary }
 *     responses:
 *       200: { description: 'Uploaded.' }
 */
router.post(
  '/avatar',
  authenticate,
  rateLimiter('upload'),
  ...uploadChain('avatar'),
  fileController.uploadAvatar
);

/* ===========================================================================
 * Asset management
 * ======================================================================== */

/**
 * @openapi
 * /files/books/{bookId}/assets:
 *   get:
 *     tags: [Files]
 *     summary: List a book's ebook files
 *     description: >
 *       Includes each file's text-extraction status, so a librarian can tell
 *       "the AI has no text to work with" from "the AI is broken".
 *       Never returns the internal storage path.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The files.' }
 */
router.get(
  '/books/:bookId/assets',
  authenticate,
  validate({ params: bookIdParam }),
  fileController.listAssets
);

/**
 * @openapi
 * /files/ebooks/{assetId}:
 *   delete:
 *     tags: [Files]
 *     summary: Remove an ebook file (staff only)
 *     description: >
 *       The underlying file is deleted only when no other record shares its
 *       checksum — deduplication means several assets can point at one file.
 *     parameters:
 *       - in: path
 *         name: assetId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Removed.' }
 */
router.delete(
  '/ebooks/:assetId',
  authenticate,
  requireStaff,
  validate({ params: assetIdParam }),
  fileController.deleteAsset
);

/**
 * @openapi
 * /files/ebooks/{assetId}/extract:
 *   post:
 *     tags: [Files]
 *     summary: Re-run text extraction (staff only)
 *     description: >
 *       Useful after a failed extraction, or after enabling the feature.
 *       Runs synchronously and reports the outcome.
 *     parameters:
 *       - in: path
 *         name: assetId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Extraction finished; the status describes the outcome.' }
 */
router.post(
  '/ebooks/:assetId/extract',
  authenticate,
  requireStaff,
  validate({ params: assetIdParam }),
  fileController.reextract
);

/* ===========================================================================
 * Reading
 * ======================================================================== */

/**
 * @openapi
 * /files/ebooks/{assetId}/read:
 *   get:
 *     tags: [Files]
 *     summary: Read an ebook (requires an active digital loan)
 *     description: |
 *       Streams the file, with full HTTP **range** support so a browser PDF
 *       viewer can seek to any page without downloading everything before it.
 *
 *       **Access is granted only when** the file is a preview, the caller is
 *       staff, or the caller holds an ACTIVE digital loan for the book. The
 *       loan is checked on every request, so access ends the moment it expires.
 *
 *       Send `Range: bytes=0-1023` to receive `206 Partial Content` with a
 *       `Content-Range` header. Without a Range header the whole file is sent
 *       with `200`.
 *     parameters:
 *       - in: path
 *         name: assetId
 *         required: true
 *         schema: { type: string }
 *       - in: header
 *         name: Range
 *         schema: { type: string, example: bytes=0-1023 }
 *     responses:
 *       200:
 *         description: The complete file.
 *         content:
 *           application/pdf: { schema: { type: string, format: binary } }
 *       206:
 *         description: A byte range, with Content-Range set.
 *       401: { description: 'Not signed in, and the file is not a preview.' }
 *       403: { description: 'No active digital loan for this book (NO_READ_ACCESS).' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *       416: { description: 'The requested range cannot be satisfied.' }
 */
router.get(
  '/ebooks/:assetId/read',
  optionalAuthenticate,
  validate({ params: assetIdParam }),
  fileController.readEbook
);

/**
 * @openapi
 * /files/ebooks/{assetId}/download-link:
 *   post:
 *     tags: [Files]
 *     summary: Create a short-lived signed download URL
 *     description: >
 *       For contexts that cannot send an Authorization header — an
 *       `<a download>` link, or a native PDF viewer. The returned token is
 *       scoped to this one file and expires within minutes, so a leaked URL is
 *       worth very little.
 *       Requires the same entitlement as reading.
 *     parameters:
 *       - in: path
 *         name: assetId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'A signed URL and its expiry.' }
 *       403: { description: 'No active digital loan.' }
 */
router.post(
  '/ebooks/:assetId/download-link',
  authenticate,
  validate({ params: assetIdParam }),
  fileController.getDownloadLink
);

/**
 * @openapi
 * /files/ebooks/{assetId}/download:
 *   get:
 *     tags: [Files]
 *     summary: Download an ebook using a signed token
 *     description: >
 *       Deliberately not behind bearer authentication — the token IS the
 *       credential, which is the reason this endpoint exists. It is far
 *       narrower than a session: one file, a few minutes, nothing else.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: assetId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: token
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The file, as an attachment.' }
 *       401: { description: 'Missing, invalid or expired token.' }
 *       403: { description: 'The token is for a different file.' }
 */
router.get(
  '/ebooks/:assetId/download',
  validate({ params: assetIdParam }),
  fileController.downloadWithToken
);

export default router;
