import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject } from '../helpers.js';

let project;
let t;
const api = (path, init = {}) => fetch(`${t.origin}/_calm/api${path}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });
const post = (path, body) => api(path, { method: 'POST', headers: { 'x-calm-devtools': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });

before(async () => {
  project = await makeProject();
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('review state, signing from devtools, and refusals', async () => {
  const first = await (await api('/review')).json();
  assert.equal(first.baseline, null);
  assert.equal(first.needsSignature, true);
  assert.equal((await api('/review/signer')).status, 200);

  assert.equal((await api('/review/sign', { method: 'POST' })).status, 403, 'writes need the devtools header');
  const noName = await post('/review/sign', { name: ' ' });
  assert.equal(noName.status, 400);
  assert.match((await noName.json()).error, /Give your name/);

  const res = await post('/review/sign', { name: 'Grace Hopper', email: 'grace@example.test', note: 'baseline' });
  assert.equal(res.status, 201);
  const { review } = await res.json();
  assert.equal(review.via, 'devtools');
  assert.equal(review.signer.name, 'Grace Hopper');
  assert.ok(existsSync(join(project.dir, '.calm', 'reviews', `${review.id}.json`)));
  const baseline = JSON.parse(readFileSync(join(project.dir, '.calm', 'reviews', 'baseline.json'), 'utf8'));
  assert.equal(baseline.reviewId, review.id);
  assert.ok(baseline.snapshot.routes.length > 5);

  const after = await (await api('/review')).json();
  assert.equal(after.baseline.reviewId, review.id);
  assert.deepEqual(after.changes, []);
  assert.equal(after.needsSignature, false);

  const log = readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8');
  assert.match(log, /"type":"review".*"signer":"Grace Hopper"/);
});
