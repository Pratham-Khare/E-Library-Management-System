/**
 * Strips MongoDB operator keys (`$gt`), dotted paths (`profile.role`) and
 * prototype-pollution keys (`__proto__`) from incoming request data, before
 * anything downstream can pass them to a query.
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
