/**
 * One physical item on a shelf. Six copies of a title are six documents here
 * and one Book document.
 *
 * `claimAvailableCopy()` is where borrowing is made safe: a single atomic
 * findOneAndUpdate filtered on `status: 'AVAILABLE'`, so two concurrent claims
 * cannot both win. No transaction needed, which matters because a standalone
 * mongod has none.
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

/** One status change, kept as an audit trail rather than a silent overwrite. */
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

    /** Barcode on the item — scanned at the desk, unique library-wide. */
    accessionNumber: {
      type: String,
      required: [true, 'An accession number is required'],
      unique: true,
      trim: true,
      uppercase: true,
      maxlength: [50, 'Accession number cannot exceed 50 characters'],
    },

    /** Where it physically sits, e.g. "A-12-3" — aisle A, shelf 12, position 3. */
    shelfLocation: { type: String, trim: true, uppercase: true, maxlength: 50, default: null },

    /** AVAILABLE -> ON_LOAN is the atomic transition; see claimAvailableCopy(). */
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

    /** The loan holding this copy. Denormalised so a barcode scan answers "who has this?". */
    currentLoan: { type: Schema.Types.ObjectId, ref: 'Loan', default: null },

    /** Lifetime loans of THIS copy. Identifies items due for replacement. */
    loanCount: { type: Number, default: 0, min: 0 },
    lastBorrowedAt: { type: Date, default: null },

    statusHistory: [statusHistorySchema],

    notes: { type: String, trim: true, maxlength: 1000, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/**
 * The hot path: claimAvailableCopy() queries exactly this shape on every borrow,
 * so the compound index turns it into a seek rather than a scan.
 */
bookCopySchema.index({ book: 1, status: 1 });

/** Shelf-order listing for stocktaking. */
bookCopySchema.index({ shelfLocation: 1 });
/** "Show me everything currently out" for the circulation dashboard. */
bookCopySchema.index({ status: 1, updatedAt: -1 });

/* Virtuals */

bookCopySchema.virtual('isBorrowable').get(function isBorrowable() {
  return this.status === COPY_STATUS.AVAILABLE;
});

bookCopySchema.virtual('isRetired').get(function isRetired() {
  return this.status === COPY_STATUS.WITHDRAWN || this.status === COPY_STATUS.LOST;
});

/* Hooks */

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

    // Bounded, or a heavily circulated copy drifts toward the 16MB document ceiling.
  if (this.statusHistory.length > 50) {
    this.statusHistory = this.statusHistory.slice(-50);
  }

  return next();
});

/** Remember the pre-change status so the history entry can record `from`. */
bookCopySchema.post('init', function rememberStatus() {
  this._previousStatus = this.status;
});

/* Statics */

/**
 * Atomically claim an available copy — the compare-and-swap that makes
 * concurrent borrowing correct. Returns null when nothing was free.
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
      // Least-circulated copy first, so wear spreads across the stock.
      sort: { loanCount: 1 },
      ...(session ? { session } : {}),
    }
  );
};

/**
 * Release a copy back to the shelf. Filtered on ON_LOAN, so a double return
 * cannot increment availability twice.
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
 * Next accession number, ACC-<year>-<sequence>. Allocated through the atomic
 * Counter rather than countDocuments() + 1, which collides on concurrent adds.
 */
bookCopySchema.statics.generateAccessionNumber = async function generateAccessionNumber() {
  const year = new Date().getFullYear();
  const sequence = await Counter.next(`accessionNumber:${year}`);
  return `ACC-${year}-${String(sequence).padStart(6, '0')}`;
};

export const BookCopy = model('BookCopy', bookCopySchema);

export default BookCopy;
