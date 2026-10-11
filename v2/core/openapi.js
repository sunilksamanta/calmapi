// OpenAPI 3.1 document generated from your resources and routes. Nothing to annotate:
// fields, policies and route options already say everything.

import { resourceJSONSchema } from './resource/resource.js';
import { toJSONSchema } from './resource/fields.js';
import { pascal, camel, pluralize } from './utils/strings.js';

const ERROR = {
  type: 'object',
  properties: {
    error: {
      type: 'object',
      required: ['code', 'message'],
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: { type: 'string' } },
        requestId: { type: 'string' },
      },
    },
  },
};

export function buildOpenAPI(app) {
  const { config, registry, routes } = app;
  const schemas = { Error: ERROR };
  for (const { def } of registry.values()) {
    const base = pascal(def.name);
    schemas[base] = resourceJSONSchema(def, 'output');
    schemas[`${base}Create`] = resourceJSONSchema(def, 'create');
    schemas[`${base}Update`] = resourceJSONSchema(def, 'update');
  }

  const paths = {};
  const ids = new Set();
  for (const route of routes) {
    if (route.hidden || route.source === 'devtools') continue;
    const path = `${config.apiPrefix}${route.path}`.replace(/:(\w+)/g, '{$1}');
    const op = operation(route, registry);
    op.operationId = uniqueId(operationId(route, registry), ids);
    (paths[path] ??= {})[route.method.toLowerCase()] = op;
  }

  return {
    openapi: '3.1.0',
    info: { title: config.app.name, version: config.app.version },
    servers: [{ url: config.app.url }],
    paths,
    components: {
      schemas,
      securitySchemes: { session: { type: 'http', scheme: 'bearer', description: 'Session token from POST /auth/login' } },
    },
  };
}

function operation(route, registry) {
  const entry = route.resource ? registry.get(route.resource) : null;
  const name = entry ? pascal(entry.def.name) : null;
  const ref = (s) => ({ $ref: `#/components/schemas/${s}` });
  const op = {
    summary: route.summary,
    description: [route.description, `Access: \`${route.policyLabel}\``].filter(Boolean).join('\n\n'),
    tags: route.tags ?? [route.resource ?? route.source],
    responses: {},
  };
  op.security = route.policy?.includes('public') ? [] : [{ session: [] }];

  const params = [...route.path.matchAll(/:(\w+)/g)].map(([, p]) => ({ name: p, in: 'path', required: true, schema: { type: 'string' } }));
  if (route.action === 'list' && entry) params.push(...listParams(entry.def));
  if (params.length) op.parameters = params;

  const inputSchema = route.inputSchema ?? route.input;
  if (inputSchema === 'create' || inputSchema === 'update') {
    op.requestBody = { required: true, content: { 'application/json': { schema: ref(`${name}${inputSchema === 'create' ? 'Create' : 'Update'}`) } } };
  } else if (inputSchema && !inputSchema['~standard']) {
    const properties = {};
    const required = [];
    for (const [k, field] of Object.entries(inputSchema)) {
      properties[k] = toJSONSchema(field);
      if (field.opts.required) required.push(k);
    }
    op.requestBody = { required: true, content: { 'application/json': { schema: { type: 'object', properties, ...(required.length ? { required } : {}) } } } };
  } else if (['POST', 'PUT', 'PATCH'].includes(route.method) && route.source !== 'crud') {
    op.requestBody = { content: { 'application/json': { schema: { type: 'object' } } } };
  }

  const ok = String(route.method === 'DELETE' && route.source === 'crud' ? 204 : route.status);
  if (ok === '204') op.responses[ok] = { description: 'Done' };
  else if (route.output === 'list') {
    op.responses[ok] = {
      description: 'A page of records',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            properties: {
              data: { type: 'array', items: ref(name) },
              meta: { type: 'object', properties: { total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, pages: { type: 'integer' } } },
            },
          },
        },
      },
    };
  } else if (route.output === 'item' && name) {
    op.responses[ok] = { description: 'The record', content: { 'application/json': { schema: { type: 'object', properties: { data: ref(name) } } } } };
  } else {
    op.responses[ok] = { description: 'Success', content: { 'application/json': { schema: { type: 'object', properties: { data: {} } } } } };
  }

  const err = (description) => ({ description, content: { 'application/json': { schema: ref('Error') } } });
  if (op.security.length) op.responses['401'] = err('Not signed in');
  if (route.action === 'list') op.responses['400'] = err('Invalid query');
  if (route.input || route.inputSchema) op.responses['422'] = err('Validation failed');
  if (route.path.includes(':id')) op.responses['404'] = err('Not found');
  if (route.rateLimit) op.responses['429'] = err('Rate limited');
  return op;
}

const CRUD_VERB = { list: 'list', read: 'get', create: 'create', update: 'update', delete: 'delete' };

function operationId(route, registry) {
  const entry = route.resource ? registry.get(route.resource) : null;
  if (route.source === 'crud' && entry) {
    const name = route.action === 'list' ? pascal(pluralize(entry.def.name)) : pascal(entry.def.name);
    return `${CRUD_VERB[route.action]}${name}`;
  }
  const words = route.path.split('/').filter(Boolean).map((seg) => (seg.startsWith(':') ? `by-${seg.slice(1)}` : seg));
  return camel([route.method.toLowerCase(), ...words].join('-'));
}

function uniqueId(id, seen) {
  let out = id;
  for (let i = 2; seen.has(out); i++) out = `${id}${i}`;
  seen.add(out);
  return out;
}

function listParams(def) {
  const params = [
    { name: 'page', in: 'query', schema: { type: 'integer', minimum: 1, default: 1 } },
    { name: 'limit', in: 'query', schema: { type: 'integer', minimum: 1 } },
    { name: 'sort', in: 'query', description: 'Comma separated, prefix with - for descending', schema: { type: 'string' } },
    { name: 'fields', in: 'query', description: 'Comma separated list of fields to return', schema: { type: 'string' } },
  ];
  if (Object.values(def.fields).some((field) => field.opts.searchable)) {
    params.push({ name: 'q', in: 'query', description: 'Search text', schema: { type: 'string', maxLength: 100 } });
  }
  for (const [key, field] of Object.entries(def.fields)) {
    for (const op of field.filterOps) {
      params.push({ name: op === 'eq' ? key : `${key}[${op}]`, in: 'query', schema: op === 'exists' ? { type: 'boolean' } : { type: 'string' } });
    }
  }
  return params;
}
