/**
 * Ratings, reviews, helpful votes and moderation.
 */

import logger from '../utils/logger.js';
import { Review } from '../models/Review.js';
import { Book } from '../models/Book.js';
import { Loan } from '../models/Loan.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { REVIEW_STATUS, MODERATION_VERDICT, NOTIFICATION_TYPE } from '../constants/enums.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import * as notificationService from './notification.service.js';

/* Heuristic moderation */

/**
 * A cheap pre-filter, run on every review.
 */
export const heuristicModeration = (text) => {
  if (!text || text.trim().length === 0) {
    return { verdict: MODERATION_VERDICT.CLEAN, reasons: [], score: 0, conclusive: true };
  }

  const reasons = [];
  let score = 0;

  const lower = text.toLowerCase();

  // Spam signals — links and contact details in a book review are almost
  // always someone advertising something.
  if (/https?:\/\/|www\.|\b\w+\.(com|net|org|xyz|shop)\b/i.test(text)) {
    reasons.push('Contains a web link');
    score += 0.4;
  }
  if (/\b\d{10}\b|\bwhatsapp\b|\btelegram\b/i.test(lower)) {
    reasons.push('Contains contact details');
    score += 0.4;
  }
  if (/\b(buy now|free download|click here|discount|earn money|work from home)\b/i.test(lower)) {
    reasons.push('Contains promotional language');
    score += 0.5;
  }

  // Low-effort signals.
  const letters = text.replace(/[^a-z]/gi, '');
  if (letters.length > 20) {
    const upperRatio = (text.match(/[A-Z]/g) ?? []).length / letters.length;
    if (upperRatio > 0.6) {
      reasons.push('Mostly capital letters');
      score += 0.2;
    }
  }
  if (/(.)\1{6,}/.test(text)) {
    reasons.push('Repeated characters');
    score += 0.2;
  }

  /**
   * A deliberately small list of unambiguous profanity. Nuanced toxicity
   * detection is what the AI pass is for; this catches the blatant cases so
   * they never cost a model call.
   */
  const blatant = ['fuck', 'shit', 'bastard', 'asshole', 'bitch', 'cunt'];
  const profanityHits = blatant.filter((word) => new RegExp(`\\b${word}`, 'i').test(lower)).length;
  if (profanityHits > 0) {
    reasons.push(profanityHits === 1 ? 'Contains profanity' : `Contains profanity (${profanityHits} terms)`);
    score += 0.7 + (profanityHits - 1) * 0.15;
  }

  const clamped = Math.min(1, score);

  if (clamped >= 0.7) {
    return { verdict: MODERATION_VERDICT.BLOCKED, reasons, score: clamped, conclusive: true };
  }
  if (clamped === 0) {
    return { verdict: MODERATION_VERDICT.CLEAN, reasons: [], score: 0, conclusive: true };
  }

  // Something suspicious but not damning — this is the band worth spending an
  // AI call on, if the feature is enabled and quota allows.
  return { verdict: MODERATION_VERDICT.FLAGGED, reasons, score: clamped, conclusive: false };
};

/* Writing */

/**
 * Create a review.
 */
export const create = async (userId, bookId, { rating, title, body }) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false });
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  /**
   * Verified-borrower badge. Any loan counts, open or closed — someone who
   * read the book last year is no less a real reader than someone holding it
   * now, and stripping the badge on return would be perverse.
   */
  const hasBorrowed = await Loan.exists({ user: userId, book: bookId });

  const moderation = heuristicModeration([title, body].filter(Boolean).join(' '));

  // Blocked outright by the pre-filter — never published, and the author is
  // told plainly rather than left wondering why it vanished.
  if (moderation.verdict === MODERATION_VERDICT.BLOCKED) {
    throw ApiError.badRequest(
      `This review could not be published: ${moderation.reasons.join('; ')}.`,
      ERROR_CODES.REVIEW_BLOCKED_BY_MODERATION,
      { details: { reasons: moderation.reasons } }
    );
  }

  /**
   * ESCALATE TO THE MODEL ONLY WHEN THE HEURISTIC WAS INCONCLUSIVE.
   */
  let finalModeration = moderation;

  if (!moderation.conclusive) {
    const { moderateReview } = await import('./ai.service.js');
    const aiVerdict = await moderateReview({ rating, title, body });

    // Null means no call could be made — keep the heuristic verdict rather
    // than losing the review over an unavailable service.
    if (aiVerdict) {
      finalModeration = { ...aiVerdict, conclusive: true };

      if (aiVerdict.verdict === MODERATION_VERDICT.BLOCKED) {
        throw ApiError.badRequest(
          `This review could not be published: ${aiVerdict.reasons.join('; ')}.`,
          ERROR_CODES.REVIEW_BLOCKED_BY_MODERATION,
          { details: { reasons: aiVerdict.reasons } }
        );
      }
    }
  }

  let review;
  try {
    review = await Review.create({
      user: userId,
      book: bookId,
      rating,
      title,
      body,
      isVerifiedBorrower: Boolean(hasBorrowed),
      // Flagged reviews are published but surfaced in the moderation queue —
      // holding back every borderline review would make the feature feel broken.
      status: REVIEW_STATUS.APPROVED,
      aiModeration: {
        verdict: finalModeration.verdict,
        reasons: finalModeration.reasons,
        score: finalModeration.score,
        usedAi: finalModeration.usedAi ?? false,
        checkedAt: new Date(),
      },
    });
  } catch (error) {
    if (error.code === 11000) {
      throw ApiError.conflict(
        'You have already reviewed this book. Edit your existing review instead.',
        ERROR_CODES.REVIEW_ALREADY_EXISTS
      );
    }
    throw error;
  }

  await Promise.all([
    Book.recalculateRating(bookId),
    User.updateOne({ _id: userId }, { $inc: { 'stats.reviewCount': 1 } }),
  ]);

  logger.info('Review created', {
    reviewId: String(review._id),
    bookId: String(bookId),
    rating,
    verified: Boolean(hasBorrowed),
  });

  return review;
};

/** Edit your own review. */
export const update = async (reviewId, userId, data) => {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);

  if (String(review.user) !== String(userId)) {
    throw ApiError.forbidden('This is not your review', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  if (data.title !== undefined || data.body !== undefined) {
    const moderation = heuristicModeration(
      [data.title ?? review.title, data.body ?? review.body].filter(Boolean).join(' ')
    );

    if (moderation.verdict === MODERATION_VERDICT.BLOCKED) {
      throw ApiError.badRequest(
        `This review could not be published: ${moderation.reasons.join('; ')}.`,
        ERROR_CODES.REVIEW_BLOCKED_BY_MODERATION
      );
    }

    review.aiModeration = {
      verdict: moderation.verdict,
      reasons: moderation.reasons,
      score: moderation.score,
      usedAi: false,
      checkedAt: new Date(),
    };
  }

  if (data.rating !== undefined) review.rating = data.rating;
  if (data.title !== undefined) review.title = data.title;
  if (data.body !== undefined) review.body = data.body;

  await review.save();

  // The aggregate must be rebuilt whenever a rating changes.
  if (data.rating !== undefined) await Book.recalculateRating(review.book);

  return review;
};

export const remove = async (reviewId, actor) => {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);

  const isOwner = String(review.user) === String(actor.id);
  const isStaff = ['LIBRARIAN', 'ADMIN'].includes(actor.role);

  if (!isOwner && !isStaff) {
    throw ApiError.forbidden('This is not your review', ERROR_CODES.NOT_RESOURCE_OWNER);
  }

  const bookId = review.book;
  const userId = review.user;

  await review.deleteOne();

  await Promise.all([
    Book.recalculateRating(bookId),
    User.updateOne({ _id: userId }, { $inc: { 'stats.reviewCount': -1 } }),
  ]);

  return { deleted: true };
};

/* Reading */

/** Reviews of a book. Members see only approved ones; staff see everything. */
export const listForBook = async (bookId, query = {}, viewer = null) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['createdAt', 'rating', 'helpfulVotes'], { createdAt: -1 });

  const isStaff = viewer && ['LIBRARIAN', 'ADMIN'].includes(viewer.role);

  const filter = { book: bookId };
  if (!isStaff) filter.status = REVIEW_STATUS.APPROVED;
  if (query.rating) filter.rating = query.rating;
  if (query.verifiedOnly === true) filter.isVerifiedBorrower = true;

  return paginateQuery(Review, filter, {
    sort,
    page,
    limit,
    skip,
    populate: [{ path: 'user', select: 'name avatar' }],
  });
};

/** A member's own reviews. */
export const listForUser = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query);

  return paginateQuery(Review, { user: userId }, {
    sort: { createdAt: -1 },
    page,
    limit,
    skip,
    populate: [{ path: 'book', select: 'title slug coverImage authors' }],
  });
};

export const getById = async (reviewId) => {
  const review = await Review.findById(reviewId)
    .populate('user', 'name avatar')
    .populate('book', 'title slug coverImage');

  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);
  return review;
};

/* Votes and reports */

/**
 * Toggle a helpful vote.
 */
export const toggleHelpful = async (reviewId, userId) => {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);

  if (String(review.user) === String(userId)) {
    throw ApiError.badRequest(
      'You cannot mark your own review as helpful',
      ERROR_CODES.CANNOT_VOTE_OWN_REVIEW
    );
  }

  const alreadyVoted = review.helpfulVotes.some((id) => String(id) === String(userId));

  if (alreadyVoted) {
    review.helpfulVotes = review.helpfulVotes.filter((id) => String(id) !== String(userId));
  } else {
    review.helpfulVotes.push(userId);
  }

  await review.save();

  return { voted: !alreadyVoted, helpfulCount: review.helpfulVotes.length };
};

/**
 * Report a review for moderation.
 */
export const report = async (reviewId, userId) => {
  const review = await Review.findById(reviewId);
  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);

  if (review.reportedBy.some((id) => String(id) === String(userId))) {
    return { reported: true, alreadyReported: true };
  }

  review.reportedBy.push(userId);
  review.reportCount = review.reportedBy.length;

  const AUTO_HOLD_THRESHOLD = 3;
  if (review.reportCount >= AUTO_HOLD_THRESHOLD && review.status === REVIEW_STATUS.APPROVED) {
    review.status = REVIEW_STATUS.PENDING;
    logger.warn('Review auto-held after multiple reports', {
      reviewId: String(review._id),
      reportCount: review.reportCount,
    });
  }

  await review.save();

  // Held reviews leave the public aggregate immediately.
  if (review.status === REVIEW_STATUS.PENDING) await Book.recalculateRating(review.book);

  return { reported: true, reportCount: review.reportCount, held: review.status === REVIEW_STATUS.PENDING };
};

/* Moderation */

/** Reviews awaiting a decision — reported, or flagged by the pre-filter. */
export const moderationQueue = async (query = {}) => {
  const { page, limit, skip } = parsePagination(query);

  return paginateQuery(
    Review,
    {
      $or: [
        { status: REVIEW_STATUS.PENDING },
        { reportCount: { $gt: 0 } },
        { 'aiModeration.verdict': MODERATION_VERDICT.FLAGGED },
      ],
    },
    {
      sort: { reportCount: -1, createdAt: -1 },
      page,
      limit,
      skip,
      populate: [
        { path: 'user', select: 'name email membershipNumber' },
        { path: 'book', select: 'title slug' },
      ],
    }
  );
};

/** Approve or reject a review. */
export const moderate = async (reviewId, { status, note }, moderator) => {
  const review = await Review.findById(reviewId).populate('user', 'name email notificationPreferences');
  if (!review) throw ApiError.notFound('No such review', ERROR_CODES.REVIEW_NOT_FOUND);

  review.status = status;
  review.moderatedBy = moderator.id;
  review.moderatedAt = new Date();
  review.moderationNote = note ?? null;

  // A moderation decision resolves the reports that triggered it.
  if (status === REVIEW_STATUS.APPROVED) {
    review.reportCount = 0;
    review.reportedBy = [];
  }

  await review.save();
  await Book.recalculateRating(review.book);

  await notificationService.notify({
    user: review.user,
    type:
      status === REVIEW_STATUS.APPROVED
        ? NOTIFICATION_TYPE.REVIEW_APPROVED
        : NOTIFICATION_TYPE.REVIEW_REJECTED,
    title: status === REVIEW_STATUS.APPROVED ? 'Your review is published' : 'Your review was not published',
    body:
      status === REVIEW_STATUS.APPROVED
        ? 'Thank you for sharing your thoughts.'
        : `A librarian reviewed it and it was not published.${note ? ` Reason: ${note}` : ''}`,
    data: { reviewId: String(review._id), bookId: String(review.book) },
  });

  logger.info('Review moderated', {
    reviewId: String(review._id),
    status,
    moderator: String(moderator.id),
  });

  return review;
};

export default {
  create,
  update,
  remove,
  listForBook,
  listForUser,
  getById,
  toggleHelpful,
  report,
  moderationQueue,
  moderate,
  heuristicModeration,
};
