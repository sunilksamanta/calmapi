import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const files = {
  'app/blocks/billing/index.js': `import { definePlugin } from '#calm';
export default definePlugin({
  name: 'billing',
  env: { BILLING_KEY: { secret: true, description: 'API key' } },
  setup(calm) {
    const { Schema } = calm.mongoose;
    calm.mongoose.model('invoiceRun', new Schema({ at: Date }, { collection: 'billing_runs' }));
    calm.onStart(() => {});
    calm.provide('charge', () => fetch('https://api.billing-provider.io/v1/charges', { method: 'POST' }));
  },
});
`,
};

let project;
let t;
before(async () => {
  project = await makeProject({ files });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('the pipeline is listed in the order it is wired', async () => {
  const a = await t.app.about();
  const names = a.pipeline.map((p) => p.name);
  const order = ['requestContext', 'securityHeaders', 'cors', 'json body', 'jsonGuard', 'authenticate', 'handler', 'errorHandler'];
  const idx = order.map((n) => names.indexOf(n));
  assert.ok(idx.every((i) => i >= 0), names.join(', '));
  assert.deepEqual([...idx].sort((x, y) => x - y), idx);
});

test('headers, stored data with lifetimes, and blocks with their models', async () => {
  const a = await t.app.about();
  const headers = a.headers.always.map((x) => x.name);
  for (const name of ['X-Request-Id', 'X-Content-Type-Options', 'Content-Security-Policy']) assert.ok(headers.includes(name), name);
  assert.ok(!headers.includes('Strict-Transport-Security'), 'HSTS only in production');
  const sessions = a.stored.collections.find((c) => c.collection === 'calm_sessions');
  assert.equal(sessions.owner, 'auth');
  assert.equal(sessions.ttl.field, 'expiresAt');
  assert.match(sessions.note, /30 days/);
  const runs = a.stored.collections.find((c) => c.collection === 'billing_runs');
  assert.equal(runs.owner, 'block:billing');
  const billing = a.blocks.find((b) => b.name === 'billing');
  assert.deepEqual(billing.env, ['BILLING_KEY']);
  assert.deepEqual(billing.models, ['invoiceRun']);
  assert.ok(a.files.some((f) => f.path.includes('.calm/checkpoints')));
});

test('outbound hosts: the block is listed, calm/ reaches nothing', async () => {
  const { outbound } = await t.app.about();
  assert.deepEqual(outbound.hosts, [{ host: 'api.billing-provider.io', files: ['app/blocks/billing/index.js'] }]);
  assert.equal(outbound.promise.ok, true, outbound.promise.detail);
  assert.ok(!outbound.hosts.some((h) => h.files.some((f) => f.startsWith('calm/'))));
});

test('devtools serves it and calm about prints it', async () => {
  const res = await fetch(`${t.origin}/_calm/api/about`, { headers: { host: 'localhost' } });
  assert.equal(res.status, 200);
  assert.ok((await res.json()).pipeline.length > 5);
  const env = { ...process.env, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_about_cli' };
  const json = JSON.parse(execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'about', '--json'], { cwd: project.dir, env, encoding: 'utf8' }));
  assert.ok(json.pipeline.some((p) => p.name === 'authenticate'));
  const text = execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'about'], { cwd: project.dir, env, encoding: 'utf8' });
  assert.match(text, /Request pipeline/);
  assert.match(text, /✔ calm\/ makes no network requests of its own/);
  assert.match(text, /api\.billing-provider\.io/);
});
