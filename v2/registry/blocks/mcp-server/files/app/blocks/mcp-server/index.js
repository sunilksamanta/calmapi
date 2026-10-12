import { definePlugin } from '#calm';
import { resourceJSONSchema } from '#calm/resource/resource.js';

// Model Context Protocol server (Streamable HTTP, stateless) at POST /mcp.
//
// Tools are generated from your resources. A tool call is executed as a real HTTP
// request against your own API with the caller's Authorization header, so policies,
// validation, scoping, rate limits and field visibility are exactly the REST ones.

const PROTOCOLS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const DEFAULT_EXCLUDED = new Set(['user', 'file']);

export default definePlugin({
  name: 'mcp-server',
  env: {
    MCP_RESOURCES: 'Comma separated resources the MCP tools may use (default: all)',
  },
  setup(calm) {
    const { config } = calm;

    const exposed = () => {
      const only = (process.env.MCP_RESOURCES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
      return [...calm.app.registry.values()].filter(({ def }) => (only.length ? only.includes(def.name) : !DEFAULT_EXCLUDED.has(def.name)));
    };

    function tools() {
      const list = [];
      for (const { def } of exposed()) {
        const actions = def.crud === true ? ['list', 'read', 'create', 'update', 'delete'] : Array.isArray(def.crud) ? def.crud : [];
        const can = (a) => actions.includes(a) && !(def.policy[a]?.length === 1 && def.policy[a][0] === 'none');
        const label = def.description ?? def.name;
        const id = { type: 'string', description: `${def.name} id` };
        const include = { type: 'string', description: 'Comma separated reference fields to expand' };
        if (can('list')) {
          const filterable = Object.entries(def.fields).filter(([, f]) => f.filterOps.length).map(([k, f]) => `${k} (${f.filterOps.join('/')})`);
          list.push({
            name: `${def.name}_list`,
            description: `List ${label} records. Filterable: ${filterable.join(', ') || 'none'}.`,
            inputSchema: {
              type: 'object',
              properties: {
                q: { type: 'string', description: 'Search text' },
                filter: { type: 'object', additionalProperties: { type: 'string' }, description: 'e.g. { "status": "published", "price[gte]": "10" }' },
                sort: { type: 'string', description: 'e.g. "-createdAt"' },
                page: { type: 'integer', minimum: 1 },
                limit: { type: 'integer', minimum: 1, maximum: config.pagination.maxLimit },
                include,
              },
            },
            annotations: { readOnlyHint: true },
          });
        }
        if (can('read')) list.push({ name: `${def.name}_get`, description: `Get one ${label} by id.`, inputSchema: { type: 'object', properties: { id, include }, required: ['id'] }, annotations: { readOnlyHint: true } });
        if (can('create')) list.push({ name: `${def.name}_create`, description: `Create a ${label}.`, inputSchema: { type: 'object', properties: { data: resourceJSONSchema(def, 'create') }, required: ['data'] } });
        if (can('update')) list.push({ name: `${def.name}_update`, description: `Update fields of a ${label}.`, inputSchema: { type: 'object', properties: { id, data: resourceJSONSchema(def, 'update') }, required: ['id', 'data'] } });
        if (can('delete')) list.push({ name: `${def.name}_delete`, description: `Delete a ${label}.`, inputSchema: { type: 'object', properties: { id }, required: ['id'] }, annotations: { destructiveHint: true } });
      }
      return list;
    }

    async function callTool(req, name, args = {}) {
      const m = /^([\w-]+)_(list|get|create|update|delete)$/.exec(name);
      const entry = m && exposed().find((e) => e.def.name === m[1]);
      if (!entry) return { content: [{ type: 'text', text: `Unknown tool ${name}` }], isError: true };
      const base = `${config.apiPrefix}${entry.def.path}`;
      const qs = (params) => {
        const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '').map(([k, v]) => [k, String(v)]));
        return s.size ? `?${s}` : '';
      };
      const id = encodeURIComponent(String(args.id ?? ''));
      const calls = {
        list: ['GET', `${base}${qs({ ...(args.filter ?? {}), q: args.q, sort: args.sort, page: args.page, limit: args.limit, include: args.include })}`],
        get: ['GET', `${base}/${id}${qs({ include: args.include })}`],
        create: ['POST', base, args.data],
        update: ['PATCH', `${base}/${id}`, args.data],
        delete: ['DELETE', `${base}/${id}`],
      };
      const [method, path, body] = calls[m[2]];
      const res = await fetch(`http://127.0.0.1:${req.socket.localPort}${path}`, {
        method,
        headers: {
          ...(req.headers.authorization ? { authorization: req.headers.authorization } : {}),
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          'x-request-id': `${req.id}-mcp`,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = res.status === 204 ? JSON.stringify({ ok: true }) : await res.text();
      return { content: [{ type: 'text', text }], isError: res.status >= 400 };
    }

    async function handle(req, msg) {
      const { id, method, params } = msg ?? {};
      if (id === undefined) return null;
      const ok = (result) => ({ jsonrpc: '2.0', id, result });
      switch (method) {
        case 'initialize':
          return ok({
            protocolVersion: PROTOCOLS.includes(params?.protocolVersion) ? params.protocolVersion : PROTOCOLS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: config.app.name, version: config.app.version },
            instructions: `Tools for the ${config.app.name} API. Each tool maps to a REST endpoint and obeys its access rules.`,
          });
        case 'ping':
          return ok({});
        case 'tools/list':
          return ok({ tools: tools() });
        case 'tools/call':
          return ok(await callTool(req, params?.name, params?.arguments));
        default:
          return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    }

    calm.use(async (req, res, next) => {
      if (req.path !== '/mcp') return next();
      // DNS rebinding protection required by the MCP spec: reject foreign origins.
      const origin = req.get('origin');
      // Only an explicit allowlist counts here: CORS '*' is not a reason to trust any site.
      const allowed = Array.isArray(config.cors.origins) && config.cors.origins.includes(origin);
      if (origin && !allowed && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return res.status(403).json({ error: 'Origin not allowed' });
      if (req.method !== 'POST') return res.set('Allow', 'POST').status(405).json({ error: 'Use POST (stateless Streamable HTTP)' });

      const body = await readJson(req).catch(() => undefined);
      if (body === undefined) return res.status(400).json({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      if (calm.app.auth && req.headers.authorization) {
        const failed = await new Promise((resolve) => calm.app.auth.service.authenticate(req, res, (err) => resolve(err)));
        if (failed) return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: failed.message } });
      }
      const messages = Array.isArray(body) ? body : [body];
      const replies = (await Promise.all(messages.map((m) => handle(req, m)))).filter(Boolean);
      if (!replies.length) return res.status(202).end();
      res.json(Array.isArray(body) ? replies : replies[0]);
    });
  },
});

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) reject(new Error('too large'));
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
