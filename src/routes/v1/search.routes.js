/**
 * ---------------------------------------------------------------------------
 * SEARCH ROUTES  —  /api/v1/search
 * ---------------------------------------------------------------------------
 * Public, and rate-limited with its own budget. Search runs text-index queries
 * and `$facet` aggregations — the most database-expensive reads in the
 * application — so it gets a tighter limit than ordinary traffic rather than
 * sharing the global one.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import * as searchController from '../../controllers/search.controller.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimiter } from '../../middlewares/rateLimiter.js';
import { searchQuery, suggestQuery } from '../../validators/catalog.validator.js';

const router = Router();

/**
 * @openapi
 * /search:
 *   get:
 *     tags: [Search]
 *     summary: Search the catalogue
 *     description: |
 *       Weighted full-text search with filtering.
 *
 *       **Ranking** — a match in the title outranks one in the description
 *       (title ×10, subtitle ×5, tags ×3, description ×1).
 *
 *       **Fuzzy fallback** — MongoDB's text index matches whole stemmed words,
 *       so "algo" would find nothing. When text search returns zero results the
 *       query is retried as a substring match, and the response reports
 *       `exactMatch: false` so a client can label the results honestly.
 *
 *       **Category filters expand down the tree** — filtering by "Science" also
 *       matches books tagged only with a descendant category.
 *
 *       Omit `q` entirely for a filtered browse.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string, example: things fall apart }
 *         description: Free-text term. Omit for a filtered browse.
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *         description: Category ID or slug. Includes descendants by default.
 *       - in: query
 *         name: includeSubcategories
 *         schema: { type: boolean, default: true }
 *       - in: query
 *         name: author
 *         schema: { type: string }
 *       - in: query
 *         name: publisher
 *         schema: { type: string }
 *       - in: query
 *         name: language
 *         schema: { type: string, example: en }
 *       - in: query
 *         name: yearFrom
 *         schema: { type: integer, example: 1950 }
 *       - in: query
 *         name: yearTo
 *         schema: { type: integer, example: 2000 }
 *       - in: query
 *         name: minRating
 *         schema: { type: number, minimum: 0, maximum: 5, example: 4 }
 *       - in: query
 *         name: available
 *         schema: { type: boolean }
 *         description: Only titles with a copy on the shelf right now.
 *       - in: query
 *         name: format
 *         schema: { type: string, enum: [physical, digital, any] }
 *       - in: query
 *         name: tags
 *         schema: { type: string, example: 'fiction,classic' }
 *         description: Comma-separated. A book must carry ALL of them.
 *       - in: query
 *         name: sort
 *         schema:
 *           type: string
 *           enum: [relevance, title, -title, newest, oldest, rating, popular, recent]
 *           default: relevance
 *     responses:
 *       200:
 *         description: Search results.
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
 *                     meta:
 *                       type: object
 *                       properties:
 *                         page:       { type: integer }
 *                         total:      { type: integer }
 *                         searchTerm: { type: string, nullable: true }
 *                         exactMatch:
 *                           type: boolean
 *                           description: false when the fuzzy fallback produced these results.
 *       422: { description: 'Invalid filter — e.g. yearFrom later than yearTo.' }
 *       429: { $ref: '#/components/responses/TooManyRequests' }
 */
router.get('/', rateLimiter('search'), validate({ query: searchQuery }), searchController.search);

/**
 * @openapi
 * /search/facets:
 *   get:
 *     tags: [Search]
 *     summary: Filter counts for the current query
 *     description: >
 *       Counts per category, author, language, decade and availability for
 *       whatever the current filters match — everything a sidebar needs to show
 *       numbers next to each option.
 *       Computed in ONE aggregation pass rather than one query per facet, so
 *       the counts are both fast and internally consistent.
 *       Accepts the same parameters as `GET /search`.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         schema: { type: string }
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Facet counts.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     categories:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           name:  { type: string }
 *                           slug:  { type: string }
 *                           count: { type: integer }
 *                     languages: { type: array, items: { type: object } }
 *                     decades:   { type: array, items: { type: object } }
 *                     availability:
 *                       type: object
 *                       properties:
 *                         available:   { type: integer }
 *                         unavailable: { type: integer }
 *                         digital:     { type: integer }
 *                     total: { type: integer }
 */
router.get('/facets', rateLimiter('search'), validate({ query: searchQuery }), searchController.facets);

/**
 * @openapi
 * /search/suggest:
 *   get:
 *     tags: [Search]
 *     summary: Type-ahead suggestions
 *     description: >
 *       Titles and authors matching a partial term, for a search box.
 *       Prefix-anchored so it can be served from an index — an unanchored
 *       pattern would scan the whole collection on every keystroke.
 *       Requires at least 2 characters.
 *     security: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema: { type: string, minLength: 2, example: alg }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 20 }
 *     responses:
 *       200:
 *         description: Matching titles and authors.
 *       422: { description: 'Fewer than 2 characters.' }
 */
router.get('/suggest', rateLimiter('search'), validate({ query: suggestQuery }), searchController.suggest);

export default router;
