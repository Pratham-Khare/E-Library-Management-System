/**
 * This is the ONLY file in the entire codebase that reads `process.env`.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

/** Absolute path to the project root (two levels up from src/config). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Load .env from the project root. `override: false` means a variable already
// present in the real environment (e.g. injected by a hosting platform) wins
// over the file — which is what you want in production.
dotenv.config({ path: path.join(ROOT_DIR, '.env'), override: false });

/* Reusable coercion helpers */

/**
 * Parses the many ways a human writes "yes" in an env file.
 * Accepts: true/false, 1/0, yes/no, on/off (any casing).
 */
const boolish = (defaultValue) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === '') return defaultValue;
      if (typeof value === 'boolean') return value;
      const normalised = String(value).trim().toLowerCase();
      if (['true', '1', 'yes', 'y', 'on'].includes(normalised)) return true;
      if (['false', '0', 'no', 'n', 'off'].includes(normalised)) return false;
      return value; // let Zod reject it with a clear message
    }, z.boolean())
    .describe('boolean');

/** A positive integer with a default, e.g. a port or a timeout in ms. */
const intWithDefault = (defaultValue, { min, max } = {}) => {
  let schema = z.coerce.number().int();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess((v) => (v === undefined || v === '' ? defaultValue : v), schema);
};

/** A float with a default, e.g. AI temperature. */
const floatWithDefault = (defaultValue, { min, max } = {}) => {
  let schema = z.coerce.number();
  if (min !== undefined) schema = schema.min(min);
  if (max !== undefined) schema = schema.max(max);
  return z.preprocess((v) => (v === undefined || v === '' ? defaultValue : v), schema);
};

/** A string with a default applied when the key is absent OR blank. */
const strWithDefault = (defaultValue) =>
  z.preprocess((v) => (v === undefined || v === '' ? defaultValue : v), z.string());

/** An optional string that normalises blank/whitespace to undefined. */
const optionalStr = () =>
  z.preprocess((v) => {
    if (v === undefined) return undefined;
    const trimmed = String(v).trim();
    return trimmed === '' ? undefined : trimmed;
  }, z.string().optional());

/** Comma-separated list -> trimmed string array, blanks removed. */
const csvList = (defaultValue = []) =>
  z.preprocess((v) => {
    if (v === undefined || v === '') return defaultValue;
    if (Array.isArray(v)) return v;
    return String(v)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }, z.array(z.string()));

/**
 * A duration accepted by the `ms` package and by jsonwebtoken's expiresIn,
 * e.g. "15m", "7d", "30s". Also allows a bare number of seconds.
 */
const duration = (defaultValue) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? defaultValue : String(v).trim()),
    z.string().regex(/^\d+(\.\d+)?\s*(ms|s|m|h|d|w|y)?$/i, {
      message: 'must be a duration like "15m", "7d", "30s", or a number of milliseconds',
    })
  );

/**
 * A cron expression. Deliberately permissive — node-cron does the real
 * validation at registration time. This only catches obvious typos such as
 * the wrong number of fields.
 */
const cron = (defaultValue) =>
  z.preprocess(
    (v) => (v === undefined || v === '' ? defaultValue : String(v).trim()),
    z.string().refine((value) => {
      const fields = value.split(/\s+/).length;
      return fields === 5 || fields === 6;
    }, 'must be a cron expression with 5 or 6 space-separated fields')
  );

/**
 * A secret that must be present and long enough to be worth calling a secret.
 * 32 characters is the floor for an HMAC-SHA256 signing key.
 */
const secret = (label) =>
  z
    .string({ required_error: `${label} is required` })
    .min(32, `${label} must be at least 32 characters — generate one with: node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`);

/* The schema */

const envSchema = z
  .object({
    /* --- 1. Application ---------------------------------------------- */
    NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
    PORT: intWithDefault(5000, { min: 1, max: 65535 }),
    HOST: strWithDefault('0.0.0.0'),
    API_PREFIX: strWithDefault('/api/v1'),
    APP_NAME: strWithDefault('E-Library Management System'),
    APP_URL: strWithDefault('http://localhost:5000'),
    TRUST_PROXY: intWithDefault(0, { min: 0, max: 10 }),
    BODY_LIMIT: strWithDefault('1mb'),
    SHUTDOWN_TIMEOUT_SECONDS: intWithDefault(10, { min: 0, max: 300 }),

    /* --- 2. Database -------------------------------------------------- */
    MONGO_URI: z
      .string({ required_error: 'MONGO_URI is required' })
      .min(1, 'MONGO_URI cannot be empty')
      .refine(
        (value) => value.startsWith('mongodb://') || value.startsWith('mongodb+srv://'),
        'MONGO_URI must start with mongodb:// or mongodb+srv://'
      ),
    MONGO_DB_NAME: z
      .string({ required_error: 'MONGO_DB_NAME is required' })
      .min(1, 'MONGO_DB_NAME cannot be empty')
      .regex(/^[^/\\. "$*<>:|?]+$/, 'MONGO_DB_NAME contains characters MongoDB does not allow'),
    MONGO_MAX_POOL_SIZE: intWithDefault(10, { min: 1, max: 500 }),
    MONGO_MIN_POOL_SIZE: intWithDefault(2, { min: 0, max: 500 }),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: intWithDefault(10000, { min: 1000 }),
    MONGO_SOCKET_TIMEOUT_MS: intWithDefault(45000, { min: 1000 }),
    MONGO_DEBUG: boolish(false),

    /* --- 3. Authentication -------------------------------------------- */
    JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
    JWT_ACCESS_EXPIRES_IN: duration('15m'),
    JWT_REFRESH_SECRET: secret('JWT_REFRESH_SECRET'),
    JWT_REFRESH_EXPIRES_IN: duration('7d'),
    JWT_RESET_SECRET: secret('JWT_RESET_SECRET'),
    JWT_RESET_EXPIRES_IN: duration('30m'),
    JWT_DOWNLOAD_EXPIRES_IN: duration('5m'),
    JWT_ISSUER: strWithDefault('e-library-api'),
    JWT_AUDIENCE: strWithDefault('e-library-client'),
    BCRYPT_SALT_ROUNDS: intWithDefault(10, { min: 4, max: 15 }),

    /* --- 4. Bootstrap admin ------------------------------------------- */
    BOOTSTRAP_ADMIN_ENABLED: boolish(true),
    BOOTSTRAP_ADMIN_NAME: strWithDefault('Library Administrator'),
    BOOTSTRAP_ADMIN_EMAIL: strWithDefault('admin@elibrary.local').pipe(z.string().email('BOOTSTRAP_ADMIN_EMAIL must be a valid email address')),
    BOOTSTRAP_ADMIN_PASSWORD: strWithDefault('Admin@12345').pipe(z.string().min(8, 'BOOTSTRAP_ADMIN_PASSWORD must be at least 8 characters')),

    /* --- 5. Rate limiting --------------------------------------------- */
    RATE_LIMIT_ENABLED: boolish(true),
    RATE_LIMIT_WINDOW_MS: intWithDefault(900000, { min: 1000 }),
    RATE_LIMIT_MAX: intWithDefault(300, { min: 1 }),
    AUTH_RATE_LIMIT_WINDOW_MS: intWithDefault(900000, { min: 1000 }),
    AUTH_RATE_LIMIT_MAX: intWithDefault(10, { min: 1 }),
    SEARCH_RATE_LIMIT_WINDOW_MS: intWithDefault(60000, { min: 1000 }),
    SEARCH_RATE_LIMIT_MAX: intWithDefault(60, { min: 1 }),
    UPLOAD_RATE_LIMIT_WINDOW_MS: intWithDefault(3600000, { min: 1000 }),
    UPLOAD_RATE_LIMIT_MAX: intWithDefault(20, { min: 1 }),
    AI_RATE_LIMIT_WINDOW_MS: intWithDefault(86400000, { min: 1000 }),
    AI_RATE_LIMIT_MAX: intWithDefault(5, { min: 1 }),

    /* --- 6. CORS ------------------------------------------------------- */
    CORS_ORIGINS: csvList(['http://localhost:3000', 'http://localhost:5173']),
    CORS_CREDENTIALS: boolish(true),

    /* --- 7. AI service ------------------------------------------------- */
    AI_API_BASE_URL: strWithDefault('https://ai-api.userfacet.com').pipe(z.string().url('AI_API_BASE_URL must be a valid URL')),
    AI_API_TOKEN: optionalStr(),
    AI_MODEL: strWithDefault('gpt-4o-mini'),
    AI_MAX_TOKENS: intWithDefault(1000, { min: 1, max: 5000 }), // upstream hard-caps at 5000
    AI_TEMPERATURE: floatWithDefault(0.4, { min: 0, max: 2 }),
    AI_TIMEOUT_MS: intWithDefault(30000, { min: 1000 }),
    AI_MAX_RETRIES: intWithDefault(2, { min: 0, max: 5 }),
    AI_RETRY_BASE_DELAY_MS: intWithDefault(500, { min: 0 }),
    AI_MOCK_MODE: z.enum(['auto', 'always', 'never']).default('auto'),
    AI_TOTAL_QUOTA: intWithDefault(100, { min: 0 }),
    AI_QUOTA_SAFETY_THRESHOLD: floatWithDefault(0.9, { min: 0, max: 1 }),
    AI_CACHE_ENABLED: boolish(true),
    AI_PROMPT_VERSION: strWithDefault('v1'),
    AI_MAX_INPUT_CHARS: intWithDefault(12000, { min: 100 }),
    AI_FEATURE_SUMMARY: boolish(true),
    AI_FEATURE_KEY_TAKEAWAYS: boolish(true),
    AI_FEATURE_SIMPLIFIED: boolish(true),
    AI_FEATURE_QA: boolish(true),
    AI_FEATURE_RECOMMENDATIONS: boolish(true),
    AI_FEATURE_REVIEW_MODERATION: boolish(true),
    AI_FEATURE_METADATA_ENRICHMENT: boolish(true),

    /* --- 8. Library policy --------------------------------------------- */
    LOAN_PERIOD_DAYS_PUBLIC: intWithDefault(14, { min: 1, max: 365 }),
    LOAN_PERIOD_DAYS_STUDENT: intWithDefault(21, { min: 1, max: 365 }),
    LOAN_PERIOD_DAYS_FACULTY: intWithDefault(30, { min: 1, max: 365 }),
    MAX_ACTIVE_LOANS_PUBLIC: intWithDefault(3, { min: 1, max: 100 }),
    MAX_ACTIVE_LOANS_STUDENT: intWithDefault(5, { min: 1, max: 100 }),
    MAX_ACTIVE_LOANS_FACULTY: intWithDefault(8, { min: 1, max: 100 }),
    MAX_RENEWALS_PUBLIC: intWithDefault(2, { min: 0, max: 20 }),
    MAX_RENEWALS_STUDENT: intWithDefault(2, { min: 0, max: 20 }),
    MAX_RENEWALS_FACULTY: intWithDefault(2, { min: 0, max: 20 }),
    FINE_GRACE_DAYS: intWithDefault(2, { min: 0, max: 30 }),
    FINE_PER_DAY: floatWithDefault(5, { min: 0 }),
    FINE_MAX_PER_LOAN: floatWithDefault(500, { min: 0 }),
    FINE_BLOCK_BORROWING_ABOVE: floatWithDefault(200, { min: 0 }),
    FINE_CURRENCY: strWithDefault('INR').pipe(z.string().length(3, 'FINE_CURRENCY must be a 3-letter ISO 4217 code')),
    DIGITAL_LOAN_DAYS: intWithDefault(7, { min: 1, max: 365 }),
    DIGITAL_DEFAULT_CONCURRENT_LICENSES: intWithDefault(3, { min: 1, max: 1000 }),
    DUE_REMINDER_DAYS_BEFORE: intWithDefault(3, { min: 0, max: 30 }),
    BLOCK_BORROWING_WHEN_OVERDUE: boolish(true),

    /* --- 9. File uploads ----------------------------------------------- */
    STORAGE_PROVIDER: z.enum(['local', 's3']).default('local'),
    STORAGE_ROOT: strWithDefault('storage'),
    MAX_COVER_SIZE_MB: intWithDefault(5, { min: 1, max: 100 }),
    MAX_EBOOK_SIZE_MB: intWithDefault(50, { min: 1, max: 2048 }),
    MAX_AVATAR_SIZE_MB: intWithDefault(2, { min: 1, max: 50 }),
    ALLOWED_COVER_TYPES: csvList(['image/jpeg', 'image/png', 'image/webp']),
    ALLOWED_EBOOK_TYPES: csvList(['application/pdf', 'application/epub+zip']),
    ALLOWED_AVATAR_TYPES: csvList(['image/jpeg', 'image/png', 'image/webp']),
    EXTRACT_EBOOK_TEXT: boolish(true),

    /* --- 10. Email ------------------------------------------------------ */
    MAIL_PROVIDER: z.enum(['console', 'sendgrid']).default('console'),
    SENDGRID_API_KEY: optionalStr(),
    MAIL_FROM_EMAIL: strWithDefault('no-reply@elibrary.local').pipe(z.string().email('MAIL_FROM_EMAIL must be a valid email address')),
    MAIL_FROM_NAME: strWithDefault('E-Library'),
    MAIL_REPLY_TO: optionalStr(),
    SENDGRID_SANDBOX_MODE: boolish(false),
    SENDGRID_TEMPLATE_WELCOME: optionalStr(),
    SENDGRID_TEMPLATE_PASSWORD_RESET: optionalStr(),
    SENDGRID_TEMPLATE_DUE_SOON: optionalStr(),
    SENDGRID_TEMPLATE_OVERDUE: optionalStr(),
    SENDGRID_TEMPLATE_FINE_ISSUED: optionalStr(),
    MAIL_ENABLED: boolish(true),

    /* --- 11. Scheduled jobs --------------------------------------------- */
    CRON_ENABLED: boolish(true),
    CRON_TIMEZONE: strWithDefault('Asia/Kolkata'),
    CRON_OVERDUE_CHECK: cron('30 0 * * *'),
    CRON_DUE_REMINDER: cron('0 9 * * *'),
    CRON_DIGITAL_EXPIRY: cron('0 * * * *'),
    CRON_AI_USAGE_SYNC: cron('0 */6 * * *'),
    CRON_CLEANUP: cron('0 3 * * *'),

    /* --- 12. Logging ----------------------------------------------------- */
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'http', 'debug']).default('info'),
    LOG_DIR: strWithDefault('logs'),
    LOG_TO_FILE: boolish(true),
    LOG_HTTP_REQUESTS: boolish(true),

    /* --- 13. API documentation ------------------------------------------- */
    SWAGGER_ENABLED: boolish(true),
    SWAGGER_ROUTE: strWithDefault('/api-docs'),
  })
  /**
   * Cross-field rules. These catch misconfigurations that are individually
   * valid but wrong in combination — the kind that would otherwise only
   * surface as a security hole or a runtime surprise.
   */
  .superRefine((env, ctx) => {
    // Reusing one secret across token types means a stolen password-reset
    // token could be replayed as an access token. Reject it outright.
    const secrets = {
      JWT_ACCESS_SECRET: env.JWT_ACCESS_SECRET,
      JWT_REFRESH_SECRET: env.JWT_REFRESH_SECRET,
      JWT_RESET_SECRET: env.JWT_RESET_SECRET,
    };
    const seen = new Map();
    for (const [key, value] of Object.entries(secrets)) {
      if (seen.has(value)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `must be different from ${seen.get(value)} — reusing one secret across token types lets a token of one kind be replayed as another`,
        });
      }
      seen.set(value, key);
    }

    if (env.MONGO_MIN_POOL_SIZE > env.MONGO_MAX_POOL_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGO_MIN_POOL_SIZE'],
        message: `cannot exceed MONGO_MAX_POOL_SIZE (${env.MONGO_MAX_POOL_SIZE})`,
      });
    }

    if (env.FINE_BLOCK_BORROWING_ABOVE > env.FINE_MAX_PER_LOAN) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['FINE_BLOCK_BORROWING_ABOVE'],
        message: `is higher than FINE_MAX_PER_LOAN (${env.FINE_MAX_PER_LOAN}), so a single overdue loan could never trigger the borrowing block`,
      });
    }

    if (env.DUE_REMINDER_DAYS_BEFORE >= env.LOAN_PERIOD_DAYS_PUBLIC) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DUE_REMINDER_DAYS_BEFORE'],
        message: `must be less than the shortest loan period (LOAN_PERIOD_DAYS_PUBLIC = ${env.LOAN_PERIOD_DAYS_PUBLIC}), otherwise the reminder fires before the book is even borrowed`,
      });
    }

    // Production must not run on placeholder secrets or a wide-open CORS policy.
    if (env.NODE_ENV === 'production') {
      for (const [key, value] of Object.entries(secrets)) {
        if (value.includes('replace-me')) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'still contains the placeholder value from .env.example — generate a real secret before deploying',
          });
        }
      }
      if (env.CORS_ORIGINS.includes('*')) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'cannot be "*" in production — list the exact origins allowed to call this API',
        });
      }
      if (env.AI_MOCK_MODE === 'always') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_MOCK_MODE'],
          message: 'cannot be "always" in production — that would serve fabricated AI content to real users',
        });
      }
    }
  });

/* Parse, or fail loudly */

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  // Deliberately plain console output, not the winston logger: the logger is
  // itself configured from this file, so it may not exist yet.
  const issues = parsed.error.issues;
  const lines = [
    '',
    '  ┌────────────────────────────────────────────────────────────────────┐',
    '  │  ENVIRONMENT CONFIGURATION ERROR — the server cannot start         │',
    '  └────────────────────────────────────────────────────────────────────┘',
    '',
    `  Found ${issues.length} problem${issues.length === 1 ? '' : 's'} in your .env file:`,
    '',
  ];

  for (const issue of issues) {
    const key = issue.path.join('.') || '(root)';
    lines.push(`    • ${key}`);
    lines.push(`        ${issue.message}`);
  }

  lines.push(
    '',
    '  Fix: copy .env.example to .env and fill in the values above.',
    '       Windows (PowerShell):  Copy-Item .env.example .env',
    '       macOS / Linux:         cp .env.example .env',
    ''
  );

  console.error(lines.join('\n'));
  process.exit(1);
}

/** Fully validated, fully typed environment. */
export const env = Object.freeze(parsed.data);

export default env;
