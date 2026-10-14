import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject } from '../helpers.js';

let project;
let t;
const devtools = (path, init = {}) =>
  fetch(`${t.origin}/_calm/api${path}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });

before(async () => {
  project = await makeProject();
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('records requests with their Mongo queries, errors and redacted secrets', async () => {
  const u = await t.signup({ password: 'super-secret-pw' });
  const created = await t.post('/posts', { title: 'Traced', body: 'x' }, u);
  await t.get('/posts/not-an-id', u);

  const list = await (await devtools('/requests')).json();
  const createReq = list.find((r) => r.method === 'POST' && r.path === '/api/posts');
  assert.ok(createReq, 'request summary recorded');
  assert.equal(createReq.status, 201);
  assert.equal(createReq.user.id, u.id);
  assert.ok(createReq.queries >= 2, 'queries attributed to the request');

  const detail = await (await devtools(`/requests/${createReq.id}`)).json();
  assert.ok(detail.queries.some((q) => q.command === 'insert' && q.collection === 'posts'));
  assert.ok(detail.queries.every((q) => q.durationMs !== null));
  assert.equal(detail.responseBody.data.id, created.body.data.id);
  assert.match(detail.requestHeaders.authorization, /…/, 'token is shortened');

  const register = list.find((r) => r.path === '/api/auth/register');
  const regDetail = await (await devtools(`/requests/${register.id}`)).json();
  assert.equal(regDetail.requestBody.password, '[redacted]');

  const find = detail.queries.find((q) => q.command === 'find');
  const plan = await (await devtools(`/queries/${find.id}/explain`, { method: 'POST', headers: { 'x-calm-devtools': '1' } })).json();
  assert.ok(Array.isArray(plan.stages) && plan.stages.length);
});

test('overview, data lens, mails and act-as', async () => {
  const overview = await (await devtools('/overview')).json();
  assert.deepEqual(overview.resources.map((r) => r.name).sort(), ['post', 'user']);
  assert.ok(overview.routes.some((r) => r.path === '/api/posts/:id/publish' && r.policy === 'owner | admin'));

  const lens = await (await devtools('/resources/user/docs')).json();
  const first = lens.items[0];
  assert.match(first.stored.password, /scrypt hash/);
  assert.ok(first.notReturned.includes('password'));
  assert.ok(first.notReturned.includes('email'), 'email is private to anonymous viewers');

  const u = await t.signup();
  await t.post('/auth/password/forgot', { email: u.email });
  await t.idle();
  const mails = await (await devtools('/mails')).json();
  assert.equal(mails[0].to, u.email);
  assert.match(mails[0].text, /reset-password\?token=reset_/);

  const denied = await devtools('/act-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
  assert.equal(denied.status, 403, 'writes need the devtools header');
  const acted = await (await devtools('/act-as', { method: 'POST', headers: { 'content-type': 'application/json', 'x-calm-devtools': '1' }, body: JSON.stringify({ userId: u.id }) })).json();
  assert.equal((await t.get('/auth/me', acted.token)).body.data.id, u.id);
});

// fetch() refuses to set Host, so use node:http for the DNS rebinding case.
const rawStatus = (path, headers) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(`${t.origin}${path}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

test('only reachable from this machine', async () => {
  assert.equal(await rawStatus('/_calm/api/overview', { host: 'localhost:5001' }), 200);
  assert.equal(await rawStatus('/_calm/api/overview', { host: 'evil.example.com' }), 404, 'DNS rebinding blocked');
  assert.equal((await devtools('/overview', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 404, 'proxied requests blocked');
  const res = await devtools('/overview', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS on devtools');
});

test('proposals: list, read, apply once, refuse paths outside the project', async () => {
  const dir = join(project.dir, '.calm', 'proposals');
  mkdirSync(dir, { recursive: true });
  const proposal = (id, files) => writeFileSync(join(dir, `${id}.json`), JSON.stringify({ id, title: `Proposal ${id}`, reason: 'because', client: 'claude-code', createdAt: new Date().toISOString(), files }));
  const diff = { added: 1, removed: 0, hunks: [{ oldStart: 1, newStart: 1, lines: ['+hello'] }], truncated: false };
  proposal('abc123', [{ path: 'app/notes.txt', diff, content: 'hello\n' }, { path: 'app/deep/er/file.txt', diff, content: 'deep\n' }]);
  proposal('bad001', [{ path: '../outside.txt', diff, content: 'x' }]);
  proposal('bad002', [{ path: 'node_modules/express/index.js', diff, content: 'x' }]);

  const list = await (await devtools('/proposals')).json();
  const mine = list.find((p) => p.id === 'abc123');
  assert.deepEqual(mine.files, ['app/notes.txt', 'app/deep/er/file.txt'], 'summaries carry paths only');
  assert.equal(mine.content, undefined);
  const full = await (await devtools('/proposals/abc123')).json();
  assert.equal(full.files[0].content, 'hello\n');
  assert.equal((await devtools('/proposals/nope')).status, 404);
  assert.equal((await devtools('/proposals/../../package')).status, 404);

  const apply = (id) => devtools(`/proposals/${id}/apply`, { method: 'POST', headers: { 'x-calm-devtools': '1' } });
  assert.equal((await devtools('/proposals/abc123/apply', { method: 'POST' })).status, 403, 'writes need the devtools header');
  const res = await apply('abc123');
  assert.equal(res.status, 200);
  const out = await res.json();
  assert.deepEqual(out.applied, ['app/notes.txt', 'app/deep/er/file.txt']);
  assert.equal(readFileSync(join(project.dir, 'app/notes.txt'), 'utf8'), 'hello\n');
  assert.equal(readFileSync(join(project.dir, 'app/deep/er/file.txt'), 'utf8'), 'deep\n');
  assert.ok(JSON.parse(readFileSync(join(dir, 'abc123.json'), 'utf8')).appliedAt, 'marked as applied');
  assert.equal((await apply('abc123')).status, 409, 'applied once');

  const activity = await (await devtools('/activity')).json();
  const event = activity.find((e) => e.type === 'file' && e.path === 'app/notes.txt');
  assert.equal(event.change, 'added');
  assert.deepEqual(event.actor, { kind: 'human', name: 'devtools' });
  assert.equal(event.note, 'applied proposal abc123');
  assert.deepEqual(event.diff, diff);
  assert.match(readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8'), /applied proposal abc123/);

  assert.equal((await apply('bad001')).status, 400);
  assert.ok(!existsSync(join(project.dir, '..', 'outside.txt')));
  assert.equal((await apply('bad002')).status, 400);
});

test('overview.agentSession: the live MCP session, if its server is still running', async () => {
  const file = join(project.dir, '.calm', 'agent-session.json');
  mkdirSync(join(project.dir, '.calm'), { recursive: true });
  try {
    writeFileSync(file, JSON.stringify({ client: 'claude-code', scope: 'scaffold', allow: [], protected: ['calm/auth/**'], startedAt: new Date().toISOString(), pid: process.pid }));
    const live = await (await devtools('/overview')).json();
    assert.equal(live.agentSession.client, 'claude-code');
    assert.equal(live.agentSession.scope, 'scaffold');
    assert.deepEqual(live.agentSession.protected, ['calm/auth/**']);
    writeFileSync(file, JSON.stringify({ client: 'gone', scope: 'full', pid: 2 ** 22 - 1 }));
    assert.equal((await (await devtools('/overview')).json()).agentSession, null, 'a stale file is not a session');
  } finally {
    rmSync(file, { force: true });
  }
  assert.equal((await (await devtools('/overview')).json()).agentSession, null);
});

test('never enabled in production', async () => {
  const prod = await project.load('calm/config.js');
  const cfg = await prod.loadConfig(project.dir, { mode: 'production', devtools: { enabled: true }, db: { uri: 'mongodb://x' } }).catch((e) => e);
  // production also requires APP_URL; either way devtools must not be on
  assert.ok(cfg instanceof Error || cfg.devtools.enabled === false);
});
