/**
 * ---------------------------------------------------------------------------
 * CATEGORY SERVICE — the subject tree
 * ---------------------------------------------------------------------------
 * Categories are not built from the taxonomy factory because the hierarchy
 * makes their operations genuinely different: creating one computes an
 * ancestor path, moving one rewrites every descendant's path, and deleting one
 * has to decide what happens to the branch beneath it.
 *
 * `subtreeIds()` is the function the rest of the system depends on: it turns
 * "books in Science" into a filter that also matches books tagged only with
 * "Machine Learning", four levels down. Without it, category filtering would
 * only ever match exact tags and the tree would be decorative.
 * ---------------------------------------------------------------------------
 */

import { Category } from '../models/Category.js';
import { Book } from '../models/Book.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import { escapeRegex } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

export const getByIdOrSlug = async (identifier) => {
  const category = await Category.findByIdOrSlug(identifier);
  if (!category) throw ApiError.notFound('No such category', ERROR_CODES.CATEGORY_NOT_FOUND);
  return category;
};

/** The whole tree as nested objects, for a browse page. */
export const getTree = async () => Category.buildTree();

/** Flat, paginated list with optional filtering by depth or parent. */
export const list = async (query) => {
  const { page, limit, skip } = parsePagination(query);
  const sort = parseSort(query.sort, ['name', 'displayOrder', 'bookCount', 'depth'], {
    depth: 1,
    displayOrder: 1,
    name: 1,
  });

  const filter = { isDeleted: false };

  if (query.search) filter.name = new RegExp(escapeRegex(query.search), 'i');
  if (query.depth !== undefined) filter.depth = query.depth;
  // `?parent=root` is how a client asks for top-level categories, since an
  // empty query parameter cannot express "null".
  if (query.parent === 'root') filter.parent = null;
  else if (query.parent) filter.parent = query.parent;

  return paginateQuery(Category, filter, { sort, page, limit, skip });
};

/**
 * Create a category, optionally under a parent.
 *
 * The ancestor path and depth are computed by the model's pre-save hook, which
 * also rejects a cycle — so this only has to validate the parent exists and
 * give a readable error if it does not.
 */
export const create = async (data) => {
  if (data.parent) {
    const parent = await Category.findOne({ _id: data.parent, isDeleted: false });
    if (!parent) {
      throw ApiError.badRequest(
        'The specified parent category does not exist',
        ERROR_CODES.CATEGORY_NOT_FOUND
      );
    }
  }

  const existing = await Category.findOne({
    name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'),
    parent: data.parent ?? null,
    isDeleted: false,
  });

  // Deliberately scoped to the same parent. "History" may legitimately exist
  // under both "Science" and "Arts"; only siblings must have distinct names.
  if (existing) {
    throw ApiError.conflict(
      `A category named "${existing.name}" already exists at this level`,
      ERROR_CODES.DUPLICATE_RESOURCE
    );
  }

  return Category.create(data);
};

/**
 * Update a category, including moving it to a different parent.
 *
 * A MOVE IS THE EXPENSIVE CASE. Because ancestors are materialised on every
 * descendant, re-parenting a node invalidates the stored path of everything
 * beneath it — so `rebuildDescendantAncestors()` rewrites the subtree in one
 * bulk operation. This is the cost that buys single-query subtree reads.
 */
export const update = async (identifier, data) => {
  const category = await getByIdOrSlug(identifier);

  const isMoving = data.parent !== undefined && String(data.parent ?? '') !== String(category.parent ?? '');

  if (isMoving && data.parent) {
    const parent = await Category.findOne({ _id: data.parent, isDeleted: false });
    if (!parent) {
      throw ApiError.badRequest(
        'The specified parent category does not exist',
        ERROR_CODES.CATEGORY_NOT_FOUND
      );
    }
  }

  Object.assign(category, data);

  try {
    await category.save();
  } catch (error) {
    // The model's pre-save hook throws a plain Error for a cycle; translate it
    // into a typed API error the client can branch on.
    if (error.message?.includes('cycle') || error.message?.includes('own parent')) {
      throw ApiError.badRequest(error.message, ERROR_CODES.CATEGORY_CYCLE_DETECTED);
    }
    throw error;
  }

  if (isMoving) {
    const { modified } = await Category.rebuildDescendantAncestors(category._id);
    if (modified > 0) {
      logger.info('Rebuilt ancestor paths after a category move', {
        category: category.name,
        descendantsUpdated: modified,
      });
    }
  }

  return category;
};

/**
 * Soft-delete a category.
 *
 * Refused while it holds books OR has children. Deleting a node with children
 * would strand the whole branch: the children keep an ancestor id pointing at
 * a deleted record, so they vanish from the tree without ever being deleted
 * themselves — a far more confusing outcome than an error.
 */
export const remove = async (identifier) => {
  const category = await getByIdOrSlug(identifier);

  const childCount = await Category.countDocuments({ parent: category._id, isDeleted: false });
  if (childCount > 0) {
    throw ApiError.conflict(
      `Cannot delete this category: it has ${childCount} subcategor${childCount === 1 ? 'y' : 'ies'}. Delete or move those first.`,
      ERROR_CODES.CONFLICT,
      { details: { childCount } }
    );
  }

  const bookCount = await Book.countDocuments({ categories: category._id, isDeleted: false });
  if (bookCount > 0) {
    throw ApiError.conflict(
      `Cannot delete this category: ${bookCount} book${bookCount === 1 ? '' : 's'} still use${bookCount === 1 ? 's' : ''} it.`,
      ERROR_CODES.CATEGORY_HAS_BOOKS,
      { details: { bookCount } }
    );
  }

  category.isDeleted = true;
  category.deletedAt = new Date();
  await category.save();

  return category;
};

/**
 * Books in a category, INCLUDING every descendant category by default.
 *
 * This is the behaviour a user expects: browsing "Science" should surface a
 * machine-learning textbook filed four levels down, not an empty page because
 * nothing was tagged with the broad category directly.
 *
 * @param {string} identifier
 * @param {object} query
 * @param {boolean} [query.includeDescendants] Defaults to true.
 */
export const listBooks = async (identifier, query) => {
  const category = await getByIdOrSlug(identifier);
  const { page, limit, skip } = parsePagination(query);

  // One indexed query on the materialised path, at any depth.
  const categoryIds =
    query.includeDescendants === false
      ? [category._id]
      : await Category.subtreeIds(category._id);

  const result = await paginateQuery(
    Book,
    { categories: { $in: categoryIds }, isDeleted: false, status: 'ACTIVE' },
    {
      sort: parseSort(query.sort, ['title', 'publishedYear', 'rating.average', 'stats.loanCount'], {
        title: 1,
      }),
      page,
      limit,
      skip,
      populate: [
        { path: 'authors', select: 'name slug' },
        { path: 'publisher', select: 'name slug' },
      ],
    }
  );

  return { category, categoryIds, ...result };
};

/** Immediate children of a category. */
export const listChildren = async (identifier) => {
  const category = await getByIdOrSlug(identifier);
  return Category.find({ parent: category._id, isDeleted: false })
    .sort({ displayOrder: 1, name: 1 })
    .lean();
};

/**
 * The breadcrumb trail from the root down to this category.
 *
 * `ancestors` is stored root-first, so the trail needs no traversal — one
 * query fetches every level, and the order is preserved by re-sorting against
 * the stored array (`$in` does not guarantee result order).
 */
export const getBreadcrumb = async (identifier) => {
  const category = await getByIdOrSlug(identifier);

  if (!category.ancestors?.length) return [category];

  const ancestors = await Category.find({ _id: { $in: category.ancestors } })
    .select('name slug depth')
    .lean();

  const byId = new Map(ancestors.map((doc) => [String(doc._id), doc]));
  const ordered = category.ancestors.map((id) => byId.get(String(id))).filter(Boolean);

  return [...ordered, category];
};

/** Recompute the denormalised book count. Used by the nightly reconciliation. */
export const recalculateBookCount = async (categoryId) => {
  const count = await Book.countDocuments({ categories: categoryId, isDeleted: false });
  await Category.updateOne({ _id: categoryId }, { $set: { bookCount: count } });
  return count;
};

export default {
  getByIdOrSlug,
  getTree,
  list,
  create,
  update,
  remove,
  listBooks,
  listChildren,
  getBreadcrumb,
  recalculateBookCount,
};
