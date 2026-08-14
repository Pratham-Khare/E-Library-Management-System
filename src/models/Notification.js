/**
 * ---------------------------------------------------------------------------
 * NOTIFICATION MODEL
 * ---------------------------------------------------------------------------
 * The in-app notification centre. Every notification is recorded here whether
 * or not an email also went out, so a member who never opens their email still
 * has a complete record of what happened to their account.
 *
 * `data` carries the ids needed to make a notification ACTIONABLE — a
 * due-soon notice with a `loanId` lets a client render a "Renew" button
 * directly, rather than leaving the member to go and find the loan.
 *
 * A TTL index expires old READ notifications. Unread ones are kept
 * indefinitely: the whole point is that the member has not seen them yet.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import {
  NOTIFICATION_TYPE_VALUES,
  NOTIFICATION_CHANNEL,
  NOTIFICATION_CHANNEL_VALUES,
  DELIVERY_STATUS,
  DELIVERY_STATUS_VALUES,
} from '../constants/enums.js';

const { Schema, model } = mongoose;

const notificationSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },

    type: { type: String, enum: NOTIFICATION_TYPE_VALUES, required: true, index: true },

    title: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, trim: true, maxlength: 1000 },

    /** Which channels this was sent through. IN_APP is always included. */
    channels: [{ type: String, enum: NOTIFICATION_CHANNEL_VALUES }],

    /**
     * Context ids — loanId, bookId, fineId — so a client can render an
     * actionable notification rather than a dead-end line of text.
     * Free-form because each type carries different context.
     */
    data: { type: Schema.Types.Mixed, default: {} },

    /** Where tapping it should take the member. */
    actionUrl: { type: String, trim: true, maxlength: 500, default: null },

    readAt: { type: Date, default: null },

    /* --- Email delivery ------------------------------------------------- */

    emailStatus: {
      type: String,
      enum: DELIVERY_STATUS_VALUES,
      default: DELIVERY_STATUS.PENDING,
    },
    /** SendGrid's message id, for tracing a delivery complaint. */
    providerMessageId: { type: String, default: null },
    emailError: { type: String, default: null, maxlength: 300 },

    /**
     * TTL anchor.
     *
     * Set only when the notification is READ, so unread ones never expire.
     * A member who has not seen a notification has not been notified, and
     * silently deleting it would defeat the entire feature.
     */
    expiresAt: { type: Date, default: null, index: { expires: 0 } },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/** The notification centre: a member's list, newest first, unread filterable. */
notificationSchema.index({ user: 1, readAt: 1, createdAt: -1 });

notificationSchema.virtual('isRead').get(function isRead() {
  return this.readAt !== null;
});

/* ===========================================================================
 * Statics
 * ======================================================================== */

/** How many unread notifications a member has — the badge count. */
notificationSchema.statics.unreadCountFor = function unreadCountFor(userId) {
  return this.countDocuments({ user: userId, readAt: null });
};

/**
 * Mark notifications read, and start their retention clock.
 *
 * `expiresAt` is set HERE rather than at creation, so the TTL measures time
 * since the member saw it — not time since it was raised.
 */
notificationSchema.statics.markRead = function markRead(userId, notificationIds = null) {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + config.cron.retention.readNotificationDays * 86_400_000);

  const filter = { user: userId, readAt: null };
  if (notificationIds) filter._id = { $in: notificationIds };

  return this.updateMany(filter, { $set: { readAt: now, expiresAt } });
};

export const Notification = model('Notification', notificationSchema);

export default Notification;
