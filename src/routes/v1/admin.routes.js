/**
 * ADMIN ROUTES  —  /api/v1/admin
 * Analytics, reports, the audit log, bulk import/export, and manual job
 * triggers. Staff-only throughout; a few operations are admin-only.
 */

import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import * as adminService from '../../services/admin.service.js';
import { runJobNow } from '../../jobs/scheduler.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStaff, requireAdmin } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import { asyncHandler } from '../../utils/asyncHandler.js';
import { ok, accepted } from '../../utils/ApiResponse.js';
import { ApiError } from '../../utils/ApiError.js';
import { ERROR_CODES } from '../../constants/errorCodes.js';
import { objectId, optionalString, listQuery, queryBoolean, dateString } from '../../validators/common.js';
import { AUDIT_ACTION_VALUES, AUDIT_ENTITY_VALUES } from '../../constants/enums.js';

const router = Router();

router.use(authenticate, requireStaff);

/* --- Schemas -------------------------------------------------------------- */

const periodQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
});

const reportQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(90),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

const auditQuery = listQuery.extend({
  actor: objectId.optional(),
  action: z.enum(AUDIT_ACTION_VALUES).optional(),
  entity: z.enum(AUDIT_ENTITY_VALUES).optional(),
  entityId: objectId.optional(),
  from: dateString.optional(),
  to: dateString.optional(),
});

const importQuery = z.object({
  /** Validate and report without writing anything. */
  dryRun: queryBoolean.optional(),
});

const jobParam = z.object({
  job: z.enum(['overdue-check', 'due-reminders', 'digital-expiry', 'ai-usage-sync', 'cleanup']),
});

/**
 * CSV upload, held in memory.
 */
const csvUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) => {
    const accepted = ['text/csv', 'application/vnd.ms-excel', 'text/plain', 'application/csv'];
    if (!accepted.includes(file.mimetype)) {
      return cb(ApiError.unsupportedMediaType(`Expected a CSV file, received ${file.mimetype}`));
    }
    return cb(null, true);
  },
}).single('file');

/* Dashboard */

/**
 * @openapi
 * /admin/dashboard:
 *   get:
 *     tags: [Admin]
 *     summary: Library dashboard (staff only)
 *     description: |
 *       Every headline figure in one response — collection size and
 *       utilisation, open and overdue loans, membership breakdown, fine
 *       balances, and review activity.
 *
 *       Computed as a SINGLE aggregation pass per collection, so the figures
 *       are both fast and mutually consistent: separate queries could each see
 *       a different moment, and a dashboard whose totals disagree is worse than
 *       none.
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 30, maximum: 365 }
 *         description: Window for the period figures and the trend chart.
 *     responses:
 *       200:
 *         description: The dashboard.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     collection:
 *                       type: object
 *                       properties:
 *                         titles:               { type: integer, example: 15 }
 *                         copies:               { type: integer, example: 42 }
 *                         availableCopies:      { type: integer, example: 30 }
 *                         utilisationPercent:   { type: integer, example: 28 }
 *                     circulation:
 *                       type: object
 *                       properties:
 *                         openLoans:                { type: integer }
 *                         overdueLoans:             { type: integer }
 *                         overdueRatePercent:       { type: integer }
 *                         averageLoanDurationDays:  { type: number }
 *                         trend:                    { type: array, items: { type: object } }
 *                     members:  { type: object }
 *                     finances: { type: object }
 *                     engagement: { type: object }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/dashboard',
  validate({ query: periodQuery }),
  asyncHandler(async (req, res) => {
    const dashboard = await adminService.getDashboard({ days: req.query.days });
    return ok(res, dashboard, 'Dashboard');
  })
);

/* Reports */

/**
 * @openapi
 * /admin/reports/popular:
 *   get:
 *     tags: [Admin]
 *     summary: Most-borrowed titles (staff only)
 *     parameters:
 *       - in: query
 *         name: days
 *         schema: { type: integer, default: 90 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: 'Ranked titles with loan counts.' }
 *
 * /admin/reports/unborrowed:
 *   get:
 *     tags: [Admin]
 *     summary: Titles nobody has borrowed (staff only)
 *     description: >
 *       The report that changes acquisition decisions — shelf space spent on
 *       stock that has not moved. Recently added titles are excluded, since
 *       they have not had a fair chance yet.
 *     responses:
 *       200: { description: 'Unborrowed titles, oldest first.' }
 *
 * /admin/reports/active-members:
 *   get:
 *     tags: [Admin]
 *     summary: Most active members (staff only)
 *     responses:
 *       200: { description: 'Members ranked by loans in the period.' }
 *
 * /admin/reports/inventory-health:
 *   get:
 *     tags: [Admin]
 *     summary: Inventory condition (staff only)
 *     description: >
 *       Copy counts by status, plus the most heavily circulated copies — the
 *       ones approaching replacement.
 *     responses:
 *       200: { description: 'Inventory health.' }
 */
router.get(
  '/reports/popular',
  validate({ query: reportQuery }),
  asyncHandler(async (req, res) =>
    ok(res, await adminService.getPopularBooks(req.query), 'Most borrowed')
  )
);

router.get(
  '/reports/unborrowed',
  validate({ query: reportQuery }),
  asyncHandler(async (req, res) =>
    ok(res, await adminService.getUnborrowedBooks({ limit: req.query.limit }), 'Never borrowed')
  )
);

router.get(
  '/reports/active-members',
  validate({ query: reportQuery }),
  asyncHandler(async (req, res) =>
    ok(res, await adminService.getActiveMembers(req.query), 'Most active members')
  )
);

router.get(
  '/reports/inventory-health',
  asyncHandler(async (req, res) =>
    ok(res, await adminService.getInventoryHealth(), 'Inventory health')
  )
);

/* Audit log */

/**
 * @openapi
 * /admin/audit-log:
 *   get:
 *     tags: [Admin]
 *     summary: The audit log (admin only)
 *     description: >
 *       Every privileged mutation — who did what, to which record, and WHAT
 *       CHANGED. The diff records only the fields that actually changed, so
 *       "updated a book" becomes "changed price from 399 to 39".
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - in: query
 *         name: actor
 *         schema: { type: string }
 *       - in: query
 *         name: action
 *         schema: { type: string, enum: [CREATE, UPDATE, DELETE, ROLE_CHANGE, SUSPEND, FINE_WAIVE, BULK_IMPORT] }
 *       - in: query
 *         name: entity
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date }
 *     responses:
 *       200: { description: 'Audit entries, newest first.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.get(
  '/audit-log',
  requireAdmin,
  validate({ query: auditQuery }),
  asyncHandler(async (req, res) => {
    const { items, meta } = await adminService.listAuditLog(req.query);
    return ok(res, items, 'Audit log', meta);
  })
);

/* Bulk import / export */

/**
 * @openapi
 * /admin/books/import:
 *   post:
 *     tags: [Admin]
 *     summary: Bulk-import books from CSV (staff only)
 *     description: |
 *       Columns: `title` (required), `subtitle`, `isbn13`, `authors`,
 *       `publisher`, `categories`, `language`, `publishedYear`, `pageCount`,
 *       `description`, `price`, `tags`, `copies`, `shelfLocation`.
 *
 *       Multiple authors or categories go in one cell separated by `;` or `|`.
 *       Authors, publishers and categories are matched BY NAME and created if
 *       missing — a supplier's spreadsheet contains names, not IDs.
 *
 *       **Use `?dryRun=true` first.** It validates every row and reports what
 *       WOULD happen without writing anything. Importing 800 books and finding
 *       out at row 400 that the file was malformed is a bad afternoon.
 *
 *       One bad row is reported and skipped, not fatal — rejecting 799 good
 *       rows over a single typo helps nobody. Every error carries the SOURCE
 *       LINE NUMBER, so it can be found in the spreadsheet.
 *     parameters:
 *       - in: query
 *         name: dryRun
 *         schema: { type: boolean }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       200:
 *         description: Import result.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:   { type: integer, example: 120 }
 *                     created: { type: integer, example: 118 }
 *                     skipped: { type: integer, example: 2 }
 *                     dryRun:  { type: boolean }
 *                     errors:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           line:  { type: integer, example: 47 }
 *                           title: { type: string }
 *                           error: { type: string, example: 'Invalid ISBN "9780385474543"' }
 *       400: { description: 'Unreadable CSV, missing columns, or too many rows.' }
 */
router.post(
  '/books/import',
  csvUpload,
  validate({ query: importQuery }),
  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.badRequest(
        'No CSV uploaded. Send it as multipart/form-data in the "file" field.',
        ERROR_CODES.FILE_REQUIRED
      );
    }

    const result = await adminService.importBooksFromCsv(
      req.file.buffer.toString('utf8'),
      { dryRun: req.query.dryRun === true },
      req.user
    );

    if (!result.dryRun && result.created > 0) {
      await adminService.audit({
        actor: req.user,
        action: 'BULK_IMPORT',
        entity: 'BOOK',
        note: `Imported ${result.created} book(s) from CSV, skipped ${result.skipped}`,
        req,
      });
    }

    return ok(
      res,
      result,
      result.dryRun
        ? `Dry run: ${result.created} row(s) would be imported, ${result.skipped} skipped`
        : `Imported ${result.created} book(s), skipped ${result.skipped}`
    );
  })
);

/**
 * @openapi
 * /admin/books/export:
 *   get:
 *     tags: [Admin]
 *     summary: Export the catalogue as CSV (staff only)
 *     description: >
 *       Exported in the SAME shape the importer accepts, so a catalogue can be
 *       exported, edited in a spreadsheet, and re-imported.
 *     responses:
 *       200:
 *         description: A CSV file.
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */
router.get(
  '/books/export',
  asyncHandler(async (req, res) => {
    const csv = await adminService.exportBooksToCsv();

    const filename = `catalogue-${new Date().toISOString().slice(0, 10)}.csv`;
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    // A BOM, so Excel opens UTF-8 correctly instead of mangling accented names.
    return res.send(`﻿${csv}`);
  })
);

/* Manual job triggers */

/**
 * @openapi
 * /admin/jobs/{job}/run:
 *   post:
 *     tags: [Admin]
 *     summary: Run a scheduled job now (admin only)
 *     description: |
 *       Triggers a background job on demand instead of waiting for its
 *       schedule. Genuinely useful in two situations: verifying a change to the
 *       overdue rules without waiting until 00:30, and demonstrating the fine
 *       system in a review.
 *
 *       Jobs are IDEMPOTENT — running the overdue check twice updates the same
 *       fine rather than doubling anyone's debt.
 *     parameters:
 *       - in: path
 *         name: job
 *         required: true
 *         schema:
 *           type: string
 *           enum: [overdue-check, due-reminders, digital-expiry, ai-usage-sync, cleanup]
 *     responses:
 *       200: { description: 'What the job did, and how long it took.' }
 *       403: { $ref: '#/components/responses/Forbidden' }
 */
router.post(
  '/jobs/:job/run',
  requireAdmin,
  validate({ params: jobParam }),
  asyncHandler(async (req, res) => {
    const result = await runJobNow(req.params.job);

    await adminService.audit({
      actor: req.user,
      action: 'UPDATE',
      entity: 'SYSTEM',
      entityLabel: req.params.job,
      note: `Manually triggered the "${req.params.job}" job`,
      req,
    });

    return ok(res, result, `Job "${req.params.job}" finished in ${result.durationMs}ms`);
  })
);

export default router;
