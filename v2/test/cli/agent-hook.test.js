import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';
import { attribute, detectAgentEnv } from '../../src/cli/lib/attribution.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const env = { ...process.env, NO_COLOR: '1', CI: '1' };
let work;
let app;

before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-hook-'));
  execFileSync(process.execPath, [CALM, 'create', 'hooked', '--yes', '--no-install', '--no-git'], { cwd: work, env });
  app = join(work, 'hooked');
});
after(() => rmSync(work, { recursive: true, force: true }));

const hook = (payload, ...args) => execFileSync(process.execPath, [CALM, 'agent-hook', ...args], { cwd: app, env, input: JSON.stringify(payload), encoding: 'utf8' });
const lastEvent = () => JSON.parse(readFileSync(join(app, '.calm', 'activity.jsonl'), 'utf8').trim().split('\n').at(-1));

test('new projects ship the Claude Code hook', () => {
  const settings = JSON.parse(readFileSync(join(app, '.claude', 'settings.json'), 'utf8'));
  const entry = settings.hooks.PreToolUse[0];
  assert.match(entry.matcher, /Edit/);
  assert.match(entry.hooks[0].command, /calm agent-hook/);
});

test('the Claude Code payload is recorded with the file relative to the project', () => {
  const out = hook({ session_id: 'x', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: join(app, 'app', 'resources', 'post', 'post.resource.js') }, cwd: app });
  assert.equal(out, '', 'prints nothing');
  const e = lastEvent();
  assert.equal(e.type, 'agent');
  assert.equal(e.client, 'claude-code');
  assert.equal(e.tool, 'hook:Edit');
  assert.equal(e.path, 'app/resources/post/post.resource.js');
  assert.equal(e.summary, 'claude-code is about to edit app/resources/post/post.resource.js');
});

test('a generic payload with another client; files outside the project are not logged; bad input never fails', () => {
  hook({ tool: 'write', path: 'app/routes.js' }, '--client', 'cursor');
  assert.equal(lastEvent().client, 'cursor');
  assert.equal(lastEvent().path, 'app/routes.js');
  const before = lastEvent();
  hook({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, cwd: app });
  assert.deepEqual(lastEvent(), before, 'an edit outside the project is not logged');
  execFileSync(process.execPath, [CALM, 'agent-hook'], { cwd: app, env, input: 'not json' });
  assert.ok(existsSync(join(app, '.calm', 'activity.jsonl')));
});

test('attribution: the hook names the file, MCP claims a window, the environment is last', () => {
  const now = Date.parse('2026-10-13T10:00:00Z');
  const at = (sec) => new Date(now - sec * 1000).toISOString();
  const hookEvent = { time: at(60), type: 'agent', client: 'claude-code', tool: 'hook:Edit', path: 'app/a.js' };
  const mcpEvent = { time: at(5), type: 'agent', client: 'codex', tool: 'calm_routes' };
  assert.deepEqual(attribute('app/a.js', [hookEvent, mcpEvent], { now }), { kind: 'agent', name: 'claude-code', via: 'hook' }, 'an exact file wins over a newer MCP call');
  assert.deepEqual(attribute('app/b.js', [hookEvent, mcpEvent], { now }), { kind: 'agent', name: 'codex', via: 'mcp' });
  assert.equal(attribute('app/b.js', [hookEvent], { now }), null, 'a hook only claims its own file');
  assert.equal(attribute('app/b.js', [{ ...mcpEvent, time: at(30) }], { now }), null, 'MCP calls claim 20 seconds');
  assert.deepEqual(attribute('app/b.js', [], { now, envAgent: 'claude-code' }), { kind: 'agent', name: 'claude-code', via: 'env' });
  assert.equal(attribute('app/a.js', [{ ...hookEvent, time: at(600) }], { now }), null, 'old hook events expire');
  assert.equal(detectAgentEnv({ CLAUDECODE: '1' }), 'claude-code');
  assert.equal(detectAgentEnv({}), null);
});

test('calm dev credits a hooked edit to the agent, records test/ files, and ignores edits outside the project', { timeout: 60_000 }, async () => {
  const { makeProject } = await import('../helpers.js');
  const { spawn } = await import('node:child_process');
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const project = await makeProject();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const port = 5900 + Math.floor(Math.random() * 90);
  const envFile = join(project.dir, '.env');
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^PORT=.*$/m, `PORT=${port}`).replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=mongodb://127.0.0.1:27017/calm_hook_${Date.now()}`));
  const { NODE_TEST_CONTEXT: _c, CLAUDECODE: _cc, ...childEnv } = { ...process.env, NO_COLOR: '1' };
  const dev = spawn(process.execPath, [CALM, 'dev'], { cwd: project.dir, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  const log = () => readFileSync(join(project.dir, '.calm', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const waitFor = async (fn) => {
    for (let i = 0; i < 100; i++) {
      try {
        const v = fn();
        if (v) return v;
      } catch {
        // not yet
      }
      await sleep(200);
    }
    throw new Error('timed out');
  };
  try {
    await waitFor(() => log().some((e) => e.type === 'session'));
    await sleep(500);
    const hookIn = (payload) => execFileSync(process.execPath, [CALM, 'agent-hook'], { cwd: project.dir, env: childEnv, input: JSON.stringify(payload) });
    const testFile = join(project.dir, 'test', 'extra.test.js');
    hookIn({ tool_name: 'Write', tool_input: { file_path: testFile }, cwd: project.dir });
    writeFileSync(testFile, "import { test } from 'node:test';\ntest('x', () => {});\n");
    const byAgent = await waitFor(() => log().find((e) => e.type === 'file' && e.path === 'test/extra.test.js'));
    assert.deepEqual(byAgent.actor, { kind: 'agent', name: 'claude-code' });
    assert.equal(byAgent.via, 'hook');

    // A human edit with no hook note, 30 seconds of quiet is not needed: hooks only claim their own file.
    writeFileSync(join(project.dir, 'README.md'), '# changed by a person\n');
    const byHuman = await waitFor(() => log().find((e) => e.type === 'file' && e.path === 'README.md'));
    assert.equal(byHuman.actor.kind, 'human');

    const outside = join(project.dir, '..', `plan-${Date.now()}.md`);
    mkdirSync(join(project.dir, '..'), { recursive: true });
    const before = log().length;
    hookIn({ tool_name: 'Write', tool_input: { file_path: outside }, cwd: project.dir });
    assert.equal(log().length, before, 'an edit outside the project is not logged');
  } finally {
    dev.kill('SIGTERM');
    await new Promise((r) => dev.once('exit', r));
    project.cleanup();
  }
});
