import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// The devtools Blocks panel: where each block came from, what you changed, the extension
// points it uses, its env vars and options. Secret values never reach the browser.
const files = {
  'calm.config.js': `import { defineConfig } from '#calm';
export default defineConfig({ blocks: { mine: { apiKey: 'from-config-123', label: 'Mine' } } });
`,
  'app/blocks/mine/index.js': `import { definePlugin } from '#calm';
export default definePlugin({
  name: 'mine',
  env: { MINE_TOKEN: { secret: true, description: 'Signs things' }, MINE_MODE: 'fast or slow' },
  options: { apiKey: null, label: 'Default' },
  setup(calm) {
    calm.policy('member', () => true);
    calm.on('post.created', () => {});
    calm.routes((r) => r.get('/mine', { policy: 'public' }, () => ({ ok: true })));
  },
});
`,
};

let project;
let t;
const saved = { ...process.env };
before(async () => {
  project = await makeProject({ files });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'idempotency', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  appendFileSync(join(project.dir, 'app/blocks/idempotency/index.js'), '\n// our tweak\n');
  process.env.MINE_TOKEN = 'very-secret-value';
  process.env.MINE_MODE = 'fast';
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
  process.env = saved;
});

test('overview.blocks: origin, changed files, extension points, env and options', async () => {
  const res = await fetch(`${t.origin}/_calm/api/overview`, { headers: { host: 'localhost' } });
  const { blocks } = await res.json();
  const idem = blocks.find((b) => b.name === 'idempotency');
  const mine = blocks.find((b) => b.name === 'mine');

  assert.equal(idem.installed.key, '@calmapi/idempotency');
  assert.deepEqual(idem.changed, ['app/blocks/idempotency/index.js'], 'files edited since calm add are listed');
  assert.ok(idem.uses.some((u) => u.kind === 'guard' && u.name === 'order 100'));

  assert.equal(mine.installed, null, 'not in calm.lock: your own block');
  assert.deepEqual(mine.uses.map((u) => [u.kind, u.name]), [['policy', 'member'], ['event', 'post.created']]);
  assert.deepEqual(mine.routes, [{ method: 'GET', path: '/api/mine', policy: 'public' }]);

  const token = mine.env.find((v) => v.key === 'MINE_TOKEN');
  assert.equal(token.set, true);
  assert.equal(token.value, null, 'secret values are never sent');
  assert.equal(mine.env.find((v) => v.key === 'MINE_MODE').value, 'fast');
  assert.equal(mine.options.apiKey, '[redacted]', 'secret-looking options are redacted');
  assert.equal(mine.options.label, 'Mine');
  assert.ok(!JSON.stringify(blocks).includes('very-secret-value'));
  assert.ok(!JSON.stringify(blocks).includes('from-config-123'));
});
