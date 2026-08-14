/**
 * ---------------------------------------------------------------------------
 * AI QUOTA GUARD
 * ---------------------------------------------------------------------------
 * Decides whether a live API call may be made.
 *
 * The token allows 100 calls IN TOTAL, for its lifetime. Three checks stand
 * between a request and a spent call:
 *
 *   1. IS THERE A USABLE TOKEN? A missing or placeholder token means no live
 *      call is possible at all.
 *   2. IS THE GLOBAL BUDGET SPENT? Counted from AiUsageLog and reconciled
 *      against the provider's own usage endpoint, with a SAFETY MARGIN so the
 *      last few calls are held in reserve rather than consumed by whoever
 *      happens to click next.
 *   3. HAS THIS MEMBER USED THEIR DAILY SHARE? Without a per-user cap, one
 *      curious member clicking "summarise" repeatedly exhausts the shared
 *      budget for everyone, permanently.
 *
 * When a live call is refused, this returns WHY — so the caller can decide
 * between serving mock content and reporting an error, rather than being told
 * only that something went wrong.
 * ---------------------------------------------------------------------------
 */

import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { AiUsageLog } from '../../models/AiUsageLog.js';

/**
 * Cached view of the provider's own usage figures.
 *
 * Reconciled by a cron job rather than fetched per request — asking the
 * provider "how much is left?" before every call would itself be traffic, and
 * the number changes only when we spend one.
 */
let upstreamUsage = { used: null, limit: null, remaining: null, fetchedAt: null };

export const setUpstreamUsage = (usage) => {
  upstreamUsage = { ...usage, fetchedAt: new Date() };
  // A successful usage call proves the token works — clear any earlier
  // rejection, so replacing a bad key in .env takes effect without a restart.
  tokenRejected = { at: null, message: null };
  logger.info('AI usage reconciled with the provider', usage);
};

export const getUpstreamUsage = () => ({ ...upstreamUsage });

/**
 * Latch recording that the provider rejected our token.
 *
 * Set on the first 401, cleared by a successful usage reconciliation. Without
 * it, every AI request would pay a full network round-trip and a retry cycle
 * to rediscover a fact that will not change until the key does.
 */
let tokenRejected = { at: null, message: null };

export const markTokenRejected = (message = null) => {
  if (tokenRejected.at !== null) return;
  tokenRejected = { at: new Date(), message };
  logger.error(
    'The AI provider rejected our API token. Every AI request will now serve MOCK content until a valid token is configured. ' +
      'Update AI_API_TOKEN in .env, then restart or call POST /api/v1/ai/sync-usage.'
  );
};

export const isTokenRejected = () => tokenRejected.at !== null;
export const clearTokenRejection = () => {
  tokenRejected = { at: null, message: null };
};

/**
 * How many live calls remain.
 *
 * Takes the LOWER of the local count and the provider's own figure. They can
 * disagree — another deployment might share this token, or a call might have
 * failed after being counted upstream — and in a disagreement about a finite
 * budget the pessimistic number is the safe one.
 */
export const getRemaining = async () => {
  const localUsed = await AiUsageLog.liveCallCount();
  const localRemaining = Math.max(0, config.ai.quota.liveCallCeiling - localUsed);

  if (upstreamUsage.remaining === null) {
    return { remaining: localRemaining, used: localUsed, source: 'local' };
  }

  return {
    remaining: Math.min(localRemaining, upstreamUsage.remaining),
    used: Math.max(localUsed, upstreamUsage.used ?? 0),
    source: 'reconciled',
  };
};

/**
 * May a live call be made right now?
 *
 * Returns a decision object rather than throwing, because "no" is frequently
 * the normal path — it means "serve mock content", not "fail the request".
 *
 * @param {string|null} userId Null for system-initiated generation.
 * @returns {Promise<{allowed: boolean, reason?: string, code?: string, remaining: number}>}
 */
export const canMakeLiveCall = async (userId = null) => {
  /* 1. A usable token. */
  if (!config.ai.hasToken) {
    return {
      allowed: false,
      reason: 'No AI API token is configured',
      code: 'tokenMissing',
      remaining: 0,
    };
  }

  /**
   * The provider has already rejected this token.
   *
   * A rejected token will keep being rejected, so retrying costs a full
   * network round-trip plus a retry cycle to rediscover the same fact — on
   * every single request. Latching it means the first failure is the only
   * slow one; everything after goes straight to mock.
   */
  if (tokenRejected.at !== null) {
    return {
      allowed: false,
      reason: `The AI provider rejected this token${tokenRejected.message ? `: ${tokenRejected.message}` : ''}`,
      code: 'tokenRejected',
      remaining: 0,
    };
  }

  /* 2. The global budget. */
  const { remaining, used } = await getRemaining();

  if (remaining <= 0) {
    logger.warn('AI quota exhausted — falling back to cached or mock content', {
      used,
      ceiling: config.ai.quota.liveCallCeiling,
      total: config.ai.quota.total,
    });

    return {
      allowed: false,
      reason: `The AI call budget is exhausted (${used} of ${config.ai.quota.total} used)`,
      code: 'quotaExhausted',
      remaining: 0,
    };
  }

  // Warn as the budget runs down, so it is noticed BEFORE it is gone.
  if (used >= config.ai.quota.total * config.ai.quota.warnAtFraction) {
    logger.warn(`AI budget is ${Math.round((used / config.ai.quota.total) * 100)}% spent`, {
      used,
      total: config.ai.quota.total,
      remaining,
    });
  }

  /* 3. The member's daily share. */
  if (userId) {
    const since = new Date(Date.now() - config.rateLimit.groups.ai.windowMs);
    const userCalls = await AiUsageLog.liveCallCountForUser(userId, since);

    if (userCalls >= config.rateLimit.groups.ai.max) {
      return {
        allowed: false,
        reason: `You have used your ${config.rateLimit.groups.ai.max} AI generations for today`,
        code: 'userLimitReached',
        remaining,
      };
    }
  }

  return { allowed: true, remaining };
};

/**
 * Record an AI request — live, cached OR mock.
 *
 * Logging the free ones matters: without them there is no way to show how much
 * the cache saved, which is the number that justifies the entire design.
 *
 * Never throws. A failure to write a usage row must not fail the request that
 * successfully produced a summary.
 */
export const recordUsage = async ({
  user = null,
  book = null,
  feature,
  source,
  success = true,
  errorCode = null,
  errorMessage = null,
  usage = {},
  latencyMs = 0,
  model = null,
}) => {
  try {
    return await AiUsageLog.create({
      user,
      book,
      feature,
      source,
      success,
      errorCode,
      errorMessage: errorMessage?.slice(0, 300) ?? null,
      promptTokens: usage.promptTokens ?? 0,
      completionTokens: usage.completionTokens ?? 0,
      totalTokens: usage.totalTokens ?? 0,
      latencyMs,
      model,
      promptVersion: config.ai.cache.promptVersion,
    });
  } catch (error) {
    logger.warn('Could not record AI usage', { error: error.message });
    return null;
  }
};

/** Quota status, for the readiness probe and the admin dashboard. */
export const getStatus = async () => {
  const { remaining, used, source } = await getRemaining();

  return {
    // The mode ACTUALLY in force, which may differ from the boot-time mode if
    // the provider has since rejected the token.
    mode: tokenRejected.at !== null ? 'mock' : config.ai.initialMode,
    reason:
      tokenRejected.at !== null
        ? `The AI provider rejected our token${tokenRejected.message ? `: ${tokenRejected.message}` : ''} — serving mock content`
        : config.ai.initialModeReason,
    hasToken: config.ai.hasToken,
    tokenRejected: tokenRejected.at !== null,
    quota: {
      total: config.ai.quota.total,
      used,
      remaining,
      /** Calls held back by the safety margin, reachable only deliberately. */
      reserved: config.ai.quota.total - config.ai.quota.liveCallCeiling,
      countedFrom: source,
    },
    upstream: upstreamUsage.fetchedAt ? upstreamUsage : null,
    perUserDailyLimit: config.rateLimit.groups.ai.max,
    cacheEnabled: config.ai.cache.enabled,
    promptVersion: config.ai.cache.promptVersion,
  };
};

export default {
  canMakeLiveCall,
  recordUsage,
  getRemaining,
  getStatus,
  setUpstreamUsage,
  getUpstreamUsage,
  markTokenRejected,
  isTokenRejected,
  clearTokenRejection,
};
