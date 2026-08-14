/**
 * ---------------------------------------------------------------------------
 * MONGODB CONNECTION
 * ---------------------------------------------------------------------------
 * Connection options plus the connect/disconnect lifecycle.
 *
 * The interesting part is REPLICA-SET DETECTION.
 *
 * MongoDB only supports multi-document transactions on a replica set. A
 * default local install runs as a standalone `mongod`, where starting a
 * session and calling `withTransaction` throws. Most tutorial code either
 * ignores transactions entirely (and corrupts data under concurrency) or uses
 * them unconditionally (and crashes on a developer's laptop).
 *
 * This file probes the deployment type once at connect time and records it.
 * `utils/transaction.js` reads that flag and either runs the operation inside
 * a real session or executes it directly with compensating rollback. The
 * critical borrow path is additionally written as a single atomic
 * compare-and-swap, so it is correct even with no transaction available.
 *
 * See docs/architecture.md for how to convert a local install to a single-node
 * replica set and unlock real transactions.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import env from './env.js';
import logger from '../utils/logger.js';

/**
 * Driver options.
 *
 *   dbName            — kept out of MONGO_URI so one URI serves all environments.
 *   maxPoolSize       — concurrent sockets. Too few queues requests; too many
 *                       exhausts the server's connection limit.
 *   serverSelectionTimeoutMS — how long to hunt for a reachable node before
 *                       failing. Low enough that a wrong URI fails fast.
 *   autoIndex         — build indexes declared in schemas on startup. Wanted in
 *                       development; in production it blocks the event loop on
 *                       a large collection, so indexes are built deliberately.
 */
export const options = Object.freeze({
  dbName: env.MONGO_DB_NAME,
  maxPoolSize: env.MONGO_MAX_POOL_SIZE,
  minPoolSize: env.MONGO_MIN_POOL_SIZE,
  serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
  socketTimeoutMS: env.MONGO_SOCKET_TIMEOUT_MS,
  family: 4, // Prefer IPv4: "localhost" resolving to ::1 is a classic Windows stall
  autoIndex: env.NODE_ENV !== 'production',
  retryWrites: true,
});

export const uri = env.MONGO_URI;
export const dbName = env.MONGO_DB_NAME;

/* ===========================================================================
 * Deployment capabilities, discovered at connect time
 * ======================================================================== */

/**
 * Populated by `connectDatabase()`. Read it through `getCapabilities()`.
 *
 *   isReplicaSet         — true when the server reports a replica-set name.
 *   supportsTransactions — same thing, named for how the app uses it.
 *   topology             — 'replicaSet' | 'sharded' | 'standalone' | 'unknown'
 */
const capabilities = {
  isReplicaSet: false,
  supportsTransactions: false,
  topology: 'unknown',
  serverVersion: null,
};

export const getCapabilities = () => ({ ...capabilities });

/** True when multi-document transactions can actually be used. */
export const supportsTransactions = () => capabilities.supportsTransactions;

/**
 * Ask the server what it is.
 *
 * The `hello` command reports `setName` on a replica-set member and
 * `msg: 'isdbgrid'` behind a mongos router. A standalone reports neither.
 * Probe failure is not fatal — we simply assume the more restrictive case
 * (no transactions), which is always safe.
 */
const detectCapabilities = async () => {
  try {
    const admin = mongoose.connection.db.admin();

    // `hello` reports the TOPOLOGY but not the server version; `buildInfo`
    // reports the version but not the topology. Both are cheap, and they are
    // independent, so issue them together rather than one after the other.
    const [info, build] = await Promise.all([
      admin.command({ hello: 1 }),
      admin.command({ buildInfo: 1 }).catch(() => null), // needs a privilege on some managed hosts
    ]);

    capabilities.serverVersion = build?.version ?? null;

    if (info.msg === 'isdbgrid') {
      capabilities.topology = 'sharded';
      capabilities.isReplicaSet = false;
      capabilities.supportsTransactions = true; // sharded clusters support them
    } else if (info.setName) {
      capabilities.topology = 'replicaSet';
      capabilities.isReplicaSet = true;
      capabilities.supportsTransactions = true;
    } else {
      capabilities.topology = 'standalone';
      capabilities.isReplicaSet = false;
      capabilities.supportsTransactions = false;
    }
  } catch (error) {
    // Assume the restrictive case. Being wrong in this direction costs a
    // little safety margin; being wrong the other way throws at runtime.
    capabilities.topology = 'unknown';
    capabilities.supportsTransactions = false;
    logger.warn('Could not determine MongoDB topology; assuming no transaction support', {
      error: error.message,
    });
  }
};

/* ===========================================================================
 * Connection lifecycle
 * ======================================================================== */

let listenersAttached = false;

/**
 * Connection-level event handlers. Attached once — mongoose keeps a single
 * global connection, and re-registering on every connect leaks listeners.
 */
const attachListeners = () => {
  if (listenersAttached) return;
  listenersAttached = true;

  const connection = mongoose.connection;

  connection.on('connected', () => {
    logger.info('MongoDB connected', { database: dbName });
  });

  connection.on('error', (error) => {
    logger.error('MongoDB connection error', { error: error.message });
  });

  connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — the driver will attempt to reconnect');
  });

  connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });
};

/**
 * Connect, then detect capabilities.
 *
 * @returns {Promise<typeof mongoose.connection>}
 * @throws  Rethrows the driver error after logging actionable guidance. The
 *          caller (server.js) exits — an API that cannot reach its database
 *          should fail loudly at startup rather than serve 500s.
 */
export const connectDatabase = async () => {
  attachListeners();

  // Reject queries against fields not in the schema rather than silently
  // dropping them — a typo in a filter should surface, not return everything.
  mongoose.set('strictQuery', true);

  if (env.MONGO_DEBUG) {
    mongoose.set('debug', (collection, method, query) => {
      logger.debug(`Mongoose: ${collection}.${method}`, { query });
    });
  }

  try {
    await mongoose.connect(uri, options);
    await detectCapabilities();

    if (!capabilities.supportsTransactions) {
      logger.warn(
        'MongoDB is running standalone, so multi-document transactions are unavailable. ' +
          'Circulation still behaves correctly: the copy claim is a single atomic ' +
          'compare-and-swap, and multi-step writes use compensating rollback. ' +
          'See docs/architecture.md to enable a single-node replica set.'
      );
    }

    return mongoose.connection;
  } catch (error) {
    logger.error('Failed to connect to MongoDB', {
      error: error.message,
      // Never log the full URI — it may embed a password.
      uri: uri.replace(/\/\/[^@]*@/, '//<credentials>@'),
      database: dbName,
    });

    logger.error(
      'Check that: (1) MongoDB is running — on Windows, `Get-Service MongoDB`; ' +
        '(2) MONGO_URI in .env points at the right host and port; ' +
        '(3) any firewall or Atlas IP allow-list permits this machine.'
    );

    throw error;
  }
};

/**
 * Close the connection cleanly. Called during graceful shutdown so in-flight
 * operations finish and the server does not leave sockets hanging.
 */
export const disconnectDatabase = async () => {
  try {
    await mongoose.connection.close(false);
    logger.info('MongoDB connection closed');
  } catch (error) {
    logger.error('Error while closing the MongoDB connection', { error: error.message });
  }
};

/** Mongoose readyState mapped to a readable label, for the health endpoint. */
export const connectionState = () => {
  const states = { 0: 'disconnected', 1: 'connected', 2: 'connecting', 3: 'disconnecting' };
  return states[mongoose.connection.readyState] ?? 'unknown';
};

/** True when the connection is usable right now. */
export const isConnected = () => mongoose.connection.readyState === 1;

export default Object.freeze({
  uri,
  dbName,
  options,
  connectDatabase,
  disconnectDatabase,
  connectionState,
  isConnected,
  getCapabilities,
  supportsTransactions,
});
