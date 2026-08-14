/**
 * ---------------------------------------------------------------------------
 * LOGGING CONFIGURATION
 * ---------------------------------------------------------------------------
 * Describes HOW logging behaves; the winston instance itself is built in
 * src/utils/logger.js. Keeping the two apart means the logger can import this
 * without config/index.js importing the logger, which would be a cycle.
 *
 * Two output shapes:
 *   development — colourised, human-readable single lines for a terminal.
 *   production  — structured JSON, so a log aggregator can index the fields.
 *
 * REDACTION is the security-relevant part. Passwords, tokens and API keys pass
 * through request bodies constantly; without an explicit deny-list they end up
 * in plaintext in a log file that is far less protected than the database.
 * ---------------------------------------------------------------------------
 */

import path from 'node:path';
import env, { ROOT_DIR } from './env.js';

/**
 * Severity levels, most to least severe. Setting LOG_LEVEL=info emits error,
 * warn and info but suppresses http and debug.
 */
export const levels = Object.freeze({
  error: 0,
  warn: 1,
  info: 2,
  http: 3,
  debug: 4,
});

/** Terminal colours per level. */
export const colors = Object.freeze({
  error: 'red',
  warn: 'yellow',
  info: 'green',
  http: 'magenta',
  debug: 'blue',
});

export const level = env.LOG_LEVEL;

/** JSON in production for machine parsing; pretty lines in development. */
export const format = env.NODE_ENV === 'production' ? 'json' : 'pretty';

/** Include a full stack trace on Error objects. */
export const includeStack = true;

/* ===========================================================================
 * File transports
 * ======================================================================== */

export const files = Object.freeze({
  enabled: env.LOG_TO_FILE,
  directory: path.resolve(ROOT_DIR, env.LOG_DIR),
  /** Everything at the configured level and above. */
  combined: path.resolve(ROOT_DIR, env.LOG_DIR, 'combined.log'),
  /** Errors only, so a production incident does not mean grepping gigabytes. */
  error: path.resolve(ROOT_DIR, env.LOG_DIR, 'error.log'),
  /** Rotate at 10MB, keep 5 generations. */
  maxSizeBytes: 10 * 1024 * 1024,
  maxFiles: 5,
  /** Do not let a logging failure crash the process. */
  handleExceptions: true,
  handleRejections: true,
});

/* ===========================================================================
 * HTTP request logging (morgan)
 * ======================================================================== */

export const http = Object.freeze({
  enabled: env.LOG_HTTP_REQUESTS,
  /** Custom morgan format including our request id and response time. */
  format:
    env.NODE_ENV === 'production'
      ? ':remote-addr :method :url :status :res[content-length] - :response-time ms :request-id'
      : ':method :url :status :response-time ms - :res[content-length] :request-id',
  /**
   * Health and metrics endpoints are polled constantly by uptime checks and
   * would otherwise drown out real traffic.
   */
  skipPaths: Object.freeze(['/health', '/health/ready', '/favicon.ico']),
});

/* ===========================================================================
 * Redaction
 * ======================================================================== */

/**
 * Keys whose values are replaced with '[REDACTED]' anywhere they appear in a
 * logged object, at any depth. Matching is case-insensitive.
 *
 * This list is deliberately broad. The cost of redacting something harmless is
 * a slightly less useful log line; the cost of missing something is a password
 * sitting in plaintext on disk.
 */
export const redactKeys = Object.freeze([
  'password',
  'newPassword',
  'oldPassword',
  'currentPassword',
  'confirmPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'resetToken',
  'downloadToken',
  'tokenHash',
  'authorization',
  'cookie',
  'setCookie',
  'apiKey',
  'api_key',
  'secret',
  'clientSecret',
  'sendgridApiKey',
  'AI_API_TOKEN',
  'SENDGRID_API_KEY',
  'creditCard',
  'cvv',
]);

export const redactedPlaceholder = '[REDACTED]';

/**
 * Fields removed from logged request bodies entirely rather than redacted,
 * because they are large and never diagnostically useful.
 */
export const dropKeys = Object.freeze(['extractedText', 'fileBuffer', 'buffer']);

/** Truncate any single logged string beyond this length. */
export const maxStringLength = 2000;

export default Object.freeze({
  levels,
  colors,
  level,
  format,
  includeStack,
  files,
  http,
  redactKeys,
  redactedPlaceholder,
  dropKeys,
  maxStringLength,
});
