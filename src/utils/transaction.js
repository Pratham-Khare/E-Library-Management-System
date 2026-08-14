/**
 * MongoDB supports multi-document transactions ONLY on a replica set or a
 * sharded cluster. A default local `mongod` runs standalone, where opening a
 * session and calling `withTransaction` throws:
 */

import mongoose from 'mongoose';
import { supportsTransactions } from '../config/database.js';
import logger from './logger.js';

/**
 * Context handed to the callback. `compensate` registers an undo action that
 * runs only on the standalone path — with a real transaction, the database
 * rolls everything back and compensation would double-undo.
 */
class TransactionContext {
  constructor(usingRealTransaction) {
    this.usingRealTransaction = usingRealTransaction;
    /** @type {Array<() => Promise<void>>} */
    this.compensations = [];
  }

  /**
   * Register an undo action for a write that has already happened.
   * Called in REVERSE order on failure, so later writes unwind before the
   * earlier ones they depend on.
   */
  compensate(action, description = 'unnamed compensation') {
    this.compensations.push({ action, description });
  }

  /**
   * Run every registered compensation, newest first.
   * Each is individually guarded: one failing undo must not prevent the rest
   * from running, and the original error is what the caller needs to see.
   */
  async rollback() {
    if (this.compensations.length === 0) return;

    logger.warn(
      `Transaction failed on a deployment without transaction support — running ${this.compensations.length} compensating action(s)`
    );

    for (let i = this.compensations.length - 1; i >= 0; i -= 1) {
      const { action, description } = this.compensations[i];
      try {
        await action();
      } catch (error) {
        // Genuinely bad: a write happened and could not be undone. Log loudly
        // with enough context for a human to repair it by hand.
        logger.error('Compensating action FAILED — manual reconciliation may be required', {
          description,
          error: error.message,
        });
      }
    }
  }
}

/**
 * Run `callback` atomically where the deployment allows it, and with
 * compensating rollback where it does not.
 */
export const runInTransaction = async (callback, options = {}) => {
  const canUseTransactions = supportsTransactions();
  const context = new TransactionContext(canUseTransactions);

  /* --- Path A: real transactions ------------------------------------- */
  if (canUseTransactions) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(
        async () => {
          result = await callback(session, context);
        },
        {
          // 'snapshot' + 'majority' gives a consistent view and durable writes,
          // which is what makes the borrow path safe against a concurrent read.
          readConcern: options.readConcern ?? { level: 'snapshot' },
          writeConcern: options.writeConcern ?? { w: 'majority' },
        }
      );
      return result;
    } finally {
      // Always end the session, success or failure, or the pool leaks.
      await session.endSession();
    }
  }

  /* --- Path B: standalone, compensating rollback ---------------------- */
  try {
    return await callback(null, context);
  } catch (error) {
    await context.rollback();
    throw error;
  }
};

/**
 * Whether the deployment supports real transactions. Useful for a health
 * endpoint, and for tests that want to assert which path they exercised.
 */
export const hasTransactionSupport = () => supportsTransactions();

/**
 * Add `{ session }` to a Mongoose call only when a session exists.
 */
export const withSession = (session, extra = {}) =>
  session ? { ...extra, session } : { ...extra };

export default { runInTransaction, hasTransactionSupport, withSession };
