/**
 * ---------------------------------------------------------------------------
 * USER SERIALIZER — the "View" layer for user data
 * ---------------------------------------------------------------------------
 * Converts User documents into the exact shape sent over the wire.
 *
 * This layer exists so that WHAT LEAVES THE SYSTEM is an explicit decision made
 * in one file, rather than an accident of whichever fields happened to be on a
 * document. Returning `user.toJSON()` from a controller is the common
 * shortcut, and it means every field added to the schema later is silently
 * published — including the next one that should not have been.
 *
 * Three audiences, three shapes:
 *
 *   toPublic()  — what ANY user may see about another. Name and avatar only.
 *   toSelf()    — what a user sees about THEMSELVES. Contact details, stats,
 *                 preferences.
 *   toAdmin()   — what STAFF see. Adds suspension details, login history and
 *                 audit timestamps.
 *
 * `passwordHash` and `passwordChangedAt` are `select: false` on the schema, so
 * they are normally absent — but these functions build an explicit allow-list
 * rather than deleting keys from a copy. An allow-list cannot leak a field
 * added tomorrow; a deny-list can, and eventually does.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';
import { COLLEGE_MEMBERSHIP_TYPES, USER_STATUS } from '../constants/roles.js';

/**
 * Turn a stored avatar key into a URL a client can actually load.
 * The database holds a storage key (`a1b2c3.jpg`); clients need a URL. Doing
 * the join here keeps storage layout out of both the database and the client.
 */
const avatarUrl = (avatar) =>
  avatar ? `${config.app.url}${config.upload.categories.avatar.urlPrefix}/${avatar}` : null;

/**
 * Normalise a Mongoose Map field to a plain object.
 *
 * A hydrated document gives a real `Map`; a `.lean()` query gives a plain
 * object. Serializers see both — list endpoints are lean for speed, single
 * fetches are hydrated — so every Map field has to tolerate either form.
 */
const toPlainMap = (value) => {
  if (!value) return {};
  if (value instanceof Map) return Object.fromEntries(value);
  return value;
};

/**
 * The minimal public view: what shows next to a review or on a public reading
 * list. No email, no membership number, no statistics.
 */
export const toPublic = (user) => {
  if (!user) return null;

  return {
    id: String(user._id ?? user.id),
    name: user.name,
    avatar: avatarUrl(user.avatar),
    memberSince: user.membershipStartedAt ?? user.createdAt,
  };
};

/**
 * The self view: everything a member may see about their own account.
 * `studentProfile` appears only for college members, matching the model.
 */
export const toSelf = (user) => {
  if (!user) return null;

  const isCollegeMember = COLLEGE_MEMBERSHIP_TYPES.includes(user.membershipType);
  const policy = config.library.getPolicy(user.membershipType);

  return {
    id: String(user._id ?? user.id),
    name: user.name,
    email: user.email,
    avatar: avatarUrl(user.avatar),

    role: user.role,
    membershipType: user.membershipType,
    membershipNumber: user.membershipNumber,
    membershipStartedAt: user.membershipStartedAt,
    membershipExpiresAt: user.membershipExpiresAt ?? null,

    // Present only for STUDENT and FACULTY.
    ...(isCollegeMember && user.studentProfile
      ? {
          studentProfile: {
            enrollmentNo: user.studentProfile.enrollmentNo,
            department: user.studentProfile.department ?? null,
            course: user.studentProfile.course ?? null,
            year: user.studentProfile.year ?? null,
            collegeEmail: user.studentProfile.collegeEmail ?? null,
            verified: Boolean(user.studentProfile.verifiedAt),
          },
        }
      : {}),

    phone: user.phone ?? null,
    address: user.address ?? null,
    preferredLanguage: user.preferredLanguage ?? 'en',

    status: user.status,

    stats: {
      activeLoans: user.stats?.activeLoans ?? 0,
      totalBorrowed: user.stats?.totalBorrowed ?? 0,
      outstandingFine: user.stats?.outstandingFine ?? 0,
      totalFinesPaid: user.stats?.totalFinesPaid ?? 0,
      reviewCount: user.stats?.reviewCount ?? 0,
    },

    /**
     * The member's own borrowing entitlements, resolved from their membership
     * tier. Included so a client can show "3 of 5 books borrowed" without
     * hard-coding the policy — which would then silently disagree with the
     * server the moment an administrator changes it in .env.
     */
    borrowingPolicy: {
      maxActiveLoans: policy.maxActiveLoans,
      loanPeriodDays: policy.loanPeriodDays,
      maxRenewals: policy.maxRenewals,
      canBorrow:
        user.status === USER_STATUS.ACTIVE &&
        (user.stats?.activeLoans ?? 0) < policy.maxActiveLoans &&
        (user.stats?.outstandingFine ?? 0) <= config.library.fines.blockBorrowingAbove,
      finesBlockThreshold: config.library.fines.blockBorrowingAbove,
      currency: config.library.fines.currency,
    },

    /**
     * `notificationPreferences` is a Mongoose Map on a hydrated document, but
     * a PLAIN OBJECT when the query used `.lean()` — and `Object.fromEntries`
     * requires an iterable, so calling it on the lean form throws. List
     * endpoints are lean for speed while single-record fetches are hydrated,
     * so both shapes genuinely reach this line.
     */
    notificationPreferences: toPlainMap(user.notificationPreferences),

    lastLoginAt: user.lastLoginAt ?? null,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
};

/**
 * The staff view: the self view plus the moderation and audit fields staff
 * need to manage an account.
 */
export const toAdmin = (user) => {
  if (!user) return null;

  return {
    ...toSelf(user),

    suspension: user.suspendedAt
      ? {
          suspendedAt: user.suspendedAt,
          reason: user.suspensionReason ?? null,
          suspendedBy: user.suspendedBy ? String(user.suspendedBy) : null,
        }
      : null,

    isDeleted: user.isDeleted ?? false,
    deletedAt: user.deletedAt ?? null,

    // The academic verification state matters to staff, who are the ones who
    // set it after checking a student's details.
    studentProfileVerifiedAt: user.studentProfile?.verifiedAt ?? null,
  };
};

/**
 * Pick the right shape for the caller.
 *
 * Centralising the decision means a handler cannot accidentally serialise a
 * member's private data into a public response by choosing the wrong function.
 *
 * @param {object} user The user being serialised.
 * @param {object|null} viewer The authenticated caller, if any.
 */
export const forViewer = (user, viewer) => {
  if (!user) return null;
  if (!viewer) return toPublic(user);

  const isSelf = String(viewer._id ?? viewer.id) === String(user._id ?? user.id);
  if (isSelf) return toSelf(user);

  if (viewer.role === 'LIBRARIAN' || viewer.role === 'ADMIN') return toAdmin(user);

  return toPublic(user);
};

/** Serialise a list, applying the same rules per item. */
export const listForViewer = (users, viewer) => users.map((user) => forViewer(user, viewer));

/** Serialise a staff-facing list. */
export const listForAdmin = (users) => users.map(toAdmin);

/**
 * The authentication response: the user plus their freshly minted tokens.
 *
 * `expiresIn` is included so a client can schedule a refresh proactively
 * instead of waiting for a 401 and retrying — which is the difference between
 * a seamless session and a visible stutter every fifteen minutes.
 */
export const toAuthResponse = (user, tokens) => ({
  user: toSelf(user),
  tokens: {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    tokenType: 'Bearer',
    expiresIn: config.jwt.tokens.access.expiresIn,
    refreshExpiresIn: config.jwt.tokens.refresh.expiresIn,
  },
});

/** An active-session entry for the "where am I signed in?" list. */
export const toSession = (refreshToken, currentTokenHash) => ({
  id: String(refreshToken._id),
  createdAt: refreshToken.createdAt,
  lastUsedAt: refreshToken.lastUsedAt ?? refreshToken.createdAt,
  expiresAt: refreshToken.expiresAt,
  ip: refreshToken.ip ?? null,
  userAgent: refreshToken.userAgent ?? null,
  /** Lets a client label one entry "this device" rather than listing anonymous rows. */
  isCurrent: currentTokenHash ? refreshToken.tokenHash === currentTokenHash : false,
});

export default { toPublic, toSelf, toAdmin, forViewer, listForViewer, listForAdmin, toAuthResponse, toSession };
