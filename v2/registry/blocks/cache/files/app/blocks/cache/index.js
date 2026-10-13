import { createHash } from 'node:crypto';
import { definePlugin, parsePolicy, ResourceService, currentRequest, trace } from '#calm';
import { memoryStore, mongoStore } from './stores.js';

// Response caching for GET routes, safe by default.
//
//   r.get('/stats', { policy: 'public', meta: { cache: '60s' } }, ...)          a route opts in
//   blocks: { cache: { routes: { 'GET /api/posts': '30s' } } }                CRUD routes, from config
//
// The rules, each one there so a cached answer is never one the caller should not get:
//
//  1. The key is the method, the path, the query (sorted, so ?a=1&b=2 and ?b=2&a=1 share an
//     entry) and the identity that shapes the answer: 'anonymous', or the user id with their
//     roles and credential scopes. A signed-in user only ever reads entries their own requests
//     produced, under the roles they have now.
//  2. vary: 'roles' shares entries between users with the same roles. It is refused at boot on
//     routes whose answer depends on who owns what ('owner' or function policies, visibleTo
//     rules with them, a service scope()), where it would hand one user's records to another.
//  3. Only 200 JSON answers are stored. Errors, redirects, responses that set a cookie (a
//     session, a CSRF token: per-visitor by nature) or say Cache-Control: no-store never are.
//  4. Entries are served from a guard that runs after every other guard (API key scopes,
//     plans, maintenance...). An entry exists only because the same identity passed the route
//     policy moments ago; changes to the records are covered by invalidation (below), changes to
//     roles by the key.
//  5. Resource events (post.created, .updated, .deleted, .restored) clear the entries tagged with
//     that resource. A response computed while an invalidation happened is not stored, so a
//     slow request cannot write stale data back after the clear.
//  6. Concurrent misses for the same key run the handler once (per process, with either store):
//     the others wait for that answer instead of stampeding the database.
//
// Responses get a strong ETag (If-None-Match -> 304, cached or not), x-cache: hit | miss, and
// Cache-Control: public for anonymous answers on public routes, private, no-cache otherwise.

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };
const RESOURCE_EVENT = /^([\w-]+)\.(created|updated|deleted|restored)$/;
const JSON_TYPE = /^application\/([\w.-]+\+)?json\b/i;

/** 5000, '30s', '5m', '1h' -> milliseconds. */
export function toMs(value, name) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!m || Number(m[1]) <= 0) throw new Error(`cache: ${name} must be milliseconds or a duration like '30s', '5m', '1h' (got ${JSON.stringify(value)})`);
  return Number(m[1]) * UNITS[m[2]];
}

/** '?b=2&a=1&a=0' -> 'a=1&a=0&b=2': keys sorted, the order of repeated keys kept (it can matter). */
export function normalizeQuery(url) {
  const i = url.indexOf('?');
  if (i < 0) return '';
  const entries = [...new URLSearchParams(url.slice(i + 1))];
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)); // stable: same keys keep their order
  return new URLSearchParams(entries).toString();
}

const sha256 = (text) => createHash('sha256').update(text).digest('base64url');
const pathOf = (req) => req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';

/** Why the answer of this route can depend on who owns what, or null. */
function ownershipReason(route, entry) {
  const dynamic = (tokens) => (tokens ?? []).some((t) => t === 'owner' || typeof t === 'function');
  if (dynamic(route.policy)) return `its policy (${route.policyLabel}) depends on the record or the user`;
  if (!entry) return null;
  for (const [name, field] of Object.entries(entry.def.fields ?? {})) {
    if (field.opts?.visibleTo && dynamic(parsePolicy(field.opts.visibleTo))) return `field ${name} is visibleTo(${field.opts.visibleTo})`;
  }
  if (entry.service.scope !== ResourceService.prototype.scope) return `${entry.service.constructor.name}.scope() filters records per user`;
  return null;
}

export default definePlugin({
  name: 'cache',
  // Override in calm.config.js: blocks: { cache: { store: 'memory', routes: { 'GET /api/posts': '30s' } } }
  options: {
    /** 'mongo' (shared by every instance), 'memory' (per process, an LRU) or your own store object (see stores.js). */
    store: 'mongo',
    /** Default time to live for routes that say cache: true. */
    ttl: '60s',
    /** Routes to cache without touching their code: { 'GET /api/posts': '30s', 'GET /api/posts/:id': { ttl: '5m', tags: ['user'] } }. */
    routes: {},
    /** Memory store: most entries kept. */
    maxEntries: 1000,
    /** Bigger responses are served but not stored. */
    maxBodyKb: 512,
    /** Request headers that change the answer (a tenant header, accept-language): they join the key. */
    varyHeaders: [],
    /** max-age sent to browsers and CDNs for public, anonymous answers (0: always revalidate, with the ETag). */
    browserMaxAge: 0,
    /** How long concurrent misses wait for the first one before running the handler themselves. */
    waitMs: 5000,
  },
  setup(calm, options) {
    const defaultTtl = toMs(options.ttl, 'ttl');
    const maxBytes = Math.max(1, Number(options.maxBodyKb) || 512) * 1024;
    const waitMs = Math.max(0, Number(options.waitMs) || 0);
    const browserMaxAge = Math.max(0, Math.floor(Number(options.browserMaxAge) || 0));
    const varyHeaders = (options.varyHeaders ?? []).map((h) => String(h).toLowerCase());

    let store;
    if (options.store === 'memory') store = memoryStore({ maxEntries: options.maxEntries });
    else if (options.store === 'mongo') store = mongoStore({ mongoose: calm.mongoose, cipher: calm.app.cipher });
    else if (options.store && ['get', 'set', 'deleteTag', 'deletePrefix', 'clear'].every((m) => typeof options.store[m] === 'function')) store = options.store;
    else throw new Error("cache: store must be 'mongo', 'memory' or an object with get, set, deleteTag, deletePrefix and clear");

    // ---- which routes, and how ----------------------------------------------------------------
    const configured = new Map(Object.entries(options.routes ?? {}).map(([pattern, spec]) => [pattern.trim().replace(/\s+/, ' ').replace(/\/+$/, ''), spec]));
    const used = new Set();
    const settings = new WeakMap(); // route record -> settings | null

    function settingsFor(route) {
      if (settings.has(route)) return settings.get(route);
      const label = `${route.method} ${calm.config.apiPrefix}${route.path}`.replace(/\/+$/, '');
      let spec = route.meta?.cache;
      if (configured.has(label)) {
        spec = configured.get(label);
        used.add(label);
      }
      let s = null;
      if (spec !== undefined && spec !== false && spec !== null) {
        if (route.method !== 'GET') throw new Error(`cache: ${label} is not a GET route; only GET answers are cached`);
        const o = typeof spec === 'object' ? spec : { ttl: spec === true ? defaultTtl : spec };
        const vary = o.vary ?? 'user';
        if (!['user', 'roles'].includes(vary)) throw new Error(`cache: ${label}: vary must be 'user' or 'roles'`);
        const entry = route.resource ? calm.app.registry.get(route.resource) : null;
        if (vary === 'roles') {
          const reason = ownershipReason(route, entry);
          if (reason) throw new Error(`cache: ${label} cannot use vary: 'roles' because ${reason}. Users would see each other's records. Remove vary (per user entries).`);
        }
        s = {
          label,
          ttl: o.ttl === undefined ? defaultTtl : toMs(o.ttl, `${label} ttl`),
          vary,
          // Resource routes are tagged with their resource, so its events clear them.
          tags: [...new Set([...(route.resource ? [route.resource] : []), ...(o.tags ?? [])])],
          publicRoute: (route.policy ?? []).includes('public'),
        };
      }
      settings.set(route, s);
      return s;
    }

    /** Who is asking, as far as it can change the answer (rule 1). */
    function identity(ctx, s) {
      if (!ctx.user) return 'anonymous';
      const roles = [...(ctx.user.roles ?? [])].map(String).sort().join(',');
      const credential = ctx.auth ? `${ctx.auth.via ?? ''}:${[...(ctx.auth.scopes ?? [])].sort().join(',')}` : '';
      return s.vary === 'roles' ? `roles:${roles}|${credential}` : `user:${ctx.user.id}|roles:${roles}|${credential}`;
    }

    const keyFor = (ctx, s) =>
      sha256(JSON.stringify(['v1', ctx.req.method, pathOf(ctx.req), normalizeQuery(ctx.req.originalUrl), identity(ctx, s), varyHeaders.map((h) => ctx.req.get(h) ?? '')]));

    // ---- invalidation -----------------------------------------------------------------------------
    // Generations (rule 5): a response is only stored if no invalidation touching its tags (or
    // any prefix invalidation) happened while it was computed.
    let prefixGeneration = 0;
    const tagGenerations = new Map();
    const snapshot = (tags) => ({ prefix: prefixGeneration, tags: tags.map((t) => tagGenerations.get(t) ?? 0) });
    const unchanged = (snap, tags) => snap.prefix === prefixGeneration && tags.every((t, i) => (tagGenerations.get(t) ?? 0) === snap.tags[i]);

    /** invalidate('post') clears a tag; invalidate('/api/reports') every path starting with it. */
    async function invalidate(tagOrPrefix) {
      const value = String(tagOrPrefix);
      if (value.startsWith('/')) {
        prefixGeneration += 1;
        await store.deletePrefix(value);
      } else {
        tagGenerations.set(value, (tagGenerations.get(value) ?? 0) + 1);
        await store.deleteTag(value);
      }
    }
    async function clear() {
      prefixGeneration += 1;
      await store.clear();
    }

    calm.on('*', async (_payload, name) => {
      const m = RESOURCE_EVENT.exec(name);
      if (m) await invalidate(m[1]);
    });

    // ---- serving ----------------------------------------------------------------------------------
    const stats = { hits: 0, misses: 0, stored: 0, skipped: 0 };
    const inflight = new Map(); // key -> Promise<entry | null> (rule 6)

    function cacheControl(ctx, s) {
      if (ctx.res.getHeader('cache-control')) return; // the handler decided
      if (!ctx.user && s.publicRoute) {
        ctx.res.setHeader('Cache-Control', `public, max-age=${browserMaxAge}, must-revalidate`);
        ctx.res.vary('Authorization'); // a CDN must not hand this anonymous copy to signed-in requests, or the reverse
      } else {
        ctx.res.setHeader('Cache-Control', 'private, no-cache'); // never in shared caches; browsers revalidate
      }
    }

    function note(outcome) {
      trace({ kind: 'cache', name: 'cache', file: 'app/blocks/cache/index.js', detail: outcome, outcome: outcome === 'hit' ? 'answered' : 'passed' });
      const record = currentRequest()?.devtools;
      if (record) record.cache = outcome;
    }

    function serve(ctx, s, entry) {
      stats.hits += 1;
      note('hit');
      const { res } = ctx;
      res.setHeader('Content-Type', entry.contentType);
      res.setHeader('ETag', entry.etag);
      res.setHeader('x-cache', 'hit');
      cacheControl(ctx, s);
      // Express answers 304 when If-None-Match matches the ETag.
      res.status(200).send(entry.body);
    }

    /** Store what the handler sends, when rule 3 allows it, and answer the waiting requests. */
    function capture(ctx, s, key, leader) {
      const { res } = ctx;
      const snap = snapshot(s.tags);
      const original = res.send;
      let done = false;
      const finish = (entry) => {
        if (done) return;
        done = true;
        if (leader) {
          inflight.delete(key);
          leader.resolve(entry);
        }
      };
      res.once('close', () => finish(null)); // the handler failed or the client left: waiters run on their own

      res.send = function (body) {
        res.send = original;
        const text = typeof body === 'string' ? body : Buffer.isBuffer(body) ? body.toString('utf8') : null;
        if (res.statusCode !== 200 || text === null) {
          finish(null);
          return original.call(this, body);
        }
        const etag = `"${sha256(text)}"`;
        res.setHeader('ETag', etag);
        res.setHeader('x-cache', 'miss');
        cacheControl(ctx, s);
        const contentType = String(res.getHeader('content-type') ?? '');
        const noStore = /no-store/i.test(String(res.getHeader('cache-control') ?? ''));
        const storable = JSON_TYPE.test(contentType) && !res.getHeader('set-cookie') && !noStore && Buffer.byteLength(text) <= maxBytes;
        if (storable && unchanged(snap, s.tags)) {
          const entry = { body: text, contentType, etag, tags: s.tags, path: pathOf(ctx.req), expiresAt: Date.now() + s.ttl };
          stats.stored += 1;
          calm.app.background(() => store.set(key, entry));
          finish(entry);
        } else {
          stats.skipped += 1;
          finish(null);
        }
        return original.call(this, body);
      };
    }

    const wait = (promise) =>
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), waitMs);
        timer.unref?.();
        promise.then((entry) => {
          clearTimeout(timer);
          resolve(entry);
        });
      });

    calm.guard(
      async (ctx, route) => {
        if (ctx.req.method !== 'GET') return;
        const s = settingsFor(route);
        if (!s) return;
        const key = keyFor(ctx, s);
        // Someone is already computing (or reading) this key: wait for their answer.
        const pending = inflight.get(key);
        if (pending) {
          const entry = await wait(pending);
          if (entry) return serve(ctx, s, entry);
          stats.misses += 1;
          note('miss');
          return capture(ctx, s, key, null);
        }
        // Claim the key before the first await, so requests arriving while the store is read
        // (MongoDB takes a round trip) wait too instead of all missing at once.
        const leader = Promise.withResolvers();
        inflight.set(key, leader.promise);
        const entry = await store.get(key).catch((err) => {
          calm.log.warn('cache: store read failed, answering without the cache', { err: err.message });
          return null;
        });
        if (entry) {
          inflight.delete(key);
          leader.resolve(entry);
          return serve(ctx, s, entry);
        }
        stats.misses += 1;
        note('miss');
        capture(ctx, s, key, leader);
      },
      { order: 1000 }, // last (rule 4): every other guard has had its say
    );

    // Validate every route now, so a mistake (vary: 'roles' on an owner route) fails the boot.
    calm.onStart(async () => {
      for (const route of calm.app.routes) settingsFor(route);
      await store.init?.();
    });

    calm.provide('cache', { store, invalidate, clear, stats, keyFor, normalizeQuery });
    calm.guard((ctx) => {
      ctx.cache = { invalidate, clear };
    });

    calm.doctor((app) => {
      const findings = [];
      for (const route of app.routes) {
        try {
          settingsFor(route);
        } catch (err) {
          findings.push({ level: 'error', id: 'cache-route', title: 'cache: a route is configured unsafely', detail: err.message });
        }
      }
      for (const label of configured.keys()) {
        if (!used.has(label)) findings.push({ level: 'warn', id: 'cache-route-unmatched', title: `cache: "${label}" matches no GET route`, detail: 'Use the method and the full path as declared, with the /api prefix: "GET /api/posts/:id".' });
      }
      if (store.name === 'memory' && app.config.mode === 'production') {
        findings.push({ level: 'info', id: 'cache-memory', title: 'cache: in-memory store', detail: 'Each instance keeps its own copy and only clears it for changes it made itself. With several instances use store: \'mongo\'.' });
      }
      return findings;
    });

    calm.devtools.panel('cache', async () => ({ store: store.name ?? 'custom', ...stats, entries: store.size?.() ?? null, inflight: inflight.size }));
  },
});
