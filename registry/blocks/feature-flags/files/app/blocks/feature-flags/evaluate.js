import { createHash } from 'node:crypto';

// Flag evaluation, pure functions only (no database, no cache), so the rules are easy to
// read and to test.
//
//   enabled off                -> off for everyone (kill switch)
//   user id in users           -> on
//   any of the user's roles    -> on
//   rollout 100                -> on, signed in or not
//   rollout 1..99              -> on when bucket(key, id) < rollout, id = user id or anonymousId
//   otherwise                  -> off (visitors without an anonymousId included)
//
// bucket() hashes the flag key with the id, so every flag splits users differently, and a
// user keeps the same bucket forever: raising rollout from 10 to 20 keeps the first 10%
// and adds another 10%, nobody flips back and forth.

export const KEY_PATTERN = /^[A-Za-z0-9][\w.-]{0,99}$/;
const VARIANT_NAME = /^[\w-]{1,50}$/;

const hashInt = (text) => createHash('sha256').update(text).digest().readUInt32BE(0);

/** 0..modulo-1, stable for a flag and an id. */
export const bucket = (key, id, modulo = 100) => hashInt(`${key}:${id}`) % modulo;

/** Normalize who is asking: { user } (a document or ctx.user), { userId, roles } or { anonymousId }. */
export function subjectOf({ user, userId, roles, anonymousId } = {}) {
  const id = userId ?? (user ? String(user.id ?? user._id) : null);
  return { userId: id ? String(id) : null, roles: roles ?? user?.roles ?? [], anonymousId: anonymousId ? String(anonymousId) : null };
}

export function isEnabled(flag, subject) {
  if (!flag?.enabled) return false;
  const unit = subject.userId ?? subject.anonymousId;
  if (unit && flag.users?.includes(unit)) return true;
  if (subject.userId && flag.roles?.some((role) => subject.roles.includes(role))) return true;
  const rollout = flag.rollout ?? 0;
  if (rollout >= 100) return true;
  if (rollout <= 0 || !unit) return false;
  return bucket(flag.key, unit) < rollout;
}

/**
 * The variant this subject sees: null when the flag is off for them, has no variants, or
 * the caller has no stable id. Weighted, and hashed separately from the rollout so the
 * split inside the rollout is not skewed.
 */
export function variantOf(flag, subject) {
  if (!isEnabled(flag, subject)) return null;
  const unit = subject.userId ?? subject.anonymousId;
  const entries = Object.entries(flag.variants ?? {}).filter(([, weight]) => weight > 0);
  if (!unit || !entries.length) return null;
  const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
  let n = hashInt(`${flag.key}:variant:${unit}`) % total;
  for (const [name, weight] of entries) {
    if (n < weight) return name;
    n -= weight;
  }
  return null;
}

/** f.json().check(): { name: weight } with whole, non-negative weights. */
export function checkVariants(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'Must be an object like { "control": 50, "new": 50 }';
  const entries = Object.entries(value);
  if (entries.length > 20) return 'At most 20 variants';
  for (const [name, weight] of entries) {
    if (!VARIANT_NAME.test(name)) return `Variant "${name}": use letters, digits, - and _ (max 50)`;
    if (!Number.isInteger(weight) || weight < 0 || weight > 10_000) return `Variant "${name}": weight must be a whole number from 0 to 10000`;
  }
  if (entries.length && !entries.some(([, weight]) => weight > 0)) return 'At least one variant needs a weight above 0';
  return true;
}
