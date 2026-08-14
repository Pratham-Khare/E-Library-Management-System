/**
 * Profile management for members, and account administration for staff.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import {
  ROLES,
  USER_STATUS,
  COLLEGE_MEMBERSHIP_TYPES,
  ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES,
} from '../constants/roles.js';
import { NOTIFICATION_TYPE } from '../constants/enums.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import { escapeRegex } from '../utils/sanitize.js';
import mailService from './mail/index.js';

/** Fields a member list may be sorted by. Anything else is ignored — sorting
 *  on an arbitrary field means an unindexed collection scan. */
const SORTABLE_FIELDS = ['name', 'email', 'createdAt', 'lastLoginAt', 'stats.outstandingFine', 'stats.totalBorrowed'];

/* Reading */

/**
 * Fetch one user.
 * @param {boolean} [includeDeleted] Staff may look at soft-deleted accounts.
 */
export const getById = async (userId, includeDeleted = false) => {
  const filter = { _id: userId };
  if (!includeDeleted) filter.isDeleted = false;

  const user = await User.findOne(filter);
  if (!user) throw ApiError.notFound('No such member', ERROR_CODES.USER_NOT_FOUND);

  return user;
};

/**
 * Staff-facing member list with filtering, search and pagination.
 *
 * @param {object} query Validated query parameters.
 */
export const list = async (query) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, SORTABLE_FIELDS, { createdAt: -1 });

  const filter = {};

  // Soft-deleted accounts are hidden unless explicitly requested.
  filter.isDeleted = query.includeDeleted === true ? { $in: [true, false] } : false;

  if (query.role) filter.role = query.role;
  if (query.membershipType) filter.membershipType = query.membershipType;
  if (query.status) filter.status = query.status;
  if (query.department) filter['studentProfile.department'] = query.department;

  // Members who owe money — the fines dashboard.
  if (query.hasOutstandingFines === true) {
    filter['stats.outstandingFine'] = { $gt: 0 };
  }

  /**
   * Free-text search across name, email and enrolment number.
   */
  if (query.search) {
    const pattern = new RegExp(escapeRegex(query.search), 'i');
    filter.$or = [
      { name: pattern },
      { email: pattern },
      { membershipNumber: pattern },
      { 'studentProfile.enrollmentNo': pattern },
    ];
  }

  return paginateQuery(User, filter, { sort, page, limit, skip });
};

/* Self-service */

/**
 * Update one's own profile.
 */
export const updateProfile = async (userId, data) => {
  const user = await getById(userId);

  if (data.name !== undefined) user.name = data.name;
  if (data.phone !== undefined) user.phone = data.phone;
  if (data.preferredLanguage !== undefined) user.preferredLanguage = data.preferredLanguage;

  if (data.address) {
    user.address = { ...(user.address?.toObject?.() ?? user.address ?? {}), ...data.address };
  }

  /**
   * Academic details may be corrected, but ONLY by a college member, and the
   * enrolment number is checked for uniqueness first. Editing it also clears
   * `verifiedAt`: staff verified the OLD details, and that verification does
   * not carry over to a changed enrolment number.
   */
  if (data.studentProfile) {
    if (!COLLEGE_MEMBERSHIP_TYPES.includes(user.membershipType)) {
      throw ApiError.badRequest(
        'Academic details only apply to student and faculty memberships',
        ERROR_CODES.VALIDATION_ERROR
      );
    }

    const incoming = data.studentProfile;

    if (incoming.enrollmentNo && incoming.enrollmentNo !== user.studentProfile?.enrollmentNo) {
      const taken = await User.findOne({
        'studentProfile.enrollmentNo': incoming.enrollmentNo,
        _id: { $ne: user._id },
      });
      if (taken) {
        throw ApiError.conflict(
          'This enrolment number is already registered to another member',
          ERROR_CODES.ENROLLMENT_NUMBER_TAKEN
        );
      }
      user.studentProfile.verifiedAt = null;
    }

    Object.assign(user.studentProfile, incoming);
  }

  await user.save();
  return user;
};

/** Update notification preferences for one or more notification types. */
export const updateNotificationPreferences = async (userId, preferences) => {
  const user = await getById(userId);

  for (const [type, setting] of Object.entries(preferences)) {
    const existing = user.notificationPreferences.get(type) ?? { inApp: true, email: true };
    user.notificationPreferences.set(type, { ...existing, ...setting });
  }

  await user.save();
  return user;
};

/**
 * Self-deactivation.
 */
export const deactivateOwnAccount = async (userId) => {
  const user = await getById(userId);

  if ((user.stats?.activeLoans ?? 0) > 0) {
    throw ApiError.conflict(
      `Please return your ${user.stats.activeLoans} borrowed item(s) before closing your account`,
      ERROR_CODES.CONFLICT
    );
  }

  if ((user.stats?.outstandingFine ?? 0) > 0) {
    throw ApiError.conflict(
      `Please settle your outstanding balance of ${config.library.fines.currency} ${user.stats.outstandingFine} before closing your account`,
      ERROR_CODES.OUTSTANDING_FINES
    );
  }

  // An administrator closing their own account could leave nobody in charge.
  if (user.role === ROLES.ADMIN) {
    const adminCount = await User.countAdmins();
    if (adminCount <= 1) {
      throw ApiError.conflict(
        'You are the only administrator. Promote another account before closing this one.',
        ERROR_CODES.LAST_ADMIN_PROTECTED
      );
    }
  }

  user.status = USER_STATUS.INACTIVE;
  user.isDeleted = true;
  user.deletedAt = new Date();
  await user.save();

  await RefreshToken.revokeAllForUser(user._id, 'LOGOUT_ALL');

  logger.info('Member deactivated their own account', { userId: String(user._id) });
  return user;
};

/* Administration */

/**
 * Change a user's role.
 */
export const changeRole = async (targetUserId, newRole, actor) => {
  if (String(targetUserId) === String(actor.id)) {
    throw ApiError.forbidden(
      'You cannot change your own role. Ask another administrator to do it.',
      ERROR_CODES.FORBIDDEN
    );
  }

  const user = await getById(targetUserId);

  if (user.role === newRole) return user;

  if (user.role === ROLES.ADMIN && newRole !== ROLES.ADMIN) {
    const adminCount = await User.countAdmins();
    if (adminCount <= 1) {
      throw ApiError.conflict(
        'This is the only administrator account. Promote another before demoting it.',
        ERROR_CODES.LAST_ADMIN_PROTECTED
      );
    }
  }

  const previousRole = user.role;
  user.role = newRole;
  await user.save();

  /**
   * Revoke every session. The role is embedded in the access token, so an
   * existing token would keep granting the OLD permissions until it expired.
   * For a demotion that is a 15-minute window in which a removed administrator
   * still holds administrative access.
   */
  await RefreshToken.revokeAllForUser(user._id, 'LOGOUT_ALL');

  logger.warn('User role changed', {
    userId: String(user._id),
    from: previousRole,
    to: newRole,
    actorId: String(actor.id),
  });

  return user;
};

/** Change a member's borrowing tier, which changes their loan entitlements. */
export const changeMembershipType = async (targetUserId, membershipType, studentProfile) => {
  const user = await getById(targetUserId);

  const needsEnrollment = ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES.includes(membershipType);
  const isStaff = user.role === ROLES.LIBRARIAN || user.role === ROLES.ADMIN;

  // Mirrors the model invariant, so the caller gets a clear message rather
  // than a translated Mongoose error.
  if (needsEnrollment && !isStaff && !studentProfile?.enrollmentNo && !user.studentProfile?.enrollmentNo) {
    throw ApiError.badRequest(
      `An enrolment number is required for ${membershipType} membership`,
      ERROR_CODES.STUDENT_PROFILE_REQUIRED
    );
  }

  user.membershipType = membershipType;
  if (studentProfile) {
    user.studentProfile = { ...(user.studentProfile?.toObject?.() ?? {}), ...studentProfile };
  }

  await user.save();

  logger.info('Membership type changed', {
    userId: String(user._id),
    membershipType,
  });

  return user;
};

/**
 * Suspend an account.
 */
export const suspend = async (targetUserId, reason, actor) => {
  if (String(targetUserId) === String(actor.id)) {
    throw ApiError.forbidden('You cannot suspend your own account', ERROR_CODES.FORBIDDEN);
  }

  const user = await getById(targetUserId);

  if (user.role === ROLES.ADMIN) {
    const adminCount = await User.countAdmins();
    if (adminCount <= 1) {
      throw ApiError.conflict(
        'This is the only administrator account and cannot be suspended',
        ERROR_CODES.LAST_ADMIN_PROTECTED
      );
    }
  }

  user.status = USER_STATUS.SUSPENDED;
  user.suspensionReason = reason;
  user.suspendedAt = new Date();
  user.suspendedBy = actor.id;
  await user.save();

  await RefreshToken.revokeAllForUser(user._id, 'ACCOUNT_SUSPENDED');

  logger.warn('Account suspended', {
    userId: String(user._id),
    reason,
    actorId: String(actor.id),
  });

  mailService
    .send(NOTIFICATION_TYPE.ACCOUNT_SUSPENDED, user.email, { user, reason })
    .catch((error) => logger.warn('Suspension email failed', { error: error.message }));

  return user;
};

/** Lift a suspension. */
export const reactivate = async (targetUserId, actor) => {
  const user = await getById(targetUserId, true);

  user.status = USER_STATUS.ACTIVE;
  user.suspensionReason = null;
  user.suspendedAt = null;
  user.suspendedBy = null;
  user.isDeleted = false;
  user.deletedAt = null;
  await user.save();

  logger.info('Account reactivated', { userId: String(user._id), actorId: String(actor.id) });

  return user;
};

/** Mark a student's academic details as checked and correct. */
export const verifyStudentProfile = async (targetUserId) => {
  const user = await getById(targetUserId);

  if (!user.studentProfile?.enrollmentNo) {
    throw ApiError.badRequest(
      'This member has no academic details to verify',
      ERROR_CODES.STUDENT_PROFILE_REQUIRED
    );
  }

  user.studentProfile.verifiedAt = new Date();
  await user.save();

  return user;
};

/**
 * Create a staff account.
 */
export const createStaffAccount = async (data, actor) => {
  const { hashPassword } = await import('../utils/password.js');

  const existing = await User.findOne({ email: data.email });
  if (existing) {
    throw ApiError.conflict(
      'An account with this email address already exists',
      ERROR_CODES.EMAIL_ALREADY_REGISTERED
    );
  }

  const user = await User.createUnique({
    name: data.name,
    email: data.email,
    passwordHash: await hashPassword(data.password),
    role: data.role,
    membershipType: data.membershipType,
    phone: data.phone,
  });

  logger.warn('Staff account created', {
    userId: String(user._id),
    role: user.role,
    actorId: String(actor.id),
  });

  return user;
};

/** Force-revoke every session for a user, without suspending the account. */
export const forceLogout = async (targetUserId) => {
  const result = await RefreshToken.revokeAllForUser(targetUserId, 'LOGOUT_ALL');
  return { revokedCount: result.modifiedCount };
};

export default {
  getById,
  list,
  updateProfile,
  updateNotificationPreferences,
  deactivateOwnAccount,
  changeRole,
  changeMembershipType,
  suspend,
  reactivate,
  verifyStudentProfile,
  createStaffAccount,
  forceLogout,
};
