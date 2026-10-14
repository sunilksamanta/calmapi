import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// calm make resource --team: a team-scoped resource and tests that prove the isolation.

test('make resource --team needs the teams block, then scaffolds a team-scoped resource whose tests pass', { timeout: 240_000 }, async () => {
  const project = await makeProject();
  const env = { ...process.env, CI: '1', NO_COLOR: '1' };
  const calm = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: project.dir, env, stdio: 'pipe' }).toString();
  try {
    assert.throws(() => calm('make', 'resource', 'task', 'title:string+required', '--team'), (err) => /--team needs the teams block: npx calm add teams/.test(String(err.stderr)));
    calm('add', 'teams', '--yes', '--no-install');
    calm('make', 'resource', 'task', 'title:string+required', '--team');
    const source = readFileSync(join(project.dir, 'app/resources/task/task.resource.js'), 'utf8');
    assert.match(source, /team: true/);
    assert.match(source, /list: 'member'/);
    assert.match(source, /update: 'team:admin \| owner'/);
    const testFile = readFileSync(join(project.dir, 'test/tasks.test.js'), 'utf8');
    assert.match(testFile, /people outside the team see nothing/);
    const { NODE_TEST_CONTEXT: _c, ...clean } = env;
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap', 'test/tasks.test.js'], { cwd: project.dir, env: clean }).toString();
    assert.match(out, /^# pass 3$/m);
    assert.match(out, /^# fail 0$/m);
  } finally {
    project.cleanup();
  }
});
