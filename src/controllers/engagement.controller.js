/**
 * ENGAGEMENT CONTROLLER — reviews, reading lists, notifications
 * Grouped in one controller because all three are member-centric features with
 * the same shape: read your own, write your own, and a small staff surface for
 * moderation. Splitting them would mean three near-identical files.
 */

import * as reviewService from '../services/review.service.js';
import * as readingListService from '../services/readingList.service.js';
import * as notificationService from '../services/notification.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated, noContent } from '../utils/ApiResponse.js';
import {
  toReview,
  listReviews,
  toReadingList,
  listReadingLists,
  toNotification,
  listNotifications,
} from '../serializers/engagement.serializer.js';

const isStaff = (user) => Boolean(user) && ['LIBRARIAN', 'ADMIN'].includes(user.role);

/* Reviews */

export const reviews = {
  listForBook: asyncHandler(async (req, res) => {
    const { items, meta } = await reviewService.listForBook(req.params.bookId, req.query, req.user);
    return paginated(
      res,
      listReviews(items, { viewerId: req.user?.id, includeModeration: isStaff(req.user) }),
      meta,
      'Reviews fetched'
    );
  }),

  create: asyncHandler(async (req, res) => {
    const review = await reviewService.create(req.user.id, req.params.bookId, req.body);
    return created(res, toReview(review, { viewerId: req.user.id }), 'Review published');
  }),

  mine: asyncHandler(async (req, res) => {
    const { items, meta } = await reviewService.listForUser(req.user.id, req.query);
    return paginated(res, listReviews(items, { viewerId: req.user.id }), meta, 'Your reviews');
  }),

  get: asyncHandler(async (req, res) => {
    const review = await reviewService.getById(req.params.reviewId);
    return ok(
      res,
      toReview(review, { viewerId: req.user?.id, includeModeration: isStaff(req.user) }),
      'Review fetched'
    );
  }),

  update: asyncHandler(async (req, res) => {
    const review = await reviewService.update(req.params.reviewId, req.user.id, req.body);
    return ok(res, toReview(review, { viewerId: req.user.id }), 'Review updated');
  }),

  remove: asyncHandler(async (req, res) => {
    await reviewService.remove(req.params.reviewId, req.user);
    return noContent(res);
  }),

  /** Toggle, not increment — so voting twice cannot inflate the count. */
  toggleHelpful: asyncHandler(async (req, res) => {
    const result = await reviewService.toggleHelpful(req.params.reviewId, req.user.id);
    return ok(res, result, result.voted ? 'Marked as helpful' : 'Vote removed');
  }),

  report: asyncHandler(async (req, res) => {
    const result = await reviewService.report(req.params.reviewId, req.user.id);
    return ok(
      res,
      result,
      result.alreadyReported
        ? 'You have already reported this review'
        : 'Reported. A librarian will look at it.'
    );
  }),

  moderationQueue: asyncHandler(async (req, res) => {
    const { items, meta } = await reviewService.moderationQueue(req.query);
    return paginated(res, listReviews(items, { includeModeration: true }), meta, 'Moderation queue');
  }),

  moderate: asyncHandler(async (req, res) => {
    const review = await reviewService.moderate(req.params.reviewId, req.body, req.user);
    return ok(res, toReview(review, { includeModeration: true }), `Review ${review.status.toLowerCase()}`);
  }),
};

/* Reading lists */

export const readingLists = {
  mine: asyncHandler(async (req, res) => {
    const lists = await readingListService.listForUser(req.user.id);
    return ok(res, listReadingLists(lists), 'Your reading lists');
  }),

  get: asyncHandler(async (req, res) => {
    const list = await readingListService.getById(req.params.listId, req.user);
    return ok(res, toReadingList(list), 'Reading list fetched');
  }),

  /** A shared list, by slug. Public — no authentication required. */
  getShared: asyncHandler(async (req, res) => {
    const list = await readingListService.getByShareSlug(req.params.slug);
    return ok(res, toReadingList(list), 'Shared list fetched');
  }),

  create: asyncHandler(async (req, res) => {
    const list = await readingListService.create(req.user.id, req.body);
    return created(res, toReadingList(list), 'Reading list created');
  }),

  update: asyncHandler(async (req, res) => {
    const list = await readingListService.update(req.params.listId, req.user.id, req.body);
    return ok(res, toReadingList(list, { includeBooks: false }), 'Reading list updated');
  }),

  remove: asyncHandler(async (req, res) => {
    await readingListService.remove(req.params.listId, req.user.id);
    return noContent(res);
  }),

  addBook: asyncHandler(async (req, res) => {
    const list = await readingListService.addBook(
      req.params.listId,
      req.user.id,
      req.body.bookId,
      req.body.note
    );
    return ok(res, toReadingList(list, { includeBooks: false }), 'Added to the list');
  }),

  removeBook: asyncHandler(async (req, res) => {
    const list = await readingListService.removeBook(
      req.params.listId,
      req.user.id,
      req.params.bookId
    );
    return ok(res, toReadingList(list, { includeBooks: false }), 'Removed from the list');
  }),

  /**
   * The endpoint a heart button calls.
   */
  toggleFavourite: asyncHandler(async (req, res) => {
    const result = await readingListService.toggleFavourite(req.user.id, req.body.bookId);
    return ok(res, result, result.favourited ? 'Added to favourites' : 'Removed from favourites');
  }),
};

/* Notifications */

export const notifications = {
  list: asyncHandler(async (req, res) => {
    const { items, meta, unreadCount } = await notificationService.list(req.user.id, req.query);
    return paginated(res, listNotifications(items), meta, 'Notifications', { unreadCount });
  }),

  /** The badge count. Deliberately its own endpoint — a client polls this
   *  frequently and should not fetch a page of notifications to get a number. */
  unreadCount: asyncHandler(async (req, res) => {
    const count = await notificationService.unreadCount(req.user.id);
    return ok(res, { unreadCount: count }, 'Unread count');
  }),

  markRead: asyncHandler(async (req, res) => {
    const result = await notificationService.markRead(req.user.id, req.body.notificationIds);
    return ok(res, result, `${result.marked} notification(s) marked read`);
  }),

  remove: asyncHandler(async (req, res) => {
    await notificationService.remove(req.user.id, req.params.notificationId);
    return noContent(res);
  }),
};

export default { reviews, readingLists, notifications };
