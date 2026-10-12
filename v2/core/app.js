import { createServer } from 'node:http';
import { styleText } from 'node:util';
import express from 'express';
import mongoose from 'mongoose';
import { loadConfig, deepMerge } from './config.js';
import { createLogger } from './logger.js';
import { createEvents } from './events.js';
import { createMailer } from './mail.js';
import { createPush } from './push.js';
import { loadResources, loadBlocks, loadAppRoutes } from './loader.js';
import { compileResource } from './resource/resource.js';
import { crudRoutes } from './resource/routes.js';
import { RouteBuilder, toExpressHandler, servicesProxy, policyPreCheck, guardsFirst } from './http/router.js';
import { registerPolicy } from './resource/policy.js';
import { requestContext, securityHeaders, cors, rateLimit, createMemoryStore, accessLog, jsonGuard } from './http/middleware.js';
import { setupAuth } from './auth/index.js';
import { buildOpenAPI } from './openapi.js';
import { runtimeChecks } from './doctor.js';
import { exposureMatrix, exposureFindings } from './security/exposure.js';
import { toHttpError, notFound } from './errors.js';
import { parseKeys, createCipher } from './security/encryption.js';

/**
 * Build a CalmAPI application from a project folder.
 * Nothing touches the network until start()/listen().
 *
 * @param {{ root?: string, config?: object }} [options]
 */
export async function createApp({ root = process.cwd(), config: overrides = {} } = {}) {
  const config = await loadConfig(root, overrides);
  const log = createLogger(config.log);
  const events = createEvents(log);
  const db = new mongoose.Mongoose();
  db.set('strictQuery', true);
  db.set('autoIndex', config.db.autoIndex);

  const keys = parseKeys(config.encryption?.keys ?? process.env.CALM_ENCRYPTION_KEYS ?? process.env.CALM_ENCRYPTION_KEY ?? '');
  const cipher = keys.length ? createCipher(keys) : null;

  const registry = new Map();
  const services = {
    get(name) {
      const entry = registry.get(name);
      if (!entry) throw new Error(`Unknown service "${name}". Known: ${[...registry.keys()].join(', ')}`);
      return entry.service;
    },
    has: (name) => registry.has(name),
  };
  services.proxy = servicesProxy(services);

  const background = new Set();
  const hooks = { start: [], shutdown: [], resource: [], service: [], middleware: [], routes: [], doctor: [], login: [], authenticators: [], guards: [], devtools: {} };
  const rateStore = createMemoryStore();

  const app = {
    root,
    config,
    log,
    events,
    mongoose: db,
    registry,
    services,
    routes: [],
    plugins: [],
    ext: {},
    hooks,
    rateStore,
    cipher,
    mailer: createMailer({ log, mode: config.mode, from: config.mail?.from ?? `${config.app.name} <no-reply@localhost>` }),
    push: createPush({ log, mode: config.mode, events }),
    express: null,
    server: null,
    auth: null,
    started: false,

    model: (name) => services.get(name).model,
    service: (name) => services.get(name),
    openapi: () => buildOpenAPI(app),
    doctor: async () => [...runtimeChecks(app), ...exposureFindings(await exposureMatrix(app))],
    exposure: () => exposureMatrix(app),

    /** Run work after the response, tracked so tests and shutdown can wait for it. */
    background(fn) {
      const p = new Promise((resolve) => setImmediate(resolve))
        .then(fn)
        .catch((err) => log.error('Background task failed', { err }))
        .finally(() => background.delete(p));
      background.add(p);
      return p;
    },
    async idle() {
      while (background.size) await Promise.allSettled([...background]);
      await events.idle();
    },

    async start() {
      if (app.started) return app;
      await connect(app);
      await Promise.all([...registry.values()].map((entry) => entry.model.init()));
      for (const fn of hooks.start) await fn(app);
      app.started = true;
      return app;
    },

    async listen(port = config.port, host = config.host) {
      await app.start();
      app.server = createServer(app.express);
      await new Promise((resolve, reject) => {
        app.server.once('error', reject);
        app.server.listen(port, host, resolve);
      });
      installShutdown(app);
      printBanner(app);
      return app.server;
    },

    async stop() {
      // 1. stop accepting connections, 2. shutdown hooks (they also end SSE streams and
      // workers, which would otherwise keep the server open), 3. wait for in-flight requests.
      let closed = Promise.resolve();
      let timer;
      if (app.server) {
        closed = new Promise((resolve) => app.server.close(resolve));
        app.server.closeIdleConnections?.();
        timer = setTimeout(() => app.server?.closeAllConnections?.(), config.shutdownTimeoutMs);
      }
      for (const fn of [...hooks.shutdown].reverse()) {
        try {
          await fn(app);
        } catch (err) {
          log.error('Shutdown hook failed', { err });
        }
      }
      await closed;
      clearTimeout(timer);
      app.server = null;
      await app.idle();
      await db.disconnect();
      app.started = false;
    },
  };

  // 1. Resources and blocks from disk
  const loaded = await loadResources(root);
  const blocks = [...(await loadBlocks(root)), ...(config.plugins ?? [])];

  // 2. Plugins set themselves up before models compile, so they can extend resources.
  for (const plugin of blocks) {
    const options = deepMerge(plugin.options ?? {}, config.blocks?.[plugin.name] ?? {});
    const api = pluginApi(app, plugin, options);
    await plugin.setup(api, options);
    app.plugins.push({ name: plugin.name, file: plugin.file ?? null, env: describeEnv(plugin, config.mode), options });
  }
  hooks.doctor.push(() => envFindings(app));

  // 3. Compile resources
  for (const item of loaded) {
    let def = item.def;
    for (const hook of hooks.resource) {
      const copy = { ...def, fields: { ...def.fields }, options: { ...def.options } };
      def = Object.freeze((await hook(copy)) ?? copy);
    }
    if (registry.has(def.name)) throw new Error(`Two resources are named "${def.name}"`);
    const model = compileResource(def, db, { cipher });
    const entry = { def, model, files: item.files, routesFn: item.routes };
    entry.service = new item.ServiceClass({ def, model, app });
    registry.set(def.name, entry);
  }
  for (const entry of registry.values()) for (const fn of hooks.service) await fn(entry, app);

  // 4. Routes: auth, plugins, app routes, then each resource (custom before CRUD so
  //    '/posts/featured' is never swallowed by '/posts/:id').
  if (config.auth.enabled && registry.has('user')) {
    app.auth = setupAuth(app);
    app.routes.push(...app.auth.routes);
  }
  for (const { fn, options } of hooks.routes) {
    const r = new RouteBuilder({ app, prefix: options.prefix ?? '', source: options.source, file: options.file });
    await fn(r);
    app.routes.push(...r.routes);
  }
  const appRoutes = await loadAppRoutes(root);
  if (appRoutes) {
    const r = new RouteBuilder({ app, source: 'app', file: appRoutes.file });
    await appRoutes.fn(r);
    app.routes.push(...r.routes);
  }
  for (const entry of registry.values()) {
    if (entry.routesFn) {
      const r = new RouteBuilder({ app, prefix: entry.def.path, entry, source: 'custom', file: entry.files.routes });
      await entry.routesFn(r);
      app.routes.push(...r.routes);
    }
    app.routes.push(...crudRoutes(app, entry));
  }
  warnDuplicates(app);

  app.express = await buildExpress(app);
  return app;
}

/** Which declared env vars a block has, for devtools. Never includes secret values. */
function describeEnv(plugin, mode) {
  return Object.entries(plugin.env ?? {}).map(([key, spec]) => {
    const set = process.env[key] !== undefined && process.env[key] !== '';
    const required = spec.required === true || (spec.required === 'production' && mode === 'production');
    return { key, set, required, requiredIn: spec.required || null, secret: Boolean(spec.secret), description: spec.description ?? null, value: set && !spec.secret ? process.env[key] : null };
  });
}

/** Doctor findings for env vars blocks declared but nobody set. */
function envFindings(app) {
  const findings = [];
  for (const p of app.plugins) {
    for (const v of p.env ?? []) {
      if (v.set || !v.requiredIn) continue;
      const missingNow = v.requiredIn === true || app.config.mode === 'production';
      findings.push({
        level: missingNow ? 'error' : 'info',
        id: `env-${v.key}`,
        title: `${v.key} is not set (${p.name} block)`,
        detail: `${v.description ? `${v.description}. ` : ''}${missingNow ? 'The block needs it.' : 'Needed in production.'} Add it to .env.`,
        file: p.file,
      });
    }
  }
  return findings;
}

function pluginApi(app, plugin, options = {}) {
  return {
    app,
    name: plugin.name,
    config: app.config,
    /** This block's settings: definePlugin options merged with calm.config.js blocks.<name>. */
    options,
    /** Read an environment variable the block declared in definePlugin({ env }). */
    env: (key, fallback) => {
      if (plugin.env && !(key in plugin.env)) throw new Error(`Block ${plugin.name} reads ${key} but does not declare it in definePlugin({ env })`);
      const value = process.env[key];
      return value === undefined || value === '' ? fallback : value;
    },
    log: app.log,
    events: app.events,
    mongoose: app.mongoose,
    mailer: app.mailer,
    push: app.push,
    on: (pattern, fn) => app.events.on(pattern, fn),
    onResource: (fn) => app.hooks.resource.push(fn),
    /** Called with { def, model, service } for every resource once services exist. */
    onService: (fn) => app.hooks.service.push(fn),
    /**
     * After a correct password, before a session is created. Return an object (e.g.
     * { mfaRequired: true, mfaToken }) to answer the login with a challenge instead.
     */
    loginChallenge: (fn) => app.hooks.login.push(fn),
    /**
     * Accept another kind of credential in Authorization: Bearer <token> (API keys, service
     * tokens...). fn(token, req) returns null to pass, or { user, via, scopes, id }.
     */
    authenticate: (fn) => app.hooks.authenticators.push(fn),
    /**
     * Run before every route's policy check: fn(ctx, route). Throw (forbidden(), tooManyRequests()...)
     * to stop the request. For API key scopes, maintenance mode, tenancy...
     */
    guard: (fn) => app.hooks.guards.push(fn),
    /** A named policy usable in resources and routes: calm.policy('member', (ctx) => ...). */
    policy: (name, fn) => registerPolicy(name, fn),
    routes: (fn, options = {}) => app.hooks.routes.push({ fn, options: { source: `block:${plugin.name}`, file: plugin.file, ...options } }),
    use: (fn) => app.hooks.middleware.push(fn),
    onStart: (fn) => app.hooks.start.push(fn),
    onShutdown: (fn) => app.hooks.shutdown.push(fn),
    provide: (key, value) => {
      app.ext[key] = value;
    },
    doctor: (fn) => app.hooks.doctor.push(fn),
    devtools: { panel: (name, fn) => (app.hooks.devtools[name] = fn) },
  };
}

async function buildExpress(app) {
  const { config, log } = app;
  const ex = express();
  ex.disable('x-powered-by');
  ex.set('trust proxy', config.trustProxy);
  ex.set('query parser', 'simple');

  ex.use(requestContext());
  if (config.devtools.enabled) {
    const { setupDevtools } = await import('./devtools/index.js');
    setupDevtools(app, ex);
  }
  ex.use(securityHeaders({ production: config.mode === 'production' }));
  ex.use(cors(config.cors));
  if (config.mode !== 'test') ex.use(accessLog(log));

  ex.get('/health/live', (_req, res) => res.json({ status: 'ok' }));
  ex.get('/health/ready', async (_req, res) => {
    const up = app.mongoose.connection.readyState === 1 && (await app.mongoose.connection.db.admin().ping().then(() => true, () => false));
    res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'unavailable', database: up ? 'up' : 'down' });
  });
  for (const fn of app.hooks.middleware) ex.use(fn);

  const onLimit = (req, name) => app.events.emit('security.rate_limited', { ip: req.ip, path: req.originalUrl, limiter: name });
  const api = express.Router();
  api.use(express.json({ limit: config.bodyLimit }));
  api.use(jsonGuard(config.jsonLimits));
  if (config.rateLimit.enabled) api.use(rateLimit({ store: app.rateStore, ...config.rateLimit.global, name: 'global', onLimit }));
  if (app.auth) api.use(app.auth.service.authenticate);

  const authLimiter = config.rateLimit.enabled
    ? rateLimit({ store: app.rateStore, ...config.rateLimit.auth, name: 'auth', key: (req) => `${req.ip}:${req.path}`, onLimit })
    : null;

  for (const route of app.routes) {
    const chain = [];
    if (route.rateLimit === 'auth' && authLimiter) chain.push(authLimiter);
    else if (route.rateLimit && typeof route.rateLimit === 'object' && config.rateLimit.enabled) {
      chain.push(rateLimit({ store: app.rateStore, name: `${route.method}:${route.path}`, ...route.rateLimit, onLimit }));
    }
    if (route.middleware.length) chain.push(policyPreCheck(route), guardsFirst(app, route), ...route.middleware);
    api[route.method.toLowerCase()](route.path, ...chain, toExpressHandler(app, route));
  }

  if (config.openapi.enabled) api.get(config.openapi.path, (_req, res) => res.json(app.openapi()));
  api.get('/', (_req, res) =>
    res.json({ data: { name: config.app.name, version: config.app.version, openapi: config.openapi.enabled ? `${config.apiPrefix}${config.openapi.path}` : null } }),
  );
  api.use((_req, _res, next) => next(notFound('Route not found')));

  ex.use(config.apiPrefix, api);
  ex.get('/', (_req, res) => res.json({ name: config.app.name, api: config.apiPrefix }));
  ex.use((_req, _res, next) => next(notFound('Route not found')));

  ex.use((err, req, res, _next) => {
    const httpErr = toHttpError(err);
    req.calmError = { original: err, http: httpErr };
    const who = { userId: req.user?.id ?? null, ip: req.ip, method: req.method, path: req.originalUrl };
    if (err?.blockedFields) app.events.emit('security.write_rejected', { ...who, ...err.blockedFields });
    else if (httpErr.status === 403) app.events.emit('security.forbidden', who);
    if (httpErr.status >= 500) log.error(`${req.method} ${req.originalUrl} failed`, { err });
    const body = { error: { code: httpErr.code, message: httpErr.message, requestId: req.id } };
    if (httpErr.details) body.error.details = httpErr.details;
    if (httpErr.status >= 500 && config.mode === 'development') body.error.debug = { message: err?.message, stack: err?.stack };
    if (res.headersSent) return void res.end();
    res.status(httpErr.status).json(body);
  });
  return ex;
}

async function connect(app) {
  const { config, log, mongoose: db } = app;
  const retries = config.db.connectRetries;
  for (let attempt = 1; ; attempt++) {
    try {
      await db.connect(config.db.uri, { serverSelectionTimeoutMS: 5000, monitorCommands: Boolean(config.devtools.enabled) });
      app.hooks.devtools.onConnect?.(db);
      return;
    } catch (err) {
      if (attempt >= retries) {
        err.message = `Could not connect to MongoDB (${redact(config.db.uri)}): ${err.message}`;
        throw err;
      }
      const wait = Math.min(1000 * 2 ** (attempt - 1), 10_000);
      log.warn(`MongoDB not reachable, retrying in ${wait}ms (${attempt}/${retries})`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

const redact = (uri = '') => uri.replace(/\/\/([^@/]+)@/, '//***@');

function warnDuplicates(app) {
  const seen = new Set();
  for (const r of app.routes) {
    const key = `${r.method} ${r.path}`;
    if (seen.has(key)) app.log.warn(`Route registered twice: ${key} (the first one wins)`);
    seen.add(key);
  }
}

function installShutdown(app) {
  if (app.shutdownInstalled) return;
  app.shutdownInstalled = true;
  const stop = async (signal) => {
    app.log.info(`${signal} received, shutting down gracefully`);
    try {
      await app.stop();
      process.exit(0);
    } catch (err) {
      app.log.error('Shutdown failed', { err });
      process.exit(1);
    }
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
}

function printBanner(app) {
  if (app.config.mode === 'test' || app.config.log.level === 'silent') return;
  const { config } = app;
  const addr = app.server.address();
  const base = `http://localhost:${addr.port}`;
  const line = (label, value) => `  ${styleText('green', '➜')}  ${styleText('bold', label.padEnd(9))} ${value}`;
  const lines = [
    '',
    `  ${styleText(['bold', 'green'], 'CalmAPI')} ${styleText('gray', `${config.app.name} v${config.app.version} (${config.mode})`)}`,
    '',
    line('API', `${base}${config.apiPrefix}`),
  ];
  if (config.openapi.enabled) lines.push(line('OpenAPI', `${base}${config.apiPrefix}${config.openapi.path}`));
  if (config.devtools.enabled) lines.push(line('Devtools', styleText('cyan', `${base}/_calm`)));
  lines.push(
    '',
    styleText('gray', `  ${app.registry.size} resources · ${app.routes.length} routes · ${app.plugins.length} blocks · MongoDB connected`),
    '',
  );
  process.stdout.write(`${lines.join('\n')}\n`);
}
