/**
 * TAXONOMY CONTROLLER — authors, publishers and categories
 * Authors and publishers share their CRUD through a service factory (see
 * taxonomy.service.js), so their controllers are produced by a small factory
 * too. Categories get explicit handlers, because the tree gives them
 */

import { createTaxonomyService } from '../services/taxonomy.service.js';
import * as categoryService from '../services/category.service.js';
import { Author } from '../models/Author.js';
import { Publisher } from '../models/Publisher.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ok, created, paginated, noContent } from '../utils/ApiResponse.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import {
  toAuthor,
  toPublisher,
  toCategory,
  listAuthors,
  listPublishers,
  listCategories,
  listBookSummaries,
} from '../serializers/catalog.serializer.js';

/* Service instances */

export const authorService = createTaxonomyService({
  model: Author,
  label: 'author',
  bookField: 'authors',
  notFoundCode: ERROR_CODES.AUTHOR_NOT_FOUND,
  hasBooksCode: ERROR_CODES.AUTHOR_HAS_BOOKS,
  sortableFields: ['name', 'bookCount', 'createdAt', 'birthYear'],
});

export const publisherService = createTaxonomyService({
  model: Publisher,
  label: 'publisher',
  bookField: 'publisher',
  notFoundCode: ERROR_CODES.PUBLISHER_NOT_FOUND,
  hasBooksCode: ERROR_CODES.PUBLISHER_HAS_BOOKS,
  sortableFields: ['name', 'bookCount', 'createdAt', 'foundedYear'],
});

/* Controller factory */

/**
 * Build the seven handlers a taxonomy resource needs.
 * @param {object} service A service from createTaxonomyService.
 */
const makeTaxonomyController = (service, serialize, serializeList, label) => ({
  list: asyncHandler(async (req, res) => {
    const { items, meta } = await service.list(req.query);
    return paginated(res, serializeList(items), meta, `${label}s fetched`);
  }),

  get: asyncHandler(async (req, res) => {
    const record = await service.getByIdOrSlug(req.params.identifier);
    return ok(res, serialize(record), `${label} fetched`);
  }),

  create: asyncHandler(async (req, res) => {
    const record = await service.create(req.body);
    return created(res, serialize(record), `${label} created`);
  }),

  update: asyncHandler(async (req, res) => {
    const record = await service.update(req.params.identifier, req.body);
    return ok(res, serialize(record), `${label} updated`);
  }),

  remove: asyncHandler(async (req, res) => {
    await service.remove(req.params.identifier);
    return noContent(res);
  }),

  listBooks: asyncHandler(async (req, res) => {
    const { record, items, meta } = await service.listBooks(req.params.identifier, req.query);
    return paginated(res, listBookSummaries(items), meta, `Books by this ${label} fetched`, {
      [label]: serialize(record),
    });
  }),

  /** Fold a duplicate into this record, repointing every book at it. */
  merge: asyncHandler(async (req, res) => {
    const { target, booksReassigned } = await service.merge(req.body.source, req.params.identifier);
    return ok(
      res,
      { [label]: serialize(target), booksReassigned },
      `Merged into "${target.name}" — ${booksReassigned} book(s) reassigned`
    );
  }),
});

export const authorController = makeTaxonomyController(authorService, toAuthor, listAuthors, 'author');
export const publisherController = makeTaxonomyController(
  publisherService,
  toPublisher,
  listPublishers,
  'publisher'
);

/* Categories */

export const categoryController = {
  /** The whole tree as nested objects, for a browse page. */
  tree: asyncHandler(async (req, res) => {
    const tree = await categoryService.getTree();
    return ok(res, listCategories(tree), 'Category tree fetched');
  }),

  list: asyncHandler(async (req, res) => {
    const { items, meta } = await categoryService.list(req.query);
    return paginated(res, listCategories(items), meta, 'Categories fetched');
  }),

  get: asyncHandler(async (req, res) => {
    const category = await categoryService.getByIdOrSlug(req.params.identifier);
    return ok(res, toCategory(category), 'Category fetched');
  }),

  /** The trail from the root down to this category, for navigation. */
  breadcrumb: asyncHandler(async (req, res) => {
    const trail = await categoryService.getBreadcrumb(req.params.identifier);
    return ok(res, listCategories(trail), 'Breadcrumb fetched');
  }),

  children: asyncHandler(async (req, res) => {
    const children = await categoryService.listChildren(req.params.identifier);
    return ok(res, listCategories(children), 'Subcategories fetched');
  }),

  /**
   * Books in a category, INCLUDING every descendant by default — browsing
   * "Science" should surface a machine-learning textbook filed four levels
   * down, not an empty page.
   */
  listBooks: asyncHandler(async (req, res) => {
    const { category, categoryIds, items, meta } = await categoryService.listBooks(
      req.params.identifier,
      req.query
    );

    return paginated(res, listBookSummaries(items), meta, 'Books in this category fetched', {
      category: toCategory(category),
      includedCategories: categoryIds.length,
    });
  }),

  create: asyncHandler(async (req, res) => {
    const category = await categoryService.create(req.body);
    return created(res, toCategory(category), 'Category created');
  }),

  update: asyncHandler(async (req, res) => {
    const category = await categoryService.update(req.params.identifier, req.body);
    return ok(res, toCategory(category), 'Category updated');
  }),

  remove: asyncHandler(async (req, res) => {
    await categoryService.remove(req.params.identifier);
    return noContent(res);
  }),
};

export default { authorController, publisherController, categoryController };
