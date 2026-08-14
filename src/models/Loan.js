/**
 * The central circulation record — one document per borrowing event.
 *
 * PHYSICAL loans take a specific BookCopy off the shelf and accrue a fine when
 * late; DIGITAL loans consume a concurrent licence and expire on their own.
 * One model, because the differences are two nullable fields.
 *
 * `dueAt` is fixed from the membership policy AT ISSUE TIME. Changing the loan
 * period in .env later must not silently move an existing due date.
 */

import mongoose from 'mongoose';
import {
  LOAN_TYPE,
  LOAN_TYPE_VALUES,
  LOAN_STATUS,
  LOAN_STATUS_VALUES,
  OPEN_LOAN_STATUSES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

/** One renewal, recorded rather than just counted — "when, and by whom?" is what gets asked when a fine is disputed. */
const renewalSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    previousDueAt: { type: Date, required: true },
    newDueAt: { type: Date, required: true },
    /** Null when the member renewed it themselves; set when staff did. */
    by: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { _id: false }
);

const loanSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A loan must belong to a member'],
      index: true,
    },

    book: {
      type: Schema.Types.ObjectId,
      ref: 'Book',
      required: [true, 'A loan must reference a book'],
      index: true,
    },

    type: {
      type: String,
      enum: { values: LOAN_TYPE_VALUES, message: '{VALUE} is not a valid loan type' },
      required: true,
      index: true,
    },

    /** The specific physical item. Null for a digital loan. */
    copy: { type: Schema.Types.ObjectId, ref: 'BookCopy', default: null, index: true },

    /** The ebook file. Null for a physical loan. */
    digitalAsset: { type: Schema.Types.ObjectId, ref: 'DigitalAsset', default: null },

    /* --- Dates --------------------------------------------------------- */

    issuedAt: { type: Date, default: Date.now, index: true },

    /** Fixed at issue time, never recomputed on read — see the header. */
    dueAt: { type: Date, required: true, index: true },

    returnedAt: { type: Date, default: null },

    /* --- Status --------------------------------------------------------- */

    status: {
      type: String,
      enum: { values: LOAN_STATUS_VALUES, message: '{VALUE} is not a valid loan status' },
      default: LOAN_STATUS.ACTIVE,
      index: true,
    },

    /* --- Renewals -------------------------------------------------------- */

    renewalCount: { type: Number, default: 0, min: 0 },
    renewalHistory: [renewalSchema],

    /* --- Who handled it ---------------------------------------------------- */

    /** Staff member who issued it at the desk. Null for a self-service borrow. */
    issuedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Staff member who processed the return. */
    returnedTo: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /* --- Fines -------------------------------------------------------------- */

    /** The fine raised against this loan, if any. */
    fine: { type: Schema.Types.ObjectId, ref: 'Fine', default: null },

    /**
     * Frozen at return. Stored rather than derived, so "how late was it?"
     * stops changing once the book is back.
     */
    daysOverdueAtReturn: { type: Number, default: null },

    /* --- Notification bookkeeping --------------------------------------------- */

    /** Stops the nightly job from sending the same reminder every night. */
    dueSoonNotifiedAt: { type: Date, default: null },
    overdueNotifiedAt: { type: Date, default: null },

    notes: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/**
 * "What does this member currently have out?" — checked on EVERY borrow
 * attempt as part of the eligibility test, and on every profile view.
 */
loanSchema.index({ user: 1, status: 1 });

/** The nightly overdue sweep, as an index range scan rather than a collection scan. */
loanSchema.index({ status: 1, dueAt: 1 });

/** "Does this member already have this title?" — the duplicate-borrow check. */
loanSchema.index({ user: 1, book: 1, status: 1 });

/** Digital-loan expiry sweep. */
loanSchema.index({ type: 1, status: 1, dueAt: 1 });

/** A book's circulation history, newest first. */
loanSchema.index({ book: 1, issuedAt: -1 });

/* Virtuals */

/** Is the item still out? */
loanSchema.virtual('isOpen').get(function isOpen() {
  return OPEN_LOAN_STATUSES.includes(this.status);
});

/**
 * Whole days past due. Computed from calendar dates, not elapsed milliseconds:
 * due at 09:00 and returned at 17:00 the same day is not one day late.
 */
loanSchema.virtual('daysOverdue').get(function daysOverdue() {
  if (!this.isOpen) return this.daysOverdueAtReturn ?? 0;

  const due = new Date(this.dueAt);
  const now = new Date();

  // Compare at day granularity, in local time.
  const dueDay = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());

  return Math.max(0, Math.round((today - dueDay) / 86_400_000));
});

/** Days remaining before it is due. Negative once overdue. */
loanSchema.virtual('daysRemaining').get(function daysRemaining() {
  const due = new Date(this.dueAt);
  const now = new Date();
  const dueDay = Date.UTC(due.getFullYear(), due.getMonth(), due.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((dueDay - today) / 86_400_000);
});

/** Is it past due right now? True even before the nightly job flips the status. */
loanSchema.virtual('isOverdue').get(function isOverdue() {
  return this.isOpen && new Date() > new Date(this.dueAt);
});

/* Statics */

/** A member's currently open loans. */
loanSchema.statics.findOpenForUser = function findOpenForUser(userId) {
  return this.find({ user: userId, status: { $in: OPEN_LOAN_STATUSES } });
};

/** How many items a member has out. Used by the eligibility check. */
loanSchema.statics.countOpenForUser = function countOpenForUser(userId) {
  return this.countDocuments({ user: userId, status: { $in: OPEN_LOAN_STATUSES } });
};

/** Does this member already hold this title? Prevents hoarding both copies. */
loanSchema.statics.hasOpenLoanForBook = function hasOpenLoanForBook(userId, bookId) {
  return this.exists({ user: userId, book: bookId, status: { $in: OPEN_LOAN_STATUSES } });
};

/** Does this member hold anything overdue? Blocks further borrowing. */
loanSchema.statics.hasOverdueItems = function hasOverdueItems(userId) {
  return this.exists({
    user: userId,
    status: { $in: OPEN_LOAN_STATUSES },
    dueAt: { $lt: new Date() },
  });
};

/** Open loans past due, as a cursor — years of history should stream, not load. */
loanSchema.statics.findOverdueCursor = function findOverdueCursor() {
  return this.find({
    status: { $in: OPEN_LOAN_STATUSES },
    dueAt: { $lt: new Date() },
  })
    .populate('user', 'name email stats notificationPreferences')
    .populate('book', 'title price')
    .cursor();
};

/**
 * Loans due within `days` that have not been reminded about. The
 * `dueSoonNotifiedAt` filter stops the job emailing the same member nightly.
 */
loanSchema.statics.findDueSoon = function findDueSoon(days) {
  const now = new Date();
  const threshold = new Date(now.getTime() + days * 86_400_000);

  return this.find({
    status: LOAN_STATUS.ACTIVE,
    dueAt: { $gte: now, $lte: threshold },
    dueSoonNotifiedAt: null,
  })
    .populate('user', 'name email notificationPreferences')
    .populate('book', 'title');
};

/** Digital loans whose term has elapsed. Their licences need releasing. */
loanSchema.statics.findExpiredDigital = function findExpiredDigital() {
  return this.find({
    type: LOAN_TYPE.DIGITAL,
    status: { $in: OPEN_LOAN_STATUSES },
    dueAt: { $lt: new Date() },
  });
};

export const Loan = model('Loan', loanSchema);

export default Loan;
