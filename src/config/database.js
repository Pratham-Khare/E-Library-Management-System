/**
 * Connection options plus the connect/disconnect lifecycle.
 */

import mongoose from 'mongoose';
import env from './env.js';
import logger from '../utils/logger.js';

/**
 * Driver options.
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

/* Deployment capabilities, discovered at connect time */

/**
 * Populated by `connectDatabase()`. Read it through `getCapabilities()`.
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

/* Connection lifecycle */

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
