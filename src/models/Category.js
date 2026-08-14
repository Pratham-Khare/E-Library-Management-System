/**
 * A hierarchical subject tree (Science > Computer Science > Algorithms).
 *
 * Alongside `parentId`, each document stores `ancestors[]` — a materialised
 * path holding the full chain from the root. That turns "everything under
 * Science, at any depth" into one indexed query instead of one per level.
 *
 * The cost is that moving a node rewrites the ancestors of everything beneath
 * it; see rebuildDescendantAncestors(). Reads vastly outnumber reorganisations.
 */

import mongoose from 'mongoose';
import slugify from 'slugify';

const { Schema, model } = mongoose;

const categorySchema = new Schema(
  {
    name: {
      type: String,
      required: [true, 'Category name is required'],
      trim: true,
      minlength: [2, 'Category name must be at least 2 characters'],
      maxlength: [120, 'Category name cannot exceed 120 characters'],
    },

    slug: { type: String, unique: true, index: true, lowercase: true, trim: true },

    description: { type: String, trim: true, maxlength: 1000 },

    /** Immediate parent. Null for a top-level category. */
    parent: {
      type: Schema.Types.ObjectId,
      ref: 'Category',
      default: null,
      index: true,
    },

    /**
     * The full ancestor chain, root first. Maintained by the hooks below —
     * never set by hand. Indexed separately, not with `index: true` here,
     * which would declare the same index twice.
     */
    ancestors: [{ type: Schema.Types.ObjectId, ref: 'Category' }],

    /** Depth from the root: 0 for a top-level category. Derived from ancestors. */
    depth: { type: Number, default: 0, min: 0, index: true },

    /**
     * Books tagged with THIS category specifically, not including descendants.
     * A subtree total is computed on demand — storing it would mean updating
     * every ancestor on every book write, for a number that is rarely shown.
     */
    bookCount: { type: Number, default: 0, min: 0 },

    /** Optional display hints, so a client can render a browse grid. */
    icon: { type: String, trim: true, maxlength: 60, default: null },
    color: { type: String, trim: true, maxlength: 20, default: null },

    /** Manual ordering within a level; ties fall back to alphabetical. */
    displayOrder: { type: Number, default: 0 },

    isDeleted: { type: Boolean, default: false, index: true },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

/* Indexes */

/** Listing the children of a node, in display order. */
categorySchema.index({ parent: 1, displayOrder: 1, name: 1 });
/** The subtree query this whole design exists for. */
categorySchema.index({ ancestors: 1 });
categorySchema.index({ name: 'text' }, { name: 'category_text_search' });

/* Virtuals */

/** Immediate children, populated on demand. */
categorySchema.virtual('children', {
  ref: 'Category',
  localField: '_id',
  foreignField: 'parent',
});

/** True for a top-level category. */
categorySchema.virtual('isRoot').get(function isRoot() {
  return this.parent === null || this.parent === undefined;
});

/* Hooks */

/** Unique slug from the name. See Author for why the collision loop exists. */
categorySchema.pre('validate', async function generateSlug(next) {
  if (!this.isModified('name') && this.slug) return next();

  const base = slugify(this.name, { lower: true, strict: true, trim: true });
  let candidate = base;
  let suffix = 1;

  // eslint-disable-next-line no-await-in-loop
  while (await this.constructor.exists({ slug: candidate, _id: { $ne: this._id } })) {
    suffix += 1;
    candidate = `${base}-${suffix}`;
  }

  this.slug = candidate;
  return next();
});

/**
 * Recompute `ancestors` and `depth`, refusing to create a cycle. Setting a
 * node's parent to its own descendant produces a loop with no root, and every
 * later tree walk either recurses forever or loses the branch. The parent
 * already carries its chain, so detecting it is one membership test.
 */
categorySchema.pre('save', async function buildAncestors(next) {
  if (!this.isModified('parent')) return next();

  if (!this.parent) {
    this.ancestors = [];
    this.depth = 0;
    return next();
  }

  try {
    const parent = await this.constructor.findById(this.parent).select('ancestors depth');

    if (!parent) {
      return next(new Error('The specified parent category does not exist'));
    }

    // A node cannot be its own parent...
    if (String(this.parent) === String(this._id)) {
      return next(new Error('A category cannot be its own parent'));
    }

    // ...nor a child of its own descendant.
    if (parent.ancestors?.some((ancestorId) => String(ancestorId) === String(this._id))) {
      return next(
        new Error(
          'That parent is a descendant of this category — the change would create a cycle in the tree'
        )
      );
    }

    this.ancestors = [...(parent.ancestors ?? []), parent._id];
    this.depth = this.ancestors.length;

    return next();
  } catch (error) {
    return next(error);
  }
});

/* Statics */

/**
 * Rewrite the ancestor paths beneath a moved node — the cost of the
 * materialised path. One bulk write, since a deep subtree would otherwise be
 * hundreds of round-trips.
 */
categorySchema.statics.rebuildDescendantAncestors = async function rebuildDescendantAncestors(categoryId) {
  const root = await this.findById(categoryId).select('ancestors');
  if (!root) return { modified: 0 };

  const descendants = await this.find({ ancestors: categoryId }).select('ancestors parent');
  if (descendants.length === 0) return { modified: 0 };

  const newRootPath = [...(root.ancestors ?? []), root._id];

  const operations = descendants.map((descendant) => {
    // Keep everything from this node down to the moved node, and re-root it.
    const indexOfMoved = descendant.ancestors.findIndex((id) => String(id) === String(categoryId));
    const below = descendant.ancestors.slice(indexOfMoved + 1);
    const ancestors = [...newRootPath, ...below];

    return {
      updateOne: {
        filter: { _id: descendant._id },
        update: { $set: { ancestors, depth: ancestors.length } },
      },
    };
  });

  const result = await this.bulkWrite(operations);
  return { modified: result.modifiedCount };
};

/**
 * Every id in a subtree, including the node itself. This is what makes "books
 * in Science" return books tagged Algorithms.
 */
categorySchema.statics.subtreeIds = async function subtreeIds(categoryId) {
  const descendants = await this.find({ ancestors: categoryId, isDeleted: false }).select('_id').lean();
  return [categoryId, ...descendants.map((doc) => doc._id)];
};

/** The whole tree as nested objects, for a browse page. */
categorySchema.statics.buildTree = async function buildTree() {
  const all = await this.find({ isDeleted: false })
    .sort({ depth: 1, displayOrder: 1, name: 1 })
    .lean();

  const byId = new Map(all.map((node) => [String(node._id), { ...node, children: [] }]));
  const roots = [];

  // Sorted by depth, so a node's parent is always already in the map.
  for (const node of all) {
    const entry = byId.get(String(node._id));
    if (node.parent) byId.get(String(node.parent))?.children.push(entry);
    else roots.push(entry);
  }

  return roots;
};

categorySchema.statics.findByIdOrSlug = function findByIdOrSlug(identifier) {
  const isObjectId = mongoose.Types.ObjectId.isValid(identifier);
  return this.findOne({
    ...(isObjectId ? { _id: identifier } : { slug: String(identifier).toLowerCase() }),
    isDeleted: false,
  });
};

export const Category = model('Category', categorySchema);

export default Category;
