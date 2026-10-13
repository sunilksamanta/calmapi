import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject } from '../helpers.js';
import { shapeOf, compareShapes } from '../../core/replay.js';

let project;
let t;
const api = (path, init = {}) => fetch(`${t.origin}/_calm/api${path}`, { ...init, headers: { host: 'localhost', 'x-calm-devtools': '1', 'content-type': 'application/json', ...(init.headers ?? {}) } });
const settle = () => new Promise((r) => setTimeout(r, 40));
let alice;
let post;

before(async () => {
  project = await makeProject();
  t = await project.testApp({ devtools: { enabled: true } });
  alice = await t.signup({ name: 'Alice' });
  post = (await t.post('/posts', { title: 'Hello', body: 'World', status: 'published' }, alice)).body.data;
  await t.get('/posts');
  await t.get(`/posts/${post.id}`, alice);
  await t.get('/auth/me', alice);
  await settle();
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('API traffic is recorded as shapes, never values, and secrets are redacted', () => {
  const lines = readFileSync(join(project.dir, '.calm', 'traffic.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const register = lines.find((l) => l.path === '/api/auth/register');
  assert.equal(register.body.password, '[redacted]');
  const read = lines.find((l) => l.method === 'GET' && l.path === `/api/posts/${post.id}`);
  assert.equal(read.status, 200);
  assert.equal(read.user.id, alice.id);
  assert.equal(read.shape.object.data.object.title, 'string');
  assert.doesNotMatch(JSON.stringify(read), /Hello/, 'no values in the traffic log');
});

test('replay: identical when nothing changed, and reports what changed', async () => {
  const first = await (await api('/replay', { method: 'POST', body: JSON.stringify({}) })).json();
  assert.equal(first.total, 3, 'reads only by default');
  assert.equal(first.identical, 3, JSON.stringify(first.changed));

  await t.app.model('post').deleteOne({ _id: post.id });
  const second = await (await api('/replay', { method: 'POST', body: JSON.stringify({}) })).json();
  const list = second.changed.find((c) => c.request === 'GET /api/posts');
  assert.ok(list.differences.some((d) => d.text === 'body.data: 1 -> 0 items'), JSON.stringify(list));
  const one = second.changed.find((c) => c.request.startsWith('GET /api/posts/'));
  assert.ok(one.differences.some((d) => d.text === 'status 200 -> 404'));
  const sessions = await t.app.auth.service.Session.countDocuments();
  assert.equal(sessions, 1, 'replay sessions are removed afterwards (only Alice remains)');
});

test('replay --writes runs between a checkpoint and its restore', async () => {
  const before = await t.app.model('post').countDocuments();
  const report = await (await api('/replay', { method: 'POST', body: JSON.stringify({ writes: true }) })).json();
  assert.ok(report.checkpoint, 'a checkpoint was taken');
  assert.ok(report.skipped.some((s) => /secret values/.test(s.reason)), 'the register body had a redacted password');
  assert.equal(await t.app.model('post').countDocuments(), before, 'data is restored');
});

test('a recorded request becomes a test that passes', async () => {
  const fresh = (await t.post('/posts', { title: 'Again', body: 'x', status: 'published' }, alice)).body.data;
  const res = await t.get(`/posts/${fresh.id}`, alice);
  await settle();
  const list = await (await api('/requests')).json();
  const rec = list.find((r) => r.path === `/api/posts/${fresh.id}` && r.method === 'GET' && r.id === res.headers.get('x-request-id'));
  const out = await api(`/requests/${rec.id}/test`, { method: 'POST', body: '{}' });
  assert.equal(out.status, 201);
  const { file } = await out.json();
  assert.match(file, /^test\/recorded\/get-posts-id-user-200\.test\.js$/);
  assert.ok(existsSync(join(project.dir, file)));
  // Dates are recorded as the client sees them (strings), not walked into empty objects.
  const detail = await (await api(`/requests/${rec.id}`)).json();
  assert.equal(typeof detail.responseBody.data.createdAt, 'string');
  assert.match(readFileSync(join(project.dir, file), 'utf8'), /"createdAt":"string"/);
  const { NODE_TEST_CONTEXT: _c, ...env } = process.env;
  const result = execFileSync(process.execPath, ['--test', '--test-reporter=tap', file], { cwd: project.dir, env: { ...env, MONGODB_TEST_URI: process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017' }, encoding: 'utf8' });
  assert.match(result, /# pass 1/);
  const again = await (await api(`/requests/${rec.id}/test`, { method: 'POST', body: '{}' })).json();
  assert.match(again.file, /-2\.test\.js$/, 'an existing file is never overwritten');
});

test('shape comparison', () => {
  const a = shapeOf({ data: [{ id: 'x', title: 't' }], meta: { total: 1 } });
  const b = shapeOf({ data: [{ id: 'x', title: 't', email: 'e' }, { id: 'y', title: 'u' }], meta: { total: '2' } });
  assert.deepEqual(compareShapes(a, b).map((d) => d.text), ['body.data: 1 -> 2 items', 'body.data[].email: newly returned', 'body.meta.total: number -> string']);
  assert.deepEqual(compareShapes(a, a), []);
});
