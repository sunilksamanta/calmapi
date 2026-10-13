import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// Keys built at runtime: no secret-shaped literals.
const adminKey = randomBytes(16).toString('hex');
const searchKey = randomBytes(16).toString('hex');

// A fake Meilisearch keeping indexes in memory. Search is a case-insensitive substring match
// on the searchable attributes (all string fields when '*'), in insertion order.
const indexes = new Map(); // uid -> { docs: Map, settings }
const calls = [];
const fake = { failWrites: 0 };
let server;
let origin;
let project;
let t;
let alice;
let bob;
let admin;

const indexOf = (uid) => {
  if (!indexes.has(uid)) indexes.set(uid, { docs: new Map(), settings: { searchableAttributes: ['*'] } });
  return indexes.get(uid);
};

const files = {
  'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  fields: {
    text: f.string().required().searchable(),
    secret: f.string().hidden(),
    staffNote: f.string().readOnly().visibleTo('admin'),
    phone: f.string().pii(),
    author: f.ref('user').owner(),
  },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/resources/note/note.service.js': `
import { ResourceService } from '#calm';
export default class NoteService extends ResourceService {
  async beforeCreate(data) { return { ...data, secret: 'classified ' + data.text, staffNote: 'flagged' }; }
}`,
};

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url, 'http://x');
      calls.push({ method: req.method, path: url.pathname, query: url.search, auth: req.headers.authorization, body });
      const json = (status, o) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(o));
      const m = /^\/indexes\/([^/]+)(\/documents(?:\/([^/]+))?|\/settings|\/search)?$/.exec(url.pathname);
      if (!m) return json(404, { message: 'not found', code: 'not_found' });
      const isSearch = m[2] === '/search';
      if (req.headers.authorization !== `Bearer ${isSearch ? searchKey : adminKey}`) return json(403, { message: 'The provided API key is invalid.', code: 'invalid_api_key' });
      if (!isSearch && fake.failWrites > 0) {
        fake.failWrites -= 1;
        return json(503, { message: 'unavailable', code: 'unavailable' });
      }
      const idx = indexOf(decodeURIComponent(m[1]));
      if (m[2] === '/documents' && req.method === 'POST') {
        for (const d of body) idx.docs.set(d.id, d);
        return json(202, { taskUid: calls.length, status: 'enqueued' });
      }
      if (m[2] === '/documents' && req.method === 'DELETE') {
        idx.docs.clear();
        return json(202, { taskUid: calls.length });
      }
      if (m[3] && req.method === 'DELETE') {
        idx.docs.delete(decodeURIComponent(m[3]));
        return json(202, { taskUid: calls.length });
      }
      if (m[2] === '/settings') {
        Object.assign(idx.settings, body);
        return json(202, { taskUid: calls.length });
      }
      if (isSearch) {
        const q = String(body.q ?? '').toLowerCase();
        const fields = idx.settings.searchableAttributes;
        const match = (d) => !q || Object.entries(d).some(([k, v]) => (fields.includes('*') || fields.includes(k)) && typeof v === 'string' && v.toLowerCase().includes(q));
        const all = [...idx.docs.values()].filter(match);
        const page = all.slice(body.offset ?? 0, (body.offset ?? 0) + (body.limit ?? 20));
        const hits = page.map((d) => (body.attributesToRetrieve ? Object.fromEntries(body.attributesToRetrieve.map((a) => [a, d[a]])) : d));
        return json(200, { hits, query: body.q, offset: body.offset ?? 0, limit: body.limit, estimatedTotalHits: all.length });
      }
      json(405, {});
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  calm(project.dir, 'add', 'search-meilisearch', '--yes', '--no-install');
  Object.assign(process.env, { MEILI_HOST: origin, MEILI_MASTER_KEY: adminKey, MEILI_SEARCH_KEY: searchKey });
  t = await project.testApp({ blocks: { 'search-meilisearch': { resources: { post: true, note: true }, retries: [10, 10, 10], batchSize: 2, searchLimit: 5 } } });
  [alice, bob, admin] = [await t.signup({ name: 'Alice' }), await t.signup({ name: 'Bob' }), await t.signup({ name: 'Admin', roles: ['user', 'admin'] })];
});

after(async () => {
  await t?.close();
  project?.cleanup();
  for (const k of ['MEILI_HOST', 'MEILI_MASTER_KEY', 'MEILI_SEARCH_KEY']) delete process.env[k];
  await new Promise((resolve) => server.close(resolve));
});

const settle = async () => {
  for (let i = 0; i < 3; i++) await t.idle();
};
const posts = () => indexOf('posts').docs;
const notes = () => indexOf('notes').docs;

test('search-meilisearch: created, updated and deleted records follow in the index', async () => {
  const created = (await t.post('/posts', { title: 'Hello Meili', body: 'First body', status: 'published', tags: ['news'] }, alice)).body.data;
  await settle();
  const doc = posts().get(created.id);
  assert.deepEqual(Object.keys(doc).sort(), ['author', 'body', 'createdAt', 'id', 'publishedAt', 'slug', 'status', 'tags', 'title', 'updatedAt']);
  assert.equal(doc.title, 'Hello Meili');
  assert.equal(doc.author, alice.id);
  const write = calls.find((c) => c.method === 'POST' && c.path === '/indexes/posts/documents');
  assert.equal(write.query, '?primaryKey=id');
  assert.equal(write.auth, `Bearer ${adminKey}`);

  await t.patch(`/posts/${created.id}`, { title: 'Hello again' }, alice);
  await settle();
  assert.equal(posts().get(created.id).title, 'Hello again');

  assert.equal((await t.delete(`/posts/${created.id}`, alice)).status, 204);
  await settle();
  assert.equal(posts().has(created.id), false);
});

test('search-meilisearch: hidden, visibleTo and pii fields never reach the index', async () => {
  const note = (await t.post('/notes', { text: 'Buy milk', phone: '+14155550100' }, alice)).body.data;
  await settle();
  const doc = notes().get(note.id);
  assert.deepEqual(Object.keys(doc).sort(), ['author', 'createdAt', 'id', 'text', 'updatedAt']);
  assert.ok(!JSON.stringify([...notes().values()]).includes('classified'));
  assert.ok(!JSON.stringify([...notes().values()]).includes('flagged'));
  assert.ok(!JSON.stringify([...notes().values()]).includes('+14155550100'));

  const { indexedFields } = await project.load('app/blocks/search-meilisearch/index.js');
  const def = t.app.registry.get('note').def;
  assert.deepEqual(indexedFields(def, ['text', 'author']), ['text', 'author']);
  for (const key of ['secret', 'staffNote', 'phone']) assert.throws(() => indexedFields(def, [key]), /cannot be indexed/);
  await assert.rejects(() => project.testApp({ blocks: { 'search-meilisearch': { resources: { note: { fields: ['text', 'secret'] } } } } }), /note\.secret is hidden and cannot be indexed/, 'a private field in the config stops the boot');
});

test('search-meilisearch: a failed sync is retried', async () => {
  const retried = t.app.ext.search.stats.retried;
  fake.failWrites = 2;
  const post = (await t.post('/posts', { title: 'Retry me', body: 'x', status: 'published' }, bob)).body.data;
  await settle();
  assert.equal(posts().get(post.id)?.title, 'Retry me');
  assert.equal(t.app.ext.search.stats.retried - retried, 2);
});

test('search-meilisearch: reindex pages through the collection', async () => {
  const Post = t.app.model('post');
  const author = alice.id;
  // Written without the API: no events, so the index does not know them yet.
  await Post.insertMany(Array.from({ length: 5 }, (_, i) => ({ title: `Imported ${i}`, slug: `imported-${i}`, body: 'Legacy', status: 'published', author })));
  const total = await Post.countDocuments();
  assert.equal((await t.post('/search/post/reindex', {}, alice)).status, 403);
  assert.equal((await t.post('/search/nope/reindex', {}, admin)).status, 404);

  const before = calls.length;
  const res = await t.post('/search/post/reindex', { clear: true }, admin);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { resource: 'post', index: 'posts', indexed: total, batches: Math.ceil(total / 2), cleared: true });
  const mine = calls.slice(before);
  assert.deepEqual(mine[0].body, { searchableAttributes: ['title'], filterableAttributes: [], sortableAttributes: [] }, 'settings come from .searchable() fields');
  assert.equal(mine[1].method, 'DELETE');
  const batches = mine.filter((c) => c.method === 'POST' && c.path === '/indexes/posts/documents');
  assert.equal(batches.length, Math.ceil(total / 2));
  assert.ok(batches.every((b) => b.body.length <= 2));
  assert.equal(posts().size, total);
});

test('search-meilisearch: results are filtered by the resource policy and scope', async () => {
  await t.post('/posts', { title: 'Alpha launch', body: 'public', status: 'published' }, alice);
  await t.post('/posts', { title: 'Alpha secret draft', body: 'draft', status: 'draft' }, alice);
  await t.post('/notes', { text: 'Alpha private note' }, alice);
  await t.post('/notes', { text: 'Alpha note of Bob' }, bob);
  await settle();
  assert.equal([...posts().values()].filter((d) => /alpha/i.test(d.title)).length, 2, 'both posts are in the index');

  const titles = (res) => res.body.data.map((p) => p.title ?? p.text).sort();
  const anon = await t.get('/posts/search?q=alpha');
  assert.equal(anon.status, 200);
  assert.deepEqual(titles(anon), ['Alpha launch'], 'visitors only find published posts');
  assert.deepEqual(titles(await t.get('/posts/search?q=alpha', bob)), ['Alpha launch'], "Bob does not find Alice's draft");
  assert.deepEqual(titles(await t.get('/posts/search?q=alpha', alice)), ['Alpha launch', 'Alpha secret draft'], 'Alice finds her own draft');
  const searches = calls.filter((c) => c.path === '/indexes/posts/search');
  assert.equal(searches.at(-1).auth, `Bearer ${searchKey}`, 'queries use the search key');
  assert.deepEqual(searches.at(-1).body.attributesToRetrieve, ['id'], 'only ids come back from Meilisearch');

  assert.equal((await t.get('/notes/search?q=alpha')).status, 401, 'the list policy applies');
  const aliceNotes = await t.get('/notes/search?q=alpha', alice);
  assert.deepEqual(titles(aliceNotes), ['Alpha private note']);
  assert.equal(aliceNotes.body.data[0].secret, undefined, 'hidden fields stay hidden');
  assert.equal(aliceNotes.body.data[0].staffNote, undefined);
  assert.deepEqual(titles(await t.get('/notes/search?q=alpha', bob)), ['Alpha note of Bob']);
  const adminNotes = await t.get('/notes/search?q=alpha', admin);
  assert.deepEqual(titles(adminNotes), ['Alpha note of Bob', 'Alpha private note']);
  assert.ok(adminNotes.body.data.every((n) => n.staffNote === 'flagged'), 'visibleTo fields follow the caller');
  assert.equal(adminNotes.body.meta.estimatedTotalHits, undefined, 'no hit count that would include hidden records');
});

test('search-meilisearch: pages are filled with readable records', async () => {
  for (let i = 0; i < 4; i++) await t.post('/posts', { title: `Beta hidden ${i}`, body: 'x', status: 'draft' }, alice);
  for (let i = 0; i < 3; i++) await t.post('/posts', { title: `Beta visible ${i}`, body: 'x', status: 'published' }, alice);
  await settle();
  const first = await t.get('/posts/search?q=beta&limit=2', bob);
  assert.deepEqual(first.body.data.map((p) => p.title), ['Beta visible 0', 'Beta visible 1'], 'drafts in between are skipped');
  assert.equal(first.body.meta.limit, 2);
  const next = await t.get(`/posts/search?q=beta&limit=2&offset=${first.body.meta.nextOffset}`, bob);
  assert.deepEqual(next.body.data.map((p) => p.title), ['Beta visible 2']);
  assert.equal(next.body.meta.nextOffset, null);
  assert.equal((await t.get('/posts/search?q=beta&limit=500', bob)).body.meta.limit, 50, 'maxSearchLimit caps the page');
  assert.equal((await t.get(`/posts/search?q=${'x'.repeat(201)}`)).status, 400);
});
