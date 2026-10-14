// Exposure matrix: who can do what, and see which fields, for every resource.
// Computed from your resource definitions (policies, visibleTo, writableBy), so it is
// always in sync with the code. Devtools shows it, doctor checks it, `calm audit`
// verifies it against the running API.

import { evaluatePolicy, parsePolicy, isOwner } from '../resource/policy.js';

const ACTIONS = ['list', 'read', 'create', 'update', 'delete'];
const BUILTIN = new Set(['public', 'authenticated', 'owner', 'none', 'admin']);
const PII = /^(e?mail|phone|mobile|tel|ssn|tax_?id|national_?id|passport|dob|birth(date|day)?|date_?of_?birth|address|street|zip|postal_?code|iban|card(_?number)?|ip(_?address)?|salary|income|health|diagnosis|medical.*)$/i;

const OTHER_ID = 'b'.repeat(24);
const SELF_ID = 'a'.repeat(24);

/** The personas evaluated for every resource: built-ins plus any custom role in use. */
export function personas(app) {
  const roles = new Set();
  const collect = (tokens) => {
    for (const t of tokens ?? []) if (typeof t === 'string' && !BUILTIN.has(t)) roles.add(t);
  };
  for (const { def } of app.registry.values()) {
    for (const tokens of Object.values(def.policy)) collect(tokens);
    for (const field of Object.values(def.fields)) {
      if (field.opts.visibleTo) collect(parsePolicy(field.opts.visibleTo));
      if (field.opts.writableBy) collect(parsePolicy(field.opts.writableBy));
    }
  }
  return [
    { key: 'anonymous', label: 'Anonymous', user: null, owns: false },
    { key: 'user', label: 'Signed-in user', user: { id: SELF_ID, roles: ['user'] }, owns: false },
    { key: 'owner', label: 'Owner', user: { id: SELF_ID, roles: ['user'] }, owns: true },
    ...[...roles].sort().map((r) => ({ key: `role:${r}`, label: r, user: { id: SELF_ID, roles: ['user', r] }, owns: false })),
    { key: 'admin', label: 'Admin', user: { id: SELF_ID, roles: ['user', 'admin'] }, owns: false },
  ];
}

const fakeDoc = (def, owns) => {
  const ownerId = owns ? SELF_ID : OTHER_ID;
  return def.ownerField === '_id' ? { _id: ownerId } : { _id: 'c'.repeat(24), ...(def.ownerField ? { [def.ownerField]: ownerId } : {}) };
};

async function decide(tokens, persona, def, action) {
  const simulated = tokens?.filter((t) => typeof t === 'function' && t.calmSimulate) ?? [];
  if (simulated.length) {
    // Rules registered with { simulate } (calm.policy) depend on data no fake record has, such
    // as a team membership: they describe themselves per persona, the other tokens are decided
    // as usual. Any 'allow' wins; otherwise 'custom' (unknown) beats 'own' and 'deny'.
    const answers = simulated.map((t) => t.calmSimulate({ user: persona.user, action }));
    const rest = tokens.filter((t) => !simulated.includes(t));
    const base = rest.length ? await decide(rest, persona, def, action) : { result: 'deny' };
    if (answers.includes('allow') || base.result === 'allow') return { result: 'allow', custom: true };
    if (answers.includes('custom') || base.result === 'custom') return { result: 'custom', custom: true };
    return base;
  }
  if (tokens?.some((t) => typeof t === 'function')) {
    // Custom rules may depend on data: evaluate, but flag as "custom".
    try {
      const d = await evaluatePolicy(tokens, { user: persona.user, action, doc: fakeDoc(def, persona.owns) });
      return { result: d.allow ? 'allow' : 'deny', custom: true };
    } catch {
      return { result: 'custom', custom: true };
    }
  }
  const d = await evaluatePolicy(tokens, { user: persona.user, action, doc: fakeDoc(def, persona.owns) });
  if (!d.allow) return { result: 'deny' };
  if (d.scope === 'owner') {
    if (action === 'list') return { result: 'own' };
    return { result: isOwner(def, fakeDoc(def, persona.owns), persona.user) ? 'allow' : 'deny' };
  }
  return { result: 'allow' };
}

async function fieldAccess(field, def, persona, mode) {
  const rule = mode === 'read' ? field.opts.visibleTo : field.opts.writableBy;
  if (mode === 'read' && !field.isOutput) return 'never';
  if (mode !== 'read' && !field.isInput) return 'never';
  if (mode === 'update' && (field.opts.immutable || field.type === 'password')) return 'never';
  if (!rule) return 'yes';
  const tokens = parsePolicy(rule);
  const { result } = await decide(tokens, persona, def, mode === 'read' ? 'read' : mode);
  return result === 'allow' ? 'yes' : 'no';
}

export async function exposureMatrix(app) {
  const people = personas(app);
  const resources = [];
  for (const { def, service } of app.registry.values()) {
    const actions = {};
    for (const action of ACTIONS) {
      const enabled = def.crud === true || (Array.isArray(def.crud) && def.crud.includes(action));
      actions[action] = {};
      for (const p of people) actions[action][p.key] = enabled ? (await decide(def.policy[action], p, def, action)).result : 'off';
    }
    const fields = [];
    for (const [name, field] of Object.entries(def.fields)) {
      const read = {};
      const write = {};
      for (const p of people) {
        read[p.key] = await fieldAccess(field, def, p, 'read');
        write[p.key] = await fieldAccess(field, def, p, 'create');
      }
      fields.push({
        name,
        type: field.type,
        encrypted: Boolean(field.opts.encrypted),
        pii: Boolean(field.opts.pii) || PII.test(name),
        read,
        write,
      });
    }
    resources.push({
      name: def.name,
      path: def.path,
      ownerField: def.ownerField,
      customScope: hasOwnScope(service), // a scope() may hide records beyond what policies say
      actions,
      fields,
    });
  }
  return { personas: people.map(({ key, label }) => ({ key, label })), resources };
}

function hasOwnScope(service) {
  // Blocks may install a scope() on the instance (calm.onService), e.g. team scoping.
  if (Object.prototype.hasOwnProperty.call(service, 'scope')) return true;
  let proto = Object.getPrototypeOf(service);
  while (proto && proto.constructor.name !== 'ResourceService') {
    if (Object.prototype.hasOwnProperty.call(proto, 'scope')) return true;
    proto = Object.getPrototypeOf(proto);
  }
  return false;
}

/** Doctor findings derived from the matrix. */
export function exposureFindings(matrix) {
  const findings = [];
  for (const r of matrix.resources) {
    const readableBy = (p) => r.actions.read[p] === 'allow' || r.actions.list[p] === 'allow';
    for (const f of r.fields) {
      if (!f.pii) continue;
      if (readableBy('anonymous') && f.read.anonymous === 'yes') {
        findings.push({ level: 'warn', id: 'pii-public', title: `${r.name}.${f.name} looks like personal data and anyone can read it`, detail: `Add .visibleTo('owner | admin') (or .hidden()) if it should stay private.` });
      } else if (readableBy('user') && f.read.user === 'yes' && r.ownerField) {
        findings.push({ level: 'info', id: 'pii-users', title: `${r.name}.${f.name} looks like personal data and every signed-in user can read it`, detail: `If only the owner should see it: .visibleTo('owner | admin').` });
      }
      if (!f.encrypted && /ssn|tax|national|passport|iban|card|health|diagnosis|medical/i.test(f.name)) {
        findings.push({ level: 'info', id: 'sensitive-unencrypted', title: `${r.name}.${f.name} could be encrypted at rest`, detail: 'Add .encrypted() so database dumps and backups only hold ciphertext.' });
      }
    }
  }
  return findings;
}
