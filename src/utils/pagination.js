/**
 * Every list endpoint paginates. Without a cap, `GET /books?limit=999999`
 * loads the entire collection into memory and serialises it — a trivially
 * available denial of service that also happens by accident when someone
 */

import config from '../config/index.js';

/**
 * Turn raw query parameters into safe skip/limit values.
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
