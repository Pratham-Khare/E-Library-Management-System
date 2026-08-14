/**
 * ---------------------------------------------------------------------------
 * BOOK MODEL — the bibliographic record
 * ---------------------------------------------------------------------------
 * A Book is a TITLE, not an object on a shelf. The library may hold six copies
 * of "Things Fall Apart"; that is ONE Book document and six BookCopy documents.
 *
 * Keeping them separate is what makes the rest of the system work: a review is
 * about the title, but a due date belongs to the specific copy someone took
 * home. Collapsing them would mean either duplicating the description six times
 * or having nowhere to record which copy is damaged.
 *
 * DENORMALISED COUNTERS. `inventory.availableCopies`, `rating.average` and
 * `stats.loanCount` could all be derived by aggregating other collections.
 * They are stored instead, because a catalogue search returning 20 books would
 * otherwise need 60 aggregations to render one page. They are maintained on
 * write and reconciled by a nightly job, so drift cannot accumulate silently.
 *
 * Availability is the one that matters most: it is read on every search, every
 * book page and every borrow attempt.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import slugify from 'slugify';
import config from '../config/index.js';
import { BOOK_STATUS, BOOK_STATUS_VALUES } from '../constants/enums.js';
import { parseIsbn } from '../utils/isbn.js';

const { Schema, model } = mongoose;

/* ===========================================================================
 * Sub-schemas
 * ======================================================================== */

/**
 * Aggregate rating.
 *
 * `distribution` stores the count per star value, because a 4.0 built from
 * forty 4-star reviews means something quite different from a 4.0 built from
 * twenty 5-star and twenty 3-star ones — and recomputing that histogram from
 * the Review collection on every book page would be absurd.
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
 * Physical stock levels, denormalised from BookCopy.
 *
 * `availableCopies` is decremented by the atomic copy claim during borrowing
 * and incremented on return. It is a CACHE of `countDocuments({ bookId,
 * status: AVAILABLE })` — the authoritative answer is always the BookCopy
 * collection, and the nightly reconciliation job resets this from it.
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
 * Digital lending.
 *
 * An ebook is not consumed by being read, so instead of copies it has
 * CONCURRENT LICENCES — a cap on simultaneous readers, which is how digital
 * lending actually works in real libraries and what keeps a digital loan
 * meaningful rather than an unlimited free-for-all.
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

/* ===========================================================================
 * Book schema
 * ======================================================================== */

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
     * BOTH ISBN formats are stored, normalised from whichever the cataloguer
     * supplied. Sparse unique indexes, because plenty of legitimate holdings
     * have no ISBN at all — anything published before 1970, most theses, and
     * locally bound material.
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

    /**
     * Free-text keywords beyond the formal category tree. Lowercased so that
     * "Fiction" and "fiction" are one tag rather than two.
     */
    tags: [{ type: String, trim: true, lowercase: true, maxlength: 60 }],

    /** Storage key for the cover image; resolved to a URL by the serializer. */
    coverImage: { type: String, default: null },

    /**
     * Replacement cost. Used to price a LOST fine — charging a flat fee for a
     * lost reference volume and a lost paperback alike is not defensible.
     */
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

    /**
     * Soft delete. A book with loan history can never be hard-deleted — the
     * circulation record would be orphaned, and that record is the library's,
     * not a cataloguer's to erase.
     */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/**
 * WEIGHTED TEXT INDEX — the backbone of catalogue search.
 *
 * Weights decide relevance: a search for "algorithms" should rank a book
 * TITLED "Algorithms" far above one that merely mentions the word in its
 * description. Without weights, MongoDB scores every field equally and the
 * results look arbitrary.
 *
 * MongoDB permits only ONE text index per collection, so every searchable
 * field has to live in this one.
 */
bookSchema.index(
  { title: 'text', subtitle: 'text', tags: 'text', description: 'text' },
  {
    weights: { title: 10, subtitle: 5, tags: 3, description: 1 },
    name: 'book_text_search',
  }
);

/**
 * PARTIAL unique indexes on both ISBNs.
 *
 * `sparse: true` would NOT be enough, and this is a genuinely easy mistake:
 * sparse skips documents where the field is ABSENT, but both ISBN fields
 * default to `null`, so every book has them. Under a sparse unique index the
 * SECOND book catalogued without an ISBN collides with the first on
 * `isbn13: null` — and plenty of legitimate holdings have no ISBN at all:
 * anything published before 1970, most theses, and locally bound material.
 *
 * `partialFilterExpression` restricts the constraint to books where the value
 * is actually a string, which is the intent.
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

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** Physical copies, populated on demand. */
bookSchema.virtual('copies', { ref: 'BookCopy', localField: '_id', foreignField: 'book' });

/** Ebook files, populated on demand. */
bookSchema.virtual('digitalAssets', {
  ref: 'DigitalAsset',
  localField: '_id',
  foreignField: 'book',
});

/** Is a physical copy on the shelf right now? */
bookSchema.virtual('isAvailable').get(function isAvailable() {
  return (this.inventory?.availableCopies ?? 0) > 0;
});

/** Is a digital licence free right now? */
bookSchema.virtual('isDigitallyAvailable').get(function isDigitallyAvailable() {
  if (!this.digital?.hasEbook) return false;
  return (this.digital.activeLicenses ?? 0) < (this.digital.concurrentLicenses ?? 0);
});

/** Digital licences currently free. */
bookSchema.virtual('availableLicenses').get(function availableLicenses() {
  if (!this.digital?.hasEbook) return 0;
  return Math.max(0, (this.digital.concurrentLicenses ?? 0) - (this.digital.activeLicenses ?? 0));
});

/* ===========================================================================
 * Hooks
 * ======================================================================== */

/**
 * Normalise ISBNs into both formats, and reject an invalid one.
 *
 * The check digit is verified rather than merely counting digits, because the
 * common cataloguing error is a transposed pair — which a checksum catches and
 * a length check does not.
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
 * Unique slug from the title.
 *
 * Book titles collide constantly — "Selected Poems" is not a rare title — so
 * the publication year is folded in before falling back to a counter, which
 * produces a far more useful URL than `selected-poems-7`.
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

/* ===========================================================================
 * Statics
 * ======================================================================== */

bookSchema.statics.findByIdOrSlug = function findByIdOrSlug(identifier) {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  return this.findOne({
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  });
};

/**
 * Recompute the denormalised rating aggregate from the Review collection.
 *
 * Called after a review is created, edited, deleted or moderated. Recomputing
 * from scratch rather than adjusting incrementally is deliberate: an
 * incremental update that misses one path drifts permanently, whereas a full
 * recount is self-correcting and cheap on the tens of reviews a book realistically has.
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
 * Recompute inventory counters from the BookCopy collection.
 *
 * The reconciliation that makes denormalisation safe. Run by the nightly job
 * and after any bulk inventory change, so a missed decrement somewhere cannot
 * become permanent corruption.
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
