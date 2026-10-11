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

export function parsePolicy(expr) {
  if (expr === undefined || expr === null) return null;
  const list = Array.isArray(expr) ? expr : [expr];
  const tokens = [];
  for (const item of list) {
    if (typeof item === 'function') tokens.push(item);
    else if (typeof item === 'string') {
      for (const raw of item.split('|')) {
        const t = raw.trim();
        if (t) tokens.push(ALIASES[t] ?? t.replace(/^role:/, ''));
      }
    } else throw new Error(`Invalid policy: ${String(item)}`);
  }
  return tokens;
}

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
    if (typeof t === 'function') {
      if (await t(ctx)) return { allow: true };
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
