// Behavior snapshots on the CLI side: the runtime snapshot from calm/snapshot.js (routes and
// who may call them, fields and who may see them, env, blocks, invariants) plus what only the
// source can tell (hosts the code can reach, events it emits, env vars it reads), and the diff
// between two of them. Pure functions, so CI and tests can use them without a project.

// The scan and the diff live in core (calm/behavior.js in a project) so devtools and reviews
// compute exactly what this command prints. They are pure functions: importing them from the
// package does not load a project.
import { scanSource, mergeScan } from '../../../core/behavior.js';

export { scanSource, direction, audience, diffSnapshots, diffRows } from '../../../core/behavior.js';

// ---- building a snapshot ------------------------------------------------------------------

const PERSONAS = ['anonymous', 'user', 'owner', 'admin'];

/** Who may call a route, from its policy label alone (for projects whose calm/ predates calm/snapshot.js). */
export function accessFromLabel(label, people = PERSONAS) {
  const tokens = String(label ?? '').split('|').map((t) => t.trim()).filter(Boolean);
  const access = {};
  const custom = tokens.some((t) => t === 'custom' || /\(\)$/.test(t));
  for (const key of people) {
    if (custom) access[key] = 'custom';
    else if (tokens.includes('public')) access[key] = 'allow';
    else if (key === 'anonymous') access[key] = 'deny';
    else if (tokens.includes('authenticated')) access[key] = 'allow';
    else if (key === 'admin' && tokens.includes('admin')) access[key] = 'allow';
    else if (key.startsWith('role:') && tokens.includes(key.slice(5))) access[key] = 'allow';
    else if (key === 'user' && tokens.includes('user')) access[key] = 'allow';
    else if (tokens.includes('owner')) access[key] = key === 'owner' ? 'own' : 'deny';
    else access[key] = 'deny';
  }
  return access;
}

/**
 * A complete snapshot from what `introspect(root)` returned plus the source scan.
 * Works with older calm/ folders too (no runtime snapshot: access comes from policy labels).
 */
export function buildSnapshot(info, root) {
  return mergeScan(info.snapshot ?? fromIntrospect(info), scanSource(root));
}

/** Field rule combined with the resource's read, list, create and update policies (what the API does). */
function effective(field, actions = {}) {
  const can = (persona, ...names) => names.some((n) => actions[n]?.[persona] === 'allow' || actions[n]?.[persona] === 'own');
  const read = {};
  const write = {};
  for (const persona of Object.keys(field.read ?? {})) {
    read[persona] = field.read[persona] === 'yes' && !can(persona, 'read', 'list') ? 'no' : field.read[persona];
    write[persona] = field.write?.[persona] === 'yes' && !can(persona, 'create', 'update') ? 'no' : field.write?.[persona];
  }
  return { read, write };
}

function fromIntrospect(info) {
  const people = [...new Set([...PERSONAS, ...(info.exposure?.personas ?? []).map((p) => p.key)])];
  const prefix = info.app?.apiPrefix ?? '/api';
  return {
    version: 0,
    app: { name: info.app?.name ?? null, apiPrefix: prefix, mode: info.app?.mode ?? null },
    personas: people,
    routes: (info.routes ?? []).filter((r) => !r.hidden).map((r) => ({
      method: r.method,
      path: r.path,
      policy: r.policy,
      explicit: r.policyExplicit,
      source: r.source,
      file: r.file ?? null,
      resource: r.resource ?? null,
      action: null,
      rateLimit: null,
      scope: null,
      access: accessFromLabel(r.policy, people),
    })),
    resources: (info.exposure?.resources ?? []).map((r) => ({
      name: r.name,
      path: `${prefix}${r.path}`,
      owner: r.ownerField ?? null,
      file: info.resources?.find((x) => x.name === r.name)?.files?.resource ?? null,
      fields: r.fields.map((f) => ({ name: f.name, type: f.type, pii: f.pii, encrypted: f.encrypted, ...effective(f, r.actions) })),
    })),
    env: (info.blocks ?? []).flatMap((b) => (b.env ?? []).map((v) => ({ key: v.key, required: v.requiredIn ?? false, secret: v.secret, from: `block:${b.name}`, file: b.file }))),
    blocks: (info.blocks ?? []).map((b) => ({ name: b.name, file: b.file ?? null })),
    invariants: [],
  };
}

