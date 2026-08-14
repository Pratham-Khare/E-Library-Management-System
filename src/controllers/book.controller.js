/**
 * HTTP adapters for /books. All logic lives in book.service.js.
 */

import * as bookService from '../services/book.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated, noContent } from '../utils/ApiResponse.js';
import {
  toBookDetail,
  toBookAdmin,
  listBookSummaries,
  toCopy,
  listCopies as serializeCopies,
} from '../serializers/catalog.serializer.js';

/** Library staff see fields members must not. */
const isStaff = (user) => Boolean(user) && ['LIBRARIAN', 'ADMIN'].includes(user.role);

/* Reading */

export const listBooks = asyncHandler(async (req, res) => {
  const { items, meta } = await bookService.list(req.query, req.user);
  return paginated(res, listBookSummaries(items), meta, 'Books fetched');
});

export const getBook = asyncHandler(async (req, res) => {
  const book = await bookService.getByIdOrSlug(req.params.bookId, {
    includeArchived: isStaff(req.user),
    countView: true,
  });

  return ok(res, isStaff(req.user) ? toBookAdmin(book) : toBookDetail(book), 'Book fetched');
});

/** Books sharing categories or authors. A cheap heuristic, not an AI call. */
export const getSimilarBooks = asyncHandler(async (req, res) => {
  const books = await bookService.findSimilar(req.params.bookId, req.query.limit);
  return ok(res, listBookSummaries(books), 'Similar books fetched');
});

/** Curated discovery feeds: new-arrivals, most-borrowed, top-rated, trending. */
export const getFeed = asyncHandler(async (req, res) => {
  const books = await bookService.getFeed(req.params.feed, req.query.limit);
  return ok(res, listBookSummaries(books), `${req.params.feed} fetched`);
});

/* Writing (staff) */

export const createBook = asyncHandler(async (req, res) => {
  const book = await bookService.create(req.body, req.user);

  return created(
    res,
    toBookAdmin(book),
    req.body.copies > 0
      ? `Book catalogued with ${req.body.copies} cop${req.body.copies === 1 ? 'y' : 'ies'}`
      : 'Book catalogued',
    `${req.baseUrl}/${book.slug}`
  );
});

export const updateBook = asyncHandler(async (req, res) => {
  const book = await bookService.update(req.params.bookId, req.body, req.user);
  return ok(res, toBookAdmin(book), 'Book updated');
});

export const deleteBook = asyncHandler(async (req, res) => {
  await bookService.remove(req.params.bookId, req.user);
  return noContent(res);
});

export const restoreBook = asyncHandler(async (req, res) => {
  const book = await bookService.restore(req.params.bookId);
  return ok(res, toBookAdmin(book), 'Book restored to the catalogue');
});

/* Copies */

export const listBookCopies = asyncHandler(async (req, res) => {
  const { book, copies } = await bookService.listCopies(req.params.bookId, req.query);

  return ok(
    res,
    {
      book: { id: String(book._id), title: book.title },
      // Borrower details are staff-only. A member scanning a shelf has no
      // business learning which neighbour has the other copy.
      copies: serializeCopies(copies, { includeBorrower: isStaff(req.user) }),
    },
    'Copies fetched'
  );
});

export const addCopies = asyncHandler(async (req, res) => {
  const { copies, inventory } = await bookService.addCopies(req.params.bookId, req.body, req.user);

  return created(
    res,
    { copies: serializeCopies(copies, { includeBorrower: true }), inventory },
    `${copies.length} cop${copies.length === 1 ? 'y' : 'ies'} added`
  );
});

export const updateCopyStatus = asyncHandler(async (req, res) => {
  const { copy, inventory } = await bookService.updateCopyStatus(
    req.params.copyId,
    req.body,
    req.user
  );

  return ok(
    res,
    { copy: toCopy(copy, { includeBorrower: true }), inventory },
    `Copy marked ${copy.status}`
  );
});

export const deleteCopy = asyncHandler(async (req, res) => {
  const { inventory } = await bookService.removeCopy(req.params.copyId);
  return ok(res, { inventory }, 'Copy removed');
});

export default {
  listBooks,
  getBook,
  getSimilarBooks,
  getFeed,
  createBook,
  updateBook,
  deleteBook,
  restoreBook,
  listBookCopies,
  addCopies,
  updateCopyStatus,
  deleteCopy,
};
