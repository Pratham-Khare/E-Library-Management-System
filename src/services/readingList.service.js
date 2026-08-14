/**
 * Favourites, custom shelves, and sharing.
 */

import logger from '../utils/logger.js';
import { ReadingList } from '../models/ReadingList.js';
import { Book } from '../models/Book.js';
import { ApiError } from '../utils/ApiError.js';
import { ERROR_CODES } from '../constants/errorCodes.js';
import { READING_LIST_TYPE, DEFAULT_READING_LISTS } from '../constants/enums.js';

/**
 * Ensure a member has their default shelves.
 */
export const ensureDefaults = async (userId) => {
  const existing = await ReadingList.countDocuments({ user: userId });
  if (existing > 0) return null;
  return ReadingList.createDefaultsFor(userId, DEFAULT_READING_LISTS);
};

export const listForUser = async (userId) => {
  await ensureDefaults(userId);

  return ReadingList.find({ user: userId })
    .sort({ type: 1, createdAt: 1 })
    .populate({
      path: 'items.book',
      select: 'title slug coverImage authors rating inventory',
      populate: { path: 'authors', select: 'name slug' },
    })
    .lean();
};

export const getById = async (listId, viewer = null) => {
  const list = await ReadingList.findById(listId).populate({
    path: 'items.book',
    select: 'title slug coverImage authors rating inventory publishedYear',
    populate: { path: 'authors', select: 'name slug' },
  });

  if (!list) throw ApiError.notFound('No such reading list', ERROR_CODES.LIST_NOT_FOUND);

  const isOwner = viewer && String(list.user) === String(viewer.id);
  if (!list.isPublic && !isOwner) {
    // 404 rather than 403 here — unlike a loan, the mere EXISTENCE of someone's
    // private reading list is not something a stranger should be able to confirm.
    throw ApiError.notFound('No such reading list', ERROR_CODES.LIST_NOT_FOUND);
  }

  return list;
};

/** A public list, by its unguessable share slug. */
export const getByShareSlug = async (slug) => {
  const list = await ReadingList.findOne({ shareSlug: slug, isPublic: true })
    .populate('user', 'name avatar')
    .populate({
      path: 'items.book',
      select: 'title slug coverImage authors rating',
      populate: { path: 'authors', select: 'name slug' },
    });

  if (!list) throw ApiError.notFound('No such shared list', ERROR_CODES.LIST_NOT_FOUND);
  return list;
};

export const create = async (userId, { name, description, isPublic }) => {
  const existing = await ReadingList.findOne({ user: userId, name: name.trim() });
  if (existing) {
    throw ApiError.conflict(
      `You already have a list called "${name}"`,
      ERROR_CODES.DUPLICATE_RESOURCE
    );
  }

  return ReadingList.create({
    user: userId,
    name: name.trim(),
    description,
    type: READING_LIST_TYPE.CUSTOM,
    isPublic: isPublic ?? false,
    shareSlug: isPublic ? ReadingList.generateShareSlug() : null,
  });
};

const loadOwned = async (listId, userId) => {
  const list = await ReadingList.findOne({ _id: listId, user: userId });
  if (!list) throw ApiError.notFound('No such reading list', ERROR_CODES.LIST_NOT_FOUND);
  return list;
};

export const update = async (listId, userId, data) => {
  const list = await loadOwned(listId, userId);

  // The four defaults are structural. Renaming "Favorites" would break every
  // client that looks it up by type.
  if (list.isDefault && data.name !== undefined) {
    throw ApiError.badRequest(
      'The default shelves cannot be renamed',
      ERROR_CODES.CANNOT_MODIFY_DEFAULT_LIST
    );
  }

  if (data.name !== undefined) list.name = data.name.trim();
  if (data.description !== undefined) list.description = data.description;

  if (data.isPublic !== undefined) {
    list.isPublic = data.isPublic;
    // Mint a slug on first share; drop it when unshared, so an old link dies.
    if (data.isPublic && !list.shareSlug) list.shareSlug = ReadingList.generateShareSlug();
    if (!data.isPublic) list.shareSlug = null;
  }

  await list.save();
  return list;
};

export const remove = async (listId, userId) => {
  const list = await loadOwned(listId, userId);

  if (list.isDefault) {
    throw ApiError.badRequest(
      'The default shelves cannot be deleted',
      ERROR_CODES.CANNOT_MODIFY_DEFAULT_LIST
    );
  }

  await list.deleteOne();
  return { deleted: true };
};

/** Add a book to a list. */
export const addBook = async (listId, userId, bookId, note = null) => {
  const list = await loadOwned(listId, userId);

  const book = await Book.findOne({ _id: bookId, isDeleted: false }).select('_id title');
  if (!book) throw ApiError.notFound('No such book', ERROR_CODES.BOOK_NOT_FOUND);

  if (list.items.some((item) => String(item.book) === String(bookId))) {
    throw ApiError.conflict(
      `"${book.title}" is already in this list`,
      ERROR_CODES.BOOK_ALREADY_IN_LIST
    );
  }

  // Bound the document, so one enthusiastic member cannot grow a single record
  // toward MongoDB's 16MB ceiling.
  if (list.items.length >= ReadingList.MAX_ITEMS) {
    throw ApiError.conflict(
      `A list cannot hold more than ${ReadingList.MAX_ITEMS} books`,
      ERROR_CODES.CONFLICT
    );
  }

  list.items.push({ book: bookId, note, position: list.items.length });
  await list.save();

  // Only favourites feed the book's public counter.
  if (list.type === READING_LIST_TYPE.FAVORITES) {
    await Book.updateOne({ _id: bookId }, { $inc: { 'stats.favoriteCount': 1 } });
  }

  return list;
};

export const removeBook = async (listId, userId, bookId) => {
  const list = await loadOwned(listId, userId);

  const before = list.items.length;
  list.items = list.items.filter((item) => String(item.book) !== String(bookId));

  if (list.items.length === before) {
    throw ApiError.notFound('That book is not in this list', ERROR_CODES.BOOK_NOT_IN_LIST);
  }

  await list.save();

  if (list.type === READING_LIST_TYPE.FAVORITES) {
    // Floored at zero: an unguarded decrement that ran twice would drive the
    // public favourite count negative.
    await Book.updateOne({ _id: bookId, 'stats.favoriteCount': { $gt: 0 } }, { $inc: { 'stats.favoriteCount': -1 } });
  }

  return list;
};

/**
 * Toggle a book in the member's favourites.
 */
export const toggleFavourite = async (userId, bookId) => {
  await ensureDefaults(userId);

  const favourites = await ReadingList.favouritesFor(userId);
  if (!favourites) throw ApiError.notFound('Favourites list not found', ERROR_CODES.LIST_NOT_FOUND);

  const isFavourite = favourites.items.some((item) => String(item.book) === String(bookId));

  if (isFavourite) {
    await removeBook(favourites._id, userId, bookId);
    return { favourited: false };
  }

  await addBook(favourites._id, userId, bookId);
  return { favourited: true };
};

/** Is this book in the member's favourites? Used to render a heart's state. */
export const isFavourite = async (userId, bookId) => {
  const favourites = await ReadingList.findOne({
    user: userId,
    type: READING_LIST_TYPE.FAVORITES,
    'items.book': bookId,
  }).select('_id');

  return Boolean(favourites);
};

export default {
  ensureDefaults,
  listForUser,
  getById,
  getByShareSlug,
  create,
  update,
  remove,
  addBook,
  removeBook,
  toggleFavourite,
  isFavourite,
};
