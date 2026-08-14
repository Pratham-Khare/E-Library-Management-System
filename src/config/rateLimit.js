/**
 * Five independent limiter groups, because one global limit cannot serve
 * competing goals. Browsing the catalogue should be generous; hammering the
 * login endpoint should not be; and burning the shared AI budget should be
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
 * The default store is in-memory, which is correct for a single process but
 * has a real limitation: with N instances behind a load balancer, each keeps
 * its own counters, so the effective limit becomes N × max.
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
