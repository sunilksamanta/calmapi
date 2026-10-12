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

import { parsePolicy, evaluatePolicy, isOwner, describePolicy } from '../resource/policy.js';
import { validateInput, serialize } from '../resource/resource.js';
import { isObjectId } from '../resource/fields.js';
import { unauthorized, forbidden, notFound, validationError } from '../errors.js';
import { kebab } from '../utils/strings.js';

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

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
      summary: opts.summary,
      description: opts.description,
      tags: opts.tags,
      input: opts.input ?? null,
      status: opts.status ?? 200,
      output: opts.output ?? null,
      rateLimit: opts.rateLimit ?? null,
      hidden: Boolean(opts.hidden),
      /** Express middleware run after the policy pre-check, before the handler (e.g. multer). */
      middleware: opts.middleware ?? [],
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

/** Build the ctx object every handler, hook and policy function receives. */
export function createContext(app, req, res, extra = {}) {
  const ctx = {
    req,
    res,
    params: req.params,
    query: req.query,
    body: req.body,
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
    if (!req.user && !anonymousCanPass) return next(unauthorized());
    next();
  };
}

/** Express handler for one route record. */
export function toExpressHandler(app, route) {
  return async (req, res) => {
    req.calmRoute = route;
    const entry = route.resource ? app.registry.get(route.resource) : null;
    const ctx = createContext(app, req, res, {
      route,
      resource: entry?.def ?? null,
      service: entry?.service ?? null,
    });

    for (const guard of app.hooks.guards) await guard(ctx, route);
    if (entry && req.params.id !== undefined) {
      ctx.doc = await authorizeItem(entry, route.policy, route.action, ctx, req.params.id);
    } else {
      const decision = await evaluatePolicy(route.policy, { user: ctx.user, action: route.action, req, body: req.body });
      if (!decision.allow) throw ctx.user ? forbidden() : unauthorized();
      ctx.scope = decision.scope ?? null;
    }

    if (route.input) ctx.body = await validateWithInput(route.input, req.body, ctx);
    let result = await route.handler(ctx);
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
export async function authorizeItem(entry, tokens, action, ctx, id) {
  const { def, service } = entry;
  const anonymousCanPass = tokens?.some((t) => t === 'public' || typeof t === 'function');
  if (!ctx.user && !anonymousCanPass) throw unauthorized();
  if (!isObjectId(String(id))) throw notFound(`${def.name} not found`);

  const doc = await service.model.findOne(service.filterFor({ ...ctx, scope: null }, { _id: id })).lean();
  if (!doc) throw notFound(`${def.name} not found`);

  const decision = await evaluatePolicy(tokens, { user: ctx.user, action, doc, req: ctx.req });
  if (decision.allow && (!decision.scope || isOwner(def, doc, ctx.user))) {
    ctx.scope = decision.scope ?? null;
    return doc;
  }
  if (!ctx.user) throw unauthorized();
  if (action !== 'read') {
    const read = await evaluatePolicy(def.policy.read, { user: ctx.user, action: 'read', doc, req: ctx.req });
    if (read.allow && (!read.scope || isOwner(def, doc, ctx.user))) throw forbidden();
  }
  throw notFound(`${def.name} not found`);
}

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
