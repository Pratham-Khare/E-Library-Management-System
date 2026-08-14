/**
 * One review per member per book, enforced by a unique compound index rather
 * than an application check, which would race.
 *
 * `isVerifiedBorrower` distinguishes someone who read the thing from someone
 * with an opinion about its cover. Ratings feed a denormalised aggregate on
 * Book, recomputed in full after every change.
 */

import mongoose from 'mongoose';
import {
  REVIEW_STATUS,
  REVIEW_STATUS_VALUES,
  MODERATION_VERDICT,
  MODERATION_VERDICT_VALUES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

/** The outcome of the moderation pass, AI or heuristic. */
const moderationSchema = new Schema(
  {
    verdict: {
      type: String,
      enum: MODERATION_VERDICT_VALUES,
      default: MODERATION_VERDICT.NOT_CHECKED,
    },
    reasons: [{ type: String, maxlength: 200 }],
    /** 0 = clean, 1 = certainly abusive. */
    score: { type: Number, min: 0, max: 1, default: 0 },
    /** Whether a model was actually consulted, or only the cheap pre-filter. */
    usedAi: { type: Boolean, default: false },
    checkedAt: { type: Date, default: null },
  },
  { _id: false }
);

const reviewSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    book: { type: Schema.Types.ObjectId, ref: 'Book', required: true, index: true },

    rating: {
      type: Number,
      required: [true, 'A rating is required'],
      min: [1, 'Rating must be between 1 and 5'],
      max: [5, 'Rating must be between 1 and 5'],
      // Half-stars would complicate the histogram for no real benefit.
      validate: { validator: Number.isInteger, message: 'Rating must be a whole number' },
    },

    title: { type: String, trim: true, maxlength: 200, default: null },
    body: { type: String, trim: true, maxlength: 5000, default: null },

    status: {
      type: String,
      enum: REVIEW_STATUS_VALUES,
      default: REVIEW_STATUS.APPROVED,
      index: true,
    },

    /**
     * Set at write time, not read time — a genuine borrower stays verified
     * after returning the book.
     */
    isVerifiedBorrower: { type: Boolean, default: false },

    aiModeration: { type: moderationSchema, default: () => ({}) },

    /** Members who found this review useful. Stored as ids so a vote is
     *  idempotent — voting twice cannot inflate the count. */
    helpfulVotes: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    /** Reports from members, for the moderation queue. */
    reportCount: { type: Number, default: 0, min: 0 },
    reportedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],

    moderatedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    moderatedAt: { type: Date, default: null },
    moderationNote: { type: String, trim: true, maxlength: 500, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/** Enforced by the database: an application check has a window two concurrent requests can both pass. */
reviewSchema.index({ user: 1, book: 1 }, { unique: true, name: 'one_review_per_user_per_book' });

/** A book's review list: approved only, most helpful first. */
reviewSchema.index({ book: 1, status: 1, createdAt: -1 });

/** The moderation queue: reported or flagged reviews, worst first. */
reviewSchema.index({ status: 1, reportCount: -1 });

/* Virtuals */

reviewSchema.virtual('helpfulCount').get(function helpfulCount() {
  return this.helpfulVotes?.length ?? 0;
});

/** Is it publicly visible? */
reviewSchema.virtual('isPublished').get(function isPublished() {
  return this.status === REVIEW_STATUS.APPROVED;
});

export const Review = model('Review', reviewSchema);

export default Review;
