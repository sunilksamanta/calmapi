import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
let keys;
const events = [];

// App routes without a resource, to check implied scopes (/api/whoami -> whoami:read) and
// a custom scope from options.routeScopes.
const files = {
  'app/routes.js': `export default (r) => {
  r.get('/whoami', { policy: 'authenticated', summary: 'Who is calling' }, (ctx) => ({ id: ctx.user.id, auth: ctx.auth }));
  r.get('/reports', { policy: 'authenticated', summary: 'Reports' }, () => ({ rows: [] }));
  r.post('/reports/export', { policy: 'authenticated', summary: 'Export a report' }, () => ({ exported: true }));
};
`,
};
const config = { blocks: { 'api-keys': { routeScopes: { 'POST /api/reports/export': 'reports:export' } } } };

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'api-keys', 'mcp-server', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp(config);
  t.app.events.on('security.invalid_api_key', (payload) => events.push(payload));
  keys = await project.load('app/blocks/api-keys/keys.js');
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

/** Create a key from a signed-in session and return the full key string. */
async function newKey(user, body = {}) {
  const res = await t.post('/auth/api-keys', { name: 'Test key', ...body }, user);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.key;
}

test('create: the key is shown once, stored as a hash, never listed', async () => {
  const u = await t.signup();
  const res = await t.post('/auth/api-keys', { name: 'CI deploy', scopes: ['posts:read'] }, u);
  assert.equal(res.status, 201);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const { key, prefix, scopes, expiresAt, id } = res.body.data;
  assert.match(key, /^calm_ak_[0-9A-Za-z]{38}$/);
  assert.equal(prefix, key.slice(0, 14));
  assert.deepEqual(scopes, ['posts:read']);
  const days = (new Date(expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 89.9 && days <= 90, 'expires in 90 days by default');

  const raw = await t.app.mongoose.connection.collection('calm_api_keys').findOne({ prefix });
  assert.match(raw.tokenHash, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(raw).includes(key.slice(14)), 'the secret part is not stored');

  const list = await t.get('/auth/api-keys', u);
  assert.equal(list.status, 200);
  assert.ok(!JSON.stringify(list.body).includes(key.slice(14)), 'never shown again');
  assert.deepEqual(Object.keys(list.body.data[0]).sort(), ['createdAt', 'expiresAt', 'id', 'lastUsedAt', 'lastUsedIp', 'name', 'prefix', 'scopes', 'status']);
  assert.equal(list.body.data[0].id, id);
  assert.equal(list.body.data[0].lastUsedAt, null);

  const fresh = await newKey(u);
  assert.notEqual(fresh, key);
  const defaults = (await t.get('/auth/api-keys', u)).body.data.find((k) => fresh.startsWith(k.prefix));
  assert.deepEqual(defaults.scopes, ['read'], 'read only unless scopes are given');
});

test('authenticate: a key acts as its user, and ctx.auth says api-key', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['whoami:read'] });
  const res = await t.get('/whoami', key);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.id, u.id);
  assert.equal(res.body.data.auth.via, 'api-key');
  assert.deepEqual(res.body.data.auth.scopes, ['whoami:read']);
  assert.match(res.body.data.auth.id, /^[a-f0-9]{24}$/);
  assert.equal((await t.get('/auth/me', key)).body.data.id, u.id, 'any key may ask who it acts as');
  assert.equal((await t.get('/whoami', u)).body.data.auth.via, 'session', 'sessions are unchanged');

  // Service keys from a script or seed.
  const seeded = await t.app.ext.apiKeys.create(u.id, { name: 'Seed', scopes: ['whoami:read'] });
  assert.equal((await t.get('/whoami', seeded.key)).body.data.id, u.id);
  await assert.rejects(t.app.ext.apiKeys.create(u.id, { name: 'Bad', scopes: ['nope:read'] }), /Validation failed/);
});

test('scopes: read-only keys cannot write, posts:write can, other areas are closed', async () => {
  const u = await t.signup();
  const readOnly = await newKey(u, { scopes: ['read'] });
  const postsRead = await newKey(u, { scopes: ['posts:read'] });
  const postsWrite = await newKey(u, { scopes: ['posts:write'] });
  const post = { title: 'Hello', body: 'From a script' };

  assert.equal((await t.get('/posts', readOnly)).status, 200);
  assert.equal((await t.get('/posts', postsRead)).status, 200);
  const denied = await t.post('/posts', post, readOnly);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /"posts:write" scope/);
  assert.equal((await t.post('/posts', post, postsRead)).status, 403);

  const created = await t.post('/posts', post, postsWrite);
  assert.equal(created.status, 201);
  assert.equal(created.body.data.author, u.id, 'owned by the key user');
  assert.equal((await t.post(`/posts/${created.body.data.id}/publish`, {}, postsWrite)).status, 200, 'custom resource routes use the same area');
  assert.equal((await t.get('/posts', postsWrite)).status, 403, 'write does not include read');
  assert.equal((await t.get('/whoami', postsRead)).status, 403, 'other areas need their own scope');

  const both = await newKey(u, { scopes: ['posts:*'] });
  assert.equal((await t.get('/posts', both)).status, 200);
  assert.equal((await t.patch(`/posts/${created.body.data.id}`, { title: 'Edited' }, both)).status, 200);
});

test('custom route scopes from options.routeScopes', async () => {
  const u = await t.signup();
  const reportsRead = await newKey(u, { scopes: ['reports:read'] });
  const exporter = await newKey(u, { scopes: ['reports:export'] });
  const reportsAll = await newKey(u, { scopes: ['reports:*'] });
  const readAll = await newKey(u, { scopes: ['read'] });

  assert.equal((await t.get('/reports', reportsRead)).status, 200);
  const denied = await t.post('/reports/export', {}, reportsRead);
  assert.equal(denied.status, 403);
  assert.match(denied.body.error.message, /"reports:export" scope/);
  assert.equal((await t.post('/reports/export', {}, exporter)).status, 200);
  assert.equal((await t.get('/reports', exporter)).status, 403);
  assert.equal((await t.post('/reports/export', {}, reportsAll)).status, 200);
  assert.equal((await t.get('/reports', reportsAll)).status, 200);
  assert.equal((await t.get('/reports', readAll)).status, 200);
});

test('scopes are validated at creation, with the list of valid ones', async () => {
  const u = await t.signup();
  const bad = await t.post('/auth/api-keys', { name: 'Typo', scopes: ['post:read', 'posts:read'] }, u);
  assert.equal(bad.status, 422);
  assert.match(bad.body.error.details.scopes, /Unknown scope "post:read"/);
  assert.match(bad.body.error.details.scopes, /posts:read/);
  assert.equal((await t.post('/auth/api-keys', { name: 'Empty', scopes: [] }, u)).status, 422);

  const catalog = (await t.get('/auth/api-keys/scopes', u)).body.data.map((s) => s.scope);
  for (const scope of ['*', 'read', 'posts:read', 'posts:write', 'posts:*', 'users:read', 'reports:read', 'reports:export', 'whoami:read']) {
    assert.ok(catalog.includes(scope), scope);
  }
  assert.ok(!catalog.some((s) => s.startsWith('auth:') || s.startsWith('admin:')), 'key management is never a scope');

  const wildcard = await t.post('/auth/api-keys', { name: 'All', scopes: ['*', 'posts:read'] }, u);
  assert.deepEqual(wildcard.body.data.scopes, ['*']);
});

test('policies still apply: a key never does more than its user', async () => {
  const u = await t.signup();
  const admin = await t.signup({ roles: ['user', 'admin'] });
  const userKey = await newKey(u, { scopes: ['*'] });
  const adminKey = await newKey(admin, { scopes: ['*'] });
  assert.equal((await t.get('/users', userKey)).status, 403, 'only admins list users');
  assert.equal((await t.get('/users', adminKey)).status, 200);
  assert.equal((await t.get('/admin/api-keys', userKey)).status, 403);
  assert.equal((await t.get('/admin/api-keys', adminKey)).status, 403, 'even admin keys cannot manage keys');
  const res = await t.patch(`/users/${u.id}`, { roles: ['user', 'admin'] }, userKey);
  assert.equal(res.status, 422, 'field rules apply too');
});

test('API keys cannot manage keys, passwords or sessions', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['*'] });
  const id = (await t.get('/auth/api-keys', u)).body.data[0].id;
  const refused = await t.post('/auth/api-keys', { name: 'Another' }, key);
  assert.equal(refused.status, 403);
  assert.match(refused.body.error.message, /cannot manage API keys/);
  assert.equal((await t.get('/auth/api-keys', key)).status, 403);
  assert.equal((await t.delete(`/auth/api-keys/${id}`, key)).status, 403);
  assert.equal((await t.post('/auth/password', { currentPassword: u.password, newPassword: 'another-long-phrase-9' }, key)).status, 403);
  assert.equal((await t.get('/auth/sessions', key)).status, 403);
  assert.equal((await t.post('/auth/logout-all', {}, key)).status, 403);
  assert.equal((await t.patch('/auth/me', { name: 'Renamed' }, key)).status, 403);
  assert.equal((await t.get('/auth/me', key)).status, 200);
  assert.equal((await t.get('/auth/me', u)).status, 200, 'the session still works');
});

test('expired and revoked keys get 401', async () => {
  const u = await t.signup();
  const admin = await t.signup({ roles: ['user', 'admin'] });
  const Keys = t.app.ext.apiKeys.model;

  const expiring = await newKey(u, { scopes: ['read'], expiresInDays: 1 });
  assert.equal((await t.get('/posts', expiring)).status, 200);
  await Keys.updateOne({ prefix: expiring.slice(0, 14) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  events.length = 0;
  assert.equal((await t.get('/posts', expiring)).status, 401);
  assert.equal(events.at(-1)?.reason, 'expired');
  assert.ok(!JSON.stringify(events).includes(expiring.slice(14)), 'events never contain the key');
  assert.equal((await t.get('/auth/api-keys', u)).body.data.find((k) => k.prefix === expiring.slice(0, 14)).status, 'expired');

  const revoked = await newKey(u);
  const id = (await t.get('/auth/api-keys', u)).body.data.find((k) => k.prefix === revoked.slice(0, 14)).id;
  const other = await t.signup();
  assert.equal((await t.delete(`/auth/api-keys/${id}`, other)).status, 404, 'only the owner can revoke');
  assert.equal((await t.delete(`/auth/api-keys/${id}`, u)).status, 204);
  assert.equal((await t.get('/posts', revoked)).status, 401);
  assert.equal(events.at(-1)?.reason, 'revoked');
  assert.ok(!(await t.get('/auth/api-keys', u)).body.data.some((k) => k.id === id), 'revoked keys leave the list');

  const third = await newKey(u);
  const all = await t.get(`/admin/api-keys?user=${u.id}`, admin);
  assert.equal(all.status, 200);
  const row = all.body.data.find((k) => k.prefix === third.slice(0, 14));
  assert.equal(row.owner.email, u.email);
  assert.equal(all.body.data.find((k) => k.id === id).status, 'revoked', 'admins see revoked keys');
  assert.equal((await t.delete(`/admin/api-keys/${row.id}`, admin)).status, 204);
  assert.equal((await t.get('/posts', third)).status, 401);
  assert.equal((await t.delete(`/admin/api-keys/${row.id}`, u)).status, 403, 'admin routes need the admin role');
});

test('typos are caught by the checksum; unknown keys are refused', async () => {
  const u = await t.signup();
  const key = await newKey(u);
  const i = 20;
  const typo = key.slice(0, i) + (key[i] === 'a' ? 'b' : 'a') + key.slice(i + 1);
  assert.ok(keys.isKeyShaped(typo) && !keys.hasValidChecksum(typo));
  events.length = 0;
  const res = await t.get('/posts', typo);
  assert.equal(res.status, 401);
  assert.match(res.body.error.message, /copied completely/);
  assert.equal(events.at(-1)?.reason, 'checksum');

  const unknown = keys.generateKey();
  assert.ok(keys.hasValidChecksum(unknown));
  assert.equal((await t.get('/posts', unknown)).status, 401);
  assert.deepEqual(Object.keys(events.at(-1)).sort(), ['ip', 'path', 'reason']);
  assert.equal(events.at(-1).reason, 'unknown');
  assert.equal((await t.get('/posts', u)).status, 200, 'session tokens are not affected');
});

test('lastUsedAt and lastUsedIp are written at most once a minute', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['read'] });
  const mine = async () => (await t.get('/auth/api-keys', u)).body.data.find((k) => k.prefix === key.slice(0, 14));
  assert.equal((await mine()).lastUsedAt, null);

  await t.get('/posts', key);
  await t.idle();
  const first = await mine();
  assert.ok(first.lastUsedAt);
  assert.ok(first.lastUsedIp);

  await t.get('/posts', key);
  await t.idle();
  assert.equal((await mine()).lastUsedAt, first.lastUsedAt, 'not rewritten within a minute');

  await t.app.ext.apiKeys.model.updateOne({ prefix: key.slice(0, 14) }, { $set: { lastUsedAt: new Date(Date.now() - 2 * 60_000) } });
  await t.get('/posts', key);
  await t.idle();
  assert.ok(new Date((await mine()).lastUsedAt) > Date.now() - 60_000, 'written again after a minute');
});

test("a disabled user's keys are refused", async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['read'] });
  assert.equal((await t.get('/posts', key)).status, 200);
  await t.app.model('user').updateOne({ _id: u.id }, { $set: { status: 'disabled' } });
  events.length = 0;
  assert.equal((await t.get('/posts', key)).status, 401);
  assert.equal(events.at(-1)?.reason, 'user_disabled');
});

test('limits: maximum lifetime, expiry required by default', async () => {
  const u = await t.signup();
  assert.equal((await t.post('/auth/api-keys', { name: 'Long', expiresInDays: 400 }, u)).status, 422);
  const forever = await t.post('/auth/api-keys', { name: 'Forever', expiresInDays: null }, u);
  assert.equal(forever.status, 422);
  assert.match(forever.body.error.details.expiresInDays, /must expire/);
  assert.equal((await t.post('/auth/api-keys', { name: 'Year', expiresInDays: 365 }, u)).status, 201);
});

test('a password reset revokes every key of that user', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['read'] });
  await t.post('/auth/password/forgot', { email: u.email });
  await t.idle();
  const token = t.mails.findLast((m) => m.to === u.email)?.meta?.token;
  assert.ok(token);
  assert.equal((await t.post('/auth/password/reset', { token, password: 'brand-new-phrase-42' })).status, 204);
  await t.idle();
  assert.equal((await t.get('/posts', key)).status, 401);
});

test('MCP tool calls are held to the same scopes', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['posts:read'] });
  const call = async (name, args) => {
    const res = await fetch(`${t.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    });
    return (await res.json()).result;
  };
  assert.equal((await call('post_list', {})).isError, false);
  const denied = await call('post_create', { data: { title: 'Agent', body: 'Should not work' } });
  assert.equal(denied.isError, true);
  assert.match(denied.content[0].text, /posts:write/);
});

test('devtools panel and doctor', async () => {
  const u = await t.signup();
  const key = await newKey(u, { scopes: ['posts:read'] });
  const panel = await t.app.hooks.devtools['api-keys'](t.app);
  const row = panel.keys.find((k) => k.prefix.startsWith(key.slice(0, 14)));
  assert.equal(row.owner, u.email);
  assert.equal(row.scopes, 'posts:read');
  assert.ok('lastUsedAt' in row);
  assert.ok(!JSON.stringify(panel).includes(key.slice(14)));
  assert.ok(!JSON.stringify(panel).includes('tokenHash'));

  const findings = await t.app.doctor();
  assert.match(findings.find((f) => f.id === 'api-keys-count')?.title ?? '', /active API key/);
  assert.equal(findings.find((f) => f.id === 'api-keys-everything-forever'), undefined, 'keys expire by default');
});

test('options: no-expiry keys when allowed, per-user limit, doctor warning', async () => {
  const t2 = await project.testApp({ blocks: { 'api-keys': { allowNoExpiry: true, maxKeysPerUser: 2 } } });
  try {
    const u = await t2.signup();
    const forever = await t2.post('/auth/api-keys', { name: 'Forever', scopes: ['*'], expiresInDays: null }, u);
    assert.equal(forever.status, 201);
    assert.equal(forever.body.data.expiresAt, null);
    assert.equal((await t2.post('/auth/api-keys', { name: 'Second' }, u)).status, 201);
    const third = await t2.post('/auth/api-keys', { name: 'Third' }, u);
    assert.equal(third.status, 409);
    assert.equal(third.body.error.code, 'API_KEY_LIMIT');

    await t2.idle();
    const warn = (await t2.app.doctor()).find((f) => f.id === 'api-keys-everything-forever');
    assert.equal(warn?.level, 'warn');
  } finally {
    await t2.close();
  }
});
