/**
 * ---------------------------------------------------------------------------
 * REQUEST SANITISATION MIDDLEWARE
 * ---------------------------------------------------------------------------
 * Strips MongoDB operator keys (`$gt`), dotted paths (`profile.role`) and
 * prototype-pollution keys (`__proto__`) from incoming request data, before
 * anything downstream can pass them to a query.
 *
 * See src/utils/sanitize.js for why this exists and why it is written by hand
 * rather than pulled from npm — the short version is that Express 5 made
 * `req.query` a getter, which breaks `express-mongo-sanitize` outright.
 *
 * `req.body` and `req.params` are writable and are cleaned IN PLACE.
 * `req.query` is not writable in Express 5, so the cleaned copy is exposed as
 * `req.sanitizedQuery` and the property is redefined to return it — leaving
 * every existing `req.query` reader working, but reading clean data.
 *
 * A stripped key is logged at WARN. Legitimate clients never send `$ne` in a
 * request body, so a hit here is either an attack or a serious bug, and either
 * one is worth knowing about.
 * ---------------------------------------------------------------------------
 */

import { sanitizeInPlace, sanitizeValue } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

export const sanitizeRequest = (req, res, next) => {
  const removed = [];

  // Body and params: writable, so clean in place and preserve object identity.
  if (req.body && typeof req.body === 'object') {
    removed.push(...sanitizeInPlace(req.body).removed);
  }
  if (req.params && typeof req.params === 'object') {
    removed.push(...sanitizeInPlace(req.params).removed);
  }

  // Query: a getter in Express 5. Build a cleaned copy and redefine the
  // property to return it, so `req.query.page` keeps working unchanged.
  if (req.query && typeof req.query === 'object') {
    const report = { removed: [] };
    const cleanQuery = sanitizeValue(req.query, report);
    removed.push(...report.removed);

    req.sanitizedQuery = cleanQuery;

    try {
      Object.defineProperty(req, 'query', {
        value: cleanQuery,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    } catch {
      // If the property is somehow locked down, downstream code can still read
      // req.sanitizedQuery. Never let sanitisation itself break the request.
    }
  }

  if (removed.length > 0) {
    logger.warn('Stripped potentially malicious keys from request', {
      requestId: req.id,
      method: req.method,
      path: req.originalUrl,
      ip: req.ip,
      removedKeys: [...new Set(removed)],
    });
  }

  next();
};

export default sanitizeRequest;
