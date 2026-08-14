/**
 * Every AI feature follows the SAME three-step fallback, and understanding it
 * explains the whole subsystem:
 */

import crypto from 'node:crypto';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Book } from '../models/Book.js';
import { DigitalAsset } from '../models/DigitalAsset.js';
import { Loan } from '../models/Loan.js';
import { AiSummary } from '../models/AiSummary.js';
import { AiUsageLog } from '../models/AiUsageLog.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import {
  AI_FEATURE,
  AI_SOURCE,
  AI_SUMMARY_KIND,
  AI_SUMMARY_LENGTH,
  MODERATION_VERDICT,
  BOOK_STATUS,
} from '../constants/enums.js';
import * as client from '../integrations/ai/client.js';
import * as quotaGuard from '../integrations/ai/quotaGuard.js';
import * as mock from '../integrations/ai/mockProvider.js';
import prompts, { parseJsonResponse, hasSufficientContext } from '../integrations/ai/prompts/index.js';

/* Helpers */

/** Load a book with everything the prompts need. */
const loadBook = async (bookId) => {
  const book = await Book.findOne({ _id: bookId, isDeleted: false, status: BOOK_STATUS.ACTIVE })
    .populate('authors', 'name')
    .populate('categories', 'name');

  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);
  return book;
};

/**
 * Extracted ebook text, when available.
 */
const loadExtractedText = async (bookId) => {
  const asset = await DigitalAsset.findOne({
    book: bookId,
    extractionStatus: 'COMPLETED',
    extractedCharCount: { $gt: 0 },
  })
    .select('+extractedText')
    .sort({ extractedCharCount: -1 });

  return asset?.extractedText ?? null;
};

/**
 * Fingerprint of the source material.
 */
const hashInput = (book, extractedText) =>
  crypto
    .createHash('sha256')
    .update(`${book.title}|${book.description ?? ''}|${(extractedText ?? '').slice(0, 5000)}`)
    .digest('hex');

/**
 * Normalise a question before hashing it for the cache.
 */
const hashQuestion = (question) =>
  crypto
    .createHash('sha256')
    .update(
      String(question)
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .digest('hex');

/** Reject a request for a feature that is switched off, rather than silently doing nothing. */
const assertFeatureEnabled = (feature) => {
  if (!config.ai.isFeatureEnabled(feature)) {
    throw ApiError.notImplemented(
      `The ${feature.toLowerCase().replace(/_/g, ' ')} feature is currently disabled`,
      ERROR_CODES.AI_FEATURE_DISABLED
    );
  }
};

/* The core generation flow */

/**
 * Cache → live → mock, in one place.
 */
const generate = async ({
  feature,
  book,
  user,
  findCached,
  buildPrompt,
  parseLive,
  buildMock,
  persist,
  requireContext = true,
  extractedText = null,
}) => {
  const userId = user?.id ?? user?._id ?? null;

  /* --- 1. CACHE ------------------------------------------------------ */
  if (config.ai.cache.enabled && findCached) {
    const startedAt = Date.now();
    const cached = await findCached();

    if (cached) {
      AiSummary.recordHit(cached._id).catch(() => {});

      await quotaGuard.recordUsage({
        user: userId,
        book: book._id,
        feature,
        source: AI_SOURCE.CACHE,
        latencyMs: Date.now() - startedAt,
      });

      return {
        content: cached.content,
        source: cached.isMock ? AI_SOURCE.MOCK : AI_SOURCE.CACHE,
        aiGenerated: !cached.isMock,
        cached: true,
        generatedAt: cached.generatedAt,
        model: cached.model,
        isMock: cached.isMock,
        /**
         * The notice travels with CACHED mock content too.
         */
        ...(cached.isMock
          ? {
              notice:
                'Generated offline because the AI service is unavailable. This is not model-generated content.',
            }
          : {}),
      };
    }
  }

  /* --- 2. LIVE -------------------------------------------------------- */
  const permission = await quotaGuard.canMakeLiveCall(userId);

  /**
   * Why a live call was impossible. Carried into the mock decision below, so
   * "the provider rejected our token" reaches `shouldMock()` as
   * `tokenRejected` rather than being lost — without which AI_MOCK_MODE=auto
   * would throw on an invalid token instead of degrading, which is precisely
   */
  const liveFailure = { tokenRejected: false, quotaExhausted: false };

  if (permission.allowed) {
    // Refuse to spend a call hallucinating from a one-line record.
    if (requireContext && !hasSufficientContext(book, extractedText)) {
      throw ApiError.badRequest(
        'There is not enough information about this book to generate a useful summary. A librarian can add a description or attach the ebook.',
        ERROR_CODES.AI_INSUFFICIENT_CONTEXT
      );
    }

    const startedAt = Date.now();

    try {
      const { messages, maxTokens, jsonMode } = buildPrompt();
      const response = await client.chat(messages, { maxTokens, jsonMode });

      const parsed = parseJsonResponse(response.content);
      if (!parsed) {
        throw ApiError.badGateway(
          'The AI service returned a response we could not read',
          ERROR_CODES.AI_MALFORMED_RESPONSE
        );
      }

      const content = parseLive(parsed);

      await quotaGuard.recordUsage({
        user: userId,
        book: book._id,
        feature,
        source: AI_SOURCE.LIVE,
        usage: response.usage,
        latencyMs: response.latencyMs,
        model: response.model,
      });

      const saved = persist
        ? await persist(content, { isMock: false, model: response.model, usage: response.usage })
        : null;

      logger.info('AI content generated', {
        feature,
        bookId: String(book._id),
        tokens: response.usage.totalTokens,
        latencyMs: response.latencyMs,
        remaining: permission.remaining - 1,
      });

      return {
        content,
        source: AI_SOURCE.LIVE,
        aiGenerated: true,
        cached: false,
        generatedAt: saved?.generatedAt ?? new Date(),
        model: response.model,
        isMock: false,
        tokensUsed: response.usage.totalTokens,
      };
    } catch (error) {
      await quotaGuard.recordUsage({
        user: userId,
        book: book._id,
        feature,
        source: AI_SOURCE.LIVE,
        success: false,
        errorCode: error.code,
        errorMessage: error.message,
        latencyMs: Date.now() - startedAt,
      });

      /**
       * A LIVE FAILURE FALLS THROUGH TO MOCK rather than failing the request.
       */
      if (config.ai.mock.neverMock) throw error;

      // Carry the REASON forward so the mock decision below can act on it.
      liveFailure.tokenRejected = error.code === ERROR_CODES.AI_INVALID_TOKEN;
      liveFailure.quotaExhausted = error.code === ERROR_CODES.AI_QUOTA_EXHAUSTED;

      /**
       * A rejected token will keep being rejected. Latch it, so every
       * subsequent request skips straight to mock instead of paying a full
       * network round-trip and a retry cycle to rediscover the same fact.
       */
      if (liveFailure.tokenRejected) quotaGuard.markTokenRejected(error.message);

      logger.warn('Live AI call failed; falling back to mock content', {
        feature,
        error: error.message,
        code: error.code,
      });
    }
  }

  /* --- 3. MOCK -------------------------------------------------------- */
  if (!config.ai.mock.shouldMock({
    tokenMissing: permission.code === 'tokenMissing',
    tokenRejected: liveFailure.tokenRejected || permission.code === 'tokenRejected',
    quotaExhausted: liveFailure.quotaExhausted || permission.code === 'quotaExhausted',
  })) {
    // Mocking is not permitted here — usually AI_MOCK_MODE=never, or the
    // member simply hit their own daily cap, which is not a system failure.
    if (permission.code === 'userLimitReached') {
      throw ApiError.tooManyRequests(permission.reason, ERROR_CODES.AI_USER_LIMIT_REACHED, {
        details: { dailyLimit: config.rateLimit.groups.ai.max },
      });
    }

    throw ApiError.serviceUnavailable(
      permission.reason ?? 'AI generation is not available at the moment',
      permission.code === 'quotaExhausted'
        ? ERROR_CODES.AI_QUOTA_EXHAUSTED
        : ERROR_CODES.AI_UNAVAILABLE,
      { details: { aiAvailable: false, reason: permission.reason } }
    );
  }

  const startedAt = Date.now();
  const content = buildMock();

  await quotaGuard.recordUsage({
    user: userId,
    book: book._id,
    feature,
    source: AI_SOURCE.MOCK,
    latencyMs: Date.now() - startedAt,
  });

  const saved = persist ? await persist(content, { isMock: true, model: 'mock' }) : null;

  return {
    content,
    source: AI_SOURCE.MOCK,
    /** Explicitly false. This content did not come from a model. */
    aiGenerated: false,
    cached: false,
    generatedAt: saved?.generatedAt ?? new Date(),
    model: 'mock',
    isMock: true,
    notice:
      'Generated offline because the AI service is unavailable. This is not model-generated content.',
  };
};

/* Summaries */

/**
 * Persist a generated summary.
 */
const persistSummary = (book, { kind, length, language, inputHash, sourceType, generatedBy }) =>
  async (content, meta) => {
    if (!config.ai.cache.enabled) return null;

    try {
      return await AiSummary.create({
        book: book._id,
        kind,
        length,
        language,
        content,
        model: meta.model,
        promptVersion: config.ai.cache.promptVersion,
        inputHash,
        sourceType,
        isMock: meta.isMock,
        promptTokens: meta.usage?.promptTokens ?? 0,
        completionTokens: meta.usage?.completionTokens ?? 0,
        generatedBy,
      });
    } catch (error) {
      if (error.code === 11000) {
        logger.debug('Another request cached this summary first — reusing it');
        return AiSummary.findCached({
          book: book._id,
          kind,
          length,
          language,
          promptVersion: config.ai.cache.promptVersion,
        });
      }
      throw error;
    }
  };

/**
 * Generate (or fetch) a book summary.
 *
 * @param {boolean} [options.force] Bypass the cache. Staff only.
 */
export const getSummary = async (bookId, { length = AI_SUMMARY_LENGTH.MEDIUM, language = 'en', force = false } = {}, user = null) => {
  assertFeatureEnabled(AI_FEATURE.SUMMARY);

  const book = await loadBook(bookId);
  const extractedText = await loadExtractedText(book._id);
  const inputHash = hashInput(book, extractedText);

  // A forced regeneration removes the old entry, so the unique index does not
  // reject the replacement.
  if (force) {
    await AiSummary.deleteOne({
      book: book._id,
      kind: AI_SUMMARY_KIND.SUMMARY,
      length,
      language,
      promptVersion: config.ai.cache.promptVersion,
    });
  }

  const result = await generate({
    feature: AI_FEATURE.SUMMARY,
    book,
    user,
    extractedText,
    findCached: force
      ? null
      : () =>
          AiSummary.findCached({
            book: book._id,
            kind: AI_SUMMARY_KIND.SUMMARY,
            length,
            language,
            promptVersion: config.ai.cache.promptVersion,
          }),
    buildPrompt: () => prompts.summaryPrompt(book, { length, extractedText }),
    parseLive: (parsed) => parsed.summary ?? parsed.content ?? '',
    buildMock: () => mock.mockSummary(book, { length }),
    persist: persistSummary(book, {
      kind: AI_SUMMARY_KIND.SUMMARY,
      length,
      language,
      inputHash,
      sourceType: extractedText ? 'FULL_TEXT' : 'METADATA',
      generatedBy: user?.id ?? null,
    }),
  });

  return {
    ...result,
    book: { id: String(book._id), title: book.title, slug: book.slug },
    length,
    basedOn: extractedText ? 'the book text' : 'the catalogue record',
  };
};

/** Key takeaways — 5 to 7 bullet points. */
export const getKeyTakeaways = async (bookId, { language = 'en', force = false } = {}, user = null) => {
  assertFeatureEnabled(AI_FEATURE.KEY_TAKEAWAYS);

  const book = await loadBook(bookId);
  const extractedText = await loadExtractedText(book._id);

  if (force) {
    await AiSummary.deleteOne({
      book: book._id,
      kind: AI_SUMMARY_KIND.KEY_TAKEAWAYS,
      length: AI_SUMMARY_LENGTH.MEDIUM,
      language,
      promptVersion: config.ai.cache.promptVersion,
    });
  }

  const result = await generate({
    feature: AI_FEATURE.KEY_TAKEAWAYS,
    book,
    user,
    extractedText,
    findCached: force
      ? null
      : () =>
          AiSummary.findCached({
            book: book._id,
            kind: AI_SUMMARY_KIND.KEY_TAKEAWAYS,
            length: AI_SUMMARY_LENGTH.MEDIUM,
            language,
            promptVersion: config.ai.cache.promptVersion,
          }),
    buildPrompt: () => prompts.keyTakeawaysPrompt(book, { extractedText }),
    parseLive: (parsed) => parsed.takeaways ?? [],
    buildMock: () => mock.mockKeyTakeaways(book),
    persist: persistSummary(book, {
      kind: AI_SUMMARY_KIND.KEY_TAKEAWAYS,
      length: AI_SUMMARY_LENGTH.MEDIUM,
      language,
      inputHash: hashInput(book, extractedText),
      sourceType: extractedText ? 'FULL_TEXT' : 'METADATA',
      generatedBy: user?.id ?? null,
    }),
  });

  return { ...result, book: { id: String(book._id), title: book.title } };
};

/** Plain-language summary, aimed at a younger or non-specialist reader. */
export const getSimplified = async (bookId, { language = 'en', force = false } = {}, user = null) => {
  assertFeatureEnabled(AI_FEATURE.SIMPLIFIED);

  const book = await loadBook(bookId);
  const extractedText = await loadExtractedText(book._id);

  if (force) {
    await AiSummary.deleteOne({
      book: book._id,
      kind: AI_SUMMARY_KIND.SIMPLIFIED,
      length: AI_SUMMARY_LENGTH.SHORT,
      language,
      promptVersion: config.ai.cache.promptVersion,
    });
  }

  const result = await generate({
    feature: AI_FEATURE.SIMPLIFIED,
    book,
    user,
    extractedText,
    findCached: force
      ? null
      : () =>
          AiSummary.findCached({
            book: book._id,
            kind: AI_SUMMARY_KIND.SIMPLIFIED,
            length: AI_SUMMARY_LENGTH.SHORT,
            language,
            promptVersion: config.ai.cache.promptVersion,
          }),
    buildPrompt: () => prompts.simplifiedPrompt(book, { extractedText }),
    parseLive: (parsed) => parsed.summary ?? '',
    buildMock: () => mock.mockSimplified(book),
    persist: persistSummary(book, {
      kind: AI_SUMMARY_KIND.SIMPLIFIED,
      length: AI_SUMMARY_LENGTH.SHORT,
      language,
      inputHash: hashInput(book, extractedText),
      sourceType: extractedText ? 'FULL_TEXT' : 'METADATA',
      generatedBy: user?.id ?? null,
    }),
  });

  return { ...result, book: { id: String(book._id), title: book.title } };
};

/* Question answering */

/**
 * Answer a question about a book.
 */
export const askQuestion = async (bookId, question, user = null) => {
  assertFeatureEnabled(AI_FEATURE.QA);

  const book = await loadBook(bookId);
  const extractedText = await loadExtractedText(book._id);
  const questionHash = hashQuestion(question);

  // An existing summary is useful extra context, and costs nothing to include.
  const existing = await AiSummary.findCached({
    book: book._id,
    kind: AI_SUMMARY_KIND.SUMMARY,
    length: AI_SUMMARY_LENGTH.MEDIUM,
    language: 'en',
    promptVersion: config.ai.cache.promptVersion,
  });

  const result = await generate({
    feature: AI_FEATURE.QA,
    book,
    user,
    extractedText,
    requireContext: false, // a factual question can be answered from metadata alone
    findCached: config.ai.cache.cacheQuestionAnswers
      ? () =>
          AiSummary.findCachedAnswer({
            book: book._id,
            questionHash,
            promptVersion: config.ai.cache.promptVersion,
          })
      : null,
    buildPrompt: () =>
      prompts.questionPrompt(book, question, {
        extractedText,
        existingSummary: typeof existing?.content === 'string' ? existing.content : null,
      }),
    parseLive: (parsed) => ({
      answer: parsed.answer ?? '',
      // The model's own admission that it could not answer from the source —
      // surfaced so a client can present it differently from a real answer.
      answeredFromSource: parsed.answeredFromSource !== false,
    }),
    buildMock: () => ({ answer: mock.mockAnswer(book, question), answeredFromSource: false }),
    persist: async (content, meta) => {
      if (!config.ai.cache.enabled || !config.ai.cache.cacheQuestionAnswers) return null;
      try {
        return await AiSummary.create({
          book: book._id,
          kind: AI_SUMMARY_KIND.QA,
          length: AI_SUMMARY_LENGTH.SHORT,
          language: 'en',
          content,
          question: String(question).slice(0, 500),
          questionHash,
          model: meta.model,
          promptVersion: config.ai.cache.promptVersion,
          isMock: meta.isMock,
          promptTokens: meta.usage?.promptTokens ?? 0,
          completionTokens: meta.usage?.completionTokens ?? 0,
          generatedBy: user?.id ?? null,
        });
      } catch (error) {
        if (error.code === 11000) return null;
        throw error;
      }
    },
  });

  return {
    ...result,
    question,
    book: { id: String(book._id), title: book.title },
  };
};

/* Recommendations */

/**
 * Recommend books for a member.
 */
export const getRecommendations = async (user, { limit = 10, explain = false } = {}) => {
  assertFeatureEnabled(AI_FEATURE.RECOMMENDATIONS);

  const userId = user.id ?? user._id;

  const history = await Loan.find({ user: userId })
    .populate('book', 'title categories authors')
    .sort({ issuedAt: -1 })
    .limit(20)
    .lean();

  const borrowedBookIds = history.map((loan) => loan.book?._id).filter(Boolean);
  const categoryIds = [...new Set(history.flatMap((loan) => loan.book?.categories ?? []).map(String))];
  const authorIds = [...new Set(history.flatMap((loan) => loan.book?.authors ?? []).map(String))];

  // No history: fall back to what is popular and well rated.
  if (borrowedBookIds.length === 0) {
    const popular = await Book.find({ isDeleted: false, status: BOOK_STATUS.ACTIVE, 'rating.count': { $gte: 1 } })
      .sort({ 'stats.loanCount': -1, 'rating.average': -1 })
      .limit(limit)
      .populate('authors', 'name slug')
      .populate('categories', 'name slug')
      .lean();

    return {
      recommendations: popular.map((book) => ({
        book,
        reason: 'Popular with other members',
        score: book.stats?.loanCount ?? 0,
      })),
      basedOn: [],
      personalised: false,
      source: 'heuristic',
    };
  }

  const mongoose = (await import('mongoose')).default;
  const toId = (value) => new mongoose.Types.ObjectId(String(value));

  const candidates = await Book.aggregate([
    {
      $match: {
        _id: { $nin: borrowedBookIds.map(toId) },
        isDeleted: false,
        status: BOOK_STATUS.ACTIVE,
        $or: [
          { categories: { $in: categoryIds.map(toId) } },
          { authors: { $in: authorIds.map(toId) } },
        ],
      },
    },
    {
      $addFields: {
        sharedCategories: { $size: { $setIntersection: ['$categories', categoryIds.map(toId)] } },
        sharedAuthors: { $size: { $setIntersection: ['$authors', authorIds.map(toId)] } },
      },
    },
    {
      $addFields: {
        // A shared author is a far stronger signal than a shared category,
        // since categories are broad. Rating breaks ties.
        score: {
          $add: [
            { $multiply: ['$sharedAuthors', 4] },
            { $multiply: ['$sharedCategories', 2] },
            { $multiply: ['$rating.average', 0.5] },
            { $cond: [{ $gt: ['$inventory.availableCopies', 0] }, 1, 0] },
          ],
        },
      },
    },
    { $sort: { score: -1, 'rating.average': -1 } },
    { $limit: limit },
    { $lookup: { from: 'authors', localField: 'authors', foreignField: '_id', as: 'authors', pipeline: [{ $project: { name: 1, slug: 1 } }] } },
    { $lookup: { from: 'categories', localField: 'categories', foreignField: '_id', as: 'categories', pipeline: [{ $project: { name: 1, slug: 1 } }] } },
  ]);

  const basedOnTitles = [...new Set(history.map((loan) => loan.book?.title).filter(Boolean))].slice(0, 5);

  // Rationales are OPT-IN, because that is the only part that costs a call.
  // The recommendations themselves are always free.
  let reasons = new Map();

  if (explain && candidates.length > 0) {
    const permission = await quotaGuard.canMakeLiveCall(userId);

    if (permission.allowed) {
      try {
        const { messages, maxTokens, jsonMode } = prompts.recommendationPrompt(candidates, basedOnTitles);
        const response = await client.chat(messages, { maxTokens, jsonMode });
        const parsed = parseJsonResponse(response.content);

        for (const entry of parsed?.reasons ?? []) {
          reasons.set(entry.title, entry.reason);
        }

        await quotaGuard.recordUsage({
          user: userId,
          feature: AI_FEATURE.RECOMMENDATIONS,
          source: AI_SOURCE.LIVE,
          usage: response.usage,
          latencyMs: response.latencyMs,
          model: response.model,
        });
      } catch (error) {
        logger.warn('Recommendation rationale generation failed; using offline text', {
          error: error.message,
        });
      }
    }
  }

  return {
    recommendations: candidates.map((book) => ({
      book,
      reason:
        reasons.get(book.title) ??
        mock.mockRecommendationReason(book, basedOnTitles),
      score: Math.round(book.score * 10) / 10,
      sharedAuthors: book.sharedAuthors,
      sharedCategories: book.sharedCategories,
    })),
    basedOn: basedOnTitles,
    personalised: true,
    // Honest about where the rationales came from.
    source: reasons.size > 0 ? 'ai-explained' : 'heuristic',
  };
};

/* Review moderation */

/**
 * Escalate an ambiguous review to the model.
 */
export const moderateReview = async (review) => {
  if (!config.ai.isFeatureEnabled(AI_FEATURE.REVIEW_MODERATION)) return null;

  const permission = await quotaGuard.canMakeLiveCall(null);
  if (!permission.allowed) return null;

  const startedAt = Date.now();

  try {
    const { messages, maxTokens, jsonMode } = prompts.moderationPrompt(review);
    const response = await client.chat(messages, { maxTokens, jsonMode });
    const parsed = parseJsonResponse(response.content);

    await quotaGuard.recordUsage({
      feature: AI_FEATURE.REVIEW_MODERATION,
      source: AI_SOURCE.LIVE,
      usage: response.usage,
      latencyMs: response.latencyMs,
      model: response.model,
    });

    if (!parsed?.verdict) return null;

    return {
      verdict: parsed.verdict,
      reasons: parsed.reasons ?? [],
      score: parsed.score ?? 0.5,
      usedAi: true,
    };
  } catch (error) {
    await quotaGuard.recordUsage({
      feature: AI_FEATURE.REVIEW_MODERATION,
      source: AI_SOURCE.LIVE,
      success: false,
      errorCode: error.code,
      errorMessage: error.message,
      latencyMs: Date.now() - startedAt,
    });
    return null;
  }
};

/* Metadata enrichment */

/** Suggest categories, tags and a reading level for a book. Librarian-triggered. */
export const suggestMetadata = async (bookId, user) => {
  assertFeatureEnabled(AI_FEATURE.METADATA_ENRICHMENT);

  const book = await loadBook(bookId);
  const { Category } = await import('../models/Category.js');
  const categories = await Category.find({ isDeleted: false }).select('name').lean();

  const result = await generate({
    feature: AI_FEATURE.METADATA_ENRICHMENT,
    book,
    user,
    requireContext: false,
    findCached: null, // suggestions are advisory and should reflect the record as it is now
    buildPrompt: () => prompts.metadataPrompt(book, categories.map((c) => c.name)),
    parseLive: (parsed) => ({
      categories: parsed.categories ?? [],
      tags: parsed.tags ?? [],
      readingLevel: parsed.readingLevel ?? null,
      confidence: parsed.confidence ?? 0.5,
    }),
    buildMock: () => mock.mockMetadataSuggestions(book),
    persist: null,
  });

  return { ...result, book: { id: String(book._id), title: book.title } };
};

/* Administration */

/** Quota, mode and cache status. */
export const getStatus = async () => {
  const status = await quotaGuard.getStatus();
  const statistics = await AiUsageLog.getStatistics();
  const cachedSummaries = await AiSummary.countDocuments();
  const mockSummaries = await AiSummary.countDocuments({ isMock: true });

  return {
    ...status,
    circuitBreaker: client.circuitState(),
    features: config.ai.features,
    cache: {
      entries: cachedSummaries,
      mockEntries: mockSummaries,
      realEntries: cachedSummaries - mockSummaries,
    },
    statistics,
  };
};

/**
 * Reconcile the local call count against the provider's own figure.
 * Run by a cron job, and directly by an administrator.
 */
export const syncUsage = async () => {
  if (!config.ai.hasToken) {
    return { synced: false, reason: 'No AI token configured' };
  }

  const usage = await client.fetchUsage();
  quotaGuard.setUpstreamUsage({
    used: usage.used,
    limit: usage.limit,
    remaining: usage.remaining,
  });

  return { synced: true, ...usage };
};

/**
 * Regenerate mock summaries with real model output.
 */
export const upgradeMockSummaries = async ({ limit = 5 } = {}, user) => {
  const mocks = await AiSummary.find({ isMock: true }).limit(limit).populate('book', 'title');

  const results = [];

  for (const entry of mocks) {
    // Stop as soon as the budget runs out rather than accumulating failures.
    const permission = await quotaGuard.canMakeLiveCall(null);
    if (!permission.allowed) {
      results.push({ book: entry.book?.title, upgraded: false, reason: permission.reason });
      break;
    }

    try {
      const regenerated = await getSummary(
        entry.book?._id ?? entry.book,
        { length: entry.length, language: entry.language, force: true },
        user
      );
      results.push({
        book: entry.book?.title,
        upgraded: regenerated.source === AI_SOURCE.LIVE,
        source: regenerated.source,
      });
    } catch (error) {
      results.push({ book: entry.book?.title, upgraded: false, reason: error.message });
    }
  }

  return { attempted: mocks.length, results };
};

export default {
  getSummary,
  getKeyTakeaways,
  getSimplified,
  askQuestion,
  getRecommendations,
  moderateReview,
  suggestMetadata,
  getStatus,
  syncUsage,
  upgradeMockSummaries,
};
