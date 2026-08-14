/**
 * Builds an express-rate-limit instance from a named group in
 * src/config/rateLimit.js. Routes then read declaratively:
 */

import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

/**
 * Derive the bucket key for a request.
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
 * @param {object} [overrides] Per-route tweaks, e.g. `{ max: 3 }`.
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
