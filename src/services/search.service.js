/**
 * ---------------------------------------------------------------------------
 * SEARCH SERVICE
 * ---------------------------------------------------------------------------
 * Catalogue search: weighted full-text ranking, filtering, faceted counts,
 * autocomplete, and a fuzzy fallback.
 *
 * THREE THINGS HERE ARE WORTH READING:
 *
 * 1. THE FUZZY FALLBACK. MongoDB's text index matches whole words after
 *    stemming, so a search for "algo" finds nothing at all even though
 *    "Algorithms" is right there. Users type fragments and misspell things
 *    constantly, and an empty result page reads as "the library doesn't have
 *    it" rather than "try more letters". So when text search returns zero
 *    hits, the query is retried as an escaped regex.
 *
 * 2. FACETS IN ONE PASS. A filter sidebar needs counts per category, per
 *    language, per availability. Computing those as separate queries would
 *    mean five round-trips over the same working set. `$facet` runs every
 *    branch over one pipeline in a single pass.
 *
 * 3. CATEGORY FILTERS EXPAND DOWN THE TREE. Filtering by "Science" matches
 *    books tagged only with "Machine Learning" four levels below it, because
 *    the materialised ancestor path turns the whole subtree into one `$in`.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import { Book } from '../models/Book.js';
import { Category } from '../models/Category.js';
import { Author } from '../models/Author.js';
import { BOOK_STATUS } from '../constants/enums.js';
import { parsePagination } from '../utils/pagination.js';
import { escapeRegex } from '../utils/sanitize.js';

const toObjectId = (value) => new mongoose.Types.ObjectId(String(value));

/* ===========================================================================
 * Filter construction
 * ======================================================================== */

/**
 * Translate validated query parameters into a MongoDB filter.
 *
 * Async because a category filter has to expand into its subtree first.
 */
const buildFilter = async (query) => {
  const filter = { isDeleted: false, status: BOOK_STATUS.ACTIVE };

  /**
   * Category — expanded to the whole subtree.
   * This is what makes browsing a broad category useful rather than empty.
   */
  if (query.category) {
    const category = await Category.findByIdOrSlug(query.category);
    if (category) {
      const ids =
        query.includeSubcategories === false
          ? [category._id]
          : await Category.subtreeIds(category._id);
      filter.categories = { $in: ids };
    } else {
      // An unknown category should return nothing, not silently everything.
      filter.categories = { $in: [] };
    }
  } else if (query.categories?.length) {
    filter.categories = { $in: query.categories.map(toObjectId) };
  }

  if (query.author) filter.authors = toObjectId(query.author);
  else if (query.authors?.length) filter.authors = { $in: query.authors.map(toObjectId) };

  if (query.publisher) filter.publisher = toObjectId(query.publisher);

  if (query.language) filter.language = query.language.toLowerCase();

  /** Publication-year range. Either bound may be supplied alone. */
  if (query.yearFrom !== undefined || query.yearTo !== undefined) {
    filter.publishedYear = {};
    if (query.yearFrom !== undefined) filter.publishedYear.$gte = query.yearFrom;
    if (query.yearTo !== undefined) filter.publishedYear.$lte = query.yearTo;
  }

  if (query.minRating !== undefined) {
    filter['rating.average'] = { $gte: query.minRating };
  }

  /**
   * Availability. `available=true` means a PHYSICAL copy is on the shelf right
   * now, which is the question a member browsing for something to take home is
   * actually asking.
   */
  if (query.available === true) filter['inventory.availableCopies'] = { $gt: 0 };
  else if (query.available === false) filter['inventory.availableCopies'] = { $lte: 0 };

  /** Format: does the library hold this physically, digitally, or both? */
  if (query.format === 'digital') filter['digital.hasEbook'] = true;
  else if (query.format === 'physical') filter['inventory.totalCopies'] = { $gt: 0 };

  if (query.tags?.length) {
    filter.tags = { $all: query.tags.map((tag) => tag.toLowerCase()) };
  }

  return filter;
};

/** Sort specifications, keyed by the `sort` query value. */
const SORT_OPTIONS = {
  relevance: { score: { $meta: 'textScore' } },
  title: { title: 1 },
  '-title': { title: -1 },
  newest: { publishedYear: -1, createdAt: -1 },
  oldest: { publishedYear: 1 },
  rating: { 'rating.average': -1, 'rating.count': -1 },
  popular: { 'stats.loanCount': -1 },
  recent: { createdAt: -1 },
};

/* ===========================================================================
 * Search
 * ======================================================================== */

/**
 * Search the catalogue.
 *
 * @param {object} query Validated query parameters.
 * @returns {Promise<{items: Array, meta: object, fallbackUsed: boolean}>}
 */
export const search = async (query) => {
  const { page, limit, skip } = parsePagination(query);
  const filter = await buildFilter(query);

  const term = query.q?.trim();

  /* --- No search term: a filtered browse ---------------------------- */
  if (!term) {
    const sort = SORT_OPTIONS[query.sort] ?? SORT_OPTIONS.recent;
    // `relevance` is meaningless without a term — it would reference a
    // textScore that no stage produced.
    const safeSort = query.sort === 'relevance' ? SORT_OPTIONS.recent : sort;

    const [items, total] = await Promise.all([
      Book.find(filter)
        .sort(safeSort)
        .skip(skip)
        .limit(limit)
        .populate([
          { path: 'authors', select: 'name slug' },
          { path: 'publisher', select: 'name slug' },
          { path: 'categories', select: 'name slug' },
        ])
        .lean(),
      Book.countDocuments(filter),
    ]);

    return { items, meta: { page, limit, total }, fallbackUsed: false, searchTerm: null };
  }

  /* --- Text search --------------------------------------------------- */
  const textFilter = { ...filter, $text: { $search: term } };
  const sort = SORT_OPTIONS[query.sort] ?? SORT_OPTIONS.relevance;

  const [items, total] = await Promise.all([
    Book.find(textFilter, { score: { $meta: 'textScore' } })
      .sort(sort)
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'authors', select: 'name slug' },
        { path: 'publisher', select: 'name slug' },
        { path: 'categories', select: 'name slug' },
      ])
      .lean(),
    Book.countDocuments(textFilter),
  ]);

  if (total > 0) {
    return { items, meta: { page, limit, total }, fallbackUsed: false, searchTerm: term };
  }

  /* --- Fuzzy fallback ------------------------------------------------- */
  /**
   * Text search found nothing. Retry as a substring match.
   *
   * Necessary because the text index matches whole stemmed words: "algo" does
   * not match "Algorithms", and neither does a misspelling. Slower — this is a
   * regex scan rather than an index seek — but it only runs when the fast path
   * has already produced nothing, so the common case is unaffected.
   *
   * The term is escaped, so "C++" is searchable and a crafted pattern cannot
   * cause catastrophic backtracking.
   */
  const pattern = new RegExp(escapeRegex(term), 'i');
  const fuzzyFilter = {
    ...filter,
    $or: [{ title: pattern }, { subtitle: pattern }, { tags: pattern }],
  };

  const [fuzzyItems, fuzzyTotal] = await Promise.all([
    Book.find(fuzzyFilter)
      .sort(query.sort && query.sort !== 'relevance' ? SORT_OPTIONS[query.sort] : { 'rating.average': -1 })
      .skip(skip)
      .limit(limit)
      .populate([
        { path: 'authors', select: 'name slug' },
        { path: 'publisher', select: 'name slug' },
        { path: 'categories', select: 'name slug' },
      ])
      .lean(),
    Book.countDocuments(fuzzyFilter),
  ]);

  return {
    items: fuzzyItems,
    meta: { page, limit, total: fuzzyTotal },
    // Surfaced so a client can say "no exact matches — showing similar titles"
    // rather than presenting weaker results as if they were exact.
    fallbackUsed: true,
    searchTerm: term,
  };
};

/* ===========================================================================
 * Facets
 * ======================================================================== */

/**
 * Counts per filter value, for a sidebar.
 *
 * `$facet` runs every branch over ONE pipeline pass. Computed separately this
 * would be five queries over the same working set — and the counts could
 * disagree with each other if a write landed between them.
 */
export const getFacets = async (query) => {
  const filter = await buildFilter(query);
  const term = query.q?.trim();
  const matchStage = term ? { ...filter, $text: { $search: term } } : filter;

  const [result] = await Book.aggregate([
    { $match: matchStage },
    {
      $facet: {
        categories: [
          { $unwind: '$categories' },
          { $group: { _id: '$categories', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 20 },
          { $lookup: { from: 'categories', localField: '_id', foreignField: '_id', as: 'category' } },
          { $unwind: '$category' },
          { $project: { _id: 1, name: '$category.name', slug: '$category.slug', count: 1 } },
        ],
        authors: [
          { $unwind: '$authors' },
          { $group: { _id: '$authors', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $limit: 15 },
          { $lookup: { from: 'authors', localField: '_id', foreignField: '_id', as: 'author' } },
          { $unwind: '$author' },
          { $project: { _id: 1, name: '$author.name', slug: '$author.slug', count: 1 } },
        ],
        languages: [
          { $group: { _id: '$language', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $project: { _id: 0, language: '$_id', count: 1 } },
        ],
        availability: [
          {
            $group: {
              _id: null,
              available: { $sum: { $cond: [{ $gt: ['$inventory.availableCopies', 0] }, 1, 0] } },
              unavailable: { $sum: { $cond: [{ $lte: ['$inventory.availableCopies', 0] }, 1, 0] } },
              digital: { $sum: { $cond: ['$digital.hasEbook', 1, 0] } },
            },
          },
          { $project: { _id: 0 } },
        ],
        // Decade buckets rather than individual years — a list of 120 years is
        // not a usable filter control.
        decades: [
          { $match: { publishedYear: { $ne: null } } },
          {
            $group: {
              _id: { $multiply: [{ $floor: { $divide: ['$publishedYear', 10] } }, 10] },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: -1 } },
          { $limit: 12 },
          { $project: { _id: 0, decade: '$_id', count: 1 } },
        ],
        total: [{ $count: 'count' }],
      },
    },
  ]);

  return {
    categories: result?.categories ?? [],
    authors: result?.authors ?? [],
    languages: result?.languages ?? [],
    availability: result?.availability?.[0] ?? { available: 0, unavailable: 0, digital: 0 },
    decades: result?.decades ?? [],
    total: result?.total?.[0]?.count ?? 0,
  };
};

/* ===========================================================================
 * Autocomplete
 * ======================================================================== */

/**
 * Type-ahead suggestions across titles and authors.
 *
 * Anchored with `^` so the pattern is a PREFIX match, which MongoDB can serve
 * from the index on `title`. An unanchored regex would force a full collection
 * scan on every keystroke — the difference between a suggestion box that feels
 * instant and one that lags behind typing.
 */
export const suggest = async (term, limit = config.library.catalog.suggestionLimit) => {
  const cleaned = String(term ?? '').trim();
  if (cleaned.length < 2) return { books: [], authors: [] };

  const prefix = new RegExp(`^${escapeRegex(cleaned)}`, 'i');
  // Also matched anywhere, so "gatsby" still finds "The Great Gatsby" — leading
  // articles would otherwise make prefix matching useless for many titles.
  const anywhere = new RegExp(escapeRegex(cleaned), 'i');

  const [books, authors] = await Promise.all([
    Book.find(
      { $or: [{ title: prefix }, { title: anywhere }], isDeleted: false, status: BOOK_STATUS.ACTIVE },
      { title: 1, slug: 1, coverImage: 1, publishedYear: 1, 'inventory.availableCopies': 1 }
    )
      .sort({ 'stats.loanCount': -1 })
      .limit(limit)
      .lean(),

    Author.find({ name: anywhere, isDeleted: false }, { name: 1, slug: 1, bookCount: 1 })
      .sort({ bookCount: -1 })
      .limit(5)
      .lean(),
  ]);

  return { books, authors };
};

export default { search, getFacets, suggest };
