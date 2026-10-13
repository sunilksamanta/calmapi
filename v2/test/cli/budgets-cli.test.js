import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';

test('calm budgets runs the tests with the meter on and fails --ci when a route is over', { timeout: 180_000 }, () => {
  const { CLAUDECODE: _cc, NODE_TEST_CONTEXT: _ntc, ...base } = process.env;
  const env = { ...base, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_budgets_cli', MONGODB_TEST_URI: process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017' };
  const work = mkdtempSync(join(tmpdir(), 'calm-budgets-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'create', 'shop', '--yes', '--no-install', '--no-git'], { cwd: work, env });
    const app = join(work, 'shop');
    symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
    const run = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: app, env, encoding: 'utf8' }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };
    const free = run('budgets', '--ci');
    assert.equal(free.code, 0, free.out);
    assert.match(free.out, /No budgets in calm\.config\.js yet/);
    assert.match(free.out, /GET \/api\/posts/);
    const config = join(app, 'calm.config.js');
    writeFileSync(config, readFileSync(config, 'utf8').replace('  mail:', "  budgets: { 'GET /api/posts': { queries: 1 }, '*': { queries: 50 } },\n  mail:"));
    const over = run('budgets', '--ci');
    assert.equal(over.code, 1, over.out);
    assert.match(over.out, /1 route over budget/);
    assert.match(over.out, /GET \/api\/posts: queries \d+ > 1/);
    const json = JSON.parse(run('budgets', '--json').out);
    assert.equal(json.tests.fail, 0);
    assert.equal(json.over, 1);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
