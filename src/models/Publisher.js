/**
 * Same reasoning as Author: a separate collection rather than a string field.
 *
 * Publishers matter to a library in ways a plain string cannot support —
 * acquisitions are negotiated per publisher, and "show me everything we hold
 * from Oxford University Press" is a real question that string matching answers
 * badly the moment someone types "OUP".
 */

import mongoose from 'mongoose';
import slugify from 'slugify';

const { Schema, model } = mongoose;

const publisherSchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Publisher name is required'],
      trim: true,
      minlength: [2, 'Publisher name must be at least 2 characters'],
      maxlength: [200, 'Publisher name cannot exceed 200 characters'],
    },

    slug: { type: String, unique: true, index: true, lowercase: true, trim: true },

    description: { type: String, trim: true, maxlength: 2000 },

    website: { type: String, trim: true, maxlength: 500 },

    foundedYear: {
      type: Number,
      min: [1400, 'Founding year predates printing'],
      max: [new Date().getFullYear(), 'Founding year cannot be in the future'],
    },

    address: {
      city: { type: String, trim: true, maxlength: 100 },
      country: { type: String, trim: true, maxlength: 100 },
    },

    /** Acquisitions contact, useful to a librarian ordering replacements. */
    contactEmail: { type: String, trim: true, lowercase: true, maxlength: 254 },

    bookCount: { type: Number, default: 0, min: 0 },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

publisherSchema.index({ name: 'text' }, { name: 'publisher_text_search' });
publisherSchema.index({ name: 1 });
publisherSchema.index({ bookCount: -1 });

/** Unique slug from the name. See Author for why the collision loop exists. */
publisherSchema.pre('validate', async function generateSlug(next) {
  if (!this.isModified('name') && this.slug) return next();

  const base = slugify(this.name, { lower: true, strict: true, trim: true });
  let candidate = base;
  let suffix = 1;

  // eslint-disable-next-line no-await-in-loop
  while (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  this.slug = candidate;
  return next();
});

publisherSchema.statics.findByIdOrSlug = function findByIdOrSlug(identifier) {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  return this.findOne({
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  });
};

export const Publisher = model('Publisher', publisherSchema);

export default Publisher;
