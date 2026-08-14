/**
 * ---------------------------------------------------------------------------
 * AUTHENTICATION MIDDLEWARE
 * ---------------------------------------------------------------------------
 * Verifies the access token and attaches the current user to `req.user`.
 *
 * THE DATABASE LOOKUP IS DELIBERATE. A JWT is self-contained, and the common
 * shortcut is to trust its claims and skip the query entirely — fast, but it
 * means a token stays fully valid for its whole lifetime no matter what
 * happens to the account behind it. Suspend a member and they keep borrowing.
 * Delete an account and its token still works. Change a password after a
 * breach and the attacker's session survives.
 *
 * So every authenticated request re-reads the user and checks:
 *
 *   1. the account still exists and is not soft-deleted
 *   2. the account is ACTIVE, not suspended
 *   3. the token was issued AFTER the last password change
 *
 * Check 3 is what makes "change password" genuinely sign out every device.
 * The cost is one indexed lookup by primary key — a fraction of a millisecond,
 * and worth it for revocation that actually works.
 * ---------------------------------------------------------------------------
 */

import { User } from '../models/User.js';
import { verifyAccessToken, extractBearerToken } from '../utils/tokens.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { USER_STATUS } from '../constants/roles.js';
import { asyncHandler } from '../utils/asyncHandler.js';

/**
 * Load and validate the user behind a verified token payload.
 * Shared by the required and optional variants.
 */
const loadUser = async (payload) => {
  const user = await User.findById(payload.sub).select('+passwordChangedAt');

  if (!user || user.isDeleted) {
    // Same message whether the account never existed or was deleted — no
    // reason to help someone enumerate valid user ids.
    throw ApiError.unauthorized(
      'This account is no longer available',
      ERROR_CODES.USER_NOT_FOUND
    );
  }

  if (user.status === USER_STATUS.SUSPENDED) {
    throw ApiError.forbidden(
      user.suspensionReason
        ? `Your account has been suspended: ${user.suspensionReason}`
        : 'Your account has been suspended. Please contact the library.',
      ERROR_CODES.ACCOUNT_SUSPENDED
    );
  }

  if (user.status === USER_STATUS.INACTIVE) {
    throw ApiError.forbidden(
      'This account is inactive. Please contact the library to reactivate it.',
      ERROR_CODES.ACCOUNT_INACTIVE
    );
  }

  // Reject any token minted before the password changed. `iat` is in seconds.
  if (!user.isTokenStillValid(payload.iat)) {
    throw ApiError.unauthorized(
      'Your password was changed. Please sign in again.',
      ERROR_CODES.TOKEN_EXPIRED
    );
  }

  return user;
};

/**
 * Require a valid access token.
 *
 * Attaches `req.user` — the Mongoose document, so downstream code can use its
 * methods and virtuals — plus `req.user.id` as a string for convenience.
 */
export const authenticate = asyncHandler(async (req, res, next) => {
  const token = extractBearerToken(req);

  if (!token) {
    throw ApiError.unauthorized(
      'Authentication required. Send your access token as: Authorization: Bearer <token>',
      ERROR_CODES.MISSING_TOKEN
    );
  }

  // Throws a typed ApiError distinguishing expired from invalid, which is what
  // lets a client decide between "refresh and retry" and "back to login".
  const payload = verifyAccessToken(token);

  req.user = await loadUser(payload);
  req.token = token;

  next();
});

/**
 * Authenticate IF a token is present, but do not require one.
 *
 * For endpoints that are public yet richer when signed in — a book listing
 * that also marks which titles are in your favourites, for instance. An
 * invalid token is treated as no token rather than an error, because the
 * caller did not claim to be authenticated in the first place.
 */
export const optionalAuthenticate = asyncHandler(async (req, res, next) => {
  const token = extractBearerToken(req);

  if (!token) return next();

  try {
    const payload = verifyAccessToken(token);
    req.user = await loadUser(payload);
    req.token = token;
  } catch {
    // Ignored on purpose. The request continues anonymously.
    req.user = undefined;
  }

  return next();
});

export default authenticate;
