/**
 * All authentication business logic. Controllers do nothing but translate HTTP
 * to and from these functions.
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { User } from '../models/User.js';
import { RefreshToken } from '../models/RefreshToken.js';
import { PasswordResetToken } from '../models/PasswordResetToken.js';
import { hashPassword, verifyPassword } from '../utils/password.js';
import { signAccessToken, expiryFromDuration } from '../utils/tokens.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { ROLES, MEMBERSHIP_TYPES, USER_STATUS, COLLEGE_MEMBERSHIP_TYPES } from '../constants/roles.js';
import { NOTIFICATION_TYPE, DEFAULT_READING_LISTS } from '../constants/enums.js';
import mailService from './mail/index.js';

/* Token issuing */

/**
 * Mint an access/refresh pair and persist the refresh token's hash.
 */
const issueTokenPair = async (user, context = {}, familyId = null) => {
  const accessToken = signAccessToken(user);

  const rawRefreshToken = RefreshToken.generateRawToken();
  const tokenFamily = familyId ?? RefreshToken.generateFamilyId();

  const stored = await RefreshToken.create({
    tokenHash: RefreshToken.hashToken(rawRefreshToken),
    user: user._id,
    familyId: tokenFamily,
    expiresAt: expiryFromDuration(config.jwt.tokens.refresh.expiresIn),
    ip: context.ip ?? null,
    userAgent: context.userAgent ?? null,
  });

  return { accessToken, refreshToken: rawRefreshToken, refreshTokenDoc: stored, familyId: tokenFamily };
};

/* Registration */

/**
 * Register a new member.
 */
export const register = async (data, context = {}) => {
  const existing = await User.findOne({ email: data.email });
  if (existing) {
    throw ApiError.conflict(
      'An account with this email address already exists',
      ERROR_CODES.EMAIL_ALREADY_REGISTERED
    );
  }

  // Checked before insert so the caller gets a field-specific message rather
  // than a generic duplicate-key error translated after the fact. The unique
  // index remains the real guarantee under a race.
  if (data.studentProfile?.enrollmentNo) {
    const enrollmentTaken = await User.findOne({
      'studentProfile.enrollmentNo': data.studentProfile.enrollmentNo,
    });
    if (enrollmentTaken) {
      throw ApiError.conflict(
        'This enrolment number is already registered',
        ERROR_CODES.ENROLLMENT_NUMBER_TAKEN
      );
    }
  }

  // `createUnique` retries if the generated membership number was taken by a
  // concurrent registration — see the note on the static.
  const user = await User.createUnique({
    name: data.name,
    email: data.email,
    passwordHash: await hashPassword(data.password),
    role: ROLES.MEMBER, // never from input
    membershipType: data.membershipType ?? MEMBERSHIP_TYPES.PUBLIC,
    studentProfile: COLLEGE_MEMBERSHIP_TYPES.includes(data.membershipType)
      ? data.studentProfile
      : undefined,
    phone: data.phone,
    address: data.address,
  });

  /**
   * Create the four default shelves.
   */
  const { ensureDefaults } = await import('./readingList.service.js');
  ensureDefaults(user._id).catch((error) =>
    logger.warn('Could not create default reading lists', { error: error.message })
  );

  logger.info('New member registered', {
    userId: String(user._id),
    membershipType: user.membershipType,
    membershipNumber: user.membershipNumber,
  });

  // Best-effort, deliberately not awaited for its result: a SendGrid outage
  // must not fail a registration. The account is the point; the welcome email
  // is a courtesy.
  mailService
    .send(NOTIFICATION_TYPE.WELCOME, user.email, { user })
    .catch((error) => logger.warn('Welcome email failed', { error: error.message }));

  const tokens = await issueTokenPair(user, context);

  return { user, tokens, defaultReadingLists: DEFAULT_READING_LISTS };
};

/* Login */

/**
 * Authenticate with email and password.
 */
export const login = async ({ email, password }, context = {}) => {
  const user = await User.findForAuthentication(email);

  const passwordMatches = user
    ? await verifyPassword(password, user.passwordHash)
    : // Hash against a dummy value so an unknown email costs the same time as
      // a known one. The comparison result is discarded.
      await verifyPassword(password, '$2a$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy');

  if (!user || !passwordMatches) {
    logger.warn('Failed login attempt', { email, ip: context.ip });
    throw ApiError.unauthorized(
      'Incorrect email or password',
      ERROR_CODES.INVALID_CREDENTIALS
    );
  }

  // Status is checked only AFTER the password is confirmed. Reporting
  // "suspended" to someone who did not supply the right password would confirm
  // the account exists.
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

  // Fire-and-forget: a login must not wait on a bookkeeping write.
  User.updateOne(
    { _id: user._id },
    { $set: { lastLoginAt: new Date(), lastLoginIp: context.ip ?? null } }
  ).catch((error) => logger.warn('Could not record last login', { error: error.message }));

  const tokens = await issueTokenPair(user, context);

  logger.info('User logged in', { userId: String(user._id), role: user.role });

  return { user, tokens };
};

/* Refresh — rotation with reuse detection */

/**
 * Exchange a refresh token for a new pair.
 */
export const refresh = async (rawToken, context = {}) => {
  if (!rawToken) {
    throw ApiError.unauthorized('Refresh token is required', ERROR_CODES.REFRESH_TOKEN_INVALID);
  }

  const stored = await RefreshToken.findByRawToken(rawToken);

  if (!stored) {
    throw ApiError.unauthorized(
      'Invalid refresh token. Please sign in again.',
      ERROR_CODES.REFRESH_TOKEN_INVALID
    );
  }

  /* --- Reuse detected ------------------------------------------------ */
  if (stored.revokedAt !== null) {
    await RefreshToken.revokeFamily(stored.familyId, 'REUSE_DETECTED');

    logger.error('REFRESH TOKEN REUSE DETECTED — entire session family revoked', {
      userId: String(stored.user),
      familyId: stored.familyId,
      originallyRevokedAt: stored.revokedAt,
      originalReason: stored.revokedReason,
      replayIp: context.ip,
      replayUserAgent: context.userAgent,
      originalIp: stored.ip,
    });

    throw ApiError.unauthorized(
      'This session has been terminated for security reasons. Please sign in again.',
      ERROR_CODES.REFRESH_TOKEN_REUSED
    );
  }

  /* --- Expired -------------------------------------------------------- */
  // Checked in code as well as by the TTL index: MongoDB's reaper runs about
  // once a minute, so "will be deleted soon" is not "invalid now".
  if (stored.expiresAt <= new Date()) {
    throw ApiError.unauthorized(
      'Your session has expired. Please sign in again.',
      ERROR_CODES.REFRESH_TOKEN_EXPIRED
    );
  }

  const user = await User.findById(stored.user);

  if (!user || user.isDeleted || user.status !== USER_STATUS.ACTIVE) {
    await RefreshToken.revokeFamily(stored.familyId, 'ACCOUNT_SUSPENDED');
    throw ApiError.unauthorized(
      'This account is no longer active',
      ERROR_CODES.ACCOUNT_SUSPENDED
    );
  }

  /* --- Rotate --------------------------------------------------------- */
  // Stay within the SAME family, so the chain remains traceable and a later
  // replay of any link still triggers detection.
  const tokens = await issueTokenPair(user, context, stored.familyId);

  stored.revokedAt = new Date();
  stored.revokedReason = 'ROTATED';
  stored.replacedBy = tokens.refreshTokenDoc._id;
  stored.lastUsedAt = new Date();
  await stored.save();

  return { user, tokens };
};

/* Logout */

/**
 * Revoke one session.
 */
export const logout = async (rawToken) => {
  if (!rawToken) return { revoked: false };

  const stored = await RefreshToken.findByRawToken(rawToken);
  if (!stored || stored.revokedAt) return { revoked: false };

  stored.revokedAt = new Date();
  stored.revokedReason = 'LOGOUT';
  await stored.save();

  return { revoked: true };
};

/** Revoke every session for a user — "sign out everywhere". */
export const logoutAll = async (userId) => {
  const result = await RefreshToken.revokeAllForUser(userId, 'LOGOUT_ALL');
  logger.info('All sessions revoked', { userId: String(userId), count: result.modifiedCount });
  return { revokedCount: result.modifiedCount };
};

/** List active sessions, newest first, for a "where am I signed in?" view. */
export const listSessions = async (userId) =>
  RefreshToken.find({ user: userId, revokedAt: null, expiresAt: { $gt: new Date() } })
    .sort({ createdAt: -1 })
    .lean();

/** Revoke one specific session by id — "sign out that other device". */
export const revokeSession = async (userId, sessionId) => {
  const session = await RefreshToken.findOne({ _id: sessionId, user: userId });

  if (!session) {
    throw ApiError.notFound('No such session', ERROR_CODES.NOT_FOUND);
  }
  if (session.revokedAt) return { revoked: false };

  session.revokedAt = new Date();
  session.revokedReason = 'LOGOUT';
  await session.save();

  return { revoked: true };
};

/* Password reset */

/**
 * Begin a password reset.
 */
export const forgotPassword = async ({ email }, context = {}) => {
  const genericResponse = {
    message:
      'If an account exists for that email address, a password reset link has been sent to it.',
  };

  const user = await User.findOne({ email, isDeleted: false });

  if (!user || user.status === USER_STATUS.SUSPENDED) {
    logger.info('Password reset requested for an unknown or suspended account', { email });
    return genericResponse;
  }

  // Only the newest link should work, so anything outstanding is invalidated.
  await PasswordResetToken.invalidateAllForUser(user._id);

  const rawToken = PasswordResetToken.generateRawToken();

  await PasswordResetToken.create({
    tokenHash: PasswordResetToken.hashToken(rawToken),
    user: user._id,
    expiresAt: expiryFromDuration(config.jwt.tokens.reset.expiresIn),
    requestedFromIp: context.ip ?? null,
    requestedFromUserAgent: context.userAgent ?? null,
  });

  const resetUrl = `${config.app.url}/reset-password?token=${rawToken}`;
  const expiresInMinutes = Math.round(
    (expiryFromDuration(config.jwt.tokens.reset.expiresIn).getTime() - Date.now()) / 60_000
  );

  // The one place delivery failure is worth surfacing: a reset the user can
  // never receive is worse than an honest error.
  const result = await mailService.send(NOTIFICATION_TYPE.PASSWORD_RESET, user.email, {
    user,
    resetUrl,
    expiresInMinutes,
    requestIp: context.ip,
  });

  if (!result.success && !result.skipped) {
    logger.error('Password reset email could not be delivered', {
      userId: String(user._id),
      error: result.error,
    });
  }

  return {
    ...genericResponse,
    /**
     * Development and test only — NEVER production.
     */
    ...(config.app.isProduction ? {} : { devResetUrl: resetUrl, devToken: rawToken }),
  };
};

/**
 * Complete a password reset.
 */
export const resetPassword = async ({ token, password }) => {
  const stored = await PasswordResetToken.findByRawToken(token);

  // One message for unknown, used, invalidated and expired alike — the user
  // needs a new link in all four cases, and the distinctions only help someone
  // probing the endpoint.
  const invalid = () =>
    ApiError.badRequest(
      'This password reset link is invalid or has expired. Please request a new one.',
      ERROR_CODES.RESET_TOKEN_INVALID
    );

  if (!stored) throw invalid();
  if (stored.usedAt !== null) throw invalid();
  if (stored.invalidatedAt !== null) throw invalid();
  if (stored.expiresAt <= new Date()) throw invalid();

  const user = await User.findById(stored.user);
  if (!user || user.isDeleted) throw invalid();

  user.passwordHash = await hashPassword(password);
  user.passwordChangedAt = new Date();
  await user.save();

  // Mark spent BEFORE anything else can go wrong, so the link cannot be reused.
  stored.usedAt = new Date();
  await stored.save();
  await PasswordResetToken.invalidateAllForUser(user._id);

  await RefreshToken.revokeAllForUser(user._id, 'PASSWORD_CHANGED');

  logger.info('Password reset completed', { userId: String(user._id) });

  mailService
    .send(NOTIFICATION_TYPE.PASSWORD_CHANGED, user.email, { user, changedAt: new Date() })
    .catch((error) => logger.warn('Password-changed email failed', { error: error.message }));

  return { user };
};

/**
 * Change a password while signed in.
 */
export const changePassword = async (userId, { currentPassword, newPassword }) => {
  const user = await User.findById(userId).select('+passwordHash');
  if (!user) throw ApiError.notFound('Account not found', ERROR_CODES.USER_NOT_FOUND);

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    throw ApiError.badRequest(
      'Your current password is incorrect',
      ERROR_CODES.INCORRECT_PASSWORD
    );
  }

  user.passwordHash = await hashPassword(newPassword);
  user.passwordChangedAt = new Date();
  await user.save();

  // Every other session dies. `passwordChangedAt` additionally invalidates any
  // access token already in flight, so this takes effect instantly rather than
  // after the current 15-minute window.
  await RefreshToken.revokeAllForUser(user._id, 'PASSWORD_CHANGED');

  logger.info('Password changed', { userId: String(user._id) });

  mailService
    .send(NOTIFICATION_TYPE.PASSWORD_CHANGED, user.email, { user, changedAt: new Date() })
    .catch((error) => logger.warn('Password-changed email failed', { error: error.message }));

  return { user };
};

/* Bootstrap admin */

/**
 * Create the first administrator, if none exists.
 */
export const ensureBootstrapAdmin = async () => {
  if (!config.bootstrapAdmin.enabled) return { created: false, reason: 'disabled' };

  const adminCount = await User.countDocuments({ role: ROLES.ADMIN, isDeleted: false });
  if (adminCount > 0) return { created: false, reason: 'admin already exists' };

  // An account may already exist on this email with a lesser role.
  const existing = await User.findOne({ email: config.bootstrapAdmin.email });
  if (existing) {
    existing.role = ROLES.ADMIN;
    await existing.save();

    logger.warn('Promoted an existing account to ADMIN during bootstrap', {
      email: config.bootstrapAdmin.email,
    });
    return { created: false, promoted: true, user: existing };
  }

  const admin = await User.createUnique({
    name: config.bootstrapAdmin.name,
    email: config.bootstrapAdmin.email,
    passwordHash: await hashPassword(config.bootstrapAdmin.password),
    role: ROLES.ADMIN,
    membershipType: MEMBERSHIP_TYPES.FACULTY,
    status: USER_STATUS.ACTIVE,
  });

  logger.warn(
    `Bootstrap admin created: ${config.bootstrapAdmin.email} — CHANGE THIS PASSWORD after your first login.`
  );

  return { created: true, user: admin };
};

export default {
  register,
  login,
  refresh,
  logout,
  logoutAll,
  listSessions,
  revokeSession,
  forgotPassword,
  resetPassword,
  changePassword,
  ensureBootstrapAdmin,
};
