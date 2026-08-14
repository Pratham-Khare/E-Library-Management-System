/**
 * ---------------------------------------------------------------------------
 * DIGITAL ASSET MODEL — an ebook file
 * ---------------------------------------------------------------------------
 * Metadata for a PDF or EPUB attached to a book. The bytes live on disk (or in
 * object storage); this row is what the application reasons about.
 *
 * THE FILE IS NEVER SERVED STATICALLY. `storageKey` is an internal path, not a
 * URL, and it is deliberately withheld from every API response. Reading an
 * ebook goes through a controller that verifies an active digital loan and
 * then streams the bytes — because a static mount would let anyone who
 * guessed or shared a URL download the library's entire collection without
 * ever borrowing anything.
 *
 * `checksum` (SHA-256 of the file) enables deduplication: uploading the same
 * PDF twice should reuse one file on disk rather than storing 40MB again.
 *
 * `extractedText` is the bridge to the AI subsystem. Summarising from a real
 * chapter produces a far better result than summarising from a two-sentence
 * catalogue blurb — and when extraction fails, summaries degrade to metadata
 * rather than the feature breaking.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import {
  EBOOK_FORMAT,
  EBOOK_FORMAT_VALUES,
  EXTRACTION_STATUS,
  EXTRACTION_STATUS_VALUES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

const digitalAssetSchema = new Schema(
  {
    book: {
      type: Schema.Types.ObjectId,
      ref: 'Book',
      required: [true, 'A digital asset must belong to a book'],
      index: true,
    },

    format: {
      type: String,
      enum: { values: EBOOK_FORMAT_VALUES, message: '{VALUE} is not a supported ebook format' },
      required: true,
    },

    /**
     * Where the bytes live, relative to the storage root.
     *
     * A GENERATED name (uuid + extension), never the client's filename.
     * Trusting an uploaded name invites path traversal (`../../.env`),
     * collisions between two files called `book.pdf`, and encoding problems
     * with non-ASCII names on Windows.
     *
     * `select: false` so it cannot leak into an API response by accident —
     * knowing the internal path is a step toward reaching the file directly.
     */
    storageKey: { type: String, required: true, select: false },

    /** What the uploader called it. Used for the download filename. */
    originalName: { type: String, required: true, trim: true, maxlength: 300 },

    mimeType: { type: String, required: true, trim: true },

    sizeBytes: { type: Number, required: true, min: 0 },

    /**
     * SHA-256 of the file contents.
     *
     * Two jobs: deduplication (the same PDF uploaded twice reuses one file on
     * disk), and integrity (a corrupted or truncated upload is detectable
     * rather than only discovered by a reader).
     */
    checksum: { type: String, required: true, index: true },

    pageCount: { type: Number, min: 0, default: null },

    /**
     * A preview is a sample chapter, readable WITHOUT borrowing — the digital
     * equivalent of flipping through a book in the shop. The full text still
     * requires an active loan.
     */
    isPreview: { type: Boolean, default: false },

    /* --- Text extraction (feeds the AI summariser) --------------------- */

    extractionStatus: {
      type: String,
      enum: EXTRACTION_STATUS_VALUES,
      default: EXTRACTION_STATUS.PENDING,
      index: true,
    },

    /**
     * Extracted text, truncated to a configured ceiling.
     *
     * `select: false` because it can run to hundreds of kilobytes; loading it
     * on every asset listing would be a serious and entirely pointless
     * expense. The AI service selects it explicitly when it needs it.
     */
    extractedText: { type: String, select: false, default: null },

    extractedCharCount: { type: Number, default: 0 },

    /** Why extraction failed, if it did. Not fatal — summaries fall back to metadata. */
    extractionError: { type: String, default: null, maxlength: 500 },

    extractedAt: { type: Date, default: null },

    /* --- Bookkeeping ---------------------------------------------------- */

    uploadedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** How many times it has been opened or downloaded. */
    accessCount: { type: Number, default: 0, min: 0 },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/** A book's assets, previews first. */
digitalAssetSchema.index({ book: 1, isPreview: 1 });

/**
 * Deduplication lookup: has this exact file been uploaded before?
 * Not unique — the same file may legitimately be attached to two different
 * catalogue records (an anthology and its standalone reprint).
 */
digitalAssetSchema.index({ checksum: 1, book: 1 });

/** The extraction worker's queue. */
digitalAssetSchema.index({ extractionStatus: 1, createdAt: 1 });

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** Human-readable size, e.g. "4.2 MB". */
digitalAssetSchema.virtual('sizeFormatted').get(function sizeFormatted() {
  const bytes = this.sizeBytes ?? 0;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
});

/** Is there usable text for the AI summariser? */
digitalAssetSchema.virtual('hasExtractedText').get(function hasExtractedText() {
  return this.extractionStatus === EXTRACTION_STATUS.COMPLETED && this.extractedCharCount > 0;
});

/* ===========================================================================
 * Statics
 * ======================================================================== */

/** Find an existing upload of the same file, for deduplication. */
digitalAssetSchema.statics.findByChecksum = function findByChecksum(checksum) {
  return this.findOne({ checksum }).select('+storageKey');
};

/**
 * Fetch an asset WITH its storage key.
 *
 * The only way to obtain the key, and deliberately explicit: the streaming
 * controller needs it to open the file, and nothing else should.
 */
digitalAssetSchema.statics.findWithStorageKey = function findWithStorageKey(assetId) {
  return this.findById(assetId).select('+storageKey');
};

export const DigitalAsset = model('DigitalAsset', digitalAssetSchema);

export default DigitalAsset;
