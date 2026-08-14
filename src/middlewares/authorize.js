/**
 * Two distinct questions, and conflating them is a classic source of holes:
 */

import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { ROLES, ROLE_RANK, STAFF_ROLES } from '../constants/roles.js';

/**
 * Restrict a route to specific roles.
 *
 *     router.post('/books', authenticate, authorize(ROLES.LIBRARIAN, ROLES.ADMIN), create);
 */
export const authorize =
  (...allowedRoles) =>
  (req, res, next) => {
    // A programming error, not a client one: authorize() without authenticate()
    // in front of it would otherwise silently allow everyone through.
    if (!req.user) {
      return next(
        ApiError.unauthorized('Authentication required', ERROR_CODES.MISSING_TOKEN)
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        ApiError.forbidden(
          `This action requires ${allowedRoles.length === 1 ? 'the' : 'one of the'} ${allowedRoles.join(' or ')} role${allowedRoles.length === 1 ? '' : 's'}`,
          ERROR_CODES.INSUFFICIENT_ROLE
        )
      );
    }

    return next();
  };

/**
 * Require at least a given role, by rank.
 */
export const requireMinimumRole = (minimumRole) => (req, res, next) => {
  if (!req.user) {
    return next(ApiError.unauthorized('Authentication required', ERROR_CODES.MISSING_TOKEN));
  }

  const callerRank = ROLE_RANK[req.user.role] ?? 0;
  const requiredRank = ROLE_RANK[minimumRole] ?? Number.POSITIVE_INFINITY;

  if (callerRank < requiredRank) {
    return next(
      ApiError.forbidden(
        `This action requires at least the ${minimumRole} role`,
        ERROR_CODES.INSUFFICIENT_ROLE
      )
    );
  }

  return next();
};

/** Convenience: library staff (LIBRARIAN or ADMIN). */
export const requireStaff = authorize(...STAFF_ROLES);

/** Convenience: administrators only. */
export const requireAdmin = authorize(ROLES.ADMIN);

/**
 * Require that the caller owns the resource identified by a route parameter —
 * unless they are staff, who are permitted to act on any member's records.
 */
export const requireOwnerOrStaff =
  (paramName = 'userId') =>
  (req, res, next) => {
    if (!req.user) {
      return next(ApiError.unauthorized('Authentication required', ERROR_CODES.MISSING_TOKEN));
    }

    // Rewrite `/users/me/...` to the caller's real id so every handler
    // downstream deals with an ObjectId and never has to special-case 'me'.
    if (req.params[paramName] === 'me') {
      req.params[paramName] = String(req.user.id);
      return next();
    }

    if (STAFF_ROLES.includes(req.user.role)) return next();

    if (String(req.params[paramName]) !== String(req.user.id)) {
      return next(
        ApiError.forbidden(
          'You can only access your own records',
          ERROR_CODES.NOT_RESOURCE_OWNER
        )
      );
    }

    return next();
  };

/**
 * Ownership check for resources that are not addressed by user id — a review,
 * a reading list, a loan.
 */
export const requireResourceOwner =
  (loader, options = {}) =>
  async (req, res, next) => {
    const { allowStaff = true, notFoundMessage = 'Resource not found' } = options;

    try {
      if (!req.user) {
        return next(ApiError.unauthorized('Authentication required', ERROR_CODES.MISSING_TOKEN));
      }

      const loaded = await loader(req);

      if (!loaded) {
        return next(ApiError.notFound(notFoundMessage, ERROR_CODES.NOT_FOUND));
      }

      req.resource = loaded.resource;

      if (allowStaff && STAFF_ROLES.includes(req.user.role)) return next();

      if (String(loaded.ownerId) !== String(req.user.id)) {
        // Deliberately 403 and not 404. A 404 would hide the resource's
        // existence, but these ids are not secrets and a clear "not yours" is
        // far easier to debug against than a phantom missing record.
        return next(
          ApiError.forbidden(
            'You do not own this resource',
            ERROR_CODES.NOT_RESOURCE_OWNER
          )
        );
      }

      return next();
    } catch (error) {
      return next(error);
    }
  };

export default authorize;
