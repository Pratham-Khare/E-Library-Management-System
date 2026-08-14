/**
 * ---------------------------------------------------------------------------
 * FILE SERVICE
 * ---------------------------------------------------------------------------
 * Uploads, text extraction, and the ACCESS-CONTROLLED ebook reader.
 *
 * The reader is the part that matters. An ebook is the library's actual asset,
 * so `getReadableAsset()` verifies an active digital loan before returning
 * anything, and the file is streamed through a controller rather than mounted
 * statically. A static mount would mean anyone who obtained or guessed a URL
 * could download the entire collection without ever borrowing a thing.
 *
 * Range support is not a nicety: browser PDF viewers request byte ranges to
 * render page 400 without downloading pages 1-399, and a server that ignores
 * `Range` forces a full 50MB transfer for every seek.
 * ---------------------------------------------------------------------------
 */

import fs from 'node:fs/promises';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import storage from './storage/index.js';
import { Book } from '../models/Book.js';
import { DigitalAsset } from '../models/DigitalAsset.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { EBOOK_FORMAT, EXTRACTION_STATUS, LOAN_STATUS } from '../constants/enums.js';
import { cleanupTempFile } from '../middlewares/upload.js';
import { signDownloadToken, verifyDownloadToken } from '../utils/tokens.js';

/* ===========================================================================
 * Text extraction
 * ======================================================================== */

/**
 * Extract text from a PDF, to feed the AI summariser.
 *
 * FAILURE IS NEVER FATAL. A scanned PDF has no text layer, an encrypted one
 * cannot be parsed, and pdf-parse occasionally chokes on malformed files. In
 * every case the asset is marked FAILED or SKIPPED and the book still works —
 * summaries simply fall back to catalogue metadata. Refusing the upload
 * because text extraction failed would trade a small feature for the whole one.
 *
 * @param {string} assetId
 */
export const extractText = async (assetId) => {
  const asset = await DigitalAsset.findById(assetId).select('+storageKey');
  if (!asset) return { status: EXTRACTION_STATUS.FAILED, reason: 'Asset not found' };

  if (!config.upload.extraction.enabled) {
    asset.extractionStatus = EXTRACTION_STATUS.SKIPPED;
    asset.extractionError = 'Text extraction is disabled by configuration';
    await asset.save();
    return { status: EXTRACTION_STATUS.SKIPPED };
  }

  // EPUB is a ZIP of XHTML and needs a different parser. Marked SKIPPED rather
  // than FAILED — nothing went wrong, the format is simply not handled yet.
  if (!config.upload.extraction.supportedTypes.includes(asset.mimeType)) {
    asset.extractionStatus = EXTRACTION_STATUS.SKIPPED;
    asset.extractionError = `Text extraction is not implemented for ${asset.mimeType}`;
    await asset.save();
    return { status: EXTRACTION_STATUS.SKIPPED };
  }

  asset.extractionStatus = EXTRACTION_STATUS.PROCESSING;
  await asset.save();

  try {
    /**
     * `unpdf` rather than the more commonly seen `pdf-parse`.
     *
     * pdf-parse has not been published since 2018 and bundles a pdf.js build
     * of the same vintage, which rejects perfectly valid PDFs with "bad XRef
     * entry" — including ones its own recovery path should handle. unpdf wraps
     * a current pdf.js, is ESM-native, and parses the same files correctly.
     *
     * Imported lazily so the PDF engine is only loaded when a PDF is actually
     * uploaded, rather than on every server start.
     */
    const { getDocumentProxy, extractText: extractPdfText } = await import('unpdf');

    const buffer = await storage.read(asset.storageKey);

    // Races against a timeout: a malformed PDF can send the parser into a very
    // long loop, and an upload handler that never returns is worse than one
    // that gives up.
    const parsed = await Promise.race([
      (async () => {
        const document = await getDocumentProxy(new Uint8Array(buffer));
        const { totalPages, text } = await extractPdfText(document, { mergePages: true });
        return { text, numpages: totalPages };
      })(),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error('Extraction timed out')),
          config.upload.extraction.timeoutMs
        )
      ),
    ]);

    const text = (parsed.text ?? '').replace(/\s+/g, ' ').trim();
    const truncated = text.slice(0, config.upload.extraction.maxStoredChars);

    asset.extractedText = truncated;
    asset.extractedCharCount = truncated.length;
    asset.pageCount = parsed.numpages ?? asset.pageCount;
    asset.extractionStatus =
      truncated.length > 0 ? EXTRACTION_STATUS.COMPLETED : EXTRACTION_STATUS.FAILED;
    asset.extractionError =
      truncated.length > 0
        ? null
        : 'No text layer found — this is likely a scanned document, which would need OCR';
    asset.extractedAt = new Date();

    await asset.save();

    // Backfill the book's page count if cataloguing left it blank.
    if (parsed.numpages) {
      await Book.updateOne(
        { _id: asset.book, $or: [{ pageCount: null }, { pageCount: { $exists: false } }] },
        { $set: { pageCount: parsed.numpages } }
      );
    }

    logger.info('Extracted text from an ebook', {
      assetId: String(asset._id),
      chars: truncated.length,
      pages: parsed.numpages,
    });

    return { status: asset.extractionStatus, chars: truncated.length, pages: parsed.numpages };
  } catch (error) {
    asset.extractionStatus = EXTRACTION_STATUS.FAILED;
    asset.extractionError = error.message.slice(0, 500);
    asset.extractedAt = new Date();
    await asset.save();

    logger.warn('Text extraction failed; AI summaries will fall back to metadata', {
      assetId: String(asset._id),
      error: error.message,
    });

    return { status: EXTRACTION_STATUS.FAILED, reason: error.message };
  }
};

/* ===========================================================================
 * Uploads
 * ======================================================================== */

/** Attach a cover image to a book, replacing any existing one. */
export const uploadCover = async (bookId, file) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false });
  if (!book) {
    await cleanupTempFile(file);
    throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);
  }

  const previousCover = book.coverImage;

  const key = storage.generateKey('covers', file.mimetype);
  await storage.save(file.path, key);

  // Only the filename is stored; the serializer builds the URL, so moving the
  // storage layout later does not invalidate every stored value.
  book.coverImage = key.split('/').pop();
  await book.save();

  // Remove the old file AFTER the new one is committed — losing the old cover
  // because the new save failed would be the worse ordering.
  if (previousCover) {
    await storage.remove(`covers/${previousCover}`).catch(() => {});
  }

  return book;
};

/** Attach an avatar to a user, replacing any existing one. */
export const uploadAvatar = async (userId, file) => {
  const user = await User.findById(userId);
  if (!user) {
    await cleanupTempFile(file);
    throw ApiError.notFound('Account not found', ERROR_CODES.USER_NOT_FOUND);
  }

  const previousAvatar = user.avatar;

  const key = storage.generateKey('avatars', file.mimetype);
  await storage.save(file.path, key);

  user.avatar = key.split('/').pop();
  await user.save();

  if (previousAvatar) {
    await storage.remove(`avatars/${previousAvatar}`).catch(() => {});
  }

  return user;
};

/**
 * Attach an ebook to a book.
 *
 * DEDUPLICATION: the file's SHA-256 is computed first, and if the identical
 * file is already stored the existing bytes are reused rather than written
 * again. Uploading the same 40MB PDF to two catalogue records should cost 40MB
 * of disk, not 80.
 *
 * Text extraction runs in the BACKGROUND. Parsing a 600-page PDF takes several
 * seconds, and holding the HTTP response open for it would make every ebook
 * upload feel broken. The asset is usable immediately; the extracted text
 * arrives shortly after and only affects AI summaries.
 */
export const uploadEbook = async (bookId, file, { isPreview = false, concurrentLicenses } = {}, actor) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false });
  if (!book) {
    await cleanupTempFile(file);
    throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);
  }

  // Computed from the TEMP path, before the file moves into storage.
  const checksum = await storage.checksum(file.path, { isAbsolute: true });

  const duplicate = await DigitalAsset.findByChecksum(checksum);

  let storageKey;
  let sizeBytes;

  if (duplicate) {
    // Same bytes already on disk. Point at them and discard the new copy.
    storageKey = duplicate.storageKey;
    sizeBytes = duplicate.sizeBytes;
    await cleanupTempFile(file);

    logger.info('Reused an identical ebook file already in storage', {
      checksum,
      existingAssetId: String(duplicate._id),
    });
  } else {
    const key = storage.generateKey('ebooks', file.mimetype);
    const saved = await storage.save(file.path, key);
    storageKey = saved.key;
    sizeBytes = saved.sizeBytes;
  }

  const format = file.mimetype === 'application/pdf' ? EBOOK_FORMAT.PDF : EBOOK_FORMAT.EPUB;

  const asset = await DigitalAsset.create({
    book: book._id,
    format,
    storageKey,
    originalName: file.originalname,
    mimeType: file.mimetype,
    sizeBytes,
    checksum,
    isPreview,
    uploadedBy: actor?.id ?? null,
    // A deduplicated file already has extracted text; reuse it rather than
    // parsing identical bytes a second time.
    extractionStatus: duplicate?.extractionStatus ?? EXTRACTION_STATUS.PENDING,
  });

  // Mark the book as digitally lendable.
  book.digital.hasEbook = true;
  if (concurrentLicenses !== undefined) book.digital.concurrentLicenses = concurrentLicenses;
  await book.save();

  // Background extraction. Deliberately not awaited — see the note above.
  if (!duplicate) {
    extractText(asset._id).catch((error) =>
      logger.warn('Background text extraction failed', { error: error.message })
    );
  }

  logger.info('Ebook attached', {
    bookId: String(book._id),
    assetId: String(asset._id),
    format,
    sizeBytes,
    deduplicated: Boolean(duplicate),
  });

  return { asset, book };
};

/** Ebook files attached to a book. */
export const listAssets = async (bookId) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false }).select('_id title digital');
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  const assets = await DigitalAsset.find({ book: book._id }).sort({ isPreview: -1, createdAt: 1 }).lean();

  return { book, assets };
};

/**
 * Detach an ebook.
 *
 * The file itself is deleted only when NO other asset references the same
 * checksum — deduplication means several records can share one file, and
 * removing it while another still points at it would break that one.
 */
export const removeAsset = async (assetId) => {
  const asset = await DigitalAsset.findById(assetId).select('+storageKey');
  if (!asset) throw ApiError.notFound('No such file', ERROR_CODES.FILE_NOT_FOUND);

  const others = await DigitalAsset.countDocuments({
    checksum: asset.checksum,
    _id: { $ne: asset._id },
  });

  await asset.deleteOne();

  if (others === 0) {
    await storage.remove(asset.storageKey).catch(() => {});
  }

  // Clear the book's digital flag if that was its last file.
  const remaining = await DigitalAsset.countDocuments({ book: asset.book, isPreview: false });
  if (remaining === 0) {
    await Book.updateOne({ _id: asset.book }, { $set: { 'digital.hasEbook': false } });
  }

  return { deleted: true, fileRemoved: others === 0 };
};

/* ===========================================================================
 * Access-controlled reading
 * ======================================================================== */

/**
 * Fetch an asset the caller is entitled to read, or refuse.
 *
 * THE AUTHORISATION GATE for the whole digital collection. Access is granted
 * only when one of these holds:
 *
 *   - the asset is a PREVIEW (a sample chapter, deliberately public);
 *   - the caller is library STAFF;
 *   - the caller holds an ACTIVE digital loan for this book.
 *
 * The loan check queries the Loan collection directly rather than trusting any
 * flag on the user, so revoking access is a matter of the loan expiring — no
 * separate bookkeeping to forget.
 *
 * @returns {Promise<{asset: object, reason: string}>}
 */
export const getReadableAsset = async (assetId, user) => {
  const asset = await DigitalAsset.findById(assetId).select('+storageKey');
  if (!asset) throw ApiError.notFound('No such file', ERROR_CODES.FILE_NOT_FOUND);

  // A sample chapter is meant to be readable without borrowing.
  if (asset.isPreview) return { asset, reason: 'preview' };

  if (!user) {
    throw ApiError.unauthorized(
      'Sign in and borrow this book to read it',
      ERROR_CODES.NO_READ_ACCESS
    );
  }

  if (['LIBRARIAN', 'ADMIN'].includes(user.role)) return { asset, reason: 'staff' };

  /**
   * Look up an active digital loan. Imported lazily because the Loan model
   * lands in a later phase than this file, and a static import would make
   * uploads fail before circulation exists.
   */
  const mongooseModels = (await import('mongoose')).default.models;

  if (!mongooseModels.Loan) {
    throw ApiError.forbidden(
      'Digital lending is not available yet',
      ERROR_CODES.NO_READ_ACCESS
    );
  }

  const activeLoan = await mongooseModels.Loan.findOne({
    user: user.id ?? user._id,
    book: asset.book,
    type: 'DIGITAL',
    status: { $in: [LOAN_STATUS.ACTIVE, LOAN_STATUS.OVERDUE] },
  });

  if (!activeLoan) {
    throw ApiError.forbidden(
      'You need an active digital loan for this book in order to read it',
      ERROR_CODES.NO_READ_ACCESS,
      { details: { bookId: String(asset.book) } }
    );
  }

  return { asset, reason: 'loan', loan: activeLoan };
};

/**
 * Parse an HTTP `Range` header.
 *
 * Only the single-range `bytes=start-end` form is handled — which is what
 * every browser PDF viewer actually sends. Multi-range requests are rare and
 * require a multipart/byteranges response; returning the whole file for them
 * is correct behaviour, just not optimal.
 *
 * Both bounds are optional and mean different things:
 *   `bytes=0-1023`  the first 1024 bytes
 *   `bytes=1024-`   from 1024 to the end
 *   `bytes=-500`    the LAST 500 bytes (used to read a PDF's trailer)
 *
 * @param {string} rangeHeader
 * @param {number} fileSize
 * @returns {{start: number, end: number, satisfiable: boolean}|null}
 */
export const parseRange = (rangeHeader, fileSize) => {
  if (!rangeHeader) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return { satisfiable: false, start: 0, end: 0 };

  const [, startRaw, endRaw] = match;

  let start;
  let end;

  if (startRaw === '') {
    // Suffix form: the last N bytes.
    const suffixLength = Number(endRaw);
    if (!Number.isFinite(suffixLength) || suffixLength <= 0) {
      return { satisfiable: false, start: 0, end: 0 };
    }
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === '' ? fileSize - 1 : Number(endRaw);
  }

  // Cap an over-large end rather than rejecting: a client asking for more than
  // exists should get what exists, which is what the spec calls for.
  end = Math.min(end, fileSize - 1);

  if (!Number.isFinite(start) || start < 0 || start >= fileSize || start > end) {
    return { satisfiable: false, start: 0, end: 0 };
  }

  // Bound a single response so one client cannot pull a whole 50MB file in a
  // single chunk while claiming to stream.
  if (end - start + 1 > config.upload.streaming.maxChunkSize) {
    end = start + config.upload.streaming.maxChunkSize - 1;
  }

  return { start, end, satisfiable: true };
};

/** Record that an asset was opened. Fire-and-forget; not worth a failed read. */
export const recordAccess = (assetId) => {
  DigitalAsset.updateOne({ _id: assetId }, { $inc: { accessCount: 1 } }).catch(() => {});
};

/* ===========================================================================
 * Signed download links
 * ======================================================================== */

/**
 * Mint a short-lived signed URL for an ebook.
 *
 * Exists because a browser's built-in PDF viewer — or an `<a download>` link —
 * cannot attach an `Authorization` header. Rather than loosening the endpoint,
 * the caller proves entitlement once through the normal authenticated route
 * and receives a token that is scoped to ONE asset and expires in minutes, so
 * a leaked URL is worth very little.
 */
export const createDownloadToken = async (assetId, user) => {
  const { asset, loan } = await getReadableAsset(assetId, user);

  const token = signDownloadToken({
    userId: user.id ?? user._id,
    assetId: asset._id,
    loanId: loan?._id ?? 'staff',
  });

  return {
    token,
    url: `${config.app.url}${config.app.apiPrefix}/files/ebooks/${asset._id}/download?token=${token}`,
    expiresIn: config.jwt.tokens.download.expiresIn,
  };
};

/** Validate a signed download token and return the asset it authorises. */
export const resolveDownloadToken = async (token, assetId) => {
  const payload = verifyDownloadToken(token);

  // The token is scoped to one asset; presenting it for a different one is a
  // straightforward attempt to widen the grant.
  if (String(payload.asset) !== String(assetId)) {
    throw ApiError.forbidden(
      'This download link is not valid for this file',
      ERROR_CODES.INVALID_DOWNLOAD_TOKEN
    );
  }

  const asset = await DigitalAsset.findById(assetId).select('+storageKey');
  if (!asset) throw ApiError.notFound('No such file', ERROR_CODES.FILE_NOT_FOUND);

  return asset;
};

export default {
  uploadCover,
  uploadAvatar,
  uploadEbook,
  listAssets,
  removeAsset,
  extractText,
  getReadableAsset,
  parseRange,
  recordAccess,
  createDownloadToken,
  resolveDownloadToken,
};
