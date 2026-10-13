// `calm mcp`: a Model Context Protocol server over stdio, so coding agents can
// understand and drive a CalmAPI project. No SDK needed: JSON-RPC 2.0, one message per line.
//
//   claude mcp add calm -- npx calm mcp
//
// Static tools run the CLI in a child process (fresh view of the code every call).
// Runtime tools read the devtools API of the running dev server (npm run dev).

import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { requireProject, capture } from '../lib/project.js';
import { PKG, PKG_ROOT, readJson, readText } from '../lib/files.js';
import { appendActivity, readActivity } from '../lib/activity.js';
import { runAuditInProject } from './audit.js';
import { introspect } from '../lib/introspect.js';
import { explainText } from '../lib/explain-text.js';
import { parseScopeArgs, resolveAgentSession, allowedIn, refusalText, annotateTools, scopeSentence, writeAgentSession, clearAgentSession } from '../lib/agent-scope.js';
import { writeProposal } from '../lib/proposals.js';

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const BIN = join(PKG_ROOT, 'bin', 'calm.js');
const ANSI = /\x1b\[[0-9;]*m/g;

export const help = `
calm mcp [--scope read|scaffold|full] [--allow <glob>]...

  Start an MCP server on stdio for AI coding agents. Register it once:
    claude mcp add calm -- npx calm mcp
  or add to your agent's MCP config: { "command": "npx", "args": ["calm", "mcp"] }

  --scope    what the agent may do: read (inspect only), scaffold (plus make resource,
             add block, checkpoints) or full. Default: agents.scope in calm.config.js, else full.
  --allow    a protected path (agents.protected) the agent may edit in this session, repeatable.
`;

const str = (description) => ({ type: 'string', description });
const TOOLS = [
  {
    name: 'calm_project',
    description: 'Overview of this CalmAPI project: app name, framework version, resources (with paths and policies), installed blocks, and whether the dev server is running. Call this first.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_routes',
    description: 'Every HTTP route with method, full path, access policy (public/authenticated/owner/admin/role), and the source file.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_resource',
    description: 'Full definition of one resource: fields with types and flags (hidden, readOnly, filterable...), policies per action, owner field, and the source of its files.',
    inputSchema: { type: 'object', properties: { name: str('Resource name, e.g. "post"') }, required: ['name'] },
  },
  {
    name: 'calm_make_resource',
    description: 'Scaffold a new resource. Field specs: name:type[:arg][=default][+modifier...], e.g. "title:string+required+searchable", "price:number=0", "status:enum:draft,live=draft", "category:ref:category", "tags:string+array". Modifiers: required, array, searchable, sortable, filterable, unique, index, hidden, writeOnly, readOnly, immutable, populate, owner. Adds an owner field and a test automatically when the project has users.',
    inputSchema: {
      type: 'object',
      properties: {
        name: str('Singular resource name, e.g. "product"'),
        fields: { type: 'array', items: { type: 'string' }, description: 'Field specs' },
        service: { type: 'boolean', description: 'Also create <name>.service.js' },
        routes: { type: 'boolean', description: 'Also create <name>.routes.js' },
      },
      required: ['name'],
    },
  },
  {
    name: 'calm_doctor',
    description: 'Run security and correctness checks (config, policies, exposed secrets, risky code patterns, advisories). Fix every "error" finding.',
    inputSchema: { type: 'object', properties: { production: { type: 'boolean', description: 'Evaluate with production rules' } } },
  },
  {
    name: 'calm_blocks',
    description: 'List official blocks that can be added with calm_add_block (jobs, storage, realtime, mcp-server, ...).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_add_block',
    description: 'Add blocks to the project (copies source into app/blocks, adds dependencies and env vars). Use dryRun first to preview.',
    inputSchema: {
      type: 'object',
      properties: {
        blocks: { type: 'array', items: { type: 'string' }, description: 'e.g. ["jobs"] or ["@calmapi/storage-local"]' },
        dryRun: { type: 'boolean' },
        install: { type: 'boolean', description: 'Run the package manager (default true)' },
      },
      required: ['blocks'],
    },
  },
  {
    name: 'calm_openapi',
    description: 'The OpenAPI 3.1 document generated from the code.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_recent_requests',
    description: 'Recent HTTP requests handled by the running dev server (method, path, status, duration, query count, error code). Use to debug what just happened.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', description: 'Default 20' }, errorsOnly: { type: 'boolean' }, path: str('Only paths containing this text') },
    },
  },
  {
    name: 'calm_request',
    description: 'Everything about one request from the dev server: headers, body, response, every MongoDB query with timing, logs, and the full error with stack trace.',
    inputSchema: { type: 'object', properties: { id: str('Request id from calm_recent_requests') }, required: ['id'] },
  },
  {
    name: 'calm_logs',
    description: 'Recent log lines from the dev server.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' }, level: { type: 'string', enum: ['debug', 'info', 'warn', 'error'] } } },
  },
  {
    name: 'calm_http',
    description: 'Call the running dev API like a real client and get status + body. `as` picks the caller: "anonymous" (default), "admin" (first admin user), or a user email. The request shows up in devtools tagged as yours; pass its requestId to calm_request for queries, logs and errors.',
    inputSchema: {
      type: 'object',
      properties: {
        method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
        path: str('e.g. "/api/posts?status=published"'),
        body: { type: 'object', description: 'JSON body for POST/PUT/PATCH' },
        as: str('"anonymous", "admin" or a user email'),
      },
      required: ['method', 'path'],
    },
  },
  {
    name: 'calm_test',
    description: 'Run the project tests (node --test) and get pass/fail counts with each failing test and its error.',
    inputSchema: { type: 'object', properties: { pattern: str('Optional file or glob, e.g. "test/posts.test.js"') } },
  },
  {
    name: 'calm_audit',
    description: 'Security audit: calls every route as anonymous, owner, another user, admin and custom roles on a throwaway database, and reports policy mismatches, field leaks, mass assignment and injection problems. Run after changing policies or fields.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_security',
    description: 'Security picture: the exposure matrix (who can do what and see which fields, per resource and role), security-related doctor findings, and recent security events (failed logins, lockouts, rejected writes) from the dev server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'calm_activity',
    description: 'Recent project activity: file changes with diffs (and who made them: you or a human), server restarts and crashes with their error output. Check this after editing code to see if the dev server came back up.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer', description: 'Default 30' } } },
  },
  {
    name: 'calm_mails',
    description: 'Emails the dev server would have sent (e.g. password reset links), newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'calm_pushes',
    description:
      'Push notifications the dev server sent or captured (app.push.send), newest first: title, body, data, target devices and platforms, warnings (payload too large, text cut off on iOS or Android, sensitive data in the payload) and the delivery log. Use it to check notifications your code sends.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
  {
    name: 'calm_diff',
    description:
      'What changed in behavior (not lines) between a git ref (default HEAD) and the working tree: routes added or removed, policies loosened or tightened, fields visible to more people, env vars, hosts the code can reach, events, blocks and invariants, with a count of changes that widen access. Run it before you finish, and show the developer the result.',
    inputSchema: { type: 'object', properties: { ref: str('Git ref to compare with, e.g. "main" (default HEAD)') } },
  },
  {
    name: 'calm_checkpoint',
    description:
      'Snapshot the development database (every collection, to .calm/checkpoints) so it can be put back with calm_restore. One is taken automatically when you connect; take another before a migration, a seed or a destructive change. Needs the dev server (npm run dev).',
    inputSchema: { type: 'object', properties: { name: str('Short name, e.g. "before migration" (default "manual")') } },
  },
  {
    name: 'calm_restore',
    description:
      'Put the development database back exactly as it was in a checkpoint: every stored collection is replaced, collections created since are dropped. Use the id from calm_checkpoint or from the checkpoint events in calm_activity. Needs the dev server (npm run dev).',
    inputSchema: { type: 'object', properties: { id: str('Checkpoint id, e.g. "20260413-141500-before-claude-session"') }, required: ['id'] },
  },
  {
    name: 'calm_propose',
    description:
      'Describe a change instead of making it: for protected paths (calm/security, calm/auth, calm.config.js), access rules in resources, or anything the current scope refuses. Give the whole content of each file. The developer reviews the diff and applies it from devtools Activity.',
    inputSchema: {
      type: 'object',
      properties: {
        title: str('What the change does, one line'),
        reason: str('Why it is needed'),
        files: {
          type: 'array',
          description: 'Files to write, with their full new content',
          items: { type: 'object', properties: { path: str('Project-relative path'), content: str('Whole file content') }, required: ['path', 'content'] },
        },
      },
      required: ['title', 'files'],
    },
  },
  {
    name: 'calm_explain',
    description:
      'Why a request got its answer: the path it took through the code, step by step (rate limit, authentication, guards, the policy decision token by token, input validation, service hooks, the handler with file and line, events, the error). Use it on any 401, 403, 404 or 422 instead of guessing. The id comes from calm_recent_requests or the requestId of calm_http.',
    inputSchema: { type: 'object', properties: { id: str('Request id') }, required: ['id'] },
  },
  {
    name: 'calm_about',
    description:
      'The transparency report: what the framework does on every request (the middleware pipeline in order), the headers it sets, what it stores and for how long, what it logs, which hosts the code can reach, and the files the CLI writes. Read it before changing middleware, auth or storage.',
    inputSchema: { type: 'object', properties: {} },
  },
];

export async function run(argv) {
  if (argv.includes('--help')) return process.stdout.write(help);
  const root = requireProject();
  session = await resolveAgentSession(root, parseScopeArgs(argv));
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    const messages = Array.isArray(msg) ? msg : [msg];
    for (const m of messages) {
      const reply = await handle(root, m);
      if (reply) send(reply);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => (clearAgentSession(root), process.exit(0)));
  await new Promise((resolve) => rl.on('close', resolve));
  clearAgentSession(root);
}

let clientName = 'agent';
let session = { scope: 'full', allow: [], protected: [] }; // from resolveAgentSession
const tokens = new Map();

async function handle(root, msg) {
  const { id, method, params } = msg;
  const result = (r) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // notification (e.g. notifications/initialized)

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      clientName = String(params?.clientInfo?.name ?? 'agent').slice(0, 60);
      appendActivity(root, { type: 'agent', client: clientName, tool: 'connect', ok: true, ms: 0, summary: `${clientName} connected over MCP (scope ${session.scope})` });
      writeAgentSession(root, { client: clientName, ...session });
      // A checkpoint of the dev database before the agent touches anything (needs the dev server).
      await autoCheckpoint(root, clientName).catch(() => {});
      return result({
        protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'calmapi', title: 'CalmAPI', version: PKG.version },
        instructions:
          `Tools for a CalmAPI project (Node.js + MongoDB REST framework whose code lives in calm/). Start with calm_project; conventions are in AGENTS.md; resources live in app/resources/<name>/. After editing code: calm_activity (did the dev server restart or crash?), calm_http to try endpoints as anonymous/admin/a user, calm_test, then calm_doctor and calm_audit for security. A human may be watching your work live in devtools (/_calm). ${scopeSentence(session)}`,
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: annotateTools(TOOLS, session.scope) });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return error(-32602, `Unknown tool ${params?.name}`);
      const started = Date.now();
      const args = params.arguments ?? {};
      const log = (ok, text, extra = {}) =>
        appendActivity(root, { type: 'agent', client: clientName, tool: tool.name, args: clip(JSON.stringify(args), 400), ok, ...extra, ms: Date.now() - started, summary: clip(text, 300) });
      if (!allowedIn(session.scope, tool.name, args)) {
        const text = refusalText(session.scope, tool.name, args);
        log(false, text, { refused: true, scope: session.scope });
        return result({ content: [{ type: 'text', text }], isError: true });
      }
      try {
        const out = await callTool(root, tool.name, args);
        const text = typeof out === 'string' ? out : JSON.stringify(out, null, 2);
        log(true, text);
        return result({ content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        log(false, err.message);
        return result({ content: [{ type: 'text', text: err.message }], isError: true });
      }
    }
    default:
      return error(-32601, `Method not found: ${method}`);
  }
}

async function cli(root, args) {
  const res = await capture(process.execPath, [BIN, ...args], { cwd: root, env: { NO_COLOR: '1', FORCE_COLOR: '0', CI: '1' } });
  const text = `${res.stdout}${res.stderr}`.replace(ANSI, '').trim();
  if (res.code !== 0) throw new Error(text || `calm ${args.join(' ')} failed`);
  return text;
}

const json = async (root, args) => JSON.parse(await cli(root, args));

function devServerUrl(root) {
  const env = existsSync(join(root, '.env')) ? readText(join(root, '.env')) : '';
  const port = process.env.PORT ?? /^PORT=(\d+)/m.exec(env)?.[1] ?? '5001';
  return `http://localhost:${port}`;
}

const clip = (s, n) => (typeof s === 'string' && s.length > n ? `${s.slice(0, n)}…` : s);

async function devtoolsPost(root, path, body) {
  const res = await fetch(`${devServerUrl(root)}/_calm/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-calm-devtools': '1' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function tokenFor(root, as) {
  if (!as || as === 'anonymous') return null;
  if (tokens.has(as)) return tokens.get(as);
  const users = await devtools(root, `/users${as === 'admin' ? '' : `?q=${encodeURIComponent(as)}`}`);
  const user = as === 'admin' ? users.find((u) => u.roles.includes('admin')) : users.find((u) => u.email === String(as).toLowerCase());
  if (!user) throw new Error(as === 'admin' ? 'No admin user yet. Sign one up, then run `npx calm admin <email>`.' : `No user with email ${as}. Register one with POST /api/auth/register.`);
  const { token } = await devtoolsPost(root, '/act-as', { userId: user.id });
  tokens.set(as, token);
  return token;
}

function parseTap(text) {
  const num = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(text)?.[1] ?? 0);
  const failures = [];
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = /^\s*not ok \d+ - (.+)$/.exec(line);
    if (!m) return;
    const block = lines.slice(i + 1, i + 40);
    const end = block.findIndex((l) => /^\s*\.\.\.\s*$/.test(l));
    const detail = (end === -1 ? block : block.slice(0, end)).join('\n');
    if (/failureType: 'subtestsFailed'/.test(detail)) return;
    const error = /error: \|?-?\s*\n?([\s\S]*?)\n\s+(code|name|expected|stack):/.exec(detail)?.[1]?.trim() ?? /error: '([^']*)'/.exec(detail)?.[1] ?? '';
    const where = /location: '([^']+)'/.exec(detail)?.[1] ?? null;
    failures.push({ name: m[1], error: clip(error.replace(/\s+/g, ' '), 500), where });
  });
  return { tests: num('tests'), pass: num('pass'), fail: num('fail'), failures };
}

async function devtools(root, path) {
  const base = devServerUrl(root);
  let res;
  try {
    res = await fetch(`${base}/_calm/api${path}`);
  } catch {
    throw new Error(`The dev server is not reachable at ${base}. Start it with \`npm run dev\` (devtools only run in development).`);
  }
  if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function callTool(root, name, args) {
  switch (name) {
    case 'calm_project': {
      const routes = await json(root, ['routes', '--json']);
      const lock = readJson(join(root, 'calm.lock'), {});
      let devServer = 'not running (start with npm run dev)';
      try {
        const o = await devtools(root, '/overview');
        devServer = `running at ${devServerUrl(root)} (devtools: ${devServerUrl(root)}/_calm)`;
        return {
          app: o.app,
          framework: { calmapi: lock.calmapi, template: lock.template },
          devServer,
          database: o.database,
          resources: o.resources.map((r) => ({ name: r.name, path: r.path, policy: r.policy, files: r.files })),
          blocks: Object.keys(lock.blocks ?? {}),
          routeCount: routes.length,
        };
      } catch {
        const byResource = {};
        for (const r of routes) if (r.resource) (byResource[r.resource] ??= []).push(`${r.method} ${r.path} [${r.policy}]`);
        return { framework: { calmapi: lock.calmapi, template: lock.template }, devServer, resources: byResource, blocks: Object.keys(lock.blocks ?? {}), routeCount: routes.length };
      }
    }
    case 'calm_routes':
      return json(root, ['routes', '--json']);
    case 'calm_resource': {
      const dir = join(root, 'app', 'resources', args.name);
      if (!existsSync(dir)) throw new Error(`No resource "${args.name}" in app/resources`);
      const files = {};
      for (const suffix of ['resource', 'service', 'routes']) {
        const file = join(dir, `${args.name}.${suffix}.js`);
        if (existsSync(file)) files[`app/resources/${args.name}/${args.name}.${suffix}.js`] = readText(file);
      }
      const routes = (await json(root, ['routes', '--json'])).filter((r) => r.resource === args.name);
      return { files, routes };
    }
    case 'calm_make_resource': {
      const flags = [args.service && '--service', args.routes && '--routes'].filter(Boolean);
      return cli(root, ['make', 'resource', args.name, ...(args.fields ?? []), ...flags]);
    }
    case 'calm_doctor':
      return json(root, ['doctor', '--json', ...(args.production ? ['--prod'] : [])]);
    case 'calm_blocks':
      return readJson(join(PKG_ROOT, 'registry', 'r', 'index.json'), { items: [] }).items;
    case 'calm_add_block': {
      const flags = ['--yes', ...(args.dryRun ? ['--dry-run'] : []), ...(args.install === false ? ['--no-install'] : [])];
      return cli(root, ['add', ...args.blocks, ...flags]);
    }
    case 'calm_openapi':
      return json(root, ['openapi', '--stdout']);
    case 'calm_recent_requests': {
      let list = await devtools(root, '/requests');
      if (args.errorsOnly) list = list.filter((r) => r.status >= 400);
      if (args.path) list = list.filter((r) => r.path.includes(args.path));
      return list.slice(0, args.limit ?? 20);
    }
    case 'calm_request':
      return devtools(root, `/requests/${encodeURIComponent(args.id)}`);
    case 'calm_logs': {
      let logs = await devtools(root, '/logs');
      if (args.level) logs = logs.filter((l) => l.level === args.level);
      return logs.slice(-(args.limit ?? 50));
    }
    case 'calm_mails':
      return (await devtools(root, '/mails')).slice(0, args.limit ?? 10);
    case 'calm_pushes':
      // Payload bodies are large; agents get sizes and warnings, the full payloads stay in devtools.
      return (await devtools(root, '/pushes')).slice(0, args.limit ?? 10).map(({ payloads, ...p }) => ({
        ...p,
        sizes: Object.fromEntries(Object.entries(payloads).map(([k, v]) => [k, `${v.bytes}/${v.limit} bytes`])),
      }));
    case 'calm_http': {
      const token = await tokenFor(root, args.as);
      const path = args.path.startsWith('/') ? args.path : `/${args.path}`;
      let res;
      try {
        res = await fetch(`${devServerUrl(root)}${path}`, {
          method: args.method,
          headers: {
            'x-calm-agent': clientName,
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(args.body !== undefined ? { 'content-type': 'application/json' } : {}),
          },
          body: args.body !== undefined ? JSON.stringify(args.body) : undefined,
        });
      } catch {
        throw new Error(`The dev server is not reachable at ${devServerUrl(root)}. Start it with \`npm run dev\`.`);
      }
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = clip(text, 4000);
      }
      return { status: res.status, requestId: res.headers.get('x-request-id'), as: args.as ?? 'anonymous', body };
    }
    case 'calm_test': {
      const res = await capture(process.execPath, ['--test', '--test-reporter=tap', ...(args.pattern ? [args.pattern] : [])], { cwd: root, env: { NODE_TEST_CONTEXT: undefined } });
      return parseTap(`${res.stdout}\n${res.stderr}`);
    }
    case 'calm_audit': {
      const report = await runAuditInProject(root);
      return {
        ok: report.ok,
        summary: report.summary,
        failures: report.results.filter((r) => r.ok === false),
        leaks: report.leaks,
        failedProbes: report.probes.filter((p) => !p.ok),
        notes: report.notes,
      };
    }
    case 'calm_security': {
      const info = await introspect(root);
      if (info.error) throw new Error(info.error.message);
      const security = /secret|pii|sensitive|cors|rate|mail|policy|roles|public-write|email-unique|trust|encrypt/;
      let events;
      try {
        events = (await devtools(root, '/security')).events.slice(0, 30);
      } catch {
        events = 'dev server not running';
      }
      return { exposure: info.exposure, findings: info.doctor.filter((f) => security.test(f.id)), recentEvents: events };
    }
    case 'calm_diff':
      return json(root, ['diff', ...(args.ref ? [String(args.ref)] : []), '--json']);
    case 'calm_activity':
      return readActivity(root, (args.limit ?? 30) * 3).filter((e) => !(e.type === 'agent' && String(e.tool ?? '').startsWith('hook:'))).slice(-(args.limit ?? 30)).map((e) =>
        e.type === 'file' && e.diff
          ? { ...e, diff: { added: e.diff.added, removed: e.diff.removed, text: e.diff.hunks.map((h) => h.lines.join('\n')).join('\n...\n').slice(0, 3000) } }
          : e,
      );
    case 'calm_checkpoint': {
      const meta = await checkpointCall(root, 'POST', '/checkpoints', { name: args.name || 'manual', actor: { kind: 'agent', name: clientName } });
      return { id: meta.id, name: meta.name, createdAt: meta.createdAt, collections: meta.collections.length, docs: meta.collections.reduce((n, c) => n + c.docs, 0), restoreWith: `calm_restore { id: "${meta.id}" }` };
    }
    case 'calm_restore': {
      if (!args.id) {
        const list = await checkpointCall(root, 'GET', '/checkpoints');
        throw new Error(list.length ? `Pass the id of a checkpoint. Available (newest first): ${list.map((c) => `${c.id} (${c.name})`).join(', ')}` : 'No checkpoints yet. Take one with calm_checkpoint.');
      }
      return checkpointCall(root, 'POST', `/checkpoints/${encodeURIComponent(args.id)}/restore`, { actor: { kind: 'agent', name: clientName } });
    }
    case 'calm_propose': {
      const p = writeProposal(root, { ...args, client: clientName });
      return `Proposal ${p.id} saved: "${p.title}" (${p.files.map((f) => `${f.path} +${f.diff.added} -${f.diff.removed}`).join(', ')}). The developer can review the diff and apply it from devtools Activity (/_calm); nothing was written to the project.`;
    }
    case 'calm_explain': {
      const record = await devtools(root, `/requests/${encodeURIComponent(args.id)}`);
      return {
        text: explainText(record),
        request: { method: record.method, path: record.path, status: record.status, user: record.user, route: record.route ?? null, error: record.error ? { code: record.error.code, message: record.error.message } : null },
        steps: record.steps ?? [],
      };
    }
    case 'calm_about': {
      const info = await introspect(root);
      if (info.error) throw new Error(info.error.message);
      return info.about;
    }
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}

// ---- checkpoints (through the dev server's devtools API) ---------------------------------

async function checkpointCall(root, method, path, body) {
  const base = devServerUrl(root);
  let res;
  try {
    res = await fetch(`${base}/_calm/api${path}`, {
      method,
      headers: { 'x-calm-devtools': '1', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(60_000),
    });
  } catch {
    throw new Error(`The dev server is not reachable at ${base}. Checkpoints are taken through it: start it with \`npm run dev\`.`);
  }
  if (res.status === 204) return null;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  if (!res.ok) throw new Error(data?.error ?? `${path}: ${res.status} ${clip(text, 300)}`);
  return data;
}

/**
 * On connect: a checkpoint named after the client, unless one is less than ten minutes old.
 * Only the five newest automatic ones are kept. Silent when the dev server is not running.
 */
async function autoCheckpoint(root, client) {
  let list;
  try {
    list = await checkpointCall(root, 'GET', '/checkpoints');
  } catch {
    return;
  }
  const newest = list[0];
  if (newest && Date.now() - Date.parse(newest.createdAt) < 10 * 60_000) return;
  await checkpointCall(root, 'POST', '/checkpoints', { name: `before ${client} session`, actor: { kind: 'agent', name: client }, auto: true });
  for (const old of list.filter((c) => c.auto).slice(4)) await checkpointCall(root, 'DELETE', `/checkpoints/${encodeURIComponent(old.id)}`).catch(() => {});
}
