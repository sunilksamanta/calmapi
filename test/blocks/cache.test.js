import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');

// Custom routes that count how often their handler runs (shared by both apps below, so the
// tests compare counts before and after).
const files = {
  'app/routes.js': `
const runs = (globalThis.cacheRuns ??= {});
const count = (name) => (runs[name] = (runs[name] ?? 0) + 1);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export default (r) => {
  r.get('/counted', { policy: 'public', meta: { cache: '60s' } }, (ctx) => ({ n: count('counted'), user: ctx.user?.id ?? null }));
  r.get('/static', { policy: 'public', meta: { cache: '60s' } }, () => { count('static'); return { hello: 'world' }; });
  r.get('/whoami', { policy: 'authenticated', meta: { cache: '60s' } }, (ctx) => ({ id: ctx.user.id, n: count('whoami') }));
  r.get('/maybe', { policy: 'public', meta: { cache: '60s' } }, (ctx) => {
    count('maybe');
    if (ctx.query.fail) return ctx.reply({ missing: true }, { status: 404 });
    return { ok: true };
  });
  r.get('/cookie', { policy: 'public', meta: { cache: '60s' } }, (ctx) => {
    count('cookie');
    ctx.res.setHeader('Set-Cookie', 'visitor=' + Math.random() + '; HttpOnly');
    return { ok: true };
  });
  r.get('/nostore', { policy: 'public', meta: { cache: '60s' } }, (ctx) => {
    count('nostore');
    return ctx.reply({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  });
  r.get('/slow', { policy: 'public', meta: { cache: '60s' } }, async () => {
    const n = count('slow');
    await sleep(150);
    return { n };
  });
  r.get('/short', { policy: 'public', meta: { cache: '120ms' } }, () => ({ n: count('short') }));
  r.get('/by-role', { policy: 'authenticated', meta: { cache: { ttl: '60s', vary: 'roles' } } }, (ctx) => ({ n: count('by-role'), roles: ctx.user.roles }));
  r.get('/tagged', { policy: 'public', meta: { cache: { ttl: '60s', tags: ['post'] } } }, () => ({ n: count('tagged') }));
  r.get('/plain', { policy: 'public' }, () => ({ n: count('plain') }));
};
`,
};

const routes = { 'GET /api/posts': '60s', 'GET /api/posts/:id': '60s' };
const runs = (name) => globalThis.cacheRuns?.[name] ?? 0;

let project;
before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [CALM, 'add', 'cache', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
});
after(() => project?.cleanup());

/**
 * GET with optional user and headers; waits for background work (stores, invalidations).
 * fetch() adds Cache-Control: no-cache to conditional requests (If-None-Match), which forces
 * a full answer: send max-age=0 instead, like a browser revalidating its copy.
 */
async function get(t, path, { who, headers = {} } = {}) {
  const conditional = headers['if-none-match'] ? { 'cache-control': 'max-age=0' } : {};
  const res = await fetch(`${t.origin}/api${path}`, { headers: { ...conditional, ...headers, ...(who ? { authorization: `Bearer ${who.token}` } : {}) } });
  const text = await res.text();
  await t.idle();
  return { status: res.status, headers: res.headers, body: text ? JSON.parse(text) : null, cache: res.headers.get('x-cache') };
}
const unique = () => randomBytes(4).toString('hex');
let limits = 20;
/** A list query no other test uses (unknown query parameters are refused by CRUD lists). */
const freshList = () => `limit=${++limits}`;

for (const store of ['memory', 'mongo']) {
  describe(`cache (${store} store)`, () => {
    let t;
    let alice;
    let bob;
    let admin;

    before(async () => {
      t = await project.testApp({ blocks: { cache: { store, routes } } });
      alice = await t.signup({ name: 'Alice' });
      bob = await t.signup({ name: 'Bob' });
      admin = await t.signup({ name: 'Admin', roles: ['user', 'admin'] });
    });
    after(async () => t?.close());

    test('miss then hit, the handler runs once', async () => {
      const q = unique();
      const start = runs('counted');
      const first = await get(t, `/counted?q=${q}`);
      assert.equal(first.status, 200);
      assert.equal(first.cache, 'miss');
      const second = await get(t, `/counted?q=${q}`);
      assert.equal(second.cache, 'hit');
      assert.deepEqual(second.body, first.body);
      assert.equal(second.headers.get('content-type'), 'application/json; charset=utf-8');
      assert.equal(runs('counted') - start, 1);
    });

    test('query order is normalized, other values are other entries', async () => {
      const q = unique();
      const start = runs('counted');
      assert.equal((await get(t, `/counted?a=${q}&b=2`)).cache, 'miss');
      assert.equal((await get(t, `/counted?b=2&a=${q}`)).cache, 'hit');
      assert.equal((await get(t, `/counted?b=3&a=${q}`)).cache, 'miss');
      assert.equal(runs('counted') - start, 2);
    });

    test('anonymous and signed-in callers never share an entry', async () => {
      const q = unique();
      const anon = await get(t, `/counted?q=${q}`);
      const mine = await get(t, `/counted?q=${q}`, { who: alice });
      assert.equal(mine.cache, 'miss');
      assert.equal(mine.body.data.user, alice.id);
      assert.equal(anon.body.data.user, null);
      assert.equal((await get(t, `/counted?q=${q}`)).body.data.user, null);
      assert.equal((await get(t, `/counted?q=${q}`, { who: alice })).cache, 'hit');
    });

    test('two users never see each other\'s answers', async () => {
      const a1 = await get(t, '/whoami', { who: alice });
      const b1 = await get(t, '/whoami', { who: bob });
      assert.equal(a1.body.data.id, alice.id);
      assert.equal(b1.body.data.id, bob.id);
      assert.equal(b1.cache, 'miss');
      const a2 = await get(t, '/whoami', { who: alice });
      const b2 = await get(t, '/whoami', { who: bob });
      assert.equal(a2.cache, 'hit');
      assert.equal(a2.body.data.id, alice.id);
      assert.equal(b2.body.data.id, bob.id);
      assert.equal((await get(t, '/whoami')).status, 401, 'a cached answer is never served to an anonymous caller');
    });

    test('per user CRUD lists: drafts stay with their author', async () => {
      const title = `Draft ${unique()}`;
      assert.equal((await t.post('/posts', { title, body: 'secret draft' }, alice)).status, 201);
      await t.idle();
      const mine = await get(t, '/posts?limit=100', { who: alice });
      assert.ok(mine.body.data.some((p) => p.title === title));
      const theirs = await get(t, '/posts?limit=100', { who: bob });
      assert.equal(theirs.cache, 'miss');
      assert.ok(!theirs.body.data.some((p) => p.title === title), 'Bob never gets Alice\'s cached list');
      assert.ok(!(await get(t, '/posts?limit=100')).body.data.some((p) => p.title === title));
      assert.equal((await get(t, '/posts?limit=100', { who: alice })).cache, 'hit');
    });

    test('resource events invalidate: create, update, delete', async () => {
      const q = freshList();
      await get(t, `/posts?${q}`);
      assert.equal((await get(t, `/posts?${q}`)).cache, 'hit');
      const tagged = await get(t, '/tagged');
      assert.equal((await get(t, '/tagged')).cache, 'hit');

      const created = await t.post('/posts', { title: `Live ${unique()}`, body: 'hello', status: 'published' }, alice);
      await t.idle();
      const afterCreate = await get(t, `/posts?${q}`);
      assert.equal(afterCreate.cache, 'miss');
      assert.ok(afterCreate.body.data.some((p) => p.id === created.body.data.id));
      assert.equal((await get(t, '/tagged')).cache, 'miss', 'tags: [\'post\'] follows post events');
      assert.notEqual((await get(t, '/tagged')).body.data.n, tagged.body.data.n);

      const id = created.body.data.id;
      assert.equal((await get(t, `/posts/${id}`)).cache, 'miss');
      assert.equal((await get(t, `/posts/${id}`)).cache, 'hit');
      await t.patch(`/posts/${id}`, { title: 'Renamed' }, alice);
      await t.idle();
      const renamed = await get(t, `/posts/${id}`);
      assert.equal(renamed.cache, 'miss');
      assert.equal(renamed.body.data.title, 'Renamed');

      await get(t, `/posts?${q}`);
      assert.equal((await t.delete(`/posts/${id}`, alice)).status, 204);
      await t.idle();
      const afterDelete = await get(t, `/posts?${q}`);
      assert.equal(afterDelete.cache, 'miss');
      assert.ok(!afterDelete.body.data.some((p) => p.id === id));
      assert.equal((await get(t, `/posts/${id}`)).status, 404, 'the cached item is gone with the record');
    });

    test('manual invalidation by tag, by path prefix, and clear', async () => {
      const q = unique();
      await get(t, `/counted?q=${q}`);
      assert.equal((await get(t, `/counted?q=${q}`)).cache, 'hit');
      await t.app.ext.cache.invalidate('/api/counted');
      assert.equal((await get(t, `/counted?q=${q}`)).cache, 'miss');
      await get(t, '/tagged');
      await t.app.ext.cache.invalidate('post');
      assert.equal((await get(t, '/tagged')).cache, 'miss');
      await t.app.ext.cache.clear();
      assert.equal((await get(t, `/counted?q=${q}`)).cache, 'miss');
    });

    test('TTL expiry', async () => {
      const q = unique();
      const first = await get(t, `/short?q=${q}`);
      assert.equal((await get(t, `/short?q=${q}`)).cache, 'hit');
      await new Promise((r) => setTimeout(r, 200));
      const later = await get(t, `/short?q=${q}`);
      assert.equal(later.cache, 'miss');
      assert.notEqual(later.body.data.n, first.body.data.n);
    });

    test('ETag and If-None-Match: 304 for cached and uncached answers', async () => {
      await t.app.ext.cache.invalidate('/api/static');
      const start = runs('static');
      const first = await get(t, '/static');
      const etag = first.headers.get('etag');
      assert.match(etag, /^"[\w-]{43}"$/, 'a strong ETag');
      const cached = await get(t, '/static', { headers: { 'if-none-match': etag } });
      assert.equal(cached.status, 304);
      assert.equal(cached.body, null);
      assert.equal(runs('static') - start, 1);

      // A miss (the entry is gone) still answers 304 when the content did not change.
      await t.app.ext.cache.invalidate('/api/static');
      const uncached = await get(t, '/static', { headers: { 'if-none-match': etag } });
      assert.equal(uncached.status, 304);
      assert.equal(runs('static') - start, 2);
      assert.equal((await get(t, '/static', { headers: { 'if-none-match': '"stale"' } })).status, 200);
    });

    test('Cache-Control: public for anonymous answers on public routes, private otherwise', async () => {
      const anon = await get(t, `/counted?q=${unique()}`);
      assert.equal(anon.headers.get('cache-control'), 'public, max-age=0, must-revalidate');
      assert.match(anon.headers.get('vary'), /Authorization/);
      const mine = await get(t, `/counted?q=${unique()}`, { who: alice });
      assert.equal(mine.headers.get('cache-control'), 'private, no-cache');
      assert.equal((await get(t, '/whoami', { who: alice })).headers.get('cache-control'), 'private, no-cache');
    });

    test('non-200, Set-Cookie and no-store answers are never stored', async () => {
      let start = runs('maybe');
      assert.equal((await get(t, '/maybe?fail=1')).status, 404);
      const again = await get(t, '/maybe?fail=1');
      assert.equal(again.status, 404);
      assert.equal(again.cache, null);
      assert.equal(runs('maybe') - start, 2);

      start = runs('cookie');
      assert.equal((await get(t, '/cookie')).cache, 'miss');
      assert.equal((await get(t, '/cookie')).cache, 'miss');
      assert.equal(runs('cookie') - start, 2);

      start = runs('nostore');
      await get(t, '/nostore');
      const ns = await get(t, '/nostore');
      assert.equal(ns.cache, 'miss');
      assert.equal(ns.headers.get('cache-control'), 'no-store', 'the handler\'s Cache-Control is kept');
      assert.equal(runs('nostore') - start, 2);
    });

    test('vary: roles shares an entry between users with the same roles only', async () => {
      await t.app.ext.cache.invalidate('/api/by-role');
      assert.equal((await get(t, '/by-role', { who: alice })).cache, 'miss');
      assert.equal((await get(t, '/by-role', { who: bob })).cache, 'hit');
      const adminView = await get(t, '/by-role', { who: admin });
      assert.equal(adminView.cache, 'miss');
      assert.deepEqual(adminView.body.data.roles.sort(), ['admin', 'user']);
    });

    test('stampede: concurrent misses run the handler once', async () => {
      const q = unique();
      const start = runs('slow');
      const results = await Promise.all(Array.from({ length: 10 }, () => fetch(`${t.origin}/api/slow?q=${q}`).then(async (r) => ({ status: r.status, cache: r.headers.get('x-cache'), body: await r.json() }))));
      await t.idle();
      assert.equal(runs('slow') - start, 1);
      assert.ok(results.every((r) => r.status === 200 && r.body.data.n === results[0].body.data.n));
      assert.equal(results.filter((r) => r.cache === 'miss').length, 1);
      assert.equal(results.filter((r) => r.cache === 'hit').length, 9);
    });

    test('routes without cache settings are untouched', async () => {
      const plain = await get(t, '/plain');
      assert.equal(plain.cache, null);
      assert.equal((await get(t, '/plain')).cache, null);
    });

    test('doctor is clean and stats count', async () => {
      assert.deepEqual((await t.app.doctor()).filter((f) => f.id.startsWith('cache-')), []);
      const { stats } = t.app.ext.cache;
      assert.ok(stats.hits > 0 && stats.misses > 0 && stats.stored > 0);
      if (store === 'mongo') {
        const doc = await t.app.ext.cache.store.model.findOne().lean();
        assert.match(doc.body, /^enc:/, 'cached bodies are encrypted at rest');
      }
    });
  });
}

describe('cache configuration', () => {
  test('vary: roles is refused at boot on routes that depend on ownership', async () => {
    const { createApp } = await project.load('calm/app.js');
    const base = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
    const uri = new URL(base);
    uri.pathname = `/calm_test_cache_${unique()}`;
    const app = await createApp({
      root: project.dir,
      config: { mode: 'test', db: { uri: uri.toString(), connectRetries: 1 }, log: { level: 'silent' }, blocks: { cache: { store: 'memory', routes: { 'GET /api/posts': { ttl: '60s', vary: 'roles' } } } } },
    });
    try {
      await assert.rejects(app.start(), /cannot use vary: 'roles' because PostService\.scope\(\) filters records per user/);
    } finally {
      await app.stop();
    }
  });

  test('unmatched route patterns are reported by doctor', async () => {
    const t = await project.testApp({ blocks: { cache: { store: 'memory', routes: { 'GET /api/nothing-here': '1m' } } } });
    try {
      const ids = (await t.app.doctor()).filter((f) => f.id.startsWith('cache-')).map((f) => f.id);
      assert.deepEqual(ids, ['cache-route-unmatched']);
    } finally {
      await t.close();
    }
  });
});
