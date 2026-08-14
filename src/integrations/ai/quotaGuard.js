/**
 * Decides whether a live API call may be made.
 */

import config from '../../config/index.js';
import logger from '../../utils/logger.js';
import { AiUsageLog } from '../../models/AiUsageLog.js';

/**
 * Cached view of the provider's own usage figures.
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
