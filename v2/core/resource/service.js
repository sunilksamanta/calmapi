import { notFound } from '../errors.js';
import { hashPassword } from '../auth/password.js';

/**
 * Default data access for a resource. Extend it in `<name>.service.js` and override
 * only what you need: hooks for small tweaks, whole methods for full control.
 *
 *   export default class PostService extends ResourceService {
 *     async beforeCreate(data, ctx) { return { ...data, slug: slugify(data.title) }; }
 *   }
 *
 * `ctx` is the request context ({ user, scope, ... }) or {} when called from jobs/scripts.
 */
export class ResourceService {
  constructor({ def, model, app }) {
    this.def = def;
    this.model = model;
    this.app = app;
  }

  /**
   * Select string that adds hidden and write-only fields (never password hashes).
   * Hooks and events are server-side, so they get the whole record; API responses are
   * still serialized, which strips these fields again.
   */
  get internalSelect() {
    this.#internal ??= Object.entries(this.def.fields)
      .filter(([, field]) => !field.isOutput && field.type !== 'password')
      .map(([key]) => `+${key}`)
      .join(' ');
    return this.#internal;
  }
  #internal;

  get name() { return this.def.name; }
  get events() { return this.app.events; }
  get log() { return this.app.log; }
  /** Another resource's service: this.service('user').get(id) */
  service(name) { return this.app.services.get(name); }

  // ---- hooks (override in your service) ------------------------------------------
  /** Extra filter applied to every query, e.g. multi-tenancy: ({ user }) => ({ org: user.org }) */
  scope(_ctx) { return {}; }
  async beforeCreate(data, _ctx) { return data; }
  async afterCreate(_doc, _ctx) {}
  async beforeUpdate(data, _existing, _ctx) { return data; }
  async afterUpdate(_doc, _previous, _ctx) {}
  async beforeDelete(_doc, _ctx) {}
  async afterDelete(_doc, _ctx) {}

  // ---- reads ---------------------------------------------------------------------
  /** Build the full Mongo filter for this request: your scope(), owner scoping, then `extra`. */
  filterFor(ctx = {}, extra = {}) {
    const parts = [this.scope(ctx), extra];
    if (ctx.scope === 'owner') {
      if (!ctx.user) return { _id: null }; // matches nothing
      parts.push({ [this.def.ownerField]: ctx.user.id });
    }
    const nonEmpty = parts.filter((p) => p && Object.keys(p).length);
    if (nonEmpty.length <= 1) return nonEmpty[0] ?? {};
    return { $and: nonEmpty };
  }

  async list({ filter = {}, sort = { _id: -1 }, skip = 0, limit = 20, populate = [] } = {}, ctx = {}) {
    const where = this.filterFor(ctx, filter);
    const [items, total] = await Promise.all([
      this.model.find(where).sort(sort).skip(skip).limit(limit).populate(populate).lean(),
      this.model.countDocuments(where),
    ]);
    return { items, total };
  }

  async get(id, { populate = [] } = {}, ctx = {}) {
    const doc = await this.model.findOne(this.filterFor(ctx, { _id: id })).populate(populate).lean();
    if (!doc) throw notFound(`${this.def.name} not found`);
    return doc;
  }

  async find(filter = {}, ctx = {}) {
    return this.model.find(this.filterFor(ctx, filter)).lean();
  }

  async findOne(filter = {}, ctx = {}) {
    return this.model.findOne(this.filterFor(ctx, filter)).lean();
  }

  // ---- writes --------------------------------------------------------------------
  async create(data, ctx = {}) {
    let input = { ...data };
    if (this.def.ownerField && this.def.ownerField !== '_id' && ctx.user && input[this.def.ownerField] === undefined) {
      input[this.def.ownerField] = ctx.user.id;
    }
    input = await this.beforeCreate(input, ctx);
    input = await this.#hashPasswords(input);
    const created = await this.model.create(input);
    const doc = await this.model.findById(created._id).select(this.internalSelect).lean();
    await this.afterCreate(doc, ctx);
    this.#emit('created', { doc }, ctx);
    return doc;
  }

  async update(id, data, ctx = {}) {
    const existing = await this.model.findOne(this.filterFor(ctx, { _id: id })).select(this.internalSelect).lean();
    if (!existing) throw notFound(`${this.def.name} not found`);
    let changes = await this.beforeUpdate({ ...data }, existing, ctx);
    changes = await this.#hashPasswords(changes);

    const $set = {};
    const $unset = {};
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) $unset[key] = 1;
      else $set[key] = value;
    }
    const update = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;

    const doc = Object.keys(update).length
      ? await this.model.findOneAndUpdate({ _id: existing._id }, update, { returnDocument: 'after', runValidators: true }).select(this.internalSelect).lean()
      : existing;
    await this.afterUpdate(doc, existing, ctx);
    this.#emit('updated', { doc, previous: existing }, ctx);
    return doc;
  }

  async remove(id, ctx = {}) {
    const doc = await this.model.findOne(this.filterFor(ctx, { _id: id })).select(this.internalSelect).lean();
    if (!doc) throw notFound(`${this.def.name} not found`);
    await this.beforeDelete(doc, ctx);
    await this.model.deleteOne({ _id: doc._id });
    await this.afterDelete(doc, ctx);
    this.#emit('deleted', { doc }, ctx);
    return doc;
  }

  async #hashPasswords(data) {
    for (const [key, field] of Object.entries(this.def.fields)) {
      if (field.type === 'password' && typeof data[key] === 'string') {
        data[key] = await hashPassword(data[key], this.app.config.auth.password);
      }
    }
    return data;
  }

  #emit(action, payload, ctx) {
    this.events.emit(`${this.def.name}.${action}`, { ...payload, resource: this.def.name, user: ctx.user ?? null });
  }
}
