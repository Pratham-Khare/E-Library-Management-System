/**
 * Metadata for an ebook file. The bytes live on disk; this row is what the
 * application reasons about.
 *
 * The file is NEVER served statically — `storageKey` is an internal path, not
 * a URL, and is withheld from every response. Reading goes through a
 * controller that verifies an active digital loan first.
 *
 * `checksum` deduplicates uploads; `extractedText` feeds the AI subsystem, and
 * when extraction fails summaries degrade to metadata rather than breaking.
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
     * A GENERATED name (uuid + extension), never the client's filename, which
     * would invite path traversal and collisions. `select: false` so the
     * internal path cannot leak into a response.
     */
    storageKey: { type: String, required: true, select: false },

    /** What the uploader called it. Used for the download filename. */
    originalName: { type: String, required: true, trim: true, maxlength: 300 },

    mimeType: { type: String, required: true, trim: true },

    sizeBytes: { type: Number, required: true, min: 0 },

    /** SHA-256: deduplication, and detecting a truncated upload. */
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

    /** `select: false` — this can run to hundreds of KB, and only the AI service needs it. */
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

/* Indexes */

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

/* Virtuals */

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

/* Statics */

/** Find an existing upload of the same file, for deduplication. */
digitalAssetSchema.statics.findByChecksum = function findByChecksum(checksum) {
  return this.findOne({ checksum }).select('+storageKey');
};

/** Fetch an asset WITH its storage key — deliberately explicit; only the streaming controller needs it. */
digitalAssetSchema.statics.findWithStorageKey = function findWithStorageKey(assetId) {
  return this.findById(assetId).select('+storageKey');
};

export const DigitalAsset = model('DigitalAsset', digitalAssetSchema);

export default DigitalAsset;
