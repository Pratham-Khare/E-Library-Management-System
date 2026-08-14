/**
 * The single object the rest of the application imports:
 */

import env, { ROOT_DIR } from './env.js';
import database from './database.js';
import jwt from './jwt.js';
import rateLimit from './rateLimit.js';
import library from './library.js';
import ai from './ai.js';
import upload from './upload.js';
import mail from './mail.js';
import logger from './logger.js';
import swagger from './swagger.js';

/* Application */

export const app = Object.freeze({
  name: env.APP_NAME,
  env: env.NODE_ENV,
  isDevelopment: env.NODE_ENV === 'development',
  isProduction: env.NODE_ENV === 'production',
  isTest: env.NODE_ENV === 'test',

  port: env.PORT,
  host: env.HOST,
  /** Everything versioned mounts here, e.g. /api/v1/books. */
  apiPrefix: env.API_PREFIX,
  /** Public base URL, used to build absolute links in emails. */
  url: env.APP_URL.replace(/\/+$/, ''),

  /**
   * Number of proxies in front of the app. Express's `trust proxy` uses this
   * to pick the real client IP out of X-Forwarded-For. Getting it wrong breaks
   * rate limiting in one of two ways: too low and every request appears to
   * come from the proxy (one shared bucket for everyone); too high and a
   */
  trustProxy: env.TRUST_PROXY,

  /** Max request body size. A guard against memory-exhaustion payloads. */
  bodyLimit: env.BODY_LIMIT,

  /** Seconds to let in-flight requests finish on SIGTERM before forcing exit. */
  shutdownTimeoutSeconds: env.SHUTDOWN_TIMEOUT_SECONDS,

  /** Absolute project root, for resolving paths without __dirname games. */
  rootDir: ROOT_DIR,

  version: '1.0.0',
});

/* CORS */

export const cors = Object.freeze({
  origins: env.CORS_ORIGINS,
  credentials: env.CORS_CREDENTIALS,
  /** '*' is permitted in development only — env.js rejects it in production. */
  allowAnyOrigin: env.CORS_ORIGINS.includes('*'),
  methods: Object.freeze(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']),
  allowedHeaders: Object.freeze([
    'Content-Type',
    'Authorization',
    'X-Request-Id',
    'Range', // required by the ebook streaming reader
  ]),
  /** Headers a browser client is allowed to read off the response. */
  exposedHeaders: Object.freeze([
    'X-Request-Id',
    'Content-Range',
    'Accept-Ranges',
    'Content-Disposition',
    'RateLimit-Limit',
    'RateLimit-Remaining',
    'RateLimit-Reset',
  ]),
  maxAge: 86400, // cache the preflight for a day
});

/* Bootstrap admin */

/**
 * On first boot, if the database holds zero ADMIN accounts, one is created
 * from these values. Idempotent — once any admin exists it never runs again.
 */
export const bootstrapAdmin = Object.freeze({
  enabled: env.BOOTSTRAP_ADMIN_ENABLED,
  name: env.BOOTSTRAP_ADMIN_NAME,
  email: env.BOOTSTRAP_ADMIN_EMAIL,
  password: env.BOOTSTRAP_ADMIN_PASSWORD,
});

/* Scheduled jobs */

/**
 * node-cron schedules. Set CRON_ENABLED=false to disable every background job
 * — necessary when running multiple instances, where only one should be doing
 * scheduled writes.
 */
export const cron = Object.freeze({
  enabled: env.CRON_ENABLED,
  timezone: env.CRON_TIMEZONE,

  jobs: Object.freeze({
    /** Mark loans OVERDUE and accrue fines. Daily, just after midnight. */
    overdueCheck: env.CRON_OVERDUE_CHECK,
    /** "Due soon" reminders, DUE_REMINDER_DAYS_BEFORE ahead. Daily, 09:00. */
    dueReminder: env.CRON_DUE_REMINDER,
    /** Expire digital loans past their term and release licences. Hourly. */
    digitalExpiry: env.CRON_DIGITAL_EXPIRY,
    /** Reconcile the local AI call count against upstream /v1/usage. */
    aiUsageSync: env.CRON_AI_USAGE_SYNC,
    /** Purge expired tokens and old read notifications. Daily, 03:00. */
    cleanup: env.CRON_CLEANUP,
  }),

  /** Retention windows used by the cleanup job. */
  retention: Object.freeze({
    readNotificationDays: 90,
    auditLogDays: 365,
    aiUsageLogDays: 365,
  }),
});

/* Pagination */

export const pagination = Object.freeze({
  defaultPage: 1,
  defaultLimit: library.catalog.defaultPageSize,
  /** Hard ceiling on `?limit=`, so nobody can request an entire collection. */
  maxLimit: library.catalog.maxPageSize,
});

/* The aggregate */

const config = Object.freeze({
  app,
  cors,
  bootstrapAdmin,
  cron,
  pagination,
  database,
  jwt,
  rateLimit,
  library,
  ai,
  upload,
  mail,
  logger,
  swagger,
  /** Raw validated env, for the rare case a value has no home above. */
  env,
});

export {
  database,
  jwt,
  rateLimit,
  library,
  ai,
  upload,
  mail,
  logger,
  swagger,
  env,
};

export default config;
