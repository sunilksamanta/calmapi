// Team roles, ordered from most to least powerful: ['owner', 'admin', 'member'] by default,
// with your own roles from options.roles (e.g. ['owner', 'admin', 'billing', 'member', 'viewer']).
//
//  - 'team:<role>' allows that role and every role above it ('team:admin' = admins and owners).
//  - 'member' allows anyone in the team, whatever their role.
//  - You can grant roles up to your own. Only owners grant (or take away) 'owner'.
//  - A role that is no longer configured counts as the lowest one: removing a role from
//    options never promotes anybody.

export const OWNER = 'owner';
export const ADMIN = 'admin';

export function createRoles(list = [OWNER, ADMIN, 'member']) {
  if (!Array.isArray(list) || list[0] !== OWNER || list[1] !== ADMIN || list.length < 3) {
    throw new Error(`teams: options.roles must start with 'owner', 'admin' and list at least one more role, e.g. ['owner', 'admin', 'member']`);
  }
  for (const role of list) {
    if (typeof role !== 'string' || !/^[a-z][a-z0-9-]*$/.test(role)) throw new Error(`teams: role "${role}" must be lowercase letters, digits and -`);
  }
  if (new Set(list).size !== list.length) throw new Error('teams: options.roles has duplicates');

  const rank = (role) => {
    const i = list.indexOf(role);
    return i === -1 ? list.length : i;
  };
  return {
    list: [...list],
    lowest: list.at(-1),
    has: (role) => list.includes(role),
    rank,
    /** True when `role` is `min` or above it. */
    atLeast: (role, min) => role !== undefined && role !== null && rank(role) <= rank(min),
    /** May someone with `actor` give `role` to a person? Up to their own role; owner only by owners. */
    canGrant: (actor, role) => list.includes(role) && (actor === OWNER || (role !== OWNER && rank(role) >= rank(actor))),
  };
}
