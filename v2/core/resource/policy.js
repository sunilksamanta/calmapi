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

const ALIASES = { auth: 'authenticated', user: 'authenticated', self: 'owner', nobody: 'none' };
const BUILT_IN = new Set(['public', 'authenticated', 'owner', 'none']);

// Named policies added by blocks with calm.policy(name, fn), e.g. 'member' from an
// organizations block. They resolve to their function when a policy is parsed.
const named = new Map();
export function registerPolicy(name, fn) {
  if (typeof name !== 'string' || !/^[a-z][\w-]*$/i.test(name)) throw new Error(`calm.policy(name, fn): invalid name "${name}"`);
  if (BUILT_IN.has(name) || name in ALIASES) throw new Error(`calm.policy: "${name}" is a built-in policy`);
  if (typeof fn !== 'function') throw new Error(`calm.policy('${name}', fn): fn must be a function`);
  Object.defineProperty(fn, 'name', { value: name });
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

/**
 * @param {Array} tokens parsed policy
 * @param {{ user?: object, action?: string, doc?: object, req?: object }} ctx
 */
export async function evaluatePolicy(tokens, ctx) {
  if (!tokens || tokens.length === 0) return { allow: false, reason: ctx.user ? 'forbidden' : 'unauthenticated' };
  const { user, action } = ctx;
  let ownerAllowed = false;

  for (const t of tokens) {
    if (t === 'public') return { allow: true };
    if (t === 'none') continue;
    if (typeof t === 'function' || named.has(t)) {
      if (await (typeof t === 'function' ? t : named.get(t))(ctx)) return { allow: true };
      continue;
    }
    if (!user) continue;
    if (t === 'authenticated') return { allow: true };
    if (t === 'owner') {
      // Creating a record makes you its owner.
      if (action === 'create') return { allow: true };
      ownerAllowed = true;
      continue;
    }
    if (hasRole(user, t)) return { allow: true };
  }

  if (ownerAllowed) return { allow: true, scope: 'owner' };
  return { allow: false, reason: user ? 'forbidden' : 'unauthenticated' };
}

/** True when `user` owns `doc` according to the resource's owner field. */
export function isOwner(resource, doc, user) {
  if (!user || !doc || !resource.ownerField) return false;
  const value = resource.ownerField === '_id' ? doc._id : doc[resource.ownerField];
  const id = value?._id ?? value;
  return id != null && String(id) === String(user.id);
}

/** Evaluate a field-level policy (visibleTo / writableBy) against one record. */
export async function fieldAllowed(tokens, { user, resource, doc, action }) {
  const res = await evaluatePolicy(tokens, { user, action, doc });
  if (!res.allow) return false;
  if (res.scope === 'owner') return action === 'create' || isOwner(resource, doc, user);
  return true;
}
