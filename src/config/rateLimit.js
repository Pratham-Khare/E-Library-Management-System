/**
 * ---------------------------------------------------------------------------
 * RATE LIMITING CONFIGURATION
 * ---------------------------------------------------------------------------
 * Five independent limiter groups, because one global limit cannot serve
 * competing goals. Browsing the catalogue should be generous; hammering the
 * login endpoint should not be; and burning the shared AI budget should be
 * strictly rationed per user.
 *
 * Two different KEYS are used, and the distinction matters:
 *
 *   IP-keyed   — for unauthenticated traffic (login, register, search). There
 *                is no user yet, so the IP is the only handle we have.
 *   USER-keyed — for authenticated, expensive actions (uploads, AI). Keying
 *                these by IP would let one person bypass the limit by
 *                switching networks, and would unfairly throttle an entire
 *                campus sharing one NAT address.
 *
 * The limiter middleware factory lives in src/middlewares/rateLimiter.js; this
 * file only describes the policy.
 * ---------------------------------------------------------------------------
 */

import env from './env.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

/** Master switch — set RATE_LIMIT_ENABLED=false to disable all limiters. */
export const enabled = env.RATE_LIMIT_ENABLED;

/** How a limiter derives its bucket key. */
export const KEY_STRATEGY = Object.freeze({
  IP: 'ip',
  /** Authenticated user id, falling back to IP for anonymous callers. */
  USER: 'user',
});

/**
 * Shared response shape for every limiter, so a client sees the same envelope
 * whether it tripped the auth limiter or the AI one.
 */
const limitExceededBody = (message) => ({
  success: false,
  message,
  code: ERROR_CODES.RATE_LIMIT_EXCEEDED,
  errors: [],
});

/**
 * The limiter groups.
 *
 *   windowMs  — length of the sliding window, in milliseconds.
 *   max       — requests permitted per key per window.
 *   keyBy     — IP or USER (see above).
 *   message   — human-readable text returned on 429.
 *   skipSuccessfulRequests — when true, only FAILED attempts count. Used on
 *                            auth so a legitimately busy user is never locked
 *                            out, while a credential-stuffing attacker (whose
 *                            attempts fail) burns the budget immediately.
 */
export const groups = Object.freeze({
  /**
   * GLOBAL — a blanket ceiling applied to every request. Deliberately loose;
   * it exists to stop a single misbehaving client from saturating the process,
   * not to police individual features.
   */
  global: Object.freeze({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    keyBy: KEY_STRATEGY.IP,
    message: 'Too many requests from this address. Please slow down and try again shortly.',
    skipSuccessfulRequests: false,
  }),

  /**
   * AUTH — login, register, forgot-password. The tightest limit in the system,
   * because this is the endpoint an attacker points a stolen credential list
   * at. Only failed attempts count toward the budget.
   */
  auth: Object.freeze({
    windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
    max: env.AUTH_RATE_LIMIT_MAX,
    keyBy: KEY_STRATEGY.IP,
    message:
      'Too many authentication attempts from this address. Please wait a few minutes before trying again.',
    skipSuccessfulRequests: true,
  }),

  /**
   * SEARCH — catalogue search runs text-index queries and $facet aggregations,
   * which are the most database-expensive reads in the app.
   */
  search: Object.freeze({
    windowMs: env.SEARCH_RATE_LIMIT_WINDOW_MS,
    max: env.SEARCH_RATE_LIMIT_MAX,
    keyBy: KEY_STRATEGY.IP,
    message: 'Too many search requests. Please wait a moment before searching again.',
    skipSuccessfulRequests: false,
  }),

  /**
   * UPLOAD — cover images and ebooks. Keyed per user because uploads consume
   * disk, and disk is charged to whoever filled it.
   */
  upload: Object.freeze({
    windowMs: env.UPLOAD_RATE_LIMIT_WINDOW_MS,
    max: env.UPLOAD_RATE_LIMIT_MAX,
    keyBy: KEY_STRATEGY.USER,
    message: 'Upload limit reached for now. Please try again later.',
    skipSuccessfulRequests: false,
  }),

  /**
   * AI — the single most important limit in this application.
   *
   * The shared AI token has a HARD LIFETIME QUOTA OF 100 CALLS. Without a
   * per-user cap, one curious member clicking "summarise" repeatedly would
   * exhaust the budget for everyone, permanently. Five generations per user
   * per day, combined with the persistent summary cache, keeps the budget
   * alive across a real demo.
   *
   * This is the FIRST of three defences; see config/ai.js for the global
   * quota guard and the cache.
   */
  ai: Object.freeze({
    windowMs: env.AI_RATE_LIMIT_WINDOW_MS,
    max: env.AI_RATE_LIMIT_MAX,
    keyBy: KEY_STRATEGY.USER,
    message:
      'You have reached your daily limit for AI generations. Cached summaries remain available, and your limit resets in 24 hours.',
    skipSuccessfulRequests: false,
  }),
});

/**
 * Options common to every limiter instance.
 *
 * standardHeaders sends the modern RateLimit-* headers so a client can see how
 * much budget is left; legacyHeaders (X-RateLimit-*) are switched off to avoid
 * sending both.
 */
export const defaults = Object.freeze({
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

/** Builds the JSON body returned when a group's limit is exceeded. */
export const buildLimitResponse = (groupName) =>
  limitExceededBody(groups[groupName]?.message ?? 'Too many requests.');

/**
 * STORE NOTE — multi-instance deployments
 * --------------------------------------
 * The default store is in-memory, which is correct for a single process but
 * has a real limitation: with N instances behind a load balancer, each keeps
 * its own counters, so the effective limit becomes N × max.
 *
 * Swapping in a shared store is a one-line change here and one dependency,
 * with no other code touched:
 *
 *     import { RedisStore } from 'rate-limit-redis';
 *     export const store = new RedisStore({ sendCommand: (...args) => redis.call(...args) });
 *
 * Left in-memory deliberately: this deployment is single-instance, and adding
 * Redis would mean adding infrastructure that buys nothing today.
 */
export const store = undefined;

export default Object.freeze({
  enabled,
  groups,
  defaults,
  KEY_STRATEGY,
  buildLimitResponse,
  store,
});
