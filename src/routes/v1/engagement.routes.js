/**
 * ---------------------------------------------------------------------------
 * ENGAGEMENT ROUTES — /reviews, /reading-lists, /notifications
 * ---------------------------------------------------------------------------
 * Three routers exported from one file, because they share the same shape:
 * member-owned data with a small staff moderation surface.
 *
 * Review READING is public — a catalogue whose reviews require an account to
 * read is a catalogue nobody browses. Everything else needs authentication.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import { reviews, readingLists, notifications } from '../../controllers/engagement.controller.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { bookIdParam } from '../../validators/catalog.validator.js';
import {
  createReviewSchema,
  updateReviewSchema,
  reviewIdParam,
  listReviewsQuery,
  moderateReviewSchema,
  createListSchema,
  updateListSchema,
  listIdParam,
  listBookParams,
  shareSlugParam,
  addToListSchema,
  bookIdBodySchema,
  listNotificationsQuery,
  notificationIdParam,
  markReadSchema,
} from '../../validators/engagement.validator.js';

/* ===========================================================================
 * Reviews
 * ======================================================================== */

export const reviewRouter = Router();

/**
 * @openapi
 * /reviews/me:
 *   get:
 *     tags: [Reviews]
 *     summary: Your reviews
 *     responses:
 *       200: { description: 'Your reviews.' }
 *
 * /reviews/moderation-queue:
 *   get:
 *     tags: [Reviews]
 *     summary: Reviews needing a decision (staff only)
 *     description: >
 *       Reviews that were reported by members, auto-held after three distinct
 *       reports, or flagged by the moderation pre-filter.
 *     responses:
 *       200: { description: 'The queue, worst first.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *
 * /reviews/books/{bookId}:
 *   get:
 *     tags: [Reviews]
 *     summary: Reviews of a book
 *     description: >
 *       Public. Members see approved reviews only; staff additionally see held
 *       ones and the moderation detail behind them.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: verifiedOnly
 *         schema: { type: boolean }
 *         description: Only reviews from members who actually borrowed the book.
 *       - in: query
 *         name: rating
 *         schema: { type: integer, minimum: 1, maximum: 5 }
 *     responses:
 *       200: { description: 'Reviews.' }
 *   post:
 *     tags: [Reviews]
 *     summary: Review a book
 *     description: >
 *       One review per member per book, enforced by a unique index.
 *       A `isVerifiedBorrower` badge is applied automatically when you have (or
 *       had) a loan for the book.
 *       Obvious spam is rejected outright by the moderation pre-filter, with
 *       the reason stated — no AI call is spent on it.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties:
 *               rating: { type: integer, minimum: 1, maximum: 5, example: 5 }
 *               title:  { type: string, example: 'A remarkable book' }
 *               body:   { type: string }
 *     responses:
 *       201: { description: 'Published.' }
 *       400: { description: 'Held by moderation (REVIEW_BLOCKED_BY_MODERATION).' }
 *       409: { description: 'You have already reviewed this book.' }
 */
reviewRouter.get('/me', authenticate, validate({ query: listReviewsQuery }), reviews.mine);

reviewRouter.get(
  '/moderation-queue',
  authenticate,
  requireStaff,
  validate({ query: listReviewsQuery }),
  reviews.moderationQueue
);

reviewRouter
  .route('/books/:bookId')
  .get(
    optionalAuthenticate,
    validate({ params: bookIdParam, query: listReviewsQuery }),
    reviews.listForBook
  )
  .post(
    authenticate,
    validate({ params: bookIdParam, body: createReviewSchema }),
    reviews.create
  );

/**
 * @openapi
 * /reviews/{reviewId}:
 *   get:
 *     tags: [Reviews]
 *     summary: Get a review
 *     security: []
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'The review.' }
 *   patch:
 *     tags: [Reviews]
 *     summary: Edit your review
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'Updated; the book rating is recalculated.' }
 *       403: { description: 'Not your review.' }
 *   delete:
 *     tags: [Reviews]
 *     summary: Delete a review
 *     description: Your own, or any review if you are staff.
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     responses:
 *       204: { description: 'Deleted.' }
 *
 * /reviews/{reviewId}/helpful:
 *   post:
 *     tags: [Reviews]
 *     summary: Toggle "helpful" on a review
 *     description: >
 *       A TOGGLE, not an increment — votes are stored per member, so clicking
 *       repeatedly cannot inflate the count. You cannot vote on your own review.
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'The new vote state and count.' }
 *
 * /reviews/{reviewId}/report:
 *   post:
 *     tags: [Reviews]
 *     summary: Report a review
 *     description: >
 *       Idempotent per member. A review is auto-held after three DISTINCT
 *       reporters — a threshold rather than a single report, so one person
 *       cannot silence a review they merely disagree with.
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'Reported.' }
 *
 * /reviews/{reviewId}/moderate:
 *   post:
 *     tags: [Reviews]
 *     summary: Approve or reject a review (staff only)
 *     parameters: [{ in: path, name: reviewId, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [APPROVED, REJECTED] }
 *               note:   { type: string }
 *     responses:
 *       200: { description: 'Moderated; the author is notified.' }
 */
reviewRouter
  .route('/:reviewId')
  .get(optionalAuthenticate, validate({ params: reviewIdParam }), reviews.get)
  .patch(
    authenticate,
    validate({ params: reviewIdParam, body: updateReviewSchema }),
    reviews.update
  )
  .delete(authenticate, validate({ params: reviewIdParam }), reviews.remove);

reviewRouter.post(
  '/:reviewId/helpful',
  authenticate,
  validate({ params: reviewIdParam }),
  reviews.toggleHelpful
);

reviewRouter.post(
  '/:reviewId/report',
  authenticate,
  validate({ params: reviewIdParam }),
  reviews.report
);

reviewRouter.post(
  '/:reviewId/moderate',
  authenticate,
  requireStaff,
  validate({ params: reviewIdParam, body: moderateReviewSchema }),
  reviews.moderate
);

/* ===========================================================================
 * Reading lists
 * ======================================================================== */

export const readingListRouter = Router();

/**
 * @openapi
 * /reading-lists/shared/{slug}:
 *   get:
 *     tags: [Reading Lists]
 *     summary: View a shared reading list
 *     description: >
 *       Public, by an unguessable slug. The slug is random rather than derived
 *       from the list name, so private lists cannot be found by guessing.
 *     security: []
 *     parameters: [{ in: path, name: slug, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'The shared list.' }
 *       404: { description: 'No such shared list, or it is not public.' }
 *
 * /reading-lists:
 *   get:
 *     tags: [Reading Lists]
 *     summary: Your reading lists
 *     description: >
 *       The four default shelves — Favourites, Want to Read, Currently
 *       Reading, Finished — are created automatically and always present, so a
 *       client can rely on them existing.
 *     responses:
 *       200: { description: 'Your lists, with their books.' }
 *   post:
 *     tags: [Reading Lists]
 *     summary: Create a custom list
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, example: 'Summer reading' }
 *               description: { type: string }
 *               isPublic:    { type: boolean, default: false }
 *     responses:
 *       201: { description: 'Created.' }
 *       409: { description: 'You already have a list with that name.' }
 *
 * /reading-lists/favourites/toggle:
 *   post:
 *     tags: [Reading Lists]
 *     summary: Toggle a book in your favourites
 *     description: >
 *       What a heart button calls. One request rather than "check, then add or
 *       remove" — which would be two round-trips with a race between them.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId]
 *             properties:
 *               bookId: { type: string }
 *     responses:
 *       200: { description: 'The new state, as `favourited: true|false`.' }
 */
readingListRouter.get('/shared/:slug', validate({ params: shareSlugParam }), readingLists.getShared);

readingListRouter.use(authenticate);

readingListRouter
  .route('/')
  .get(readingLists.mine)
  .post(validate({ body: createListSchema }), readingLists.create);

readingListRouter.post(
  '/favourites/toggle',
  validate({ body: bookIdBodySchema }),
  readingLists.toggleFavourite
);

/**
 * @openapi
 * /reading-lists/{listId}:
 *   get:
 *     tags: [Reading Lists]
 *     summary: Get a reading list
 *     parameters: [{ in: path, name: listId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'The list.' }
 *       404: { description: 'No such list, or it is private and not yours.' }
 *   patch:
 *     tags: [Reading Lists]
 *     summary: Update a list
 *     description: >
 *       Setting `isPublic: true` mints a share slug; setting it false clears
 *       the slug, so an old shared link stops working.
 *       The four default shelves cannot be renamed.
 *     parameters: [{ in: path, name: listId, required: true, schema: { type: string } }]
 *     responses:
 *       200: { description: 'Updated.' }
 *       400: { description: 'Tried to rename a default shelf.' }
 *   delete:
 *     tags: [Reading Lists]
 *     summary: Delete a custom list
 *     parameters: [{ in: path, name: listId, required: true, schema: { type: string } }]
 *     responses:
 *       204: { description: 'Deleted.' }
 *       400: { description: 'Default shelves cannot be deleted.' }
 *
 * /reading-lists/{listId}/books:
 *   post:
 *     tags: [Reading Lists]
 *     summary: Add a book to a list
 *     parameters: [{ in: path, name: listId, required: true, schema: { type: string } }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bookId]
 *             properties:
 *               bookId: { type: string }
 *               note:   { type: string, example: 'Recommended by Dr Iyer' }
 *     responses:
 *       200: { description: 'Added.' }
 *       409: { description: 'Already in this list.' }
 *
 * /reading-lists/{listId}/books/{bookId}:
 *   delete:
 *     tags: [Reading Lists]
 *     summary: Remove a book from a list
 *     parameters:
 *       - { in: path, name: listId, required: true, schema: { type: string } }
 *       - { in: path, name: bookId, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: 'Removed.' }
 */
readingListRouter
  .route('/:listId')
  .get(validate({ params: listIdParam }), readingLists.get)
  .patch(validate({ params: listIdParam, body: updateListSchema }), readingLists.update)
  .delete(validate({ params: listIdParam }), readingLists.remove);

readingListRouter.post(
  '/:listId/books',
  validate({ params: listIdParam, body: addToListSchema }),
  readingLists.addBook
);

readingListRouter.delete(
  '/:listId/books/:bookId',
  validate({ params: listBookParams }),
  readingLists.removeBook
);

/* ===========================================================================
 * Notifications
 * ======================================================================== */

export const notificationRouter = Router();

notificationRouter.use(authenticate);

/**
 * @openapi
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: Your notification centre
 *     description: >
 *       Every notification is recorded here whether or not an email also went
 *       out, so a member who never opens email still has a complete record.
 *       `meta.unreadCount` accompanies every page.
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - in: query
 *         name: unread
 *         schema: { type: boolean }
 *     responses:
 *       200: { description: 'Notifications, with an unread count.' }
 *
 * /notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Unread count
 *     description: >
 *       Its own endpoint because a client polls this frequently for a badge and
 *       should not fetch a page of notifications just to get a number.
 *     responses:
 *       200: { description: 'The count.' }
 *
 * /notifications/read:
 *   post:
 *     tags: [Notifications]
 *     summary: Mark notifications read
 *     description: >
 *       Send `notificationIds` for specific ones, or an empty body to mark
 *       everything read. Marking read also starts the retention clock —
 *       unread notifications are never auto-deleted.
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               notificationIds: { type: array, items: { type: string } }
 *     responses:
 *       200: { description: 'How many were marked, and the remaining count.' }
 *
 * /notifications/{notificationId}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Delete a notification
 *     parameters: [{ in: path, name: notificationId, required: true, schema: { type: string } }]
 *     responses:
 *       204: { description: 'Deleted.' }
 */
notificationRouter.get('/', validate({ query: listNotificationsQuery }), notifications.list);
notificationRouter.get('/unread-count', notifications.unreadCount);
notificationRouter.post('/read', validate({ body: markReadSchema }), notifications.markRead);
notificationRouter.delete(
  '/:notificationId',
  validate({ params: notificationIdParam }),
  notifications.remove
);

export default { reviewRouter, readingListRouter, notificationRouter };
