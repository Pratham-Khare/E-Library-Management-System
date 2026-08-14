/**
 * ---------------------------------------------------------------------------
 * AUTHENTICATION REQUEST SCHEMAS
 * ---------------------------------------------------------------------------
 * Zod schemas for every /auth endpoint.
 *
 * Note what the registration schema deliberately DOES NOT accept: `role`,
 * `status`, `stats`, `membershipNumber`. Zod strips unknown keys, so a request
 * body containing `{"email": "...", "role": "ADMIN"}` arrives at the service
 * with the role silently removed. That single property is what prevents
 * self-promotion to administrator — the classic mass-assignment vulnerability.
 * Roles are only ever changed through an explicit admin-only endpoint.
 * ---------------------------------------------------------------------------
 */

import { z } from 'zod';
import { email, nonEmptyString, optionalString, phone, objectId } from './common.js';
import { PASSWORD_PATTERN, PASSWORD_DESCRIPTION } from '../utils/password.js';
import { MEMBERSHIP_TYPES, ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES } from '../constants/roles.js';

/** Shared password rule, so registration and reset cannot drift apart. */
const password = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password cannot exceed 128 characters')
  .regex(PASSWORD_PATTERN, PASSWORD_DESCRIPTION);

/** Academic details, required for STUDENT and FACULTY. */
const studentProfile = z.object({
  enrollmentNo: nonEmptyString('Enrolment number', { min: 2, max: 50 }).transform((value) =>
    value.toUpperCase()
  ),
  department: optionalString(120),
  course: optionalString(120),
  year: z.coerce.number().int().min(1).max(8).optional(),
  collegeEmail: email.optional(),
});

/* ===========================================================================
 * Registration
 * ======================================================================== */

export const registerSchema = z
  .object({
    name: nonEmptyString('Name', { min: 2, max: 120 }),
    email,
    password,

    /**
     * Public registration may only create PUBLIC, STUDENT or FACULTY members —
     * never staff. `role` is not accepted at all and is stripped by Zod.
     */
    membershipType: z
      .enum([MEMBERSHIP_TYPES.PUBLIC, MEMBERSHIP_TYPES.STUDENT, MEMBERSHIP_TYPES.FACULTY])
      .default(MEMBERSHIP_TYPES.PUBLIC),

    studentProfile: studentProfile.optional(),

    phone: phone.optional(),
    address: z
      .object({
        line1: optionalString(200),
        line2: optionalString(200),
        city: optionalString(100),
        state: optionalString(100),
        postalCode: optionalString(20),
        country: optionalString(100),
      })
      .optional(),
  })
  /**
   * Cross-field rule: a college membership needs an enrolment number.
   *
   * Checked here as well as in the model. The model guarantees the invariant
   * on every write path including the seeder; doing it here too means the API
   * caller gets a clean 422 naming the exact field, rather than a Mongoose
   * error translated after the fact.
   */
  .superRefine((data, ctx) => {
    // Students only — see ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES for why faculty
    // are not held to this.
    if (
      ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES.includes(data.membershipType) &&
      !data.studentProfile?.enrollmentNo
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['studentProfile', 'enrollmentNo'],
        message: `An enrolment number is required when registering as ${data.membershipType}`,
      });
    }
  });

/* ===========================================================================
 * Login & session
 * ======================================================================== */

export const loginSchema = z.object({
  email,
  // No pattern check on login. The stored password may predate a policy change,
  // and rejecting it here would lock the user out of the very account they are
  // trying to reach in order to fix it.
  password: z.string().min(1, 'Password is required'),
});

export const refreshSchema = z.object({
  /**
   * Optional in the body: the refresh token may instead arrive as a cookie.
   * The service checks both, preferring the body.
   */
  refreshToken: z.string().min(1, 'Refresh token is required').optional(),
});

export const logoutSchema = refreshSchema;

/* ===========================================================================
 * Password management
 * ======================================================================== */

export const forgotPasswordSchema = z.object({ email });

export const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'Reset token is required'),
    password,
    confirmPassword: z.string().min(1, 'Please confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });

export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Your current password is required'),
    newPassword: password,
    confirmPassword: z.string().min(1, 'Please confirm your new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  })
  .refine((data) => data.currentPassword !== data.newPassword, {
    path: ['newPassword'],
    message: 'Your new password must be different from your current one',
  });

/* ===========================================================================
 * Profile
 * ======================================================================== */

/**
 * Self-service profile update.
 *
 * Note the absence of `email`, `role`, `membershipType`, `status` and `stats`.
 * Changing an email is an identity change that needs its own verified flow;
 * the rest are staff-controlled. Zod strips them, so including any of them in
 * a request body is a silent no-op rather than a privilege escalation.
 */
export const updateProfileSchema = z
  .object({
    name: nonEmptyString('Name', { min: 2, max: 120 }).optional(),
    phone: phone.optional(),
    address: z
      .object({
        line1: optionalString(200),
        line2: optionalString(200),
        city: optionalString(100),
        state: optionalString(100),
        postalCode: optionalString(20),
        country: optionalString(100),
      })
      .optional(),
    preferredLanguage: z.string().trim().toLowerCase().length(2).optional(),
    studentProfile: studentProfile.partial().optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Provide at least one field to update',
  });

/* ===========================================================================
 * Session id parameter
 * ======================================================================== */

export const sessionIdParam = z.object({ sessionId: objectId });

export default {
  registerSchema,
  loginSchema,
  refreshSchema,
  logoutSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  changePasswordSchema,
  updateProfileSchema,
  sessionIdParam,
};
