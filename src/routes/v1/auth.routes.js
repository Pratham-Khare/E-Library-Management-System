/**
 * AUTHENTICATION ROUTES  —  /api/v1/auth
 * Every route reads as a declaration of its own security posture:
 */

import { Router } from 'express';
import * as authController from '../../controllers/auth.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { validate } from '../../middlewares/validate.js';
import { rateLimiter } from '../../middlewares/rateLimiter.js';
import {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  sessionIdParam,
} from '../../validators/auth.validator.js';

const router = Router();

/**
 * @openapi
 * components:
 *   schemas:
 *     AuthTokens:
 *       type: object
 *       properties:
 *         accessToken:  { type: string, description: 'Short-lived. Send as `Authorization: Bearer <token>`.' }
 *         refreshToken: { type: string, description: 'Single-use. Rotates on every exchange. Also set as an httpOnly cookie.' }
 *         tokenType:    { type: string, example: Bearer }
 *         expiresIn:    { type: string, example: 15m }
 *         refreshExpiresIn: { type: string, example: 7d }
 *     AuthResponse:
 *       type: object
 *       properties:
 *         user:   { $ref: '#/components/schemas/UserSelf' }
 *         tokens: { $ref: '#/components/schemas/AuthTokens' }
 *     UserSelf:
 *       type: object
 *       properties:
 *         id:               { type: string, example: 65f1a2b3c4d5e6f7a8b9c0d1 }
 *         name:             { type: string, example: Ananya Sharma }
 *         email:            { type: string, example: ananya@example.com }
 *         role:             { type: string, enum: [MEMBER, LIBRARIAN, ADMIN] }
 *         membershipType:   { type: string, enum: [PUBLIC, STUDENT, FACULTY] }
 *         membershipNumber: { type: string, example: LIB-2026-000042 }
 *         borrowingPolicy:
 *           type: object
 *           description: The caller's own entitlements, resolved from their membership tier.
 *           properties:
 *             maxActiveLoans: { type: integer, example: 5 }
 *             loanPeriodDays: { type: integer, example: 21 }
 *             maxRenewals:    { type: integer, example: 2 }
 *             canBorrow:      { type: boolean, example: true }
 */

/**
 * @openapi
 * /auth/register:
 *   post:
 *     tags: [Auth]
 *     summary: Register a new member
 *     description: >
 *       Creates a MEMBER account and returns a token pair. `role` cannot be set
 *       through this endpoint — it is stripped from the request body, so
 *       self-promotion to staff is not possible.
 *       STUDENT and FACULTY registrations must include
 *       `studentProfile.enrollmentNo`.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name:     { type: string, example: Ananya Sharma }
 *               email:    { type: string, format: email, example: ananya@example.com }
 *               password: { type: string, example: Str0ngPass, description: 'Min 8 chars with an uppercase letter, a lowercase letter and a number.' }
 *               membershipType: { type: string, enum: [PUBLIC, STUDENT, FACULTY], default: PUBLIC }
 *               studentProfile:
 *                 type: object
 *                 properties:
 *                   enrollmentNo: { type: string, example: CS2023045 }
 *                   department:   { type: string, example: Computer Science }
 *                   course:       { type: string, example: B.Tech }
 *                   year:         { type: integer, example: 3 }
 *               phone: { type: string, example: '+91 98765 43210' }
 *     responses:
 *       201:
 *         description: Account created.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/AuthResponse' }
 *       409: { description: 'Email or enrolment number already registered.' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 *       429: { $ref: '#/components/responses/TooManyRequests' }
 */
router.post(
  '/register',
  rateLimiter('auth'),
  validate({ body: registerSchema }),
  authController.register
);

/**
 * @openapi
 * /auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Sign in
 *     description: >
 *       Returns an access token (15 min) and a refresh token (7 days). The
 *       refresh token is also set as an httpOnly cookie for browser clients.
 *       An unknown email and a wrong password return the same error, so this
 *       endpoint cannot be used to discover which addresses are registered.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email:    { type: string, format: email, example: admin@elibrary.local }
 *               password: { type: string, example: Admin@12345 }
 *     responses:
 *       200:
 *         description: Signed in.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/AuthResponse' }
 *       401: { description: 'Incorrect email or password (INVALID_CREDENTIALS).' }
 *       403: { description: 'Account suspended or inactive.' }
 *       429: { $ref: '#/components/responses/TooManyRequests' }
 */
router.post('/login', rateLimiter('auth'), validate({ body: loginSchema }), authController.login);

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     tags: [Auth]
 *     summary: Exchange a refresh token for a new token pair
 *     description: >
 *       Refresh tokens are SINGLE-USE and rotate on every exchange. Presenting
 *       one that has already been rotated is treated as evidence of theft: the
 *       entire session family is revoked and the caller must sign in again
 *       (`REFRESH_TOKEN_REUSED`).
 *       The token may be sent in the body or as the `refreshToken` cookie.
 *     security: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               refreshToken: { type: string, description: 'Omit if sending the cookie instead.' }
 *     responses:
 *       200: { description: 'A new token pair. The old refresh token is now revoked.' }
 *       401: { description: 'Invalid, expired or already-used refresh token.' }
 */
router.post('/refresh', rateLimiter('auth'), validate({ body: refreshSchema }), authController.refresh);

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out of the current session
 *     description: Revokes the supplied refresh token and clears the cookie. Idempotent.
 *     security: []
 *     responses:
 *       200: { description: 'Signed out.' }
 */
router.post('/logout', validate({ body: logoutSchema }), authController.logout);

/**
 * @openapi
 * /auth/logout-all:
 *   post:
 *     tags: [Auth]
 *     summary: Sign out of every device
 *     description: Revokes all refresh tokens for the authenticated user.
 *     responses:
 *       200: { description: 'All sessions revoked.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post('/logout-all', authenticate, authController.logoutAll);

/**
 * @openapi
 * /auth/sessions:
 *   get:
 *     tags: [Auth]
 *     summary: List active sessions
 *     description: >
 *       Every device currently signed in, with its IP, user agent and last use.
 *       The session matching the caller's own refresh token is flagged
 *       `isCurrent`.
 *     responses:
 *       200: { description: 'Active sessions.' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/sessions', authenticate, authController.listSessions);

/**
 * @openapi
 * /auth/sessions/{sessionId}:
 *   delete:
 *     tags: [Auth]
 *     summary: Revoke one session
 *     description: Signs out a specific device without affecting the others.
 *     parameters:
 *       - in: path
 *         name: sessionId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Session revoked.' }
 *       404: { $ref: '#/components/responses/NotFound' }
 */
router.delete(
  '/sessions/:sessionId',
  authenticate,
  validate({ params: sessionIdParam }),
  authController.revokeSession
);

/**
 * @openapi
 * /auth/forgot-password:
 *   post:
 *     tags: [Auth]
 *     summary: Request a password reset link
 *     description: >
 *       Emails a single-use, time-limited reset link.
 *       ALWAYS reports success, whether or not an account exists for the
 *       address — otherwise this endpoint would reveal which emails are
 *       registered.
 *       In development the reset URL is also returned in the response body, so
 *       the flow is testable without a configured mail provider.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email]
 *             properties:
 *               email: { type: string, format: email }
 *     responses:
 *       200: { description: 'Generic confirmation, regardless of whether the account exists.' }
 *       429: { $ref: '#/components/responses/TooManyRequests' }
 */
router.post(
  '/forgot-password',
  rateLimiter('auth'),
  validate({ body: forgotPasswordSchema }),
  authController.forgotPassword
);

/**
 * @openapi
 * /auth/reset-password:
 *   post:
 *     tags: [Auth]
 *     summary: Complete a password reset
 *     description: >
 *       Consumes the reset token and sets a new password. The token is
 *       single-use. All existing sessions are revoked, since a reset is often
 *       the response to a compromise.
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, password, confirmPassword]
 *             properties:
 *               token:           { type: string }
 *               password:        { type: string }
 *               confirmPassword: { type: string }
 *     responses:
 *       200: { description: 'Password reset. All sessions revoked.' }
 *       400: { description: 'Invalid, used or expired token (RESET_TOKEN_INVALID).' }
 *       422: { $ref: '#/components/responses/ValidationError' }
 */
router.post(
  '/reset-password',
  rateLimiter('auth'),
  validate({ body: resetPasswordSchema }),
  authController.resetPassword
);

/**
 * @openapi
 * /auth/change-password:
 *   post:
 *     tags: [Auth]
 *     summary: Change your password
 *     description: >
 *       Requires the current password even though you are already signed in —
 *       otherwise an unattended session or a stolen access token would be
 *       enough to take over the account permanently.
 *       All other sessions are revoked, and access tokens issued before the
 *       change stop working immediately.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword, confirmPassword]
 *             properties:
 *               currentPassword: { type: string }
 *               newPassword:     { type: string }
 *               confirmPassword: { type: string }
 *     responses:
 *       200: { description: 'Password changed. Other sessions revoked.' }
 *       400: { description: 'Current password is incorrect (INCORRECT_PASSWORD).' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.post(
  '/change-password',
  authenticate,
  validate({ body: changePasswordSchema }),
  authController.changePassword
);

/**
 * @openapi
 * /auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: Get the authenticated user
 *     description: >
 *       The caller's own profile, including borrowing entitlements and current
 *       statistics. The endpoint a client calls on startup to restore session
 *       state.
 *     responses:
 *       200:
 *         description: The current user.
 *         content:
 *           application/json:
 *             schema:
 *               allOf:
 *                 - $ref: '#/components/schemas/SuccessResponse'
 *                 - type: object
 *                   properties:
 *                     data: { $ref: '#/components/schemas/UserSelf' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 */
router.get('/me', authenticate, authController.me);

export default router;
