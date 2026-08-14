/**
 * ---------------------------------------------------------------------------
 * ROLES & MEMBERSHIP TYPES
 * ---------------------------------------------------------------------------
 * Two orthogonal axes describe a person in this system, and keeping them
 * separate is what lets one deployment serve both a public library and a
 * college library:
 *
 *   ROLE            — what you are ALLOWED TO DO (authorisation).
 *   MEMBERSHIP_TYPE — what BORROWING PRIVILEGES you get (policy).
 *
 * A librarian is a member too: they have role LIBRARIAN for the permissions,
 * and a membershipType for their own borrowing limits. Collapsing these into a
 * single "role" field would force awkward hybrids like STUDENT_LIBRARIAN.
 * ---------------------------------------------------------------------------
 */

/**
 * Authorisation roles, ordered from least to most privileged.
 * Used by the `authorize(...roles)` middleware.
 */
export const ROLES = Object.freeze({
  /** A library patron. Can browse, borrow, review, and manage their own data. */
  MEMBER: 'MEMBER',
  /** Library staff. Runs the circulation desk and manages the catalogue. */
  LIBRARIAN: 'LIBRARIAN',
  /** Full control, including user management, policy and audit logs. */
  ADMIN: 'ADMIN',
});

export const ROLE_VALUES = Object.freeze(Object.values(ROLES));

/**
 * Numeric rank for "at least this privileged" checks.
 * Higher number = more authority.
 */
export const ROLE_RANK = Object.freeze({
  [ROLES.MEMBER]: 1,
  [ROLES.LIBRARIAN]: 2,
  [ROLES.ADMIN]: 3,
});

/**
 * True when `role` is at least as privileged as `minimumRole`.
 * Prefer this over hard-coded role lists when a route should be open to
 * "librarian and up" — it stays correct if a role is inserted later.
 */
export const hasAtLeastRole = (role, minimumRole) =>
  (ROLE_RANK[role] ?? 0) >= (ROLE_RANK[minimumRole] ?? Number.POSITIVE_INFINITY);

/** Convenience groupings used across route definitions. */
export const STAFF_ROLES = Object.freeze([ROLES.LIBRARIAN, ROLES.ADMIN]);
export const ALL_ROLES = ROLE_VALUES;

/**
 * Borrowing-privilege tiers. Each maps to a row in config/library.js that
 * defines loan period, concurrent-loan cap and renewal allowance.
 */
export const MEMBERSHIP_TYPES = Object.freeze({
  /** General public patron. The default for open registration. */
  PUBLIC: 'PUBLIC',
  /** Enrolled college student. Requires studentProfile details. */
  STUDENT: 'STUDENT',
  /** College teaching or research staff. The most generous tier. */
  FACULTY: 'FACULTY',
});

export const MEMBERSHIP_TYPE_VALUES = Object.freeze(Object.values(MEMBERSHIP_TYPES));

/**
 * Membership types that represent a college affiliation and MAY therefore
 * carry a `studentProfile` (department, course, year, institutional email).
 */
export const COLLEGE_MEMBERSHIP_TYPES = Object.freeze([
  MEMBERSHIP_TYPES.STUDENT,
  MEMBERSHIP_TYPES.FACULTY,
]);

/**
 * Membership types for which an enrolment number is MANDATORY.
 *
 * Students only. A roll number is what identifies a student to their
 * institution, so requiring it is meaningful. Faculty are staff — many have an
 * employee ID and may record it here, but demanding one produces awkward
 * failures for no benefit: a FACULTY-tier administrator being demoted to
 * MEMBER would suddenly become invalid, blocking a legitimate role change on a
 * field nobody intended to require of them.
 */
export const ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES = Object.freeze([MEMBERSHIP_TYPES.STUDENT]);

/** Account lifecycle states. Only ACTIVE accounts may borrow or log in. */
export const USER_STATUS = Object.freeze({
  /** Normal, fully functional account. */
  ACTIVE: 'ACTIVE',
  /** Blocked by staff — login is refused with an explanatory message. */
  SUSPENDED: 'SUSPENDED',
  /** Self-deactivated or soft-deleted. Data retained for loan history. */
  INACTIVE: 'INACTIVE',
});

export const USER_STATUS_VALUES = Object.freeze(Object.values(USER_STATUS));
