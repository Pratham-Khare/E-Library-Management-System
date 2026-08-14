/**
 * ---------------------------------------------------------------------------
 * EXPRESS APPLICATION
 * ---------------------------------------------------------------------------
 * Builds and configures the Express app. Deliberately does NOT listen on a
 * port or connect to the database — server.js owns that. Keeping construction
 * separate from startup means the app can be imported and exercised without
 * side effects.
 *
 * MIDDLEWARE ORDER IS NOT ARBITRARY. Each layer depends on the ones before it:
 *
 *   1. trust proxy    — must precede anything that reads req.ip
 *   2. requestId      — so every later log line can be correlated
 *   3. helmet         — security headers before any response can be sent
 *   4. cors           — must precede routes to answer OPTIONS preflights
 *   5. compression    — must wrap the response stream before it is written
 *   6. body parsers   — populate req.body for the sanitiser
 *   7. sanitise       — strip injection keys BEFORE any handler reads them
 *   8. hpp            — collapse duplicated query parameters
 *   9. request log    — after the id exists, before handlers run
 *  10. rate limit     — reject excess traffic before it reaches business logic
 *  11. static files   — cheap, no auth needed
 *  12. routes         — the actual API
 *  13. 404            — only reached when nothing above matched
 *  14. error handler  — must be LAST; Express identifies it by arity
 * ---------------------------------------------------------------------------
 */

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import hpp from 'hpp';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';

import config from './config/index.js';
import logger from './utils/logger.js';

import requestId from './middlewares/requestId.js';
import sanitizeRequest from './middlewares/sanitize.js';
import requestLogger from './middlewares/requestLogger.js';
import { globalRateLimiter } from './middlewares/rateLimiter.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';

import healthRoutes from './routes/health.routes.js';
import apiRoutes from './routes/index.js';

const app = express();

/* ===========================================================================
 * 1. Proxy trust
 * ---------------------------------------------------------------------------
 * Behind a reverse proxy, req.ip is the PROXY's address unless Express is told
 * how many hops to unwind from X-Forwarded-For. Get this wrong and rate
 * limiting breaks: too low and every client shares one bucket, too high and a
 * client can spoof the header to mint a fresh bucket per request.
 * ======================================================================== */
app.set('trust proxy', config.app.trustProxy);

// Do not advertise the framework. Trivial to work around, but there is no
// reason to hand a scanner a free version fingerprint.
app.disable('x-powered-by');

/* ===========================================================================
 * 2. Request correlation
 * ======================================================================== */
app.use(requestId);

/* ===========================================================================
 * 3. Security headers
 * ---------------------------------------------------------------------------
 * A JSON API needs a different CSP from an HTML app. The one exception is
 * Swagger UI, which is real HTML with inline styles — so its CSP is relaxed
 * only on its own route, below, rather than weakening the policy globally.
 * ======================================================================== */
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Covers are served from this origin; data: supports inline placeholders.
        imgSrc: ["'self'", 'data:', 'blob:'],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    // Let a browser PDF viewer on another origin load a streamed ebook.
    crossOriginResourcePolicy: { policy: 'cross-origin' },
    // HSTS only makes sense over real HTTPS; on plain-HTTP local dev it would
    // pin localhost to https:// in the browser and be a nuisance to undo.
    hsts: config.app.isProduction
      ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
      : false,
  })
);

/* ===========================================================================
 * 4. CORS
 * ---------------------------------------------------------------------------
 * A function rather than a static list so the allow-list can be checked per
 * request and a rejected origin can be LOGGED — otherwise a blocked frontend
 * produces a browser console error with no server-side trace at all.
 * ======================================================================== */
app.use(
  cors({
    origin: (origin, callback) => {
      // No Origin header: same-origin, curl, Postman, or a server-to-server
      // call. Not a browser cross-origin request, so nothing to police.
      if (!origin) return callback(null, true);

      if (config.cors.allowAnyOrigin) return callback(null, true);
      if (config.cors.origins.includes(origin)) return callback(null, true);

      logger.warn('CORS: blocked a request from a disallowed origin', {
        origin,
        allowed: config.cors.origins,
      });
      return callback(new Error(`Origin ${origin} is not allowed by CORS policy`));
    },
    credentials: config.cors.credentials,
    methods: [...config.cors.methods],
    allowedHeaders: [...config.cors.allowedHeaders],
    exposedHeaders: [...config.cors.exposedHeaders],
    maxAge: config.cors.maxAge,
  })
);

/* ===========================================================================
 * 5. Compression
 * ---------------------------------------------------------------------------
 * Skipped for ebook streaming: PDFs and EPUBs are already compressed, so
 * gzipping them burns CPU for nothing — and worse, it breaks HTTP Range
 * requests, because byte offsets in the compressed stream do not correspond to
 * offsets in the file the reader is trying to seek within.
 * ======================================================================== */
app.use(
  compression({
    filter: (req, res) => {
      if (req.path.includes('/read') || req.path.includes('/download')) return false;
      if (req.headers['x-no-compression']) return false;
      return compression.filter(req, res);
    },
    threshold: 1024, // not worth the CPU below ~1KB
  })
);

/* ===========================================================================
 * 6. Body parsing
 * ---------------------------------------------------------------------------
 * The size limit is a real defence: without it a single request can be sized
 * to exhaust process memory. File uploads bypass these parsers entirely and
 * are handled by multer with its own, larger caps.
 * ======================================================================== */
app.use(express.json({ limit: config.app.bodyLimit }));
app.use(express.urlencoded({ extended: true, limit: config.app.bodyLimit }));
app.use(cookieParser());

/* ===========================================================================
 * 7. Injection sanitising
 * ---------------------------------------------------------------------------
 * Must run AFTER the body parsers (there is no req.body before them) and
 * BEFORE any route handler. See middlewares/sanitize.js.
 * ======================================================================== */
app.use(sanitizeRequest);

/* ===========================================================================
 * 8. HTTP parameter pollution
 * ---------------------------------------------------------------------------
 * `?role=MEMBER&role=ADMIN` arrives as an array. Code written expecting a
 * string then behaves unpredictably. hpp keeps the last value — except for
 * parameters that are legitimately repeatable.
 * ======================================================================== */
app.use(
  hpp({
    whitelist: ['tags', 'categories', 'authors', 'status', 'format', 'sort', 'fields'],
  })
);

/* ===========================================================================
 * 9. HTTP request logging
 * ======================================================================== */
app.use(requestLogger());

/* ===========================================================================
 * 10. Global rate limiting
 * ---------------------------------------------------------------------------
 * A blanket ceiling. Tighter per-route limiters (auth, search, upload, AI) are
 * applied at their own routes.
 * ======================================================================== */
app.use(globalRateLimiter());

/* ===========================================================================
 * 11. Static files
 * ---------------------------------------------------------------------------
 * Cover images and avatars only. EBOOKS ARE DELIBERATELY NOT SERVED HERE —
 * they are the library's actual assets, and a static mount would let anyone
 * with a URL download any book without borrowing it. Ebook access goes through
 * a controller that verifies an active digital loan and then streams with
 * Range support.
 * ======================================================================== */
const staticOptions = {
  maxAge: config.app.isProduction ? '7d' : 0,
  etag: true,
  index: false,
  // Refuse to follow a symlink out of the storage directory.
  dotfiles: 'deny',
};
app.use('/files/covers', express.static(config.upload.paths.covers, staticOptions));
app.use('/files/avatars', express.static(config.upload.paths.avatars, staticOptions));

/* ===========================================================================
 * 12. API documentation
 * ======================================================================== */
if (config.swagger.enabled) {
  try {
    const openapiSpec = swaggerJsdoc(config.swagger.options);

    // The raw spec — importable into Postman, or usable to generate a client.
    app.get(config.swagger.jsonRoute, (req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.send(openapiSpec);
    });

    app.use(
      config.swagger.route,
      // Swagger UI is real HTML with inline styles and scripts, so the global
      // JSON-API CSP would break it. Relaxed HERE ONLY, on this one route.
      helmet({ contentSecurityPolicy: false }),
      swaggerUi.serve,
      swaggerUi.setup(openapiSpec, config.swagger.uiOptions)
    );

    logger.debug(`Swagger UI mounted at ${config.swagger.route}`);
  } catch (error) {
    // Bad documentation should never stop the API from serving.
    logger.error('Failed to build the OpenAPI specification; docs will be unavailable', {
      error: error.message,
    });
  }
}

/* ===========================================================================
 * 13. Routes
 * ======================================================================== */

// Health probes live at the root so an orchestrator does not need to know the
// API version, and so they are not part of the versioned contract.
app.use('/', healthRoutes);

// Everything else is versioned.
app.use(config.app.apiPrefix, apiRoutes);

/**
 * Root landing response. Someone opening the base URL in a browser should get
 * a signpost rather than a bare 404.
 */
app.get('/', (req, res) => {
  res.json({
    success: true,
    message: `${config.app.name} — API is running`,
    data: {
      version: config.app.version,
      documentation: `${config.app.url}${config.swagger.route}`,
      api: `${config.app.url}${config.app.apiPrefix}`,
      health: `${config.app.url}/health`,
    },
  });
});

/* ===========================================================================
 * 14. Error handling — must be last
 * ======================================================================== */
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
