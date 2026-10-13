// Recorded traffic, replay and recorded tests (development only).
//
// With devtools on, every API request is also written, compactly, to .calm/traffic.jsonl:
// method, path, the route, who made it (user id and roles), the request body with secrets
// redacted, the status and the shape of the response (keys and types, never values). That
// file survives restarts, so after a change you can replay real traffic against the new
// code and see which answers changed:
//
//   calm replay                  the last 200 reads (GET), as the users who made them
//   calm replay --writes         writes too, between a checkpoint and its restore
//
// Any recorded request also becomes a test you can read and edit: test/recorded/<name>.test.js.

import http from 'node:http';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const TRAFFIC_FILE = join('.calm', 'traffic.jsonl');
const MAX_TRAFFIC_BYTES = 2 * 1024 * 1024;
const KEEP_LINES = 1000;
const REPLAY_HEADER = 'x-calm-replay';

// ---- shapes ---------------------------------------------------------------------------------

/** The shape of a JSON value: types and keys, never the values themselves. */
export function shapeOf(value, depth = 0) {
  // As the client sees it: dates, ObjectIds and anything with toJSON() are what JSON makes of them.
  if (value && typeof value === 'object' && typeof value.toJSON === 'function') value = value.toJSON();
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) {
    const items = value.slice(0, 20).map((v) => shapeOf(v, depth + 1));
    return { array: depth > 6 ? 'any' : mergeShapes(items), length: value.length };
  }
  if (typeof value === 'object') {
    if (depth > 6) return 'object';
    return { object: Object.fromEntries(Object.keys(value).sort().map((k) => [k, shapeOf(value[k], depth + 1)])) };
  }
  return typeof value;
}

/** One shape for the items of a list: keys seen in any item. */
function mergeShapes(shapes) {
  if (!shapes.length) return null;
  const objects = shapes.filter((s) => s && typeof s === 'object' && s.object);
  if (objects.length === shapes.length) {
    const keys = {};
    for (const s of objects) for (const [k, v] of Object.entries(s.object)) keys[k] ??= v;
    return { object: keys };
  }
  return shapes[0];
}

const kindOf = (s) => (s && typeof s === 'object' ? (s.object ? 'object' : 'array') : s);

/**
 * Differences between a recorded shape and a new one: fields added (a possible leak) or
 * removed, types changed, list lengths. `path` names where in the body.
 */
export function compareShapes(before, after, path = 'body', out = []) {
  const ka = kindOf(before);
  const kb = kindOf(after);
  if (ka !== kb) {
    if (!(ka === 'null' || kb === 'null')) out.push({ kind: 'type', path, text: `${path}: ${ka} -> ${kb}` });
    else if (ka !== kb) out.push({ kind: 'null', path, text: `${path}: ${ka} -> ${kb}` });
    return out;
  }
  if (ka === 'object') {
    for (const k of Object.keys(before.object)) {
      if (!(k in after.object)) out.push({ kind: 'removed', path: `${path}.${k}`, text: `${path}.${k}: no longer returned` });
      else compareShapes(before.object[k], after.object[k], `${path}.${k}`, out);
    }
    for (const k of Object.keys(after.object)) if (!(k in before.object)) out.push({ kind: 'added', path: `${path}.${k}`, text: `${path}.${k}: newly returned` });
  } else if (ka === 'array') {
    if (before.length !== after.length) out.push({ kind: 'length', path, text: `${path}: ${before.length} -> ${after.length} items` });
    if (before.array && after.array) compareShapes(before.array, after.array, `${path}[]`, out);
  }
  return out;
}

// ---- recording ----------------------------------------------------------------------------

export function recordTraffic(root, entry) {
  try {
    const file = join(root, TRAFFIC_FILE);
    mkdirSync(join(root, '.calm'), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
    if (statSync(file).size > MAX_TRAFFIC_BYTES) {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      writeFileSync(file, `${lines.slice(-KEEP_LINES).join('\n')}\n`);
    }
  } catch {
    // traffic is a convenience for replay; never fail a request over it
  }
}

export function readTraffic(root, { limit = 200, writes = false } = {}) {
  const file = join(root, TRAFFIC_FILE);
  if (!existsSync(file)) return [];
  const all = readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .filter((e) => writes || e.method === 'GET');
  return all.slice(-limit);
}

/** The compact traffic entry for a finished request (devtools calls this). */
export function trafficEntry(record, body) {
  return {
    id: record.id,
    time: record.startedAt,
    method: record.method,
    path: record.path,
    route: record.route ?? null,
    user: record.user ? { id: record.user.id, roles: record.user.roles ?? [] } : null,
    body: record.requestBody ?? null,
    status: record.status,
    shape: body === undefined ? null : shapeOf(body),
  };
}

export const isReplay = (req) => req.get?.(REPLAY_HEADER) === '1';

const hasRedacted = (value) => JSON.stringify(value ?? null).includes('[redacted]');

// ---- replay -------------------------------------------------------------------------------

/**
 * Replay recorded requests against the running code, as the users who made them, and
 * compare status and response shape. Writes run only with { writes: true }, between a
 * checkpoint and its restore, so your data ends as it began.
 */
export async function replay(app, { limit = 200, writes = false, onProgress } = {}) {
  if (app.config.mode === 'production') throw new Error('Replay is a development tool: it does not run in production.');
  if (!app.started) throw new Error('Start the app first (calm dev).');
  const entries = readTraffic(app.root, { limit, writes });
  const report = { total: entries.length, identical: 0, changed: [], skipped: [], failed: [], writes, checkpoint: null, durationMs: 0 };
  if (!entries.length) return report;
  const started = performance.now();

  let checkpoint = null;
  if (writes) {
    checkpoint = await app.checkpoints.create({ name: 'before replay', actor: { kind: 'human', name: 'replay' }, auto: true });
    report.checkpoint = checkpoint.id;
  }
  const server = http.createServer(app.express);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const tokens = new Map();
  const sessionIds = [];

  async function tokenFor(user) {
    if (!user) return null;
    if (tokens.has(user.id)) return tokens.get(user.id);
    let token = null;
    if (app.auth && app.registry.has('user')) {
      const doc = await app.model('user').findById(user.id).lean().catch(() => null);
      if (doc) {
        const session = await app.auth.service.createSession(doc, { ip: '127.0.0.1', get: () => 'calm replay' });
        token = session.token;
        const created = await app.auth.service.Session.findOne({ user: doc._id }).sort({ _id: -1 }).select('_id').lean();
        if (created) sessionIds.push(created._id);
      }
    }
    tokens.set(user.id, token);
    return token;
  }

  try {
    for (const [i, e] of entries.entries()) {
      onProgress?.(i, entries.length);
      const label = `${e.method} ${e.path}`;
      if (e.method !== 'GET' && hasRedacted(e.body)) {
        report.skipped.push({ id: e.id, request: label, reason: 'the body had secret values, which are never recorded' });
        continue;
      }
      if (e.path.startsWith(`${app.config.apiPrefix}/auth/`) && e.method !== 'GET') {
        report.skipped.push({ id: e.id, request: label, reason: 'sign-in and password routes are not replayed' });
        continue;
      }
      const token = await tokenFor(e.user);
      if (e.user && !token) {
        report.skipped.push({ id: e.id, request: label, reason: 'the user who made it no longer exists' });
        continue;
      }
      let res;
      let body;
      try {
        res = await fetch(`${origin}${e.path}`, {
          method: e.method,
          headers: { [REPLAY_HEADER]: '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(e.body != null && e.method !== 'GET' ? { 'content-type': 'application/json' } : {}) },
          body: e.body != null && e.method !== 'GET' ? JSON.stringify(e.body) : undefined,
        });
        const text = await res.text();
        body = text ? JSON.parse(text) : undefined;
      } catch (err) {
        report.failed.push({ id: e.id, request: label, error: err.message });
        continue;
      }
      const differences = [];
      if (res.status !== e.status) differences.push({ kind: 'status', text: `status ${e.status} -> ${res.status}` });
      if (e.shape && res.status === e.status) compareShapes(e.shape, body === undefined ? null : shapeOf(body), 'body', differences);
      if (differences.length) report.changed.push({ id: e.id, request: label, user: e.user, differences, newFields: differences.some((d) => d.kind === 'added') });
      else report.identical += 1;
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (sessionIds.length && app.auth) await app.auth.service.Session.deleteMany({ _id: { $in: sessionIds } }).catch(() => {});
    if (checkpoint) {
      await app.checkpoints.restore(checkpoint.id, { actor: { kind: 'human', name: 'replay' } });
      await app.checkpoints.delete(checkpoint.id, { actor: { kind: 'human', name: 'replay' } }).catch(() => {});
    }
  }
  report.durationMs = Math.round(performance.now() - started);
  return report;
}

// ---- recorded tests -------------------------------------------------------------------------

const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'request';

/**
 * A node:test file that makes the same request as the same kind of user on a throwaway
 * database and checks the status, and that no field is returned that was not before.
 * Records the route needs (/:id) are created from your field definitions.
 */
export function testFromRecord(app, record) {
  const prefix = app.config.apiPrefix;
  const route = app.routes.find((r) => `${prefix}${r.path}` === record.route && r.method === record.method);
  if (!route) throw new Error(`No route for ${record.method} ${record.route ?? record.path}: record the request again after a restart`);
  const resource = route.resource ? app.registry.get(route.resource) : null;
  const roles = record.user?.roles ?? null;
  // The query string as recorded (no URL with a placeholder host: calm about lists URLs in calm/).
  const query = /\?[^#]+/.exec(record.path)?.[0] ?? '';
  const needsDoc = /\/:id\b/.test(route.path) && resource;
  const body = record.method === 'GET' || record.requestBody == null ? null : record.requestBody;
  const redacted = hasRedacted(body);
  const shape = record.responseBody === undefined || record.responseBody === null ? null : shapeOf(record.responseBody);
  const asWho = record.user ? `a user with roles [${roles.join(', ')}]` : 'anonymous';
  const name = `${record.method} ${route.path}${query ? ' with a query' : ''} as ${asWho} answers ${record.status}`;
  const pathCode = needsDoc ? `\`${route.path.replace(':id', '${doc._id}')}${query}\`` : JSON.stringify(`${route.path}${query}`);
  const call = record.method === 'GET' || record.method === 'DELETE' ? `t.${record.method.toLowerCase()}(${pathCode}${record.user ? ', user' : ''})` : `t.${record.method.toLowerCase()}(${pathCode}, ${JSON.stringify(body ?? {}, null, 2).replace(/\n/g, '\n    ')}${record.user ? ', user' : ', null'})`;
  const ownerField = resource?.def.ownerField && resource.def.ownerField !== '_id' ? resource.def.ownerField : null;
  const lines = [
    `// Recorded in devtools on ${new Date().toISOString().slice(0, 10)} from a real request: ${record.method} ${record.path}`,
    `// (${record.status}, ${asWho}). It runs on a throwaway database, so the data is made up.`,
    '// It is a normal test: edit it as you like.',
    '',
    "import { test, before, after } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { createTestApp } from '#calm/testing.js';",
    "import { shapeOf, compareShapes } from '#calm/replay.js';",
    needsDoc ? "import { seed } from '#calm/seed.js';" : null,
    '',
    'let t;',
    'before(async () => {',
    '  t = await createTestApp();',
    '});',
    'after(() => t.close());',
    '',
    `test(${JSON.stringify(name)}, async () => {`,
    record.user ? `  const user = await t.signup({ roles: ${JSON.stringify(roles)} });` : null,
    needsDoc ? `  await seed(t.app, { resource: '${resource.def.name}', count: 1 });` : null,
    needsDoc ? `  const doc = await t.app.model('${resource.def.name}').findOne().sort({ _id: -1 }).lean();` : null,
    needsDoc && ownerField && record.user && record.status < 400 ? `  await t.app.model('${resource.def.name}').updateOne({ _id: doc._id }, { $set: { ${ownerField}: user.id } }); // the recorded user owned it` : null,
    redacted ? '  // The recorded body had secret values (shown as [redacted]): put real ones in before running.' : null,
    `  const res = await ${call};`,
    `  assert.equal(res.status, ${record.status});`,
    shape ? `  // No field may be returned that was not returned when this was recorded (fields that are\n  // simply empty in the made-up data are fine).\n  const recorded = ${JSON.stringify(shape)};\n  const leaks = compareShapes(recorded, shapeOf(res.body)).filter((d) => d.kind === 'added');\n  assert.deepEqual(leaks, []);` : null,
    '});',
    '',
  ].filter((l) => l !== null);
  const file = join('test', 'recorded', `${slug(`${record.method} ${route.path} ${record.user ? roles.join('-') || 'user' : 'anonymous'} ${record.status}`)}.test.js`);
  return { file, content: lines.join('\n') };
}
