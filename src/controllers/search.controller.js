/**
 * Three endpoints, deliberately separate:
 */

import * as searchService from '../services/search.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, paginated } from '../utils/ApiResponse.js';
import { listBookSummaries } from '../serializers/catalog.serializer.js';

/**
 * Search the catalogue.
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
