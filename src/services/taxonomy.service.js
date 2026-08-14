/**
 * ---------------------------------------------------------------------------
 * TAXONOMY SERVICE — shared CRUD for Author and Publisher
 * ---------------------------------------------------------------------------
 * Authors and publishers are structurally the same thing: a named entity that
 * books point at, carrying a slug, a denormalised `bookCount`, and a soft
 * delete. Writing the same six functions twice would mean fixing every bug
 * twice, so a factory produces both.
 *
 * Categories are NOT built from this factory — the ancestor tree makes their
 * create, move and delete genuinely different operations, and forcing them
 * into a shared shape would obscure that.
 *
 * THE DELETE GUARD IS THE INTERESTING PART. Deleting an author who still has
 * books would leave those books pointing at a document that no longer exists,
 * and every book page would then render a blank author. So deletion is refused
 * while references remain, and the error says exactly how many.
 * ---------------------------------------------------------------------------
 */

import { Book } from '../models/Book.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { parsePagination, parseSort, paginateQuery } from '../utils/pagination.js';
import { escapeRegex } from '../utils/sanitize.js';
import logger from '../utils/logger.js';

/**
 * Build a CRUD service for a taxonomy model.
 *
 * @param {object} options
 * @param {import('mongoose').Model} options.model
 * @param {string} options.label Human-readable name, used in messages.
 * @param {string} options.bookField The field on Book referencing this model.
 * @param {string} options.notFoundCode
 * @param {string} options.hasBooksCode
 * @param {string[]} options.sortableFields
 */
export const createTaxonomyService = ({
  model,
  label,
  bookField,
  notFoundCode,
  hasBooksCode,
  sortableFields,
}) => {
  /** Fetch by id or slug, so both work in a URL. */
  const getByIdOrSlug = async (identifier) => {
    const record = await model.findByIdOrSlug(identifier);
    if (!record) throw ApiError.notFound(`No such ${label}`, notFoundCode);
    return record;
  };

  const list = async (query) => {
    const { page, limit, skip } = parsePagination(query);
    const sort = parseSort(query.sort, sortableFields, { name: 1 });

    const filter = { isDeleted: false };

    /**
     * Partial, case-insensitive match rather than the text index: staff type
     * fragments ("achi" for "Achebe"), which a word-boundary text index will
     * not match. The term is escaped, so a search for "C++" cannot become an
     * invalid or pathological pattern.
     */
    if (query.search) {
      filter.name = new RegExp(escapeRegex(query.search), 'i');
    }

    // "Only entries that actually have books" — the useful default for a
    // browse page, where empty authors are noise.
    if (query.hasBooks === true) filter.bookCount = { $gt: 0 };

    return paginateQuery(model, filter, { sort, page, limit, skip });
  };

  const create = async (data) => {
    const existing = await model.findOne({
      name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'),
      isDeleted: false,
    });

    if (existing) {
      throw ApiError.conflict(
        `A ${label} named "${existing.name}" already exists`,
        ERROR_CODES.DUPLICATE_RESOURCE,
        { details: { existingId: String(existing._id), slug: existing.slug } }
      );
    }

    return model.create(data);
  };

  const update = async (identifier, data) => {
    const record = await getByIdOrSlug(identifier);

    // A rename must not collide with another record's name.
    if (data.name && data.name.toLowerCase() !== record.name.toLowerCase()) {
      const clash = await model.findOne({
        name: new RegExp(`^${escapeRegex(data.name)}$`, 'i'),
        _id: { $ne: record._id },
        isDeleted: false,
      });
      if (clash) {
        throw ApiError.conflict(
          `Another ${label} is already named "${clash.name}"`,
          ERROR_CODES.DUPLICATE_RESOURCE
        );
      }
    }

    Object.assign(record, data);
    await record.save();
    return record;
  };

  /**
   * Soft-delete, refusing while books still reference this record.
   *
   * Deleting anyway would leave those books pointing at nothing, and a book
   * page rendering a blank author is a data bug that surfaces much later and
   * far from its cause.
   */
  const remove = async (identifier) => {
    const record = await getByIdOrSlug(identifier);

    const bookCount = await Book.countDocuments({ [bookField]: record._id, isDeleted: false });

    if (bookCount > 0) {
      throw ApiError.conflict(
        `Cannot delete this ${label}: ${bookCount} book${bookCount === 1 ? '' : 's'} still reference${bookCount === 1 ? 's' : ''} it. Reassign or remove those books first.`,
        hasBooksCode,
        { details: { bookCount } }
      );
    }

    record.isDeleted = true;
    record.deletedAt = new Date();
    await record.save();

    return record;
  };

  /** Books attributed to this record. */
  const listBooks = async (identifier, query) => {
    const record = await getByIdOrSlug(identifier);
    const { page, limit, skip } = parsePagination(query);

    const result = await paginateQuery(
      Book,
      { [bookField]: record._id, isDeleted: false, status: 'ACTIVE' },
      {
        sort: parseSort(query.sort, ['title', 'publishedYear', 'rating.average'], { title: 1 }),
        page,
        limit,
        skip,
        populate: [
          { path: 'authors', select: 'name slug' },
          { path: 'publisher', select: 'name slug' },
        ],
      }
    );

    return { record, ...result };
  };

  /**
   * Merge a duplicate into a canonical record.
   *
   * Catalogues accumulate duplicates — "J.R.R. Tolkien" and "J. R. R. Tolkien"
   * arrive from different import sources, and neither is wrong. Merging
   * repoints every book at the survivor and retires the other, which is the
   * only way to make an author page complete again.
   */
  const merge = async (sourceIdentifier, targetIdentifier) => {
    const source = await getByIdOrSlug(sourceIdentifier);
    const target = await getByIdOrSlug(targetIdentifier);

    if (String(source._id) === String(target._id)) {
      throw ApiError.badRequest(`Cannot merge a ${label} into itself`, ERROR_CODES.BAD_REQUEST);
    }

    // `authors`/`categories` are arrays while `publisher` is a scalar, so the
    // repoint differs. Detected from the existing value rather than hard-coded.
    const isArrayField = Array.isArray(Book.schema.path(bookField)?.options?.type);

    const result = isArrayField
      ? await Book.updateMany({ [bookField]: source._id }, { $set: { [`${bookField}.$`]: target._id } })
      : await Book.updateMany({ [bookField]: source._id }, { $set: { [bookField]: target._id } });

    source.isDeleted = true;
    source.deletedAt = new Date();
    await source.save();

    // Both counts are now wrong; recompute rather than adjust, so the numbers
    // are correct regardless of what the update actually matched.
    target.bookCount = await Book.countDocuments({ [bookField]: target._id, isDeleted: false });
    await target.save();

    logger.info(`Merged ${label}`, {
      from: source.name,
      into: target.name,
      booksReassigned: result.modifiedCount,
    });

    return { target, booksReassigned: result.modifiedCount };
  };

  /** Recompute the denormalised book count. Used by the nightly reconciliation. */
  const recalculateBookCount = async (recordId) => {
    const count = await Book.countDocuments({ [bookField]: recordId, isDeleted: false });
    await model.updateOne({ _id: recordId }, { $set: { bookCount: count } });
    return count;
  };

  return { getByIdOrSlug, list, create, update, remove, listBooks, merge, recalculateBookCount };
};

export default createTaxonomyService;
