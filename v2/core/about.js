// The transparency report: what the framework does that you did not write. The request
// pipeline, the headers it sets, what it stores and for how long, what it logs, which hosts
// the code can reach and the files the CLI writes. Generated from the running app and the
// code on disk, so it cannot drift. `calm about` prints it, devtools shows it under About,
// coding agents read it as calm_about.

import { createRequire } from 'node:module';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { SECURITY_HEADERS, EXPOSED_HEADERS, CORS_METHODS } from './http/middleware.js';

const require = createRequire(import.meta.url);

/** Every file the CLI writes, by command. Static on purpose: this is the promise. */
export const CLI_FILES = [
  { path: 'calm/**', by: 'calm create, calm upgrade', when: 'the framework code you own; upgrade merges updates into it and writes <file>.calm-new next to a conflict it cannot merge' },
  { path: 'package.json, server.js, calm.config.js, .gitignore, Dockerfile, .dockerignore, README.md, AGENTS.md, CLAUDE.md, eslint.config.js, .claude/settings.json', by: 'calm create', when: 'a new project, from the template (.claude/settings.json runs calm agent-hook before Claude Code edits a file)' },
  { path: 'app/resources/**, app/routes.js, test/**', by: 'calm create', when: 'the template\'s example resources and tests' },
  { path: 'app/resources/<name>/<name>.resource.js, .service.js, .routes.js', by: 'calm make resource', when: 'a new resource (service and routes files on request)' },
  { path: 'test/<name>.test.js', by: 'calm make resource', when: 'a test for the new resource, when the project has users' },
  { path: 'app/blocks/<name>/**', by: 'calm add, calm make block', when: 'a block\'s source, copied into your project (index.js, block.json, README.md)' },
  { path: 'test/blocks/<name>.test.js', by: 'calm make block', when: 'a test for your own block' },
  { path: 'app/notifications/*', by: 'calm add notifications', when: 'notification types (welcome.js) the notifications block starts you with' },
  { path: 'r/<name>.json, r/index.json', by: 'calm block pack', when: 'a block packed for sharing (--out changes the folder)' },
  { path: 'package.json', by: 'calm add', when: 'the dependencies a block needs' },
  { path: '.env.example, .env', by: 'calm create, calm add', when: 'create writes both; add appends the env keys a block declares, never changing existing lines' },
  { path: '.env', by: 'calm keygen --write', when: 'adds or rotates CALM_ENCRYPTION_KEYS' },
  { path: 'calm.lock', by: 'calm create, calm add, calm upgrade', when: 'the framework version and a hash of every framework and block file, so upgrade and devtools can tell what you changed' },
  { path: 'openapi.json', by: 'calm openapi', when: 'the OpenAPI document (--out changes the path, --stdout writes nothing)' },
  { path: '.calm/activity.jsonl', by: 'calm dev, calm mcp, calm agent-hook, checkpoints', when: 'file changes with diffs, restarts, crashes, agent tool calls and the files agents are about to edit, for the Activity panel; trimmed at 4 MB' },
  { path: '.calm/checkpoints/**', by: 'calm checkpoint, calm mcp, devtools', when: 'snapshots of the development database, restored with calm restore' },
  { path: '.calm/agent-session.json, .calm/proposals/**', by: 'calm mcp', when: 'what an agent is doing and the changes it proposes, for devtools' },
  { path: '.calm/reviews/<date>-<id>.json, .calm/reviews/baseline.json', by: 'calm review --sign, devtools Review', when: 'a signature and the behavior it accepted; meant to be committed' },
  { path: 'security.snapshot.json', by: 'calm audit --accept', when: 'the exposure budget: who may do what, and who accepted each widening and why; meant to be committed' },
  { path: '.calm/declarations/<id>.json', by: 'calm mcp (calm_declare)', when: 'what an agent said it would change, compared in the review' },
  { path: '.gitignore', by: 'calm review --sign', when: 'once, in projects created before reviews: .calm/ becomes .calm/* and !.calm/reviews/ so reviews are committed' },
  { path: '~/.calm/cache/calmapi-<version>/**', by: 'calm upgrade', when: 'the released calm/ to merge against, downloaded with npm pack (outside the project)' },
];

/** Files that make network requests reach hosts; files that only mention URLs do not. */
// Names carry no parentheses, so this file does not look like a caller to its own scan.
const NETWORK_CALLS = [
  { re: /\bfetch\s*\(/g, call: 'fetch' },
  { re: /\bhttps?\.(?:request|get)\s*\(/g, call: 'http.request' },
  { re: /\b(?:net|tls)\.(?:connect|createConnection)\s*\(/g, call: 'net.connect' },
  { re: /\bnew\s+WebSocket\s*\(/g, call: 'WebSocket' },
];
const NETWORK_PACKAGES = ['@aws-sdk/', 'nodemailer', 'undici', 'axios', 'got', 'node-fetch', 'ws', 'ioredis', 'redis', 'pg', 'mysql', 'amqplib', 'kafkajs', '@sendgrid/', 'stripe', 'twilio', 'openai', '@anthropic-ai/'];
const LOOPBACK = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const SOURCE = /\.(m?js|cjs|ts)$/;
const MAX_FILE = 512 * 1024;
const SKIP_DIRS = new Set(['node_modules', '.git']);

export async function aboutReport(app) {
  const { config } = app;
  // Loaded here, not at the top: production never loads the devtools collector.
  const { SECRET_KEYS, RING_SIZES } = await import('./devtools/index.js');
  return {
    framework: framework(app),
    pipeline: app.pipeline,
    headers: headers(config),
    stored: stored(app, RING_SIZES),
    logging: logging(app, SECRET_KEYS),
    outbound: scanOutbound(app.root),
    files: CLI_FILES,
    devtools: {
      enabled: Boolean(config.devtools.enabled),
      path: '/_calm',
      rule: 'development only (production forces it off); answers only requests from this machine: loopback socket, localhost Host header, no proxy headers; writes need the X-Calm-Devtools header',
    },
    blocks: app.plugins.map((p) => ({ name: p.name, file: p.file, env: (p.env ?? []).map((v) => v.key), models: p.models ?? [] })),
  };
}

function framework(app) {
  const version = (name) => {
    try {
      return require(`${name}/package.json`).version;
    } catch {
      return null;
    }
  };
  let calmapi = null;
  try {
    calmapi = JSON.parse(readFileSync(join(app.root, 'calm.lock'), 'utf8')).calmapi ?? null;
  } catch {
    // no lock file: calm/ was not written by the CLI
  }
  return { calmapi, node: process.version, express: version('express'), mongoose: version('mongoose'), mode: app.config.mode };
}

function headers(config) {
  const production = config.mode === 'production';
  const always = [
    { name: 'X-Request-Id', value: 'the request id (a UUID, or the incoming X-Request-Id when it is sane)', by: 'requestContext' },
    ...SECURITY_HEADERS.filter((h) => !h.production || production).map((h) => ({ name: h.name, value: h.value, by: 'securityHeaders' })),
  ];
  const rate = config.rateLimit.enabled
    ? [
        { name: 'RateLimit-Limit', value: 'the limit of the window', by: 'rateLimit', when: 'every /api response' },
        { name: 'RateLimit-Remaining', value: 'requests left in the window', by: 'rateLimit', when: 'every /api response' },
        { name: 'RateLimit-Reset', value: 'seconds until the window resets', by: 'rateLimit', when: 'every /api response' },
        { name: 'Retry-After', value: 'seconds until the window resets', by: 'rateLimit', when: 'with a 429' },
      ]
    : [];
  return {
    always,
    rateLimit: rate,
    removed: ['X-Powered-By'],
    cors: {
      origins: config.cors.origins ?? [],
      credentials: Boolean(config.cors.credentials),
      methods: CORS_METHODS,
      exposeHeaders: [...new Set([...EXPOSED_HEADERS, ...(config.cors.exposeHeaders ?? [])])],
      maxAge: config.cors.maxAge ?? 600,
      notProduction: !production && config.cors.origins === '*' ? 'any origin until CORS_ORIGINS is set; production allows none by default' : null,
    },
  };
}

function stored(app, RING_SIZES) {
  const { config } = app;
  const minutes = (n) => `${n} minute${n === 1 ? '' : 's'}`;
  const lockout = { maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ...(config.auth.lockout ?? {}) };
  const notes = {
    calm_sessions: `sessions: opaque tokens, SHA-256 at rest, ${config.auth.sessionTtlDays} days; with the IP and user agent of the sign-in`,
    calm_password_resets: `password reset tokens: SHA-256 at rest, single use, ${minutes(config.auth.resetTokenTtlMinutes)}`,
    calm_login_attempts: lockout.maxAttempts
      ? `failed sign-ins per email (hashed, never the address): ${lockout.maxAttempts} in ${minutes(lockout.windowMinutes)} locks the account for ${minutes(lockout.lockMinutes)}`
      : 'failed sign-ins per email (hashed); lockout is off',
    calm_devices: `push tokens your apps register, with the platform and device name${config.auth.devicesFollowSessions !== false ? '; removed when the session that registered them ends' : ''}`,
    calm_idempotency: 'Idempotency-Key values with the response they produced, replayed on a repeat',
    calm_rate_limits: 'rate limit counters shared between instances, one document per key and window',
  };
  const owners = new Map();
  for (const [name, entry] of app.registry) owners.set(entry.model.modelName, { owner: `resource:${name}`, file: entry.files.resource, encrypted: Object.entries(entry.def.fields).filter(([, f]) => f.opts.encrypted).map(([k]) => k) });
  for (const [key, model] of Object.entries(app.auth?.service ?? {})) {
    if (model?.modelName && ['Session', 'PasswordReset', 'LoginAttempt'].includes(key)) owners.set(model.modelName, { owner: 'auth', file: 'calm/auth/models.js' });
  }
  if (app.push.devices?.modelName) owners.set(app.push.devices.modelName, { owner: 'push', file: 'calm/push.js' });
  for (const p of app.plugins) for (const name of p.models ?? []) owners.set(name, { owner: `block:${p.name}`, file: p.file });

  const collections = Object.values(app.mongoose.models).map((model) => {
    const info = owners.get(model.modelName) ?? { owner: 'calm', file: null };
    const ttlIndex = model.schema.indexes().find(([, options]) => options?.expireAfterSeconds !== undefined);
    const collection = model.collection.collectionName;
    return {
      model: model.modelName,
      collection,
      owner: info.owner,
      file: info.file ?? null,
      ttl: ttlIndex ? { field: Object.keys(ttlIndex[0])[0], seconds: ttlIndex[1].expireAfterSeconds } : null,
      encryptedFields: info.encrypted ?? [],
      note: notes[collection] ?? (info.owner.startsWith('resource:') ? 'your resource; what the API stores for it' : null),
    };
  });

  const memory = [];
  const win = (ms) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);
  if (config.rateLimit.enabled) {
    memory.push({
      name: 'rate limit counters',
      where: app.rateStore?.kind === 'memory' ? 'memory (this process only)' : 'a store a block provides (calm.app.rateStore)',
      what: 'hit counts per IP (per IP and path on auth routes)',
      retention: `one window: ${win(config.rateLimit.global.windowMs)} global, ${win(config.rateLimit.auth.windowMs)} auth`,
    });
  }
  if (config.devtools.enabled) {
    memory.push({
      name: 'devtools',
      where: 'memory (this process only), development only',
      what: `the last ${RING_SIZES.requests} requests with headers, bodies and queries, ${RING_SIZES.logs} log lines, ${RING_SIZES.mails} mails, ${RING_SIZES.pushes} push notifications, ${RING_SIZES.activity} activity events, ${RING_SIZES.securityEvents} security events`,
      retention: 'until the process restarts; newest wins',
    });
  }
  return { collections, memory };
}

function logging(app, SECRET_KEYS) {
  const { config } = app;
  return {
    level: config.log.level,
    format: config.log.format,
    accessLog: {
      when: config.mode === 'test' ? 'off in tests' : 'every request',
      fields: ['method', 'url (with its query string)', 'status', 'duration', 'requestId', 'userId'],
      example: 'GET /api/posts 200 12ms',
      file: 'calm/http/middleware.js',
    },
    never: 'request bodies, headers and tokens are never logged by the framework',
    errors: '5xx errors are logged with their stack; 4xx are one warn line without the body',
    devtools: {
      when: config.devtools.enabled ? 'on' : 'off',
      records: 'requests with headers, bodies and responses, MongoDB queries, logs, mail, push notifications, security events',
      redacts: `values of keys matching ${SECRET_KEYS.source}; Authorization is shortened, Cookie removed`,
      where: 'memory, local only, development only; nothing leaves this machine',
    },
  };
}

// ---- outbound: hosts the code can reach, found statically ------------------------------------

function scanOutbound(root) {
  const hosts = new Map();
  const loopback = new Map();
  const dynamic = [];
  let scanned = 0;
  for (const rel of listSources(root, ['calm', 'app'])) {
    let text;
    try {
      text = readFileSync(join(root, rel), 'utf8');
    } catch {
      continue;
    }
    scanned += 1;
    const code = stripComments(text);
    const calls = networkCalls(code);
    const packages = NETWORK_PACKAGES.filter((pkg) => new RegExp(`from\\s+['"]${pkg.replace(/[/.]/g, '\\$&')}|require\\(\\s*['"]${pkg.replace(/[/.]/g, '\\$&')}`).test(code));
    for (const pkg of packages) dynamic.push({ file: rel, call: `import ${pkg}`, arg: null, note: `uses ${pkg.replace(/\/$/, '')}, which connects to the host it is configured with` });
    if (!calls.length && !packages.length) continue;
    for (const call of calls) if (!call.host) dynamic.push({ file: rel, call: call.call, arg: call.arg, note: `${call.call}() with a computed URL` });
    for (const m of code.matchAll(/https?:\/\/([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?|\[[0-9a-f:]+\])(?::\d+)?/gi)) {
      const host = m[1].toLowerCase();
      const map = LOOPBACK.has(host) ? loopback : hosts;
      if (!map.has(host)) map.set(host, new Set());
      map.get(host).add(rel);
    }
  }
  const list = (map) => [...map].sort(([a], [b]) => a.localeCompare(b)).map(([host, files]) => ({ host, files: [...files].sort() }));
  const fromCalm = list(hosts).filter((h) => h.files.some((f) => f.startsWith('calm/')));
  const dynamicInCalm = dynamic.filter((d) => d.file.startsWith('calm/'));
  return {
    hosts: list(hosts),
    loopback: list(loopback),
    dynamic,
    scanned,
    promise: {
      text: 'calm/ makes no network requests of its own',
      ok: !fromCalm.length,
      detail: fromCalm.length
        ? `calm/ reaches ${fromCalm.map((h) => h.host).join(', ')}: read the files above before you trust it`
        : `no host is named by a file under calm/ that makes network calls${dynamicInCalm.length ? `; ${dynamicInCalm.map((d) => `${d.file} calls ${d.call}() with a computed URL`).join(', ')}` : ''}`,
    },
  };
}

function listSources(root, dirs) {
  const out = [];
  const visit = (rel) => {
    let entries;
    try {
      entries = readdirSync(join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) visit(path);
        continue;
      }
      if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
      try {
        if (statSync(join(root, path)).size <= MAX_FILE) out.push(path);
      } catch {
        // gone between readdir and stat
      }
    }
  };
  for (const dir of dirs) visit(dir);
  return out.sort();
}

/** Network calls in a source file, with the host of a literal URL first argument or null. */
function networkCalls(code) {
  const out = [];
  for (const { re, call } of NETWORK_CALLS) {
    for (const m of code.matchAll(re)) {
      const rest = code.slice(m.index + m[0].length, m.index + m[0].length + 200).trimStart();
      const literal = /^(['"`])(https?:\/\/[^'"`$\s]+)/.exec(rest);
      const host = literal ? /^https?:\/\/([^/:?#]+)/.exec(literal[2])?.[1]?.toLowerCase() ?? null : null;
      out.push({ call, host, arg: host ? null : rest.split(/[,)\n]/)[0].trim().slice(0, 60) });
    }
  }
  return out;
}

/** Drop comments so a documentation link does not count as a host. Strings and regexes are kept. */
export function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  const skipString = (quote) => {
    let j = i + 1;
    while (j < n && src[j] !== quote) {
      if (src[j] === '\\') j += 1;
      else if (src[j] === '\n' && quote !== '`') break;
      j += 1;
    }
    out += src.slice(i, j + 1);
    i = j + 1;
  };
  // A slash starts a regex when the last meaningful character cannot end an expression.
  const regexMayStart = () => {
    const prev = out.replace(/\s+$/, '').slice(-1);
    return !prev || /[([{,;=:!&|?+\-*%<>^~]/.test(prev) || /\b(?:return|typeof|case|in|of|do|else)$/.test(out.replace(/\s+$/, ''));
  };
  while (i < n) {
    const ch = src[i];
    const next = src[i + 1];
    if (ch === '"' || ch === "'" || ch === '`') skipString(ch);
    else if (ch === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? n : end;
    } else if (ch === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? n : end + 2;
    } else if (ch === '/' && regexMayStart()) {
      let j = i + 1;
      let inClass = false;
      while (j < n && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') j += 1;
        else if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        j += 1;
      }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}
