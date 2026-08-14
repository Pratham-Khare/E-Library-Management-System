/**
 *     npm run seed         Add demo data. Refuses if the database already has any.
 *     npm run seed:fresh   Wipe everything, then seed.
 *     npm run seed:clear   Empty the collections without seeding.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import mongoose from 'mongoose';
import config from '../config/index.js';
import logger, { banner } from '../utils/logger.js';
import { connectDatabase, disconnectDatabase } from '../config/database.js';
import { hashPassword } from '../utils/password.js';
import { DEFAULT_READING_LISTS } from '../constants/enums.js';

import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { PasswordResetToken } from '../models/PasswordResetToken.js';
import { Author } from '../models/Author.js';
import { Publisher } from '../models/Publisher.js';
import { Category } from '../models/Category.js';
import { Book } from '../models/Book.js';
import { BookCopy } from '../models/BookCopy.js';
import { DigitalAsset } from '../models/DigitalAsset.js';
import { Loan } from '../models/Loan.js';
import { Fine } from '../models/Fine.js';
import { Review } from '../models/Review.js';
import { ReadingList } from '../models/ReadingList.js';
import { Notification } from '../models/Notification.js';
import { AiSummary } from '../models/AiSummary.js';
import { AiUsageLog } from '../models/AiUsageLog.js';
import { AuditLog } from '../models/AuditLog.js';
import { Counter } from '../models/Counter.js';

import { users as userFixtures, SEED_PASSWORD } from './data/users.js';
import {
  authors as authorFixtures,
  publishers as publisherFixtures,
  categoryTree,
  books as bookFixtures,
} from './data/catalog.js';

/* CLI flags */

const args = process.argv.slice(2);
const FRESH = args.includes('--fresh');
const CLEAR_ONLY = args.includes('--clear');

/**
 * Collections the seeder owns, in DELETION ORDER — children before parents, so
 * nothing is ever left pointing at a document that no longer exists.
 * Later phases append their models here.
 */
const seededModels = [
  Counter,
  AuditLog,
  AiUsageLog,
  AiSummary,
  Notification,
  ReadingList,
  Review,
  Fine,
  Loan,
  DigitalAsset,
  BookCopy,
  Book,
  Category,
  Publisher,
  Author,
  PasswordResetToken,
  RefreshToken,
  User,
];

/* Guards */

/**
 * Refuse destructive operations outside development.
 */
const assertSafeToDestroy = () => {
  if (config.app.isProduction) {
    logger.error(
      'Refusing to wipe data with NODE_ENV=production. If you genuinely intend this, change NODE_ENV first — deliberately.'
    );
    process.exit(1);
  }
};

/** Is there already data here? */
const databaseHasData = async () => {
  const counts = await Promise.all(seededModels.map((model) => model.estimatedDocumentCount()));
  return counts.some((count) => count > 0);
};

/* Steps */

const clearCollections = async () => {
  logger.info('Clearing seeded collections…');

  for (const model of seededModels) {
    const { deletedCount } = await model.deleteMany({});
    if (deletedCount > 0) {
      logger.info(`  cleared ${String(deletedCount).padStart(4)} × ${model.modelName}`);
    }
  }

  await clearUploadedFiles();
};

/**
 * Delete uploaded files alongside the records that referenced them.
 */
const clearUploadedFiles = async () => {
  const directories = [
    config.upload.paths.covers,
    config.upload.paths.ebooks,
    config.upload.paths.avatars,
    config.upload.paths.temp,
  ];

  let removed = 0;

  for (const directory of directories) {
    try {
      const entries = await fs.readdir(directory);
      for (const entry of entries) {
        // eslint-disable-next-line no-await-in-loop
        await fs.unlink(path.join(directory, entry));
        removed += 1;
      }
    } catch (error) {
      // A missing directory is fine — it simply has not been created yet.
      if (error.code !== 'ENOENT') {
        logger.warn(`Could not clear ${directory}`, { error: error.message });
      }
    }
  }

  if (removed > 0) logger.info(`  cleared ${String(removed).padStart(4)} × uploaded file`);
};

/**
 * Seed users.
 */
const seedUsers = async () => {
  logger.info('Seeding users…');

  const passwordHash = await hashPassword(SEED_PASSWORD);

  const created = [];

  for (const fixture of userFixtures) {
    // `_note` is documentation for whoever reads the fixture file; it is not a
    // schema field and must not reach the database.
    const { _note, ...data } = fixture;

    // Created through the model rather than insertMany, so the pre-save hooks
    // run — which is what generates the membership numbers and enforces the
    const user = await User.create({ ...data, passwordHash });
    created.push(user);
  }

  logger.info(`  created ${created.length} users`);
  return created;
};

/** Authors and publishers — created through the model so slugs are generated. */
const seedTaxonomy = async () => {
  logger.info('Seeding authors and publishers…');

  const authors = [];
  for (const fixture of authorFixtures) {
    // eslint-disable-next-line no-await-in-loop
    authors.push(await Author.create(fixture));
  }

  const publishers = [];
  for (const fixture of publisherFixtures) {
    // eslint-disable-next-line no-await-in-loop
    publishers.push(await Publisher.create(fixture));
  }

  logger.info(`  created ${authors.length} authors, ${publishers.length} publishers`);
  return { authors, publishers };
};

/**
 * Walk the nested category fixture depth-first, creating each node with its
 * parent already in place.
 */
const seedCategories = async () => {
  logger.info('Seeding categories…');

  const created = [];

  const createNode = async (fixture, parentId = null) => {
    const { children = [], ...data } = fixture;
    const category = await Category.create({ ...data, parent: parentId });
    created.push(category);

    for (const child of children) {
      // eslint-disable-next-line no-await-in-loop
      await createNode(child, category._id);
    }
  };

  for (const root of categoryTree) {
    // eslint-disable-next-line no-await-in-loop
    await createNode(root);
  }

  const maxDepth = Math.max(...created.map((c) => c.depth));
  logger.info(`  created ${created.length} categories, ${maxDepth + 1} levels deep`);

  return created;
};

/**
 * Books and their physical copies.
 */
const seedBooks = async ({ authors, publishers, categories }) => {
  logger.info('Seeding books and copies…');

  const authorByName = new Map(authors.map((doc) => [doc.name, doc._id]));
  const publisherByName = new Map(publishers.map((doc) => [doc.name, doc._id]));
  const categoryByName = new Map(categories.map((doc) => [doc.name, doc._id]));

  const books = [];
  let copyCount = 0;

  for (const fixture of bookFixtures) {
    const { authorNames = [], publisherName, categoryNames = [], copies = 0, ...data } = fixture;

    // Fail loudly on a typo in a fixture rather than silently creating a book
    // with no author — a bad fixture should be obvious immediately.
    const authorIds = authorNames.map((name) => {
      const id = authorByName.get(name);
      if (!id) throw new Error(`Seed fixture references an unknown author: "${name}"`);
      return id;
    });

    const categoryIds = categoryNames.map((name) => {
      const id = categoryByName.get(name);
      if (!id) throw new Error(`Seed fixture references an unknown category: "${name}"`);
      return id;
    });

    // eslint-disable-next-line no-await-in-loop
    const book = await Book.create({
      ...data,
      authors: authorIds,
      publisher: publisherName ? publisherByName.get(publisherName) : null,
      categories: categoryIds,
    });

    books.push(book);

    // Copies, with shelf locations that look like a real classification.
    for (let i = 0; i < copies; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const accessionNumber = await BookCopy.generateAccessionNumber();
      const shelf = `${String.fromCharCode(65 + (books.length % 6))}-${String(books.length).padStart(2, '0')}-${i + 1}`;

      // eslint-disable-next-line no-await-in-loop
      await BookCopy.create({
        book: book._id,
        accessionNumber,
        shelfLocation: shelf,
        condition: i === 0 ? 'NEW' : 'GOOD',
        cost: book.price,
        source: 'Initial acquisition',
      });
      copyCount += 1;
    }
  }

  /**
   * Rebuild every denormalised counter from source.
   */
  logger.info('  reconciling denormalised counters…');

  for (const book of books) {
    // eslint-disable-next-line no-await-in-loop
    await Book.recalculateInventory(book._id);
  }

  for (const author of authors) {
    // eslint-disable-next-line no-await-in-loop
    const count = await Book.countDocuments({ authors: author._id, isDeleted: false });
    // eslint-disable-next-line no-await-in-loop
    await Author.updateOne({ _id: author._id }, { $set: { bookCount: count } });
  }

  for (const publisher of publishers) {
    // eslint-disable-next-line no-await-in-loop
    const count = await Book.countDocuments({ publisher: publisher._id, isDeleted: false });
    // eslint-disable-next-line no-await-in-loop
    await Publisher.updateOne({ _id: publisher._id }, { $set: { bookCount: count } });
  }

  for (const category of categories) {
    // eslint-disable-next-line no-await-in-loop
    const count = await Book.countDocuments({ categories: category._id, isDeleted: false });
    // eslint-disable-next-line no-await-in-loop
    await Category.updateOne({ _id: category._id }, { $set: { bookCount: count } });
  }

  logger.info(`  created ${books.length} books and ${copyCount} copies`);
  return books;
};

/**
 * Loans, in deliberately varied states.
 */
const seedLoans = async ({ users, books }) => {
  logger.info('Seeding loans and fines…');

  const memberByEmail = new Map(users.map((user) => [user.email, user]));
  const bookByTitle = new Map(books.map((book) => [book.title, book]));

  const daysAgo = (days) => new Date(Date.now() - days * 86_400_000);
  const daysAhead = (days) => {
    const date = new Date(Date.now() + days * 86_400_000);
    date.setHours(23, 59, 59, 999);
    return date;
  };

  /**
   * Each entry describes a loan by MEMBER EMAIL and BOOK TITLE rather than by
   * id, so the fixture stays readable and does not depend on insertion order.
   */
  const fixtures = [
    // --- Healthy active loans -------------------------------------------
    { email: 'ananya@student.test', title: 'Introduction to Algorithms', issuedDaysAgo: 3, dueInDays: 18 },
    { email: 'ananya@student.test', title: 'Clean Code', issuedDaysAgo: 1, dueInDays: 20 },
    { email: 'sunita@faculty.test', title: 'Sapiens', issuedDaysAgo: 10, dueInDays: 20 },
    { email: 'kavita@public.test', title: 'Becoming', issuedDaysAgo: 2, dueInDays: 12 },

    // --- Due very soon: exercises the reminder job ------------------------
    { email: 'arjun@student.test', title: 'Cosmos', issuedDaysAgo: 19, dueInDays: 2 },

    // --- Renewed once ------------------------------------------------------
    { email: 'sunita@faculty.test', title: 'The Shadow Lines', issuedDaysAgo: 35, dueInDays: 25, renewals: 1 },

    // --- OVERDUE: the states that make fines testable ---------------------
    // 5 days late, minus 2 grace = 3 chargeable × ₹5 = ₹15
    { email: 'rohan@student.test', title: 'Things Fall Apart', issuedDaysAgo: 26, dueInDays: -5, overdue: true },
    // 12 days late, minus 2 grace = 10 chargeable × ₹5 = ₹50
    { email: 'rohan@student.test', title: 'Beloved', issuedDaysAgo: 33, dueInDays: -12, overdue: true },
    // 40 days late → would be ₹190; well over the block threshold when combined
    { email: 'imran@public.test', title: 'The God of Small Things', issuedDaysAgo: 54, dueInDays: -40, overdue: true },

    // --- Completed history ------------------------------------------------
    { email: 'ananya@student.test', title: 'Norwegian Wood', issuedDaysAgo: 60, dueInDays: -39, returnedDaysAgo: 45 },
    { email: 'priya@student.test', title: 'A Wizard of Earthsea', issuedDaysAgo: 50, dueInDays: -29, returnedDaysAgo: 32 },
    { email: 'kavita@public.test', title: 'The Guide', issuedDaysAgo: 90, dueInDays: -76, returnedDaysAgo: 80 },
  ];

  const loans = [];
  const fines = [];

  for (const fixture of fixtures) {
    const user = memberByEmail.get(fixture.email);
    const book = bookByTitle.get(fixture.title);

    if (!user || !book) {
      throw new Error(
        `Loan fixture references something unknown: ${fixture.email} / ${fixture.title}`
      );
    }

    const isClosed = fixture.returnedDaysAgo !== undefined;

    // Claim a real copy for anything still out, so BookCopy status and the
    // book's availability counters reflect reality rather than diverging from it.
    let copy = null;
    if (!isClosed) {
      copy = await BookCopy.findOneAndUpdate(
        { book: book._id, status: 'AVAILABLE' },
        { $set: { status: 'ON_LOAN', lastBorrowedAt: daysAgo(fixture.issuedDaysAgo) }, $inc: { loanCount: 1 } },
        { new: true }
      );
      if (!copy) continue; // no free copy for this title; skip rather than fake it
    }

    const loan = await Loan.create({
      user: user._id,
      book: book._id,
      copy: copy?._id ?? null,
      type: 'PHYSICAL',
      issuedAt: daysAgo(fixture.issuedDaysAgo),
      dueAt: daysAhead(fixture.dueInDays),
      status: isClosed ? 'RETURNED' : fixture.overdue ? 'OVERDUE' : 'ACTIVE',
      returnedAt: isClosed ? daysAgo(fixture.returnedDaysAgo) : null,
      daysOverdueAtReturn: isClosed ? 0 : null,
      renewalCount: fixture.renewals ?? 0,
      renewalHistory: fixture.renewals
        ? [
            {
              at: daysAgo(fixture.issuedDaysAgo - 20),
              previousDueAt: daysAgo(fixture.issuedDaysAgo - 21),
              newDueAt: daysAhead(fixture.dueInDays),
            },
          ]
        : [],
    });

    if (copy) {
      copy.currentLoan = loan._id;
      await copy.save();
    }

    loans.push(loan);

    // Raise the fine using the SAME arithmetic the application uses, so the
    // seeded amounts can never disagree with what the app would calculate.
    if (fixture.overdue) {
      const daysOverdue = Math.abs(fixture.dueInDays);
      const amount = config.library.calculateOverdueFine(daysOverdue);

      if (amount > 0) {
        const fine = await Fine.create({
          user: user._id,
          loan: loan._id,
          book: book._id,
          reason: 'OVERDUE',
          amount,
          daysOverdue,
          chargeableDays: config.library.chargeableDays(daysOverdue),
          ratePerDay: config.library.fines.perDay,
          cappedAtMaximum: amount >= config.library.fines.maxPerLoan,
          description: `${daysOverdue} day(s) overdue, ${config.library.fines.graceDays} forgiven as grace`,
        });

        loan.fine = fine._id;
        await loan.save();
        fines.push(fine);
      }
    }
  }

  /**
   * Rebuild the denormalised counters from source.
   */
  logger.info('  reconciling loan counters…');

  for (const book of books) {
    await Book.recalculateInventory(book._id);
  }

  for (const user of users) {
    const activeLoans = await Loan.countDocuments({
      user: user._id,
      status: { $in: ['ACTIVE', 'OVERDUE'] },
    });
    const totalBorrowed = await Loan.countDocuments({ user: user._id });
    const { total: outstandingFine } = await Fine.outstandingTotalForUser(user._id);

    await User.updateOne(
      { _id: user._id },
      { $set: { 'stats.activeLoans': activeLoans, 'stats.totalBorrowed': totalBorrowed, 'stats.outstandingFine': outstandingFine } }
    );
  }

  const totalOwed = fines.reduce((sum, fine) => sum + fine.amount, 0);
  logger.info(
    `  created ${loans.length} loans and ${fines.length} fines (${config.library.fines.currency} ${totalOwed} outstanding)`
  );

  return { loans, fines };
};


/**
 * Reviews, reading lists and notifications.
 */
const seedEngagement = async ({ users, books }) => {
  logger.info('Seeding reviews, lists and notifications…');

  const members = users.filter((user) => user.role === 'MEMBER' && user.status === 'ACTIVE');

  const bodies = [
    'A genuinely absorbing read. The pacing takes a while to settle but it is worth staying with.',
    'Clear, well organised, and far more readable than I expected from a book this size.',
    'I picked this up on a recommendation and finished it in three sittings.',
    'Useful as a reference, though not something I would read end to end.',
    'The first half is excellent. The second meanders somewhat.',
    'Exactly what I needed for my coursework. The examples are especially good.',
    'Beautifully written. I have already lent my own copy to a friend.',
    'Dense in places, but the ideas repay the effort.',
  ];

  const reviews = [];

  /**
   * REVIEWS FROM ACTUAL BORROWERS FIRST.
   */
  const allLoans = await Loan.find().select('user book').lean();
  const seenPairs = new Set();

  for (let i = 0; i < allLoans.length; i += 1) {
    const loan = allLoans[i];
    const key = `${loan.user}:${loan.book}`;
    if (seenPairs.has(key)) continue;
    seenPairs.add(key);

    const rating = [5, 4, 5, 4, 3, 5, 4, 5][i % 8];

    try {
      const review = await Review.create({
        user: loan.user,
        book: loan.book,
        rating,
        title: rating >= 4 ? 'Glad I borrowed this' : 'Worth a look',
        body: bodies[i % bodies.length],
        // Verified by construction — this member demonstrably had this book.
        isVerifiedBorrower: true,
        status: 'APPROVED',
        aiModeration: { verdict: 'CLEAN', reasons: [], score: 0, usedAi: false, checkedAt: new Date() },
      });
      reviews.push(review);
    } catch (error) {
      if (error.code !== 11000) throw error;
    }
  }

  // Then fill in unverified reviews, so the badge distinguishes something.
  // Deterministic rather than random, so a reseed reproduces the same data.
  for (let b = 0; b < books.length; b += 1) {
    const reviewerCount = (b % 4) + 1;

    for (let r = 0; r < reviewerCount; r += 1) {
      const member = members[(b + r) % members.length];
      if (!member) continue;

      const rating = [5, 4, 5, 3, 4, 2, 5, 4][(b + r) % 8];

      const hasBorrowed = await Loan.exists({ user: member._id, book: books[b]._id });

      try {
        const review = await Review.create({
          user: member._id,
          book: books[b]._id,
          rating,
          title: rating >= 4 ? 'Well worth reading' : 'Mixed feelings',
          body: bodies[(b + r) % bodies.length],
          isVerifiedBorrower: Boolean(hasBorrowed),
          status: 'APPROVED',
          aiModeration: { verdict: 'CLEAN', reasons: [], score: 0, usedAi: false, checkedAt: new Date() },
        });
        reviews.push(review);
      } catch (error) {
        // Unique index on (user, book) — the deterministic spread can collide.
        if (error.code !== 11000) throw error;
      }
    }
  }

  // Rebuild every rating aggregate from the reviews just written.
  for (const book of books) {
    await Book.recalculateRating(book._id);
  }

  // Default shelves for everyone, plus some populated favourites.
  const lists = [];
  for (const user of users) {
    const created = await ReadingList.createDefaultsFor(user._id, DEFAULT_READING_LISTS);
    if (created) lists.push(...created);
  }

  let favouritesAdded = 0;
  for (let i = 0; i < members.length; i += 1) {
    const favourites = await ReadingList.favouritesFor(members[i]._id);
    if (!favourites) continue;

    const picks = [books[i % books.length], books[(i + 3) % books.length], books[(i + 7) % books.length]];
    const unique = [...new Map(picks.map((book) => [String(book._id), book])).values()];

    favourites.items = unique.map((book, position) => ({ book: book._id, position }));
    await favourites.save();

    for (const book of unique) {
      await Book.updateOne({ _id: book._id }, { $inc: { 'stats.favoriteCount': 1 } });
      favouritesAdded += 1;
    }
  }

  // A few unread notifications, so the notification centre is not empty.
  const notifications = [];
  for (const member of members.slice(0, 5)) {
    notifications.push(
      await Notification.create({
        user: member._id,
        type: 'WELCOME',
        title: 'Welcome to the library',
        body: 'Your account is ready. Browse the catalogue to get started.',
        channels: ['IN_APP'],
        emailStatus: 'SENT',
      })
    );
  }

  // Members with overdue items get a matching notification, so the in-app
  // record agrees with what the circulation data says.
  const overdueLoans = await Loan.find({ status: 'OVERDUE' }).populate('book', 'title');
  for (const loan of overdueLoans) {
    notifications.push(
      await Notification.create({
        user: loan.user,
        type: 'OVERDUE',
        title: 'You have an overdue item',
        body: `"${loan.book?.title}" was due on ${new Date(loan.dueAt).toDateString()}.`,
        data: { loanId: String(loan._id), bookId: String(loan.book?._id ?? loan.book) },
        channels: ['IN_APP', 'EMAIL'],
        emailStatus: 'SENT',
      })
    );
  }

  // Keep the members' cached review counts honest.
  for (const user of users) {
    const reviewCount = await Review.countDocuments({ user: user._id });
    await User.updateOne({ _id: user._id }, { $set: { 'stats.reviewCount': reviewCount } });
  }

  logger.info(
    `  created ${reviews.length} reviews, ${lists.length} lists (${favouritesAdded} favourites), ${notifications.length} notifications`
  );

  return { reviews, lists, notifications };
};

/**
 * The seed pipeline. Each phase appends its step here, and each receives the
 * accumulated context so later steps can reference earlier records.
 */
const runSeed = async () => {
  const context = {};

  context.users = await seedUsers();

  const taxonomy = await seedTaxonomy();
  context.authors = taxonomy.authors;
  context.publishers = taxonomy.publishers;
  context.categories = await seedCategories();
  context.books = await seedBooks(context);

  const circulation = await seedLoans(context);
  context.loans = circulation.loans;
  context.fines = circulation.fines;

  const engagement = await seedEngagement(context);
  context.reviews = engagement.reviews;
  context.readingLists = engagement.lists;

  // Phase 6: context.aiSummaries (pre-baked mocks, costing zero AI calls)

  return context;
};

/* Reporting */

/**
 * Print the demo credentials.
 */
const printCredentials = (context) => {
  const rows = [
    { label: 'Password (all)', value: SEED_PASSWORD },
    { label: '', value: '' },
  ];

  const byRole = {
    ADMIN: context.users.filter((u) => u.role === 'ADMIN'),
    LIBRARIAN: context.users.filter((u) => u.role === 'LIBRARIAN'),
    MEMBER: context.users.filter((u) => u.role === 'MEMBER'),
  };

  for (const [role, list] of Object.entries(byRole)) {
    if (list.length === 0) continue;
    rows.push({ label: role, value: '' });
    for (const user of list) {
      rows.push({
        label: '',
        value: `${user.email.padEnd(28)} ${user.membershipType}${user.status !== 'ACTIVE' ? ` (${user.status})` : ''}`,
      });
    }
    rows.push({ label: '', value: '' });
  }

  banner('DEMO ACCOUNTS — development only', rows);
};

const printSummary = async () => {
  const counts = await Promise.all(
    seededModels.map(async (model) => ({
      name: model.modelName,
      count: await model.countDocuments(),
    }))
  );

  logger.info('Seed complete:');
  for (const { name, count } of counts.filter((entry) => entry.count > 0)) {
    logger.info(`  ${String(count).padStart(5)} × ${name}`);
  }
};

/* Entry point */

const main = async () => {
  await connectDatabase();

  try {
    if (CLEAR_ONLY) {
      assertSafeToDestroy();
      await clearCollections();
      logger.info('Collections cleared. Nothing was seeded.');
      return;
    }

    if (FRESH) {
      assertSafeToDestroy();
      await clearCollections();
    } else if (await databaseHasData()) {
      // Refusing beats silently duplicating every record.
      logger.error(
        'The database already contains data. Use `npm run seed:fresh` to wipe and reseed, or `npm run seed:clear` to empty it.'
      );
      process.exitCode = 1;
      return;
    }

    const context = await runSeed();

    await printSummary();
    printCredentials(context);

    logger.info(`Start the server with \`npm run dev\` and sign in at ${config.app.url}${config.app.apiPrefix}/auth/login`);
  } finally {
    await disconnectDatabase();
    // Mongoose keeps the event loop alive; close it so the script exits.
    await mongoose.connection.close();
  }
};

main().catch(async (error) => {
  logger.error('Seeding failed', { error: error.message, stack: error.stack });
  await disconnectDatabase().catch(() => {});
  process.exit(1);
});
