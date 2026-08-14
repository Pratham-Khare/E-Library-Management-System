/**
 * ---------------------------------------------------------------------------
 * AI ROUTES  —  /api/v1/ai
 * ---------------------------------------------------------------------------
 * Every generation endpoint carries the `ai` rate limiter: 5 per member per
 * day, keyed by USER rather than IP. With a 100-call lifetime budget, an
 * IP-keyed limit would be trivially bypassed and a shared campus address would
 * throttle everyone at once.
 *
 * Staff are exempt from that limiter (see middlewares/rateLimiter.js) — a
 * librarian backfilling summaries should not be throttled by a limit designed
 * to stop one member burning the shared budget.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import { z } from 'zod';
import * as aiService from '../../services/ai.service.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/authenticate.js';
import { requireStaff, requireAdmin } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimiter } from '../../middlewares/rateLimiter.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok } from '../../utils/ApiResponse.js';
import { objectId, queryBoolean } from '../../validators/common.js';
import { AI_SUMMARY_LENGTH_VALUES } from '../../constants/enums.js';

const router = Router();

/* --- Schemas -------------------------------------------------------------- */

const bookIdParam = z.object({ bookId: objectId });

const summaryQuery = z.object({
  length: z.enum(AI_SUMMARY_LENGTH_VALUES).default('MEDIUM'),
  language: z.string().trim().toLowerCase().length(2).default('en'),
  /** Staff only — bypasses the cache and spends a call. */
  force: queryBoolean.optional(),
});

const questionSchema = z.object({
  question: z
    .string()
    .trim()
    .min(5, 'Please ask a fuller question')
    .max(500, 'That question is too long'),
});

const recommendationsQuery = z.object({
  limit: z.coerce.number().int().min(1).max(20).default(10),
  /**
   * Rationales are OPT-IN because they are the only part that costs a call.
   * The recommendations themselves are a database query and always free.
   */
  explain: queryBoolean.optional(),
});

/* ===========================================================================
 * Summaries
 * ======================================================================== */

/**
 * @openapi
 * /ai/books/{bookId}/summary:
 *   get:
 *     tags: [AI]
 *     summary: AI-generated book summary
 *     description: |
 *       Generates a summary, or returns a previously generated one.
 *
 *       **How it resolves**, in order:
 *       1. **Cache** — already generated for this book, length and prompt
 *          version? Returned immediately, costing nothing.
 *       2. **Live** — a real call to `gpt-4o-mini`. Counts against a
 *          budget of 100 calls for the token's ENTIRE LIFETIME.
 *       3. **Mock** — deterministic content built from the book's own
 *          metadata, when no live call is possible.
 *
 *       Every response reports `source` (`cache` | `live` | `mock`) and
 *       `aiGenerated`. **Mock content is never presented as model output.**
 *
 *       When an ebook has been uploaded, the summary is generated from the
 *       extracted text rather than the catalogue blurb — `basedOn` says which.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: length
 *         schema: { type: string, enum: [SHORT, MEDIUM, LONG], default: MEDIUM }
 *       - in: query
 *         name: force
 *         schema: { type: boolean }
 *         description: Staff only. Bypasses the cache and spends a call.
 *     responses:
 *       200:
 *         description: The summary.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     content:     { type: string }
 *                     source:      { type: string, enum: [cache, live, mock] }
 *                     aiGenerated: { type: boolean, description: 'false for mock content.' }
 *                     cached:      { type: boolean }
 *                     basedOn:     { type: string, example: the catalogue record }
 *                     notice:      { type: string, description: 'Present only on mock responses.' }
 *       400: { description: 'Too little material to summarise (AI_INSUFFICIENT_CONTEXT).' }
 *       429: { description: 'Your daily AI limit, or the shared budget, is exhausted.' }
 *       501: { description: 'This AI feature is disabled (AI_FEATURE_DISABLED).' }
 *       503: { description: 'AI unavailable and mocking is disabled.' }
 */
router.get(
  '/books/:bookId/summary',
  optionalAuthenticate,
  rateLimiter('ai'),
  validate({ params: bookIdParam, query: summaryQuery }),
  asyncHandler(async (req, res) => {
    // `force` is a staff capability — it deliberately spends a call.
    const force = req.query.force === true && ['LIBRARIAN', 'ADMIN'].includes(req.user?.role);
    const result = await aiService.getSummary(
      req.params.bookId,
      { length: req.query.length, language: req.query.language, force },
      req.user
    );
    return ok(res, result, result.cached ? 'Summary (from cache)' : 'Summary generated');
  })
);

/**
 * @openapi
 * /ai/books/{bookId}/takeaways:
 *   get:
 *     tags: [AI]
 *     summary: Key takeaways about a book
 *     description: >
 *       Five to seven bullet points to help a reader decide whether to borrow
 *       it. Cached and quota-guarded exactly like the summary endpoint.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'An array of takeaways in `content`.' }
 */
router.get(
  '/books/:bookId/takeaways',
  optionalAuthenticate,
  rateLimiter('ai'),
  validate({ params: bookIdParam, query: summaryQuery }),
  asyncHandler(async (req, res) => {
    const force = req.query.force === true && ['LIBRARIAN', 'ADMIN'].includes(req.user?.role);
    const result = await aiService.getKeyTakeaways(
      req.params.bookId,
      { language: req.query.language, force },
      req.user
    );
    return ok(res, result, 'Key takeaways');
  })
);

/**
 * @openapi
 * /ai/books/{bookId}/simplified:
 *   get:
 *     tags: [AI]
 *     summary: Plain-language summary
 *     description: >
 *       The book explained as it would be to a 15-year-old — genuinely useful
 *       for students approaching an unfamiliar subject, and for anyone deciding
 *       whether a dense-looking title is worth their time.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The simplified summary.' }
 */
router.get(
  '/books/:bookId/simplified',
  optionalAuthenticate,
  rateLimiter('ai'),
  validate({ params: bookIdParam, query: summaryQuery }),
  asyncHandler(async (req, res) => {
    const force = req.query.force === true && ['LIBRARIAN', 'ADMIN'].includes(req.user?.role);
    const result = await aiService.getSimplified(
      req.params.bookId,
      { language: req.query.language, force },
      req.user
    );
    return ok(res, result, 'Simplified summary');
  })
);

/**
 * @openapi
 * /ai/books/{bookId}/ask:
 *   post:
 *     tags: [AI]
 *     summary: Ask a question about a book
 *     description: >
 *       Answers from the catalogue record and, where an ebook has been
 *       uploaded, its extracted text.
 *       The model is instructed NOT TO GUESS — `answeredFromSource: false`
 *       means it could not answer from the material rather than that it
 *       invented something. A library publishing fabricated plot details would
 *       be worse than one publishing none.
 *       Answers are cached against a normalised question, so the same question
 *       asked by twenty members costs one call in total.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question]
 *             properties:
 *               question: { type: string, example: 'What is the main theme of this book?' }
 *     responses:
 *       200:
 *         description: The answer.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     content:
 *                       type: object
 *                       properties:
 *                         answer:             { type: string }
 *                         answeredFromSource: { type: boolean }
 *                     source: { type: string }
 *       429: { description: 'Daily limit reached.' }
 */
router.post(
  '/books/:bookId/ask',
  authenticate,
  rateLimiter('ai'),
  validate({ params: bookIdParam, body: questionSchema }),
  asyncHandler(async (req, res) => {
    const result = await aiService.askQuestion(req.params.bookId, req.body.question, req.user);
    return ok(res, result, 'Answer');
  })
);

/* ===========================================================================
 * Recommendations
 * ======================================================================== */

/**
 * @openapi
 * /ai/recommendations:
 *   get:
 *     tags: [AI]
 *     summary: Personalised book recommendations
 *     description: |
 *       Books chosen from your borrowing history by shared authors and
 *       categories.
 *
 *       **Selection is a database query, not an AI call** — instant, free, and
 *       available to every member on every request. `explain=true` additionally
 *       spends ONE call to write the rationales; without it you still get the
 *       same recommendations with offline explanations.
 *
 *       With no borrowing history, falls back to popular well-rated titles,
 *       and says so via `personalised: false`.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 10, maximum: 20 }
 *       - in: query
 *         name: explain
 *         schema: { type: boolean, default: false }
 *         description: Spend an AI call to write the rationales.
 *     responses:
 *       200: { description: 'Recommendations, with `source` reporting how the rationales were produced.' }
 */
router.get(
  '/recommendations',
  authenticate,
  validate({ query: recommendationsQuery }),
  asyncHandler(async (req, res) => {
    const result = await aiService.getRecommendations(req.user, {
      limit: req.query.limit,
      explain: req.query.explain === true,
    });
    return ok(res, result, result.personalised ? 'Recommended for you' : 'Popular in the library');
  })
);

/* ===========================================================================
 * Staff
 * ======================================================================== */

/**
 * @openapi
 * /ai/books/{bookId}/suggest-metadata:
 *   post:
 *     tags: [AI]
 *     summary: Suggest catalogue metadata (staff only)
 *     description: >
 *       Proposes categories, tags and a reading level for a book. Advisory
 *       only — nothing is applied automatically, and a `confidence` figure
 *       accompanies the suggestion.
 *     parameters:
 *       - in: path
 *         name: bookId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Suggestions.' }
 */
router.post(
  '/books/:bookId/suggest-metadata',
  authenticate,
  requireStaff,
  rateLimiter('ai'),
  validate({ params: bookIdParam }),
  asyncHandler(async (req, res) => {
    const result = await aiService.suggestMetadata(req.params.bookId, req.user);
    return ok(res, result, 'Metadata suggestions');
  })
);

/**
 * @openapi
 * /ai/status:
 *   get:
 *     tags: [AI]
 *     summary: AI quota and cache status (staff only)
 *     description: |
 *       How the AI subsystem is actually behaving:
 *
 *       - the operating mode (`live` or `mock`) and WHY
 *       - calls used and remaining, reconciled against the provider
 *       - the circuit-breaker state
 *       - cache size, and how many entries are mock
 *       - **`savedByCache`** — requests served without spending a call, which
 *         on a 100-call lifetime budget is the number that matters most
 *     responses:
 *       200: { description: 'Status.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/status',
  authenticate,
  requireStaff,
  asyncHandler(async (req, res) => {
    const status = await aiService.getStatus();
    return ok(res, status, 'AI status');
  })
);

/**
 * @openapi
 * /ai/sync-usage:
 *   post:
 *     tags: [AI]
 *     summary: Reconcile the call count with the provider (admin only)
 *     description: >
 *       Fetches the provider's own usage figures, so the locally counted total
 *       cannot drift — another deployment might share this token.
 *       Also runs automatically on a schedule.
 *     responses:
 *       200: { description: 'Reconciled.' }
 *
 * /ai/upgrade-mocks:
 *   post:
 *     tags: [AI]
 *     summary: Regenerate mock summaries with real model output (admin only)
 *     description: >
 *       For after a valid token is added — entries produced offline can be
 *       upgraded in bulk.
 *       DELIBERATELY BOUNDED: with a 100-call lifetime budget, an unbounded
 *       regeneration would spend everything in a single command. Stops as soon
 *       as the budget runs out and reports what it managed.
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 5, maximum: 20 }
 *     responses:
 *       200: { description: 'What was upgraded, and what was not.' }
 */
router.post(
  '/sync-usage',
  authenticate,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await aiService.syncUsage();
    return ok(res, result, result.synced ? 'Usage reconciled' : result.reason);
  })
);

router.post(
  '/upgrade-mocks',
  authenticate,
  requireAdmin,
  validate({ query: z.object({ limit: z.coerce.number().int().min(1).max(20).default(5) }) }),
  asyncHandler(async (req, res) => {
    const result = await aiService.upgradeMockSummaries({ limit: req.query.limit }, req.user);
    return ok(res, result, 'Mock summaries processed');
  })
);

export default router;
