/**
 * The bibliographic record. A Book is a TITLE, not an object on a shelf: six
 * copies of "Things Fall Apart" is one Book and six BookCopy documents.
 *
 * `inventory`, `rating` and `stats` are denormalised — derivable by aggregating
 * other collections, but a search returning 20 books would need 60 aggregations
 * to render one page. Maintained on write, reconciled by the nightly job.
 */

import mongoose from 'mongoose';
import slugify from 'slugify';
import config from '../config/index.js';
import { BOOK_STATUS, BOOK_STATUS_VALUES } from '../constants/enums.js';
import { parseIsbn } from '../utils/isbn.js';

const { Schema, model } = mongoose;

/* Sub-schemas */

/**
 * Aggregate rating. `distribution` keeps the per-star histogram, because a 4.0
 * from forty 4-star reviews is not the same as one from twenty 5s and twenty 3s.
 */
const ratingSchema = new Schema(
  {
    average: { type: Number, default: 0, min: 0, max: 5 },
    count: { type: Number, default: 0, min: 0 },
    distribution: {
      1: { type: Number, default: 0, min: 0 },
      2: { type: Number, default: 0, min: 0 },
      3: { type: Number, default: 0, min: 0 },
      4: { type: Number, default: 0, min: 0 },
      5: { type: Number, default: 0, min: 0 },
    },
  },
  { _id: false }
);

/**
 * Physical stock, denormalised from BookCopy. A cache — the authoritative
 * answer is always the BookCopy collection, and the nightly job resets this.
 */
const inventorySchema = new Schema(
  {
    /** Every copy on the books, including lost and withdrawn ones. */
    totalCopies: { type: Number, default: 0, min: 0 },
    /** Copies with status AVAILABLE right now. The number search filters on. */
    availableCopies: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/**
 * Digital lending. An ebook is not consumed by being read, so instead of copies
 * it has concurrent licences: a cap on simultaneous readers.
 */
const digitalSchema = new Schema(
  {
    hasEbook: { type: Boolean, default: false },
    /** Maximum simultaneous readers. */
    concurrentLicenses: {
      type: Number,
      default: () => config.library.digital.defaultConcurrentLicenses,
      min: 0,
    },
    /** Licences currently in use. Incremented on borrow, released on expiry. */
    activeLicenses: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/** Read-only usage counters, for ranking and analytics. */
const statsSchema = new Schema(
  {
    /** Lifetime loans. Drives "most borrowed" and the popularity sort. */
    loanCount: { type: Number, default: 0, min: 0 },
    viewCount: { type: Number, default: 0, min: 0 },
    favoriteCount: { type: Number, default: 0, min: 0 },
    lastBorrowedAt: { type: Date, default: null },
  },
  { _id: false }
);

/* Book schema */

const bookSchema = new Schema(
  {
    /* --- Bibliographic ------------------------------------------------ */

    title: {
      type: String,
      required: [true, 'Title is required'],
      trim: true,
      minlength: [1, 'Title cannot be empty'],
      maxlength: [500, 'Title cannot exceed 500 characters'],
    },

    subtitle: { type: String, trim: true, maxlength: 500 },

    slug: { type: String, unique: true, index: true, lowercase: true, trim: true },

    /**
     * Both formats stored, normalised from whichever was supplied. Indexed
     * partially, not sparsely — see the index definition below.
     */
    isbn10: { type: String, trim: true, uppercase: true, default: null },
    isbn13: { type: String, trim: true, default: null },

    authors: [{ type: Schema.Types.ObjectId, ref: 'Author', index: true }],

    publisher: { type: Schema.Types.ObjectId, ref: 'Publisher', default: null, index: true },

    categories: [{ type: Schema.Types.ObjectId, ref: 'Category', index: true }],

    /** ISO 639-1 code. Two letters, lowercased. */
    language: { type: String, trim: true, lowercase: true, default: 'en', maxlength: 10 },

    edition: { type: String, trim: true, maxlength: 100 },

    publishedYear: {
      type: Number,
      min: [-3000, 'Publication year is implausible'],
      max: [new Date().getFullYear() + 1, 'Publication year cannot be in the future'],
      index: true,
    },

    pageCount: { type: Number, min: [1, 'Page count must be at least 1'], max: 50_000 },

    description: { type: String, trim: true, maxlength: 10_000 },

    /** Free-text keywords beyond the category tree. Lowercased, so "Fiction" and "fiction" are one tag. */
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],

    /** Storage key for the cover image; resolved to a URL by the serializer. */
    coverImage: { type: String, default: null },

    /** Replacement cost, used to price a LOST fine. */
    price: { type: Number, min: 0, default: null },
    currency: { type: String, default: () => config.library.fines.currency, maxlength: 3 },

    /* --- Denormalised aggregates --------------------------------------- */

    rating: { type: ratingSchema, default: () => ({}) },
    inventory: { type: inventorySchema, default: () => ({}) },
    digital: { type: digitalSchema, default: () => ({}) },
    stats: { type: statsSchema, default: () => ({}) },

    /* --- Lifecycle ------------------------------------------------------ */

    status: {
      type: String,
      enum: { values: BOOK_STATUS_VALUES, message: '{VALUE} is not a valid book status' },
      default: BOOK_STATUS.ACTIVE,
      index: true,
    },

    /** Who catalogued it. Useful when a record needs querying months later. */
    addedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    /** Soft delete — a book with loan history can never be hard-deleted. */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/**
 * Weighted text index — the backbone of catalogue search. Weights decide
 * relevance: a book TITLED "Algorithms" must outrank one that mentions the word
 * in its description. MongoDB allows only one text index, so everything
 * searchable lives here.
 */
bookSchema.index(
  { title: 'text', subtitle: 'text', tags: 'text', description: 'text' },
  {
    weights: { title: 10, subtitle: 5, tags: 3, description: 1 },
    name: 'book_text_search',
  }
);

/**
 * PARTIAL unique indexes on both ISBNs — `sparse: true` is not enough, and the
 * difference is an easy mistake. Sparse skips documents where the field is
 * ABSENT, but both fields default to null, so the second book catalogued
 * without an ISBN would collide with the first on `isbn13: null`. Plenty of
 * legitimate holdings have no ISBN: anything pre-1970, theses, bound material.
 */
bookSchema.index(
  { isbn13: 1 },
  { unique: true, partialFilterExpression: { isbn13: { $type: 'string' } }, name: 'unique_isbn13_when_present' }
);
bookSchema.index(
  { isbn10: 1 },
  { unique: true, partialFilterExpression: { isbn10: { $type: 'string' } }, name: 'unique_isbn10_when_present' }
);

/** The default catalogue listing: active books, newest first. */
bookSchema.index({ status: 1, isDeleted: 1, createdAt: -1 });

/** Faceted browse — books in a category, best rated first. */
bookSchema.index({ categories: 1, status: 1, 'rating.average': -1 });
bookSchema.index({ authors: 1, status: 1 });

/** "Available now" filtering, and the most-borrowed feed. */
bookSchema.index({ 'inventory.availableCopies': -1, status: 1 });
bookSchema.index({ 'stats.loanCount': -1 });
bookSchema.index({ 'rating.average': -1, 'rating.count': -1 });

/** Autocomplete: a prefix match on title needs an ordinary index, not the text one. */
bookSchema.index({ title: 1 });

/* Virtuals */

bookSchema.virtual('copies', { ref: 'BookCopy', localField: '_id', foreignField: 'book' });

bookSchema.virtual('digitalAssets', {
  ref: 'DigitalAsset',
  localField: '_id',
  foreignField: 'book',
});

bookSchema.virtual('isAvailable').get(function isAvailable() {
  return (this.inventory?.availableCopies ?? 0) > 0;
});

bookSchema.virtual('isDigitallyAvailable').get(function isDigitallyAvailable() {
  if (!this.digital?.hasEbook) return false;
  return (this.digital.activeLicenses ?? 0) < (this.digital.concurrentLicenses ?? 0);
});

bookSchema.virtual('availableLicenses').get(function availableLicenses() {
  if (!this.digital?.hasEbook) return 0;
  return Math.max(0, (this.digital.concurrentLicenses ?? 0) - (this.digital.activeLicenses ?? 0));
});

/* Hooks */

/**
 * Normalise ISBNs into both formats, rejecting an invalid one. The check digit
 * is verified, not just the length — the common cataloguing error is a
 * transposed pair, which a checksum catches and a length check does not.
 */
bookSchema.pre('validate', function normalizeIsbns(next) {
  const supplied = this.isbn13 || this.isbn10;
  if (!supplied) return next();

  if (!this.isModified('isbn13') && !this.isModified('isbn10')) return next();

  const parsed = parseIsbn(supplied);

  if (!parsed.valid) {
    this.invalidate(
      this.isbn13 ? 'isbn13' : 'isbn10',
      `"${supplied}" is not a valid ISBN — the check digit does not match, which usually means a mistyped or transposed digit`
    );
    return next();
  }

  // Store both, so a search on either format finds this book.
  this.isbn13 = parsed.isbn13;
  this.isbn10 = parsed.isbn10;

  return next();
});

/**
 * Unique slug from the title. Titles collide constantly, so the publication
 * year is folded in before falling back to a counter.
 */
bookSchema.pre('validate', async function generateSlug(next) {
  if (!this.isModified('title') && this.slug) return next();

  const base = slugify(this.title, { lower: true, strict: true, trim: true }).slice(0, 80);
  let candidate = base;
  let suffix = 1;

  if (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
    if (this.publishedYear) {
      candidate = `${base}-${this.publishedYear}`;
    }
    // eslint-disable-next-line no-await-in-loop
    while (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
      suffix += 1;
      candidate = `${base}-${this.publishedYear ? `${this.publishedYear}-` : ''}${suffix}`;
    }
  }

  this.slug = candidate;
  return next();
});

/** Deduplicate tags, so ["Fiction","fiction"] does not become two. */
bookSchema.pre('save', function dedupeTags(next) {
  if (this.tags?.length) {
    this.tags = [...new Set(this.tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  }
  return next();
});

/* Statics */

bookSchema.statics.findByIdOrSlug = function findByIdOrSlug(identifier) {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  return this.findOne({
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  });
};

/**
 * Recompute the rating aggregate from Review. Recomputed in full rather than
 * adjusted incrementally: an incremental update that misses one path drifts
 * permanently, a full recount is self-correcting.
 */
bookSchema.statics.recalculateRating = async function recalculateRating(bookId) {
  const Review = model('Review');

  const [result] = await Review.aggregate([
    { $match: { book: new mongoose.Types.ObjectId(String(bookId)), status: 'APPROVED' } },
    {
      $group: {
        _id: null,
        average: { $avg: '$rating' },
        count: { $sum: 1 },
        // One pass produces the whole histogram; a second aggregation would be waste.
        one: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
        two: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        three: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        four: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        five: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
      },
    },
  ]);

  const rating = result
    ? {
        average: Math.round(result.average * 100) / 100,
        count: result.count,
        distribution: {
          1: result.one,
          2: result.two,
          3: result.three,
          4: result.four,
          5: result.five,
        },
      }
    : { average: 0, count: 0, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } };

  await this.updateOne({ _id: bookId }, { $set: { rating } });
  return rating;
};

/**
 * Recompute inventory from BookCopy — the reconciliation that makes
 * denormalisation safe. Run nightly and after any bulk inventory change.
 */
bookSchema.statics.recalculateInventory = async function recalculateInventory(bookId) {
  const BookCopy = model('BookCopy');

  const [counts] = await BookCopy.aggregate([
    { $match: { book: new mongoose.Types.ObjectId(String(bookId)) } },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        available: { $sum: { $cond: [{ $eq: ['$status', 'AVAILABLE'] }, 1, 0] } },
      },
    },
  ]);

  const inventory = {
    totalCopies: counts?.total ?? 0,
    availableCopies: counts?.available ?? 0,
  };

  await this.updateOne({ _id: bookId }, { $set: { inventory } });
  return inventory;
};

export const Book = model('Book', bookSchema);

export default Book;
