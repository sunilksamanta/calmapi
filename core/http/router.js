// Route builder with return-value handlers.
//
//   export default (r) => {
//     r.post('/:id/publish', { policy: 'owner | admin', summary: 'Publish a post' }, async (ctx) => {
//       return ctx.service.publish(ctx.params.id, ctx);   // returned value -> 200 { data }
//     });
//   };
//
// Throw a CalmError (or any error) to fail; return undefined for 204; return
// ctx.reply(data, { status: 201, meta }) to control the response.

import { fileURLToPath } from 'node:url';
import { parsePolicy, evaluatePolicy, isOwner, describePolicy, explainOwner } from '../resource/policy.js';
import { validateInput, serialize } from '../resource/resource.js';
import { isObjectId } from '../resource/fields.js';
import { unauthorized, forbidden, notFound, validationError } from '../errors.js';
import { kebab, shortId } from '../utils/strings.js';
import { trace, traced } from '../context.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const HERE = fileURLToPath(import.meta.url);

/** Line of the r.get()/r.post() call that is defining a route: the first stack frame outside this file. Boot only. */
function definitionLine() {
  for (const frame of (new Error().stack ?? '').split('\n').slice(1)) {
    const m = /:(\d+):\d+\)?\s*$/.exec(frame);
    if (m && !frame.includes(HERE)) return Number(m[1]);
  }
  return null;
}

export class Reply {
  constructor(data, { status, meta, headers } = {}) {
    this.data = data;
    this.status = status;
    this.meta = meta;
    this.headers = headers;
  }
}

export class RouteBuilder {
  /**
   * @param {{ app: object, prefix?: string, entry?: object, source: string, file?: string }} options
   */
  constructor({ app, prefix = '', entry = null, source, file }) {
    this.app = app;
    this.prefix = prefix;
    this.entry = entry;
    this.source = source;
    this.file = file;
    this.routes = [];
    for (const method of METHODS) {
      this[method] = (path, opts, handler) => this.add(method, path, opts, handler);
    }
  }

  add(method, path, opts, handler) {
    if (typeof opts === 'function') [handler, opts] = [opts, {}];
    if (typeof handler !== 'function') throw new Error(`${method.toUpperCase()} ${path}: handler must be a function`);
    const explicit = opts.policy !== undefined;
    const route = {
      method: method.toUpperCase(),
      path: joinPath(this.prefix, path),
      policy: parsePolicy(explicit ? opts.policy : 'authenticated'),
      policyExplicit: explicit,
      action: opts.action ?? 'custom',
      resource: this.entry?.def.name ?? null,
      source: this.source,
      file: this.file,
      line: definitionLine(),
      summary: opts.summary,
      description: opts.description,
      tags: opts.tags,
      input: opts.input ?? null,
      status: opts.status ?? 200,
      output: opts.output ?? null,
      /** Documentation only, for handlers that validate on their own: { body, response } as JSON Schema (response is the `data` payload). */
      openapi: opts.openapi ?? null,
      rateLimit: opts.rateLimit ?? null,
      hidden: Boolean(opts.hidden),
      /** Express middleware run after the policy pre-check, before the handler (e.g. multer). */
      middleware: opts.middleware ?? [],
      /** A permission name for credentials with scopes (API keys), e.g. 'reports:export'. */
      scope: opts.scope ?? null,
      /** Anything blocks want to read from the route in guards: { flag: 'beta', audit: false }. */
      meta: opts.meta ?? {},
      /** Keep the exact bytes of a JSON body as ctx.rawBody (a Buffer), to check a signature over them (Stripe, GitHub...). */
      rawBody: Boolean(opts.rawBody),
      handler,
    };
    route.policyLabel = describePolicy(route.policy);
    this.routes.push(route);
    return this;
  }
}

export const joinPath = (...parts) => {
  const path = parts.filter(Boolean).join('/').replace(/\/+/g, '/').replace(/\/$/, '');
  return path.startsWith('/') ? path || '/' : `/${path}`;
};

/**
 * For express.json({ verify }): true when the request goes to a route declared with
 * { rawBody: true }. Matched by method and path (':param' is one segment) before routing
 * runs, so only those requests keep a second copy of their body in memory.
 */
export function rawBodyMatcher(routes) {
  const wanted = routes.filter((r) => r.rawBody).map((r) => ({ method: r.method, segments: r.path.split('/').filter(Boolean) }));
  if (!wanted.length) return null;
  return (req) => {
    const segments = req.path.split('/').filter(Boolean);
    return wanted.some((w) => w.method === req.method && w.segments.length === segments.length && w.segments.every((s, i) => s.startsWith(':') || s === segments[i]));
  };
}

/** Build the ctx object every handler, hook and policy function receives. */
export function createContext(app, req, res, extra = {}) {
  const ctx = {
    req,
    res,
    params: req.params,
    query: req.query,
    body: req.body,
    /** The body as received (Buffer) on routes declared with { rawBody: true }, otherwise null. */
    rawBody: req.rawBody ?? null,
    user: req.user ?? null,
    session: req.session ?? null,
    /** How this request authenticated: { via: 'session' | 'api-key' | ..., scopes, id } or null. */
    auth: req.auth ?? null,
    requestId: req.id,
    app,
    config: app.config,
    log: app.log,
    events: app.events,
    push: app.push,
    services: app.services.proxy,
    reply: (data, opts) => new Reply(data, opts),
    /** Serialize a stored document with a resource's visibility rules (defaults to this route's resource). */
    serialize: (doc, resourceName) => {
      const name = resourceName ?? ctx.resource?.name;
      const entry = name ? app.registry.get(name) : null;
      if (!entry) throw new Error('ctx.serialize(doc, resourceName): unknown resource');
      return serialize(entry.def, doc, { user: ctx.user, registry: app.registry });
    },
    ...extra,
  };
  return ctx;
}

/**
 * Cheap policy check that runs before route middleware, so for example an upload
 * parser never runs for signed-out users. Record-level rules are checked later.
 */
export function policyPreCheck(route) {
  return async (req, _res, next) => {
    const anonymousCanPass = route.policy?.some((t) => t === 'public' || typeof t === 'function');
    if (!req.user && !anonymousCanPass) {
      trace({ ...policyStep(route, null), outcome: 'denied', detail: [], note: 'no user and the policy needs one: 401' });
      return next(unauthorized());
    }
    next();
  };
}

/** The policy step of a route: its label and where it is written (resource file for CRUD, the route call otherwise). */
function policyStep(route, entry) {
  const crud = route.source === 'crud';
  return { kind: 'policy', name: route.policyLabel, file: route.file ?? null, line: (crud ? entry?.lines?.policy : route.line) ?? null };
}

const handlerName = (route, entry) => {
  if (route.source === 'crud') return `${entry?.service?.constructor?.name ?? 'ResourceService'}.${CRUD_METHOD[route.action] ?? route.action}`;
  return route.handler.name || route.summary || `${route.method} ${route.path}`;
};
const CRUD_METHOD = { list: 'list', read: 'get', create: 'create', update: 'update', delete: 'remove' };

/**
 * Run calm.guard() hooks. A guard stops the request by throwing, by returning a Reply
 * (ctx.reply(data, { status })), or by sending the response itself (res.end()). Resolves to
 * true when the request has been answered.
 */
async function runGuards(app, ctx, route) {
  for (const guard of app.hooks.guards) {
    const answered = (out) => out instanceof Reply || ctx.res.headersSent || ctx.res.writableEnded;
    const out = await traced({ kind: 'guard', name: guard.calmName ?? guard.name ?? 'guard', file: guard.calmFile ?? null }, () => guard(ctx, route), (out) => (answered(out) ? { outcome: 'answered' } : null));
    if (out instanceof Reply) {
      send(ctx.res, out, out.status ?? 200);
      return true;
    }
    if (ctx.res.headersSent || ctx.res.writableEnded) return true;
  }
  return false;
}

const routeContext = (app, route, req, res) => {
  const entry = route.resource ? app.registry.get(route.resource) : null;
  return createContext(app, req, res, { route, resource: entry?.def ?? null, service: entry?.service ?? null });
};

/**
 * Guards (calm.guard) before route middleware, so a request a guard refuses never has its
 * upload parsed. The context is kept for the handler, so what guards attach stays on it.
 */
export function guardsFirst(app, route) {
  return async (req, res, next) => {
    req.calmRoute = route;
    const ctx = routeContext(app, route, req, res);
    if (await runGuards(app, ctx, route)) return;
    req.calmCtx = ctx;
    next();
  };
}

/** Express handler for one route record. */
export function toExpressHandler(app, route) {
  return async (req, res) => {
    req.calmRoute = route;
    const entry = route.resource ? app.registry.get(route.resource) : null;
    let ctx = req.calmCtx;
    if (ctx) Object.assign(ctx, { body: req.body, params: req.params, query: req.query }); // after middleware such as multer
    else {
      ctx = routeContext(app, route, req, res);
      if (await runGuards(app, ctx, route)) return;
    }
    if (entry && req.params.id !== undefined) {
      ctx.doc = await authorizeItem(entry, route.policy, route.action, ctx, req.params.id, route);
    } else {
      const decision = await evaluatePolicy(route.policy, { user: ctx.user, action: route.action, req, body: req.body });
      trace({ ...policyStep(route, entry), outcome: decision.allow ? 'passed' : 'denied', detail: decision.trace ?? [], note: decision.allow ? undefined : `no alternative allows it: ${ctx.user ? '403' : '401'}` });
      if (!decision.allow) throw ctx.user ? forbidden() : unauthorized();
      ctx.scope = decision.scope ?? null;
    }

    if (route.input) ctx.body = await traceInput(route.file, () => validateWithInput(route.input, req.body, ctx));
    let result = await traced({ kind: 'handler', name: handlerName(route, entry), file: route.file ?? null, line: route.line ?? null }, () => route.handler(ctx));
    // Safety net: raw documents returned from a resource route are serialized with the
    // resource's visibility rules, so hidden fields cannot slip out of custom routes.
    if (entry && route.source !== 'crud') {
      if (result instanceof Reply) result.data = await autoSerialize(result.data, ctx);
      else result = await autoSerialize(result, ctx);
    }
    send(res, result, route.status);
  };
}

const looksLikeDoc = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && v._id !== undefined;

async function autoSerialize(value, ctx) {
  if (Array.isArray(value) && value.length && value.every(looksLikeDoc)) return Promise.all(value.map((d) => ctx.serialize(d)));
  if (looksLikeDoc(value)) return ctx.serialize(value);
  return value;
}

/**
 * Authorize an action on one record. Loads the record (respecting the service's scope()),
 * then applies the policy with the record in hand.
 * Unauthorized users get 401; users who can see the record but not change it get 403;
 * everyone else gets 404 so ids of private records are not revealed.
 */
export async function authorizeItem(entry, tokens, action, ctx, id, route = null) {
  const { def, service } = entry;
  const step = route ? policyStep(route, entry) : { kind: 'policy', name: describePolicy(tokens), file: entry.files?.resource ?? null, line: entry.lines?.policy ?? null };
  const load = { kind: 'service', name: `load ${def.name} ${shortId(id)}`, file: 'calm/http/router.js' };
  const anonymousCanPass = tokens?.some((t) => t === 'public' || typeof t === 'function');
  if (!ctx.user && !anonymousCanPass) {
    trace({ ...step, outcome: 'denied', detail: [], note: 'no user and the policy needs one: 401' });
    throw unauthorized();
  }
  if (!isObjectId(String(id))) {
    trace({ ...load, outcome: 'failed', detail: `"${String(id).slice(0, 40)}" is not an id: 404` });
    throw notFound(`${def.name} not found`);
  }

  const doc = await service.model.findOne(service.filterFor({ ...ctx, scope: null }, { _id: id })).lean();
  trace({ ...load, outcome: doc ? 'passed' : 'failed', detail: doc ? `found (within ${service.constructor.name}.scope)` : `no ${def.name} with this id within ${service.constructor.name}.scope: 404` });
  if (!doc) throw notFound(`${def.name} not found`);

  const decision = await evaluatePolicy(tokens, { user: ctx.user, action, doc, req: ctx.req });
  if (decision.scope) explainOwner(decision.trace, def, doc, ctx.user);
  const decide = (outcome, note) => trace({ ...step, outcome, detail: decision.trace ?? [], note });
  if (decision.allow && (!decision.scope || isOwner(def, doc, ctx.user))) {
    decide('passed');
    ctx.scope = decision.scope ?? null;
    return doc;
  }
  if (!ctx.user) {
    decide('denied', 'no alternative allows an anonymous caller: 401');
    throw unauthorized();
  }
  if (action !== 'read') {
    const read = await evaluatePolicy(def.policy.read, { user: ctx.user, action: 'read', doc, req: ctx.req, explain: false });
    if (read.allow && (!read.scope || isOwner(def, doc, ctx.user))) {
      decide('denied', `the user may read this ${def.name} but not ${action} it: 403`);
      throw forbidden();
    }
  }
  decide('denied', `the user may not even read this ${def.name}, so the id is not confirmed: 404`);
  throw notFound(`${def.name} not found`);
}

/** Validation as a step: how many fields passed, or which ones failed. */
export const traceInput = (file, validate) =>
  traced({ kind: 'input', name: 'validate', file: file ?? null }, validate, (out) => {
    const n = out && typeof out === 'object' ? Object.keys(out).length : 0;
    return { detail: `${n} field${n === 1 ? '' : 's'}` };
  });

async function validateWithInput(input, body, ctx) {
  if (input['~standard']) {
    const res = await input['~standard'].validate(body);
    if (res.issues?.length) {
      const details = {};
      for (const issue of res.issues) {
        const key = (issue.path ?? []).map((p) => (typeof p === 'object' ? p.key : p)).join('.') || 'body';
        details[key] ??= issue.message;
      }
      throw validationError(details);
    }
    return res.value;
  }
  return validateInput({ name: 'input', fields: input }, body ?? {}, {
    mode: 'create',
    user: ctx.user,
    unknownFields: ctx.config.unknownFields,
  });
}

export function send(res, result, defaultStatus = 200) {
  if (res.headersSent || res.writableEnded) return;
  if (result instanceof Reply) {
    for (const [k, v] of Object.entries(result.headers ?? {})) res.setHeader(k, v);
    const status = result.status ?? defaultStatus;
    if (result.data === undefined) return void res.status(status).end();
    return void res.status(status).json(result.meta ? { data: result.data, meta: result.meta } : { data: result.data });
  }
  if (result === undefined) return void res.status(204).end();
  res.status(defaultStatus).json({ data: result });
}

/** Lazy access to services by name: ctx.services.productCategory or ctx.services['product-category'] */
export function servicesProxy(services) {
  return new Proxy(
    {},
    {
      get: (_, name) => (typeof name === 'string' ? services.get(kebab(name)) : undefined),
      has: (_, name) => typeof name === 'string' && services.has(kebab(name)),
    },
  );
}
