import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 20_000, every = 200 } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      // not yet
    }
    if (Date.now() > end) throw new Error('timed out');
    await sleep(every);
  }
}

test('humans watch agents work: MCP calls, attributed diffs, restarts, crashes and tagged requests', { timeout: 120_000 }, async () => {
  const project = await makeProject();
  const port = 5600 + Math.floor(Math.random() * 300);
  const dbName = `calm_live_${Date.now()}`;
  const envFile = join(project.dir, '.env');
  const base = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  writeFileSync(envFile, readFileSync(envFile, 'utf8').replace(/^PORT=.*$/m, `PORT=${port}`).replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=${base.replace(/\/$/, '')}/${dbName}`));
  const { NODE_TEST_CONTEXT: _c, ...env } = { ...process.env, NO_COLOR: '1' };
  const dev = spawn(process.execPath, [CALM, 'dev'], { cwd: project.dir, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const mcp = spawn(process.execPath, [CALM, 'mcp'], { cwd: project.dir, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const devtools = (p) => fetch(`http://localhost:${port}/_calm/api${p}`).then((r) => r.json());
  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) !== -1) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  let id = 0;
  const call = async (name, args = {}) => {
    const n = ++id;
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: n, method: n === 1 ? 'initialize' : 'tools/call', params: n === 1 ? { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-code', version: '9' } } : { name, arguments: args } })}\n`);
    const r = await waitFor(() => replies.get(n), { timeout: 60_000, every: 50 });
    return n === 1 ? r : { ok: !r.result.isError, text: r.result.content[0].text };
  };

  try {
    await waitFor(() => devtools('/overview'));
    await call('init');

    const made = await call('calm_make_resource', { name: 'ticket', fields: ['title:string!', 'priority:enum:low,high=low'] });
    assert.ok(made.ok, made.text);
    const fileEvent = await waitFor(async () => (await devtools('/activity')).find((e) => e.type === 'file' && e.path === 'app/resources/ticket/ticket.resource.js'));
    assert.equal(fileEvent.change, 'added');
    assert.deepEqual(fileEvent.actor, { kind: 'agent', name: 'claude-code' });
    assert.ok(fileEvent.diff.added > 5);
    assert.ok(fileEvent.diff.hunks[0].lines.some((l) => l.includes("resource('ticket'")));
    const agentEvent = (await devtools('/activity')).find((e) => e.type === 'agent' && e.tool === 'calm_make_resource');
    assert.equal(agentEvent.client, 'claude-code');
    await waitFor(async () => (await devtools('/activity')).some((e) => e.type === 'restart'));
    await waitFor(async () => (await devtools('/overview')).resources.some((r) => r.name === 'ticket'));

    await fetch(`http://localhost:${port}/api/auth/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Live', email: 'live@example.com', password: 'stormy-harbor-92' }) });
    const created = JSON.parse((await call('calm_http', { method: 'POST', path: '/api/tickets', body: { title: 'From the agent' }, as: 'live@example.com' })).text);
    assert.equal(created.status, 201);
    const requests = await devtools('/requests');
    const tagged = requests.find((r) => r.id === created.requestId);
    assert.equal(tagged.agent, 'claude-code');
    const anon = JSON.parse((await call('calm_http', { method: 'GET', path: '/api/tickets' })).text);
    assert.equal(anon.status, 401);

    const security = JSON.parse((await call('calm_security')).text);
    assert.ok(security.exposure.resources.some((r) => r.name === 'ticket'));

    const tests = JSON.parse((await call('calm_test', { pattern: 'test/tickets.test.js' })).text);
    assert.equal(tests.fail, 0, JSON.stringify(tests));
    assert.ok(tests.pass >= 2);

    // A broken edit: the crash is recorded with its error, for the human and the agent.
    writeFileSync(join(project.dir, 'app/resources/ticket/ticket.service.js'), 'export default class extends {');
    const crash = await waitFor(async () => (await devtools('/activity')).find((e) => e.type === 'crash'), { timeout: 30_000 }).catch(async () => {
      // the dev server is down, so read the log file through the agent tool
      return JSON.parse((await call('calm_activity', { limit: 50 })).text).find((e) => e.type === 'crash');
    });
    assert.match(crash.text, /SyntaxError|Unexpected token/);
  } finally {
    mcp.kill();
    dev.kill('SIGTERM');
    await sleep(500);
    const { default: mongoose } = await import('mongoose');
    const conn = await mongoose.createConnection(`${base.replace(/\/$/, '')}/${dbName}`).asPromise();
    await conn.dropDatabase();
    await conn.close();
    project.cleanup();
  }
});
