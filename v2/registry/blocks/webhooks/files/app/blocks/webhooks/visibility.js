import { isOwner } from '#calm';
import { evaluatePolicy } from '#calm/resource/policy.js';

/**
 * May `user` read this record, by the same rules as GET /api/<resource>/:id?
 * Read policy, owner scoping and the service scope() (drafts, multi-tenancy...).
 *
 * The record is judged as it was when the event happened (the event's copy), so it also
 * works for deleted records. A scope() filter too complex for matchesFilter() is asked to
 * MongoDB instead, which is impossible for a deleted record: those are refused.
 */
export async function canRead(entry, doc, user, { deleted = false } = {}) {
  const decision = await evaluatePolicy(entry.def.policy.read, { user, action: 'read', doc });
  if (!decision.allow) return false;
  if (decision.scope === 'owner' && !isOwner(entry.def, doc, user)) return false;
  return inScope(entry, doc, user, { deleted });
}

/**
 * Is the record inside the service scope() for this user? Global endpoints skip the read
 * policy but not this: scope() is where apps keep tenants apart, even for their admins.
 */
export async function inScope(entry, doc, user, { deleted = false } = {}) {
  const scope = await entry.service.scope({ user });
  if (!scope || !Object.keys(scope).length) return true;
  const local = matchesFilter(scope, doc);
  if (local !== null) return local;
  if (deleted) return false;
  return Boolean(await entry.model.exists({ $and: [scope, { _id: doc._id }] }));
}

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date) && v._bsontype === undefined;

// Three-valued logic: true, false, or null for "cannot tell here".
const all = (results) => (results.includes(false) ? false : results.includes(null) ? null : true);
const any = (results) => (results.includes(true) ? true : results.includes(null) ? null : false);

function same(value, target) {
  if (isPlain(target)) return null; // regular expressions, embedded documents: not judged here
  if (target === null || target === undefined) return value === null || value === undefined;
  if (value === null || value === undefined) return false;
  if (target instanceof Date || value instanceof Date) return new Date(value).getTime() === new Date(target).getTime();
  if (isPlain(value)) return null;
  return String(value) === String(target); // ObjectId vs string ids
}

// Like MongoDB: { tags: 'a' } matches when the array contains 'a'.
const equals = (value, target) => (Array.isArray(value) && !Array.isArray(target) ? any(value.map((v) => same(v, target))) : same(value, target));

function fieldMatches(value, condition) {
  if (!isPlain(condition) || !Object.keys(condition).some((k) => k.startsWith('$'))) return equals(value, condition);
  return all(
    Object.entries(condition).map(([op, arg]) => {
      switch (op) {
        case '$eq': return equals(value, arg);
        case '$ne': { const r = equals(value, arg); return r === null ? null : !r; }
        case '$in': return Array.isArray(arg) ? any(arg.map((a) => equals(value, a))) : null;
        case '$nin': { if (!Array.isArray(arg)) return null; const r = any(arg.map((a) => equals(value, a))); return r === null ? null : !r; }
        case '$exists': return (value !== undefined) === Boolean(arg);
        default: return null;
      }
    }),
  );
}

function valueAt(doc, path) {
  let value = doc;
  for (const key of path.split('.')) {
    if (Array.isArray(value)) return { unknown: true };
    value = value?.[key];
  }
  return { value };
}

/**
 * Does `doc` match a MongoDB filter? Handles what scope() filters usually use (equality,
 * $and, $or, $nor, $eq, $ne, $in, $nin, $exists). Returns null for anything else, so
 * the caller never guesses.
 */
export function matchesFilter(filter, doc) {
  if (!isPlain(filter)) return null;
  return all(
    Object.entries(filter).map(([key, condition]) => {
      if (key === '$and') return Array.isArray(condition) ? all(condition.map((f) => matchesFilter(f, doc))) : null;
      if (key === '$or') return Array.isArray(condition) ? any(condition.map((f) => matchesFilter(f, doc))) : null;
      if (key === '$nor') {
        if (!Array.isArray(condition)) return null;
        const r = any(condition.map((f) => matchesFilter(f, doc)));
        return r === null ? null : !r;
      }
      if (key.startsWith('$')) return null;
      const { value, unknown } = valueAt(doc, key);
      return unknown ? null : fieldMatches(value, condition);
    }),
  );
}
