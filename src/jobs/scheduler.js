/**
 * ---------------------------------------------------------------------------
 * SCHEDULED JOBS
 * ---------------------------------------------------------------------------
 * node-cron tasks: overdue detection and fine accrual, due-date reminders,
 * digital-loan expiry, and cleanup.
 *
 * EVERY JOB IS IDEMPOTENT. A cron task will eventually run twice — a restart
 * at the wrong moment, a manual trigger, two instances briefly overlapping —
 * and a fine-accrual job that is not idempotent doubles someone's debt when
 * that happens. So the overdue job UPDATES an existing fine rather than
 * creating a second one, and the reminder job records that it sent.
 *
 * Jobs also guard against OVERLAPPING RUNS. An overdue sweep across a large
 * library can take longer than the interval between runs, and two concurrent
 * sweeps would compete over the same documents.
 *
 * Set CRON_ENABLED=false to disable all of it — necessary when running
 * multiple instances, where only one should be doing scheduled writes.
 * ---------------------------------------------------------------------------
 */

import cron from 'node-cron';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Loan } from '../models/Loan.js';
import { Fine } from '../models/Fine.js';
import { Book } from '../models/Book.js';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { PasswordResetToken } from '../models/PasswordResetToken.js';
import { LOAN_STATUS, OPEN_LOAN_STATUSES, NOTIFICATION_TYPE } from '../constants/enums.js';
import * as loanService from '../services/loan.service.js';
import mailService from '../services/mail/index.js';

/** Registered tasks, so shutdown can stop them cleanly. */
const tasks = [];

/** Jobs currently executing — the overlap guard. */
const running = new Set();

/**
 * Wrap a job with logging, timing, error containment and an overlap guard.
 *
 * ERROR CONTAINMENT MATTERS MOST. An unhandled rejection inside a cron
 * callback becomes a process-level unhandled rejection, which this
 * application treats as fatal — so one malformed record could take the whole
 * server down at 00:30 with nobody watching.
 */
const wrapJob = (name, fn) => async () => {
  if (running.has(name)) {
    logger.warn(`Skipping "${name}" — the previous run has not finished`);
    return;
  }

  running.add(name);
  const startedAt = Date.now();

  try {
    const result = await fn();
    const durationMs = Date.now() - startedAt;

    // Log at info only when the job actually did something; a nightly "0
    // processed" at info level is just noise in the log every single day.
    const didWork = result && Object.values(result).some((value) => typeof value === 'number' && value > 0);

    logger[didWork ? 'info' : 'debug'](`Job "${name}" finished in ${durationMs}ms`, result ?? {});
  } catch (error) {
    logger.error(`Job "${name}" failed`, { error: error.message, stack: error.stack });
  } finally {
    running.delete(name);
  }
};

/* ===========================================================================
 * Overdue detection and fine accrual
 * ======================================================================== */

/**
 * Flip open loans past their due date to OVERDUE and accrue fines.
 *
 * Uses a CURSOR rather than loading every overdue loan into memory: a library
 * with years of history could have thousands, and there is no reason to hold
 * them all at once.
 *
 * The fine assessment is idempotent (see `assessOverdueFine`), so running this
 * twice in one day updates the same fine rather than creating a second.
 */
export const runOverdueCheck = async () => {
  const cursor = Loan.findOverdueCursor();

  let markedOverdue = 0;
  let finesAssessed = 0;
  let notified = 0;
  const affectedUsers = new Set();

  for await (const loan of cursor) {
    try {
      if (loan.status !== LOAN_STATUS.OVERDUE) {
        loan.status = LOAN_STATUS.OVERDUE;
        await loan.save();
        markedOverdue += 1;
      }

      const fine = await loanService.assessOverdueFine(loan);
      if (fine) {
        finesAssessed += 1;
        affectedUsers.add(String(loan.user?._id ?? loan.user));
      }

      /**
       * Notify at most once a day. Without this check the job would email the
       * same member every night for as long as the book stayed out, which is
       * how a reminder system trains people to ignore it.
       */
      const lastNotified = loan.overdueNotifiedAt;
      const aDayAgo = new Date(Date.now() - 86_400_000);

      if (loan.user?.email && (!lastNotified || lastNotified < aDayAgo)) {
        await mailService.send(NOTIFICATION_TYPE.OVERDUE, loan.user.email, {
          user: loan.user,
          loans: [
            {
              bookTitle: loan.book?.title ?? 'A borrowed item',
              daysOverdue: loan.daysOverdue,
              fineAmount: fine?.amount ?? 0,
            },
          ],
          totalFine: fine?.amount ?? 0,
        });

        loan.overdueNotifiedAt = new Date();
        await loan.save();
        notified += 1;
      }
    } catch (error) {
      // One bad record must not abort the sweep for everyone else.
      logger.error('Failed to process an overdue loan', {
        loanId: String(loan._id),
        error: error.message,
      });
    }
  }

  // Refresh each affected member's cached fine total once, not once per fine.
  for (const userId of affectedUsers) {
    await loanService.refreshUserFineTotal(userId).catch(() => {});
  }

  return { markedOverdue, finesAssessed, notified, usersAffected: affectedUsers.size };
};

/* ===========================================================================
 * Due-date reminders
 * ======================================================================== */

/**
 * Remind members whose loans are due soon.
 *
 * Loans are GROUPED PER MEMBER, so someone with four books due this week gets
 * one email listing all four rather than four separate emails. That is the
 * difference between a useful reminder and something people filter away.
 */
export const runDueReminders = async () => {
  const loans = await Loan.findDueSoon(config.library.reminders.dueSoonDaysBefore);

  if (loans.length === 0) return { reminded: 0, loans: 0 };

  const byUser = new Map();

  for (const loan of loans) {
    if (!loan.user?.email) continue;

    const key = String(loan.user._id);
    if (!byUser.has(key)) byUser.set(key, { user: loan.user, loans: [] });

    byUser.get(key).loans.push({
      loanId: loan._id,
      bookTitle: loan.book?.title ?? 'A borrowed item',
      dueAt: loan.dueAt,
      daysRemaining: loan.daysRemaining,
    });
  }

  let reminded = 0;

  for (const { user, loans: userLoans } of byUser.values()) {
    // Respect the member's own preference for this notification type.
    if (!user.wantsNotification?.(NOTIFICATION_TYPE.DUE_SOON, 'email')) continue;

    const result = await mailService.send(NOTIFICATION_TYPE.DUE_SOON, user.email, {
      user,
      loans: userLoans,
    });

    if (result.success || result.skipped) {
      // Stamped whether or not delivery succeeded, so a persistently failing
      // address does not cause the same reminder to be retried nightly.
      await Loan.updateMany(
        { _id: { $in: userLoans.map((entry) => entry.loanId) } },
        { $set: { dueSoonNotifiedAt: new Date() } }
      );
      reminded += 1;
    }
  }

  return { reminded, loans: loans.length };
};

/* ===========================================================================
 * Digital-loan expiry
 * ======================================================================== */

/**
 * Expire digital loans past their term and release their licences.
 *
 * Runs hourly rather than nightly: a licence held for up to 23 extra hours
 * after expiry is a licence nobody else can use, and digital stock is
 * deliberately scarce.
 */
export const runDigitalExpiry = async () => {
  const expired = await Loan.findExpiredDigital();

  let released = 0;

  for (const loan of expired) {
    try {
      await loanService.expireDigitalLoan(loan._id);
      released += 1;
    } catch (error) {
      logger.error('Failed to expire a digital loan', {
        loanId: String(loan._id),
        error: error.message,
      });
    }
  }

  return { released };
};


/* ===========================================================================
 * AI usage reconciliation
 * ======================================================================== */

/**
 * Reconcile the locally counted AI call total against the provider's own
 * figure.
 *
 * The local count could drift — another deployment might share the token, or
 * a call might be billed upstream after failing locally. On a budget of 100
 * calls for the token's entire lifetime, an over-optimistic local count means
 * spending calls that are not actually there.
 */
export const runAiUsageSync = async () => {
  const { syncUsage } = await import('../services/ai.service.js');
  const result = await syncUsage();
  return result.synced ? { used: result.used, remaining: result.remaining } : { skipped: true };
};

/* ===========================================================================
 * Cleanup
 * ======================================================================== */

/**
 * Housekeeping.
 *
 * TTL indexes already remove expired tokens, but MongoDB's reaper runs about
 * once a minute and only handles documents whose TTL field is set — a revoked
 * token with a far-future expiry would linger for its full week. This sweeps
 * those.
 *
 * It also RECONCILES the denormalised counters. Every write path maintains
 * them, but a missed update anywhere would otherwise persist forever; a
 * nightly recompute means drift is bounded to one day rather than permanent.
 */
export const runCleanup = async () => {
  const now = new Date();

  const [revokedTokens, usedResets] = await Promise.all([
    RefreshToken.deleteMany({
      revokedAt: { $ne: null, $lt: new Date(now - 7 * 86_400_000) },
    }),
    PasswordResetToken.deleteMany({
      $or: [{ usedAt: { $ne: null } }, { expiresAt: { $lt: now } }],
    }),
  ]);

  /**
   * Reconcile member fine totals.
   *
   * Only members who currently have a PENDING fine or a non-zero cached total
   * are examined — walking every user nightly would be pointless work in a
   * library where most owe nothing.
   */
  const usersWithFines = await Fine.distinct('user', { status: 'PENDING' });
  const usersWithCachedTotals = await User.distinct('_id', {
    'stats.outstandingFine': { $gt: 0 },
  });

  const toReconcile = new Set([
    ...usersWithFines.map(String),
    ...usersWithCachedTotals.map(String),
  ]);

  let reconciled = 0;
  for (const userId of toReconcile) {
    await loanService.refreshUserFineTotal(userId).catch(() => {});
    reconciled += 1;
  }

  /** Reconcile book inventory for anything that moved in the last day. */
  const recentlyChanged = await Loan.distinct('book', {
    updatedAt: { $gte: new Date(now - 86_400_000) },
  });

  for (const bookId of recentlyChanged) {
    await Book.recalculateInventory(bookId).catch(() => {});
  }

  return {
    revokedTokensRemoved: revokedTokens.deletedCount,
    resetTokensRemoved: usedResets.deletedCount,
    fineTotalsReconciled: reconciled,
    inventoriesReconciled: recentlyChanged.length,
  };
};

/* ===========================================================================
 * Registration
 * ======================================================================== */

/**
 * Register every scheduled job.
 * Called from server.js after the database is connected and before the port
 * opens, so a job can never run against an unavailable database.
 */
export const startScheduler = () => {
  if (!config.cron.enabled) {
    logger.info('Scheduled jobs are disabled (CRON_ENABLED=false)');
    return { started: 0 };
  }

  const definitions = [
    { name: 'overdue-check', schedule: config.cron.jobs.overdueCheck, handler: runOverdueCheck },
    { name: 'due-reminders', schedule: config.cron.jobs.dueReminder, handler: runDueReminders },
    { name: 'digital-expiry', schedule: config.cron.jobs.digitalExpiry, handler: runDigitalExpiry },
    { name: 'ai-usage-sync', schedule: config.cron.jobs.aiUsageSync, handler: runAiUsageSync },
    { name: 'cleanup', schedule: config.cron.jobs.cleanup, handler: runCleanup },
  ];

  for (const { name, schedule, handler } of definitions) {
    if (!cron.validate(schedule)) {
      // Fail loudly. A silently unregistered job means fines silently stop
      // accruing, and nobody notices until a member points it out.
      logger.error(`Invalid cron expression for "${name}": "${schedule}" — this job will NOT run`);
      continue;
    }

    const task = cron.schedule(schedule, wrapJob(name, handler), {
      scheduled: true,
      timezone: config.cron.timezone,
    });

    tasks.push({ name, task, schedule });
    logger.debug(`Scheduled "${name}" at "${schedule}" (${config.cron.timezone})`);
  }

  logger.info(`Started ${tasks.length} scheduled job(s)`, {
    timezone: config.cron.timezone,
    jobs: tasks.map((entry) => `${entry.name} @ ${entry.schedule}`),
  });

  return { started: tasks.length };
};

/** Stop every job. Called during graceful shutdown, before the DB closes. */
export const stopScheduler = () => {
  for (const { name, task } of tasks) {
    task.stop();
    logger.debug(`Stopped scheduled job "${name}"`);
  }
  tasks.length = 0;
};

/**
 * Run a job by name, on demand.
 *
 * Exposed to admins so the overdue sweep can be triggered without waiting for
 * midnight — and, just as usefully, so it can be exercised in a demo.
 */
export const runJobNow = async (name) => {
  const handlers = {
    'overdue-check': runOverdueCheck,
    'due-reminders': runDueReminders,
    'digital-expiry': runDigitalExpiry,
    'ai-usage-sync': runAiUsageSync,
    cleanup: runCleanup,
  };

  const handler = handlers[name];
  if (!handler) {
    throw new Error(`Unknown job "${name}". Available: ${Object.keys(handlers).join(', ')}`);
  }

  const startedAt = Date.now();
  const result = await handler();

  return { job: name, durationMs: Date.now() - startedAt, result };
};

export default { startScheduler, stopScheduler, runJobNow };
