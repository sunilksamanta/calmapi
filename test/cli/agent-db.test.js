import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import mongoose from 'mongoose';
import { makeProject, ROOT } from '../helpers.js';
import { agentUri, devDatabaseUri } from '../../src/cli/lib/agent-db.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = (process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017').replace(/\/$/, '');

async function waitFor(fn, timeout = 30_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error('timed out');
    await sleep(200);
  }
}

test('agentUri keeps the server and options and names the copy <db>_agent', () => {
  assert.deepEqual(agentUri('mongodb://127.0.0.1:27017/shop'), { from: 'shop', to: 'shop_agent', uri: 'mongodb://127.0.0.1:27017/shop_agent' });
  assert.equal(agentUri('mongodb+srv://u:p@cluster.example.net/shop?retryWrites=true&w=majority').uri, 'mongodb+srv://u:p@cluster.example.net/shop_agent?retryWrites=true&w=majority');
  assert.equal(agentUri('mongodb://a:1,b:2/shop?replicaSet=rs').to, 'shop_agent');
  assert.equal(agentUri('mongodb://127.0.0.1:27017').from, 'test');
  assert.throws(() => agentUri('mongodb://127.0.0.1/shop_agent'), /already points at an agent copy/);
  assert.throws(() => agentUri('not a uri'), /not a valid connection string/);
  assert.throws(() => agentUri(`mongodb://h/${'x'.repeat(60)}`), /too long/);
});

test('devDatabaseUri reads the environment first, then .env', async () => {
  const project = await makeProject();
  writeFileSync(join(project.dir, '.env'), 'PORT=1\nMONGODB_URI="mongodb://h/from_env_file"\n');
  assert.equal(devDatabaseUri(project.dir, {}), 'mongodb://h/from_env_file');
  assert.equal(devDatabaseUri(project.dir, { MONGODB_URI: 'mongodb://h/x' }), 'mongodb://h/x');
});

test('calm dev --agent-db runs on a disposable copy and leaves the real database alone', { timeout: 120_000 }, async () => {
  const project = await makeProject();
  const port = 5900 + Math.floor(Math.random() * 300);
  const db = `calm_agentdb_${Date.now()}`;
  const envFile = join(project.dir, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^PORT=.*$/m, `PORT=${port}`).replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=${BASE}/${db}`));
  const conn = await mongoose.createConnection(`${BASE}/${db}`).asPromise();
  const client = conn.getClient();
  await client.db(db).collection('notes').insertMany([{ text: 'mine' }, { text: 'also mine' }]);
  await client.db(db).collection('notes').createIndex({ text: 1 }, { name: 'text_1' });
  // A stale copy from a crashed run is replaced.
  await client.db(`${db}_agent`).collection('stale').insertOne({ x: 1 });

  const { NODE_TEST_CONTEXT: _c, MONGODB_URI: _u, ...env } = { ...process.env, NO_COLOR: '1' };
  const dev = spawn(process.execPath, [CALM, 'dev', '--agent-db'], { cwd: project.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  dev.stdout.on('data', (d) => (output += d));
  dev.stderr.on('data', (d) => (output += d));
  const exited = new Promise((r) => dev.on('exit', r));
  try {
    await waitFor(() => fetch(`http://localhost:${port}/health/ready`).then((r) => r.ok));
    assert.match(output, new RegExp(`Running on ${db}_agent, a copy of ${db} \\(1 collections, 2 documents\\)`));
    const copy = client.db(`${db}_agent`);
    assert.equal(await copy.collection('notes').countDocuments(), 2);
    assert.ok((await copy.collection('notes').indexes()).some((i) => i.name === 'text_1'));
    assert.equal((await copy.listCollections({ name: 'stale' }).toArray()).length, 0);

    // What the app writes lands in the copy, not in the real database.
    const res = await fetch(`http://localhost:${port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Agent', email: 'agent@example.com', password: 'stormy-harbor-92' }) });
    assert.equal(res.status, 201);
    assert.equal(await copy.collection('users').countDocuments(), 1);
    assert.equal(await client.db(db).collection('users').countDocuments(), 0);
    const activity = readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8');
    assert.match(activity, /disposable copy of/);
  } finally {
    dev.kill('SIGINT');
    await exited;
  }
  await waitFor(async () => !(await client.db().admin().listDatabases()).databases.some((d) => d.name === `${db}_agent`), 15_000);
  assert.equal(await client.db(db).collection('notes').countDocuments(), 2);
  assert.match(readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8'), /dropped .*_agent/);
  await client.db(db).dropDatabase();
  await conn.close();
});

test('calm dev --agent-db explains a missing MONGODB_URI', async () => {
  const project = await makeProject();
  writeFileSync(join(project.dir, '.env'), 'PORT=1\n');
  const { NODE_TEST_CONTEXT: _c, MONGODB_URI: _u, ...env } = { ...process.env, NO_COLOR: '1' };
  const child = spawn(process.execPath, [CALM, 'dev', '--agent-db'], { cwd: project.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.on('data', (d) => (err += d));
  const code = await new Promise((r) => child.on('exit', r));
  assert.equal(code, 1);
  assert.match(err, /MONGODB_URI is not set/);
});
