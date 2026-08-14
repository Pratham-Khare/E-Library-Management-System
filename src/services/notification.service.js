/**
 * ---------------------------------------------------------------------------
 * NOTIFICATION SERVICE
 * ---------------------------------------------------------------------------
 * One `notify()` call raises an in-app notification AND, where the member
 * wants it and a template exists, an email. Callers never orchestrate the two
 * separately — which is what keeps them consistent, and what makes "the email
 * failed but the notification centre still shows it" the normal outcome
 * instead of a bug.
 *
 * EMAIL FAILURE NEVER FAILS THE OPERATION. If SendGrid is down while a book is
 * being returned, the return must still succeed. Delivery is best-effort and
 * its outcome is recorded on the notification for later diagnosis.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';
import logger from '../utils/logger.js';
import { Notification } from '../models/Notification.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { NOTIFICATION_CHANNEL, DELIVERY_STATUS } from '../constants/enums.js';
import { parsePagination, paginateQuery } from '../utils/pagination.js';
import mailService from './mail/index.js';

/**
 * Raise a notification.
 *
 * @param {object} params
 * @param {string|object} params.user Id, or a loaded user document.
 * @param {string} params.type A NOTIFICATION_TYPE value.
 * @param {string} params.title
 * @param {string} params.body
 * @param {object} [params.data] Context ids, so a client can act on it.
 * @param {string} [params.actionUrl]
 * @param {object} [params.emailData] Template data, when it differs from `data`.
 * @param {boolean} [params.email] Attempt email delivery. Default true.
 */
export const notify = async ({ user, type, title, body, data = {}, actionUrl = null, emailData = null, email = true }) => {
  // Accept either an id or a document, so callers that already have the user
  // do not pay for a second lookup.
  const userDoc = typeof user === 'object' && user.email ? user : await User.findById(user);
  if (!userDoc) {
    logger.warn('Cannot notify an unknown member', { type, user: String(user) });
    return null;
  }

  const wantsEmail =
    email && userDoc.wantsNotification?.(type, 'email') !== false && Boolean(userDoc.email);

  const notification = await Notification.create({
    user: userDoc._id,
    type,
    title,
    body,
    data,
    actionUrl,
    channels: wantsEmail
      ? [NOTIFICATION_CHANNEL.IN_APP, NOTIFICATION_CHANNEL.EMAIL]
      : [NOTIFICATION_CHANNEL.IN_APP],
    emailStatus: wantsEmail ? DELIVERY_STATUS.PENDING : DELIVERY_STATUS.SKIPPED,
  });

  if (!wantsEmail) return notification;

  /**
   * Email is attempted but never awaited for its RESULT by the caller.
   * A failing mail provider must not fail a book return.
   */
  mailService
    .send(type, userDoc.email, emailData ?? { user: userDoc, ...data })
    .then((result) =>
      Notification.updateOne(
        { _id: notification._id },
        {
          $set: {
            emailStatus: result.success
              ? DELIVERY_STATUS.SENT
              : result.skipped
                ? DELIVERY_STATUS.SKIPPED
                : DELIVERY_STATUS.FAILED,
            providerMessageId: result.messageId ?? null,
            emailError: result.error ?? null,
          },
        }
      ).catch(() => {})
    )
    .catch((error) => logger.warn('Notification email failed', { type, error: error.message }));

  return notification;
};

/** A member's notification centre. */
export const list = async (userId, query = {}) => {
  const { page, limit, skip } = parsePagination(query);

  const filter = { user: userId };
  if (query.unread === true) filter.readAt = null;
  if (query.type) filter.type = query.type;

  const result = await paginateQuery(Notification, filter, {
    sort: { createdAt: -1 },
    page,
    limit,
    skip,
  });

  const unreadCount = await Notification.unreadCountFor(userId);

  return { ...result, unreadCount };
};

export const unreadCount = (userId) => Notification.unreadCountFor(userId);

/** Mark specific notifications read, or all of them. */
export const markRead = async (userId, notificationIds = null) => {
  const result = await Notification.markRead(userId, notificationIds);
  const remaining = await Notification.unreadCountFor(userId);
  return { marked: result.modifiedCount, unreadCount: remaining };
};

export const remove = async (userId, notificationId) => {
  const notification = await Notification.findOne({ _id: notificationId, user: userId });
  if (!notification) {
    throw ApiError.notFound('No such notification', ERROR_CODES.NOT_FOUND);
  }
  await notification.deleteOne();
  return { deleted: true };
};

export default { notify, list, unreadCount, markRead, remove };
