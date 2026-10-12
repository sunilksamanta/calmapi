import { definePlugin, f, validateInput, notFound, conflict } from '#calm';
import { KEY_PATTERN, subjectOf, isEnabled, variantOf, checkVariants } from './evaluate.js';
import { GATE } from './gate.js';

export { requireFlag } from './gate.js';

// Feature flags: kill switches, gradual rollouts, per user and per role targeting, and
// weighted variants, stored in MongoDB (calm_flags).
//
//   if (ctx.flags.enabled('new-checkout')) ...       in any handler, hook or service call
//   const v = ctx.flags.variant('pricing-page')       'control' | 'annual-first' | null
//   GET /api/flags                                    what the frontend may know
//   /api/admin/flags                                  CRUD for admins
//
//  - Evaluation is deterministic (see evaluate.js): no randomness, no per request state,
//    every instance gives a user the same answer.
//  - Flags are read once per cacheTtlMs per process, so ctx.flags is synchronous and
//    costs nothing. Changes through this block apply at once in this process and within
//    cacheTtlMs everywhere else.
//  - If MongoDB cannot be read, the last known flags keep being served (or none: off).
//  - Flags declared in options.flags are created on start when missing and never
//    overwritten: once a flag exists, the admin API owns it.

const ANONYMOUS_ID = /^[\w.:-]{1,128}$/;
// What PATCH { field: null } resets a field to.
const EMPTY = { description: '', enabled: false, rollout: 0, users: [], roles: [], variants: null, clientVisible: false };
const NEW_FLAG = { ...EMPTY, enabled: true };

const flagFields = {
  description: f.string().max(500),
  enabled: f.boolean(),
  rollout: f.integer().min(0).max(100),
  users: f.array(f.string().max(100)).max(1000),
  roles: f.array(f.string().max(50)).max(50),
  variants: f.json().check(checkVariants),
  clientVisible: f.boolean(),
};
const keyField = f.string().required().pattern(KEY_PATTERN, 'Use letters, digits, ".", "-" and "_" (max 100), starting with a letter or a digit');

const view = (d) => ({
  key: d.key,
  description: d.description ?? '',
  enabled: Boolean(d.enabled),
  rollout: d.rollout ?? 0,
  users: d.users ?? [],
  roles: d.roles ?? [],
  variants: d.variants ?? null,
  clientVisible: Boolean(d.clientVisible),
  updatedBy: d.updatedBy ?? null,
  createdAt: d.createdAt ?? null,
  updatedAt: d.updatedAt ?? null,
});

export default definePlugin({
  name: 'feature-flags',
  options: {
    /** How long a process reuses the flags it read. 0 reads them on every request. */
    cacheTtlMs: 5000,
    /** Flags your code relies on, created on start when missing: { 'new-checkout': { description, rollout: 0 } } */
    flags: {},
  },
  async setup(calm, options) {
    const { Schema } = calm.mongoose;
    const schema = new Schema(
      {
        key: { type: String, required: true, unique: true },
        description: { type: String, default: '' },
        enabled: { type: Boolean, default: true },
        rollout: { type: Number, default: 0, min: 0, max: 100 },
        users: { type: [String], default: [] },
        roles: { type: [String], default: [] },
        variants: { type: Schema.Types.Mixed, default: null },
        clientVisible: { type: Boolean, default: false },
        updatedBy: { type: String, default: null },
      },
      { collection: 'calm_flags', timestamps: true, versionKey: false },
    );
    const Flag = calm.mongoose.model('calmFlag', schema);

    // Validate declared flags now: a typo should stop the boot, not surface in production.
    const declared = {};
    for (const [key, def] of Object.entries(options.flags ?? {})) {
      try {
        declared[key] = { ...NEW_FLAG, ...(await validateInput({ name: 'flag', fields: { key: keyField, ...flagFields } }, { key, ...def }, { mode: 'create' })) };
      } catch (err) {
        const why = err.details ? Object.entries(err.details).map(([k, v]) => `${k}: ${v}`).join(', ') : err.message;
        throw new Error(`feature-flags: blocks['feature-flags'].flags['${key}'] is invalid (${why})`, { cause: err });
      }
    }

    // ---- cache -------------------------------------------------------------------
    let cache = { at: 0, loaded: false, map: new Map() };
    let generation = 0; // bumped on every change, so a read that started before it is not trusted
    let inflight = null;

    function invalidate() {
      generation += 1;
      cache = { ...cache, at: 0 };
    }

    async function snapshot() {
      if (cache.at && Date.now() - cache.at < options.cacheTtlMs) return cache.map;
      if (inflight?.generation === generation) return inflight.promise; // one read at a time
      const started = generation;
      const promise = Flag.find()
        .lean()
        .then(
          (docs) => {
            const map = new Map(docs.map((d) => [d.key, d]));
            if (started === generation) cache = { at: Date.now(), loaded: true, map };
            return map;
          },
          (err) => {
            // Never take every route down with the flags: serve the last known values, or
            // nothing (every flag off) if they were never read. Try again after one TTL.
            if (cache.loaded) calm.log.warn('feature-flags: could not read flags, serving the last known values', { err });
            else calm.log.error('feature-flags: could not read flags, every flag is off until they can be read', { err });
            cache = { ...cache, at: Date.now() };
            return cache.map;
          },
        )
        .finally(() => {
          if (inflight?.promise === promise) inflight = null;
        });
      inflight = { generation: started, promise };
      return promise;
    }

    // ---- evaluation ----------------------------------------------------------------
    const warned = new Set();
    function evaluator(map, subject) {
      const flag = (key) => {
        const found = map.get(key);
        if (!found && calm.config.mode === 'development' && !warned.has(key)) {
          warned.add(key);
          calm.log.warn(`Feature flag "${key}" does not exist, so it is off. Create it with the admin API or in blocks['feature-flags'].flags.`);
        }
        return found;
      };
      const evaluate = (filter) =>
        Object.fromEntries([...map.values()].filter(filter).map((d) => [d.key, { enabled: isEnabled(d, subject), variant: variantOf(d, subject) }]));
      return {
        enabled: (key) => isEnabled(flag(key), subject),
        variant: (key) => variantOf(flag(key), subject),
        /** Every flag for this subject: { key: { enabled, variant } } */
        all: () => evaluate(() => true),
        /** Only flags marked clientVisible (what GET /api/flags returns). */
        client: () => evaluate((d) => d.clientVisible),
      };
    }

    // ---- changes -------------------------------------------------------------------
    function changed(action, doc, previous, ctx) {
      invalidate();
      calm.events.emit('flag.changed', {
        key: (doc ?? previous).key,
        action,
        flag: doc ? view(doc) : null,
        previous: previous ? view(previous) : null,
        user: ctx?.user ?? null,
      });
    }

    const flags = {
      model: Flag,
      /** Evaluator for anyone, outside requests too: (await flags.evaluate({ user })).enabled('x') */
      evaluate: async (who) => evaluator(await snapshot(), subjectOf(who)),
      isEnabled: async (key, who) => isEnabled((await snapshot()).get(key), subjectOf(who)),
      variant: async (key, who) => variantOf((await snapshot()).get(key), subjectOf(who)),
      invalidate,

      async list() {
        return (await Flag.find().sort({ key: 1 }).lean()).map(view);
      },
      async get(key) {
        const doc = await Flag.findOne({ key }).lean();
        if (!doc) throw notFound(`Flag "${key}" not found`);
        return view(doc);
      },
      async create(input, ctx) {
        if (await Flag.exists({ key: input.key })) throw conflict(`Flag "${input.key}" already exists`, { key: 'Already taken' });
        const data = { ...NEW_FLAG, updatedBy: ctx?.user?.id ?? null };
        for (const [field, value] of Object.entries(input)) data[field] = value === null ? EMPTY[field] : value;
        const doc = (await Flag.create(data)).toObject();
        changed('created', doc, null, ctx);
        return view(doc);
      },
      async update(key, input, ctx) {
        const $set = { updatedBy: ctx?.user?.id ?? null };
        for (const [field, value] of Object.entries(input)) $set[field] = value === null ? EMPTY[field] : value;
        const previous = await Flag.findOne({ key }).lean();
        if (!previous) throw notFound(`Flag "${key}" not found`);
        const doc = await Flag.findOneAndUpdate({ key }, { $set }, { returnDocument: 'after' }).lean();
        if (!doc) throw notFound(`Flag "${key}" not found`);
        changed('updated', doc, previous, ctx);
        return view(doc);
      },
      async remove(key, ctx) {
        const previous = await Flag.findOneAndDelete({ key }).lean();
        if (!previous) throw notFound(`Flag "${key}" not found`);
        changed('deleted', null, previous, ctx);
      },

      /** Create declared flags that do not exist yet. Existing flags are left alone. */
      async ensureDefaults() {
        const created = [];
        for (const [key, def] of Object.entries(declared)) {
          const now = new Date();
          // $setOnInsert only, and no automatic timestamps: an existing flag is not touched at all.
          const res = await Flag.updateOne({ key }, { $setOnInsert: { ...def, key, createdAt: now, updatedAt: now } }, { upsert: true, timestamps: false }).catch((err) => {
            if (err?.code === 11000) return { upsertedCount: 0 }; // another instance created it first
            throw err;
          });
          if (res.upsertedCount) {
            created.push(key);
            changed('created', await Flag.findOne({ key }).lean(), null, null);
          }
        }
        return created;
      },
    };
    calm.provide('flags', flags);

    calm.onStart(async () => {
      await Flag.init(); // the unique index on key, before declared flags are upserted
      await flags.ensureDefaults();
    });

    // ctx.flags on every request. Also enforces requireFlag() gates in the route's policy.
    calm.guard(async (ctx, route) => {
      const header = ctx.req.get('x-anonymous-id');
      const subject = subjectOf({ user: ctx.user, anonymousId: header && ANONYMOUS_ID.test(header) ? header : null });
      const evaluatorForRequest = evaluator(await snapshot(), subject);
      ctx.flags = evaluatorForRequest;
      ctx.req.calmFlags = evaluatorForRequest; // policy functions only get req
      for (const token of route?.policy ?? []) {
        const key = typeof token === 'function' ? token[GATE] : undefined;
        if (key !== undefined && !evaluatorForRequest.enabled(key)) throw notFound('Route not found');
      }
    });

    calm.routes((r) => {
      r.get('/flags', { policy: 'public', summary: 'Feature flags for the current user or visitor (clientVisible ones)', tags: ['flags'] }, (ctx) =>
        // Per user answers: never cached by a shared cache.
        ctx.reply(ctx.flags.client(), { headers: { 'Cache-Control': 'private, no-store' } }),
      );

      r.get('/admin/flags', { policy: 'admin', summary: 'List feature flags', tags: ['flags'] }, () => flags.list());
      r.get('/admin/flags/:key', { policy: 'admin', summary: 'Get a feature flag', tags: ['flags'] }, (ctx) => flags.get(ctx.params.key));
      r.post('/admin/flags', { policy: 'admin', status: 201, summary: 'Create a feature flag', input: { key: keyField, ...flagFields }, tags: ['flags'] }, (ctx) =>
        flags.create(ctx.body, ctx),
      );
      r.patch('/admin/flags/:key', { policy: 'admin', summary: 'Change a feature flag (null resets a field)', input: flagFields, tags: ['flags'] }, (ctx) =>
        flags.update(ctx.params.key, ctx.body, ctx),
      );
      r.delete('/admin/flags/:key', { policy: 'admin', summary: 'Delete a feature flag', tags: ['flags'] }, (ctx) => flags.remove(ctx.params.key, ctx));
    });

    calm.devtools.panel('feature-flags', async () => {
      const all = await Flag.find().sort({ key: 1 }).lean();
      return {
        flags: all.length,
        on: all.filter((d) => d.enabled && (d.rollout > 0 || d.users?.length || d.roles?.length)).length,
        cacheTtlMs: options.cacheTtlMs,
        list: all.map((d) => ({
          key: d.key,
          enabled: d.enabled,
          rollout: d.rollout,
          users: d.users?.length ?? 0,
          roles: (d.roles ?? []).join(', '),
          variants: d.variants ? Object.entries(d.variants).map(([name, weight]) => `${name} ${weight}`).join(' / ') : '',
          clientVisible: Boolean(d.clientVisible),
          description: d.description ?? '',
          updatedAt: d.updatedAt,
        })),
      };
    });
  },
});
