/**
 * ---------------------------------------------------------------------------
 * INTEGRATION TEST DATABASE HELPERS
 * ---------------------------------------------------------------------------
 * Connects to a SEPARATE database (`elibrary_test` by default — set in
 * tests/setup-env.js) so a test run can never touch development data.
 *
 * `clearDatabase()` is called between tests rather than dropping and
 * recreating: dropping a database also drops its indexes, and several
 * behaviours under test — unique ISBNs, one review per member per book, the
 * atomic copy claim — depend on those indexes existing. Deleting documents
 * keeps them.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../../src/config/index.js';

/** Import every model once, so `mongoose.models` is fully populated. */
const loadModels = async () => {
  await Promise.all([
    import('../../src/models/User.js'),
    import('../../src/models/RefreshToken.js'),
    import('../../src/models/PasswordResetToken.js'),
    import('../../src/models/Author.js'),
    import('../../src/models/Publisher.js'),
    import('../../src/models/Category.js'),
    import('../../src/models/Book.js'),
    import('../../src/models/BookCopy.js'),
    import('../../src/models/DigitalAsset.js'),
    import('../../src/models/Loan.js'),
    import('../../src/models/Fine.js'),
    import('../../src/models/Review.js'),
    import('../../src/models/ReadingList.js'),
    import('../../src/models/Notification.js'),
    import('../../src/models/AiSummary.js'),
    import('../../src/models/AiUsageLog.js'),
    import('../../src/models/AuditLog.js'),
    import('../../src/models/Counter.js'),
  ]);
};

/**
 * Connect, and build the indexes the tests depend on.
 *
 * `syncIndexes()` is not optional here. Mongoose builds indexes lazily in the
 * background, so without it a uniqueness assertion can pass simply because the
 * index did not exist yet — a false green.
 */
export const connect = async () => {
  if (mongoose.connection.readyState === 1) return;

  await loadModels();

  await mongoose.connect(config.database.uri, {
    ...config.database.options,
    dbName: process.env.MONGO_DB_NAME,
  });

  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
};

/** Empty every collection, keeping the indexes. */
export const clearDatabase = async () => {
  if (mongoose.connection.readyState !== 1) return;

  await Promise.all(
    Object.values(mongoose.connection.collections).map((collection) => collection.deleteMany({}))
  );
};

/** Drop the test database entirely and close the connection. */
export const disconnect = async () => {
  if (mongoose.connection.readyState !== 1) return;

  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
};

/** True when the deployment supports multi-document transactions. */
export const supportsTransactions = () => config.database.supportsTransactions();
