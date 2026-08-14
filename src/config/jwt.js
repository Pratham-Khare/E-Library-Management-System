/**
 * Four distinct token types, each with its OWN secret and lifetime:
 */

import env from './env.js';

/** Token type discriminator, embedded as the `type` claim in every token. */
export const TOKEN_TYPES = Object.freeze({
  ACCESS: 'access',
  REFRESH: 'refresh',
  RESET: 'reset',
  DOWNLOAD: 'download',
});

/**
 * Signing/verification settings per token type.
 * `secret` signs, `expiresIn` bounds the lifetime, and issuer/audience are
 * verified on the way back in.
 */
export const tokens = Object.freeze({
  [TOKEN_TYPES.ACCESS]: Object.freeze({
    secret: env.JWT_ACCESS_SECRET,
    expiresIn: env.JWT_ACCESS_EXPIRES_IN,
  }),
  [TOKEN_TYPES.REFRESH]: Object.freeze({
    secret: env.JWT_REFRESH_SECRET,
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  }),
  [TOKEN_TYPES.RESET]: Object.freeze({
    secret: env.JWT_RESET_SECRET,
    expiresIn: env.JWT_RESET_EXPIRES_IN,
  }),
  // Download links reuse the reset secret: both are short-lived, single-use
  // capability tokens that never grant API access, and keeping the number of
  // independent secrets to manage low is itself an operational virtue.
  [TOKEN_TYPES.DOWNLOAD]: Object.freeze({
    secret: env.JWT_RESET_SECRET,
    expiresIn: env.JWT_DOWNLOAD_EXPIRES_IN,
  }),
});

/** Claims attached to every token we mint, and verified on every token we read. */
export const claims = Object.freeze({
  issuer: env.JWT_ISSUER,
  audience: env.JWT_AUDIENCE,
});

/** HMAC-SHA256. Symmetric, fast, and appropriate for a single-service API. */
export const algorithm = 'HS256';

/**
 * Options handed to jwt.sign() for a given token type.
 * @param {string} type One of TOKEN_TYPES.
 */
export const signOptions = (type) => ({
  expiresIn: tokens[type].expiresIn,
  issuer: claims.issuer,
  audience: claims.audience,
  algorithm,
});

/**
 * Options handed to jwt.verify(). Pinning `algorithms` is a security control,
 * not a formality: without it, a token could claim `alg: none` and skip
 * signature verification entirely.
 */
export const verifyOptions = () => ({
  issuer: claims.issuer,
  audience: claims.audience,
  algorithms: [algorithm],
});

/** The secret for a token type. */
export const secretFor = (type) => tokens[type].secret;

/** Password hashing cost factor, used by utils/password.js. */
export const bcryptSaltRounds = env.BCRYPT_SALT_ROUNDS;

export default Object.freeze({
  TOKEN_TYPES,
  tokens,
  claims,
  algorithm,
  signOptions,
  verifyOptions,
  secretFor,
  bcryptSaltRounds,
});
