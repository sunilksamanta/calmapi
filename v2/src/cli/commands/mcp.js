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

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const BIN = join(PKG_ROOT, 'bin', 'calm.js');
const ANSI = /\x1b\[[0-9;]*m/g;

export const help = `
calm mcp

  Start an MCP server on stdio for AI coding agents. Register it once:
    claude mcp add calm -- npx calm mcp
  or add to your agent's MCP config: { "command": "npx", "args": ["calm", "mcp"] }
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
    description: 'Scaffold a new resource. Field specs: name:type[!][=default][+modifier], e.g. "title:string!+searchable", "price:number=0", "status:enum:draft,live=draft", "category:ref:category", "tags:string[]". Adds an owner field and a test automatically when the project has users.',
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
    name: 'calm_mails',
    description: 'Emails the dev server would have sent (e.g. password reset links), newest first.',
    inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } },
  },
];

export async function run(argv) {
  if (argv.includes('--help')) return process.stdout.write(help);
  const root = requireProject();
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
  await new Promise((resolve) => rl.on('close', resolve));
}

async function handle(root, msg) {
  const { id, method, params } = msg;
  const result = (r) => ({ jsonrpc: '2.0', id, result: r });
  const error = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  if (id === undefined) return null; // notification (e.g. notifications/initialized)

  switch (method) {
    case 'initialize': {
      const requested = params?.protocolVersion;
      return result({
        protocolVersion: PROTOCOLS.includes(requested) ? requested : PROTOCOLS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'calmapi', title: 'CalmAPI', version: PKG.version },
        instructions:
          'Tools for a CalmAPI project (Node.js + MongoDB REST framework whose code lives in calm/). Start with calm_project. Conventions are in AGENTS.md. Resources live in app/resources/<name>/. Run calm_doctor after changes.',
      });
    }
    case 'ping':
      return result({});
    case 'tools/list':
      return result({ tools: TOOLS });
    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return error(-32602, `Unknown tool ${params?.name}`);
      try {
        const out = await callTool(root, tool.name, params.arguments ?? {});
        return result({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }], isError: false });
      } catch (err) {
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
    default:
      throw new Error(`Unknown tool ${name}`);
  }
}
