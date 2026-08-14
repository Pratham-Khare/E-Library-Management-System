/**
 * The supplied API token has a HARD LIFETIME QUOTA OF 100 CALLS.
 */

import env from './env.js';
import { AI_FEATURE, AI_LENGTH_WORD_TARGET } from '../constants/enums.js';

/* Upstream connection */

/**
 * The upstream proxies OpenAI's chat completions API with the same request and
 * response shape, but locks the model and caps max_tokens.
 */
export const api = Object.freeze({
  baseUrl: env.AI_API_BASE_URL.replace(/\/+$/, ''),
  /** Chat completions. Body matches openai.chat.completions.create(). */
  chatPath: '/v1/chat/completions',
  /** Reports this token's own quota: { email, used, limit, remaining }. */
  usagePath: '/v1/usage',
  /** Liveness probe. No auth required. */
  healthPath: '/health',
  token: env.AI_API_TOKEN,
  /** Locked upstream — any other model returns 404 model_not_found. */
  model: env.AI_MODEL,
  /** Upstream clamps to 5000; env.js enforces the same ceiling. */
  maxTokens: env.AI_MAX_TOKENS,
  /** Low temperature keeps summaries factual rather than imaginative. */
  temperature: env.AI_TEMPERATURE,
  timeoutMs: env.AI_TIMEOUT_MS,
});

/**
 * A token is considered absent if it is blank or still the placeholder from
 * .env.example. Treating the placeholder as "no token" is what lets someone
 * clone the repo, run `npm run dev`, and have every AI endpoint work in mock
 * mode without touching configuration first.
 */
const PLACEHOLDER_TOKENS = ['sk-your-token-here', 'your-token-here', 'changeme', 'replace-me'];

export const hasToken = Boolean(
  api.token && api.token.trim() !== '' && !PLACEHOLDER_TOKENS.includes(api.token.trim().toLowerCase())
);

/* Retry & circuit breaker */

/**
 * Retries apply ONLY to failures that might succeed on a second attempt —
 * network errors, timeouts, 5xx, and the upstream's `passthrough` errors.
 */
export const retry = Object.freeze({
  maxAttempts: env.AI_MAX_RETRIES,
  baseDelayMs: env.AI_RETRY_BASE_DELAY_MS,
  /** Exponential: delay = baseDelay × 2^attempt, plus jitter. */
  factor: 2,
  /** Randomised ±25% so concurrent retries do not synchronise into a spike. */
  jitterRatio: 0.25,
  retryableStatuses: Object.freeze([408, 500, 502, 503, 504]),
});

/**
 * Circuit breaker. Once the upstream has failed `failureThreshold` times in a
 * row the circuit opens and requests fail fast for `resetTimeoutMs` instead of
 * each waiting out the full 30-second timeout. One probe request is allowed
 * through after the cooldown to test recovery.
 */
export const circuitBreaker = Object.freeze({
  enabled: true,
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
});

/* Quota management */

export const quota = Object.freeze({
  /** Lifetime calls this deployment may spend. */
  total: env.AI_TOTAL_QUOTA,
  /**
   * Stop making LIVE calls once this fraction of the quota is spent, keeping a
   * reserve for staff and demos. 0.9 of 100 means live calls stop at 90 and
   * the remaining 10 are only reachable by explicitly raising the threshold.
   */
  safetyThreshold: env.AI_QUOTA_SAFETY_THRESHOLD,
  /** Calls permitted before the safety brake engages. */
  get liveCallCeiling() {
    return Math.floor(env.AI_TOTAL_QUOTA * env.AI_QUOTA_SAFETY_THRESHOLD);
  },
  /** Warn in the logs once usage crosses this fraction. */
  warnAtFraction: 0.75,
});

/* Caching */

export const cache = Object.freeze({
  enabled: env.AI_CACHE_ENABLED,
  /**
   * Part of the cache key. Bumping it invalidates every cached summary at
   * once — the deliberate way to roll out an improved prompt without stale
   * output lingering. Edit a prompt template, bump this, redeploy.
   */
  promptVersion: env.AI_PROMPT_VERSION,
  /** Default content language. Also part of the cache key. */
  defaultLanguage: 'en',
  /**
   * Q&A answers are cached against a normalised question hash, so the same
   * question asked by different members costs one call in total.
   */
  cacheQuestionAnswers: true,
});

/* Mock mode */

export const MOCK_MODES = Object.freeze({
  /** Mock only when a live call is impossible. Recommended. */
  AUTO: 'auto',
  /** Never touch the network. Offline development and zero-cost demos. */
  ALWAYS: 'always',
  /** Fail loudly instead of mocking. Correct for production. */
  NEVER: 'never',
});

export const mock = Object.freeze({
  mode: env.AI_MOCK_MODE,

  /** True when every request should be mocked regardless of token state. */
  get alwaysMock() {
    return env.AI_MOCK_MODE === MOCK_MODES.ALWAYS;
  },

  /** True when mocking is forbidden and failures should surface as errors. */
  get neverMock() {
    return env.AI_MOCK_MODE === MOCK_MODES.NEVER;
  },

  /**
   * Should the mock provider handle this situation?
   */
  shouldMock(reason = {}) {
    if (this.alwaysMock) return true;
    if (this.neverMock) return false;
    return Boolean(reason.tokenMissing || reason.tokenRejected || reason.quotaExhausted);
  },
});

/**
 * Resolved operating mode at boot, surfaced by GET /health/ready so it is
 * never a mystery whether responses are real.
 *   'mock' — every AI response will be generated offline
 *   'live' — real calls will be attempted
 */
export const initialMode = mock.alwaysMock || !hasToken ? 'mock' : 'live';

/**
 * Human-readable explanation of `initialMode`, logged once at startup and
 * returned by the readiness probe.
 */
export const initialModeReason = (() => {
  if (mock.alwaysMock) return 'AI_MOCK_MODE=always — no network calls will be made';
  if (!hasToken && mock.neverMock)
    return 'AI_API_TOKEN is not set and AI_MOCK_MODE=never — AI endpoints will return errors';
  if (!hasToken) return 'AI_API_TOKEN is not set — serving deterministic mock responses';
  return `Live calls enabled against ${api.model} (budget: ${quota.total} calls)`;
})();

/* Feature flags */

/**
 * Individual AI capabilities can be switched off to conserve quota. A disabled
 * feature returns 501 with AI_FEATURE_DISABLED rather than silently doing
 * nothing, so the caller knows the difference between "off" and "broken".
 */
export const features = Object.freeze({
  [AI_FEATURE.SUMMARY]: env.AI_FEATURE_SUMMARY,
  [AI_FEATURE.KEY_TAKEAWAYS]: env.AI_FEATURE_KEY_TAKEAWAYS,
  [AI_FEATURE.SIMPLIFIED]: env.AI_FEATURE_SIMPLIFIED,
  [AI_FEATURE.QA]: env.AI_FEATURE_QA,
  [AI_FEATURE.RECOMMENDATIONS]: env.AI_FEATURE_RECOMMENDATIONS,
  [AI_FEATURE.REVIEW_MODERATION]: env.AI_FEATURE_REVIEW_MODERATION,
  [AI_FEATURE.METADATA_ENRICHMENT]: env.AI_FEATURE_METADATA_ENRICHMENT,
});

export const isFeatureEnabled = (feature) => features[feature] === true;

/* Prompt inputs */

export const prompt = Object.freeze({
  /**
   * Characters of extracted ebook text fed into a prompt. Caps token spend on
   * a 600-page book; beyond this the text is truncated at a sentence boundary.
   */
  maxInputChars: env.AI_MAX_INPUT_CHARS,
  /** Approximate word budget per requested length. */
  wordTargets: AI_LENGTH_WORD_TARGET,
  /**
   * Minimum source material required before a call is worth making. Below
   * this we return AI_INSUFFICIENT_CONTEXT rather than spend a call
   * hallucinating from a one-line description.
   */
  minContextChars: 40,
  /** Ask the model for JSON so responses can be parsed rather than scraped. */
  requestJsonOutput: true,
});

export default Object.freeze({
  api,
  hasToken,
  retry,
  circuitBreaker,
  quota,
  cache,
  mock,
  MOCK_MODES,
  initialMode,
  initialModeReason,
  features,
  isFeatureEnabled,
  prompt,
});
