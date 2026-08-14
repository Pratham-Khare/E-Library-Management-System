/**
 * ---------------------------------------------------------------------------
 * TAXONOMY ROUTES — /authors, /publishers, /categories
 * ---------------------------------------------------------------------------
 * Authors and publishers expose an identical route surface, so a factory
 * builds both routers rather than duplicating seven route definitions and
 * their guards. Categories get their own router, because the tree adds
 * operations the other two do not have.
 *
 * Reading is PUBLIC throughout — browsing a library's authors should not
 * require an account. Writing requires staff.
 * ---------------------------------------------------------------------------
 */

import { Router } from 'express';
import {
  authorController,
  publisherController,
  categoryController,
} from '../../controllers/taxonomy.controller.js';
import { authenticate } from '../../middlewares/authenticate.js';
import { requireStaff } from '../../middlewares/authorize.js';
import { validate } from '../../middlewares/validate.js';
import {
  createAuthorSchema,
  updateAuthorSchema,
  createPublisherSchema,
  updatePublisherSchema,
  createCategorySchema,
  updateCategorySchema,
  listCategoriesQuery,
  identifierParam,
  listTaxonomyQuery,
  taxonomyBooksQuery,
  mergeSchema,
} from '../../validators/catalog.validator.js';

/**
 * Build a router for a taxonomy resource.
 * @param {object} controller From makeTaxonomyController.
 * @param {object} schemas { create, update }
 */
const buildTaxonomyRouter = (controller, schemas) => {
  const router = Router();

  router
    .route('/')
    .get(validate({ query: listTaxonomyQuery }), controller.list)
    .post(authenticate, requireStaff, validate({ body: schemas.create }), controller.create);

  router
    .route('/:identifier')
    .get(validate({ params: identifierParam }), controller.get)
    .patch(
      authenticate,
      requireStaff,
      validate({ params: identifierParam, body: schemas.update }),
      controller.update
    )
    .delete(authenticate, requireStaff, validate({ params: identifierParam }), controller.remove);

  router.get(
    '/:identifier/books',
    validate({ params: identifierParam, query: taxonomyBooksQuery }),
    controller.listBooks
  );

  router.post(
    '/:identifier/merge',
    authenticate,
    requireStaff,
    validate({ params: identifierParam, body: mergeSchema }),
    controller.merge
  );

  return router;
};

/* ===========================================================================
 * Authors
 * ======================================================================== */

/**
 * @openapi
 * /authors:
 *   get:
 *     tags: [Authors]
 *     summary: List authors
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Partial, case-insensitive match on the name.
 *       - in: query
 *         name: hasBooks
 *         schema: { type: boolean }
 *         description: Only authors with at least one book.
 *     responses:
 *       200: { description: 'Paginated authors.' }
 *   post:
 *     tags: [Authors]
 *     summary: Create an author (staff only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, example: Chinua Achebe }
 *               bio:         { type: string }
 *               nationality: { type: string, example: Nigerian }
 *               birthYear:   { type: integer, example: 1930 }
 *               deathYear:   { type: integer, example: 2013 }
 *     responses:
 *       201: { description: 'Created. A URL slug is generated from the name.' }
 *       409: { description: 'An author with this name already exists.' }
 *
 * /authors/{identifier}:
 *   get:
 *     tags: [Authors]
 *     summary: Get an author
 *     description: Accepts an ID or a slug.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string, example: chinua-achebe }
 *     responses:
 *       200: { description: 'The author.' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   patch:
 *     tags: [Authors]
 *     summary: Update an author (staff only)
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Updated.' }
 *   delete:
 *     tags: [Authors]
 *     summary: Delete an author (staff only)
 *     description: >
 *       Refused while books still reference this author — deleting anyway
 *       would leave those books pointing at a record that no longer exists.
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: 'Deleted.' }
 *       409: { description: 'Books still reference this author (AUTHOR_HAS_BOOKS).' }
 *
 * /authors/{identifier}/books:
 *   get:
 *     tags: [Authors]
 *     summary: Books by this author
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Paginated books.' }
 *
 * /authors/{identifier}/merge:
 *   post:
 *     tags: [Authors]
 *     summary: Merge a duplicate author into this one (staff only)
 *     description: >
 *       Catalogues accumulate duplicates — "J.R.R. Tolkien" and
 *       "J. R. R. Tolkien" arrive from different import sources. This repoints
 *       every book from the source onto this author and retires the duplicate.
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *         description: The author to KEEP.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [source]
 *             properties:
 *               source: { type: string, description: 'ID or slug of the duplicate to retire.' }
 *     responses:
 *       200: { description: 'Merged, with the number of books reassigned.' }
 */
export const authorRouter = buildTaxonomyRouter(authorController, {
  create: createAuthorSchema,
  update: updateAuthorSchema,
});

/* ===========================================================================
 * Publishers
 * ======================================================================== */

/**
 * @openapi
 * /publishers:
 *   get:
 *     tags: [Publishers]
 *     summary: List publishers
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Paginated publishers.' }
 *   post:
 *     tags: [Publishers]
 *     summary: Create a publisher (staff only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, example: Penguin Books }
 *               description: { type: string }
 *               website:     { type: string, example: 'https://penguin.co.uk' }
 *               foundedYear: { type: integer, example: 1935 }
 *     responses:
 *       201: { description: 'Created.' }
 *
 * /publishers/{identifier}:
 *   get:
 *     tags: [Publishers]
 *     summary: Get a publisher
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The publisher.' }
 *   patch:
 *     tags: [Publishers]
 *     summary: Update a publisher (staff only)
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Updated.' }
 *   delete:
 *     tags: [Publishers]
 *     summary: Delete a publisher (staff only)
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: 'Deleted.' }
 *       409: { description: 'Books still reference this publisher.' }
 *
 * /publishers/{identifier}/books:
 *   get:
 *     tags: [Publishers]
 *     summary: Books from this publisher
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Paginated books.' }
 */
export const publisherRouter = buildTaxonomyRouter(publisherController, {
  create: createPublisherSchema,
  update: updatePublisherSchema,
});

/* ===========================================================================
 * Categories
 * ======================================================================== */

export const categoryRouter = Router();

/**
 * @openapi
 * /categories/tree:
 *   get:
 *     tags: [Categories]
 *     summary: The full category tree
 *     description: >
 *       Every category as nested objects, ready to render a browse page.
 *       Built from a single query using the stored ancestor paths — no
 *       recursive fetching.
 *     security: []
 *     responses:
 *       200: { description: 'Nested categories, each with a `children` array.' }
 */
categoryRouter.get('/tree', categoryController.tree);

/**
 * @openapi
 * /categories:
 *   get:
 *     tags: [Categories]
 *     summary: List categories (flat)
 *     security: []
 *     parameters:
 *       - $ref: '#/components/parameters/PageParam'
 *       - $ref: '#/components/parameters/LimitParam'
 *       - in: query
 *         name: parent
 *         schema: { type: string }
 *         description: A category ID, or `root` for top-level categories.
 *       - in: query
 *         name: depth
 *         schema: { type: integer }
 *         description: 0 is top-level.
 *     responses:
 *       200: { description: 'Paginated categories.' }
 *   post:
 *     tags: [Categories]
 *     summary: Create a category (staff only)
 *     description: >
 *       Omit `parent` for a top-level category. The ancestor path and depth are
 *       computed automatically.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name:        { type: string, example: Machine Learning }
 *               description: { type: string }
 *               parent:      { type: string, nullable: true, description: Parent category ID. }
 *               icon:        { type: string, example: brain }
 *     responses:
 *       201: { description: 'Created.' }
 *       409: { description: 'A sibling category already has this name.' }
 */
categoryRouter
  .route('/')
  .get(validate({ query: listCategoriesQuery }), categoryController.list)
  .post(authenticate, requireStaff, validate({ body: createCategorySchema }), categoryController.create);

/**
 * @openapi
 * /categories/{identifier}:
 *   get:
 *     tags: [Categories]
 *     summary: Get a category
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string, example: machine-learning }
 *     responses:
 *       200: { description: 'The category, including its ancestor path.' }
 *   patch:
 *     tags: [Categories]
 *     summary: Update or move a category (staff only)
 *     description: >
 *       Changing `parent` MOVES the category, which rewrites the stored
 *       ancestor path of every descendant. A move that would make the tree
 *       cyclic — re-parenting a node under its own descendant — is rejected.
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'Updated; descendants re-pathed if it moved.' }
 *       400: { description: 'The move would create a cycle (CATEGORY_CYCLE_DETECTED).' }
 *   delete:
 *     tags: [Categories]
 *     summary: Delete a category (staff only)
 *     description: >
 *       Refused if the category has subcategories or books. Deleting a node
 *       with children would strand the whole branch.
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       204: { description: 'Deleted.' }
 *       409: { description: 'Has subcategories or books (CATEGORY_HAS_BOOKS).' }
 */
categoryRouter
  .route('/:identifier')
  .get(validate({ params: identifierParam }), categoryController.get)
  .patch(
    authenticate,
    requireStaff,
    validate({ params: identifierParam, body: updateCategorySchema }),
    categoryController.update
  )
  .delete(authenticate, requireStaff, validate({ params: identifierParam }), categoryController.remove);

/**
 * @openapi
 * /categories/{identifier}/books:
 *   get:
 *     tags: [Categories]
 *     summary: Books in a category
 *     description: >
 *       Includes books in every DESCENDANT category by default, so browsing
 *       "Science" surfaces a machine-learning textbook filed four levels below
 *       it. Set `includeDescendants=false` for an exact-tag match only.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: includeDescendants
 *         schema: { type: boolean, default: true }
 *     responses:
 *       200: { description: 'Paginated books, with the number of categories included in `meta`.' }
 *
 * /categories/{identifier}/children:
 *   get:
 *     tags: [Categories]
 *     summary: Immediate subcategories
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The children.' }
 *
 * /categories/{identifier}/breadcrumb:
 *   get:
 *     tags: [Categories]
 *     summary: Breadcrumb trail from the root
 *     description: Root first, ending with the requested category.
 *     security: []
 *     parameters:
 *       - in: path
 *         name: identifier
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: 'The trail.' }
 */
categoryRouter.get(
  '/:identifier/books',
  validate({ params: identifierParam, query: taxonomyBooksQuery }),
  categoryController.listBooks
);
categoryRouter.get(
  '/:identifier/children',
  validate({ params: identifierParam }),
  categoryController.children
);
categoryRouter.get(
  '/:identifier/breadcrumb',
  validate({ params: identifierParam }),
  categoryController.breadcrumb
);

export default { authorRouter, publisherRouter, categoryRouter };
