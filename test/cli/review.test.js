import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';
import { normalizeDeclared, compareDeclared, unreviewedFiles } from '../../core/review.js';
import { parseSigner } from '../../src/cli/commands/review.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const { CLAUDECODE: _cc, NODE_TEST_CONTEXT: _ntc, ...base } = process.env;
const env = { ...base, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_review_test', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 't@example.test' };
const run = (cwd, args, extra = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env, encoding: 'utf8' });

let work;
let app;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-review-'));
  execFileSync(process.execPath, [CALM, 'create', 'shop', '--yes', '--no-install', '--no-git'], { cwd: work, env });
  app = join(work, 'shop');
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
  git(app, 'init', '-q');
  git(app, 'add', '-A');
  git(app, 'commit', '-qm', 'init');
});
after(() => rmSync(work, { recursive: true, force: true }));

test('no baseline: the review says so and --ci passes', () => {
  const r = run(app, ['review']);
  assert.equal(r.code, 0);
  assert.match(r.out, /nothing signed yet/);
  assert.equal(run(app, ['review', '--ci']).code, 0);
});

test('signing needs --yes without a terminal, a person, and writes files git will commit', () => {
  assert.match(run(app, ['review', '--sign']).out, /pass --yes/);
  assert.match(run(app, ['review', '--sign', '--yes'], { CLAUDECODE: '1' }).out, /Signing is for a person.*claude-code/);
  const r = run(app, ['review', '--sign', '--yes', '--as', 'Ada Lovelace <ada@example.test>', '--note', 'first']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Signed \d{4}-\d{2}-\d{2}-[0-9a-f]{6} as Ada Lovelace/);
  const files = readdirSync(join(app, '.calm', 'reviews'));
  assert.ok(files.includes('baseline.json'));
  const record = JSON.parse(readFileSync(join(app, '.calm', 'reviews', files.find((f) => f !== 'baseline.json')), 'utf8'));
  assert.deepEqual(record.signer, { name: 'Ada Lovelace', email: 'ada@example.test' });
  assert.equal(record.note, 'first');
  assert.match(record.commit, /^[0-9a-f]{7}/);
  assert.match(git(app, 'status', '--porcelain', '-uall'), /\.calm\/reviews\/baseline\.json/, 'new projects commit .calm/reviews/');
  assert.match(run(app, ['review']).out, /No behavior changes/);
  assert.match(run(app, ['review', '--sign', '--yes', '--as', 'Ada']).out, /Nothing to sign/);
});

test('a looser policy and an agent edit show up, --ci fails, and signing clears them', async () => {
  const file = join(app, 'app/resources/post/post.resource.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("update: 'owner | admin'", "update: 'authenticated'"));
  await new Promise((r) => setTimeout(r, 20));
  appendFileSync(join(app, '.calm', 'activity.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), type: 'file', path: 'app/resources/post/post.resource.js', change: 'modified', actor: { kind: 'agent', name: 'claude-code' }, via: 'hook', protected: true, reason: 'access rules' })}\n`);
  const r = run(app, ['review']);
  assert.match(r.out, /~ {2}PATCH {2}\/api\/posts\/:id\s+policy: owner \| admin -> authenticated\s+looser/);
  assert.match(r.out, /Written by agents, not signed \(1\)/);
  assert.match(r.out, /access rules/);
  assert.match(run(app, ['review', '--list']).out, /app\/resources\/post\/post\.resource\.js\s+claude-code/);
  assert.equal(run(app, ['review', '--ci']).code, 1);
  const json = JSON.parse(run(app, ['review', '--json']).out);
  assert.equal(json.summary.widen, 1);
  assert.equal(json.needsSignature, true);
  assert.equal(run(app, ['review', '--sign', '--yes', '--as', 'Ada']).code, 0);
  assert.equal(run(app, ['review', '--ci']).code, 0, 'signed: CI passes');
  assert.match(run(app, ['review', '--list']).out, /No unsigned agent changes/);
});

test('projects created before reviews: signing rewrites the .gitignore line', () => {
  writeFileSync(join(app, '.gitignore'), 'node_modules/\n.env\n.calm/\n');
  assert.match(run(app, ['review']).out, /hides \.calm\/reviews/);
  const r = run(app, ['review', '--sign', '--yes', '--as', 'Ada']);
  assert.equal(r.code, 0);
  assert.match(r.out, /\.gitignore: \.calm\/ is now/);
  const signed = run(app, ['review']);
  assert.doesNotMatch(signed.out, /hides \.calm\/reviews/);
  assert.match(readFileSync(join(app, '.gitignore'), 'utf8'), /^\.calm\/\*\n!\.calm\/reviews\/$/m);
});

test('declarations: normalized, and compared with what changed', () => {
  assert.deepEqual(normalizeDeclared('route post /api/refunds/'), { kind: 'route', key: 'POST /api/refunds' });
  assert.deepEqual(normalizeDeclared({ kind: 'route', key: 'POST /api/refunds', policy: 'owner|admin' }), { kind: 'route', key: 'POST /api/refunds', policy: 'owner | admin' });
  assert.deepEqual(normalizeDeclared('field order.total'), { kind: 'field', key: 'order.total' });
  assert.throws(() => normalizeDeclared('refunds please'), /start with route, field/);
  assert.throws(() => normalizeDeclared({ kind: 'route', key: 'refunds' }), /METHOD \/path/);
  assert.throws(() => normalizeDeclared({ kind: 'table', key: 'x' }), /Unknown kind/);

  const changes = [
    { kind: 'route', change: 'added', key: 'POST /api/refunds', detail: 'policy: authenticated', after: { policy: 'authenticated' } },
    { kind: 'field', change: 'changed', key: 'user.phone', detail: 'visible to: owner -> everyone' },
  ];
  const decl = [{ id: 'd1', client: 'claude-code', changes: [normalizeDeclared({ kind: 'route', key: 'POST /api/refunds', policy: 'admin' }), normalizeDeclared('env STRIPE_KEY')] }];
  const c = compareDeclared(decl, changes);
  assert.equal(c.ok, false);
  assert.deepEqual(c.undeclared.map((x) => x.key), ['user.phone']);
  assert.deepEqual(c.unmade.map((x) => x.key), ['STRIPE_KEY']);
  assert.deepEqual(c.different, [{ kind: 'route', key: 'POST /api/refunds', declared: 'policy admin', shipped: 'policy authenticated', by: 'claude-code' }]);
  assert.equal(compareDeclared([{ id: 'd', client: 'x', changes: changes.map((x) => normalizeDeclared({ kind: x.kind, key: x.key })) }], changes).ok, true);

  // Making a declared route public shows the resource's fields to everyone: part of the same change.
  // A field removed, or a field of another resource, is still undeclared.
  const wider = [
    { kind: 'route', change: 'changed', key: 'GET /api/products', after: { policy: 'public', resource: 'product' } },
    { kind: 'field', change: 'changed', key: 'product.name', detail: 'visible to: signed-in users -> everyone' },
    { kind: 'field', change: 'removed', key: 'product.tags' },
    { kind: 'field', change: 'changed', key: 'user.email', detail: 'visible to: owner -> everyone' },
  ];
  const d2 = compareDeclared([{ id: 'd2', client: 'x', changes: [normalizeDeclared({ kind: 'route', key: 'GET /api/products', policy: 'public' })] }], wider);
  assert.deepEqual(d2.undeclared.map((x) => x.key), ['product.tags', 'user.email']);
});

test('authorship: an agent edit stays unsigned until a person signs, even after they edit the file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calm-auth-'));
  try {
    const log = (e) => appendFileSync(join(dir, '.calm', 'activity.jsonl'), `${JSON.stringify(e)}\n`);
    execFileSync('mkdir', ['-p', join(dir, '.calm')]);
    log({ time: '2026-10-13T10:00:00.000Z', type: 'file', path: 'a.js', change: 'modified', actor: { kind: 'agent', name: 'x' } });
    log({ time: '2026-10-13T10:01:00.000Z', type: 'file', path: 'b.js', change: 'modified', actor: { kind: 'agent', name: 'x' } });
    log({ time: '2026-10-13T10:02:00.000Z', type: 'file', path: 'b.js', change: 'modified', actor: { kind: 'human', name: 'me' } });
    log({ time: '2026-10-13T10:03:00.000Z', type: 'file', path: 'c.js', change: 'deleted', actor: { kind: 'agent', name: 'x' } });
    assert.deepEqual(unreviewedFiles(dir).map((f) => [f.path, f.editedAfter]), [['b.js', true], ['a.js', false]]);
    assert.deepEqual(unreviewedFiles(dir, '2026-10-13T10:00:30.000Z').map((f) => f.path), ['b.js']);
    assert.deepEqual(unreviewedFiles(dir, '2026-10-13T10:01:30.000Z'), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parseSigner', () => {
  assert.deepEqual(parseSigner('Ada Lovelace <ada@example.test>'), { name: 'Ada Lovelace', email: 'ada@example.test' });
  assert.deepEqual(parseSigner('Ada'), { name: 'Ada', email: null });
  assert.equal(parseSigner(''), null);
  assert.ok(existsSync(CALM));
});
