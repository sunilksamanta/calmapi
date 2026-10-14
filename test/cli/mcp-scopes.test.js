import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const env = { ...process.env, NO_COLOR: '1', CI: '1' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let work;
let app;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-scopes-'));
  execFileSync(process.execPath, [CALM, 'create', 'scoped-api', '--yes', '--no-install', '--no-git'], { cwd: work, env, encoding: 'utf8' });
  app = join(work, 'scoped-api');
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
});
after(() => rmSync(work, { recursive: true, force: true }));

/** An MCP server over stdio: send JSON-RPC lines, await replies by id, kill by pid. */
function mcp(...args) {
  const child = spawn(process.execPath, [CALM, 'mcp', ...args], { cwd: app, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const replies = new Map();
  let buffer = '';
  let stderr = '';
  child.stderr.on('data', (d) => (stderr += d));
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) !== -1) {
      const msg = JSON.parse(buffer.slice(0, i));
      buffer = buffer.slice(i + 1);
      replies.set(msg.id, msg);
    }
  });
  let seq = 0;
  const request = async (method, params) => {
    const id = ++seq;
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    for (let i = 0; i < 1200 && !replies.has(id); i++) await sleep(50);
    assert.ok(replies.has(id), `no reply to ${method} (${stderr})`);
    return replies.get(id);
  };
  return {
    pid: child.pid,
    init: (name = 'scopes-test') => request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name, version: '1' } }),
    list: async () => (await request('tools/list')).result.tools,
    call: async (name, args = {}) => {
      const r = (await request('tools/call', { name, arguments: args })).result;
      return { ok: !r.isError, text: r.content[0].text };
    },
    async stop() {
      const exited = new Promise((r) => child.on('exit', r));
      process.kill(child.pid, 'SIGTERM');
      await exited;
    },
  };
}

const activity = () => readFileSync(join(app, '.calm', 'activity.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const sessionFile = () => join(app, '.calm', 'agent-session.json');

describe('calm mcp --scope', () => {
  test('read: refuses writes, annotates the tool list, records the session and proposals', { timeout: 120_000 }, async () => {
    const server = mcp('--scope', 'read');
    try {
      const init = await server.init();
      assert.match(init.result.instructions, /scope "read"/);
      assert.match(init.result.instructions, /calm\/security\/\*\*, calm\/auth\/\*\*, calm\.config\.js/);
      assert.match(init.result.instructions, /calm_propose/);

      const session = JSON.parse(readFileSync(sessionFile(), 'utf8'));
      assert.equal(session.scope, 'read');
      assert.equal(session.client, 'scopes-test');
      assert.equal(session.pid, server.pid);
      assert.deepEqual(session.allow, []);
      assert.deepEqual(session.protected, ['calm/security/**', 'calm/auth/**', 'calm.config.js']);
      assert.ok(Date.parse(session.startedAt) > 0);

      const tools = await server.list();
      const byName = Object.fromEntries(tools.map((t) => [t.name, t.description]));
      assert.ok(byName.calm_make_resource && byName.calm_propose && byName.calm_project, 'every tool is still listed');
      assert.match(byName.calm_make_resource, /Not available in the current scope \(read\): ask the developer to run calm mcp --scope scaffold\.$/);
      assert.match(byName.calm_add_block, /--scope scaffold\.$/);
      assert.doesNotMatch(byName.calm_project, /Not available/);
      assert.doesNotMatch(byName.calm_propose, /Not available/);
      assert.match(byName.calm_http, /Only GET is available in the current scope \(read\)/);

      const refused = await server.call('calm_make_resource', { name: 'ticket', fields: ['title:string!'] });
      assert.equal(refused.ok, false);
      assert.equal(refused.text, 'Refused: scope "read" cannot run calm_make_resource. Ask the developer to start the server with `calm mcp --scope scaffold`, or describe the change with calm_propose so they can apply it.');
      assert.ok(!existsSync(join(app, 'app/resources/ticket')), 'nothing was scaffolded');

      const post = await server.call('calm_http', { method: 'POST', path: '/api/tickets', body: {} });
      assert.equal(post.ok, false);
      assert.match(post.text, /^Refused: scope "read" cannot run calm_http with POST\./);

      const project = await server.call('calm_project');
      assert.equal(project.ok, true, project.text);
      assert.ok(JSON.parse(project.text).framework.calmapi);

      const config = readFileSync(join(app, 'calm.config.js'), 'utf8');
      const proposed = await server.call('calm_propose', {
        title: 'Lower the page size',
        reason: 'Lists are slow with 20 items',
        files: [{ path: 'calm.config.js', content: config.replace('defaultLimit: 20', 'defaultLimit: 10') }, { path: 'app/NOTES.md', content: '# notes\n' }],
      });
      assert.equal(proposed.ok, true, proposed.text);
      const id = /Proposal (\w+) saved/.exec(proposed.text)?.[1];
      assert.ok(id, proposed.text);
      assert.match(proposed.text, /devtools Activity/);
      assert.equal(readFileSync(join(app, 'calm.config.js'), 'utf8'), config, 'the project is untouched');
      const file = JSON.parse(readFileSync(join(app, '.calm', 'proposals', `${id}.json`), 'utf8'));
      assert.equal(file.title, 'Lower the page size');
      assert.equal(file.reason, 'Lists are slow with 20 items');
      assert.equal(file.client, 'scopes-test');
      assert.equal(file.files[0].path, 'calm.config.js');
      assert.equal(file.files[0].diff.added, 1);
      assert.equal(file.files[0].diff.removed, 1);
      assert.ok(file.files[0].diff.hunks[0].lines.some((l) => l === '+  pagination: { defaultLimit: 10, maxLimit: 100 },'));
      assert.equal(file.files[1].diff.added, 1, 'a new file diffs against nothing');
      assert.equal(file.files[1].diff.removed, 0);

      const outside = await server.call('calm_propose', { title: 'x', files: [{ path: '../elsewhere.js', content: '' }] });
      assert.equal(outside.ok, false);
      assert.match(outside.text, /outside the project/);
      const deps = await server.call('calm_propose', { title: 'x', files: [{ path: 'node_modules/express/index.js', content: '' }] });
      assert.equal(deps.ok, false);
      assert.match(deps.text, /node_modules/);

      const events = activity();
      const refusal = events.find((e) => e.type === 'agent' && e.tool === 'calm_make_resource');
      assert.equal(refusal.ok, false);
      assert.equal(refusal.refused, true);
      assert.equal(refusal.scope, 'read');
      assert.equal(refusal.client, 'scopes-test');
      assert.match(refusal.summary, /^Refused: scope "read"/);
      assert.ok(typeof refusal.ms === 'number');
      const proposal = events.find((e) => e.type === 'proposal');
      assert.equal(proposal.id, id);
      assert.equal(proposal.title, 'Lower the page size');
      assert.equal(proposal.client, 'scopes-test');
      assert.deepEqual(proposal.files, ['calm.config.js', 'app/NOTES.md']);
      const connect = events.find((e) => e.type === 'agent' && e.tool === 'connect');
      assert.match(connect.summary, /scope read/);
    } finally {
      await server.stop();
    }
    assert.ok(!existsSync(sessionFile()), 'the session file goes with the server');
  });

  test('full: scaffolds, --allow is recorded in the session', { timeout: 120_000 }, async () => {
    const server = mcp('--scope', 'full', '--allow', 'calm/auth/**');
    try {
      const init = await server.init('claude-code');
      assert.match(init.result.instructions, /scope "full"/);
      const made = await server.call('calm_make_resource', { name: 'ticket', fields: ['title:string!'] });
      assert.equal(made.ok, true, made.text);
      assert.ok(existsSync(join(app, 'app/resources/ticket/ticket.resource.js')));
      const tools = await server.list();
      assert.ok(tools.every((t) => !/Not available/.test(t.description)));
      const session = JSON.parse(readFileSync(sessionFile(), 'utf8'));
      assert.equal(session.scope, 'full');
      assert.equal(session.client, 'claude-code');
      assert.deepEqual(session.allow, ['calm/auth/**']);
    } finally {
      await server.stop();
    }
  });

  test('the default scope and protected paths come from agents in calm.config.js', { timeout: 120_000 }, async () => {
    const configFile = join(app, 'calm.config.js');
    const original = readFileSync(configFile, 'utf8');
    writeFileSync(configFile, original.replace('export default defineConfig({', "export default defineConfig({\n  agents: { scope: 'scaffold', protected: ['app/billing/**'] },"));
    const server = mcp();
    try {
      const init = await server.init();
      assert.match(init.result.instructions, /scope "scaffold"/);
      assert.match(init.result.instructions, /app\/billing\/\*\*/);
      const session = JSON.parse(readFileSync(sessionFile(), 'utf8'));
      assert.equal(session.scope, 'scaffold');
      assert.deepEqual(session.protected, ['app/billing/**']);
      const restore = await server.call('calm_restore', {});
      assert.equal(restore.ok, false);
      // calm_restore is full only, listed or not yet (another feature adds it)
      assert.match(restore.text, /Refused: scope "scaffold" cannot run calm_restore|Unknown tool calm_restore/);
    } finally {
      await server.stop();
      writeFileSync(configFile, original);
    }
    assert.equal(readdirSync(join(app, '.calm', 'proposals')).length, 1, 'proposals from the first test are still there');
  });

  test('rejects an unknown scope', () => {
    let out = '';
    try {
      execFileSync(process.execPath, [CALM, 'mcp', '--scope', 'admin'], { cwd: app, env, encoding: 'utf8', stdio: 'pipe' });
    } catch (err) {
      out = `${err.stdout}${err.stderr}`;
    }
    assert.match(out, /Unknown scope "admin"/);
  });
});
