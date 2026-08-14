/**
 * ---------------------------------------------------------------------------
 * SEARCH CONTROLLER
 * ---------------------------------------------------------------------------
 * Three endpoints, deliberately separate:
 *
 *   GET /search           results only
 *   GET /search/facets    filter counts only
 *   GET /search/suggest   type-ahead
 *
 * Keeping facets on their own route matters. A filter sidebar's counts change
 * far less often than the result page, so a client can fetch them once per
 * query and then paginate freely — whereas bundling them into every search
 * response would recompute the whole aggregation on each page turn, for data
 * that did not change.
 * ---------------------------------------------------------------------------
 */

import * as searchService from '../services/search.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, paginated } from '../utils/ApiResponse.js';
import { listBookSummaries } from '../serializers/catalog.serializer.js';

/**
 * Search the catalogue.
 *
 * `exactMatch: false` in the response means the text index found nothing and
 * the fuzzy fallback ran. Surfaced so a client can say "no exact matches —
 * showing similar titles" rather than presenting weaker results as exact hits.
 */
export const search = asyncHandler(async (req, res) => {
  const { items, meta, fallbackUsed, searchTerm } = await searchService.search(req.query);

  return paginated(res, listBookSummaries(items), meta, 'Search complete', {
    searchTerm: searchTerm ?? null,
    exactMatch: !fallbackUsed,
    ...(fallbackUsed
      ? { note: 'No exact matches were found, so these are the closest titles.' }
      : {}),
  });
});

/** Counts per filter value, for a sidebar. Computed in one aggregation pass. */
export const facets = asyncHandler(async (req, res) => {
  const result = await searchService.getFacets(req.query);
  return ok(res, result, 'Facets fetched');
});

/** Type-ahead suggestions across titles and authors. */
export const suggest = asyncHandler(async (req, res) => {
  const result = await searchService.suggest(req.query.q, req.query.limit);
  return ok(
    res,
    { books: listBookSummaries(result.books), authors: result.authors },
    'Suggestions fetched'
  );
});

export default { search, facets, suggest };
