/**
 * ---------------------------------------------------------------------------
 * USER ROUTES  —  /api/v1/users
 * ---------------------------------------------------------------------------
 * ROUTE ORDER MATTERS HERE. Express matches in declaration order, so the
 * literal `/me` routes MUST come before the `/:userId` pattern — otherwise
 * `/users/me` matches `/users/:userId` with `userId = "me"` and every handler
 * downstream has to special-case it.
 *
 * Note the layered guards on the parameterised routes:
 *
 *     authenticate           — who are you?
 *     requireOwnerOrStaff    — is this record yours, or are you staff?
 *     validate               — is the input well-formed?
 *
 * The ownership guard is what stops a signed-in member reading another
 * member's contact details and borrowing history by changing one id in the
 * URL. A role check alone would not.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import * as userController from '../../controllers/user.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStaff, requireAdmin, requireOwnerOrStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { updateProfileSchema } from '../../validators/auth.validator.js';
import {
  listUsersQuery,
  userIdParamSchema,
  changeRoleSchema,
  changeMembershipSchema,
  suspendUserSchema,
  createStaffSchema,
  notificationPreferencesSchema,
} from '../../validators/user.validator.js';

const router = Router();

// Everything under /users requires authentication.
router.use(authenticate);

/* ===========================================================================
 * Self-service — must be declared before /:userId
 * ======================================================================== */

/**
 * @openapi
 * /users/me:
 *   get:
 *     tags: [Users]
 *     summary: Get your own profile
 *     responses:
 *       200: { description: 'Your profile, including borrowing entitlements and statistics.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *   patch:
 *     tags: [Users]
 *     summary: Update your own profile
 *     description: >
 *       Updates name, phone, address, preferred language and academic details.
 *       `email`, `role`, `membershipType` and `status` cannot be changed here —
 *       they are stripped from the request body. Email changes need a verified
 *       flow; the rest are staff-controlled.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:  { type: string, example: Ananya Sharma }
 *               phone: { type: string, example: '+91 98765 43210' }
 *               address:
 *                 type: object
 *                 properties:
 *                   line1:      { type: string }
 *                   city:       { type: string }
 *                   state:      { type: string }
 *                   postalCode: { type: string }
 *               preferredLanguage: { type: string, example: en }
 *     responses:
 *       200: { description: 'Profile updated.' }
 *       409: { description: 'Enrolment number already taken.' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.get('/me', userController.getMe);
router.patch('/me', validate({ body: updateProfileSchema }), userController.updateMe);

/**
 * @openapi
 * /users/me/notification-preferences:
 *   patch:
 *     tags: [Users]
 *     summary: Update your notification preferences
 *     description: >
 *       Partial update — only the notification types you send are changed.
 *       Anything omitted keeps its current setting.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             additionalProperties:
 *               type: object
 *               properties:
 *                 inApp: { type: boolean }
 *                 email: { type: boolean }
 *             example:
 *               DUE_SOON: { email: false }
 *               OVERDUE:  { inApp: true, email: true }
 *     responses:
 *       200: { description: 'Preferences updated.' }
 */
router.patch(
  '/me/notification-preferences',
  validate({ body: notificationPreferencesSchema }),
  userController.updateNotificationPreferences
);

/**
 * @openapi
 * /users/me:
 *   delete:
 *     tags: [Users]
 *     summary: Close your account
 *     description: >
 *       Soft delete — loan history is retained, since it is the library's
 *       record rather than the member's. Refused while items are on loan or
 *       fines are unpaid.
 *     responses:
 *       200: { description: 'Account closed.' }
 *       409: { description: 'Outstanding loans or fines prevent closure.' }
 */
router.delete('/me', userController.deactivateMe);

/* ===========================================================================
 * Staff
 * ======================================================================== */

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List members (staff only)
 *     description: >
 *       Search across name, email, membership number and enrolment number, with
 *       filters for role, membership type, status, department and outstanding
 *       fines.
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Partial match on name, email, membership number or enrolment number.
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [MEMBER, LIBRARIAN, ADMIN] }
 *       - in: query
 *         name: membershipType
 *         schema: { type: string, enum: [PUBLIC, STUDENT, FACULTY] }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [ACTIVE, SUSPENDED, INACTIVE] }
 *       - in: query
 *         name: hasOutstandingFines
 *         schema: { type: boolean }
 *         description: Only members who currently owe money.
 *       - in: query
 *         name: sort
 *         schema: { type: string, example: '-stats.outstandingFine' }
 *     responses:
 *       200: { description: 'Paginated member list.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get('/', requireStaff, validate({ query: listUsersQuery }), userController.listUsers);

/**
 * @openapi
 * /users/staff:
 *   post:
 *     tags: [Users]
 *     summary: Create a staff account (admin only)
 *     description: >
 *       The only way to create a LIBRARIAN or ADMIN. Public registration always
 *       produces a MEMBER, so staff accounts cannot be self-created.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, role]
 *             properties:
 *               name:     { type: string, example: Ravi Menon }
 *               email:    { type: string, format: email }
 *               password: { type: string }
 *               role:     { type: string, enum: [LIBRARIAN, ADMIN] }
 *     responses:
 *       201: { description: 'Staff account created.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 *       409: { description: 'Email already registered.' }
 */
router.post('/staff', requireAdmin, validate({ body: createStaffSchema }), userController.createStaff);

/**
 * @openapi
 * /users/{userId}:
 *   get:
 *     tags: [Users]
 *     summary: Get a member
 *     description: >
 *       Members may fetch only their own record; staff may fetch any. The
 *       response shape depends on who is asking — another member sees name and
 *       avatar only, staff see the full record.
 *       Pass `me` to refer to yourself.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *         description: A member id, or `me`.
 *     responses:
 *       200: { description: 'The member.' }
 *       403: { description: 'You can only access your own records (NOT_RESOURCE_OWNER).' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.get(
  '/:userId',
  requireOwnerOrStaff('userId'),
  validate({ params: userIdParamSchema }),
  userController.getUser
);

/**
 * @openapi
 * /users/{userId}/role:
 *   patch:
 *     tags: [Users]
 *     summary: Change a member's role (admin only)
 *     description: >
 *       Revokes every session for that member, because the role is embedded in
 *       the access token — otherwise a demoted administrator would keep
 *       administrative access until their token expired.
 *       You cannot change your own role, and the last remaining administrator
 *       cannot be demoted.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [role]
 *             properties:
 *               role: { type: string, enum: [MEMBER, LIBRARIAN, ADMIN] }
 *     responses:
 *       200: { description: 'Role changed and sessions revoked.' }
 *       403: { description: 'Cannot change your own role.' }
 *       409: { description: 'Cannot demote the only administrator (LAST_ADMIN_PROTECTED).' }
 */
router.patch(
  '/:userId/role',
  requireAdmin,
  validate({ params: userIdParamSchema, body: changeRoleSchema }),
  userController.changeRole
);

/**
 * @openapi
 * /users/{userId}/membership:
 *   patch:
 *     tags: [Users]
 *     summary: Change a member's borrowing tier (staff only)
 *     description: >
 *       Changes loan period, concurrent-loan cap and renewal allowance.
 *       Moving a patron to STUDENT or FACULTY requires an enrolment number.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [membershipType]
 *             properties:
 *               membershipType: { type: string, enum: [PUBLIC, STUDENT, FACULTY] }
 *               studentProfile:
 *                 type: object
 *                 properties:
 *                   enrollmentNo: { type: string, example: CS2023045 }
 *                   department:   { type: string }
 *     responses:
 *       200: { description: 'Membership changed.' }
 *       400: { description: 'Enrolment number required (STUDENT_PROFILE_REQUIRED).' }
 */
router.patch(
  '/:userId/membership',
  requireStaff,
  validate({ params: userIdParamSchema, body: changeMembershipSchema }),
  userController.changeMembershipType
);

/**
 * @openapi
 * /users/{userId}/suspend:
 *   post:
 *     tags: [Users]
 *     summary: Suspend a member (staff only)
 *     description: >
 *       Blocks sign-in and borrowing, and revokes every active session
 *       immediately. A reason is required — it is shown to the member when
 *       their sign-in is refused, and it is the only lasting record of why.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reason]
 *             properties:
 *               reason: { type: string, example: 'Repeated failure to return borrowed items' }
 *     responses:
 *       200: { description: 'Suspended and sessions revoked.' }
 *       403: { description: 'Cannot suspend your own account.' }
 *       409: { description: 'Cannot suspend the only administrator.' }
 */
router.post(
  '/:userId/suspend',
  requireStaff,
  validate({ params: userIdParamSchema, body: suspendUserSchema }),
  userController.suspendUser
);

/**
 * @openapi
 * /users/{userId}/reactivate:
 *   post:
 *     tags: [Users]
 *     summary: Lift a suspension (staff only)
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Account reactivated.' }
 */
router.post(
  '/:userId/reactivate',
  requireStaff,
  validate({ params: userIdParamSchema }),
  userController.reactivateUser
);

/**
 * @openapi
 * /users/{userId}/verify-student:
 *   post:
 *     tags: [Users]
 *     summary: Mark a member's academic details as verified (staff only)
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Academic details verified.' }
 *       400: { description: 'No academic details to verify.' }
 */
router.post(
  '/:userId/verify-student',
  requireStaff,
  validate({ params: userIdParamSchema }),
  userController.verifyStudentProfile
);

/**
 * @openapi
 * /users/{userId}/sessions:
 *   delete:
 *     tags: [Users]
 *     summary: Force-revoke every session for a member (admin only)
 *     description: >
 *       Signs the member out everywhere without suspending the account — the
 *       right response to a suspected token compromise.
 *     parameters:
 *       - in: path
 *         name: userId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Sessions revoked.' }
 */
router.delete(
  '/:userId/sessions',
  requireAdmin,
  validate({ params: userIdParamSchema }),
  userController.forceLogout
);

export default router;
