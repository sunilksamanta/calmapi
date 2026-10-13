import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// Every official block in one project: they install together, the app boots, and the
// framework's own checks (calm doctor) find nothing wrong in their code.

test('every official block installs and runs next to the others, and doctor finds nothing in their code', { timeout: 300_000 }, async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')], { stdio: 'ignore' });
  const metas = readdirSync(join(ROOT, 'registry', 'blocks')).map((n) => JSON.parse(readFileSync(join(ROOT, 'registry', 'blocks', n, 'block.json'), 'utf8')));
  // One of each group of blocks that do the same job.
  const skip = new Set(['storage-s3', 'mail-smtp', 'mail-postmark']);
  const names = metas.map((m) => m.name).filter((n) => !skip.has(n));
  for (const m of metas) for (const c of m.conflicts ?? []) {
    const other = metas.find((x) => x.name === c);
    assert.ok(other, `${m.name} conflicts with unknown block ${c}`);
    assert.ok((other.conflicts ?? []).includes(m.name), `${m.name} and ${c} must declare their conflict both ways`);
  }

  const project = await makeProject();
  try {
    const env = { ...process.env, CI: '1', NO_COLOR: '1' };
    const calm = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: project.dir, env, maxBuffer: 64 * 1024 * 1024 }).toString();
    calm('add', ...names, '--yes', '--no-install');
    for (const n of names) assert.ok(existsSync(join(project.dir, 'app', 'blocks', n, 'AGENTS.md')), `${n} ships AGENTS.md`);

    const t = await project.testApp();
    try {
      const res = await t.get('/health/ready');
      assert.equal(res.status, 200);
      assert.ok(t.app.plugins.length >= names.length);
    } finally {
      await t.close();
    }

    // Big projects produce a big report: it must arrive whole (it used to be cut at 64 KB).
    const report = JSON.parse(calm('doctor', '--json'));
    const inBlocks = report.findings.filter((f) => f.level === 'error' && String(f.file ?? '').startsWith('app/blocks/'));
    assert.deepEqual(inBlocks, [], 'official blocks trip no doctor error');
  } finally {
    project.cleanup();
  }
});
