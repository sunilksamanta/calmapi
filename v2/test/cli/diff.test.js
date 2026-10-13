import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';

// `calm diff` checks a git ref out into a temporary worktree, loads both versions of the
// project (no database, no server) and reports what changed in behavior.

const CALM = join(ROOT, 'bin', 'calm.js');
const env = { ...process.env, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_diff_test', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env, encoding: 'utf8' });
const calmStatus = (cwd, ...args) => {
  try {
    return { code: 0, out: calm(cwd, ...args) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

let work;
let app;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-diff-'));
  calm(work, 'create', 'shop', '--yes', '--no-install', '--no-git');
  app = join(work, 'shop');
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
  git(app, 'init', '-q');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'init');
});
after(() => rmSync(work, { recursive: true, force: true }));

const edit = (rel, fn) => writeFileSync(join(app, rel), fn(existsSync(join(app, rel)) ? readFileSync(join(app, rel), 'utf8') : ''));

test('no changes right after a commit', () => {
  assert.match(calm(app, 'diff'), /No behavior changes since HEAD/);
});

test('reports behavior changes against a ref, and --ci fails when access widens', () => {
  edit('app/resources/post/post.resource.js', (s) => s.replace("update: 'owner | admin'", "update: 'authenticated'"));
  edit('app/resources/user/user.resource.js', (s) => s.replace("list: 'admin'", "list: 'public'").replace("read: 'owner | admin'", "read: 'public'").replace(".immutable().filterable().visibleTo('owner | admin')", '.immutable().filterable()'));
  edit('app/routes.js', () => `export default (r) => {
  r.post('/refunds', { policy: 'admin' }, () => ({ ok: true }));
  r.get('/pulse', { policy: 'public' }, async () => {
    const res = await fetch('https://api.stripe.com/v1/balance', { headers: { authorization: process.env.STRIPE_SECRET_KEY } });
    return { ok: res.ok };
  });
};
`);
  edit('calm.config.js', (s) => s.replace('  mail:', "  invariants: ['no public write routes'],\n  mail:"));

  const text = calm(app, 'diff');
  assert.match(text, /Behavior changes since HEAD/);
  assert.match(text, /\+ {2}POST {3}\/api\/refunds\s+policy: admin/);
  assert.match(text, /~ {2}PATCH {2}\/api\/posts\/:id\s+policy: owner \| admin -> authenticated\s+looser/);
  assert.match(text, /~ {2}user\.email\s+visible to: the owner and admins -> everyone\s+looser, personal data/);
  assert.match(text, /\+ {2}env {2}STRIPE_SECRET_KEY/);
  assert.match(text, /\+ {2}calls api\.stripe\.com/);
  assert.match(text, /\+ {2}invariant no public write routes\s+promised\s+tighter/);

  const res = calmStatus(app, 'diff', 'HEAD', '--ci', '--json');
  assert.equal(res.code, 1, 'wider access fails the build');
  const report = JSON.parse(res.out);
  assert.match(report.since, /^HEAD \([0-9a-f]{7}\)$/);
  assert.ok(report.summary.widen >= 3, JSON.stringify(report.summary));
  const kinds = new Set(report.changes.map((c) => c.kind));
  for (const k of ['route', 'field', 'env', 'host', 'invariant']) assert.ok(kinds.has(k), k);
  const pulse = report.changes.find((c) => c.key === 'GET /api/pulse');
  assert.equal(pulse.direction, 'looser');
  assert.equal(pulse.file, 'app/routes.js');
});

test('snapshot files: --save now, compare later; unknown refs are refused', () => {
  calm(app, 'diff', '--save', 'behavior.json');
  const saved = JSON.parse(readFileSync(join(app, 'behavior.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.ok(saved.routes.some((r) => r.path === '/api/pulse'));
  assert.match(calm(app, 'diff', 'behavior.json'), /No behavior changes since behavior\.json/);

  edit('app/routes.js', (s) => s.replace("r.get('/pulse', { policy: 'public' }", "r.get('/pulse', { policy: 'admin' }"));
  const res = calmStatus(app, 'diff', 'behavior.json', '--ci');
  assert.equal(res.code, 0, 'tightening passes --ci');
  assert.match(res.out, /~ {2}GET {4}\/api\/pulse\s+policy: public -> admin\s+tighter/);

  assert.match(calmStatus(app, 'diff', 'no-such-branch').out, /Unknown git ref "no-such-branch"/);
  assert.equal(git(app, 'worktree', 'list').trim().split('\n').length, 1, 'temporary worktrees are removed');
});
