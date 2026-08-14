/**
 * ---------------------------------------------------------------------------
 * PAGINATION HELPERS
 * ---------------------------------------------------------------------------
 * Every list endpoint paginates. Without a cap, `GET /books?limit=999999`
 * loads the entire collection into memory and serialises it — a trivially
 * available denial of service that also happens by accident when someone
 * types the wrong number.
 *
 * `parsePagination` clamps every input to a sane range, so a controller can
 * pass user input straight through and still be safe.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';

/**
 * Turn raw query parameters into safe skip/limit values.
 *
 * Handles the full range of nonsense a query string can carry — negatives,
 * zero, decimals, `NaN`, arrays (`?page=1&page=2` arrives as `['1','2']`), and
 * absurdly large numbers — by clamping rather than throwing. A bad page number
 * is not worth a 422; it is worth showing page 1.
 *
 * @param {object} query Typically `req.query`.
 * @param {object} [overrides] Per-endpoint defaults, e.g. `{ defaultLimit: 10 }`.
 * @returns {{ page: number, limit: number, skip: number }}
 */
export const parsePagination = (query = {}, overrides = {}) => {
  const defaultLimit = overrides.defaultLimit ?? config.pagination.defaultLimit;
  const maxLimit = overrides.maxLimit ?? config.pagination.maxLimit;

  // `?page=1&page=2` gives an array; take the last value, matching how most
  // servers resolve duplicated parameters.
  const raw = (value) => (Array.isArray(value) ? value[value.length - 1] : value);

  const parsedPage = Number.parseInt(raw(query.page), 10);
  const parsedLimit = Number.parseInt(raw(query.limit), 10);

  const page = Number.isFinite(parsedPage) && parsedPage > 0 ? parsedPage : 1;

  const limit =
    Number.isFinite(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, maxLimit) // the cap that makes this safe
      : defaultLimit;

  return { page, limit, skip: (page - 1) * limit };
};

/**
 * Turn a `?sort=` string into a Mongoose sort object.
 *
 * Supports `-field` for descending and comma-separated multi-key sorts:
 *     ?sort=-rating,title   ->   { rating: -1, title: 1 }
 *
 * ALLOW-LISTING IS THE POINT. Sorting on an arbitrary field means sorting on
 * an unindexed one, which turns a fast query into a full collection scan; it
 * also lets a caller probe fields they were never meant to see. Anything not
 * on the allow-list is silently dropped.
 *
 * @param {string} sortParam Raw `?sort=` value.
 * @param {string[]} allowedFields Sortable fields for this endpoint.
 * @param {object} [fallback] Sort used when nothing valid was supplied.
 * @returns {object} A Mongoose sort specification.
 */
export const parseSort = (sortParam, allowedFields = [], fallback = { createdAt: -1 }) => {
  if (!sortParam || typeof sortParam !== 'string') return fallback;

  const allowed = new Set(allowedFields);
  const sort = {};

  for (const rawField of sortParam.split(',')) {
    const token = rawField.trim();
    if (!token) continue;

    const descending = token.startsWith('-');
    const field = descending ? token.slice(1) : token;

    if (allowed.has(field)) sort[field] = descending ? -1 : 1;
  }

  return Object.keys(sort).length > 0 ? sort : fallback;
};

/**
 * Build the `meta` block for a paginated response.
 * Kept next to `parsePagination` so the two never disagree about the maths.
 *
 * @param {{page: number, limit: number, total: number}} params
 */
export const buildPaginationMeta = ({ page, limit, total }) => {
  const safeLimit = Math.max(1, limit);
  const safeTotal = Math.max(0, total);
  const totalPages = Math.ceil(safeTotal / safeLimit);

  return {
    page,
    limit: safeLimit,
    total: safeTotal,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
};

/**
 * Run a find and its count together and return both the rows and the meta.
 *
 * The two queries are issued CONCURRENTLY. Run sequentially they would take
 * the sum of their latencies for no reason — they are independent.
 *
 * `countDocuments` is used rather than `estimatedDocumentCount` because it
 * respects the filter; the estimate ignores it and only counts the whole
 * collection, which is wrong for any filtered list.
 *
 * @param {import('mongoose').Model} model
 * @param {object} filter
 * @param {object} options
 * @param {object} [options.sort]
 * @param {number} options.page
 * @param {number} options.limit
 * @param {number} options.skip
 * @param {string|object} [options.select] Field projection.
 * @param {Array|string} [options.populate]
 * @param {boolean} [options.lean] Plain objects instead of hydrated documents.
 * @returns {Promise<{items: Array, meta: object}>}
 */
export const paginateQuery = async (model, filter, options) => {
  const { sort = { createdAt: -1 }, page, limit, skip, select, populate, lean = true } = options;

  let query = model.find(filter).sort(sort).skip(skip).limit(limit);
  if (select) query = query.select(select);
  if (populate) query = query.populate(populate);
  if (lean) query = query.lean();

  const [items, total] = await Promise.all([query.exec(), model.countDocuments(filter)]);

  return { items, meta: buildPaginationMeta({ page, limit, total }) };
};

/**
 * The `$facet` stage that paginates an aggregation pipeline.
 *
 * Aggregations cannot use `paginateQuery`, and running the pipeline twice —
 * once for rows, once for a count — doubles the work on what is usually the
 * most expensive query in the app. `$facet` computes both in a single pass.
 *
 *     pipeline.push(paginationFacet({ skip, limit }));
 *     // -> [{ items: [...], totalCount: [{ count: 137 }] }]
 *
 * @param {{skip: number, limit: number}} params
 */
export const paginationFacet = ({ skip, limit }) => ({
  $facet: {
    items: [{ $skip: skip }, { $limit: limit }],
    totalCount: [{ $count: 'count' }],
  },
});

/**
 * Read the row count out of a `$facet` result.
 * `totalCount` is an EMPTY ARRAY when nothing matched — `[0].count` on it
 * throws, so the fallback here is doing real work.
 *
 * @param {Array} facetResult
 */
export const extractFacetTotal = (facetResult) => facetResult?.[0]?.totalCount?.[0]?.count ?? 0;

export default {
  parsePagination,
  parseSort,
  buildPaginationMeta,
  paginateQuery,
  paginationFacet,
  extractFacetTotal,
};
