/**
 * ---------------------------------------------------------------------------
 * PASSWORD RESET TOKEN MODEL
 * ---------------------------------------------------------------------------
 * Single-use, short-lived tokens backing the forgot-password flow.
 *
 * A reset token is the most dangerous credential the system issues: it grants
 * full account takeover, and it travels through EMAIL — plaintext, stored on
 * someone else's servers, and likely to sit in an inbox for years. Four
 * properties follow from that:
 *
 *   1. HASHED AT REST     — the raw token exists only in the email. A database
 *                           leak yields nothing usable.
 *   2. SHORT-LIVED        — 30 minutes by default. An old email is inert.
 *   3. SINGLE-USE         — `usedAt` is stamped on redemption, so a forwarded
 *                           or intercepted link cannot be replayed.
 *   4. SUPERSEDING        — requesting a new reset invalidates outstanding
 *                           ones, so only the newest email ever works.
 *
 * Kept in its own collection rather than as fields on User so the TTL index
 * can clean up expired tokens automatically, and so a reset request never
 * writes to the User document at all.
 * ---------------------------------------------------------------------------
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const passwordResetTokenSchema = new Schema(
  {
    /** SHA-256 of the raw token. The raw value goes only into the email. */
    tokenHash: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },

    user: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },

    /** TTL index — MongoDB removes the document once this passes. */
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },

    /** Stamped on redemption. Non-null means the token is spent. */
    usedAt: { type: Date, default: null },

    /** Set when a newer reset request supersedes this one. */
    invalidatedAt: { type: Date, default: null },

    /**
     * Where the request came from. Included in the reset email ("this request
     * came from …") so a user who did not initiate it can recognise that.
     */
    requestedFromIp: { type: String, default: null },
    requestedFromUserAgent: { type: String, default: null, maxlength: 500 },
  },
  { timestamps: true }
);

/** Invalidate a user's outstanding tokens when a new request arrives. */
passwordResetTokenSchema.index({ user: 1, usedAt: 1, invalidatedAt: 1 });

/** True when the token can still be redeemed. */
passwordResetTokenSchema.virtual('isRedeemable').get(function isRedeemable() {
  return this.usedAt === null && this.invalidatedAt === null && this.expiresAt > new Date();
});

/** Hash a raw token for storage or lookup. See RefreshToken for why SHA-256. */
passwordResetTokenSchema.statics.hashToken = function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

passwordResetTokenSchema.statics.generateRawToken = function generateRawToken() {
  return crypto.randomBytes(32).toString('hex');
};

passwordResetTokenSchema.statics.findByRawToken = function findByRawToken(rawToken) {
  return this.findOne({ tokenHash: this.hashToken(rawToken) });
};

/**
 * Invalidate every outstanding token for a user.
 *
 * Called when a NEW reset is requested (only the latest email should work) and
 * after a successful reset (so a second link in the same inbox is dead).
 */
passwordResetTokenSchema.statics.invalidateAllForUser = function invalidateAllForUser(userId) {
  return this.updateMany(
    { user: userId, usedAt: null, invalidatedAt: null },
    { $set: { invalidatedAt: new Date() } }
  );
};

export const PasswordResetToken = model('PasswordResetToken', passwordResetTokenSchema);

export default PasswordResetToken;
