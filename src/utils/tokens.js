/**
 * ---------------------------------------------------------------------------
 * JWT SIGNING & VERIFICATION
 * ---------------------------------------------------------------------------
 * All token minting and checking in one place, so no route can accidentally
 * sign with the wrong secret or skip a claim check.
 *
 * Four token types, each with its own secret (see config/jwt.js for why that
 * separation matters). Every token also carries a `type` claim that is checked
 * on verification — belt and braces, so even if two types ever shared a secret
 * by mistake, a download token still could not be presented as an access token.
 *
 * `algorithms: ['HS256']` on verify is a real security control, not a
 * formality: without it, jsonwebtoken would honour the `alg` header supplied
 * by the token itself, and a forged token claiming `alg: none` would verify
 * with no signature at all.
 * ---------------------------------------------------------------------------
 */

import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import jwtConfig, { TOKEN_TYPES } from '../config/jwt.js';
import { ApiError } from './ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';

export { TOKEN_TYPES };

/* ===========================================================================
 * Signing
 * ======================================================================== */

/**
 * Sign a token of a given type.
 *
 * @param {string} type One of TOKEN_TYPES.
 * @param {object} payload Claims to embed. Keep it SMALL — a JWT is sent on
 *   every request, and it is not encrypted, merely signed. Anything in here is
 *   readable by anyone holding the token.
 * @returns {string}
 */
export const signToken = (type, payload) =>
  jwt.sign({ ...payload, type }, jwtConfig.secretFor(type), jwtConfig.signOptions(type));

/**
 * Mint an access token.
 *
 * Carries the role so `authorize()` can make a decision without a database
 * round-trip on every request. The trade-off is that a role change does not
 * take effect until the token expires — bounded to 15 minutes, and the
 * authenticate middleware re-reads the user anyway for status and
 * password-change checks, so a suspended account is cut off immediately.
 *
 * @param {{ id: string, role: string, membershipType: string }} user
 */
export const signAccessToken = (user) =>
  signToken(TOKEN_TYPES.ACCESS, {
    sub: String(user.id ?? user._id),
    role: user.role,
    membershipType: user.membershipType,
  });

/**
 * Mint a password-reset token.
 *
 * The JWT is only half the mechanism: a matching hashed record is stored in
 * PasswordResetToken and marked used on redemption. The JWT alone could not be
 * single-use, because a signed token is valid until it expires no matter how
 * many times it is presented. The database row is what makes redemption final.
 *
 * @param {string} userId
 * @param {string} nonce Ties this JWT to its database record.
 */
export const signResetToken = (userId, nonce) =>
  signToken(TOKEN_TYPES.RESET, { sub: String(userId), nonce });

/**
 * Mint a short-lived signed download token for an ebook.
 *
 * Lets a client hand a URL straight to a browser's PDF viewer, which cannot
 * attach an Authorization header. The capability is scoped to one asset and
 * expires in minutes, so a leaked URL is worth very little.
 *
 * @param {{ userId: string, assetId: string, loanId: string }} params
 */
export const signDownloadToken = ({ userId, assetId, loanId }) =>
  signToken(TOKEN_TYPES.DOWNLOAD, {
    sub: String(userId),
    asset: String(assetId),
    loan: String(loanId),
    nonce: crypto.randomBytes(8).toString('hex'),
  });

/* ===========================================================================
 * Verification
 * ======================================================================== */

/**
 * Verify a token and confirm it is of the expected type.
 *
 * Throws an ApiError rather than letting the raw jsonwebtoken error escape, so
 * callers get a stable `code` and the client can distinguish "expired, refresh
 * and retry" from "invalid, send the user to login".
 *
 * @param {string} type Expected token type.
 * @param {string} token The raw JWT.
 * @returns {object} The decoded payload.
 */
export const verifyToken = (type, token) => {
  let decoded;

  try {
    decoded = jwt.verify(token, jwtConfig.secretFor(type), jwtConfig.verifyOptions());
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw ApiError.unauthorized(
        type === TOKEN_TYPES.ACCESS
          ? 'Your session has expired. Please refresh your token.'
          : 'This link has expired. Please request a new one.',
        type === TOKEN_TYPES.RESET ? ERROR_CODES.RESET_TOKEN_INVALID : ERROR_CODES.TOKEN_EXPIRED,
        { details: { expiredAt: error.expiredAt } }
      );
    }
    // Deliberately vague. Telling an attacker whether the signature, the
    // issuer or the audience failed helps them forge a better token next time.
    throw ApiError.unauthorized('Invalid or malformed token', ERROR_CODES.INVALID_TOKEN);
  }

  // Confirm the token is being used for what it was minted for.
  if (decoded.type !== type) {
    throw ApiError.unauthorized(
      'This token cannot be used for this operation',
      ERROR_CODES.INVALID_TOKEN
    );
  }

  return decoded;
};

export const verifyAccessToken = (token) => verifyToken(TOKEN_TYPES.ACCESS, token);
export const verifyResetToken = (token) => verifyToken(TOKEN_TYPES.RESET, token);
export const verifyDownloadToken = (token) => verifyToken(TOKEN_TYPES.DOWNLOAD, token);

/* ===========================================================================
 * Helpers
 * ======================================================================== */

/**
 * Pull the token out of an `Authorization: Bearer <token>` header.
 *
 * Returns null rather than throwing so the caller decides whether a missing
 * token is an error — optional authentication is a real case (a public book
 * listing that shows "in your favourites" only when signed in).
 *
 * @param {import('express').Request} req
 * @returns {string|null}
 */
export const extractBearerToken = (req) => {
  const header = req.headers.authorization;
  if (!header || typeof header !== 'string') return null;

  const [scheme, token] = header.split(' ');
  if (!/^Bearer$/i.test(scheme) || !token) return null;

  return token.trim() || null;
};

/**
 * Decode without verifying. For inspection only — reading an expired token's
 * claims for a log message, say. NEVER use this to make an authorisation
 * decision: the payload is attacker-controlled until the signature is checked.
 */
export const decodeTokenUnsafe = (token) => {
  try {
    return jwt.decode(token);
  } catch {
    return null;
  }
};

/**
 * Convert a duration string ("15m", "7d") into an absolute expiry Date.
 * Used to compute the `expiresAt` stored alongside a refresh token, which must
 * match the JWT's own expiry or the two disagree about when a session ends.
 *
 * @param {string} durationString
 * @returns {Date}
 */
export const expiryFromDuration = (durationString) => {
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|y)?$/i.exec(String(durationString).trim());
  if (!match) throw new Error(`Cannot parse duration: ${durationString}`);

  const value = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();

  const multipliers = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
    y: 31_536_000_000,
  };

  return new Date(Date.now() + value * multipliers[unit]);
};

export default {
  signToken,
  signAccessToken,
  signResetToken,
  signDownloadToken,
  verifyToken,
  verifyAccessToken,
  verifyResetToken,
  verifyDownloadToken,
  extractBearerToken,
  decodeTokenUnsafe,
  expiryFromDuration,
  TOKEN_TYPES,
};
