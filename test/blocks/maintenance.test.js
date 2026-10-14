import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
let admin;
let alice;
let ipRules;

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'maintenance', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({ blocks: { maintenance: { cacheMs: 60_000 } } });
  ipRules = await project.load('app/blocks/maintenance/index.js');
  admin = await t.signup({ roles: ['user', 'admin'], password: 'correct-horse-battery' });
  alice = await t.signup({ password: 'quiet-meadow-41' });
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const set = (body) => t.patch('/admin/maintenance', body, admin);
const off = () => set({ mode: 'off', message: null, allowIps: [] });

test('off by default; only admins switch it', async () => {
  assert.equal((await t.get('/posts')).status, 200);
  const status = await t.get('/maintenance');
  assert.equal(status.body.data.mode, 'off');
  assert.equal(status.headers.get('cache-control'), 'no-store');
  assert.equal((await t.patch('/admin/maintenance', { mode: 'maintenance' }, alice)).status, 403);
  assert.equal((await t.patch('/admin/maintenance', { mode: 'maintenance' })).status, 401);
  assert.equal((await set({ mode: 'nope' })).status, 422);
  assert.equal((await set({ allowIps: ['not an ip'] })).status, 422);
  assert.equal((await set({ until: '2001-01-01T00:00:00Z' })).status, 422);
});

test('maintenance: 503 with Retry-After for everyone but admins, health and sign-in stay open', async () => {
  const res = await set({ mode: 'maintenance', message: 'Upgrading the database' });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.mode, 'maintenance');

  const anon = await t.get('/posts');
  assert.equal(anon.status, 503);
  assert.equal(anon.body.error.code, 'MAINTENANCE');
  assert.equal(anon.body.error.message, 'Upgrading the database');
  assert.equal(anon.headers.get('retry-after'), '300');
  assert.equal((await t.get('/posts', alice)).status, 503);
  assert.equal((await t.post('/posts', { title: 'x', body: 'y' }, alice)).status, 503);

  assert.equal((await t.get('/posts', admin)).status, 200, 'admins pass');
  assert.equal((await t.get('/health/live')).status, 200);
  assert.equal((await t.get('/health/ready')).status, 200);
  const status = await t.get('/maintenance');
  assert.equal(status.status, 200);
  assert.equal(status.body.data.mode, 'maintenance');
  assert.equal(status.body.data.retryAfterSeconds, 300);

  const login = await t.post('/auth/login', { email: admin.email, password: 'correct-horse-battery' });
  assert.equal(login.status, 200, 'admins can still sign in');
  assert.equal((await t.get('/posts', login.body.data.token)).status, 200);

  await set({ retryAfterSeconds: 42, message: null });
  const again = await t.get('/posts');
  assert.equal(again.headers.get('retry-after'), '42');
  assert.match(again.body.error.message, /maintenance/, 'the default message');
  await off();
  assert.equal((await t.get('/posts')).status, 200);
});

test('read-only: reads work, writes answer 503 READ_ONLY', async () => {
  await set({ mode: 'read-only' });
  assert.equal((await t.get('/posts')).status, 200);
  assert.equal((await t.get('/auth/me', alice)).status, 200);
  const write = await t.post('/posts', { title: 'x', body: 'y' }, alice);
  assert.equal(write.status, 503);
  assert.equal(write.body.error.code, 'READ_ONLY');
  assert.ok(Number(write.headers.get('retry-after')) > 0);
  assert.equal((await t.patch('/auth/me', { name: 'New' }, alice)).status, 503);
  assert.equal((await t.post('/posts', { title: 'x', body: 'y' }, admin)).status, 201, 'admins can still write');
  await off();
  assert.equal((await t.post('/posts', { title: 'x', body: 'y' }, alice)).status, 201);
});

test('allowlisted IPs pass; IP rules match exact addresses and IPv4 ranges', async () => {
  await set({ mode: 'maintenance', allowIps: ['127.0.0.0/8'] });
  assert.equal((await t.get('/posts')).status, 200, 'the test client is 127.0.0.1');
  await set({ allowIps: ['10.0.0.1'] });
  assert.equal((await t.get('/posts')).status, 503);
  await off();

  const { ipMatches } = ipRules;
  assert.ok(ipMatches('::ffff:127.0.0.1', '127.0.0.1'));
  assert.ok(ipMatches('192.168.1.77', '192.168.0.0/16'));
  assert.ok(!ipMatches('192.169.1.77', '192.168.0.0/16'));
  assert.ok(ipMatches('8.8.8.8', '0.0.0.0/0'));
  assert.ok(ipMatches('2001:db8::1', '2001:db8::1'));
  assert.ok(!ipMatches('2001:db8::1', '2001:db8::/32'), 'IPv6 ranges are not supported, so they match nothing');
});

test('until ends a manual switch on its own', async () => {
  await set({ mode: 'maintenance', until: new Date(Date.now() + 1500).toISOString() });
  const res = await t.get('/posts');
  assert.equal(res.status, 503);
  assert.ok(Number(res.headers.get('retry-after')) <= 2, 'Retry-After is the time left');
  await new Promise((r) => setTimeout(r, 1600));
  assert.equal((await t.get('/posts')).status, 200);
  await off();
});

test('scheduled windows start and end on time, and are listed for banners', async () => {
  const now = Date.now();
  const soon = await t.post('/admin/maintenance/windows', { start: new Date(now + 3_600_000).toISOString(), end: new Date(now + 7_200_000).toISOString(), mode: 'read-only', message: 'Planned upgrade' }, admin);
  assert.equal(soon.status, 201, JSON.stringify(soon.body));
  assert.equal((await t.get('/posts')).status, 200, 'not started yet');
  const banner = (await t.get('/maintenance')).body.data;
  assert.equal(banner.mode, 'off');
  assert.equal(banner.upcoming.length, 1);
  assert.equal(banner.upcoming[0].message, 'Planned upgrade');

  const active = await t.post('/admin/maintenance/windows', { start: new Date(now - 1000).toISOString(), end: new Date(now + 60_000).toISOString() }, admin);
  const res = await t.get('/posts');
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'MAINTENANCE');
  const left = Number(res.headers.get('retry-after'));
  assert.ok(left > 50 && left <= 60, `Retry-After until the end of the window (${left})`);

  const id = active.body.data.windows.find((w) => w.mode === 'maintenance').id;
  assert.equal((await t.delete(`/admin/maintenance/windows/${id}`, admin)).status, 204);
  assert.equal((await t.get('/posts')).status, 200);
  assert.equal((await t.delete(`/admin/maintenance/windows/${id}`, admin)).status, 404);
  assert.equal((await t.post('/admin/maintenance/windows', { start: new Date(now + 2000).toISOString(), end: new Date(now + 1000).toISOString() }, admin)).status, 422);
  assert.equal((await t.post('/admin/maintenance/windows', { start: new Date(now).toISOString(), end: new Date(now + 1000).toISOString() }, alice)).status, 403);
});

test('MAINTENANCE_MODE forces a mode without the database', async () => {
  process.env.MAINTENANCE_MODE = 'read-only';
  try {
    assert.equal((await t.post('/posts', { title: 'x', body: 'y' }, alice)).body.error?.code, 'READ_ONLY');
    assert.equal((await t.get('/posts')).status, 200);
    assert.equal((await t.get('/admin/maintenance', admin)).body.data.source, 'env');
    assert.ok((await t.app.doctor()).some((f) => f.id === 'maintenance-forced'));
  } finally {
    delete process.env.MAINTENANCE_MODE;
  }
  assert.equal((await t.post('/posts', { title: 'x', body: 'y' }, alice)).status, 201);
  assert.deepEqual((await t.app.doctor()).filter((f) => f.level === 'error'), []);
});

test('every instance follows the state stored in MongoDB within cacheMs (runs last)', async () => {
  const other = await project.testApp({ db: { uri: t.app.config.db.uri }, blocks: { maintenance: { cacheMs: 200 } } });
  try {
    assert.equal((await other.get('/posts')).status, 200);
    await set({ mode: 'maintenance' });
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await other.get('/posts')).status, 503, 'the other instance picked it up');
    await off();
    await new Promise((r) => setTimeout(r, 250));
    assert.equal((await other.get('/posts')).status, 200);
  } finally {
    await other.close(); // drops the shared database: this test runs last
  }
});
