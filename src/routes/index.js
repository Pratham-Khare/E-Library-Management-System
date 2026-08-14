/**
 * ---------------------------------------------------------------------------
 * API v1 ROUTER
 * ---------------------------------------------------------------------------
 * Mounts every versioned resource router under the configured API prefix
 * (default `/api/v1`). One file to read to see the full surface of the API.
 *
 * Routers are added here as each phase lands; the list below reflects what is
 * currently wired up.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import config from '../config/index.js';
import authRoutes from './v1/auth.routes.js';
import userRoutes from './v1/user.routes.js';
import bookRoutes from './v1/book.routes.js';
import searchRoutes from './v1/search.routes.js';
import fileRoutes from './v1/file.routes.js';
import loanRoutes from './v1/loan.routes.js';
import fineRoutes from './v1/fine.routes.js';
import aiRoutes from './v1/ai.routes.js';
import adminRoutes from './v1/admin.routes.js';
import {
  reviewRouter,
  readingListRouter,
  notificationRouter,
} from './v1/engagement.routes.js';
import { authorRouter, publisherRouter, categoryRouter } from './v1/taxonomy.routes.js';

const router = Router();

/**
 * @openapi
 * /:
 *   get:
 *     tags: [Health]
 *     summary: API index
 *     description: Reports the API version and points at the documentation.
 *     security: []
 *     responses:
 *       200:
 *         description: API metadata.
 */
router.get('/', (req, res) => {
  res.json({
    success: true,
    message: `${config.app.name} API v1`,
    data: {
      name: config.app.name,
      version: config.app.version,
      environment: config.app.env,
      documentation: `${config.app.url}${config.swagger.route}`,
      openapiSpec: `${config.app.url}${config.swagger.jsonRoute}`,
      health: `${config.app.url}/health`,
    },
  });
});

/* ===========================================================================
 * Resource routers
 * ======================================================================== */

router.use('/auth', authRoutes);
router.use('/users', userRoutes);
router.use('/books', bookRoutes);
router.use('/authors', authorRouter);
router.use('/publishers', publisherRouter);
router.use('/categories', categoryRouter);
router.use('/search', searchRoutes);
router.use('/files', fileRoutes);
router.use('/loans', loanRoutes);
router.use('/fines', fineRoutes);
router.use('/reviews', reviewRouter);
router.use('/reading-lists', readingListRouter);
router.use('/notifications', notificationRouter);
router.use('/ai', aiRoutes);
router.use('/admin', adminRoutes);

export default router;
