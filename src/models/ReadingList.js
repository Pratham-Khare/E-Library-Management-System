/**
 * Favourites, "want to read", "currently reading", "finished", and any custom
 * shelf a member names themselves.
 *
 * The four defaults are created automatically on registration and cannot be
 * renamed or deleted — a client can rely on every member having a FAVORITES
 * list without checking first, which removes a whole class of "create it if it
 * does not exist" logic from every call site.
 *
 * Books are stored as an EMBEDDED ARRAY rather than a separate join
 * collection. A reading list is read as a unit and rarely exceeds a few
 * hundred entries, so one document beats N+1 lookups. `maxItems` guards
 * against a list growing toward MongoDB's 16MB document ceiling.
 */

import mongoose from 'mongoose';
import crypto from 'node:crypto';
import { READING_LIST_TYPE, READING_LIST_TYPE_VALUES } from '../constants/enums.js';

const { Schema, model } = mongoose;

const listItemSchema = new Schema(
  {
    book: { type: Schema.Types.ObjectId, ref: 'Book', required: true },
    addedAt: { type: Date, default: Date.now },
    /** A member's own note — "recommended by Dr Iyer", "for the exam". */
    note: { type: String, trim: true, maxlength: 500, default: null },
    /** Manual ordering within the list. */
    position: { type: Number, default: 0 },
  },
  { _id: false }
);

const readingListSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    name: {
      type: String,
      required: true,
      trim: true,
      minlength: 1,
      maxlength: 100,
    },

    type: {
      type: String,
      enum: READING_LIST_TYPE_VALUES,
      default: READING_LIST_TYPE.CUSTOM,
    },

    description: { type: String, trim: true, maxlength: 500, default: null },

    items: [listItemSchema],

    /**
     * Public lists are readable by anyone holding the share slug.
     * Default false — a reading list says a lot about a person, and it should
     * be shared deliberately rather than by accident.
     */
    isPublic: { type: Boolean, default: false },

    /**
     * An unguessable slug for sharing.
     *
     * Random rather than derived from the name: a predictable slug would let
     * anyone enumerate other members' private lists by trying likely names.
     *
     * Uniqueness is enforced by a PARTIAL index below, not by `sparse: true`
     * here — see the note on that index for why the difference matters.
     */
    shareSlug: { type: String, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/** A member's lists, and the "is this book in my favourites?" lookup. */
readingListSchema.index({ user: 1, type: 1 });

/** A member cannot have two lists with the same name. */
readingListSchema.index({ user: 1, name: 1 }, { unique: true });

/**
 * Share slugs unique among lists that HAVE one. `sparse: true` would not work:
 * sparse skips ABSENT fields, but `shareSlug` defaults to null, so the second
 * unshared list would collide with the first.
 */
readingListSchema.index(
  { shareSlug: 1 },
  {
    unique: true,
    partialFilterExpression: { shareSlug: { $type: 'string' } },
    name: 'unique_share_slug_when_present',
  }
);

/** "Which lists contain this book?" — powers the favourite count on a book. */
readingListSchema.index({ 'items.book': 1 });

/* Virtuals */

readingListSchema.virtual('bookCount').get(function bookCount() {
  return this.items?.length ?? 0;
});

/** The four defaults are structural and cannot be renamed or deleted. */
readingListSchema.virtual('isDefault').get(function isDefault() {
  return this.type !== READING_LIST_TYPE.CUSTOM;
});

/* Statics */

/** Bound on list size, so one document cannot approach MongoDB's 16MB limit. */
readingListSchema.statics.MAX_ITEMS = 1000;

readingListSchema.statics.generateShareSlug = () => crypto.randomBytes(12).toString('hex');

/**
 * The four default shelves for a new member. `ordered: false` so one duplicate
 * cannot abort a signup.
 */
readingListSchema.statics.createDefaultsFor = async function createDefaultsFor(userId, defaults) {
  const documents = defaults.map(({ type, name }) => ({ user: userId, type, name, items: [] }));

  try {
    return await this.insertMany(documents, { ordered: false });
  } catch (error) {
    // Duplicate key means the shelves already exist. Not an error.
    if (error.code === 11000) return this.find({ user: userId });
    throw error;
  }
};

/** A member's favourites shelf. */
readingListSchema.statics.favouritesFor = function favouritesFor(userId) {
  return this.findOne({ user: userId, type: READING_LIST_TYPE.FAVORITES });
};

export const ReadingList = model('ReadingList', readingListSchema);

export default ReadingList;
