// Which agent edits need a human's eyes: protected paths from the project config
// (minus the session's --allow globs) and access rules inside resource files.
// `calm dev` marks matching Activity events, devtools shows a badge, `calm doctor`
// warns until the change is committed.

import { globToRegex } from './static-checks.js';

/** A line that grants or removes access: policies and field visibility or storage flags. */
export const ACCESS_RULE = /\b(policy|visibleTo|writableBy|owner\(|hidden\(|writeOnly\(|encrypted\()/;
// The actions inside a policy block: `update: 'owner | admin',`
const POLICY_ACTION = /^\s*(list|read|create|update|delete)\s*:\s*(['"`]|\(|\[|[A-Za-z_$])/;
const RESOURCE_FILE = /^app\/resources\/[^/]+\/[^/]+\.resource\.js$/;

const matches = (path, globs = []) => globs.some((g) => globToRegex(String(g)).test(path));

/** Protected by a glob and not opened up by an allow glob. */
export function isProtected(path, { protected: globs = [], allow = [] } = {}) {
  return matches(path, globs) && !matches(path, allow);
}

/** A resource file edit whose diff adds or removes an access rule line. */
export function touchesAccessRules(path, diff) {
  if (!RESOURCE_FILE.test(path) || !diff?.hunks) return false;
  return diff.hunks.some((h) => (h.lines ?? []).some((l) => (l[0] === '+' || l[0] === '-') && (ACCESS_RULE.test(l.slice(1)) || POLICY_ACTION.test(l.slice(1)))));
}

/** Why this agent edit is flagged ('protected path' | 'access rules'), or null. */
export function protectionReason(path, diff, session = {}) {
  if (isProtected(path, session)) return 'protected path';
  if (!matches(path, session.allow) && touchesAccessRules(path, diff)) return 'access rules';
  return null;
}
