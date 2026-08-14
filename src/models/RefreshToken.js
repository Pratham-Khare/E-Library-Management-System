/**
 * One document per issued refresh token — what turns JWTs from "unrevocable
 * until expiry" into a session system you can control.
 *
 * Three decisions, each solving a specific attack:
 *
 * 1. Tokens are stored HASHED, so a leaked dump contains nothing presentable.
 *    SHA-256, not bcrypt: the token is already 256 bits of entropy.
 * 2. ROTATION — every refresh mints a new token and revokes the old, bounding
 *    the damage from a stolen one.
 * 3. REUSE DETECTION — every token descended from one login shares a
 *    `familyId`. Presenting an already-rotated token is proof of theft, since
 *    a legitimate client always holds the newest, so the whole family is
 *    revoked. The real user signs in again; the attacker is locked out.
 */

import crypto from 'node:crypto';
import mongoose from 'mongoose';

const { Schema, model } = mongoose;

const refreshTokenSchema = new Schema(
  {
    /**
     * SHA-256 of the raw token. The raw value is returned to the client once,
     * at issue time, and never stored anywhere.
     */
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

    /** Groups every token descended from one login, so reuse anywhere in the chain revokes the session in one update. */
    familyId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * TTL index, so expired tokens do not accumulate. Expiry is still checked
     * in code — the reaper runs about once a minute, and "deleted eventually"
     * is not "invalid immediately".
     */
    expiresAt: {
      type: Date,
      required: true,
      index: { expires: 0 },
    },

    /** Set when the token is rotated away or explicitly revoked. */
    revokedAt: { type: Date, default: null },

    /**
     * Why it was revoked. Diagnostically valuable: a family revoked for
     * REUSE_DETECTED is a security event worth investigating, one revoked for
     * LOGOUT is routine.
     */
    revokedReason: {
      type: String,
      enum: ['ROTATED', 'LOGOUT', 'LOGOUT_ALL', 'REUSE_DETECTED', 'PASSWORD_CHANGED', 'ACCOUNT_SUSPENDED'],
      default: null,
    },

    /** The token that superseded this one. Makes the rotation chain walkable. */
    replacedBy: { type: Schema.Types.ObjectId, ref: 'RefreshToken', default: null },

    /**
     * Where the session came from. Shown in a "your active sessions" list, and
     * useful context when investigating a reuse-detection event.
     */
    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 500 },

    lastUsedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

/* Indexes */

/** Revoke every live token in a family — the reuse-detection response. */
refreshTokenSchema.index({ familyId: 1, revokedAt: 1 });

/** List a user's active sessions, and revoke them all on logout-everywhere. */
refreshTokenSchema.index({ user: 1, revokedAt: 1 });

/* Virtuals */

/** True when the token can still be exchanged. */
refreshTokenSchema.virtual('isActive').get(function isActive() {
  return this.revokedAt === null && this.expiresAt > new Date();
});

/* Statics */

/**
 * SHA-256, not bcrypt. Bcrypt makes brute-forcing low-entropy secrets
 * expensive; a 256-bit random token has nothing to brute-force, and bcrypt
 * would add ~100ms to every refresh.
 */
refreshTokenSchema.statics.hashToken = function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

/** Look up a token by its raw value. */
refreshTokenSchema.statics.findByRawToken = function findByRawToken(rawToken) {
  return this.findOne({ tokenHash: this.hashToken(rawToken) });
};

/**
 * Revoke every unrevoked token in a family — the reuse-detection response.
 * Deliberately blunt: the thief's requests cannot be told from the victim's,
 * so both are logged out and only the victim can sign back in.
 */
refreshTokenSchema.statics.revokeFamily = function revokeFamily(familyId, reason, session = null) {
  return this.updateMany(
    { familyId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
    session ? { session } : {}
  );
};

/** Revoke every live token for a user — logout-everywhere, or on suspension. */
refreshTokenSchema.statics.revokeAllForUser = function revokeAllForUser(userId, reason, session = null) {
  return this.updateMany(
    { user: userId, revokedAt: null },
    { $set: { revokedAt: new Date(), revokedReason: reason } },
    session ? { session } : {}
  );
};

/** Generate a new random token and a fresh family id. */
refreshTokenSchema.statics.generateRawToken = function generateRawToken() {
  // 48 bytes = 384 bits. Comfortably beyond any feasible guessing attack.
  return crypto.randomBytes(48).toString('hex');
};

refreshTokenSchema.statics.generateFamilyId = function generateFamilyId() {
  return crypto.randomUUID();
};

export const RefreshToken = model('RefreshToken', refreshTokenSchema);

export default RefreshToken;
