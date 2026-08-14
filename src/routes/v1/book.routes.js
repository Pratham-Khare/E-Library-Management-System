/**
 * BOOK ROUTES  —  /api/v1/books
 * Reading the catalogue is PUBLIC — a library catalogue that requires an
 * account to browse defeats the purpose. `optionalAuthenticate` still runs on
 * read routes so a signed-in staff member sees archived titles and per-copy
 */

import { Router } from 'express';
import * as bookController from '../../controllers/book.controller.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimiter } from '../../middlewares/rateLimiter.js';
import {
  createBookSchema,
  updateBookSchema,
  bookIdParam,
  listBooksQuery,
  feedParam,
  feedQuery,
  addCopiesSchema,
  copyIdParam,
  updateCopyStatusSchema,
  listCopiesQuery,
} from '../../validators/catalog.validator.js';

const router = Router();

/**
 * @openapi
 * components:
 *   schemas:
 *     BookSummary:
 *       type: object
 *       description: Compact shape used in lists and search results.
 *       properties:
 *         id:       { type: string, example: 65f1a2b3c4d5e6f7a8b9c0d1 }
 *         title:    { type: string, example: Things Fall Apart }
 *         slug:     { type: string, example: things-fall-apart }
 *         coverImage: { type: string, nullable: true }
 *         authors:
 *           type: array
 *           items:
 *             type: object
 *             properties:
 *               id:   { type: string }
 *               name: { type: string, example: Chinua Achebe }
 *               slug: { type: string }
 *         publishedYear: { type: integer, example: 1958 }
 *         rating:
 *           type: object
 *           properties:
 *             average: { type: number, example: 4.3 }
 *             count:   { type: integer, example: 27 }
 *         availability:
 *           type: object
 *           description: Computed from physical stock and digital licences.
 *           properties:
 *             physical:
 *               type: object
 *               properties:
 *                 total:       { type: integer, example: 4 }
 *                 available:   { type: integer, example: 2 }
 *                 isAvailable: { type: boolean, example: true }
 *             digital:
 *               type: object
 *               properties:
 *                 hasEbook:    { type: boolean }
 *                 licenses:    { type: integer }
 *                 available:   { type: integer }
 *                 isAvailable: { type: boolean }
 *             canBorrowNow: { type: boolean, example: true }
 */

/* Discovery feeds — declared before /:bookId */

/**
 * @openapi
 * /books/feeds/{feed}:
 *   get:
 *     tags: [Books]
 *     summary: A curated discovery feed
 *     description: |
 *       - `new-arrivals` — recently catalogued
 *       - `most-borrowed` — highest lifetime loan count
 *       - `top-rated` — best rated, with at least 3 reviews so a single
 *         5-star rating cannot top the list
 *       - `trending` — borrowed within the last 30 days
 *       - `available` — a copy is on the shelf right now
 *     security: []
 *     parameters:
 *       - in: path
 *         name: feed
 *         required: true
 *         schema: { type: string, enum: [new-arrivals, most-borrowed, top-rated, trending, available] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 50 }
 *     responses:
 *       200: { description: 'The feed.' }
 *       400: { description: 'Unknown feed name.' }
 */
router.get(
  '/feeds/:feed',
  validate({ params: feedParam, query: feedQuery }),
  bookController.getFeed
);

/* Catalogue */

/**
 * @openapi
 * /books:
 *   get:
 *     tags: [Books]
 *     summary: List the catalogue
 *     description: >
 *       A plain listing. For text search, filtering and facets use
 *       `GET /search`, which is purpose-built for it.
 *       Staff additionally see DRAFT and ARCHIVED titles.
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: sort
 *         schema: { type: string, example: '-rating.average' }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, DRAFT, ARCHIVED] }
 *         description: Staff only. Ignored for other callers.
 *     responses:
 *       200:
 *         description: Paginated books.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data:
 *                       type: array
 *                       items: { $ref: '#/components/schemas/BookSummary' }
 *   post:
 *     tags: [Books]
 *     summary: Catalogue a new book (staff only)
 *     description: >
 *       ISBNs are validated by CHECK DIGIT, not merely by length, and stored in
 *       both ISBN-10 and ISBN-13 form so a search on either finds the book.
 *       Pass `copies` to create the physical copies in the same request.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title]
 *             properties:
 *               title:      { type: string, example: Things Fall Apart }
 *               subtitle:   { type: string }
 *               isbn13:     { type: string, example: '9780385474542' }
 *               authors:    { type: array, items: { type: string }, description: Author IDs }
 *               publisher:  { type: string, description: Publisher ID }
 *               categories: { type: array, items: { type: string }, description: Category IDs }
 *               language:   { type: string, example: en }
 *               publishedYear: { type: integer, example: 1958 }
 *               pageCount:  { type: integer, example: 209 }
 *               description: { type: string }
 *               tags:       { type: array, items: { type: string }, example: [fiction, classic] }
 *               price:      { type: number, example: 399 }
 *               copies:     { type: integer, example: 3, description: Physical copies to create alongside the record. }
 *     responses:
 *       201: { description: 'Catalogued.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: 'A book with this ISBN already exists (ISBN_ALREADY_EXISTS).' }
 *       422: { description: 'Validation failed — includes an invalid ISBN check digit or unknown author/category IDs.' }
 */
router
  .route('/')
  .get(optionalAuthenticate, validate({ query: listBooksQuery }), bookController.listBooks)
  .post(
    authenticate,
    requireStaff,
    validate({ body: createBookSchema }),
    bookController.createBook
  );

/**
 * @openapi
 * /books/{bookId}:
 *   get:
 *     tags: [Books]
 *     summary: Get one book
 *     description: Accepts an ID or a slug, so `/books/things-fall-apart` works.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *         description: Book ID or slug.
 *     responses:
 *       200: { description: 'The book.' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Books]
 *     summary: Update a book (staff only)
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Updated.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *   delete:
 *     tags: [Books]
 *     summary: Remove a book from the catalogue (staff only)
 *     description: >
 *       A SOFT delete — loan history references this record and must survive.
 *       Refused while any copy is out with a borrower.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: 'Removed.' }
 *       409: { description: 'Copies are currently on loan (COPY_ON_LOAN).' }
 */
router
  .route('/:bookId')
  .get(optionalAuthenticate, validate({ params: bookIdParam }), bookController.getBook)
  .patch(
    authenticate,
    requireStaff,
    validate({ params: bookIdParam, body: updateBookSchema }),
    bookController.updateBook
  )
  .delete(
    authenticate,
    requireStaff,
    validate({ params: bookIdParam }),
    bookController.deleteBook
  );

/**
 * @openapi
 * /books/{bookId}/restore:
 *   post:
 *     tags: [Books]
 *     summary: Restore a removed book (staff only)
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Restored.' }
 */
router.post(
  '/:bookId/restore',
  authenticate,
  requireStaff,
  validate({ params: bookIdParam }),
  bookController.restoreBook
);

/**
 * @openapi
 * /books/{bookId}/similar:
 *   get:
 *     tags: [Books]
 *     summary: Books similar to this one
 *     description: >
 *       Ranked by shared authors and categories — a shared author counts for
 *       more than a shared category, since categories are broad.
 *       This is a database heuristic, not an AI call, so it is instant and
 *       spends nothing from the AI budget.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10 }
 *     responses:
 *       200: { description: 'Similar books.' }
 */
router.get(
  '/:bookId/similar',
  validate({ params: bookIdParam, query: feedQuery }),
  bookController.getSimilarBooks
);

/* Copies */

/**
 * @openapi
 * /books/{bookId}/copies:
 *   get:
 *     tags: [Copies]
 *     summary: List the physical copies of a book
 *     description: >
 *       Staff additionally see who currently holds each copy, its acquisition
 *       cost and its status history. Members see only shelf location and
 *       availability — which copy a specific neighbour borrowed is not public.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [AVAILABLE, ON_LOAN, LOST, DAMAGED, WITHDRAWN] }
 *     responses:
 *       200: { description: 'The copies.' }
 *   post:
 *     tags: [Copies]
 *     summary: Add copies to a book (staff only)
 *     description: Accession numbers are generated automatically as ACC-YYYY-NNNNNN.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               count:         { type: integer, default: 1, maximum: 100 }
 *               shelfLocation: { type: string, example: A-12-3 }
 *               condition:     { type: string, enum: [NEW, GOOD, FAIR, POOR] }
 *               cost:          { type: number, example: 399 }
 *               source:        { type: string, example: Landmark Books }
 *     responses:
 *       201: { description: 'Copies added, with the updated inventory totals.' }
 */
router
  .route('/:bookId/copies')
  .get(
    optionalAuthenticate,
    validate({ params: bookIdParam, query: listCopiesQuery }),
    bookController.listBookCopies
  )
  .post(
    authenticate,
    requireStaff,
    rateLimiter('upload'),
    validate({ params: bookIdParam, body: addCopiesSchema }),
    bookController.addCopies
  );

/**
 * @openapi
 * /books/copies/{copyId}:
 *   patch:
 *     tags: [Copies]
 *     summary: Change a copy's status (staff only)
 *     description: >
 *       Mark a copy DAMAGED, LOST or WITHDRAWN. Refused while the copy is
 *       ON_LOAN — that transition belongs to the circulation engine (return, or
 *       mark-lost), which also closes the loan and raises any fine.
 *     parameters:
 *       - in: path
 *         name: copyId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status:    { type: string, enum: [AVAILABLE, LOST, DAMAGED, WITHDRAWN] }
 *               condition: { type: string, enum: [NEW, GOOD, FAIR, POOR] }
 *               note:      { type: string, example: 'Water damage to the last 30 pages' }
 *     responses:
 *       200: { description: 'Status changed, with the updated inventory.' }
 *       409: { description: 'The copy is on loan (COPY_ON_LOAN).' }
 *   delete:
 *     tags: [Copies]
 *     summary: Permanently delete a copy record (staff only)
 *     description: >
 *       Only for a copy that has never been borrowed — a mis-scanned barcode.
 *       A copy WITH loan history must be marked WITHDRAWN instead, so those
 *       loans are not orphaned.
 *     parameters:
 *       - in: path
 *         name: copyId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Deleted.' }
 *       409: { description: 'The copy has loan history or is on loan.' }
 */
router
  .route('/copies/:copyId')
  .patch(
    authenticate,
    requireStaff,
    validate({ params: copyIdParam, body: updateCopyStatusSchema }),
    bookController.updateCopyStatus
  )
  .delete(
    authenticate,
    requireStaff,
    validate({ params: copyIdParam }),
    bookController.deleteCopy
  );

export default router;
