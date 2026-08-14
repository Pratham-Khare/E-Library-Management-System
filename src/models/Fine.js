/**
 * A charge against a member — overdue accrual, damage, or replacement cost.
 *
 * A separate collection rather than a field on Loan: one loan can raise more
 * than one charge, fines outlive their loans in accounting terms, and "what
 * does this member owe?" should not have to walk the circulation history.
 *
 * `amount` is frozen when the fine is raised — the daily rate lives in config
 * and may change, but an assessed fine must not re-price itself.
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import {
  FINE_REASON,
  FINE_REASON_VALUES,
  FINE_STATUS,
  FINE_STATUS_VALUES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

const fineSchema = new Schema(
  {
    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: [true, 'A fine must belong to a member'],
      index: true,
    },

    /** Null for a manually raised charge with no loan behind it. */
    loan: { type: Schema.Types.ObjectId, ref: 'Loan', default: null, index: true },

    book: { type: Schema.Types.ObjectId, ref: 'Book', default: null },

    reason: {
      type: String,
      enum: { values: FINE_REASON_VALUES, message: '{VALUE} is not a valid fine reason' },
      required: true,
    },

    /** Frozen at assessment — a config change must not alter an existing debt. */
    amount: { type: Number, required: true, min: 0 },

    currency: { type: String, default: () => config.library.fines.currency, maxlength: 3 },

    /**
     * Days used in the calculation, after the grace period. Recorded so a
     * disputed fine can be shown as arithmetic: "12 late, 2 forgiven, 10 × ₹5".
     */
    daysOverdue: { type: Number, default: null, min: 0 },
    chargeableDays: { type: Number, default: null, min: 0 },

    /** The daily rate in force when this fine was raised. */
    ratePerDay: { type: Number, default: null, min: 0 },

    /** True when the amount hit the per-loan ceiling. */
    cappedAtMaximum: { type: Boolean, default: false },

    status: {
      type: String,
      enum: { values: FINE_STATUS_VALUES, message: '{VALUE} is not a valid fine status' },
      default: FINE_STATUS.PENDING,
      index: true,
    },

    /* --- Settlement -------------------------------------------------------- */

    paidAt: { type: Date, default: null },
    /** Staff member who took the payment. */
    collectedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    paymentMethod: { type: String, trim: true, maxlength: 50, default: null },
    /** Receipt or transaction reference from whatever handled the money. */
    paymentReference: { type: String, trim: true, maxlength: 100, default: null },

    /* --- Waiver ------------------------------------------------------------- */

    waivedAt: { type: Date, default: null },
    waivedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    /** Why it was forgiven. Required when waiving — an unexplained write-off is indistinguishable from a favour. */
    waiverNote: { type: String, trim: true, maxlength: 500, default: null },

    /** Free-text detail, e.g. what exactly was damaged. */
    description: { type: String, trim: true, maxlength: 500, default: null },

    assessedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/**
 * "What does this member owe?" — evaluated on every borrow attempt as part of
 * the eligibility check, so it needs to be an index seek.
 */
fineSchema.index({ user: 1, status: 1 });

/** The staff fines dashboard: outstanding debts, largest first. */
fineSchema.index({ status: 1, createdAt: -1 });

/** Revenue reporting by period. */
fineSchema.index({ paidAt: -1 });

/* Virtuals */

/** Is this still owed? Only PENDING fines count toward the borrowing block. */
fineSchema.virtual('isOutstanding').get(function isOutstanding() {
  return this.status === FINE_STATUS.PENDING;
});

/** Formatted for display, e.g. "INR 40.00". */
fineSchema.virtual('formattedAmount').get(function formattedAmount() {
  return `${this.currency} ${Number(this.amount).toFixed(2)}`;
});

/* Statics */

/**
 * Total a member owes. An aggregation rather than summing in JavaScript, since
 * this runs on every borrow attempt. `$group` yields no documents for an empty
 * match, so the optional chain is doing real work.
 */
fineSchema.statics.outstandingTotalForUser = async function outstandingTotalForUser(userId) {
  const [result] = await this.aggregate([
    {
      $match: {
        user: new mongoose.Types.ObjectId(String(userId)),
        status: FINE_STATUS.PENDING,
      },
    },
    { $group: { _id: null, total: { $sum: '$amount' }, count: { $sum: 1 } } },
  ]);

  return { total: result?.total ?? 0, count: result?.count ?? 0 };
};

/** Outstanding fines for a member, newest first. */
fineSchema.statics.findOutstandingForUser = function findOutstandingForUser(userId) {
  return this.find({ user: userId, status: FINE_STATUS.PENDING })
    .populate('book', 'title')
    .populate('loan', 'dueAt returnedAt')
    .sort({ createdAt: -1 });
};

/**
 * The fine already raised against a loan. Makes overdue accrual idempotent —
 * the nightly job updates rather than raising a second one.
 */
fineSchema.statics.findForLoan = function findForLoan(loanId, reason = FINE_REASON.OVERDUE) {
  return this.findOne({ loan: loanId, reason });
};

export const Fine = model('Fine', fineSchema);

export default Fine;
