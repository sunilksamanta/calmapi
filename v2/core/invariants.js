// Invariants: promises written once in calm.config.js, in words the framework understands,
// that must stay true whatever anyone (a person or an agent) changes next. Policies say who
// may do what; invariants say what must never become possible.
//
//   // calm.config.js
//   invariants: [
//     'no public write routes',
//     'personal data is never public',
//     'auth routes are rate limited',
//     'every route has an explicit policy',
//     'resource order requires idempotency',
//     'routes under /api/admin require admin',
//     { rule: 'no public write routes', except: ['POST /api/contact'] },
//     (app) => app.routes.filter((r) => r.path.startsWith('/internal') && r.policyLabel !== 'admin'),
//   ],
//
// They are checked by `calm doctor`, in devtools (Doctor), and at boot: in production a
// broken invariant stops the app with a clear message instead of serving. The list is part of
// the behavior snapshot (`calm diff`), so removing a promise is a visible change, never a
// side effect.

import { exposureMatrix } from './security/exposure.js';

const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/** The named rules. `check` returns violations: { what, file? }. */
const RULES = [
  {
    match: /^no public write routes$/,
    describe: () => 'No POST, PUT, PATCH or DELETE route is public (sign up, sign in and password flows excepted)',
    check: (app, { except }) =>
      app.routes
        .filter((r) => WRITE.has(r.method) && r.source !== 'auth' && isPublic(r.policy) && !except(routeLabel(app, r)))
        .map((r) => ({ what: `${routeLabel(app, r)} is public`, file: r.file })),
  },
  {
    match: /^no public routes$/,
    describe: () => 'No route is public (sign up, sign in and password flows excepted)',
    check: (app, { except }) =>
      app.routes
        .filter((r) => r.source !== 'auth' && isPublic(r.policy) && !except(routeLabel(app, r)))
        .map((r) => ({ what: `${routeLabel(app, r)} is public`, file: r.file })),
  },
  {
    match: /^personal data is never public$/,
    describe: () => 'No field that looks like personal data (or is marked .pii()) is readable without signing in',
    check: async (app, { except, matrix }) => {
      const out = [];
      for (const r of await matrix()) {
        const readable = r.actions.read.anonymous === 'allow' || r.actions.list.anonymous === 'allow';
        if (!readable) continue;
        for (const f of r.fields) {
          if (f.pii && f.read.anonymous === 'yes' && !except(`${r.name}.${f.name}`)) {
            out.push({ what: `${r.name}.${f.name} is personal data and anyone can read it`, file: app.registry.get(r.name)?.files?.resource });
          }
        }
      }
      return out;
    },
  },
  {
    match: /^auth routes are rate limited$/,
    describe: () => 'Rate limiting is on and every auth route callable without signing in (register, login, password reset...) has a limit',
    check: (app) => {
      if (!app.config.rateLimit.enabled && app.config.mode !== 'test') return [{ what: 'rate limiting is disabled (config.rateLimit.enabled)' }];
      return app.routes
        .filter((r) => r.source === 'auth' && WRITE.has(r.method) && isPublic(r.policy) && !r.rateLimit)
        .map((r) => ({ what: `${routeLabel(app, r)} has no rate limit`, file: r.file }));
    },
  },
  {
    match: /^every route has an explicit policy$/,
    describe: () => 'Every route and every resource action names its policy (no defaults)',
    check: (app, { except }) => {
      const out = [];
      for (const r of app.routes) {
        if (r.source === 'crud' || r.source === 'auth' || r.policyExplicit || except(routeLabel(app, r))) continue;
        out.push({ what: `${routeLabel(app, r)} has no explicit policy`, file: r.file });
      }
      for (const { def, files } of app.registry.values()) {
        if (def.defaultedPolicies.length && !except(def.name)) {
          out.push({ what: `${def.name}: no explicit policy for ${def.defaultedPolicies.join(', ')}`, file: files?.resource });
        }
      }
      return out;
    },
  },
  {
    match: /^resource ([\w-]+) requires idempotency$/,
    describe: ([, name]) => `Writes to ${name} need an Idempotency-Key (the idempotency block, with the resource in its required list)`,
    check: (app, { params: [, name] }) => {
      const entry = app.registry.get(name);
      if (!entry) return [{ what: `there is no resource "${name}"` }];
      const block = app.plugins.find((p) => p.name === 'idempotency');
      if (!block) return [{ what: 'the idempotency block is not installed (calm add idempotency)' }];
      const patterns = (block.options?.required ?? []).map(parseRoutePattern).filter(Boolean);
      const prefix = app.config.apiPrefix;
      const writes = app.routes.filter((r) => r.resource === name && WRITE.has(r.method));
      return writes
        .filter((r) => !patterns.some((p) => p.covers(r.method, `${prefix}${r.path}`)))
        .map((r) => ({ what: `${routeLabel(app, r)} is not in blocks.idempotency.required`, file: r.file }));
    },
  },
  {
    match: /^routes under (\/\S+) require ([\w-]+)$/,
    describe: ([, prefix, role]) => `Every route under ${prefix} is only for the ${role} role`,
    check: (app, { params: [, prefix, role], except }) =>
      app.routes
        .filter((r) => `${app.config.apiPrefix}${r.path}`.startsWith(prefix) && !except(routeLabel(app, r)))
        .filter((r) => !(r.policy?.length && r.policy.every((t) => t === role)))
        .map((r) => ({ what: `${routeLabel(app, r)} is "${r.policyLabel}", not "${role}"`, file: r.file })),
  },
];

const isPublic = (tokens) => Array.isArray(tokens) && tokens.includes('public');
const routeLabel = (app, r) => `${r.method} ${app.config.apiPrefix}${r.path}`;

/** 'POST /api/orders' or '* /api/orders/**': does it cover a declared route? */
function parseRoutePattern(pattern) {
  const m = /^([a-z]+|\*)\s+(\/\S*)$/i.exec(String(pattern).trim());
  if (!m) return null;
  const method = m[1].toUpperCase();
  const segments = m[2].split('/').filter(Boolean);
  const isParam = (s) => s === '*' || s.startsWith(':');
  return {
    covers(routeMethod, path) {
      if (method !== '*' && method !== routeMethod) return false;
      const other = path.split('/').filter(Boolean);
      for (let i = 0; i < segments.length; i++) {
        if (segments[i] === '**') return true;
        if (i >= other.length) return false;
        if (!isParam(segments[i]) && segments[i] !== other[i] && !isParam(other[i])) return false;
      }
      return segments.length === other.length;
    },
  };
}

/** `except` entries match route labels ('POST /api/contact'), 'resource.field' or resource names; `*` is a wildcard. */
function exceptMatcher(except = []) {
  const res = except.map((e) => new RegExp(`^${String(e).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`));
  return (label) => res.some((re) => re.test(label));
}

/** Normalize one config entry into { rule, except, fn, params, describe }. Throws on an unknown rule. */
function normalize(entry, index) {
  if (typeof entry === 'function') {
    const name = entry.name || `custom invariant #${index + 1}`;
    return { rule: name, kind: 'custom', except: [], fn: entry, describe: 'Your own check (a function receiving the app)' };
  }
  const spec = typeof entry === 'string' ? { rule: entry } : entry;
  if (!spec || typeof spec.rule !== 'string') throw invalid(`invariants[${index}] must be a rule name, { rule, except } or a function`);
  const rule = spec.rule.trim().replace(/\s+/g, ' ');
  for (const r of RULES) {
    const params = r.match.exec(rule);
    if (params) return { rule, kind: 'named', except: spec.except ?? [], params, named: r, describe: r.describe(params) };
  }
  throw invalid(`invariants[${index}]: unknown rule "${spec.rule}". Known rules: ${KNOWN.join('; ')}`);
}

const KNOWN = [
  'no public write routes',
  'no public routes',
  'personal data is never public',
  'auth routes are rate limited',
  'every route has an explicit policy',
  'resource <name> requires idempotency',
  'routes under <prefix> require <role>',
];

function invalid(message) {
  const err = new Error(`Invalid configuration:\n  - ${message}`);
  err.code = 'CALM_CONFIG';
  return err;
}

/** Validate config.invariants at boot (throws CALM_CONFIG) and return their descriptions. */
export function describeInvariants(config) {
  const list = Array.isArray(config.invariants) ? config.invariants : [];
  return list.map((entry, i) => {
    const n = normalize(entry, i);
    return { rule: n.rule, kind: n.kind, except: n.except, description: n.describe };
  });
}

/**
 * Check every invariant against the booted app.
 * @returns {Promise<Array<{ rule: string, kind: string, ok: boolean, violations: Array<{ what: string, file?: string }> }>>}
 */
export async function checkInvariants(app) {
  const list = Array.isArray(app.config.invariants) ? app.config.invariants : [];
  if (!list.length) return [];
  let cached = null;
  const matrix = async () => (cached ??= (await exposureMatrix(app)).resources);
  const results = [];
  for (const [i, entry] of list.entries()) {
    const n = normalize(entry, i);
    let violations;
    try {
      violations = n.kind === 'custom' ? fromCustom(await n.fn(app), app) : await n.named.check(app, { params: n.params, except: exceptMatcher(n.except), matrix });
    } catch (err) {
      violations = [{ what: `the check itself failed: ${err.message}` }];
    }
    results.push({ rule: n.rule, kind: n.kind, ok: violations.length === 0, violations });
  }
  return results;
}

/** What a custom invariant returned: an array of problems (routes, strings, objects), false, or a message. */
function fromCustom(value, app) {
  if (value === undefined || value === true || value === null) return [];
  if (value === false) return [{ what: 'returned false' }];
  if (typeof value === 'string') return [{ what: value }];
  const items = Array.isArray(value) ? value : [value];
  return items.map((v) => {
    if (typeof v === 'string') return { what: v };
    if (v && typeof v === 'object') {
      if (v.method && v.path) return { what: `${routeLabel(app, v)} is "${v.policyLabel ?? '?'}"`, file: v.file };
      if (v.what) return { what: String(v.what), file: v.file };
      return { what: JSON.stringify(v) };
    }
    return { what: String(v) };
  });
}

/** Doctor findings: one error per broken invariant. */
export async function invariantFindings(app) {
  const broken = (await checkInvariants(app)).filter((r) => !r.ok);
  return broken.map((r) => ({
    level: 'error',
    id: 'invariant',
    title: `Invariant broken: ${r.rule}`,
    detail: `${r.violations.map((v) => `${v.what}${v.file ? ` (${v.file})` : ''}`).join('\n')}\nFix the code, or change the promise in calm.config.js (invariants). In production the app refuses to start.`,
    file: r.violations.find((v) => v.file)?.file,
  }));
}

/** One readable block for logs and the boot error. */
export function formatBroken(results) {
  return results
    .filter((r) => !r.ok)
    .map((r) => `  - ${r.rule}\n${r.violations.map((v) => `      ${v.what}${v.file ? ` (${v.file})` : ''}`).join('\n')}`)
    .join('\n');
}
