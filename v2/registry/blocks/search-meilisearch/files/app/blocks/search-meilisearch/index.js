import { definePlugin, serialize, badRequest, notFound } from '#calm';
import { createClient, MeiliError } from './meili.js';

// Full-text search with Meilisearch for the resources you choose.
//
//  - Sync: <resource>.created / updated / restored upsert the record, .deleted removes it, in
//    the background (event listeners run after the response) with retries.
//  - What goes into the index: the fields anyone may see (not hidden, write-only, password,
//    visibleTo(), pii() or encrypted fields), or the fields you list, which must pass the same
//    test. The index never holds a value the public API would hide.
//  - Search: GET /api/<resource path>/search?q=. Meilisearch only returns ids; the records are
//    then loaded through the resource's own rules (list policy, service scope(), read policy,
//    field visibility), so search never shows a record, or a field, the caller could not read.
//  - Reindex: POST /api/search/<resource>/reindex (admins) or app.ext.search.reindex(name)
//    pages through the collection by _id.

export { MeiliError } from './meili.js';

const UNITS = { ms: 1, s: 1000, m: 60_000 };
const OBJECT_ID = /^[a-f\d]{24}$/i;
const RESOURCE_EVENT = /^([\w-]+)\.(created|updated|deleted|restored)$/;

function toMs(value, name) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m)$/.exec(String(value).trim());
  if (!m) throw new Error(`search-meilisearch: ${name} must be milliseconds or a duration like '5s' (got ${JSON.stringify(value)})`);
  return Number(m[1]) * UNITS[m[2]];
}

/** Why a field must never be indexed, or null. */
export function privateReason(field) {
  if (field.opts.hidden) return 'hidden';
  if (field.opts.writeOnly) return 'write-only';
  if (field.type === 'password') return 'a password';
  if (field.opts.visibleTo) return 'only visible to some users (visibleTo)';
  if (field.opts.pii) return 'personal data (pii)';
  if (field.opts.encrypted) return 'encrypted';
  return null;
}

/** The fields indexed for a resource: the configured ones (checked) or every public one. */
export function indexedFields(def, configured) {
  if (!configured) return Object.entries(def.fields).filter(([, field]) => !privateReason(field)).map(([key]) => key);
  return configured.map((key) => {
    const field = def.fields[key];
    if (!field) throw new Error(`search-meilisearch: ${def.name} has no field "${key}" (blocks['search-meilisearch'].resources.${def.name}.fields)`);
    const reason = privateReason(field);
    if (reason) throw new Error(`search-meilisearch: ${def.name}.${key} is ${reason} and cannot be indexed: search indexes are readable by whoever holds a search key`);
    return key;
  });
}

export default definePlugin({
  name: 'search-meilisearch',
  env: {
    MEILI_HOST: { required: 'production', description: 'Meilisearch URL, for example https://ms-xxxx.meilisearch.io or http://localhost:7700' },
    MEILI_MASTER_KEY: { secret: true, required: 'production', description: 'Master key or an admin API key: writes documents and settings' },
    MEILI_SEARCH_KEY: { secret: true, description: 'Optional search-only API key used for queries (default: MEILI_MASTER_KEY)' },
  },
  // In calm.config.js: blocks: { 'search-meilisearch': { resources: { post: true, product: { fields: ['name', 'description'] } } } }
  options: {
    resources: {}, // name -> true | { fields, index, searchable, filterable, sortable }
    indexPrefix: '', // 'staging_' to share one Meilisearch between environments
    host: null, // default: MEILI_HOST
    batchSize: 500, // documents per request when reindexing
    retries: ['1s', '5s', '30s'], // waits before each retry of a failed sync
    searchLimit: 20,
    maxSearchLimit: 50,
    maxScans: 5, // Meilisearch requests per search while filling a page with readable records
    timeoutMs: 10_000,
  },
  setup(calm, options) {
    const host = options.host || calm.env('MEILI_HOST');
    const adminKey = calm.env('MEILI_MASTER_KEY');
    const searchKey = calm.env('MEILI_SEARCH_KEY');
    const delays = (options.retries ?? []).map((v, i) => toMs(v, `retries[${i}]`));
    const wanted = Object.entries(options.resources ?? {}).filter(([, v]) => v);
    const stats = { indexed: 0, removed: 0, retried: 0, failed: 0, searches: 0 };
    const client = host ? createClient({ host, adminKey, searchKey, timeoutMs: options.timeoutMs }) : null;
    const plans = new Map(); // resource name -> { uid, fields, settings }

    calm.doctor(() => {
      const findings = [];
      if (!wanted.length) findings.push({ level: 'warn', id: 'meili-resources', title: 'search-meilisearch indexes no resource', detail: "List them in calm.config.js: blocks: { 'search-meilisearch': { resources: { post: true } } }" });
      for (const [name] of wanted) if (!calm.app.registry.has(name)) findings.push({ level: 'error', id: 'meili-unknown-resource', title: `search-meilisearch: unknown resource "${name}"` });
      if (host && calm.config.mode === 'production' && host.startsWith('http://') && !/^http:\/\/(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) {
        findings.push({ level: 'warn', id: 'meili-http', title: 'MEILI_HOST uses http:// over a public network', detail: 'Keys and records travel unencrypted. Use https://.' });
      }
      return findings;
    });

    // Plans are built once resources are compiled (onService runs after onResource hooks).
    calm.onService(({ def }) => {
      const conf = options.resources?.[def.name];
      if (!conf) return;
      const settings = conf === true ? {} : conf;
      const fields = indexedFields(def, settings.fields ?? null);
      const searchable = settings.searchable ?? (Object.entries(def.fields).filter(([k, f]) => f.opts.searchable && fields.includes(k)).map(([k]) => k));
      for (const key of [...(settings.filterable ?? []), ...(settings.sortable ?? []), ...searchable]) {
        if (!fields.includes(key)) throw new Error(`search-meilisearch: ${def.name}.${key} is used in searchable/filterable/sortable but is not indexed`);
      }
      plans.set(def.name, {
        uid: `${options.indexPrefix ?? ''}${settings.index ?? def.collection}`,
        fields,
        settings: {
          searchableAttributes: searchable.length ? searchable : ['*'],
          filterableAttributes: settings.filterable ?? [],
          sortableAttributes: settings.sortable ?? [],
        },
      });
    });

    const entryOf = (name) => {
      const entry = calm.app.registry.get(name);
      if (!entry || !plans.has(name)) throw notFound(`"${name}" is not indexed`);
      return entry;
    };

    /** The document stored in Meilisearch: what an anonymous visitor would get, limited to the plan's fields. */
    async function toDocument(entry, doc) {
      const plan = plans.get(entry.def.name);
      const out = await serialize(entry.def, doc, { user: null, registry: calm.app.registry, only: plan.fields });
      return JSON.parse(JSON.stringify(out)); // dates as ISO strings, nothing else
    }

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    async function withRetry(what, fn) {
      for (let i = 0; ; i++) {
        try {
          return await fn();
        } catch (err) {
          if (err instanceof MeiliError && err.permanent) {
            stats.failed += 1;
            calm.log.warn(`search-meilisearch: ${what} failed: ${err.message}`);
            return null;
          }
          if (i >= delays.length) {
            stats.failed += 1;
            calm.log.warn(`search-meilisearch: ${what} failed after ${i + 1} attempts: ${err.message}. Run a reindex once Meilisearch is back.`);
            return null;
          }
          stats.retried += 1;
          await wait(delays[i]);
        }
      }
    }

    // ---- sync ------------------------------------------------------------------------------
    if (client) {
      calm.on('*', async (payload, name) => {
        const m = RESOURCE_EVENT.exec(name);
        if (!m || !payload?.doc || !plans.has(m[1])) return;
        const entry = calm.app.registry.get(m[1]);
        const { uid } = plans.get(m[1]);
        const id = String(payload.doc._id);
        if (m[2] === 'deleted') {
          if (await withRetry(`removing ${m[1]} ${id}`, () => client.remove(uid, id))) stats.removed += 1;
          return;
        }
        const doc = await toDocument(entry, payload.doc);
        if (await withRetry(`indexing ${m[1]} ${id}`, () => client.upsert(uid, [doc]))) stats.indexed += 1;
      });
    }

    function requireClient() {
      if (!client) throw new Error('search-meilisearch: MEILI_HOST is not set');
      return client;
    }

    /** Push the index settings (searchable, filterable, sortable attributes). */
    async function configure(name) {
      entryOf(name);
      const plan = plans.get(name);
      return requireClient().settings(plan.uid, plan.settings);
    }

    /** Send every record of a resource, batchSize at a time, paging by _id. */
    async function reindex(name, { clear = false } = {}) {
      const entry = entryOf(name);
      const plan = plans.get(name);
      const meili = requireClient();
      await meili.settings(plan.uid, plan.settings);
      if (clear) await meili.clear(plan.uid);
      const size = Math.max(1, Math.floor(options.batchSize));
      let last = null;
      let indexed = 0;
      let batches = 0;
      for (;;) {
        // The model directly, without scope(): the index holds every record, search filters per user.
        const docs = await entry.model.find(last ? { _id: { $gt: last } } : {}).sort({ _id: 1 }).limit(size).select(entry.service.internalSelect).lean();
        if (!docs.length) break;
        await meili.upsert(plan.uid, await Promise.all(docs.map((d) => toDocument(entry, d))));
        indexed += docs.length;
        batches += 1;
        last = docs.at(-1)._id;
        if (docs.length < size) break;
      }
      stats.indexed += indexed;
      return { resource: name, index: plan.uid, indexed, batches, cleared: Boolean(clear) };
    }

    /**
     * Ids from Meilisearch, records from MongoDB through the resource's rules. Fills the page with
     * readable records, asking Meilisearch again (at most maxScans times) when some were filtered.
     */
    async function search(name, { q = '', limit, offset = 0, filter, sort } = {}, ctx = {}) {
      const entry = entryOf(name);
      const plan = plans.get(name);
      const meili = requireClient();
      const max = Math.max(1, options.maxSearchLimit);
      const size = Math.min(max, Math.max(1, Math.floor(Number(limit) || options.searchLimit)));
      let cursor = Math.max(0, Math.floor(Number(offset) || 0));
      const user = ctx.user ?? null;
      const found = [];
      let exhausted = false;
      stats.searches += 1;
      for (let scan = 0; scan < options.maxScans && found.length < size && !exhausted; scan++) {
        const want = Math.min(max * 3, (size - found.length) * 3);
        const res = await meili.search(plan.uid, { q: String(q), limit: want, offset: cursor, attributesToRetrieve: ['id'], ...(filter ? { filter } : {}), ...(sort ? { sort } : {}) });
        const hits = (res?.hits ?? []).map((h) => String(h.id)).filter((id) => OBJECT_ID.test(id));
        exhausted = (res?.hits ?? []).length < want;
        // Through the service: its scope() (drafts, tenants...) and the list policy's owner scope.
        const docs = hits.length ? await entry.service.find({ _id: { $in: hits } }, { user, scope: ctx.scope ?? null }) : [];
        const byId = new Map(docs.map((d) => [String(d._id), d]));
        let used = 0;
        for (const id of hits) {
          used += 1;
          const doc = byId.get(id);
          if (doc && (await calm.app.canRead(entry, doc, user))) found.push(doc);
          if (found.length === size) break;
        }
        cursor += used;
        if (used < hits.length) exhausted = false;
      }
      const data = await Promise.all(found.map((doc) => serialize(entry.def, doc, { user, registry: calm.app.registry })));
      // No hit count: it would include records the caller cannot see.
      return { data, meta: { q: String(q), limit: size, offset: Math.max(0, Math.floor(Number(offset) || 0)), nextOffset: exhausted ? null : cursor } };
    }

    calm.provide('search', { reindex, configure, search, stats, plans, get client() { return client; } });

    // ---- routes ------------------------------------------------------------------------------
    calm.routes((r) => {
      for (const [name] of wanted) {
        const entry = calm.app.registry.get(name);
        if (!entry) continue; // reported by doctor
        r.get(
          `${entry.def.path}/search`,
          { policy: entry.def.policy.list, summary: `Search ${name} records (Meilisearch), filtered by what you may read`, tags: [name, 'search'] },
          async (ctx) => {
            const q = typeof ctx.query.q === 'string' ? ctx.query.q : '';
            if (q.length > 200) throw badRequest('q is too long (200 characters at most)');
            const out = await search(name, { q, limit: ctx.query.limit, offset: ctx.query.offset }, ctx);
            return ctx.reply(out.data, { meta: out.meta });
          },
        );
      }
      r.post('/search/:resource/reindex', { policy: 'admin', summary: 'Rebuild a search index from the database', tags: ['search'] }, async (ctx) => {
        const name = String(ctx.params.resource);
        if (!plans.has(name)) throw notFound(`"${name}" is not indexed`);
        return reindex(name, { clear: ctx.body?.clear === true });
      });
    });

    calm.devtools.panel('search', () => ({ host: host ?? null, indexes: [...plans].map(([name, p]) => ({ resource: name, index: p.uid, fields: p.fields, ...p.settings })), stats: { ...stats } }));
  },
});
