/**
 * One row per AI request — including the ones that cost nothing.
 *
 * Logging cache hits and mock responses alongside real calls is the point:
 * without them there is no way to answer "how much did the cache actually
 * save?", which is the number that justifies the whole design. A log of only
 * live calls shows 40 rows and tells you nothing about the 400 requests it
 * served for free.
 *
 * This is also the SOURCE OF TRUTH for quota enforcement. The count of rows
 * where `source: 'live'` is what the quota guard compares against the budget,
 * reconciled periodically against the provider's own usage endpoint.
 */

import mongoose from 'mongoose';
import { AI_FEATURE_VALUES, AI_SOURCE, AI_SOURCE_VALUES } from '../constants/enums.js';

const { Schema, model } = mongoose;

const aiUsageLogSchema = new Schema(
  {
    /** Null for system-initiated generation, e.g. a scheduled backfill. */
    user: { type: Schema.Types.ObjectId, ref: 'User', default: null, index: true },

    book: { type: Schema.Types.ObjectId, ref: 'Book', default: null },

    feature: { type: String, enum: AI_FEATURE_VALUES, required: true, index: true },

    /**
     * Where the response came from — the field that makes this log useful.
     *
     *   live  — a real API call. THIS is what counts against the quota.
     *   cache — served from AiSummary. Cost nothing.
     *   mock  — generated offline. Cost nothing.
     */
    source: { type: String, enum: AI_SOURCE_VALUES, required: true, index: true },

    success: { type: Boolean, default: true },
    errorCode: { type: String, default: null },
    errorMessage: { type: String, default: null, maxlength: 300 },

    promptTokens: { type: Number, default: 0 },
    completionTokens: { type: Number, default: 0 },
    totalTokens: { type: Number, default: 0 },

    /** Round-trip time. A cache hit at 3ms next to a live call at 4000ms is
     *  the clearest possible demonstration of what caching buys. */
    latencyMs: { type: Number, default: 0 },

    model: { type: String, default: null },
    promptVersion: { type: String, default: null },
  },
  { timestamps: true }
);

/* Indexes */

/**
 * THE QUOTA QUERY: how many live calls have we made?
 *
 * Evaluated before every AI request, so it must be an index seek rather than
 * a scan over a log that only ever grows.
 */
aiUsageLogSchema.index({ source: 1, createdAt: -1 });

/** Per-user daily cap enforcement. */
aiUsageLogSchema.index({ user: 1, source: 1, createdAt: -1 });

/* Statics */

/** Live calls spent so far. The number the quota guard checks. */
aiUsageLogSchema.statics.liveCallCount = function liveCallCount() {
  return this.countDocuments({ source: AI_SOURCE.LIVE, success: true });
};

/** Live calls a member has made since a point in time — the per-user cap. */
aiUsageLogSchema.statics.liveCallCountForUser = function liveCallCountForUser(userId, since) {
  return this.countDocuments({
    user: userId,
    source: AI_SOURCE.LIVE,
    success: true,
    createdAt: { $gte: since },
  });
};

/**
 * Usage statistics for the admin dashboard.
 *
 * The headline figure is `savedByCache` — requests served without spending a
 * call. On a 100-call lifetime budget that number IS the feature's viability,
 * and it is the one worth showing first.
 */
aiUsageLogSchema.statics.getStatistics = async function getStatistics({ since } = {}) {
  const match = since ? { createdAt: { $gte: new Date(since) } } : {};

  const [result] = await this.aggregate([
    ...(since ? [{ $match: match }] : []),
    {
      $facet: {
        bySource: [
          { $group: { _id: '$source', count: { $sum: 1 }, tokens: { $sum: '$totalTokens' } } },
          { $project: { _id: 0, source: '$_id', count: 1, tokens: 1 } },
        ],
        byFeature: [
          { $group: { _id: '$feature', count: { $sum: 1 } } },
          { $sort: { count: -1 } },
          { $project: { _id: 0, feature: '$_id', count: 1 } },
        ],
        latency: [
          { $match: { source: AI_SOURCE.LIVE } },
          { $group: { _id: null, avgMs: { $avg: '$latencyMs' }, maxMs: { $max: '$latencyMs' } } },
          { $project: { _id: 0, avgMs: { $round: ['$avgMs', 0] }, maxMs: 1 } },
        ],
        cacheLatency: [
          { $match: { source: AI_SOURCE.CACHE } },
          { $group: { _id: null, avgMs: { $avg: '$latencyMs' } } },
          { $project: { _id: 0, avgMs: { $round: ['$avgMs', 0] } } },
        ],
        failures: [
          { $match: { success: false } },
          { $group: { _id: '$errorCode', count: { $sum: 1 } } },
          { $project: { _id: 0, errorCode: '$_id', count: 1 } },
        ],
        topUsers: [
          { $match: { source: AI_SOURCE.LIVE, user: { $ne: null } } },
          { $group: { _id: '$user', calls: { $sum: 1 } } },
          { $sort: { calls: -1 } },
          { $limit: 5 },
          { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'user' } },
          { $unwind: '$user' },
          { $project: { _id: 0, userId: '$_id', name: '$user.name', calls: 1 } },
        ],
      },
    },
  ]);

  const bySource = result?.bySource ?? [];
  const countFor = (source) => bySource.find((entry) => entry.source === source)?.count ?? 0;

  const live = countFor(AI_SOURCE.LIVE);
  const cached = countFor(AI_SOURCE.CACHE);
  const mocked = countFor(AI_SOURCE.MOCK);
  const total = live + cached + mocked;

  return {
    totalRequests: total,
    liveCalls: live,
    cacheHits: cached,
    mockResponses: mocked,
    /** Requests served without spending a call — the number that matters. */
    savedByCache: cached + mocked,
    cacheHitRate: total > 0 ? Math.round(((cached + mocked) / total) * 100) : 0,
    totalTokens: bySource.reduce((sum, entry) => sum + (entry.tokens ?? 0), 0),
    averageLiveLatencyMs: result?.latency?.[0]?.avgMs ?? 0,
    averageCacheLatencyMs: result?.cacheLatency?.[0]?.avgMs ?? 0,
    slowestLiveMs: result?.latency?.[0]?.maxMs ?? 0,
    byFeature: result?.byFeature ?? [],
    failures: result?.failures ?? [],
    topUsers: result?.topUsers ?? [],
  };
};

export const AiUsageLog = model('AiUsageLog', aiUsageLogSchema);

export default AiUsageLog;
