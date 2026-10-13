// The contract diff: what changed for the apps that call your API, from two OpenAPI
// documents. A change is breaking when a client that worked before can fail now (a removed
// route or field, a new required input, a changed type, a tighter limit, a route that now
// needs a session), minor when something was added, patch when nothing a client sees changed.
// `calm diff --api` prints it with the version bump it suggests.

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_DEPTH = 12;

function resolve(schema, doc, depth = 0) {
  let s = schema;
  for (let i = 0; s?.$ref && i < 10; i++) {
    const path = s.$ref.replace(/^#\//, '').split('/');
    s = path.reduce((node, key) => node?.[key.replace(/~1/g, '/').replace(/~0/g, '~')], doc);
  }
  return depth > MAX_DEPTH ? {} : (s ?? {});
}

const typeOf = (s) => (Array.isArray(s.type) ? s.type.filter((t) => t !== 'null').join('|') : s.type ?? (s.properties ? 'object' : s.items ? 'array' : s.enum ? 'enum' : 'any'));

/** Compare two schemas. mode 'request': what a client sends; 'response': what it receives. */
function compareSchema(a0, b0, ctx, label, mode, depth = 0) {
  const { before, after, push } = ctx;
  const a = resolve(a0, before, depth);
  const b = resolve(b0, after, depth);
  if (depth > MAX_DEPTH) return;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb && ta !== 'any' && tb !== 'any') {
    push('breaking', `${label}: type ${ta} -> ${tb}`);
    return;
  }

  if (a.enum || b.enum) {
    const ea = new Set((a.enum ?? []).map(String));
    const eb = new Set((b.enum ?? []).map(String));
    const removed = [...ea].filter((v) => !eb.has(v));
    const added = [...eb].filter((v) => !ea.has(v));
    if (mode === 'request') {
      if (removed.length && a.enum) push('breaking', `${label}: no longer accepts ${removed.map((v) => `"${v}"`).join(', ')}`);
      if (added.length) push('minor', `${label}: also accepts ${added.map((v) => `"${v}"`).join(', ')}`);
    } else {
      if (added.length && a.enum) push('minor', `${label}: may now be ${added.map((v) => `"${v}"`).join(', ')} (clients that handle every value need it)`);
      if (removed.length) push('patch', `${label}: is no longer ${removed.map((v) => `"${v}"`).join(', ')}`);
    }
  }

  if (mode === 'request') {
    const tighter = (key, smaller) => {
      const x = a[key];
      const y = b[key];
      if (y === undefined) return;
      if (x === undefined || (smaller ? y < x : y > x)) push('breaking', `${label}: ${key} ${x ?? 'none'} -> ${y}`);
    };
    tighter('maxLength', true);
    tighter('maximum', true);
    tighter('maxItems', true);
    tighter('minLength', false);
    tighter('minimum', false);
    tighter('minItems', false);
    if (b.pattern && b.pattern !== a.pattern) push('breaking', `${label}: must match ${b.pattern}`);
  }

  if (ta === 'array' || tb === 'array') compareSchema(a.items ?? {}, b.items ?? {}, ctx, `${label}[]`, mode, depth + 1);

  if (a.properties || b.properties) {
    const pa = a.properties ?? {};
    const pb = b.properties ?? {};
    const ra = new Set(a.required ?? []);
    const rb = new Set(b.required ?? []);
    for (const key of Object.keys(pa)) {
      const name = `${label}.${key}`;
      if (!(key in pb)) {
        if (mode === 'response') push('breaking', `${name}: removed from the response`);
        else if (b.additionalProperties === false) push('breaking', `${name}: no longer accepted (sending it is a 422)`);
        else push('patch', `${name}: no longer used`);
        continue;
      }
      compareSchema(pa[key], pb[key], ctx, name, mode, depth + 1);
      if (mode === 'request' && !ra.has(key) && rb.has(key)) push('breaking', `${name}: now required`);
      if (mode === 'request' && ra.has(key) && !rb.has(key)) push('patch', `${name}: now optional`);
    }
    for (const key of Object.keys(pb)) {
      if (key in pa) continue;
      const name = `${label}.${key}`;
      if (mode === 'request') push(rb.has(key) ? 'breaking' : 'minor', rb.has(key) ? `${name}: new required input` : `${name}: new optional input`);
      else push('minor', `${name}: added to the response`);
    }
  }
}

const success = (op) => Object.keys(op?.responses ?? {}).find((s) => /^2\d\d$/.test(s));
const isPublic = (op, doc) => Array.isArray(op.security ?? doc.security) && (op.security ?? doc.security).length === 0;
const bodySchema = (op) => op?.requestBody?.content?.['application/json']?.schema;
const responseSchema = (op, status) => op?.responses?.[status]?.content?.['application/json']?.schema;
const paramKey = (p) => `${p.in}:${p.name}`;

/**
 * @returns {{ changes: Array<{ level: 'breaking'|'minor'|'patch', where: string, what: string }>, summary: { breaking, minor, patch }, bump: 'major'|'minor'|'patch'|null }}
 */
export function diffContracts(before, after) {
  const changes = [];
  const ops = (doc) => {
    const map = new Map();
    for (const [path, item] of Object.entries(doc?.paths ?? {})) {
      for (const m of METHODS) {
        if (!item?.[m]) continue;
        const params = [...(item.parameters ?? []), ...(item[m].parameters ?? [])];
        map.set(`${m.toUpperCase()} ${path}`, { ...item[m], parameters: params });
      }
    }
    return map;
  };
  const oa = ops(before);
  const ob = ops(after);

  for (const [key, a] of oa) {
    const push = (level, what) => changes.push({ level, where: key, what });
    const b = ob.get(key);
    if (!b) {
      push('breaking', 'route removed');
      continue;
    }
    const ctx = { before, after, push };
    if (isPublic(a, before) && !isPublic(b, after)) push('breaking', 'now needs a signed-in user (was public)');
    if (!isPublic(a, before) && isPublic(b, after)) push('patch', 'now public');
    const sa = success(a);
    const sb = success(b);
    if (sa && sb && sa !== sb) push('breaking', `success status ${sa} -> ${sb}`);

    const pa = new Map(a.parameters.map((p) => [paramKey(p), p]));
    const pb = new Map(b.parameters.map((p) => [paramKey(p), p]));
    for (const [k, p] of pa) {
      if (!pb.has(k)) push('breaking', `${p.in} parameter ${p.name} removed`);
      else {
        const q = pb.get(k);
        if (!p.required && q.required) push('breaking', `${p.in} parameter ${p.name} now required`);
        compareSchema(p.schema ?? {}, q.schema ?? {}, ctx, `${p.in} ${p.name}`, 'request');
      }
    }
    for (const [k, q] of pb) if (!pa.has(k)) push(q.required ? 'breaking' : 'minor', `${q.in} parameter ${q.name} added${q.required ? ' (required)' : ''}`);

    const ba = bodySchema(a);
    const bb = bodySchema(b);
    if (!ba && bb && b.requestBody?.required) push('breaking', 'now requires a request body');
    if (ba && bb) compareSchema(ba, bb, ctx, 'body', 'request');
    if (!a.requestBody?.required && b.requestBody?.required && ba) push('breaking', 'request body now required');

    if (sa && sb && sa === sb) {
      const ra = responseSchema(a, sa);
      const rb = responseSchema(b, sb);
      if (ra && rb) compareSchema(ra, rb, ctx, 'response', 'response');
      else if (ra && !rb) push('breaking', 'response body removed');
    }
  }
  for (const key of ob.keys()) if (!oa.has(key)) changes.push({ level: 'minor', where: key, what: 'route added' });

  const summary = { breaking: 0, minor: 0, patch: 0 };
  for (const c of changes) summary[c.level] += 1;
  const bump = summary.breaking ? 'major' : summary.minor ? 'minor' : summary.patch ? 'patch' : null;
  return { changes, summary, bump };
}

/** 1.4.2 + major -> 2.0.0; 0.x stays 0.x (a breaking change is a minor bump before 1.0). */
export function nextVersion(version, bump) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version ?? ''));
  if (!m || !bump) return null;
  let [major, minor, patch] = m.slice(1).map(Number);
  const level = major === 0 && bump === 'major' ? 'minor' : major === 0 && bump === 'minor' ? 'patch' : bump;
  if (level === 'major') [major, minor, patch] = [major + 1, 0, 0];
  else if (level === 'minor') [minor, patch] = [minor + 1, 0];
  else patch += 1;
  return `${major}.${minor}.${patch}`;
}
