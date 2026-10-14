// Access policies.
//
//   'public'                 anyone, signed in or not
//   'authenticated'          any signed-in user
//   'owner'                  the record's owner (see f.ref('user').owner())
//   'admin' / 'editor' ...   users having that role
//   'none'                   nobody (disables the route)
//   'owner | admin'          any of the alternatives
//   (ctx) => boolean         your own rule; ctx = { user, action, doc, req }
//
// evaluatePolicy() never throws. It answers one of:
//   { allow: true }                         go ahead
//   { allow: true, scope: 'owner' }         only on records the user owns
//   { allow: false, reason: 'unauthenticated' | 'forbidden' }
// Inside a traced request (devtools) or with { explain: true } it also carries
// `trace`: one { token, result: 'allow' | 'deny' | 'skip', why } per token, for the Path tab.

import { currentRequest } from '../context.js';
import { shortId } from '../utils/strings.js';

const ALIASES = { auth: 'authenticated', user: 'authenticated', self: 'owner', nobody: 'none' };
const BUILT_IN = new Set(['public', 'authenticated', 'owner', 'none']);

// Named policies added by blocks with calm.policy(name, fn), e.g. 'member' from an
// organizations block. They resolve to their function when a policy is parsed. Names may be
// namespaced with ':' ('team:admin'); 'role:' stays reserved for roles ('role:admin' is 'admin').
//
// A rule that depends on data the exposure matrix cannot invent (a membership, a plan) passes
// { simulate }: simulate({ user, action }) answers 'allow' | 'deny' | 'custom' for a persona,
// and the matrix (and so `calm audit`) uses that instead of calling fn with a fake record.
const named = new Map();
export function registerPolicy(name, fn, { simulate } = {}) {
  if (typeof name !== 'string' || !/^[a-z][\w-]*(:[a-z][\w-]*)*$/i.test(name)) throw new Error(`calm.policy(name, fn): invalid name "${name}"`);
  if (BUILT_IN.has(name) || name in ALIASES) throw new Error(`calm.policy: "${name}" is a built-in policy`);
  if (/^role:/i.test(name)) throw new Error(`calm.policy: "${name}": the role: prefix is reserved for roles`);
  if (typeof fn !== 'function') throw new Error(`calm.policy('${name}', fn): fn must be a function`);
  if (simulate !== undefined && typeof simulate !== 'function') throw new Error(`calm.policy('${name}', fn, { simulate }): simulate must be a function`);
  Object.defineProperty(fn, 'name', { value: name });
  if (simulate) Object.defineProperty(fn, 'calmSimulate', { value: simulate, configurable: true });
  named.set(name, fn);
}

export function parsePolicy(expr) {
  if (expr === undefined || expr === null) return null;
  const list = Array.isArray(expr) ? expr : [expr];
  const tokens = [];
  for (const item of list) {
    if (typeof item === 'function') tokens.push(item);
    else if (typeof item === 'string') {
      for (const raw of item.split('|')) {
        const t = raw.trim();
        if (!t) continue;
        if (named.has(t)) tokens.push(named.get(t));
        else tokens.push(ALIASES[t] ?? t.replace(/^role:/, ''));
      }
    } else throw new Error(`Invalid policy: ${String(item)}`);
  }
  return tokens;
}

/**
 * Resource files load before blocks register their policies, so a name such as 'member'
 * in resource() is still a plain string there. createApp resolves it once blocks are set up.
 */
export const resolveNamed = (tokens) => tokens?.map((t) => (typeof t === 'string' && named.has(t) ? named.get(t) : t)) ?? tokens;

export const describePolicy = (tokens) =>
  tokens ? tokens.map((t) => (typeof t === 'function' ? t.name || 'custom' : t)).join(' | ') : 'unset';

export const hasRole = (user, role) => Array.isArray(user?.roles) && user.roles.includes(role);

const tokenName = (t) => (typeof t === 'function' ? `${t.name || 'custom'}()` : named.has(t) ? `${t}()` : t);
const rolesText = (user) => (Array.isArray(user?.roles) && user.roles.length ? `user has roles [${user.roles.join(', ')}]` : 'user has no roles');

/**
 * @param {Array} tokens parsed policy
 * @param {{ user?: object, action?: string, doc?: object, req?: object, explain?: boolean }} ctx
 */
export async function evaluatePolicy(tokens, ctx) {
  if (!tokens || tokens.length === 0) return { allow: false, reason: ctx.user ? 'forbidden' : 'unauthenticated' };
  const { user, action } = ctx;
  // The per-token story costs strings, so it is only told inside a traced request (devtools
  // on) or on request: the exposure matrix evaluates thousands of policies at boot.
  const explain = ctx.explain ?? Boolean(currentRequest()?.steps);
  const trace = explain ? [] : null;
  const note = (token, result, why) => trace?.push({ token: tokenName(token), result, why });
  const answer = (decision) => {
    if (trace) for (const t of tokens.slice(trace.length)) note(t, 'skip', 'not needed');
    return trace ? { ...decision, trace } : decision;
  };
  let ownerAllowed = false;

  for (const t of tokens) {
    if (t === 'public') {
      note(t, 'allow', 'allowed for everyone');
      return answer({ allow: true });
    }
    if (t === 'none') {
      note(t, 'deny', 'nobody');
      continue;
    }
    if (typeof t === 'function' || named.has(t)) {
      const ok = await (typeof t === 'function' ? t : named.get(t))(ctx);
      note(t, ok ? 'allow' : 'deny', `returned ${String(ok)}`);
      if (ok) return answer({ allow: true });
      continue;
    }
    if (!user) {
      note(t, 'deny', 'no user');
      continue;
    }
    if (t === 'authenticated') {
      note(t, 'allow', 'signed in');
      return answer({ allow: true });
    }
    if (t === 'owner') {
      // Creating a record makes you its owner.
      if (action === 'create') {
        note(t, 'allow', 'creating a record makes you its owner');
        return answer({ allow: true });
      }
      note(t, 'allow', action === 'list' ? 'only records the user owns are listed' : 'if the user owns the record');
      ownerAllowed = true;
      continue;
    }
    note(t, hasRole(user, t) ? 'allow' : 'deny', rolesText(user));
    if (hasRole(user, t)) return answer({ allow: true });
  }

  if (ownerAllowed) return answer({ allow: true, scope: 'owner' });
  return answer({ allow: false, reason: user ? 'forbidden' : 'unauthenticated' });
}

/** True when `user` owns `doc` according to the resource's owner field. */
export function isOwner(resource, doc, user) {
  if (!user || !doc || !resource.ownerField) return false;
  const value = resource.ownerField === '_id' ? doc._id : doc[resource.ownerField];
  const id = value?._id ?? value;
  return id != null && String(id) === String(user.id);
}

/**
 * Settle the `owner` line of a policy trace once the record is in hand:
 * "doc.author 66e0…9a is not user 66f3…11".
 */
export function explainOwner(trace, resource, doc, user) {
  const line = trace?.find((t) => t.token === 'owner' && t.result === 'allow');
  if (!line) return;
  const field = resource.ownerField;
  if (!field) return Object.assign(line, { result: 'deny', why: `${resource.name} has no owner field` });
  const value = field === '_id' ? doc._id : doc[field];
  const id = value?._id ?? value;
  const mine = isOwner(resource, doc, user);
  const why = id == null ? `doc.${field} is unset` : `doc.${field} ${shortId(id)} ${mine ? 'is' : 'is not'} user ${shortId(user?.id)}`;
  Object.assign(line, { result: mine ? 'allow' : 'deny', why });
}

/** Evaluate a field-level policy (visibleTo / writableBy) against one record. */
export async function fieldAllowed(tokens, { user, resource, doc, action }) {
  const res = await evaluatePolicy(tokens, { user, action, doc, explain: false }); // per field, per record: no trace
  if (!res.allow) return false;
  if (res.scope === 'owner') return action === 'create' || isOwner(resource, doc, user);
  return true;
}
