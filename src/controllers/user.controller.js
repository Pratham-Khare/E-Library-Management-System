/**
 * HTTP adapters for /users. All logic lives in user.service.js.
 */

import * as userService from '../services/user.service.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated } from '../utils/ApiResponse.js';
import {
  toSelf,
  toAdmin,
  forViewer,
  listForAdmin,
} from '../serializers/user.serializer.js';

/* Self-service */

/** The caller's own profile. */
export const getMe = asyncHandler(async (req, res) => ok(res, toSelf(req.user), 'Profile fetched'));

export const updateMe = asyncHandler(async (req, res) => {
  const user = await userService.updateProfile(req.user.id, req.body);
  return ok(res, toSelf(user), 'Profile updated');
});

export const updateNotificationPreferences = asyncHandler(async (req, res) => {
  const user = await userService.updateNotificationPreferences(req.user.id, req.body);
  return ok(
    res,
    Object.fromEntries(user.notificationPreferences),
    'Notification preferences updated'
  );
});

export const deactivateMe = asyncHandler(async (req, res) => {
  await userService.deactivateOwnAccount(req.user.id);
  return ok(res, null, 'Your account has been closed. Sign in again to reactivate it.');
});

/* Reading */

/**
 * One user.
 */
export const getUser = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.userId);
  return ok(res, forViewer(user, req.user), 'Member fetched');
});

/** Staff-facing member list. */
export const listUsers = asyncHandler(async (req, res) => {
  const { items, meta } = await userService.list(req.query);
  return paginated(res, listForAdmin(items), meta, 'Members fetched');
});

/* Administration */

export const changeRole = asyncHandler(async (req, res) => {
  const user = await userService.changeRole(req.params.userId, req.body.role, req.user);
  return ok(
    res,
    toAdmin(user),
    `Role changed to ${user.role}. All of this member's sessions have been revoked.`
  );
});

export const changeMembershipType = asyncHandler(async (req, res) => {
  const user = await userService.changeMembershipType(
    req.params.userId,
    req.body.membershipType,
    req.body.studentProfile
  );
  return ok(res, toAdmin(user), `Membership changed to ${user.membershipType}`);
});

export const suspendUser = asyncHandler(async (req, res) => {
  const user = await userService.suspend(req.params.userId, req.body.reason, req.user);
  return ok(res, toAdmin(user), 'Account suspended and all sessions revoked');
});

export const reactivateUser = asyncHandler(async (req, res) => {
  const user = await userService.reactivate(req.params.userId, req.user);
  return ok(res, toAdmin(user), 'Account reactivated');
});

export const verifyStudentProfile = asyncHandler(async (req, res) => {
  const user = await userService.verifyStudentProfile(req.params.userId);
  return ok(res, toAdmin(user), 'Academic details verified');
});

export const createStaff = asyncHandler(async (req, res) => {
  const user = await userService.createStaffAccount(req.body, req.user);
  return created(res, toAdmin(user), `${user.role} account created`);
});

export const forceLogout = asyncHandler(async (req, res) => {
  const result = await userService.forceLogout(req.params.userId);
  return ok(res, result, `Revoked ${result.revokedCount} session(s)`);
});

export default {
  getMe,
  updateMe,
  updateNotificationPreferences,
  deactivateMe,
  getUser,
  listUsers,
  changeRole,
  changeMembershipType,
  suspendUser,
  reactivateUser,
  verifyStudentProfile,
  createStaff,
  forceLogout,
};
