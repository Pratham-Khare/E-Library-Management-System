/**
 * ---------------------------------------------------------------------------
 * ADMIN SERVICE — analytics, audit log and bulk operations
 * ---------------------------------------------------------------------------
 * Every dashboard figure is computed by AGGREGATION IN THE DATABASE, not by
 * fetching documents and reducing them in JavaScript. On a library with years
 * of circulation history the difference is between a query and an outage.
 *
 * The dashboard uses `$facet` so a dozen figures come back in ONE pass. As
 * well as being faster, it makes the numbers mutually CONSISTENT: separate
 * queries could each see a different moment, and a dashboard whose totals do
 * not add up is worse than no dashboard.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import { parse as parseCsv } from 'csv-parse/sync';
import { stringify as toCsv } from 'csv-stringify/sync';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { User } from '../models/User.js';
import { Book } from '../models/Book.js';
import { BookCopy } from '../models/BookCopy.js';
import { Author } from '../models/Author.js';
import { Publisher } from '../models/Publisher.js';
import { Category } from '../models/Category.js';
import { Loan } from '../models/Loan.js';
import { Fine } from '../models/Fine.js';
import { Review } from '../models/Review.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { LOAN_STATUS, OPEN_LOAN_STATUSES, FINE_STATUS, BOOK_STATUS } from '../constants/enums.js';
import { parsePagination, paginateQuery } from '../utils/pagination.js';
import { parseIsbn } from '../utils/isbn.js';

/* ===========================================================================
 * Audit log
 * ======================================================================== */

/**
 * Record a privileged action.
 *
 * NEVER THROWS. An audit write must not prevent a librarian from returning a
 * book — the operation is the point, the record is the courtesy. A failure is
 * logged so the gap itself is visible.
 */
export const audit = async ({ actor, action, entity, entityId, entityLabel, changes, note, req }) => {
  try {
    return await AuditLog.create({
      actor: actor?.id ?? actor?._id ?? null,
      actorName: actor?.name ?? null,
      actorRole: actor?.role ?? null,
      action,
      entity,
      entityId: entityId ?? null,
      entityLabel: entityLabel ?? null,
      changes: changes ?? null,
      note: note ?? null,
      ip: req?.ip ?? null,
      userAgent: req?.get?.('user-agent')?.slice(0, 300) ?? null,
      requestId: req?.id ?? null,
    });
  } catch (error) {
    logger.error('Could not write an audit record', { action, entity, error: error.message });
    return null;
  }
};

export const listAuditLog = async (query = {}) => {
  const { page, limit, skip } = parsePagination(query);

  const filter = {};
  if (query.actor) filter.actor = query.actor;
  if (query.action) filter.action = query.action;
  if (query.entity) filter.entity = query.entity;
  if (query.entityId) filter.entityId = query.entityId;

  if (query.from || query.to) {
    filter.createdAt = {};
    if (query.from) filter.createdAt.$gte = new Date(query.from);
    if (query.to) filter.createdAt.$lte = new Date(query.to);
  }

  return paginateQuery(AuditLog, filter, {
    sort: { createdAt: -1 },
    page,
    limit,
    skip,
    populate: [{ path: 'actor', select: 'name email role' }],
  });
};

/* ===========================================================================
 * Dashboard
 * ======================================================================== */

/**
 * The headline dashboard.
 *
 * Runs several independent aggregations CONCURRENTLY — they touch different
 * collections and have no reason to wait for one another.
 */
export const getDashboard = async ({ days = 30 } = {}) => {
  const since = new Date(Date.now() - days * 86_400_000);

  const [collection, circulation, members, financial, engagement] = await Promise.all([
    /* --- Collection ------------------------------------------------- */
    Book.aggregate([
      { $match: { isDeleted: false } },
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                titles: { $sum: 1 },
                copies: { $sum: '$inventory.totalCopies' },
                available: { $sum: '$inventory.availableCopies' },
                withEbook: { $sum: { $cond: ['$digital.hasEbook', 1, 0] } },
              },
            },
          ],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          byLanguage: [
            { $group: { _id: '$language', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 5 },
          ],
        },
      },
    ]),

    /* --- Circulation -------------------------------------------------- */
    Loan.aggregate([
      {
        $facet: {
          current: [
            { $match: { status: { $in: OPEN_LOAN_STATUSES } } },
            {
              $group: {
                _id: null,
                open: { $sum: 1 },
                overdue: { $sum: { $cond: [{ $lt: ['$dueAt', new Date()] }, 1, 0] } },
              },
            },
          ],
          period: [
            { $match: { issuedAt: { $gte: since } } },
            { $group: { _id: null, issued: { $sum: 1 } } },
          ],
          returnedInPeriod: [
            { $match: { returnedAt: { $gte: since } } },
            { $group: { _id: null, returned: { $sum: 1 } } },
          ],
          /**
           * Average loan duration, in days.
           *
           * Computed only over CLOSED loans — including open ones would count
           * a book borrowed this morning as a zero-day loan and drag the
           * average toward meaninglessness.
           */
          averageDuration: [
            { $match: { returnedAt: { $ne: null } } },
            {
              $project: {
                days: {
                  $divide: [{ $subtract: ['$returnedAt', '$issuedAt'] }, 86_400_000],
                },
              },
            },
            { $group: { _id: null, avgDays: { $avg: '$days' } } },
            { $project: { _id: 0, avgDays: { $round: ['$avgDays', 1] } } },
          ],
          /** Daily issue counts, for a trend chart. */
          trend: [
            { $match: { issuedAt: { $gte: since } } },
            {
              $group: {
                _id: { $dateToString: { format: '%Y-%m-%d', date: '$issuedAt' } },
                count: { $sum: 1 },
              },
            },
            { $sort: { _id: 1 } },
            { $project: { _id: 0, date: '$_id', count: 1 } },
          ],
          byType: [{ $group: { _id: '$type', count: { $sum: 1 } } }],
        },
      },
    ]),

    /* --- Members ---------------------------------------------------- */
    User.aggregate([
      { $match: { isDeleted: false } },
      {
        $facet: {
          totals: [{ $group: { _id: null, total: { $sum: 1 } } }],
          byMembership: [{ $group: { _id: '$membershipType', count: { $sum: 1 } } }],
          byRole: [{ $group: { _id: '$role', count: { $sum: 1 } } }],
          byStatus: [{ $group: { _id: '$status', count: { $sum: 1 } } }],
          newInPeriod: [
            { $match: { createdAt: { $gte: since } } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],
          /** Members who borrowed at least once in the period — real activity. */
          active: [
            { $match: { lastLoginAt: { $gte: since } } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],
        },
      },
    ]),

    /* --- Money -------------------------------------------------------- */
    Fine.aggregate([
      {
        $facet: {
          byStatus: [{ $group: { _id: '$status', total: { $sum: '$amount' }, count: { $sum: 1 } } }],
          collectedInPeriod: [
            { $match: { paidAt: { $gte: since } } },
            { $group: { _id: null, total: { $sum: '$amount' } } },
          ],
          byReason: [{ $group: { _id: '$reason', total: { $sum: '$amount' }, count: { $sum: 1 } } }],
        },
      },
    ]),

    /* --- Engagement ---------------------------------------------------- */
    Review.aggregate([
      {
        $facet: {
          totals: [
            {
              $group: {
                _id: null,
                total: { $sum: 1 },
                averageRating: { $avg: '$rating' },
                verified: { $sum: { $cond: ['$isVerifiedBorrower', 1, 0] } },
              },
            },
          ],
          pending: [
            { $match: { status: 'PENDING' } },
            { $group: { _id: null, count: { $sum: 1 } } },
          ],
        },
      },
    ]),
  ]);

  const first = (facet, path, fallback = 0) => facet?.[0]?.[path]?.[0] ?? fallback;
  const toMap = (rows) =>
    Object.fromEntries((rows ?? []).map((row) => [row._id ?? 'unknown', row.count ?? row.total ?? 0]));

  const collectionTotals = first(collection, 'totals', {});
  const circulationCurrent = first(circulation, 'current', {});
  const fineByStatus = financial?.[0]?.byStatus ?? [];
  const findFine = (status) => fineByStatus.find((row) => row._id === status);

  const openLoans = circulationCurrent.open ?? 0;
  const overdueLoans = circulationCurrent.overdue ?? 0;

  return {
    periodDays: days,
    generatedAt: new Date(),

    collection: {
      titles: collectionTotals.titles ?? 0,
      copies: collectionTotals.copies ?? 0,
      availableCopies: collectionTotals.available ?? 0,
      titlesWithEbook: collectionTotals.withEbook ?? 0,
      byStatus: toMap(collection?.[0]?.byStatus),
      topLanguages: (collection?.[0]?.byLanguage ?? []).map((row) => ({
        language: row._id,
        count: row.count,
      })),
      /** Share of copies currently out — the clearest measure of how hard the
       *  collection is working. */
      utilisationPercent:
        collectionTotals.copies > 0
          ? Math.round(((collectionTotals.copies - collectionTotals.available) / collectionTotals.copies) * 100)
          : 0,
    },

    circulation: {
      openLoans,
      overdueLoans,
      overdueRatePercent: openLoans > 0 ? Math.round((overdueLoans / openLoans) * 100) : 0,
      issuedInPeriod: first(circulation, 'period', {}).issued ?? 0,
      returnedInPeriod: first(circulation, 'returnedInPeriod', {}).returned ?? 0,
      averageLoanDurationDays: first(circulation, 'averageDuration', {}).avgDays ?? 0,
      byType: toMap(circulation?.[0]?.byType),
      trend: circulation?.[0]?.trend ?? [],
    },

    members: {
      total: first(members, 'totals', {}).total ?? 0,
      byMembershipType: toMap(members?.[0]?.byMembership),
      byRole: toMap(members?.[0]?.byRole),
      byStatus: toMap(members?.[0]?.byStatus),
      newInPeriod: first(members, 'newInPeriod', {}).count ?? 0,
      activeInPeriod: first(members, 'active', {}).count ?? 0,
    },

    finances: {
      currency: config.library.fines.currency,
      outstanding: findFine(FINE_STATUS.PENDING)?.total ?? 0,
      outstandingCount: findFine(FINE_STATUS.PENDING)?.count ?? 0,
      collectedAllTime: findFine(FINE_STATUS.PAID)?.total ?? 0,
      collectedInPeriod: first(financial, 'collectedInPeriod', {}).total ?? 0,
      waived: findFine(FINE_STATUS.WAIVED)?.total ?? 0,
      byReason: (financial?.[0]?.byReason ?? []).map((row) => ({
        reason: row._id,
        total: row.total,
        count: row.count,
      })),
    },

    engagement: {
      reviews: first(engagement, 'totals', {}).total ?? 0,
      averageRating:
        Math.round((first(engagement, 'totals', {}).averageRating ?? 0) * 100) / 100,
      verifiedReviews: first(engagement, 'totals', {}).verified ?? 0,
      pendingModeration: first(engagement, 'pending', {}).count ?? 0,
    },
  };
};

/* ===========================================================================
 * Reports
 * ======================================================================== */

/** Most-borrowed titles over a period. */
export const getPopularBooks = async ({ days = 90, limit = 20 } = {}) => {
  const since = new Date(Date.now() - days * 86_400_000);

  return Loan.aggregate([
    { $match: { issuedAt: { $gte: since } } },
    { $group: { _id: '$book', loans: { $sum: 1 } } },
    { $sort: { loans: -1 } },
    { $limit: limit },
    { $lookup: { from: 'books', localField: '_id', foreignField: '_id', as: 'book' } },
    { $unwind: '$book' },
    {
      $lookup: {
        from: 'authors',
        localField: 'book.authors',
        foreignField: '_id',
        as: 'authors',
        pipeline: [{ $project: { name: 1 } }],
      },
    },
    {
      $project: {
        _id: 0,
        bookId: '$_id',
        title: '$book.title',
        slug: '$book.slug',
        authors: '$authors.name',
        loansInPeriod: '$loans',
        lifetimeLoans: '$book.stats.loanCount',
        rating: '$book.rating.average',
      },
    },
  ]);
};

/**
 * Books nobody borrows.
 *
 * The report that actually changes acquisition decisions: shelf space spent on
 * titles that have not moved. Deliberately excludes recently added books,
 * which have not had a fair chance yet.
 */
export const getUnborrowedBooks = async ({ limit = 20, minAgeDays = 90 } = {}) => {
  const cutoff = new Date(Date.now() - minAgeDays * 86_400_000);

  return Book.find({
    isDeleted: false,
    status: BOOK_STATUS.ACTIVE,
    'stats.loanCount': 0,
    createdAt: { $lt: cutoff },
    'inventory.totalCopies': { $gt: 0 },
  })
    .sort({ createdAt: 1 })
    .limit(limit)
    .select('title slug createdAt inventory.totalCopies price')
    .lean();
};

/** Members with the most activity, for the staff dashboard. */
export const getActiveMembers = async ({ days = 90, limit = 20 } = {}) => {
  const since = new Date(Date.now() - days * 86_400_000);

  return Loan.aggregate([
    { $match: { issuedAt: { $gte: since } } },
    { $group: { _id: '$user', loans: { $sum: 1 } } },
    { $sort: { loans: -1 } },
    { $limit: limit },
    { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
    { $unwind: '$user' },
    {
      $project: {
        _id: 0,
        userId: '$_id',
        name: '$user.name',
        membershipNumber: '$user.membershipNumber',
        membershipType: '$user.membershipType',
        loansInPeriod: '$loans',
        outstandingFine: '$user.stats.outstandingFine',
      },
    },
  ]);
};

/** Copies needing attention — damaged, lost, or heavily circulated. */
export const getInventoryHealth = async () => {
  const [byStatus, mostWorn] = await Promise.all([
    BookCopy.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
    BookCopy.find({ status: { $ne: 'WITHDRAWN' } })
      .sort({ loanCount: -1 })
      .limit(10)
      .populate('book', 'title slug')
      .select('accessionNumber loanCount condition status book')
      .lean(),
  ]);

  return {
    byStatus: Object.fromEntries(byStatus.map((row) => [row._id, row.count])),
    mostCirculated: mostWorn.map((copy) => ({
      accessionNumber: copy.accessionNumber,
      title: copy.book?.title,
      loanCount: copy.loanCount,
      condition: copy.condition,
      status: copy.status,
    })),
  };
};

/* ===========================================================================
 * CSV bulk import
 * ======================================================================== */

const REQUIRED_CSV_COLUMNS = ['title'];

/**
 * Import books from CSV.
 *
 * TWO PROPERTIES THAT MATTER:
 *
 *   DRY RUN — `dryRun: true` validates every row and reports what WOULD happen
 *   without writing anything. Importing 800 books and discovering row 400 was
 *   malformed is a bad afternoon; finding out first is a good one.
 *
 *   PER-ROW ISOLATION — one bad row is reported and skipped, not fatal. An
 *   all-or-nothing import of a hand-maintained spreadsheet almost never
 *   succeeds, and rejecting 799 good rows over one typo helps nobody.
 *
 * Authors, publishers and categories are matched by NAME and created when
 * missing, because a spreadsheet from an acquisitions supplier contains names,
 * not ObjectIds.
 */
export const importBooksFromCsv = async (csvContent, { dryRun = false } = {}, actor) => {
  let rows;

  try {
    rows = parseCsv(csvContent, { columns: true, skip_empty_lines: true, trim: true, bom: true });
  } catch (error) {
    throw ApiError.badRequest(`Could not read the CSV: ${error.message}`, ERROR_CODES.CSV_PARSE_ERROR);
  }

  if (rows.length === 0) {
    throw ApiError.badRequest('The CSV contains no rows', ERROR_CODES.CSV_PARSE_ERROR);
  }

  if (rows.length > config.library.catalog.maxCsvImportRows) {
    throw ApiError.badRequest(
      `The CSV has ${rows.length} rows, which exceeds the limit of ${config.library.catalog.maxCsvImportRows}. Split it into smaller files.`,
      ERROR_CODES.CSV_ROW_LIMIT_EXCEEDED
    );
  }

  const headers = Object.keys(rows[0]);
  const missing = REQUIRED_CSV_COLUMNS.filter((column) => !headers.includes(column));
  if (missing.length > 0) {
    throw ApiError.badRequest(
      `The CSV is missing required column(s): ${missing.join(', ')}`,
      ERROR_CODES.CSV_MISSING_COLUMNS,
      { details: { required: REQUIRED_CSV_COLUMNS, found: headers } }
    );
  }

  const results = { total: rows.length, created: 0, skipped: 0, errors: [], created_titles: [] };

  // Caches so a 500-row file with 20 distinct authors does 20 lookups, not 500.
  const authorCache = new Map();
  const publisherCache = new Map();
  const categoryCache = new Map();

  const resolveAuthor = async (name) => {
    const key = name.toLowerCase();
    if (authorCache.has(key)) return authorCache.get(key);

    let author = await Author.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (!author && !dryRun) author = await Author.create({ name });

    authorCache.set(key, author?._id ?? null);
    return author?._id ?? null;
  };

  const resolvePublisher = async (name) => {
    const key = name.toLowerCase();
    if (publisherCache.has(key)) return publisherCache.get(key);

    let publisher = await Publisher.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (!publisher && !dryRun) publisher = await Publisher.create({ name });

    publisherCache.set(key, publisher?._id ?? null);
    return publisher?._id ?? null;
  };

  const resolveCategory = async (name) => {
    const key = name.toLowerCase();
    if (categoryCache.has(key)) return categoryCache.get(key);

    let category = await Category.findOne({ name: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') });
    if (!category && !dryRun) category = await Category.create({ name });

    categoryCache.set(key, category?._id ?? null);
    return category?._id ?? null;
  };

  for (const [index, row] of rows.entries()) {
    // Header row is line 1, so a data row's line number is its index + 2 —
    // which is what someone will actually look for in their spreadsheet.
    const line = index + 2;

    try {
      if (!row.title?.trim()) {
        results.errors.push({ line, error: 'Missing title' });
        results.skipped += 1;
        continue;
      }

      if (row.isbn13 || row.isbn) {
        const parsed = parseIsbn(row.isbn13 || row.isbn);
        if (!parsed.valid) {
          results.errors.push({ line, title: row.title, error: `Invalid ISBN "${row.isbn13 || row.isbn}"` });
          results.skipped += 1;
          continue;
        }

        const duplicate = await Book.findOne({ isbn13: parsed.isbn13, isDeleted: false }).select('title');
        if (duplicate) {
          results.errors.push({ line, title: row.title, error: `Already catalogued as "${duplicate.title}"` });
          results.skipped += 1;
          continue;
        }
      }

      // Multiple authors or categories in one cell, separated by ; or |
      const authorNames = (row.authors ?? row.author ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);
      const categoryNames = (row.categories ?? row.category ?? '').split(/[;|]/).map((s) => s.trim()).filter(Boolean);

      const authorIds = [];
      for (const name of authorNames) {
        const id = await resolveAuthor(name);
        if (id) authorIds.push(id);
      }

      const categoryIds = [];
      for (const name of categoryNames) {
        const id = await resolveCategory(name);
        if (id) categoryIds.push(id);
      }

      const publisherId = row.publisher?.trim() ? await resolvePublisher(row.publisher.trim()) : null;

      if (dryRun) {
        results.created += 1;
        results.created_titles.push(row.title);
        continue;
      }

      const book = await Book.create({
        title: row.title.trim(),
        subtitle: row.subtitle?.trim() || undefined,
        isbn13: row.isbn13 || row.isbn || undefined,
        authors: authorIds,
        publisher: publisherId,
        categories: categoryIds,
        language: row.language?.trim().toLowerCase() || 'en',
        publishedYear: row.publishedYear ? Number(row.publishedYear) : undefined,
        pageCount: row.pageCount ? Number(row.pageCount) : undefined,
        description: row.description?.trim() || undefined,
        price: row.price ? Number(row.price) : undefined,
        tags: (row.tags ?? '').split(/[;|,]/).map((s) => s.trim().toLowerCase()).filter(Boolean),
        addedBy: actor?.id ?? null,
      });

      // Copies, when the sheet says how many.
      const copyCount = row.copies ? Number(row.copies) : 0;
      for (let i = 0; i < copyCount; i += 1) {
        const accessionNumber = await BookCopy.generateAccessionNumber();
        await BookCopy.create({
          book: book._id,
          accessionNumber,
          shelfLocation: row.shelfLocation?.trim() || null,
          cost: row.price ? Number(row.price) : null,
        });
      }

      if (copyCount > 0) await Book.recalculateInventory(book._id);

      results.created += 1;
      results.created_titles.push(book.title);
    } catch (error) {
      // Per-row isolation: one bad row must not abort the other 799.
      results.errors.push({ line, title: row.title, error: error.message });
      results.skipped += 1;
    }
  }

  if (!dryRun) {
    logger.info('CSV import finished', {
      total: results.total,
      created: results.created,
      skipped: results.skipped,
      actor: String(actor?.id),
    });
  }

  return { ...results, dryRun };
};

/** Export the catalogue as CSV, in the same shape the importer accepts. */
export const exportBooksToCsv = async () => {
  const books = await Book.find({ isDeleted: false })
    .populate('authors', 'name')
    .populate('publisher', 'name')
    .populate('categories', 'name')
    .lean();

  const rows = books.map((book) => ({
    title: book.title,
    subtitle: book.subtitle ?? '',
    isbn13: book.isbn13 ?? '',
    authors: (book.authors ?? []).map((a) => a.name).join('; '),
    publisher: book.publisher?.name ?? '',
    categories: (book.categories ?? []).map((c) => c.name).join('; '),
    language: book.language ?? '',
    publishedYear: book.publishedYear ?? '',
    pageCount: book.pageCount ?? '',
    price: book.price ?? '',
    tags: (book.tags ?? []).join('; '),
    copies: book.inventory?.totalCopies ?? 0,
    available: book.inventory?.availableCopies ?? 0,
    rating: book.rating?.average ?? '',
    loans: book.stats?.loanCount ?? 0,
    description: book.description ?? '',
  }));

  return toCsv(rows, { header: true });
};

export default {
  audit,
  listAuditLog,
  getDashboard,
  getPopularBooks,
  getUnborrowedBooks,
  getActiveMembers,
  getInventoryHealth,
  importBooksFromCsv,
  exportBooksToCsv,
};
