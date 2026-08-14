/**
 * ENGAGEMENT SERIALIZERS — reviews, reading lists, notifications
 */

import { toBookSummary } from './catalog.serializer.js';
import { toPublic as toPublicUser } from './user.serializer.js';

const isPopulated = (value) => value && typeof value === 'object' && !value.buffer;

/* --- Reviews ------------------------------------------------------------- */

/**
 * A review.
 */
export const toReview = (review, { viewerId = null, includeModeration = false } = {}) => {
  if (!review) return null;

  const votes = review.helpfulVotes ?? [];

  return {
    id: String(review._id ?? review.id),
    rating: review.rating,
    title: review.title ?? null,
    body: review.body ?? null,
    status: review.status,

    /** The single most useful signal on a review. */
    isVerifiedBorrower: review.isVerifiedBorrower ?? false,

    author: isPopulated(review.user) ? toPublicUser(review.user) : null,
    book: isPopulated(review.book) ? toBookSummary(review.book) : null,

    helpfulCount: votes.length,
    // Saves the client a second request just to render a button's state.
    viewerFoundHelpful: viewerId ? votes.some((id) => String(id) === String(viewerId)) : false,
    isOwn: viewerId ? String(review.user?._id ?? review.user) === String(viewerId) : false,

    createdAt: review.createdAt,
    updatedAt: review.updatedAt,

    // Moderation detail is staff-only — telling a member their review scored
    // 0.4 for "promotional language" invites gaming the filter.
    ...(includeModeration
      ? {
          moderation: {
            verdict: review.aiModeration?.verdict,
            reasons: review.aiModeration?.reasons ?? [],
            score: review.aiModeration?.score ?? 0,
            usedAi: review.aiModeration?.usedAi ?? false,
          },
          reportCount: review.reportCount ?? 0,
          moderatedAt: review.moderatedAt ?? null,
          moderationNote: review.moderationNote ?? null,
        }
      : {}),
  };
};

export const listReviews = (reviews, options) => (reviews ?? []).map((r) => toReview(r, options));

/* --- Reading lists ---------------------------------------------------------- */

export const toReadingList = (list, { includeBooks = true } = {}) => {
  if (!list) return null;

  return {
    id: String(list._id ?? list.id),
    name: list.name,
    type: list.type,
    description: list.description ?? null,
    isDefault: list.type !== 'CUSTOM',
    isPublic: list.isPublic ?? false,
    // Only meaningful when the list is shared; null otherwise so a client
    // cannot accidentally surface a stale link.
    shareUrl: list.isPublic && list.shareSlug ? `/lists/shared/${list.shareSlug}` : null,
    bookCount: list.items?.length ?? 0,

    ...(includeBooks
      ? {
          books: (list.items ?? []).map((item) => ({
            ...(isPopulated(item.book) ? toBookSummary(item.book) : { id: String(item.book) }),
            addedAt: item.addedAt,
            note: item.note ?? null,
          })),
        }
      : {}),

    ...(isPopulated(list.user) ? { owner: toPublicUser(list.user) } : {}),

    createdAt: list.createdAt,
    updatedAt: list.updatedAt,
  };
};

export const listReadingLists = (lists, options) =>
  (lists ?? []).map((list) => toReadingList(list, options));

/* --- Notifications ------------------------------------------------------------ */

export const toNotification = (notification) => {
  if (!notification) return null;

  return {
    id: String(notification._id ?? notification.id),
    type: notification.type,
    title: notification.title,
    body: notification.body,
    /** Context ids, so a client can render an actionable notification. */
    data: notification.data ?? {},
    actionUrl: notification.actionUrl ?? null,
    isRead: notification.readAt !== null,
    readAt: notification.readAt ?? null,
    channels: notification.channels ?? [],
    createdAt: notification.createdAt,
  };
};

export const listNotifications = (notifications) =>
  (notifications ?? []).map(toNotification);

export default {
  toReview,
  listReviews,
  toReadingList,
  listReadingLists,
  toNotification,
  listNotifications,
};
