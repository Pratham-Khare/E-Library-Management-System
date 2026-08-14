/**
 * Everyone in the system: public members, students, faculty, staff, admins.
 *
 * Two orthogonal axes, and keeping them apart is what lets one deployment serve
 * both a public and a college library:
 *
 *   role           — what you may DO.                MEMBER / LIBRARIAN / ADMIN
 *   membershipType — what BORROWING you are granted. PUBLIC / STUDENT / FACULTY
 *
 * A librarian borrows too, under their own tier. `studentProfile` is present
 * only for STUDENT and FACULTY — absent, not empty, so the partial unique index
 * on the enrolment number works.
 */

import mongoose from 'mongoose';
import {
  ROLES,
  ROLE_VALUES,
  MEMBERSHIP_TYPES,
  MEMBERSHIP_TYPE_VALUES,
  COLLEGE_MEMBERSHIP_TYPES,
  ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES,
  USER_STATUS,
  USER_STATUS_VALUES,
} from '../constants/roles.js';
import { NOTIFICATION_TYPE_VALUES } from '../constants/enums.js';
import { Counter } from './Counter.js';

const { Schema, model } = mongoose;

/* Sub-schemas */

/** Academic details, required for STUDENT and FACULTY members. */
const studentProfileSchema = new Schema(
  {
    /** Roll number / registration number. Unique across the institution. */
    enrollmentNo: {
      type: String,
      trim: true,
      uppercase: true,
      maxlength: [50, 'Enrolment number cannot exceed 50 characters'],
    },

    /** e.g. "Computer Science", "Mechanical Engineering". */
    department: {
      type: String,
      trim: true,
      maxlength: [120, 'Department cannot exceed 120 characters'],
    },

    /** e.g. "B.Tech", "M.Sc", "PhD". */
    course: {
      type: String,
      trim: true,
      maxlength: [120, 'Course cannot exceed 120 characters'],
    },

    /**
     * Year of study. Capped at 8 to accommodate long programmes (integrated
     * masters, PhD) without permitting obvious nonsense.
     */
    year: {
      type: Number,
      min: [1, 'Year of study must be at least 1'],
      max: [8, 'Year of study cannot exceed 8'],
    },

    /** Institutional email, when it differs from the login email. */
    collegeEmail: {
      type: String,
      trim: true,
      lowercase: true,
    },

    /** Set by staff once the academic details have been checked. */
    verifiedAt: { type: Date, default: null },
  },
  { _id: false }
);

/**
 * Per-type notification preferences, as a Map rather than 18 boolean fields so
 * a new type needs no migration. A missing key means "use the default".
 */
const notificationPreferenceSchema = new Schema(
  {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
  },
  { _id: false }
);

/**
 * Denormalised counters. Derivable from Loan and Fine, but the eligibility
 * check runs on every borrow and needs them instantly. Corrected nightly.
 */
const statsSchema = new Schema(
  {
    /** Items currently out. Compared against the membership tier's cap. */
    activeLoans: { type: Number, default: 0, min: 0 },
    /** Lifetime count, for the member's profile and admin analytics. */
    totalBorrowed: { type: Number, default: 0, min: 0 },
    /** Sum of PENDING fines. Compared against the borrowing-block threshold. */
    outstandingFine: { type: Number, default: 0, min: 0 },
    /** Lifetime fines paid, for the ledger. */
    totalFinesPaid: { type: Number, default: 0, min: 0 },
    /** Reviews written, shown on the public profile. */
    reviewCount: { type: Number, default: 0, min: 0 },
  },
  { _id: false }
);

/* User schema */

const userSchema = new Schema(
  {
    /* --- Identity --------------------------------------------------- */

    name: {
      type: String,
      required: [true, 'Name is required'],
      trim: true,
      minlength: [2, 'Name must be at least 2 characters'],
      maxlength: [120, 'Name cannot exceed 120 characters'],
    },

    /** Lowercased on write, so Alice@x.com and alice@x.com are one account. */
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },

    /**
     * bcrypt hash. `select: false` keeps it out of every query by default;
     * login opts back in with `.select('+passwordHash')`.
     */
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },

    /**
     * Any access token issued before this moment is rejected, which is what
     * makes changing a password log out every other device immediately.
     */
    passwordChangedAt: { type: Date, default: null, select: false },

    /* --- Authorisation ---------------------------------------------- */

    role: {
      type: String,
      enum: { values: ROLE_VALUES, message: '{VALUE} is not a valid role' },
      default: ROLES.MEMBER,
      index: true,
    },

    /* --- Membership --------------------------------------------------- */

    membershipType: {
      type: String,
      enum: { values: MEMBERSHIP_TYPE_VALUES, message: '{VALUE} is not a valid membership type' },
      default: MEMBERSHIP_TYPES.PUBLIC,
      index: true,
    },

    /** Present only for STUDENT and FACULTY. Enforced by the hook below. */
    studentProfile: { type: studentProfileSchema, default: undefined },

    /** Library card number, LIB-YYYY-NNNNNN. */
    membershipNumber: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
      uppercase: true,
    },

    membershipStartedAt: { type: Date, default: Date.now },

    /** Optional expiry, for institutions that renew membership annually. */
    membershipExpiresAt: { type: Date, default: null },

    /* --- Contact ------------------------------------------------------ */

    phone: {
      type: String,
      trim: true,
      match: [/^[+]?[\d\s()-]{7,20}$/, 'Please provide a valid phone number'],
    },

    address: {
      line1: { type: String, trim: true, maxlength: 200 },
      line2: { type: String, trim: true, maxlength: 200 },
      city: { type: String, trim: true, maxlength: 100 },
      state: { type: String, trim: true, maxlength: 100 },
      postalCode: { type: String, trim: true, maxlength: 20 },
      country: { type: String, trim: true, maxlength: 100, default: 'India' },
    },

    /** Storage key for the uploaded avatar; resolved to a URL by the serializer. */
    avatar: { type: String, default: null },

    /* --- Account state ------------------------------------------------ */

    status: {
      type: String,
      enum: { values: USER_STATUS_VALUES, message: '{VALUE} is not a valid account status' },
      default: USER_STATUS.ACTIVE,
      index: true,
    },

    /** Why staff suspended the account. Shown to the member on login refusal. */
    suspensionReason: { type: String, trim: true, maxlength: 500, default: null },
    suspendedAt: { type: Date, default: null },
    suspendedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },

    lastLoginAt: { type: Date, default: null },
    lastLoginIp: { type: String, default: null, select: false },

    /* --- Preferences --------------------------------------------------- */

    notificationPreferences: {
      type: Map,
      of: notificationPreferenceSchema,
      default: () => new Map(),
    },

    /** Preferred language for AI-generated content and emails. */
    preferredLanguage: { type: String, default: 'en', trim: true, lowercase: true },

    /* --- Denormalised counters ----------------------------------------- */

    stats: { type: statsSchema, default: () => ({}) },

    /* --- Soft delete ---------------------------------------------------- */

    /**
     * Never hard-deleted: loans, fines and reviews reference this document and
     * the circulation history is the library's record, not the user's to erase.
     */
    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
    /** Apply the transform below when a document is serialised. */
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  }
);

/* Indexes */

/**
 * Unique among members who HAVE an enrolment number. A plain unique index would
 * read every public member's missing value as null and reject the second one;
 * `partialFilterExpression` restricts the constraint to documents that have it.
 */
userSchema.index(
  { 'studentProfile.enrollmentNo': 1 },
  {
    unique: true,
    partialFilterExpression: { 'studentProfile.enrollmentNo': { $exists: true, $type: 'string' } },
    name: 'unique_enrollment_no_when_present',
  }
);

/** Staff member lists filter on role + status + membership type constantly. */
userSchema.index({ role: 1, status: 1, isDeleted: 1 });
userSchema.index({ membershipType: 1, status: 1 });

/** Admin member search by name or email. */
userSchema.index({ name: 'text', email: 'text' }, { name: 'user_text_search' });

/** "Members who owe money" — the fines dashboard. */
userSchema.index({ 'stats.outstandingFine': -1 });

/* Virtuals */

userSchema.virtual('isCollegeMember').get(function isCollegeMember() {
  return COLLEGE_MEMBERSHIP_TYPES.includes(this.membershipType);
});

userSchema.virtual('isActive').get(function isActive() {
  if (this.status !== USER_STATUS.ACTIVE || this.isDeleted) return false;
  if (this.membershipExpiresAt && this.membershipExpiresAt < new Date()) return false;
  return true;
});

userSchema.virtual('isStaff').get(function isStaff() {
  return this.role === ROLES.LIBRARIAN || this.role === ROLES.ADMIN;
});

/* Hooks */

/**
 * Enforced in the model, not just the request validator, so it also holds for
 * the seeder, bulk updates and console scripts.
 */
userSchema.pre('validate', function enforceStudentProfile(next) {
  const isCollegeTier = COLLEGE_MEMBERSHIP_TYPES.includes(this.membershipType);
  const needsEnrollment = ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES.includes(this.membershipType);

  /**
   * Staff are exempt: membershipType describes borrowing privileges, not
   * academic status, so a librarian on the STUDENT tier needs no roll number.
   */
  const isStaff = this.role === ROLES.LIBRARIAN || this.role === ROLES.ADMIN;

  if (needsEnrollment && !isStaff && !this.studentProfile?.enrollmentNo) {
    const error = new mongoose.Error.ValidationError(this);
    error.addError(
      'studentProfile.enrollmentNo',
      new mongoose.Error.ValidatorError({
        path: 'studentProfile.enrollmentNo',
        message: `An enrolment number is required for ${this.membershipType} members`,
        type: 'required',
      })
    );
    return next(error);
  }

  if (!isCollegeTier && this.studentProfile) {
    // A public member carrying academic details is contradictory data. Drop it
    // rather than storing a half-populated sub-document that the sparse unique
    // index would then have to reason about.
    this.studentProfile = undefined;
  }

  return next();
});

/**
 * Library card number for new members. Sequential and human-readable because it
 * is read aloud at a desk. Allocated through the atomic Counter, not
 * countDocuments() + 1, which collides on concurrent registrations.
 */
userSchema.pre('save', async function generateMembershipNumber(next) {
  if (this.membershipNumber || !this.isNew) return next();

  try {
    const year = new Date().getFullYear();
    const sequence = await Counter.next(`membershipNumber:${year}`);
    this.membershipNumber = `LIB-${year}-${String(sequence).padStart(6, '0')}`;
    return next();
  } catch (error) {
    return next(error);
  }
});

/* Instance methods */

/**
 * False for any token minted before the last password change — what makes a
 * password change invalidate sessions everywhere. Takes the JWT `iat`, seconds.
 */
userSchema.methods.isTokenStillValid = function isTokenStillValid(tokenIssuedAtSeconds) {
  if (!this.passwordChangedAt) return true;

  // `iat` is whole seconds; floor the comparison side too, or a token issued
  // in the same second as the change is wrongly rejected.
  const changedAtSeconds = Math.floor(this.passwordChangedAt.getTime() / 1000);
  return tokenIssuedAtSeconds >= changedAtSeconds;
};

/** Notification preference for a type, applying defaults where unset. */
userSchema.methods.wantsNotification = function wantsNotification(type, channel) {
  const preference = this.notificationPreferences?.get?.(type);
  if (!preference) return true; // default: everything on
  return preference[channel] !== false;
};

/* Statics */

/** Active user by email, WITH the password hash. Login only. */
userSchema.statics.findForAuthentication = function findForAuthentication(email) {
  return this.findOne({ email: String(email).toLowerCase().trim(), isDeleted: false }).select(
    '+passwordHash +passwordChangedAt'
  );
};

/**
 * Create a user, retrying if the membership number was taken. Only that
 * collision is retried — a duplicate email or enrolment number is a genuine
 * conflict the caller must see.
 */
userSchema.statics.createUnique = async function createUnique(data, maxAttempts = 5) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await this.create(data);
    } catch (error) {
      const isMembershipClash =
        error?.code === 11000 && Object.keys(error.keyPattern ?? {}).includes('membershipNumber');

      if (!isMembershipClash || attempt === maxAttempts - 1) throw error;

      // Clear it so the hook generates a fresh one on the next attempt.
      delete data.membershipNumber;
    }
  }

  // Unreachable: the loop either returns or throws.
  throw new Error('Could not allocate a membership number');
};

/** Count of admins, used to refuse demoting or deleting the last one. */
userSchema.statics.countAdmins = function countAdmins() {
  return this.countDocuments({ role: ROLES.ADMIN, isDeleted: false, status: USER_STATUS.ACTIVE });
};

export const User = model('User', userSchema);

export default User;
