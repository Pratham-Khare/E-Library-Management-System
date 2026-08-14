/**
 * ---------------------------------------------------------------------------
 * RATE LIMITER FACTORY
 * ---------------------------------------------------------------------------
 * Builds an express-rate-limit instance from a named group in
 * src/config/rateLimit.js. Routes then read declaratively:
 *
 *     router.post('/login',   rateLimiter('auth'),   login);
 *     router.get('/search',   rateLimiter('search'), search);
 *     router.post('/summary', rateLimiter('ai'),     generateSummary);
 *
 * The policy lives in config; this file only knows how to apply it.
 *
 * THE KEY STRATEGY IS THE INTERESTING PART. Limiters key on IP or on user id,
 * and picking wrong breaks the limit in one of two directions:
 *
 *   IP-keyed for authenticated actions — a whole college behind one NAT
 *   address shares a single bucket, so one heavy user throttles everyone;
 *   meanwhile the person you actually wanted to limit just switches networks.
 *
 *   USER-keyed for unauthenticated actions — impossible. There is no user yet
 *   on a login attempt, which is exactly when limiting matters most.
 *
 * So: anonymous endpoints key on IP, authenticated expensive ones key on user.
 * ---------------------------------------------------------------------------
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

/**
 * Derive the bucket key for a request.
 *
 * `ipKeyGenerator` from express-rate-limit is used rather than `req.ip`
 * directly because it normalises IPv6 properly. An IPv6 client is typically
 * handed an entire /56 or /64 range and can mint a fresh address per
 * connection, so keying on the raw address would let them bypass the limiter
 * indefinitely. The helper collapses the range down to one key:
 *
 *     2001:db8:85a3:8d3:1319:8a2e:370:7348  ->  2001:db8:85a3:800::/56
 *
 * IPv4 addresses pass through unchanged.
 */
const buildKeyGenerator = (strategy) => {
  if (strategy === config.rateLimit.KEY_STRATEGY.USER) {
    return (req) =>
      // Authenticated: key on the user. Falls back to IP for a request that
      // somehow reaches a user-keyed limiter before authentication.
      req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`;
  }
  return (req) => `ip:${ipKeyGenerator(req.ip)}`;
};

/**
 * Called when a limit is exceeded. Logged at WARN because a tripped limiter is
 * either an attack, a runaway client, or a limit set too low — all three are
 * worth seeing.
 */
const buildLimitHandler = (groupName) => (req, res) => {
  logger.warn('Rate limit exceeded', {
    requestId: req.id,
    group: groupName,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
    userId: req.user?.id ?? null,
  });

  const body = config.rateLimit.buildLimitResponse(groupName);
  if (req.id) body.requestId = req.id;

  return res.status(HTTP_STATUS.TOO_MANY_REQUESTS).json(body);
};

/** Pass-through middleware, used when rate limiting is switched off entirely. */
const noopMiddleware = (req, res, next) => next();

/**
 * Build a rate-limiting middleware for a configured group.
 *
 * @param {'global'|'auth'|'search'|'upload'|'ai'} groupName
 * @param {object} [overrides] Per-route tweaks, e.g. `{ max: 3 }`.
 * @returns {import('express').RequestHandler}
 */
export const rateLimiter = (groupName, overrides = {}) => {
  if (!config.rateLimit.enabled) return noopMiddleware;

  const group = config.rateLimit.groups[groupName];
  if (!group) {
    // A typo in a group name would otherwise silently leave a route unlimited.
    // Fail at startup, when it is cheap to notice.
    throw new Error(
      `Unknown rate limit group '${groupName}'. Valid groups: ${Object.keys(config.rateLimit.groups).join(', ')}`
    );
  }

  return rateLimit({
    ...config.rateLimit.defaults,
    windowMs: overrides.windowMs ?? group.windowMs,
    limit: overrides.max ?? group.max,
    keyGenerator: buildKeyGenerator(overrides.keyBy ?? group.keyBy),
    handler: buildLimitHandler(groupName),
    skipSuccessfulRequests: overrides.skipSuccessfulRequests ?? group.skipSuccessfulRequests,
    store: config.rateLimit.store,

    /**
     * Staff are exempt from the AI and upload limits. A librarian bulk-loading
     * a term's acquisitions should not be throttled by a limit designed to stop
     * one member burning the shared AI budget. The auth and global limiters
     * deliberately have no exemption — those protect the system itself.
     */
    skip: (req) => {
      if (overrides.skip) return overrides.skip(req);
      const exemptGroups = ['ai', 'upload'];
      return exemptGroups.includes(groupName) && ['LIBRARIAN', 'ADMIN'].includes(req.user?.role);
    },
  });
};

/** The blanket limiter mounted once in app.js, before any route. */
export const globalRateLimiter = () => rateLimiter('global');

export default rateLimiter;
