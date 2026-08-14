/**
 * ---------------------------------------------------------------------------
 * FINE MODEL
 * ---------------------------------------------------------------------------
 * A charge raised against a member — overdue accrual, damage, or replacement
 * cost for a lost item.
 *
 * A SEPARATE COLLECTION, not a field on Loan, for three reasons:
 *
 *   1. One loan can generate more than one charge. A book returned late AND
 *      damaged is two distinct fines with different reasons and different
 *      dispute outcomes.
 *   2. Fines outlive their loans in accounting terms. A returned loan is
 *      closed; the unpaid fine it produced is still owed.
 *   3. "What does this member owe?" and "what did we collect this month?" are
 *      queries about money, and they should not have to walk the circulation
 *      history to answer.
 *
 * `amount` is FROZEN at the moment the fine is raised. The daily rate lives in
 * configuration and may change; a fine already assessed must not silently
 * re-price itself because someone edited .env.
 * ---------------------------------------------------------------------------
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

    /**
     * The amount owed, frozen at assessment time.
     *
     * Recomputing this from the current daily rate would mean a member's debt
     * changing because an administrator adjusted a config value — including
     * for fines already settled.
     */
    amount: { type: Number, required: true, min: 0 },

    currency: { type: String, default: () => config.library.fines.currency, maxlength: 3 },

    /**
     * Days used in the calculation, AFTER the grace period.
     *
     * Recorded so a member disputing a fine can be shown the arithmetic —
     * "12 days late, 2 forgiven, 10 × ₹5" — rather than an unexplained number.
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
    /**
     * Why it was forgiven. REQUIRED when waiving — enforced in the service.
     * A waiver is staff writing off money the library was owed, and an
     * unexplained one is indistinguishable from a mistake or a favour.
     */
    waiverNote: { type: String, trim: true, maxlength: 500, default: null },

    /** Free-text detail, e.g. what exactly was damaged. */
    description: { type: String, trim: true, maxlength: 500, default: null },

    assessedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/**
 * "What does this member owe?" — evaluated on every borrow attempt as part of
 * the eligibility check, so it needs to be an index seek.
 */
fineSchema.index({ user: 1, status: 1 });

/** The staff fines dashboard: outstanding debts, largest first. */
fineSchema.index({ status: 1, createdAt: -1 });

/** Revenue reporting by period. */
fineSchema.index({ paidAt: -1 });

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** Is this still owed? Only PENDING fines count toward the borrowing block. */
fineSchema.virtual('isOutstanding').get(function isOutstanding() {
  return this.status === FINE_STATUS.PENDING;
});

/** Formatted for display, e.g. "INR 40.00". */
fineSchema.virtual('formattedAmount').get(function formattedAmount() {
  return `${this.currency} ${Number(this.amount).toFixed(2)}`;
});

/* ===========================================================================
 * Statics
 * ======================================================================== */

/**
 * Total a member currently owes.
 *
 * An aggregation rather than fetching the rows and summing in JavaScript: the
 * database can add numbers, and this runs on every borrow attempt.
 *
 * Returns 0 when nothing is owed — `$group` produces NO documents for an empty
 * match, so the optional chain is doing real work, not defensive noise.
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
 * The fine already raised against a loan, if any.
 *
 * Used to make overdue accrual IDEMPOTENT: the nightly job updates an existing
 * fine rather than creating a second one, so running it twice in a day does
 * not double a member's debt.
 */
fineSchema.statics.findForLoan = function findForLoan(loanId, reason = FINE_REASON.OVERDUE) {
  return this.findOne({ loan: loanId, reason });
};

export const Fine = model('Fine', fineSchema);

export default Fine;
