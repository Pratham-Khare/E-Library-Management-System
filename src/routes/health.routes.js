/**
 * Two probes with genuinely different jobs, a distinction worth keeping:
 */

import { Router } from 'express';
import mongoose from 'mongoose';
import config from '../config/index.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { HTTP_STATUS } from '../constants/httpStatus.js';

const router = Router();

/** Process start time, used to report uptime. */
const startedAt = new Date();

/**
 * @openapi
 * /health:
 *   get:
 *     tags: [Health]
 *     summary: Liveness probe
 *     description: >
 *       Returns 200 as long as the process is running. Deliberately checks no
 *       dependencies, so a transient database outage does not cause a restart
 *       loop. Use /health/ready to decide whether to send traffic.
 *     security: []
 *     responses:
 *       200:
 *         description: The process is alive.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 uptime: { type: number, example: 1043.21 }
 *                 timestamp: { type: string, format: date-time }
 */
router.get('/health', (req, res) => {
  res.status(HTTP_STATUS.OK).json({
    status: 'ok',
    service: config.app.name,
    version: config.app.version,
    uptime: Number(process.uptime().toFixed(2)),
    timestamp: new Date().toISOString(),
  });
});

/**
 * Ping the database with a cheap command.
 */
const checkDatabase = async () => {
  const state = config.database.connectionState();

  if (state !== 'connected') {
    return { status: 'down', state, message: 'Not connected to MongoDB' };
  }

  try {
    const started = Date.now();
    await Promise.race([
      mongoose.connection.db.admin().ping(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('ping timed out')), 3000)),
    ]);

    const capabilities = config.database.getCapabilities();

    return {
      status: 'up',
      state,
      latencyMs: Date.now() - started,
      database: config.database.dbName,
      serverVersion: capabilities.serverVersion,
      topology: capabilities.topology,
      // Surfaced deliberately: it explains which concurrency strategy the
      // circulation engine is using on this deployment.
      transactionsSupported: capabilities.supportsTransactions,
    };
  } catch (error) {
    return { status: 'down', state, message: error.message };
  }
};

/**
 * Report the mail provider ACTUALLY in use, which may differ from
 * MAIL_PROVIDER in .env when the SendGrid key is missing and the config layer
 * fell back to console. Surfacing that here is the point — otherwise "why did
 * no email arrive?" is a mystery.
 */
const checkMail = () => ({
  status: 'up',
  provider: config.mail.provider,
  configured: !config.mail.fellBackToConsole,
  reason: config.mail.providerReason,
  ...(config.mail.fellBackToConsole ? { warning: 'Falling back to console delivery' } : {}),
});

/**
 * Report the AI operating mode. No network call is made — a readiness probe
 * must be fast and must not spend a call from the limited quota just to
 * describe itself.
 */
const checkAi = () => ({
  status: 'up',
  mode: config.ai.initialMode,
  model: config.ai.api.model,
  reason: config.ai.initialModeReason,
  quotaTotal: config.ai.quota.total,
  cacheEnabled: config.ai.cache.enabled,
});

/**
 * @openapi
 * /health/ready:
 *   get:
 *     tags: [Health]
 *     summary: Readiness probe
 *     description: >
 *       Checks every dependency and reports how the service is actually
 *       configured — database connectivity and transaction support, the mail
 *       provider in use (after fallback), and whether AI is live or mocked.
 *       Returns 503 when a hard dependency is down.
 *     security: []
 *     responses:
 *       200:
 *         description: Ready to serve traffic.
 *       503:
 *         description: A required dependency is unavailable.
 */
router.get(
  '/health/ready',
  asyncHandler(async (req, res) => {
    const database = await checkDatabase();
    const mail = checkMail();
    const ai = checkAi();

    // The database is the only HARD dependency. Mail and AI both degrade
    // gracefully by design — emails fall back to the log, AI falls back to
    const ready = database.status === 'up';

    res.status(ready ? HTTP_STATUS.OK : HTTP_STATUS.SERVICE_UNAVAILABLE).json({
      status: ready ? 'ready' : 'not_ready',
      service: config.app.name,
      version: config.app.version,
      environment: config.app.env,
      uptime: Number(process.uptime().toFixed(2)),
      startedAt: startedAt.toISOString(),
      timestamp: new Date().toISOString(),
      checks: { database, mail, ai },
    });
  })
);

export default router;
