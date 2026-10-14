import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
const devtools = (path, init = {}) => fetch(`${t.origin}/_calm/api${path}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
const write = (path, method, body) =>
  devtools(path, { method, headers: { 'x-calm-devtools': '1', ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  project = await makeProject();
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

const activity = () =>
  readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
    .filter((e) => e.type === 'checkpoint');

test('create, change, restore: the data is back exactly, new collections are dropped', async () => {
  const alice = await t.signup({ name: 'Alice' });
  const post = (await t.post('/posts', { title: 'First', body: 'Hello' }, alice)).body.data;
  const Post = t.app.model('post');
  const before = await Post.findById(post.id).lean();

  const meta = await t.app.checkpoints.create({ name: 'Before Changes', note: 'try things', actor: { kind: 'agent', name: 'claude-code' } });
  assert.match(meta.id, /^\d{8}-\d{6}-before-changes$/);
  assert.equal(meta.name, 'Before Changes');
  assert.equal(meta.actor.kind, 'agent');
  assert.ok(meta.collections.some((c) => c.name === 'posts' && c.docs === 1));
  assert.ok(existsSync(join(project.dir, '.calm', 'checkpoints', meta.id, 'meta.json')));
  const line = readFileSync(join(project.dir, '.calm', 'checkpoints', meta.id, 'posts.ejson'), 'utf8').trim();
  assert.match(line, /"\$oid"/, 'canonical Extended JSON keeps ObjectIds');

  await Post.updateOne({ _id: post.id }, { $set: { title: 'Changed' } });
  await t.post('/posts', { title: 'Second', body: 'x' }, alice);
  await t.app.mongoose.connection.db.collection('scratch').insertOne({ junk: true });

  const out = await t.app.checkpoints.restore(meta.id);
  assert.deepEqual(out.dropped, ['scratch']);
  assert.equal(out.collections.find((c) => c.name === 'posts').docs, 1);
  const after = await Post.findById(post.id).lean();
  assert.deepEqual(after, before, 'same document: ObjectId references and dates included');
  assert.ok(after.author instanceof t.app.mongoose.Types.ObjectId);
  assert.ok(after.createdAt instanceof Date);
  assert.equal(await Post.countDocuments(), 1);
  const names = (await t.app.mongoose.connection.db.listCollections().toArray()).map((c) => c.name);
  assert.ok(!names.includes('scratch'));

  const log = activity();
  assert.deepEqual(log.slice(-2).map((e) => e.action), ['created', 'restored']);
  assert.equal(log.at(-2).actor.name, 'claude-code');
});

test('list newest first, delete, and ids cannot escape the folder', async () => {
  const a = await t.app.checkpoints.create({ name: 'one' });
  const b = await t.app.checkpoints.create({ name: 'one' });
  assert.notEqual(a.id, b.id, 'same second, same name: a suffix keeps them apart');
  const list = await t.app.checkpoints.list();
  assert.ok(list.findIndex((m) => m.id === b.id) <= list.findIndex((m) => m.id === a.id));
  await t.app.checkpoints.delete(a.id);
  assert.ok(!(await t.app.checkpoints.list()).some((m) => m.id === a.id));
  assert.equal(activity().at(-1).action, 'deleted');
  await assert.rejects(t.app.checkpoints.restore('../../etc'), /Invalid checkpoint id/);
  await assert.rejects(t.app.checkpoints.restore('nope'), /No checkpoint "nope"/);
});

test('refuses to run in production', async () => {
  const { createCheckpoint, restoreCheckpoint } = await project.load('calm/checkpoints.js');
  const fake = { config: { mode: 'production' }, root: project.dir };
  await assert.rejects(createCheckpoint(fake, {}), /development tool/);
  await assert.rejects(restoreCheckpoint(fake, 'x'), /development tool/);
});

test('devtools API: create, list, restore, delete; writes need the header', async () => {
  assert.equal((await devtools('/checkpoints', { method: 'POST' })).status, 403);
  const created = await write('/checkpoints', 'POST', { name: 'from devtools' });
  assert.equal(created.status, 201);
  const meta = await created.json();
  assert.equal(meta.actor.name, 'devtools');
  const list = await (await devtools('/checkpoints')).json();
  assert.equal(list[0].id, meta.id);
  const restored = await write(`/checkpoints/${meta.id}/restore`, 'POST', {});
  assert.equal(restored.status, 200);
  assert.equal((await restored.json()).id, meta.id);
  assert.equal((await write(`/checkpoints/${meta.id}`, 'DELETE')).status, 204);
  assert.equal((await write('/checkpoints/missing/restore', 'POST', {})).status, 404);
});

test('calm checkpoint and calm restore from the CLI', () => {
  const env = { ...process.env, NO_COLOR: '1', CI: '1', MONGODB_URI: t.app.config.db.uri, NODE_ENV: 'development' };
  const calm = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: project.dir, env, encoding: 'utf8' });
  const meta = JSON.parse(calm('checkpoint', 'demo', '--json'));
  assert.match(meta.id, /-demo$/);
  assert.match(calm('checkpoint', 'list'), new RegExp(meta.id));
  let refused;
  try {
    calm('restore', meta.id);
  } catch (err) {
    refused = `${err.stdout}${err.stderr}`;
  }
  assert.match(refused, /pass --yes/);
  assert.match(calm('restore', meta.id, '--yes'), /Restored/);
  assert.match(calm('checkpoint', 'delete', meta.id), /Deleted checkpoint/);
  assert.ok(!readdirSync(join(project.dir, '.calm', 'checkpoints')).includes(meta.id));
});
