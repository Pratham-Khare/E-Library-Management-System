/**
 * ---------------------------------------------------------------------------
 * TRANSACTION HELPER
 * ---------------------------------------------------------------------------
 * MongoDB supports multi-document transactions ONLY on a replica set or a
 * sharded cluster. A default local `mongod` runs standalone, where opening a
 * session and calling `withTransaction` throws:
 *
 *     MongoServerError: Transaction numbers are only allowed on a replica set
 *     member or mongos
 *
 * Most code handles this badly in one of two ways: skip transactions entirely
 * and corrupt data under concurrency, or use them unconditionally and crash on
 * a developer's laptop.
 *
 * This helper detects the deployment at connect time (see config/database.js)
 * and adapts:
 *
 *   REPLICA SET  → run inside a real session; automatic atomic rollback.
 *   STANDALONE   → run directly, and on failure invoke the caller's registered
 *                  compensating actions in reverse order.
 *
 * IMPORTANT: compensation is NOT equivalent to a transaction. Between two
 * writes there is a window where another reader sees a partial state, and a
 * process crash mid-sequence leaves compensation unrun. It is a best-effort
 * fallback, which is why the ONE place correctness genuinely matters — claiming
 * a copy when borrowing — does not depend on it at all. That claim is a single
 * atomic `findOneAndUpdate` filtered on `status: AVAILABLE`: a compare-and-swap
 * that two concurrent requests cannot both win, on any deployment.
 *
 * Usage:
 *     const loan = await runInTransaction(async (session, tx) => {
 *       const copy = await claimCopy(bookId, session);
 *       tx.compensate(() => releaseCopy(copy._id));   // undo if a later step fails
 *       return Loan.create([{ ... }], { session });
 *     });
 * ---------------------------------------------------------------------------
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
   *
   * @param {() => Promise<void>|void} action
   * @param {string} [description] Included in logs if compensation fails.
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
 *
 * @template T
 * @param {(session: import('mongoose').ClientSession|null, tx: TransactionContext) => Promise<T>} callback
 * @param {object} [options]
 * @param {import('mongodb').ReadConcernLevel} [options.readConcern]
 * @param {import('mongodb').W} [options.writeConcern]
 * @returns {Promise<T>}
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
 *
 * Passing `{ session: null }` is not the same as passing nothing to every
 * Mongoose method, so this keeps call sites free of `session ? {...} : {}`
 * ternaries:
 *
 *     await Book.findById(id, null, withSession(session));
 *
 * @param {import('mongoose').ClientSession|null} session
 * @param {object} [extra] Other options to merge in.
 */
export const withSession = (session, extra = {}) =>
  session ? { ...extra, session } : { ...extra };

export default { runInTransaction, hasTransactionSupport, withSession };
