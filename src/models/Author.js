/**
 * ---------------------------------------------------------------------------
 * AUTHOR MODEL
 * ---------------------------------------------------------------------------
 * Authors are their own collection rather than a string on Book.
 *
 * That costs a join on every book fetch, and buys three things a string cannot:
 * an author page listing everything they wrote, a biography stored once instead
 * of copied onto forty books, and immunity from the spelling drift that turns
 * "García Márquez", "Garcia Marquez" and "G. Marquez" into three different
 * authors nobody can search across.
 *
 * `bookCount` is denormalised because author lists are read constantly and a
 * `$lookup`-and-count on every request is a poor trade for a number that
 * changes only when a book is catalogued.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import slugify from 'slugify';

const { Schema, model } = mongoose;

const authorSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Author name is required'],
      trim: true,
      minlength: [2, 'Author name must be at least 2 characters'],
      maxlength: [200, 'Author name cannot exceed 200 characters'],
    },

    /**
     * URL-friendly identifier, generated from the name.
     * Lets a client use `/authors/chinua-achebe` instead of an opaque ObjectId.
     */
    slug: {
      type: String,
      unique: true,
      index: true,
      lowercase: true,
      trim: true,
    },

    bio: { type: String, trim: true, maxlength: [5000, 'Biography cannot exceed 5000 characters'] },

    /** Storage key for an uploaded photo; resolved to a URL by the serializer. */
    photo: { type: String, default: null },

    nationality: { type: String, trim: true, maxlength: 100 },

    /**
     * Years are plain numbers, not Dates. Catalogue records routinely know only
     * the year — "born 1930" — and a Date would force an invented month and day
     * that then displays as spuriously precise.
     */
    birthYear: { type: Number, min: [-3000, 'Year is implausible'], max: [new Date().getFullYear(), 'Birth year cannot be in the future'] },
    deathYear: { type: Number, min: [-3000, 'Year is implausible'], max: [new Date().getFullYear(), 'Death year cannot be in the future'] },

    website: { type: String, trim: true, maxlength: 500 },

    /** Denormalised count of ACTIVE, non-deleted books. Maintained on write. */
    bookCount: { type: Number, default: 0, min: 0 },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/** Author search, and the alphabetical browse list. */
authorSchema.index({ name: 'text' }, { name: 'author_text_search' });
authorSchema.index({ name: 1 });
/** "Most prolific authors" on the analytics dashboard. */
authorSchema.index({ bookCount: -1 });

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** "1930–2013", or "1930–" for a living author. Null when the years are unknown. */
authorSchema.virtual('lifespan').get(function lifespan() {
  if (!this.birthYear) return null;
  return `${this.birthYear}–${this.deathYear ?? ''}`;
});

/* ===========================================================================
 * Hooks
 * ======================================================================== */

/**
 * Generate a unique slug from the name.
 *
 * Two authors can genuinely share a name, and the slug is unique — so a
 * collision gets a numeric suffix (`john-smith-2`) rather than failing the
 * write. Only regenerated when the name changes, so an existing URL does not
 * break because someone fixed a typo in a biography.
 */
authorSchema.pre('validate', async function generateSlug(next) {
  if (!this.isModified('name') && this.slug) return next();

  const base = slugify(this.name, { lower: true, strict: true, trim: true });
  let candidate = base;
  let suffix = 1;

  // Loop rather than assume: the second "John Smith" needs -2, the third -3.
  // eslint-disable-next-line no-await-in-loop
  while (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  this.slug = candidate;
  return next();
});

/** Resolve an author by ObjectId or slug, so both work in a URL. */
authorSchema.statics.findByIdOrSlug = function findByIdOrSlug(identifier) {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  return this.findOne({
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  });
};

export const Author = model('Author', authorSchema);

export default Author;
