// Behavior as data, and the difference between two versions of it. A snapshot is computed
// from the same definitions the app serves (calm/snapshot.js) plus a scan of the source for
// hosts, events and env vars. `calm diff`, reviews (calm/review.js) and devtools all use these
// pure functions, so a change reads the same everywhere.

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { behaviorSnapshot } from './snapshot.js';

/** Files under dir, relative posix paths, never node_modules or dot folders. */
function walk(dir, base = '') {
  const out = [];
  let entries;
  try {
    entries = readdirSync(join(dir, base), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, rel));
    else out.push(rel);
  }
  return out.sort();
}
const readText = (file) => readFileSync(file, 'utf8');

// ---- source scan -------------------------------------------------------------------------

const SCAN_DIRS = ['app', 'calm'];
const SCAN_FILES = ['calm.config.js', 'server.js'];
const CODE = /\.(m?js|cjs|ts)$/;
const MAX_FILE = 512 * 1024;
const URL_RE = /https?:\/\/([a-z0-9][a-z0-9.-]*\.[a-z]{2,}|localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?/gi;
// Hosts that are documentation, examples or this machine, never a call the app makes.
const DOC_HOSTS = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|example\.(com|org|net|test)|.*\.example\.com|.*\.calmapi\.dev|calmapi\.dev|json-schema\.org|www\.w3\.org|github\.com|.*\.github\.com|datatracker\.ietf\.org|www\.rfc-editor\.org|developer\.mozilla\.org|nodejs\.org|npmjs\.com|www\.npmjs\.com|developers\.google\.com|docs\.expo\.dev|expo\.dev|firebase\.google\.com|cloud\.google\.com|resend\.com|developer\.apple\.com|www\.iana\.org|spec\.openapis\.org|schemas\..*|xmlns\..*)$/i;
const EVENT_RE = /\bemit\(\s*['"`]([\w.:-]+)['"`]/g;
const ENV_RE = /\bprocess\.env\.([A-Z][A-Z0-9_]*)|\benv\.([A-Z][A-Z0-9_]*)\b|\bcalm\.env\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g;
const FRAMEWORK_ENV = new Set(['NODE_ENV', 'PORT', 'HOST', 'MONGODB_URI', 'APP_URL', 'CORS_ORIGINS', 'TRUST_PROXY', 'LOG_LEVEL', 'CALM_ENCRYPTION_KEYS', 'CALM_ENCRYPTION_KEY', 'CALM_SKIP_ENV_FILE', 'MONGODB_TEST_URI', 'CALM_TEST_LOG', 'CI', 'NO_COLOR', 'FORCE_COLOR', 'USER', 'HOME']);

const stripComments = (text) => text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Hosts, events and env vars read, found in the project's own code (never node_modules). */
export function scanSource(root) {
  const files = [];
  for (const dir of SCAN_DIRS) for (const rel of walk(join(root, dir))) files.push(`${dir}/${rel}`);
  for (const f of SCAN_FILES) files.push(f);
  const hosts = new Map();
  const events = new Map();
  const env = new Map();
  for (const rel of files) {
    let text;
    try {
      if (!CODE.test(rel)) continue;
      text = readText(join(root, rel));
    } catch {
      continue;
    }
    if (text.length > MAX_FILE) continue;
    const code = stripComments(text);
    for (const m of code.matchAll(URL_RE)) {
      const host = m[1].toLowerCase();
      if (DOC_HOSTS.test(host)) continue;
      if (!hosts.has(host)) hosts.set(host, new Set());
      hosts.get(host).add(rel);
    }
    for (const m of code.matchAll(EVENT_RE)) {
      if (m[1].includes('${')) continue;
      if (!events.has(m[1])) events.set(m[1], new Set());
      events.get(m[1]).add(rel);
    }
    if (rel.startsWith('calm/')) continue; // the framework's own env vars are documented, not a change
    for (const m of code.matchAll(ENV_RE)) {
      const key = m[1] ?? m[2] ?? m[3];
      if (FRAMEWORK_ENV.has(key)) continue;
      if (!env.has(key)) env.set(key, new Set());
      env.get(key).add(rel);
    }
  }
  const sorted = (map) => [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
  return {
    hosts: sorted(hosts).map(([host, set]) => ({ host, files: [...set].sort() })),
    events: sorted(events).map(([name, set]) => ({ name, files: [...set].sort() })),
    env: sorted(env).map(([key, set]) => ({ key, files: [...set].sort() })),
  };
}

// ---- the full snapshot ----------------------------------------------------------------------

/**
 * The runtime snapshot plus what only the source tells: hosts, events, env vars read by app/
 * code. What `calm diff` compares and what a review signs.
 */
export function mergeScan(base, scan) {
  const envKeys = new Set(base.env.map((e) => e.key));
  const env = base.env.map((e) => ({ key: e.key, required: e.required ?? false, secret: Boolean(e.secret), from: e.from, files: e.files ?? (e.file ? [e.file] : []) }));
  for (const e of scan.env) if (!envKeys.has(e.key)) env.push({ key: e.key, required: 'unknown', secret: false, from: 'code', files: e.files });
  env.sort((a, b) => a.key.localeCompare(b.key));
  return { ...base, env, hosts: scan.hosts, events: scan.events };
}

export async function fullSnapshot(app) {
  return mergeScan(await behaviorSnapshot(app), scanSource(app.root));
}

// ---- diffing -----------------------------------------------------------------------------

const RANK = { deny: 0, never: 0, no: 0, own: 1, custom: 1, yes: 2, allow: 2 };

/** looser | tighter | mixed | same, comparing two persona maps. */
export function direction(before = {}, after = {}) {
  let up = false;
  let down = false;
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const a = RANK[before[key]] ?? 0;
    const b = RANK[after[key]] ?? 0;
    if (b > a) up = true;
    if (b < a) down = true;
    if (b === a && before[key] !== after[key] && (before[key] === 'custom' || after[key] === 'custom')) up = true; // custom code is unknown: treat as widening
  }
  return up && down ? 'mixed' : up ? 'looser' : down ? 'tighter' : 'same';
}

/** 'everyone' | 'signed-in users' | 'the owner' | 'admins' | 'nobody' | 'custom' from a persona map (yes/allow counts). */
export function audience(map = {}) {
  const ok = (k) => map[k] === 'yes' || map[k] === 'allow' || map[k] === 'own';
  if (map.anonymous === 'custom' || map.user === 'custom') return 'custom rule';
  if (ok('anonymous')) return 'everyone';
  if (ok('user')) return 'signed-in users';
  const roles = Object.keys(map).filter((k) => k.startsWith('role:') && ok(k)).map((k) => k.slice(5));
  if (ok('owner')) return roles.length ? `the owner, ${roles.join(', ')}${ok('admin') ? ' and admins' : ''}` : ok('admin') ? 'the owner and admins' : 'the owner';
  if (roles.length) return `${roles.join(', ')}${ok('admin') ? ' and admins' : ''}`;
  if (ok('admin')) return 'admins';
  return 'nobody';
}

const widensOnAdd = (access) => Object.entries(access).some(([k, v]) => k !== 'admin' && v !== 'deny');
const byKey = (list, key) => new Map((list ?? []).map((x) => [key(x), x]));

/**
 * Compare two snapshots. Returns { changes, summary: { total, widen, tighten } }.
 * A change: { kind, change: 'added' | 'removed' | 'changed', key, detail, direction, file, before, after, personal }
 */
export function diffSnapshots(before, after) {
  const changes = [];
  const push = (c) => changes.push({ direction: null, file: null, personal: false, ...c });

  // Routes
  const rk = (r) => `${r.method} ${r.path}`;
  const rb = byKey(before.routes, rk);
  const ra = byKey(after.routes, rk);
  for (const [key, r] of ra) {
    const old = rb.get(key);
    if (!old) {
      push({ kind: 'route', change: 'added', key, detail: `policy: ${r.policy}`, direction: widensOnAdd(r.access) ? 'looser' : null, file: r.file, after: r });
      continue;
    }
    const parts = [];
    let dir = null;
    if (old.policy !== r.policy) {
      dir = direction(old.access, r.access);
      parts.push(`policy: ${old.policy} -> ${r.policy}`);
    }
    if ((old.rateLimit ?? null) !== (r.rateLimit ?? null)) {
      parts.push(`rate limit: ${old.rateLimit ?? 'none'} -> ${r.rateLimit ?? 'none'}`);
      if (!r.rateLimit) dir = dir === 'tighter' ? 'mixed' : 'looser';
    }
    if ((old.scope ?? null) !== (r.scope ?? null)) parts.push(`scope: ${old.scope ?? 'none'} -> ${r.scope ?? 'none'}`);
    if (parts.length) push({ kind: 'route', change: 'changed', key, detail: parts.join(', '), direction: dir === 'same' ? null : dir, file: r.file ?? old.file, before: old, after: r });
  }
  for (const [key, r] of rb) if (!ra.has(key)) push({ kind: 'route', change: 'removed', key, detail: `policy: ${r.policy}`, direction: 'tighter', file: r.file, before: r });

  // Resources and fields
  const resB = byKey(before.resources, (r) => r.name);
  const resA = byKey(after.resources, (r) => r.name);
  for (const [name, r] of resA) {
    const old = resB.get(name);
    if (!old) {
      push({ kind: 'resource', change: 'added', key: name, detail: `${r.fields.length} fields, ${r.path}`, file: r.file, after: r });
      for (const f of r.fields) {
        const personalPublic = f.pii && audience(f.read) === 'everyone';
        push({ kind: 'field', change: 'added', key: `${name}.${f.name}`, detail: `visible to: ${audience(f.read)}`, direction: personalPublic ? 'looser' : null, file: r.file, personal: f.pii, after: f });
      }
      continue;
    }
    const fb = byKey(old.fields, (f) => f.name);
    const fa = byKey(r.fields, (f) => f.name);
    for (const [fname, f] of fa) {
      const of = fb.get(fname);
      const key = `${name}.${fname}`;
      if (!of) {
        const personalPublic = f.pii && audience(f.read) === 'everyone';
        push({ kind: 'field', change: 'added', key, detail: `visible to: ${audience(f.read)}`, direction: personalPublic ? 'looser' : null, file: r.file, personal: f.pii, after: f });
        continue;
      }
      const parts = [];
      let dir = null;
      const dr = direction(of.read, f.read);
      if (dr !== 'same') {
        parts.push(`visible to: ${audience(of.read)} -> ${audience(f.read)}`);
        dir = dr;
      }
      const dw = direction(of.write, f.write);
      if (dw !== 'same') {
        parts.push(`writable by: ${audience(of.write)} -> ${audience(f.write)}`);
        dir = dir && dir !== dw ? 'mixed' : (dir ?? dw);
      }
      if (of.encrypted !== f.encrypted) {
        parts.push(f.encrypted ? 'now encrypted at rest' : 'no longer encrypted at rest');
        if (!f.encrypted) dir = dir && dir !== 'looser' ? 'mixed' : 'looser';
      }
      if (of.type !== f.type) parts.push(`type: ${of.type} -> ${f.type}`);
      if (parts.length) push({ kind: 'field', change: 'changed', key, detail: parts.join(', '), direction: dir, file: r.file, personal: f.pii || of.pii, before: of, after: f });
    }
    for (const [fname, f] of fb) if (!fa.has(fname)) push({ kind: 'field', change: 'removed', key: `${name}.${fname}`, detail: `was visible to: ${audience(f.read)}`, file: r.file, personal: f.pii, before: f });
  }
  for (const [name, r] of resB) if (!resA.has(name)) push({ kind: 'resource', change: 'removed', key: name, detail: r.path, direction: 'tighter', file: r.file, before: r });

  // Env, hosts, events, blocks, invariants
  const simple = (kind, listB, listA, keyOf, detailOf, { addedDir = null, removedDir = null, fileOf = () => null } = {}) => {
    const mb = byKey(listB, keyOf);
    const ma = byKey(listA, keyOf);
    for (const [key, item] of ma) {
      if (!mb.has(key)) push({ kind, change: 'added', key, detail: detailOf(item), direction: addedDir, file: fileOf(item), after: item });
      else if (detailOf(item) !== detailOf(mb.get(key))) push({ kind, change: 'changed', key, detail: `${detailOf(mb.get(key))} -> ${detailOf(item)}`, file: fileOf(item), before: mb.get(key), after: item });
    }
    for (const [key, item] of mb) if (!ma.has(key)) push({ kind, change: 'removed', key, detail: detailOf(item), direction: removedDir, file: fileOf(item), before: item });
  };
  const envDetail = (e) => (e.required === true ? 'required' : e.required === 'production' ? 'required in production' : e.required === 'unknown' ? `read by ${e.from}` : 'optional') + (e.secret ? ', secret' : '');
  simple('env', before.env, after.env, (e) => e.key, envDetail, { fileOf: (e) => e.files?.[0] ?? null });
  simple('host', before.hosts, after.hosts, (h) => h.host, () => 'reachable from the code', { fileOf: (h) => h.files?.[0] ?? null });
  simple('event', before.events, after.events, (e) => e.name, () => 'emitted', { fileOf: (e) => e.files?.[0] ?? null });
  simple('block', before.blocks, after.blocks, (b) => b.name, () => 'installed', { fileOf: (b) => b.file });
  simple('invariant', before.invariants, after.invariants, (i) => i.rule, (i) => (i.except?.length ? `except ${i.except.join(', ')}` : 'promised'), { addedDir: 'tighter', removedDir: 'looser' });

  const widen = changes.filter((c) => c.direction === 'looser' || c.direction === 'mixed').length;
  const tighten = changes.filter((c) => c.direction === 'tighter').length;
  return { changes, summary: { total: changes.length, widen, tighten } };
}

// ---- text ---------------------------------------------------------------------------------

const MARK = { added: '+', removed: '-', changed: '~' };
const KIND_WORD = { env: 'env ', host: 'calls', event: 'emits', block: 'block', invariant: 'invariant', resource: 'resource' };

/** Rows for a terminal table: [mark, what, detail, note]. Colors are applied by the caller. */
export function diffRows(result) {
  return result.changes.map((c) => {
    const what = c.kind === 'route' ? c.key.replace(/^(\w+) /, (_m, m) => `${m.padEnd(6)} `) : c.kind === 'field' ? c.key : `${KIND_WORD[c.kind] ?? c.kind} ${c.key}`;
    const notes = [];
    if (c.direction === 'looser' || c.direction === 'mixed') notes.push(c.direction === 'mixed' ? 'looser for some' : 'looser');
    else if (c.direction === 'tighter') notes.push('tighter');
    if (c.personal) notes.push('personal data');
    return { mark: MARK[c.change], what, detail: c.detail, note: notes.join(', '), file: c.file ?? '', change: c };
  });
}
