// `calm audit`: authorization testing for your own API.
//
// Boots the app on a throwaway database, signs up a user per persona (owner, another
// user, admin, custom roles), seeds valid records from your field definitions, then
// calls every CRUD route as every persona and checks the answer against the exposure
// matrix: status codes, owner-only lists, and that no response contains a field the
// persona must not see. It also probes mass assignment, query injection and token
// handling. Nothing touches your real database.

import { randomBytes } from 'node:crypto';
import { createTestApp } from '../testing.js';
import { deepMerge } from '../config.js';
import { exposureMatrix } from './exposure.js';

const ALLOWED_STATUS = { create: [201], list: [200], read: [200], update: [200], delete: [204] };
const DENIED_STATUS = [401, 403, 404];

export async function runAudit({ root, config = {} } = {}) {
  const t = await createTestApp({
    root,
    config: deepMerge({ rateLimit: { enabled: false }, auth: { lockout: { maxAttempts: 0 } } }, config),
  });
  const results = [];
  const leaks = [];
  const probes = [];
  const notes = [];
  try {
    const matrix = await exposureMatrix(t.app);
    const byName = Object.fromEntries(matrix.resources.map((r) => [r.name, r]));
    const users = await makeUsers(t, matrix);
    const actorFor = (key) => (key === 'anonymous' ? null : key === 'owner' ? users.owner : users[key]);
    const seeded = {};
    let counter = 0;

    // ---- seeding -------------------------------------------------------------
    const payloadFor = (name, persona = 'owner') => {
      const { def } = t.app.registry.get(name);
      const res = byName[name];
      const body = {};
      for (const [key, field] of Object.entries(def.fields)) {
        const col = res.fields.find((f) => f.name === key);
        if (!field.isInput || field.opts.owner || col?.write[persona] !== 'yes') continue;
        if (!field.opts.required && !['string', 'text', 'email', 'enum'].includes(field.type)) continue;
        const value = sample(field, key, seeded, ++counter);
        if (value === undefined) {
          if (field.opts.required) return null;
          continue;
        }
        body[key] = value;
      }
      return body;
    };

    const createAs = async (name, actor) => {
      if (name === 'user') {
        const u = await t.signup({ name: `Audit seed ${++counter}` });
        return { id: u.id, actor: u };
      }
      const { def } = t.app.registry.get(name);
      const body = payloadFor(name);
      if (!body) return null;
      const res = await t.post(def.path, body, actor ?? users.owner);
      if (res.status === 201) return { id: res.body.data.id };
      // Fall back to the service (system call) when the API does not let the owner create.
      try {
        const doc = await t.app.service(name).create(
          { ...body, ...(def.ownerField && def.ownerField !== '_id' ? { [def.ownerField]: users.owner?.id } : {}) },
          { system: true, user: users.owner ? { ...users.owner.user, id: users.owner.id } : null },
        );
        return { id: String(doc._id) };
      } catch (err) {
        notes.push(`${name}: could not seed a record (${err.message})`);
        return null;
      }
    };

    for (const name of seedOrder(t.app.registry)) {
      seeded[name] = name === 'user' ? (users.owner ? { id: users.owner.id } : null) : await createAs(name);
    }

    // ---- CRUD x personas -----------------------------------------------------
    for (const r of matrix.resources) {
      const { def } = t.app.registry.get(r.name);
      const base = def.path;
      for (const persona of matrix.personas) {
        const actor = actorFor(persona.key);
        if (persona.key !== 'anonymous' && !actor) continue;
        const check = async (action, expected, run) => {
          if (expected === 'off') return;
          const res = await run();
          if (!res) return;
          const allowedExpected = expected === 'allow' || expected === 'own';
          let ok = allowedExpected ? ALLOWED_STATUS[action].includes(res.status) : DENIED_STATUS.includes(res.status);
          let note = null;
          if (!ok && allowedExpected && res.status === 404 && r.customScope) {
            ok = null;
            note = 'hidden by the service scope()';
          }
          if (expected === 'custom') {
            ok = null;
            note = 'custom policy function';
          }
          if (ok && expected === 'own' && res.status === 200) {
            const foreign = (res.body?.data ?? []).filter((item) => !isOwnedBy(def, item, actor?.id));
            if (foreign.length) {
              ok = false;
              note = `returned ${foreign.length} record(s) owned by someone else`;
            }
          }
          results.push({ resource: r.name, action, persona: persona.key, expected, status: res.status, ok, note });
          if (res.status === 200) inspectFields(r, def, persona.key, actor, res.body?.data, `${action} ${base}`);
        };

        const target = seeded[r.name];
        await check('list', r.actions.list[persona.key], () => t.get(base, actor));
        if (target) {
          await check('read', r.actions.read[persona.key], () => t.get(`${base}/${target.id}`, actor));
          const change = harmlessChange(def, r, persona.key);
          await check('update', r.actions.update[persona.key], () => t.patch(`${base}/${target.id}`, change, actor));
        }
        {
          const body = payloadFor(r.name, persona.key === 'anonymous' ? 'owner' : persona.key);
          if (body) await check('create', r.actions.create[persona.key], () => t.post(base, body, actor));
        }
        if (r.actions.delete[persona.key] !== 'off') {
          // A fresh record per persona, owned by the owner persona (or itself for users).
          const victim = await createAs(r.name);
          if (victim) {
            const deleter = r.name === 'user' && persona.key === 'owner' ? victim.actor : actor;
            await check('delete', r.actions.delete[persona.key], () => t.delete(`${base}/${victim.id}`, deleter));
          }
        }
      }

      // ---- mass assignment -----------------------------------------------------
      if (r.name !== 'user' && users.owner && r.actions.create.owner === 'allow') {
        const body = payloadFor(r.name);
        for (const [key, field] of Object.entries(def.fields)) {
          if (field.isInput && !field.opts.owner) continue;
          if (!body) break;
          const forged = { ...body, [key]: field.type === 'ref' ? users.user?.id ?? 'a'.repeat(24) : sample(field, key, seeded, ++counter) ?? 'forged' };
          const res = await t.post(base, forged, users.owner);
          probes.push({
            name: `mass assignment: ${r.name}.${key}`,
            ok: res.status === 422,
            detail: res.status === 422 ? 'rejected with 422' : `accepted (${res.status})`,
          });
        }
      }

      // ---- query hardening -------------------------------------------------------
      const reader = r.actions.list.anonymous === 'allow' ? null : users.admin;
      if (r.actions.list.admin !== 'off' && (reader || r.actions.list.anonymous === 'allow')) {
        for (const [label, q] of [['operator injection', 'x[$ne]=1'], ['limit cap', 'limit=100000'], ['unknown filter', 'definitelyNotAField=1']]) {
          const res = await t.get(`${base}?${q}`, reader);
          probes.push({ name: `${label}: ${r.name}`, ok: res.status === 400, detail: `${q} -> ${res.status}` });
        }
        const res = await t.get(`${base}/not-an-id`, reader);
        const leaky = JSON.stringify(res.body ?? '').match(/stack|Cast to ObjectId|mongoose/i);
        probes.push({ name: `error hygiene: ${r.name}`, ok: res.status === 404 && !leaky, detail: `bad id -> ${res.status}${leaky ? ' (internal details leaked)' : ''}` });
      }
    }

    // ---- token handling ----------------------------------------------------------
    if (t.app.auth && users.owner) {
      const forged = await t.get('/auth/me', 'calm_forged_token');
      probes.push({ name: 'forged session token', ok: forged.status === 401, detail: `-> ${forged.status}` });
      const inQuery = await t.get(`/auth/me?token=${users.owner.token}`);
      probes.push({ name: 'token in query string ignored', ok: inQuery.status === 401, detail: `-> ${inQuery.status}` });
      const login = await t.post('/auth/login', { email: users.owner.email, password: 'definitely-wrong-1' });
      const ghost = await t.post('/auth/login', { email: `ghost${randomBytes(3).toString('hex')}@example.test`, password: 'definitely-wrong-1' });
      probes.push({
        name: 'login does not reveal accounts',
        ok: login.status === ghost.status && login.body?.error?.message === ghost.body?.error?.message,
        detail: `${login.status} / ${ghost.status}`,
      });
    }

    const failed = results.filter((r) => r.ok === false).length + leaks.length + probes.filter((p) => !p.ok).length;
    return {
      ok: failed === 0,
      summary: {
        checks: results.length + probes.length,
        passed: results.filter((r) => r.ok === true).length + probes.filter((p) => p.ok).length,
        failed,
        skipped: results.filter((r) => r.ok === null).length,
        leaks: leaks.length,
      },
      results,
      leaks,
      probes,
      notes,
      matrix,
    };
  } finally {
    await t.close();
  }

  // ---- helpers bound to this run ----------------------------------------------
  function inspectFields(r, def, personaKey, actor, data, where) {
    const items = Array.isArray(data) ? data : data ? [data] : [];
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      const owned = actor && isOwnedBy(def, item, actor.id);
      for (const key of Object.keys(item)) {
        if (['id', 'createdAt', 'updatedAt'].includes(key)) continue;
        const col = r.fields.find((f) => f.name === key);
        const visible = col && (col.read[personaKey] === 'yes' || (owned && col.read.owner === 'yes'));
        if (!visible) leaks.push({ resource: r.name, persona: personaKey, field: key, where });
      }
    }
  }
}

async function makeUsers(t, matrix) {
  if (!t.app.auth) return {};
  const users = {
    owner: await t.signup({ name: 'Audit Owner' }),
    user: await t.signup({ name: 'Audit Other' }),
    admin: await t.signup({ name: 'Audit Admin', roles: ['user', 'admin'] }),
  };
  for (const p of matrix.personas) {
    if (p.key.startsWith('role:')) users[p.key] = await t.signup({ name: `Audit ${p.label}`, roles: ['user', p.label] });
  }
  return users;
}

function isOwnedBy(def, item, userId) {
  if (!def.ownerField) return false;
  const v = def.ownerField === '_id' ? item.id : item[def.ownerField];
  return String(v?.id ?? v) === String(userId);
}

function harmlessChange(def, r, persona) {
  for (const [key, field] of Object.entries(def.fields)) {
    const col = r.fields.find((f) => f.name === key);
    if (field.type === 'string' && field.isInput && !field.opts.immutable && !field.opts.unique && !field.opts.pattern && !field.opts.encrypted && col?.write[persona] === 'yes') {
      return { [key]: `Audit edit ${randomBytes(2).toString('hex')}` };
    }
  }
  return {};
}

function seedOrder(registry) {
  const names = [...registry.keys()];
  const deps = (name) =>
    Object.values(registry.get(name).def.fields)
      .map((f) => (f.type === 'ref' ? f.opts.ref : f.type === 'array' && f.opts.of.type === 'ref' ? f.opts.of.opts.ref : null))
      .filter((d) => d && d !== name && registry.has(d));
  const out = [];
  const visit = (n, stack = new Set()) => {
    if (out.includes(n) || stack.has(n)) return;
    stack.add(n);
    for (const d of deps(n)) visit(d, stack);
    out.push(n);
  };
  names.forEach((n) => visit(n));
  return ['user', ...out.filter((n) => n !== 'user')].filter((n) => registry.has(n));
}

/** A value that passes the field's own validation, or undefined when we cannot make one. */
export function sample(field, key, seeded, n) {
  const o = field.opts;
  const sized = (s) => {
    let v = s;
    if (o.min !== undefined && v.length < o.min) v = v.padEnd(o.min, 'x');
    if (o.max !== undefined && v.length > o.max) v = v.slice(0, o.max);
    return v;
  };
  if (o.pattern || (o.checks?.length && o.required) || o.standard) return o.default !== undefined ? o.default : undefined;
  switch (field.type) {
    case 'string': case 'text': return sized(`Audit ${key} ${n}${o.unique ? `-${randomBytes(3).toString('hex')}` : ''}`);
    case 'email': return `audit${n}-${randomBytes(2).toString('hex')}@example.test`;
    case 'url': return `https://example.test/${n}`;
    case 'password': return `Zx-${randomBytes(8).toString('hex')}`;
    case 'number': case 'integer': return Math.max(o.min ?? 1, Math.min(o.max ?? 1, 1));
    case 'boolean': return true;
    case 'date': return new Date(Date.now() + 86_400_000).toISOString();
    case 'enum': return o.default ?? o.values[0];
    case 'ref': return seeded[o.ref]?.id;
    case 'id': return 'a'.repeat(24);
    case 'array': {
      if (!o.min) return [];
      const item = sample(o.of, key, seeded, n);
      return item === undefined ? undefined : Array.from({ length: o.min }, () => item);
    }
    case 'object': {
      const out = {};
      for (const [k, sub] of Object.entries(o.shape)) {
        if (!sub.opts.required) continue;
        const v = sample(sub, k, seeded, n);
        if (v === undefined) return undefined;
        out[k] = v;
      }
      return out;
    }
    case 'json': return {};
    default: return undefined;
  }
}
