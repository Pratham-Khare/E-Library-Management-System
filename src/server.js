/**
 * Owns the process lifecycle, in a deliberate order:
 */

import fs from 'node:fs/promises';
import config from './config/index.js';
import logger, { banner } from './utils/logger.js';
import { connectDatabase, disconnectDatabase, getCapabilities } from './config/database.js';
import { ensureBootstrapAdmin } from './services/auth.service.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import app from './app.js';

/** The HTTP server, once listening. Held so the shutdown handler can close it. */
let server = null;

/** Guards against a second shutdown being started while the first is running. */
let shuttingDown = false;

/* Startup steps */

/**
 * Create the upload directories.
 */
const ensureStorageDirectories = async () => {
  for (const directory of config.upload.directoriesToEnsure) {
    try {
      await fs.mkdir(directory, { recursive: true });
    } catch (error) {
      logger.error('Could not create a storage directory — uploads will fail', {
        directory,
        error: error.message,
      });
      throw error;
    }
  }
  logger.debug('Storage directories ready', { root: config.upload.paths.root });
};

/**
 * Print the startup banner.
 */
const printBanner = () => {
  const capabilities = getCapabilities();

  banner(`${config.app.name} v${config.app.version}`, [
    { label: 'Environment', value: config.app.env },
    { label: 'Server', value: `http://localhost:${config.app.port}` },
    { label: 'API base', value: `${config.app.url}${config.app.apiPrefix}` },
    ...(config.swagger.enabled
      ? [{ label: 'API docs', value: `${config.app.url}${config.swagger.route}` }]
      : []),
    { label: 'Health', value: `${config.app.url}/health/ready` },
    {
      label: 'Database',
      value: `${config.database.dbName} (${capabilities.topology}, MongoDB ${capabilities.serverVersion ?? '?'})`,
    },
    {
      label: 'Transactions',
      value: capabilities.supportsTransactions
        ? 'supported'
        : 'unavailable (standalone) — using atomic CAS + compensation',
    },
    { label: 'Mail', value: `${config.mail.provider}${config.mail.fellBackToConsole ? ' (fallback)' : ''}` },
    { label: 'AI', value: `${config.ai.initialMode} — ${config.ai.api.model}` },
    { label: 'Scheduled jobs', value: config.cron.enabled ? 'enabled' : 'disabled' },
    { label: 'Rate limiting', value: config.rateLimit.enabled ? 'enabled' : 'DISABLED' },
  ]);
};

/**
 * Warn about configurations that are fine in development but wrong in
 * production. These are logged rather than fatal, because the person running
 * the server is the one who gets to decide — but they should not be silent.
 */
const warnAboutConfiguration = () => {
  if (config.mail.fellBackToConsole) {
    logger.warn(`Email: ${config.mail.providerReason}`);
  }

  if (config.ai.initialMode === 'mock') {
    logger.warn(`AI: ${config.ai.initialModeReason}`);
  }

  if (!config.rateLimit.enabled) {
    logger.warn('Rate limiting is DISABLED. Never run production this way.');
  }

  if (config.app.isProduction && config.swagger.enabled) {
    logger.warn(
      'Swagger UI is publicly exposed in production. Set SWAGGER_ENABLED=false if this API is private.'
    );
  }
};

/* Graceful shutdown */

/**
 * Stop accepting new work, let in-flight requests finish, release resources.
 */
const shutdown = async (signal, exitCode = 0) => {
  if (shuttingDown) {
    logger.warn(`Received ${signal} while already shutting down — ignoring`);
    return;
  }
  shuttingDown = true;

  logger.info(`${signal} received — shutting down gracefully`);

  const forceExitTimer = setTimeout(() => {
    logger.error(
      `Graceful shutdown exceeded ${config.app.shutdownTimeoutSeconds}s — forcing exit. Some in-flight requests were cut off.`
    );
    process.exit(1);
  }, config.app.shutdownTimeoutSeconds * 1000);

  // Do not keep the event loop alive purely for this timer.
  forceExitTimer.unref();

  try {
    // 1. Stop accepting new connections; existing ones drain.
    if (server) {
      await new Promise((resolve) => {
        server.close(() => {
          logger.info('HTTP server closed — no longer accepting connections');
          resolve();
        });
      });
    }

    // 2. Stop scheduled jobs, so nothing starts a new write mid-shutdown.
    stopScheduler();

    // 3. Close the database last, so anything still finishing can complete.
    await disconnectDatabase();

    clearTimeout(forceExitTimer);
    logger.info('Shutdown complete');
    process.exit(exitCode);
  } catch (error) {
    logger.error('Error during shutdown', { error: error.message });
    process.exit(1);
  }
};

/* Process-level safety nets */

/**
 * An unhandled rejection or uncaught exception means the process is in an
 * UNKNOWN state — a promise chain abandoned halfway, or a stack unwound past
 * every handler. Continuing risks serving corrupt data, so we log loudly and
 * exit; a process manager restarts into a clean state.
 */
const registerProcessHandlers = () => {
  process.on('unhandledRejection', (reason, promise) => {
    logger.error('UNHANDLED PROMISE REJECTION — shutting down', {
      reason: reason instanceof Error ? reason.message : String(reason),
      stack: reason instanceof Error ? reason.stack : undefined,
      promise: String(promise),
    });
    shutdown('unhandledRejection', 1);
  });

  process.on('uncaughtException', (error) => {
    logger.error('UNCAUGHT EXCEPTION — shutting down', {
      error: error.message,
      stack: error.stack,
    });
    shutdown('uncaughtException', 1);
  });

  // SIGTERM: orchestrator stop. SIGINT: Ctrl-C.
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
};

/* Boot */

const start = async () => {
  registerProcessHandlers();

  try {
    // Configuration has already been validated — importing ./config/index.js
    // runs the Zod schema over process.env and exits with a readable report if
    // anything is missing. Reaching this line means the config is sound.

    await ensureStorageDirectories();
    await connectDatabase();

    /**
     * Create the first administrator if none exists.
     */
    try {
      await ensureBootstrapAdmin();
    } catch (error) {
      logger.error('Bootstrap admin check failed — continuing startup', {
        error: error.message,
      });
    }

    /**
     * Start the background jobs.
     */
    startScheduler();

    server = app.listen(config.app.port, config.app.host, () => {
      printBanner();
      warnAboutConfiguration();
      logger.info(`Listening on ${config.app.host}:${config.app.port}`, {
        environment: config.app.env,
        pid: process.pid,
      });
    });

    /**
     * `listen` reports its failures through an event, not a rejected promise,
     * so the two most common startup failures need explicit handling — and
     * both deserve an actionable message rather than a raw errno.
     */
    server.on('error', (error) => {
      if (error.code === 'EADDRINUSE') {
        logger.error(
          `Port ${config.app.port} is already in use. Either stop the process using it, or set a different PORT in .env.`
        );
      } else if (error.code === 'EACCES') {
        logger.error(
          `Permission denied binding to port ${config.app.port}. Ports below 1024 require elevated privileges — pick a higher port.`
        );
      } else {
        logger.error('HTTP server error', { error: error.message, code: error.code });
      }
      process.exit(1);
    });

    // Slightly above a typical 60s load-balancer idle timeout, so the balancer
    // closes idle connections rather than the server racing it and producing
    // spurious 502s.
    server.keepAliveTimeout = 65_000;
    server.headersTimeout = 66_000;
  } catch (error) {
    logger.error('Failed to start the server', { error: error.message, stack: error.stack });
    process.exit(1);
  }
};

start();
