/**
 * ---------------------------------------------------------------------------
 * TEST ENVIRONMENT SETUP
 * ---------------------------------------------------------------------------
 * Runs BEFORE any test module is imported, which matters: `src/config/env.js`
 * reads `process.env` at import time and exits the process if anything is
 * missing. Setting these here means the configuration layer sees test values
 * rather than development ones.
 *
 * THE IMPORTANT LINE IS `MONGO_DB_NAME`. Integration tests wipe collections
 * between files, so they must never point at the development database. Using a
 * separate database name is what stops `npm test` from deleting the data you
 * were just working with.
 *
 * A real MongoDB is used rather than `mongodb-memory-server`, deliberately:
 * the in-memory package downloads a ~100MB binary on first run, which fails on
 * a restricted network and makes a fresh clone's first `npm test` unpredictable.
 * The local server is already required to run the app at all.
 * ---------------------------------------------------------------------------
 */

process.env.NODE_ENV = 'test';

/**
 * A SEPARATE database, and a separate one PER JEST WORKER.
 *
 * The worker suffix is not cosmetic. Jest runs test files in parallel across
 * workers, and integration tests clear collections between tests — so two
 * files sharing one database means each wipes the other's fixtures mid-test,
 * producing failures that look like application bugs and move around between
 * runs.
 *
 * (`maxWorkers` inside a `projects` entry does NOT prevent this: it is a
 * global Jest option and is ignored at the project level.)
 */
const worker = process.env.JEST_WORKER_ID ?? '1';
process.env.MONGO_DB_NAME = process.env.TEST_DB_NAME ?? `elibrary_test_${worker}`;

/** Rate limiting would reject a test suite firing hundreds of requests. */
process.env.RATE_LIMIT_ENABLED = 'false';

/** Keep the test output readable: no log files, no HTTP access log. */
process.env.LOG_TO_FILE = 'false';
process.env.LOG_HTTP_REQUESTS = 'false';
process.env.LOG_LEVEL = 'error';

/** No background jobs during tests — they would write while assertions run. */
process.env.CRON_ENABLED = 'false';

/** Never send email, and never call the AI provider, from a test run. */
process.env.MAIL_ENABLED = 'false';
process.env.AI_MOCK_MODE = 'always';

/**
 * Fixed secrets, so tests do not depend on whatever is in `.env`.
 * Long enough to satisfy the 32-character minimum the config layer enforces.
 */
process.env.JWT_ACCESS_SECRET = 'test-access-secret-0123456789abcdefghijklmnopqrstuvwxyz';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdefghijklmnopqrstuvwxyz';
process.env.JWT_RESET_SECRET = 'test-reset-secret-0123456789abcdefghijklmnopqrstuvwxyz';

/** Speeds up every test that hashes a password. 4 is bcrypt's minimum. */
process.env.BCRYPT_SALT_ROUNDS = '4';

/** Do not create a bootstrap admin — tests make their own fixtures. */
process.env.BOOTSTRAP_ADMIN_ENABLED = 'false';
