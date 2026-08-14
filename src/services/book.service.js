/**
 * ---------------------------------------------------------------------------
 * BOOK SERVICE — catalogue and physical inventory
 * ---------------------------------------------------------------------------
 * Creating and maintaining bibliographic records, and managing the individual
 * copies on the shelves.
 *
 * The recurring theme here is KEEPING DENORMALISED COUNTERS HONEST. Book
 * carries `inventory.availableCopies`, and Author/Publisher/Category each
 * carry a `bookCount`. Every one of those is a cache of something derivable,
 * kept because search reads them on every request. So every write path that
 * could invalidate one has to update it — and every counter also has a
 * recompute-from-source function, so a missed update is a temporary
 * discrepancy rather than permanent corruption.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Book } from '../models/Book.js';
import { BookCopy } from '../models/BookCopy.js';
import { Author } from '../models/Author.js';
import { Publisher } from '../models/Publisher.js';
import { Category } from '../models/Category.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { BOOK_STATUS, COPY_STATUS } from '../constants/enums.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import { parseIsbn } from '../utils/isbn.js';

/** Relations populated on a book fetch. Selected narrowly — a book listing
 *  needs an author's name, not their five-thousand-character biography. */
const DEFAULT_POPULATE = [
  { path: 'authors', select: 'name slug photo' },
  { path: 'publisher', select: 'name slug' },
  { path: 'categories', select: 'name slug ancestors depth' },
];

/* ===========================================================================
 * Reference validation
 * ======================================================================== */

/**
 * Verify that every referenced author, publisher and category exists.
 *
 * Mongoose does NOT enforce referential integrity — `ref` only tells `populate`
 * where to look. Without this check a book can be created pointing at a
 * category id that never existed, and the failure surfaces much later as a
 * blank field on a book page, far from its cause.
 *
 * All three checks run concurrently: they are independent, and running them in
 * sequence would triple the latency of every book creation for no reason.
 */
const validateReferences = async ({ authors, publisher, categories }) => {
  const problems = [];

  const [foundAuthors, foundPublisher, foundCategories] = await Promise.all([
    authors?.length
      ? Author.find({ _id: { $in: authors }, isDeleted: false }).select('_id').lean()
      : Promise.resolve([]),
    publisher
      ? Publisher.findOne({ _id: publisher, isDeleted: false }).select('_id').lean()
      : Promise.resolve(null),
    categories?.length
      ? Category.find({ _id: { $in: categories }, isDeleted: false }).select('_id').lean()
      : Promise.resolve([]),
  ]);

  if (authors?.length && foundAuthors.length !== authors.length) {
    const found = new Set(foundAuthors.map((doc) => String(doc._id)));
    const missing = authors.filter((id) => !found.has(String(id)));
    problems.push({ field: 'authors', message: `Unknown author ID(s): ${missing.join(', ')}` });
  }

  if (publisher && !foundPublisher) {
    problems.push({ field: 'publisher', message: `Unknown publisher ID: ${publisher}` });
  }

  if (categories?.length && foundCategories.length !== categories.length) {
    const found = new Set(foundCategories.map((doc) => String(doc._id)));
    const missing = categories.filter((id) => !found.has(String(id)));
    problems.push({ field: 'categories', message: `Unknown category ID(s): ${missing.join(', ')}` });
  }

  if (problems.length > 0) {
    throw ApiError.validation('One or more referenced records do not exist', problems);
  }
};

/**
 * Adjust the denormalised `bookCount` on every taxonomy record a book
 * references.
 *
 * Called with `delta: +1` when a book is added and `-1` when it is removed, so
 * an author page can show "12 books" without counting them on every request.
 * Failures are logged rather than thrown: a wrong count is cosmetic and gets
 * corrected by the nightly reconciliation, whereas failing the book creation
 * over it would be a far worse outcome.
 */
const adjustTaxonomyCounts = async ({ authors, publisher, categories }, delta) => {
  const operations = [];

  if (authors?.length) {
    operations.push(Author.updateMany({ _id: { $in: authors } }, { $inc: { bookCount: delta } }));
  }
  if (publisher) {
    operations.push(Publisher.updateOne({ _id: publisher }, { $inc: { bookCount: delta } }));
  }
  if (categories?.length) {
    operations.push(Category.updateMany({ _id: { $in: categories } }, { $inc: { bookCount: delta } }));
  }

  try {
    await Promise.all(operations);
  } catch (error) {
    logger.warn('Could not update taxonomy book counts; the nightly job will reconcile them', {
      error: error.message,
    });
  }
};

/* ===========================================================================
 * Reading
 * ======================================================================== */

/**
 * Fetch one book by id or slug.
 * @param {object} [options]
 * @param {boolean} [options.includeArchived] Staff may view archived titles.
 * @param {boolean} [options.countView] Increment the view counter.
 */
export const getByIdOrSlug = async (identifier, options = {}) => {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);

  const filter = {
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  };

  if (!options.includeArchived) filter.status = BOOK_STATUS.ACTIVE;

  const book = await Book.findOne(filter).populate(DEFAULT_POPULATE);

  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  if (options.countView) {
    // Fire-and-forget. A view counter is not worth delaying the response for,
    // and losing the occasional increment costs nothing.
    Book.updateOne({ _id: book._id }, { $inc: { 'stats.viewCount': 1 } }).catch(() => {});
  }

  return book;
};

/**
 * Straightforward catalogue listing. Rich filtering and relevance ranking live
 * in search.service.js; this is the plain "browse everything" path.
 */
export const list = async (query, viewer = null) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(
    query.sort,
    ['title', 'publishedYear', 'createdAt', 'rating.average', 'stats.loanCount'],
    { createdAt: -1 }
  );

  const filter = { isDeleted: false };

  // Only staff can see drafts and archived titles.
  const isStaff = viewer && ['LIBRARIAN', 'ADMIN'].includes(viewer.role);
  filter.status = isStaff && query.status ? query.status : BOOK_STATUS.ACTIVE;

  return paginateQuery(Book, filter, { sort, page, limit, skip, populate: DEFAULT_POPULATE });
};

/* ===========================================================================
 * Writing
 * ======================================================================== */

/**
 * Catalogue a new book.
 *
 * Optionally creates its physical copies in the same call, since "add a book"
 * almost always means "add a book and the three copies we bought".
 */
export const create = async (data, actor) => {
  await validateReferences(data);

  // Checked before insert so the caller gets a clear message with a link to
  // the existing record, rather than a duplicate-key error translated after
  // the fact. The sparse unique index remains the real guarantee under a race.
  if (data.isbn13 || data.isbn10) {
    const parsed = parseIsbn(data.isbn13 || data.isbn10);
    if (parsed.valid) {
      const existing = await Book.findOne({
        $or: [{ isbn13: parsed.isbn13 }, { isbn10: parsed.isbn10 }],
        isDeleted: false,
      }).select('_id title slug');

      if (existing) {
        throw ApiError.conflict(
          `"${existing.title}" is already catalogued with this ISBN. Add copies to it instead of creating a duplicate record.`,
          ERROR_CODES.ISBN_ALREADY_EXISTS,
          { details: { existingBookId: String(existing._id), slug: existing.slug } }
        );
      }
    }
  }

  const { copies: copyCount, ...bookData } = data;

  const book = await Book.create({ ...bookData, addedBy: actor?.id ?? null });

  await adjustTaxonomyCounts(book, 1);

  if (copyCount > 0) {
    await addCopies(book._id, { count: copyCount }, actor);
    // Re-read so the response reflects the copies just created.
    await book.populate(DEFAULT_POPULATE);
    const refreshed = await Book.findById(book._id).populate(DEFAULT_POPULATE);
    return refreshed;
  }

  await book.populate(DEFAULT_POPULATE);

  logger.info('Book catalogued', { bookId: String(book._id), title: book.title });

  return book;
};

/**
 * Update a book.
 *
 * Taxonomy counters are adjusted by DIFFERENCE, not by blanket decrement and
 * re-increment: moving a book from [A, B] to [B, C] should leave B untouched,
 * and the naive approach would briefly show B one book short.
 */
export const update = async (identifier, data, actor) => {
  const book = await getByIdOrSlug(identifier, { includeArchived: true });

  await validateReferences({
    authors: data.authors,
    publisher: data.publisher,
    categories: data.categories,
  });

  const before = {
    authors: (book.authors ?? []).map((a) => String(a._id ?? a)),
    publisher: book.publisher ? String(book.publisher._id ?? book.publisher) : null,
    categories: (book.categories ?? []).map((c) => String(c._id ?? c)),
  };

  Object.assign(book, data);
  await book.save();

  const after = {
    authors: (data.authors ?? before.authors).map(String),
    publisher: data.publisher !== undefined ? (data.publisher ? String(data.publisher) : null) : before.publisher,
    categories: (data.categories ?? before.categories).map(String),
  };

  // Only the genuine additions and removals.
  const added = {
    authors: after.authors.filter((id) => !before.authors.includes(id)),
    publisher: after.publisher !== before.publisher ? after.publisher : null,
    categories: after.categories.filter((id) => !before.categories.includes(id)),
  };
  const removed = {
    authors: before.authors.filter((id) => !after.authors.includes(id)),
    publisher: after.publisher !== before.publisher ? before.publisher : null,
    categories: before.categories.filter((id) => !after.categories.includes(id)),
  };

  await Promise.all([adjustTaxonomyCounts(added, 1), adjustTaxonomyCounts(removed, -1)]);

  await book.populate(DEFAULT_POPULATE);
  return book;
};

/**
 * Soft-delete a book.
 *
 * Never a hard delete: loans reference this document, and removing it would
 * orphan the library's circulation history — which is the library's permanent
 * record, not a cataloguer's to erase.
 *
 * Refused while copies are out with borrowers; those books have to come back
 * before the title leaves the catalogue.
 */
export const remove = async (identifier, actor) => {
  const book = await getByIdOrSlug(identifier, { includeArchived: true });

  const onLoan = await BookCopy.countDocuments({ book: book._id, status: COPY_STATUS.ON_LOAN });
  if (onLoan > 0) {
    throw ApiError.conflict(
      `Cannot remove this book: ${onLoan} cop${onLoan === 1 ? 'y is' : 'ies are'} currently on loan.`,
      ERROR_CODES.COPY_ON_LOAN,
      { details: { copiesOnLoan: onLoan } }
    );
  }

  book.isDeleted = true;
  book.deletedAt = new Date();
  book.status = BOOK_STATUS.ARCHIVED;
  await book.save();

  await adjustTaxonomyCounts(book, -1);

  logger.info('Book removed from the catalogue', {
    bookId: String(book._id),
    title: book.title,
    actorId: String(actor?.id),
  });

  return book;
};

/** Restore a soft-deleted book. */
export const restore = async (identifier) => {
  const book = await Book.findOne({
    ...(mongoose.Types.ObjectId.isValid(identifier) ? { _id: identifier } : { slug: identifier }),
    isDeleted: true,
  });

  if (!book) throw ApiError.notFound('No such archived book', ERROR_CODES.BOOK_NOT_FOUND);

  book.isDeleted = false;
  book.deletedAt = null;
  book.status = BOOK_STATUS.ACTIVE;
  await book.save();

  await adjustTaxonomyCounts(book, 1);

  return book;
};

/* ===========================================================================
 * Physical copies
 * ======================================================================== */

/**
 * Add copies to a book.
 *
 * Accession numbers are generated sequentially. Generated ONE AT A TIME rather
 * than as a batch because each is derived from the current document count —
 * computing ten up front from a single count would produce ten identical
 * numbers, nine of which the unique index would reject.
 */
export const addCopies = async (bookId, { count = 1, shelfLocation, condition, cost, source }, actor) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false });
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  const created = [];

  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const accessionNumber = await BookCopy.generateAccessionNumber();
    // eslint-disable-next-line no-await-in-loop
    const copy = await BookCopy.create({
      book: book._id,
      accessionNumber,
      shelfLocation,
      condition,
      cost: cost ?? book.price,
      source,
      status: COPY_STATUS.AVAILABLE,
      statusHistory: [{ to: COPY_STATUS.AVAILABLE, at: new Date(), by: actor?.id ?? null, note: 'Acquired' }],
    });
    created.push(copy);
  }

  // Recompute from source rather than incrementing, so the counters are right
  // even if a copy creation failed partway through the loop.
  const inventory = await Book.recalculateInventory(book._id);

  logger.info('Copies added', { bookId: String(book._id), count: created.length });

  return { copies: created, inventory };
};

/** Every copy of a book, with its current status. */
export const listCopies = async (bookId, query = {}) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false }).select('_id title');
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  const filter = { book: book._id };
  if (query.status) filter.status = query.status;

  let queryBuilder = BookCopy.find(filter).sort({ accessionNumber: 1 });

  /**
   * Populate the current borrower only when the Loan model is actually
   * registered.
   *
   * Mongoose resolves a `ref` by name AT QUERY TIME, and throws
   * MissingSchemaError if that model was never loaded. Guarding here makes
   * this query robust to module import order — a real hazard in any codebase
   * where models reference each other in both directions.
   */
  if (mongoose.models.Loan) {
    queryBuilder = queryBuilder.populate({
      path: 'currentLoan',
      select: 'user dueAt status',
      populate: { path: 'user', select: 'name membershipNumber' },
    });
  }

  const copies = await queryBuilder.lean();

  return { book, copies };
};

/**
 * Change a copy's status — mark it damaged, lost or withdrawn.
 *
 * Refuses to move a copy that is currently ON_LOAN. That transition belongs to
 * the circulation engine (return, or mark-lost), which also closes the loan
 * and raises any fine; changing the status here would leave an active loan
 * pointing at a copy that is no longer out.
 */
export const updateCopyStatus = async (copyId, { status, note, condition }, actor) => {
  const copy = await BookCopy.findById(copyId);
  if (!copy) throw ApiError.notFound('No such copy', ERROR_CODES.COPY_NOT_FOUND);

  if (copy.status === COPY_STATUS.ON_LOAN && status !== COPY_STATUS.ON_LOAN) {
    throw ApiError.conflict(
      'This copy is currently on loan. Return it, or mark the loan as lost, rather than changing the copy status directly.',
      ERROR_CODES.COPY_ON_LOAN,
      { details: { currentLoan: copy.currentLoan ? String(copy.currentLoan) : null } }
    );
  }

  // Passed to the pre-save hook, which records who made the change and why.
  copy.$locals._statusChangeContext = { by: actor?.id ?? null, note };

  copy.status = status;
  if (condition) copy.condition = condition;
  if (note) copy.notes = note;

  await copy.save();

  // Availability changed, so the book's cached counters must be refreshed.
  const inventory = await Book.recalculateInventory(copy.book);

  return { copy, inventory };
};

/**
 * Permanently remove a copy record.
 *
 * The one hard delete in the catalogue, and only for a copy that was never
 * borrowed — a mis-scanned barcode entered by mistake. A copy WITH loan
 * history is withdrawn instead, because deleting it would orphan those loans.
 */
export const removeCopy = async (copyId) => {
  const copy = await BookCopy.findById(copyId);
  if (!copy) throw ApiError.notFound('No such copy', ERROR_CODES.COPY_NOT_FOUND);

  if (copy.status === COPY_STATUS.ON_LOAN) {
    throw ApiError.conflict(
      'This copy is currently on loan and cannot be removed',
      ERROR_CODES.COPY_ON_LOAN
    );
  }

  if (copy.loanCount > 0) {
    throw ApiError.conflict(
      `This copy has been borrowed ${copy.loanCount} time(s), so its loan history must be preserved. Mark it WITHDRAWN instead of deleting it.`,
      ERROR_CODES.CONFLICT,
      { details: { loanCount: copy.loanCount, suggestion: 'PATCH the copy status to WITHDRAWN' } }
    );
  }

  const bookId = copy.book;
  await copy.deleteOne();

  const inventory = await Book.recalculateInventory(bookId);
  return { inventory };
};

/* ===========================================================================
 * Discovery feeds
 * ======================================================================== */

/**
 * Books similar to a given one.
 *
 * A deliberately cheap heuristic — shared categories and authors, ranked by
 * overlap — rather than an AI call. It costs one aggregation, works for every
 * book instantly, and spends nothing from the AI budget. The AI recommender
 * builds on top of this rather than replacing it.
 */
export const findSimilar = async (identifier, limit = config.library.catalog.recommendationLimit) => {
  const book = await getByIdOrSlug(identifier);

  const categoryIds = (book.categories ?? []).map((c) => c._id ?? c);
  const authorIds = (book.authors ?? []).map((a) => a._id ?? a);

  if (categoryIds.length === 0 && authorIds.length === 0) return [];

  return Book.aggregate([
    {
      $match: {
        _id: { $ne: book._id },
        isDeleted: false,
        status: BOOK_STATUS.ACTIVE,
        $or: [{ categories: { $in: categoryIds } }, { authors: { $in: authorIds } }],
      },
    },
    {
      // Score by overlap: a shared author is a stronger signal than a shared
      // category, since categories are broad and authors are specific.
      $addFields: {
        sharedCategories: { $size: { $setIntersection: ['$categories', categoryIds] } },
        sharedAuthors: { $size: { $setIntersection: ['$authors', authorIds] } },
      },
    },
    {
      $addFields: {
        similarityScore: {
          $add: [
            { $multiply: ['$sharedAuthors', 3] },
            '$sharedCategories',
            // Nudge better-rated books up among equally similar ones.
            { $multiply: ['$rating.average', 0.2] },
          ],
        },
      },
    },
    { $sort: { similarityScore: -1, 'rating.average': -1 } },
    { $limit: limit },
    {
      $lookup: { from: 'authors', localField: 'authors', foreignField: '_id', as: 'authors', pipeline: [{ $project: { name: 1, slug: 1 } }] },
    },
    { $project: { title: 1, slug: 1, subtitle: 1, coverImage: 1, authors: 1, rating: 1, inventory: 1, similarityScore: 1, publishedYear: 1 } },
  ]);
};

/** Curated discovery feeds for a home page. */
export const getFeed = async (feed, limit = 10) => {
  const base = { isDeleted: false, status: BOOK_STATUS.ACTIVE };

  const feeds = {
    /** Recently catalogued. */
    'new-arrivals': { filter: base, sort: { createdAt: -1 } },
    /** Most borrowed of all time. */
    'most-borrowed': { filter: base, sort: { 'stats.loanCount': -1 } },
    /** Best rated, but only with enough reviews to mean anything — a single
     *  5-star review is not evidence of quality. */
    'top-rated': { filter: { ...base, 'rating.count': { $gte: 3 } }, sort: { 'rating.average': -1, 'rating.count': -1 } },
    /** Borrowed recently — what is moving now, not what moved in 2019. */
    trending: {
      filter: { ...base, 'stats.lastBorrowedAt': { $gte: new Date(Date.now() - 30 * 86_400_000) } },
      sort: { 'stats.loanCount': -1 },
    },
    /** On the shelf right now. */
    available: { filter: { ...base, 'inventory.availableCopies': { $gt: 0 } }, sort: { 'rating.average': -1 } },
  };

  const chosen = feeds[feed];
  if (!chosen) {
    throw ApiError.badRequest(
      `Unknown feed "${feed}". Available: ${Object.keys(feeds).join(', ')}`,
      ERROR_CODES.BAD_REQUEST
    );
  }

  return Book.find(chosen.filter)
    .sort(chosen.sort)
    .limit(Math.min(limit, 50))
    .populate([
      { path: 'authors', select: 'name slug' },
      { path: 'categories', select: 'name slug' },
    ])
    .lean();
};

export default {
  getByIdOrSlug,
  list,
  create,
  update,
  remove,
  restore,
  addCopies,
  listCopies,
  updateCopyStatus,
  removeCopy,
  findSimilar,
  getFeed,
};
