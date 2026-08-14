/**
 * Schemas for /users. Profile-update and password schemas live in
 * auth.validator.js, next to the flows that use them.
 */

import { z } from 'zod';
import {
  email,
  nonEmptyString,
  optionalString,
  phone,
  objectId,
  listQuery,
  queryBoolean,
} from './common.js';
import { PASSWORD_PATTERN, PASSWORD_DESCRIPTION } from '../utils/password.js';
import { ROLE_VALUES, MEMBERSHIP_TYPE_VALUES, USER_STATUS_VALUES, ROLES } from '../constants/roles.js';
import { NOTIFICATION_TYPE_VALUES } from '../constants/enums.js';

/* Listing */

export const listUsersQuery = listQuery.extend({
  search: optionalString(200),
  role: z.enum(ROLE_VALUES).optional(),
  membershipType: z.enum(MEMBERSHIP_TYPE_VALUES).optional(),
  status: z.enum(USER_STATUS_VALUES).optional(),
  department: optionalString(120),
  hasOutstandingFines: queryBoolean.optional(),
  includeDeleted: queryBoolean.optional(),
});

export const userIdParamSchema = z.object({
  userId: z.union([objectId, z.literal('me')]),
});

/* Administration */

export const changeRoleSchema = z.object({
  role: z.enum(ROLE_VALUES, {
    errorMap: () => ({ message: `Role must be one of: ${ROLE_VALUES.join(', ')}` }),
  }),
});

export const changeMembershipSchema = z.object({
  membershipType: z.enum(MEMBERSHIP_TYPE_VALUES),
  studentProfile: z
    .object({
      enrollmentNo: nonEmptyString('Enrolment number', { min: 2, max: 50 })
        .transform((value) => value.toUpperCase())
        .optional(),
      department: optionalString(120),
      course: optionalString(120),
      year: z.coerce.number().int().min(1).max(8).optional(),
      collegeEmail: email.optional(),
    })
    .optional(),
});

/**
 * Suspension requires a reason.
 */
export const suspendUserSchema = z.object({
  reason: nonEmptyString('Suspension reason', { min: 5, max: 500 }),
});

export const createStaffSchema = z.object({
  name: nonEmptyString('Name', { min: 2, max: 120 }),
  email,
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters')
    .max(128)
    .regex(PASSWORD_PATTERN, PASSWORD_DESCRIPTION),
  // Only staff roles. Creating a MEMBER goes through public registration.
  role: z.enum([ROLES.LIBRARIAN, ROLES.ADMIN]),
  membershipType: z.enum(MEMBERSHIP_TYPE_VALUES).default('FACULTY'),
  phone: phone.optional(),
});

/* Notification preferences */

/**
 * A partial map of notification type to channel settings:
 */
export const notificationPreferencesSchema = z
  .record(
    z.enum(NOTIFICATION_TYPE_VALUES),
    z.object({
      inApp: z.boolean().optional(),
      email: z.boolean().optional(),
    })
  )
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one notification type to update',
  });

export default {
  listUsersQuery,
  userIdParamSchema,
  changeRoleSchema,
  changeMembershipSchema,
  suspendUserSchema,
  createStaffSchema,
  notificationPreferencesSchema,
};
