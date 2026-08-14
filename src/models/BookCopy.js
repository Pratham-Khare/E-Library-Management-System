/**
 * ---------------------------------------------------------------------------
 * BOOK COPY MODEL — one physical item on a shelf
 * ---------------------------------------------------------------------------
 * Six copies of the same title are six documents here and one Book document.
 *
 * THIS COLLECTION IS WHERE BORROWING IS MADE SAFE UNDER CONCURRENCY.
 *
 * The obvious implementation of "borrow a book" is:
 *
 *     const copy = await BookCopy.findOne({ book, status: 'AVAILABLE' });
 *     copy.status = 'ON_LOAN';
 *     await copy.save();
 *
 * That is a read-then-write, and two simultaneous requests both read the same
 * AVAILABLE copy before either writes. Both succeed. One physical book, two
 * borrowers, and a librarian with an argument to referee.
 *
 * `claimAvailableCopy()` below instead uses a single atomic `findOneAndUpdate`
 * filtered on `status: 'AVAILABLE'` — a compare-and-swap. MongoDB guarantees
 * single-document atomicity, so exactly one of two concurrent claims matches;
 * the other gets null and is told to try again. No transaction required, which
 * matters because a standalone `mongod` has none.
 *
 * `accessionNumber` is the barcode physically stuck on the item. It is what a
 * librarian scans, so it must be unique across the entire library.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import { Counter } from './Counter.js';
import {
  COPY_STATUS,
  COPY_STATUS_VALUES,
  COPY_CONDITION,
  COPY_CONDITION_VALUES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

/**
 * An entry in the copy's status history.
 *
 * Kept because "this copy has been marked damaged three times in a year" is a
 * real acquisitions signal, and because a copy going missing needs an audit
 * trail rather than a silently changed field.
 */
const statusHistorySchema = new Schema(
  {
    from: { type: String, enum: COPY_STATUS_VALUES },
    to: { type: String, enum: COPY_STATUS_VALUES, required: true },
    at: { type: Date, default: Date.now },
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    note: { type: String, trim: true, maxlength: 500 },
  },
  { _id: false }
);

const bookCopySchema = new Schema(
  {
    book: {
      type: Schema.Types.ObjectId,
      ref: 'Book',
      required: [true, 'A copy must belong to a book'],
      index: true,
    },

    /**
     * The barcode on the physical item — what a librarian scans at the desk.
     * Unique across the whole library, not just within a title.
     */
    accessionNumber: {
      type: String,
      required: [true, 'An accession number is required'],
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: [50, 'Accession number cannot exceed 50 characters'],
    },

    /**
     * Where it physically sits, e.g. "A-12-3" for aisle A, shelf 12, position 3.
     * The difference between "we own it" and "you can find it".
     */
    shelfLocation: { type: String, trim: true, uppercase: true, maxlength: 50, default: null },

    /**
     * Current state. AVAILABLE -> ON_LOAN is the atomic transition that makes
     * borrowing correct; see claimAvailableCopy() below.
     */
    status: {
      type: String,
      enum: { values: COPY_STATUS_VALUES, message: '{VALUE} is not a valid copy status' },
      default: COPY_STATUS.AVAILABLE,
      index: true,
    },

    condition: {
      type: String,
      enum: { values: COPY_CONDITION_VALUES, message: '{VALUE} is not a valid condition' },
      default: COPY_CONDITION.GOOD,
    },

    /* --- Acquisition ---------------------------------------------------- */

    acquiredOn: { type: Date, default: Date.now },
    /** What the library paid. Used to price a replacement fine. */
    cost: { type: Number, min: 0, default: null },
    source: { type: String, trim: true, maxlength: 200, default: null },

    /* --- Circulation ----------------------------------------------------- */

    /**
     * The loan currently holding this copy, when status is ON_LOAN.
     * Denormalised so the desk can answer "who has this?" from a barcode scan
     * without querying the Loan collection.
     */
    currentLoan: { type: Schema.Types.ObjectId, ref: 'Loan', default: null },

    /** Lifetime loans of THIS copy. Identifies items due for replacement. */
    loanCount: { type: Number, default: 0, min: 0 },
    lastBorrowedAt: { type: Date, default: null },

    statusHistory: [statusHistorySchema],

    notes: { type: String, trim: true, maxlength: 1000, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/**
 * THE MOST IMPORTANT INDEX IN THE CIRCULATION PATH.
 *
 * `claimAvailableCopy()` queries exactly `{ book, status: 'AVAILABLE' }`, on
 * every single borrow attempt. This compound index turns that into an index
 * seek rather than a scan across every copy of a popular title.
 */
bookCopySchema.index({ book: 1, status: 1 });

/** Shelf-order listing for stocktaking. */
bookCopySchema.index({ shelfLocation: 1 });
/** "Show me everything currently out" for the circulation dashboard. */
bookCopySchema.index({ status: 1, updatedAt: -1 });

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** Can this copy be borrowed right now? */
bookCopySchema.virtual('isBorrowable').get(function isBorrowable() {
  return this.status === COPY_STATUS.AVAILABLE;
});

/** Is it out of circulation permanently? */
bookCopySchema.virtual('isRetired').get(function isRetired() {
  return this.status === COPY_STATUS.WITHDRAWN || this.status === COPY_STATUS.LOST;
});

/* ===========================================================================
 * Hooks
 * ======================================================================== */

/** Record every status change, so a copy's history is never lost to an overwrite. */
bookCopySchema.pre('save', function recordStatusChange(next) {
  if (this.isNew || !this.isModified('status')) return next();

  // `$locals` is Mongoose's per-document scratch space — the service sets
  // `_statusChangeContext` before saving so the history entry carries who and why.
  const context = this.$locals?._statusChangeContext ?? {};

  this.statusHistory.push({
    from: this._previousStatus ?? undefined,
    to: this.status,
    at: new Date(),
    by: context.by ?? null,
    note: context.note ?? null,
  });

  // Keep history bounded. A heavily circulated copy could otherwise accumulate
  // thousands of entries and push the document toward MongoDB's 16MB ceiling.
  if (this.statusHistory.length > 50) {
    this.statusHistory = this.statusHistory.slice(-50);
  }

  return next();
});

/** Remember the pre-change status so the history entry can record `from`. */
bookCopySchema.post('init', function rememberStatus() {
  this._previousStatus = this.status;
});

/* ===========================================================================
 * Statics
 * ======================================================================== */

/**
 * ATOMICALLY claim an available copy of a book.
 *
 * The single most important function in the circulation engine.
 *
 * `findOneAndUpdate` with `status: 'AVAILABLE'` in the FILTER is a
 * compare-and-swap: MongoDB matches and updates one document as a single
 * atomic operation, so of two concurrent callers exactly one matches and the
 * other receives null. There is no window between reading and writing for a
 * second request to slip into.
 *
 * This is why borrowing is correct on a standalone `mongod` with no
 * transaction support at all — the guarantee comes from single-document
 * atomicity, which every MongoDB deployment provides.
 *
 * @param {string} bookId
 * @param {string} loanId Set as `currentLoan` in the same operation.
 * @param {import('mongoose').ClientSession|null} [session]
 * @returns {Promise<object|null>} The claimed copy, or null if none was free.
 */
bookCopySchema.statics.claimAvailableCopy = async function claimAvailableCopy(
  bookId,
  loanId,
  session = null
) {
  return this.findOneAndUpdate(
    // FILTER — the compare half of compare-and-swap. A copy already ON_LOAN
    // cannot match, so it cannot be claimed twice.
    { book: bookId, status: COPY_STATUS.AVAILABLE },
    {
      $set: {
        status: COPY_STATUS.ON_LOAN,
        currentLoan: loanId,
        lastBorrowedAt: new Date(),
      },
      $inc: { loanCount: 1 },
    },
    {
      new: true,
      // Prefer the lowest-circulation copy, so wear is spread evenly across
      // the library's stock instead of destroying whichever one sorts first.
      sort: { loanCount: 1 },
      ...(session ? { session } : {}),
    }
  );
};

/**
 * Release a copy back to the shelf. The inverse of the claim.
 *
 * Also filtered on the expected current status, so a double-return cannot
 * increment availability twice and invent a copy the library does not own.
 */
bookCopySchema.statics.releaseCopy = async function releaseCopy(copyId, session = null) {
  return this.findOneAndUpdate(
    { _id: copyId, status: COPY_STATUS.ON_LOAN },
    { $set: { status: COPY_STATUS.AVAILABLE, currentLoan: null } },
    { new: true, ...(session ? { session } : {}) }
  );
};

/** Copies free for a title right now. */
bookCopySchema.statics.countAvailable = function countAvailable(bookId) {
  return this.countDocuments({ book: bookId, status: COPY_STATUS.AVAILABLE });
};

/**
 * Generate the next accession number.
 *
 * Format: ACC-<year>-<sequence>, e.g. ACC-2026-000137. Human-readable and
 * ordered, which matters when someone is reading it off a spine label.
 *
 * Allocated through the atomic Counter, NOT `countDocuments() + 1` — the
 * latter is a read-then-write and produces duplicates whenever copies are
 * added concurrently, which a bulk acquisition import does by definition.
 * See models/Counter.js.
 */
bookCopySchema.statics.generateAccessionNumber = async function generateAccessionNumber() {
  const year = new Date().getFullYear();
  const sequence = await Counter.next(`accessionNumber:${year}`);
  return `ACC-${year}-${String(sequence).padStart(6, '0')}`;
};

export const BookCopy = model('BookCopy', bookCopySchema);

export default BookCopy;
