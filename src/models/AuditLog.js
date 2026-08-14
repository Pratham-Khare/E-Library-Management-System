/**
 * ---------------------------------------------------------------------------
 * AUDIT LOG
 * ---------------------------------------------------------------------------
 * A record of every privileged mutation: who did what, to which record, and
 * what changed.
 *
 * The `changes` diff is what makes this useful rather than decorative. Knowing
 * that a librarian "updated a book" answers nothing; knowing they changed its
 * price from 399 to 39 answers everything. Only the fields that ACTUALLY
 * CHANGED are stored — a full before-and-after copy of every document would
 * bloat the collection with unchanged data and bury the one field that matters.
 *
 * Writes here are best-effort and never block the operation being audited. An
 * audit failure must not prevent a librarian from returning a book.
 * ---------------------------------------------------------------------------
 */

import mongoose from 'mongoose';
import config from '../config/index.js';
import { AUDIT_ACTION_VALUES, AUDIT_ENTITY_VALUES } from '../constants/enums.js';

const { Schema, model } = mongoose;

const auditLogSchema = new Schema(
  {
    /** Null for system-initiated actions such as a cron job. */
    actor: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    /** Denormalised, so the log stays readable after an account is deleted. */
    actorName: { type: String, default: null },
    actorRole: { type: String, default: null },

    action: { type: String, enum: AUDIT_ACTION_VALUES, required: true, index: true },
    entity: { type: String, enum: AUDIT_ENTITY_VALUES, required: true, index: true },
    entityId: { type: Schema.Types.ObjectId, default: null, index: true },
    /** A human label — a book title, a member name — so the log reads without joins. */
    entityLabel: { type: String, default: null },

    /**
     * Only the CHANGED fields, as { field: { from, to } }.
     * Storing whole documents would bury the one field that matters.
     */
    changes: { type: Schema.Types.Mixed, default: null },

    /** Free-text context — a waiver reason, a suspension explanation. */
    note: { type: String, trim: true, maxlength: 500, default: null },

    ip: { type: String, default: null },
    userAgent: { type: String, default: null, maxlength: 300 },
    requestId: { type: String, default: null },

    /** TTL. Audit records are kept for a year by default, then expire. */
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + config.cron.retention.auditLogDays * 86_400_000),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

/** "What did this librarian do?" and "what happened to this book?" */
auditLogSchema.index({ actor: 1, createdAt: -1 });
auditLogSchema.index({ entity: 1, entityId: 1, createdAt: -1 });
auditLogSchema.index({ createdAt: -1 });

/**
 * Compute the diff between two objects, keeping only what changed.
 *
 * @param {object} before
 * @param {object} after
 * @param {string[]} [fields] Restrict to these fields.
 */
auditLogSchema.statics.diff = function diff(before = {}, after = {}, fields = null) {
  const keys = fields ?? [...new Set([...Object.keys(before), ...Object.keys(after)])];
  const changes = {};

  for (const key of keys) {
    const from = before[key];
    const to = after[key];

    // JSON comparison so nested objects and arrays compare by value. Adequate
    // for the small, flat records audited here.
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key] = { from: from ?? null, to: to ?? null };
    }
  }

  return Object.keys(changes).length > 0 ? changes : null;
};

export const AuditLog = model('AuditLog', auditLogSchema);

export default AuditLog;
