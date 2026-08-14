/**
 * ---------------------------------------------------------------------------
 * USER MODEL
 * ---------------------------------------------------------------------------
 * Everyone in the system: public members, college students, faculty, library
 * staff and administrators.
 *
 * TWO ORTHOGONAL AXES, and keeping them separate is what lets one deployment
 * serve both a public library and a college library:
 *
 *   role           — what you are ALLOWED TO DO.       MEMBER / LIBRARIAN / ADMIN
 *   membershipType — what BORROWING PRIVILEGES you get. PUBLIC / STUDENT / FACULTY
 *
 * A librarian borrows books too, and is subject to their own membership tier
 * while doing so. Collapsing these into one field would force nonsense hybrids
 * like STUDENT_LIBRARIAN and make the policy lookup ambiguous.
 *
 * `studentProfile` is a nested sub-document present only for STUDENT and
 * FACULTY members. Public members simply do not carry those fields rather than
 * carrying them empty — which keeps documents honest and lets a sparse unique
 * index on the enrolment number work correctly.
 * ---------------------------------------------------------------------------
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

/* ===========================================================================
 * Sub-schemas
 * ======================================================================== */

/**
 * Academic details, required for STUDENT and FACULTY members.
 * `_id: false` because this is embedded data, not an independently
 * addressable entity — an id here would be noise in every response.
 */
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
 * Per-type notification preferences.
 *
 * Stored as a Map keyed by NOTIFICATION_TYPE rather than as 18 boolean fields,
 * so adding a new notification type later needs no migration. Absence of a key
 * means "use the default", which is: in-app always on, email on.
 */
const notificationPreferenceSchema = new Schema(
  {
    inApp: { type: Boolean, default: true },
    email: { type: Boolean, default: true },
  },
  { _id: false }
);

/**
 * Denormalised counters, maintained by the circulation service.
 *
 * These are derivable by aggregating Loan and Fine, but the eligibility check
 * runs on EVERY borrow attempt and needs them instantly. Recomputing three
 * aggregations per borrow to avoid three counters is the wrong trade. The
 * numbers are corrected by the nightly job, so drift cannot accumulate.
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

/* ===========================================================================
 * User schema
 * ======================================================================== */

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

    /**
     * Login identifier. Lowercased on write so that Alice@x.com and
     * alice@x.com are the same account — otherwise the unique index lets both
     * exist and login becomes a coin flip.
     */
    email: {
      type: String,
      required: [true, 'Email is required'],
      unique: true,
      trim: true,
      lowercase: true,
      match: [/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Please provide a valid email address'],
    },

    /**
     * bcrypt hash — never the password itself.
     *
     * `select: false` excludes it from every query by default, so a careless
     * `User.find()` cannot leak hashes into an API response. Login explicitly
     * opts back in with `.select('+passwordHash')`.
     */
    passwordHash: {
      type: String,
      required: [true, 'Password is required'],
      select: false,
    },

    /**
     * When the password last changed. Any access token issued BEFORE this
     * moment is rejected, which is what makes "change password" genuinely log
     * out every other device — otherwise a stolen token stays valid for its
     * full 15 minutes after the victim has already reacted.
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

    /**
     * Library card number, generated on registration.
     * Format: LIB-YYYY-NNNNNN, e.g. LIB-2026-000042
     */
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
     * Users are NEVER hard-deleted. Loans, fines and reviews reference this
     * document, and removing it would orphan the library's own circulation
     * history — which is a permanent record, not the user's to erase.
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

/* ===========================================================================
 * Indexes
 * ======================================================================== */

/**
 * Enrolment numbers must be unique — but only among members who HAVE one.
 * A plain unique index would treat every public member's missing value as
 * `null` and reject the second one, making it impossible to register more than
 * one public member. `partialFilterExpression` restricts the constraint to
 * documents where the field actually exists.
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

/* ===========================================================================
 * Virtuals
 * ======================================================================== */

/** True when this member holds a college affiliation. */
userSchema.virtual('isCollegeMember').get(function isCollegeMember() {
  return COLLEGE_MEMBERSHIP_TYPES.includes(this.membershipType);
});

/** True when the account may log in and borrow. */
userSchema.virtual('isActive').get(function isActive() {
  if (this.status !== USER_STATUS.ACTIVE || this.isDeleted) return false;
  if (this.membershipExpiresAt && this.membershipExpiresAt < new Date()) return false;
  return true;
});

/** True for library staff. */
userSchema.virtual('isStaff').get(function isStaff() {
  return this.role === ROLES.LIBRARIAN || this.role === ROLES.ADMIN;
});

/* ===========================================================================
 * Hooks
 * ======================================================================== */

/**
 * Enforce the studentProfile invariant in the MODEL rather than only in the
 * request validator.
 *
 * A validator protects the HTTP boundary. This protects every path — the
 * seeder, an admin bulk update, a script run in a console. An invariant that
 * only holds when data arrives through one door is not an invariant.
 */
userSchema.pre('validate', function enforceStudentProfile(next) {
  const isCollegeTier = COLLEGE_MEMBERSHIP_TYPES.includes(this.membershipType);
  const needsEnrollment = ENROLLMENT_REQUIRED_MEMBERSHIP_TYPES.includes(this.membershipType);

  /**
   * LIBRARY STAFF ARE EXEMPT.
   *
   * `membershipType` describes BORROWING PRIVILEGES, not academic status. A
   * librarian may be given the STUDENT tier for their own borrowing without
   * being an enrolled student, and demanding a roll number from them would
   * make the account impossible to create. The requirement is about patrons,
   * so it applies to patrons.
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
 * Generate a library card number for new members.
 *
 * Sequential and human-readable, because the number is read aloud and typed at
 * a physical circulation desk — `LIB-2026-000042` is usable in a way a UUID is
 * not.
 *
 * Allocated through the atomic Counter rather than `countDocuments() + 1`.
 * The counting approach is a read-then-write and collides whenever two
 * registrations run at once — a class signing up together, or a parallel
 * import. See models/Counter.js.
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

/* ===========================================================================
 * Instance methods
 * ======================================================================== */

/**
 * Whether an access token issued at `tokenIssuedAt` is still valid.
 *
 * Returns false for any token minted before the last password change, which is
 * what makes changing a password immediately invalidate sessions everywhere.
 *
 * @param {number} tokenIssuedAtSeconds The JWT `iat` claim, in seconds.
 */
userSchema.methods.isTokenStillValid = function isTokenStillValid(tokenIssuedAtSeconds) {
  if (!this.passwordChangedAt) return true;

  // `iat` is whole seconds; floor the comparison side too, or a token issued
  // in the same second as the change is wrongly rejected.
  const changedAtSeconds = Math.floor(this.passwordChangedAt.getTime() / 1000);
  return tokenIssuedAtSeconds >= changedAtSeconds;
};

/**
 * Resolve the notification preference for a type, applying defaults for any
 * type the member has never explicitly configured.
 */
userSchema.methods.wantsNotification = function wantsNotification(type, channel) {
  const preference = this.notificationPreferences?.get?.(type);
  if (!preference) return true; // default: everything on
  return preference[channel] !== false;
};

/* ===========================================================================
 * Statics
 * ======================================================================== */

/**
 * Find an active user by email, WITH the password hash for verification.
 * Used only by the login flow.
 */
userSchema.statics.findForAuthentication = function findForAuthentication(email) {
  return this.findOne({ email: String(email).toLowerCase().trim(), isDeleted: false }).select(
    '+passwordHash +passwordChangedAt'
  );
};

/**
 * Create a user, retrying if the generated membership number was taken.
 *
 * The pre-save hook probes for a free number, but probing cannot be atomic:
 * two concurrent registrations can both find the same candidate free and both
 * try to insert it. The unique index rejects one — and THIS is where that
 * rejection is turned into a retry rather than a failed sign-up.
 *
 * Only a membershipNumber collision is retried. A duplicate email or enrolment
 * number is a genuine conflict the caller must see, so those are rethrown.
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
