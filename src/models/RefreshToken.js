/**
 * ---------------------------------------------------------------------------
 * REFRESH TOKEN MODEL
 * ---------------------------------------------------------------------------
 * One document per issued refresh token. This collection is what turns JWTs
 * from "unrevocable until expiry" into a session system you can actually
 * control.
 *
 * THREE DESIGN DECISIONS, each solving a specific attack:
 *
 * 1. TOKENS ARE STORED HASHED, never in plaintext.
 *    A refresh token is a 7-day credential. If the database leaks and tokens
 *    are stored raw, every one of them is immediately usable. Hashing means a
 *    leaked dump contains nothing an attacker can present. Same reasoning as
 *    password hashing — SHA-256 rather than bcrypt here because the token is
 *    already 256 bits of entropy, so there is nothing to brute-force and no
 *    reason to pay bcrypt's cost on every refresh.
 *
 * 2. ROTATION — every refresh mints a NEW token and revokes the old one.
 *    This bounds the damage from a stolen token: it works until the rightful
 *    owner next refreshes, at which point the thief's copy is dead.
 *
 * 3. REUSE DETECTION via token FAMILIES.
 *    Rotation alone cannot tell who the thief was. So every token descended
 *    from one login shares a `familyId`. Presenting an ALREADY-ROTATED token
 *    is proof of theft — a legitimate client always holds the newest one — and
 *    the response is to revoke the ENTIRE family, logging out both parties.
 *    The real user logs in again; the attacker is locked out for good.
 *
 *        login ──> tokenA (family F)
 *        refresh ──> tokenB (family F), A revoked
 *        refresh ──> tokenC (family F), B revoked
 *        attacker replays A  ──> A is revoked ==> THEFT ==> revoke all of F
 * ---------------------------------------------------------------------------
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

    /**
     * Groups every token descended from a single login.
     *
     * Rotation creates a chain: A -> B -> C. All three share a familyId, so
     * detecting reuse anywhere in the chain lets us revoke the whole session
     * in one update rather than walking the chain link by link.
     */
    familyId: {
      type: String,
      required: true,
      index: true,
    },

    /**
     * TTL index. MongoDB deletes the document automatically once this passes,
     * so expired tokens do not accumulate forever. Note the background reaper
     * runs about once a minute — expiry is still checked in code, because
     * "deleted eventually" is not the same as "invalid immediately".
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

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/** Revoke every live token in a family — the reuse-detection response. */
refreshTokenSchema.index({ familyId: 1, revokedAt: 1 });

/** List a user's active sessions, and revoke them all on logout-everywhere. */
refreshTokenSchema.index({ user: 1, revokedAt: 1 });

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** True when the token can still be exchanged. */
refreshTokenSchema.virtual('isActive').get(function isActive() {
  return this.revokedAt === null && this.expiresAt > new Date();
});

/* ===========================================================================
 * Statics
 * ======================================================================== */

/**
 * Hash a raw token for storage or lookup.
 *
 * SHA-256, not bcrypt. Bcrypt exists to make brute-forcing LOW-ENTROPY secrets
 * expensive; a 256-bit random token has nothing to brute-force. Using bcrypt
 * here would add ~100ms to every token refresh and buy nothing.
 */
refreshTokenSchema.statics.hashToken = function hashToken(rawToken) {
  return crypto.createHash('sha256').update(rawToken).digest('hex');
};

/** Look up a token by its raw value. */
refreshTokenSchema.statics.findByRawToken = function findByRawToken(rawToken) {
  return this.findOne({ tokenHash: this.hashToken(rawToken) });
};

/**
 * Revoke every unrevoked token in a family.
 *
 * The reuse-detection response, and deliberately blunt: when a token has been
 * stolen we cannot tell the thief's requests from the victim's, so both are
 * logged out. The victim re-authenticates with a password the attacker does
 * not have; the attacker is finished.
 *
 * @param {string} familyId
 * @param {string} reason
 * @param {import('mongoose').ClientSession|null} [session]
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
