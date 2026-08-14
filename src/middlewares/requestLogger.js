/**
 * ---------------------------------------------------------------------------
 * HTTP REQUEST LOGGING
 * ---------------------------------------------------------------------------
 * Morgan, piped through winston so HTTP access logs land in the same place
 * and the same format as application logs. Two log systems writing to two
 * destinations makes correlating "the request came in" with "the handler threw"
 * needlessly manual.
 *
 * A custom `:request-id` token ties each access-log line to the application
 * log lines from the same request.
 *
 * Health-check paths are skipped — an uptime monitor polling every 10 seconds
 * would otherwise generate 8,640 lines a day that say nothing.
 * ---------------------------------------------------------------------------
 */

import morgan from 'morgan';
import config from '../config/index.js';
import { httpStream } from '../utils/logger.js';

// Correlates this access-log line with the application logs for the same request.
morgan.token('request-id', (req) => req.id ?? '-');

// Who made the request, when authenticated. Invaluable when reconstructing
// what a specific member did, and cheap to record.
morgan.token('user-id', (req) => req.user?.id ?? '-');

const skipPaths = new Set(config.logger.http.skipPaths);

/** No-op used when HTTP logging is disabled. */
const noopMiddleware = (req, res, next) => next();

export const requestLogger = () => {
  if (!config.logger.http.enabled) return noopMiddleware;

  return morgan(config.logger.http.format, {
    stream: httpStream,
    skip: (req, res) => {
      if (skipPaths.has(req.path)) return true;
      // In production, drop successful static-file hits. Cover images generate
      // enormous volume and tell you nothing; failures still get logged.
      if (config.app.isProduction && req.path.startsWith('/files/') && res.statusCode < 400) {
        return true;
      }
      return false;
    },
  });
};

export default requestLogger;
