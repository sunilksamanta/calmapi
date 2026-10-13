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
});

test('a generic payload with another client; files outside the project have no path; bad input never fails', () => {
  hook({ tool: 'write', path: 'app/routes.js' }, '--client', 'cursor');
  assert.equal(lastEvent().client, 'cursor');
  assert.equal(lastEvent().path, 'app/routes.js');
  hook({ tool_name: 'Write', tool_input: { file_path: '/etc/hosts' }, cwd: app });
  assert.equal(lastEvent().path, undefined);
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
