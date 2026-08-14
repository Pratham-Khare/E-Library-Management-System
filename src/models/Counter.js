/**
 * COUNTER — atomic sequence allocation
 * Issues gap-free sequential numbers for membership cards and accession
 * numbers, safely under concurrency.
 *
 * WHY THIS EXISTS. Both of those numbers were previously derived from
 * `countDocuments() + 1`, which is a read-then-write and collides the moment
 * two requests run at once:
 *
 *     E11000 duplicate key error … membershipNumber: "LIB-2026-000008"
 *
 * That is not theoretical — it happens whenever a class signs up together, or
 * a script imports members in parallel. Probing for a free number narrows the
 * window but cannot close it, because all the concurrent callers read the same
 * state and pick the same candidate.
 *
 * `findOneAndUpdate` with `$inc` and `upsert` is ATOMIC on a single document,
 * so every caller receives a distinct value no matter how many run at once —
 * the same guarantee that makes the copy claim in BookCopy correct, applied to
 * a different problem.
 *
 * Human-readable sequential numbers are worth this small amount of machinery:
 * `LIB-2026-000042` is read aloud and typed at a physical desk in a way a UUID
 * is not.
 */

import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const counterSchema = new Schema(
  {
    /** The sequence name, e.g. `membershipNumber:2026` or `accessionNumber:2026`. */
    _id: { type: String, required: true },

    seq: { type: Number, default: 0 },
  },
  { versionKey: false }
);

/**
 * Allocate the next value in a sequence.
 *
 * Atomic: concurrent callers are serialised by MongoDB on this one document,
 * so no two ever receive the same number.
 */
counterSchema.statics.next = async function next(key, session = null) {
  const counter = await this.findOneAndUpdate(
    { _id: key },
    { $inc: { seq: 1 } },
    {
      upsert: true,
      new: true,
      // Ensures the upsert creates the document rather than failing when two
      // callers race to create the very first one.
      setDefaultsOnInsert: true,
      ...(session ? { session } : {}),
    }
  );

  return counter.seq;
};

/**
 * Set a sequence to a known value.
 *
 * Used by the seeder after clearing collections, so a reseeded database starts
 * numbering from 1 again rather than continuing to climb.
 */
counterSchema.statics.reset = function reset(key, value = 0) {
  return this.findOneAndUpdate({ _id: key }, { $set: { seq: value } }, { upsert: true, new: true });
};

export const Counter = model('Counter', counterSchema);

export default Counter;
