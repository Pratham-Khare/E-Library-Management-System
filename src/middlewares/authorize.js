/**
 * ---------------------------------------------------------------------------
 * AUTHORISATION MIDDLEWARE
 * ---------------------------------------------------------------------------
 * Two distinct questions, and conflating them is a classic source of holes:
 *
 *   authorize(...)  — "does this ROLE permit the action at all?"
 *                     A librarian may view any member's loans.
 *
 *   requireOwner()  — "does this record belong to the CALLER?"
 *                     A member may view their OWN loans, and nobody else's.
 *
 * Role checks alone are the common mistake. `GET /users/:id/loans` guarded only
 * by `authenticate` lets any signed-in member read any other member's
 * borrowing history by changing one number in the URL — a real and frequent
 * vulnerability class (IDOR). The ownership guard is what closes it.
 * ---------------------------------------------------------------------------
 */

import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { ROLES, ROLE_RANK, STAFF_ROLES } from '../constants/roles.js';

/**
 * Restrict a route to specific roles.
 *
 *     router.post('/books', authenticate, authorize(ROLES.LIBRARIAN, ROLES.ADMIN), create);
 *
 * @param {...string} allowedRoles
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
 *
 * Prefer this over `authorize(LIBRARIAN, ADMIN)` when the intent is genuinely
 * "librarian and up" — it stays correct if a role is ever inserted into the
 * hierarchy, whereas an explicit list silently excludes the new one.
 *
 * @param {string} minimumRole
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
 *
 *     router.get('/users/:userId/loans', authenticate, requireOwnerOrStaff('userId'), list);
 *
 * `me` is accepted as an alias for the caller's own id and rewritten in place,
 * so a client can call `/users/me/loans` without first knowing its own id.
 *
 * @param {string} [paramName] Route parameter holding the user id.
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
 *
 * Takes a loader that fetches the record and returns the id of its owner. The
 * record is cached on `req.resource` so the handler does not fetch it twice.
 *
 *     router.patch('/reviews/:id',
 *       authenticate,
 *       requireResourceOwner(async (req) => {
 *         const review = await Review.findById(req.params.id);
 *         return review ? { resource: review, ownerId: review.user } : null;
 *       }),
 *       update);
 *
 * @param {(req) => Promise<{resource: object, ownerId: string}|null>} loader
 * @param {object} [options]
 * @param {boolean} [options.allowStaff] Whether staff bypass the check.
 * @param {string} [options.notFoundMessage]
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
