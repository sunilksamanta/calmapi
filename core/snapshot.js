// The behavior snapshot: what the app does, as data. Every route with who may call it, every
// field with who may read and write it, the environment variables blocks need, the blocks,
// and the invariants. `calm diff` compares two snapshots (a git ref and the working tree) and
// reports behavior changes: routes added, policies loosened, fields visible to more people.
// Nothing here is a guess: it is computed from the same definitions the app serves.

import { exposureMatrix, personas } from './security/exposure.js';
import { evaluatePolicy } from './resource/policy.js';
import { describeInvariants } from './invariants.js';

export const SNAPSHOT_VERSION = 1;

/** Who may call a route, per persona: allow | own | deny | custom. */
export async function routeAccess(route, people) {
  const access = {};
  const custom = route.policy?.some((t) => typeof t === 'function');
  for (const p of people) {
    if (custom) {
      access[p.key] = 'custom';
      continue;
    }
    const d = await evaluatePolicy(route.policy, { user: p.user, action: route.action });
    access[p.key] = !d.allow ? 'deny' : d.scope === 'owner' && route.action !== 'create' ? 'own' : 'allow';
  }
  return access;
}

/**
 * A field rule alone says 'yes' for everyone when there is no visibleTo; what a persona can
 * actually see also depends on the resource's read and list policies. Both combined is what the
 * API does, and what a diff should report.
 */
export function effectiveAccess(field, actions) {
  const can = (persona, ...names) => names.some((n) => actions[n]?.[persona] === 'allow' || actions[n]?.[persona] === 'own');
  const read = {};
  const write = {};
  for (const persona of Object.keys(field.read)) {
    read[persona] = field.read[persona] === 'yes' && !can(persona, 'read', 'list') ? 'no' : field.read[persona];
    write[persona] = field.write[persona] === 'yes' && !can(persona, 'create', 'update') ? 'no' : field.write[persona];
  }
  return { read, write };
}

export async function behaviorSnapshot(app) {
  const people = personas(app);
  const prefix = app.config.apiPrefix;
  const routes = [];
  for (const r of app.routes) {
    if (r.hidden) continue;
    routes.push({
      method: r.method,
      path: `${prefix}${r.path}`,
      policy: r.policyLabel,
      explicit: r.policyExplicit,
      source: r.source,
      file: r.file ?? null,
      resource: r.resource,
      action: r.action,
      rateLimit: r.rateLimit === 'auth' ? 'auth' : r.rateLimit && typeof r.rateLimit === 'object' ? `${r.rateLimit.max} per ${Math.round(r.rateLimit.windowMs / 1000)}s` : null,
      scope: r.scope ?? null,
      access: await routeAccess(r, people),
    });
  }
  const matrix = await exposureMatrix(app);
  const resources = matrix.resources.map((r) => ({
    name: r.name,
    path: `${prefix}${r.path}`,
    owner: r.ownerField,
    file: app.registry.get(r.name)?.files?.resource ?? null,
    fields: r.fields.map((f) => ({ name: f.name, type: f.type, pii: f.pii, encrypted: f.encrypted, ...effectiveAccess(f, r.actions) })),
  }));
  const env = [];
  for (const p of app.plugins) {
    for (const v of p.env ?? []) env.push({ key: v.key, required: v.requiredIn ?? false, secret: v.secret, from: `block:${p.name}`, file: p.file });
  }
  return {
    version: SNAPSHOT_VERSION,
    app: { name: app.config.app.name, apiPrefix: prefix, mode: app.config.mode },
    personas: people.map((p) => p.key),
    routes,
    resources,
    env,
    blocks: app.plugins.map((p) => ({ name: p.name, file: p.file ?? null })),
    invariants: describeInvariants(app.config).map(({ rule, except }) => ({ rule, except })),
  };
}
