// Reviews: the moment a person reads what changed and signs it.
//
// A review compares what the app does now with what was last signed: the behavior diff
// (calm/behavior.js), the files AI agents changed since that signature, and what the agents
// declared they would change (calm_declare) next to what they did. Signing writes two plain
// files that belong in git:
//
//   .calm/reviews/baseline.json         the behavior that was accepted, compared against next time
//   .calm/reviews/<date>-<id>.json      who signed, when, at which commit, and what they accepted
//
// `calm review` prints the same review, `calm review --ci` fails a build whose behavior widens
// access beyond the last signature, and devtools has a Review panel. Agents can read a review
// (calm_review) and declare their intent (calm_declare), but never sign: signing is for a person.

import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { fullSnapshot, diffSnapshots } from './behavior.js';

export const REVIEWS_DIR = join('.calm', 'reviews');
export const DECLARATIONS_DIR = join('.calm', 'declarations');
const KINDS = new Set(['route', 'field', 'resource', 'env', 'host', 'event', 'block', 'invariant']);

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
const hash = (value) => `sha256:${createHash('sha256').update(JSON.stringify(value)).digest('hex')}`;

/** The last signed baseline, or null when nothing was ever signed. */
export function readBaseline(root) {
  return readJson(join(root, REVIEWS_DIR, 'baseline.json'));
}

/** Signed reviews, newest first. */
export function listReviews(root) {
  const dir = join(root, REVIEWS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && f !== 'baseline.json')
    .map((f) => readJson(join(dir, f)))
    .filter((r) => r?.id && r.signedAt)
    .sort((a, b) => b.signedAt.localeCompare(a.signedAt));
}

function readActivity(root) {
  const file = join(root, '.calm', 'activity.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Files whose last change since `since` was made by an AI agent: authorship that nobody has
 * signed yet. A later edit by a person, or a signature, clears a file.
 */
export function unreviewedFiles(root, since = null) {
  // An agent's edit stays unsigned until a person signs, even if they edited the file after it:
  // touching a file is not reviewing it.
  const agentEdit = new Map();
  const last = new Map();
  for (const e of readActivity(root)) {
    if (e.type !== 'file' || (since && e.time <= since)) continue;
    last.set(e.path, e);
    if (e.actor?.kind === 'agent') agentEdit.set(e.path, e);
  }
  return [...agentEdit.values()]
    .filter((e) => last.get(e.path).change !== 'deleted')
    .map((e) => ({ path: e.path, agent: e.actor.name, at: e.time, via: e.via ?? null, protected: Boolean(e.protected), reason: e.reason ?? null, editedAfter: last.get(e.path) !== e }))
    .sort((a, b) => b.at.localeCompare(a.at));
}

/** The last test run an agent made with calm_test since `since`: { ok, at, summary } or null. */
function lastTests(root, since) {
  const runs = readActivity(root).filter((e) => e.type === 'agent' && e.tool === 'calm_test' && (!since || e.time > since));
  const e = runs.at(-1);
  if (!e) return null;
  let pass = null;
  let fail = null;
  try {
    const out = JSON.parse(e.summary ?? '');
    pass = out.pass ?? null;
    fail = out.fail ?? null;
  } catch {
    const m = /"pass":\s*(\d+)[\s\S]*?"fail":\s*(\d+)/.exec(e.summary ?? '');
    if (m) [pass, fail] = [Number(m[1]), Number(m[2])];
  }
  return { at: e.time, by: e.client, pass, fail, ok: e.ok !== false && fail === 0 };
}

// ---- declarations -----------------------------------------------------------------------

/**
 * Normalize what an agent declares: "route POST /api/refunds", "field order.total",
 * { kind: 'route', key: 'POST /api/refunds', policy: 'admin' }, "env STRIPE_KEY".
 */
export function normalizeDeclared(item) {
  if (typeof item === 'string') {
    const m = /^\s*(route|field|resource|env|host|event|block|invariant)\s+(.+?)\s*$/i.exec(item);
    if (!m) throw new Error(`Cannot read "${item}": start with route, field, resource, env, host, event, block or invariant, e.g. "route POST /api/refunds"`);
    return normalizeDeclared({ kind: m[1].toLowerCase(), key: m[2] });
  }
  if (!item || typeof item !== 'object') throw new Error('Each change is a string ("route POST /api/refunds") or { kind, key }');
  const kind = String(item.kind ?? '').toLowerCase();
  if (!KINDS.has(kind)) throw new Error(`Unknown kind "${item.kind}": ${[...KINDS].join(', ')}`);
  if (typeof item.key !== 'string' || !item.key.trim()) throw new Error(`A ${kind} change needs a key`);
  let key = item.key.trim().replace(/\s+/g, ' ');
  if (kind === 'route') {
    const m = /^([a-z]+)\s+(\S+)$/i.exec(key);
    if (!m) throw new Error(`A route is "METHOD /path": "${key}"`);
    key = `${m[1].toUpperCase()} ${m[2].replace(/\/+$/, '') || '/'}`;
  }
  const out = { kind, key };
  if (item.change && ['added', 'removed', 'changed'].includes(item.change)) out.change = item.change;
  if (typeof item.policy === 'string' && item.policy.trim()) out.policy = item.policy.trim().replace(/\s*\|\s*/g, ' | ');
  return out;
}

export function writeDeclaration(root, { intent, changes, client = 'agent' }) {
  if (typeof intent !== 'string' || !intent.trim()) throw new Error('Say what you are about to do in one line (intent)');
  if (!Array.isArray(changes)) throw new Error('changes is a list: ["route POST /api/refunds", "field order.total"]');
  if (changes.length > 100) throw new Error('At most 100 changes per declaration');
  const list = changes.map(normalizeDeclared);
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const declaration = { id, intent: intent.trim().slice(0, 300), client: String(client).slice(0, 60), declaredAt: new Date().toISOString(), changes: list };
  mkdirSync(join(root, DECLARATIONS_DIR), { recursive: true });
  writeFileSync(join(root, DECLARATIONS_DIR, `${id}.json`), `${JSON.stringify(declaration, null, 2)}\n`);
  activity(root, { type: 'declaration', id, client: declaration.client, intent: declaration.intent, changes: list.length });
  return declaration;
}

export function readDeclarations(root, since = null) {
  const dir = join(root, DECLARATIONS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJson(join(dir, f)))
    .filter((d) => d?.declaredAt && (!since || d.declaredAt > since))
    .sort((a, b) => a.declaredAt.localeCompare(b.declaredAt));
}

const routeKey = (key) => key.replace(/^(\w+)\s+/, (_m, m) => `${m.toUpperCase()} `).replace(/\/+$/, '');

/** Declared against made: what was done without saying, what was said and not done, and policies that differ. */
export function compareDeclared(declarations, changes) {
  const declared = declarations.flatMap((d) => d.changes.map((c) => ({ ...c, by: d.client, declarationId: d.id })));
  const keyOf = (c) => `${c.kind} ${c.kind === 'route' ? routeKey(c.key) : c.key}`;
  const made = new Map(changes.map((c) => [keyOf(c), c]));
  const said = new Map(declared.map((c) => [keyOf(c), c]));
  // A field whose visibility changed only because a declared route of its resource changed policy
  // (list: 'public' shows every field to everyone) is part of that declared change, not a new one.
  const declaredResources = new Set(
    declared
      .filter((d) => d.kind === 'route')
      .map((d) => made.get(keyOf(d)))
      .map((c) => c?.after?.resource ?? c?.before?.resource)
      .filter(Boolean),
  );
  const follows = (c) => c.kind === 'field' && c.change === 'changed' && declaredResources.has(c.key.split('.')[0]);
  const undeclared = changes.filter((c) => !said.has(keyOf(c)) && !follows(c));
  const unmade = declared.filter((c) => !made.has(keyOf(c)));
  const different = [];
  for (const d of declared) {
    const c = made.get(keyOf(d));
    if (!c) continue;
    if (d.change && d.change !== c.change) different.push({ kind: d.kind, key: d.key, declared: d.change, shipped: c.change, by: d.by });
    else if (d.kind === 'route' && d.policy && c.after?.policy && d.policy !== c.after.policy) {
      different.push({ kind: d.kind, key: d.key, declared: `policy ${d.policy}`, shipped: `policy ${c.after.policy}`, by: d.by });
    }
  }
  return { declared: declared.length, undeclared, unmade, different, ok: !undeclared.length && !unmade.length && !different.length };
}

// ---- the review -----------------------------------------------------------------------------

/** Everything a person needs to decide: the diff since the last signature, authorship, declarations, tests. */
export async function reviewState(app) {
  const root = app.root;
  const baseline = readBaseline(root);
  const current = await fullSnapshot(app);
  const since = baseline?.signedAt ?? null;
  const diff = baseline ? diffSnapshots(baseline.snapshot, current) : { changes: [], summary: { total: 0, widen: 0, tighten: 0 } };
  const declarations = readDeclarations(root, since);
  const unreviewed = unreviewedFiles(root, since);
  return {
    baseline: baseline ? { signedAt: baseline.signedAt, signer: baseline.signer, reviewId: baseline.reviewId, commit: baseline.commit ?? null } : null,
    changes: diff.changes,
    summary: diff.summary,
    unreviewed,
    declarations: declarations.map((d) => ({ id: d.id, client: d.client, intent: d.intent, declaredAt: d.declaredAt, changes: d.changes })),
    declared: declarations.length ? compareDeclared(declarations, diff.changes) : null,
    tests: lastTests(root, since),
    current: { hash: hash(current) },
    needsSignature: !baseline || diff.changes.length > 0 || unreviewed.length > 0,
    gitignore: reviewsIgnored(root),
  };
}

/**
 * Sign: accept the current behavior. Writes the review record and the new baseline.
 * @param {{ name: string, email?: string }} signer a person
 */
export async function signReview(app, { signer, note = null, via = 'cli', commit = null } = {}) {
  if (!signer?.name || !String(signer.name).trim()) throw new Error('A review is signed by a person: give a name (git config user.name, or --as "Name <email>")');
  const root = app.root;
  const state = await reviewState(app);
  const snapshot = await fullSnapshot(app);
  const signedAt = new Date().toISOString();
  const id = `${signedAt.slice(0, 10)}-${randomBytes(3).toString('hex')}`;
  const review = {
    id,
    signedAt,
    signer: { name: String(signer.name).trim().slice(0, 100), email: signer.email ? String(signer.email).trim().slice(0, 200) : null },
    via,
    commit,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 2000) : null,
    previous: state.baseline?.reviewId ?? null,
    accepted: {
      summary: state.summary,
      changes: state.changes.map((c) => ({ kind: c.kind, change: c.change, key: c.key, detail: c.detail, direction: c.direction, personal: c.personal || undefined })),
      agentFiles: state.unreviewed.map((f) => ({ path: f.path, agent: f.agent })),
      declared: state.declared ? { ok: state.declared.ok, undeclared: state.declared.undeclared.length, unmade: state.declared.unmade.length, different: state.declared.different.length } : null,
      tests: state.tests,
    },
    snapshotHash: hash(snapshot),
  };
  const dir = join(root, REVIEWS_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.json`), `${JSON.stringify(review, null, 2)}\n`);
  writeFileSync(join(dir, 'baseline.json'), `${JSON.stringify({ reviewId: id, signedAt, signer: review.signer, commit, snapshot }, null, 2)}\n`);
  const gitignore = allowReviewsInGit(root);
  activity(root, { type: 'review', id, signer: review.signer.name, via, changes: state.changes.length, widen: state.summary.widen, agentFiles: state.unreviewed.length });
  return { review, gitignore };
}

/** True when .gitignore hides .calm/reviews (the folder must be committed). */
export function reviewsIgnored(root) {
  const file = join(root, '.gitignore');
  if (!existsSync(file)) return false;
  const lines = readFileSync(file, 'utf8').split('\n').map((l) => l.trim());
  const hides = lines.some((l) => l === '.calm/' || l === '.calm' || l === '/.calm/' || l === '/.calm');
  return hides && !lines.includes('!.calm/reviews/');
}

/**
 * Projects created before reviews ignore all of .calm/. Rewrite that line so the reviews are
 * committed and everything else in .calm/ (activity, checkpoints) stays local.
 */
export function allowReviewsInGit(root) {
  if (!reviewsIgnored(root)) return null;
  const file = join(root, '.gitignore');
  const text = readFileSync(file, 'utf8').replace(/^\/?\.calm\/?$/m, '.calm/*\n!.calm/reviews/');
  writeFileSync(file, text);
  return '.gitignore: .calm/ is now .calm/* with !.calm/reviews/, so reviews are committed';
}

function activity(root, event) {
  try {
    mkdirSync(join(root, '.calm'), { recursive: true });
    appendFileSync(join(root, '.calm', 'activity.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  } catch {
    // the files above are the record; the activity line is a courtesy
  }
}
