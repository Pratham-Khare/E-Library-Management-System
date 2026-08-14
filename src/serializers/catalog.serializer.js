/**
 * ---------------------------------------------------------------------------
 * CATALOGUE SERIALIZERS — the "View" layer for books and taxonomy
 * ---------------------------------------------------------------------------
 * Two shapes per book, and the distinction matters for payload size:
 *
 *   toSummary() — for LISTS. Enough to render a search result card. Omits the
 *                 description, tag list and rating histogram.
 *   toDetail()  — for a SINGLE book. Everything, plus availability derived
 *                 from the current inventory.
 *
 * A 20-book search page using the detail shape would carry twenty 10,000-
 * character descriptions nobody reads on that screen — roughly 200KB of
 * payload to render cards that show a title and a cover.
 *
 * Availability is COMPUTED here rather than stored, because the answer a
 * client needs ("can I borrow this right now?") depends on both physical
 * copies and digital licences, and no single stored field expresses it.
 * ---------------------------------------------------------------------------
 */

import config from '../config/index.js';

/** Turn a stored cover key into a URL the client can load. */
const coverUrl = (coverImage) =>
  coverImage
    ? `${config.app.url}${config.upload.categories.cover.urlPrefix}/${coverImage}`
    : null;

/** Populated refs arrive as objects; unpopulated ones as raw ObjectIds. */
const isPopulated = (value) => value && typeof value === 'object' && 'name' in value;

const toRef = (value) =>
  isPopulated(value)
    ? { id: String(value._id ?? value.id), name: value.name, slug: value.slug }
    : value
      ? { id: String(value) }
      : null;

const toRefs = (values) => (values ?? []).map(toRef).filter(Boolean);

/**
 * Availability, computed from physical stock and digital licences.
 *
 * `canBorrowNow` is the single boolean a client actually branches on; the
 * separate counts are there so it can explain WHY when the answer is no.
 */
const availabilityOf = (book) => {
  const physicalAvailable = book.inventory?.availableCopies ?? 0;
  const totalCopies = book.inventory?.totalCopies ?? 0;

  const hasEbook = book.digital?.hasEbook ?? false;
  const licenses = book.digital?.concurrentLicenses ?? 0;
  const activeLicenses = book.digital?.activeLicenses ?? 0;
  const digitalAvailable = hasEbook ? Math.max(0, licenses - activeLicenses) : 0;

  return {
    physical: { total: totalCopies, available: physicalAvailable, isAvailable: physicalAvailable > 0 },
    digital: hasEbook
      ? { hasEbook: true, licenses, available: digitalAvailable, isAvailable: digitalAvailable > 0 }
      : { hasEbook: false, licenses: 0, available: 0, isAvailable: false },
    canBorrowNow: physicalAvailable > 0 || digitalAvailable > 0,
  };
};

/* ===========================================================================
 * Books
 * ======================================================================== */

/** Compact shape for search results and listings. */
export const toBookSummary = (book) => {
  if (!book) return null;

  return {
    id: String(book._id ?? book.id),
    title: book.title,
    subtitle: book.subtitle ?? null,
    slug: book.slug,
    coverImage: coverUrl(book.coverImage),
    authors: toRefs(book.authors),
    publishedYear: book.publishedYear ?? null,
    language: book.language ?? 'en',
    rating: { average: book.rating?.average ?? 0, count: book.rating?.count ?? 0 },
    availability: availabilityOf(book),
    // Present only when the query ranked by relevance.
    ...(book.score !== undefined ? { relevanceScore: Math.round(book.score * 100) / 100 } : {}),
    ...(book.similarityScore !== undefined ? { similarityScore: book.similarityScore } : {}),
  };
};

/** Full shape for a single book page. */
export const toBookDetail = (book) => {
  if (!book) return null;

  return {
    ...toBookSummary(book),

    description: book.description ?? null,
    isbn: { isbn10: book.isbn10 ?? null, isbn13: book.isbn13 ?? null },
    publisher: toRef(book.publisher),
    categories: toRefs(book.categories),
    edition: book.edition ?? null,
    pageCount: book.pageCount ?? null,
    tags: book.tags ?? [],
    price: book.price ?? null,
    currency: book.currency ?? config.library.fines.currency,

    // The full histogram, so a book page can render the rating breakdown.
    rating: {
      average: book.rating?.average ?? 0,
      count: book.rating?.count ?? 0,
      distribution: book.rating?.distribution ?? { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
    },

    stats: {
      loanCount: book.stats?.loanCount ?? 0,
      viewCount: book.stats?.viewCount ?? 0,
      favoriteCount: book.stats?.favoriteCount ?? 0,
    },

    status: book.status,
    addedAt: book.createdAt,
    updatedAt: book.updatedAt,
  };
};

/**
 * Staff view: adds the fields a librarian needs and a member has no business
 * seeing — who catalogued it, and its soft-delete state.
 */
export const toBookAdmin = (book) => {
  if (!book) return null;

  return {
    ...toBookDetail(book),
    addedBy: book.addedBy ? String(book.addedBy) : null,
    isDeleted: book.isDeleted ?? false,
    deletedAt: book.deletedAt ?? null,
  };
};

export const listBookSummaries = (books) => (books ?? []).map(toBookSummary);

/* ===========================================================================
 * Copies
 * ======================================================================== */

/**
 * A physical copy.
 *
 * `borrower` is included ONLY for staff. A member scanning a shelf has no
 * business learning which of their neighbours has the other copy — that is a
 * genuine privacy leak, and it costs nothing to withhold.
 */
export const toCopy = (copy, { includeBorrower = false } = {}) => {
  if (!copy) return null;

  const base = {
    id: String(copy._id ?? copy.id),
    accessionNumber: copy.accessionNumber,
    shelfLocation: copy.shelfLocation ?? null,
    status: copy.status,
    condition: copy.condition,
    isBorrowable: copy.status === 'AVAILABLE',
    loanCount: copy.loanCount ?? 0,
    lastBorrowedAt: copy.lastBorrowedAt ?? null,
    acquiredOn: copy.acquiredOn ?? null,
  };

  if (!includeBorrower) return base;

  return {
    ...base,
    cost: copy.cost ?? null,
    source: copy.source ?? null,
    notes: copy.notes ?? null,
    currentLoan: copy.currentLoan
      ? {
          id: String(copy.currentLoan._id ?? copy.currentLoan),
          dueAt: copy.currentLoan.dueAt ?? null,
          status: copy.currentLoan.status ?? null,
          borrower: copy.currentLoan.user
            ? {
                id: String(copy.currentLoan.user._id ?? copy.currentLoan.user),
                name: copy.currentLoan.user.name,
                membershipNumber: copy.currentLoan.user.membershipNumber,
              }
            : null,
        }
      : null,
    statusHistory: (copy.statusHistory ?? []).slice(-10),
  };
};

export const listCopies = (copies, options) => (copies ?? []).map((copy) => toCopy(copy, options));

/* ===========================================================================
 * Taxonomy
 * ======================================================================== */

const authorPhotoUrl = (photo) =>
  photo ? `${config.app.url}${config.upload.categories.cover.urlPrefix}/${photo}` : null;

export const toAuthor = (author) => {
  if (!author) return null;
  return {
    id: String(author._id ?? author.id),
    name: author.name,
    slug: author.slug,
    bio: author.bio ?? null,
    photo: authorPhotoUrl(author.photo),
    nationality: author.nationality ?? null,
    birthYear: author.birthYear ?? null,
    deathYear: author.deathYear ?? null,
    website: author.website ?? null,
    bookCount: author.bookCount ?? 0,
  };
};

export const toPublisher = (publisher) => {
  if (!publisher) return null;
  return {
    id: String(publisher._id ?? publisher.id),
    name: publisher.name,
    slug: publisher.slug,
    description: publisher.description ?? null,
    website: publisher.website ?? null,
    foundedYear: publisher.foundedYear ?? null,
    address: publisher.address ?? null,
    bookCount: publisher.bookCount ?? 0,
  };
};

/**
 * A category. `children` is included only when the caller populated or built
 * them, so the same function serves both a flat list and a nested tree.
 */
export const toCategory = (category) => {
  if (!category) return null;

  return {
    id: String(category._id ?? category.id),
    name: category.name,
    slug: category.slug,
    description: category.description ?? null,
    parent: category.parent ? String(category.parent._id ?? category.parent) : null,
    // The materialised path, root-first — enough for a client to build a
    // breadcrumb without a second request.
    ancestors: (category.ancestors ?? []).map((id) => String(id._id ?? id)),
    depth: category.depth ?? 0,
    bookCount: category.bookCount ?? 0,
    icon: category.icon ?? null,
    color: category.color ?? null,
    displayOrder: category.displayOrder ?? 0,
    ...(category.children ? { children: category.children.map(toCategory) } : {}),
  };
};

export const listAuthors = (authors) => (authors ?? []).map(toAuthor);
export const listPublishers = (publishers) => (publishers ?? []).map(toPublisher);
export const listCategories = (categories) => (categories ?? []).map(toCategory);

/* ===========================================================================
 * Search
 * ======================================================================== */

/**
 * A search response.
 *
 * `fallbackUsed` is surfaced deliberately: it lets a client say "no exact
 * matches — showing similar titles" instead of presenting weaker fuzzy results
 * as though they were exact hits.
 */
export const toSearchResponse = ({ items, fallbackUsed, searchTerm }) => ({
  results: listBookSummaries(items),
  searchTerm: searchTerm ?? null,
  exactMatch: !fallbackUsed,
  ...(fallbackUsed
    ? { note: 'No exact matches were found, so these are the closest titles.' }
    : {}),
});

export default {
  toBookSummary,
  toBookDetail,
  toBookAdmin,
  listBookSummaries,
  toCopy,
  listCopies,
  toAuthor,
  toPublisher,
  toCategory,
  listAuthors,
  listPublishers,
  listCategories,
  toSearchResponse,
};
