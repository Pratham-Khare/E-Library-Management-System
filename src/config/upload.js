/**
 * Three categories of file, each with its own size cap and allow-list:
 */

import path from 'node:path';
import env, { ROOT_DIR } from './env.js';

const MB = 1024 * 1024;

/** Storage backend. Only `local` is implemented; see the note at the bottom. */
export const provider = env.STORAGE_PROVIDER;

/**
 * Absolute paths on disk. Created at boot by the storage provider if missing,
 * so a fresh clone does not need any manual mkdir.
 */
export const paths = Object.freeze({
  root: path.resolve(ROOT_DIR, env.STORAGE_ROOT),
  covers: path.resolve(ROOT_DIR, env.STORAGE_ROOT, 'covers'),
  ebooks: path.resolve(ROOT_DIR, env.STORAGE_ROOT, 'ebooks'),
  avatars: path.resolve(ROOT_DIR, env.STORAGE_ROOT, 'avatars'),
  /** Scratch space for in-progress uploads before validation moves them. */
  temp: path.resolve(ROOT_DIR, env.STORAGE_ROOT, 'tmp'),
});

/** Every directory the storage provider must ensure exists at startup. */
export const directoriesToEnsure = Object.freeze(Object.values(paths));

/**
 * Magic-number signatures, keyed by MIME type. Each entry lists the byte
 * prefixes that identify a genuine file of that type.
 */
export const magicNumbers = Object.freeze({
  'image/jpeg': [[0xff, 0xd8, 0xff]],
  'image/png': [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF; the WEBP tag at offset 8 is checked separately
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
  'application/epub+zip': [[0x50, 0x4b, 0x03, 0x04]], // PK.. (ZIP)
});

/** Extra bytes that must appear at a given offset for formats with a container. */
export const magicNumberOffsets = Object.freeze({
  'image/webp': { offset: 8, bytes: [0x57, 0x45, 0x42, 0x50] }, // "WEBP"
});

/** Canonical file extension per accepted MIME type. */
export const extensionFor = Object.freeze({
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
  'application/epub+zip': '.epub',
});

/**
 * Per-category upload rules.
 */
export const categories = Object.freeze({
  cover: Object.freeze({
    field: 'cover',
    maxSizeBytes: env.MAX_COVER_SIZE_MB * MB,
    maxSizeMb: env.MAX_COVER_SIZE_MB,
    allowedTypes: env.ALLOWED_COVER_TYPES,
    destination: paths.covers,
    publiclyServed: true,
    urlPrefix: '/files/covers',
  }),

  ebook: Object.freeze({
    field: 'ebook',
    maxSizeBytes: env.MAX_EBOOK_SIZE_MB * MB,
    maxSizeMb: env.MAX_EBOOK_SIZE_MB,
    allowedTypes: env.ALLOWED_EBOOK_TYPES,
    destination: paths.ebooks,
    /**
     * Deliberately false. Ebooks are the library's actual assets — serving
     * them statically would mean anyone with the URL could download any book
     * without borrowing it. Access goes through a controller that verifies an
     * active digital loan and then streams with HTTP Range support.
     */
    publiclyServed: false,
    urlPrefix: null,
  }),

  avatar: Object.freeze({
    field: 'avatar',
    maxSizeBytes: env.MAX_AVATAR_SIZE_MB * MB,
    maxSizeMb: env.MAX_AVATAR_SIZE_MB,
    allowedTypes: env.ALLOWED_AVATAR_TYPES,
    destination: paths.avatars,
    publiclyServed: true,
    urlPrefix: '/files/avatars',
  }),
});

/** Look up a category's rules by name. */
export const categoryFor = (name) => categories[name];

/* Text extraction (feeds the AI summariser) */

export const extraction = Object.freeze({
  enabled: env.EXTRACT_EBOOK_TEXT,
  /**
   * Only PDFs are parsed today. EPUB is a ZIP of XHTML and would need a
   * different parser; until then EPUB uploads are marked SKIPPED and their
   * books fall back to metadata-based summaries.
   */
  supportedTypes: Object.freeze(['application/pdf']),
  /**
   * Characters stored on the DigitalAsset. Generous enough to give the
   * summariser real material, bounded enough not to bloat documents — MongoDB
   * caps a single document at 16MB.
   */
  maxStoredChars: 200_000,
  /** Give up on a file that takes longer than this to parse. */
  timeoutMs: 60_000,
});

/* Streaming (secured ebook reader) */

export const streaming = Object.freeze({
  /** Bytes returned when a client sends an open-ended Range header. */
  defaultChunkSize: 1 * MB,
  /** Upper bound on a single ranged response. */
  maxChunkSize: 5 * MB,
  /** Advertise Range support so browser PDF readers can seek. */
  acceptRanges: 'bytes',
});

/**
 * Filenames are always generated, never taken from the client:
 *   <uuid><ext>   e.g. 7f3c1e2a-....pdf
 */
export const naming = Object.freeze({
  strategy: 'uuid',
  preserveOriginalNameInDb: true,
});

/**
 * PROVIDER NOTE — moving to cloud storage
 * services/storage/ defines a StorageProvider interface (save, read, delete,
 * stat, createReadStream, urlFor). LocalDiskProvider implements it.
 */

export default Object.freeze({
  provider,
  paths,
  directoriesToEnsure,
  categories,
  categoryFor,
  magicNumbers,
  magicNumberOffsets,
  extensionFor,
  extraction,
  streaming,
  naming,
});
