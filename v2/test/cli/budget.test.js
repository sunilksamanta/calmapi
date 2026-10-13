import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';
import { compareBudget, matrixCells } from '../../core/security/budget.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const { CLAUDECODE: _cc, NODE_TEST_CONTEXT: _ntc, ...base } = process.env;
const env = { ...base, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_budget_test' };
const run = (cwd, args, extra = {}) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...env, ...extra }, encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};

let work;
let app;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-budget-'));
  execFileSync(process.execPath, [CALM, 'create', 'shop', '--yes', '--no-install', '--no-git'], { cwd: work, env });
  app = join(work, 'shop');
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
});
after(() => rmSync(work, { recursive: true, force: true }));

test('accept writes security.snapshot.json, by a person only', () => {
  assert.match(run(app, ['audit', '--accept', '--as', 'Ada'], { CLAUDECODE: '1' }).out, /for a person.*claude-code/);
  const r = run(app, ['audit', '--accept', '--as', 'Ada Lovelace <ada@example.test>']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /security\.snapshot\.json written: 2 resources, 4 personas, accepted by Ada Lovelace/);
  const budget = JSON.parse(readFileSync(join(app, 'security.snapshot.json'), 'utf8'));
  assert.equal(budget.version, 1);
  assert.equal(budget.accepted[0].reason, 'first snapshot');
  assert.equal(budget.matrix.resources.find((x) => x.name === 'user').fields.email.read.anonymous, 'no');
  assert.equal(run(app, ['doctor', '--ci']).code, 0);
});

test('wider access fails doctor --ci until accepted with a reason', () => {
  const file = join(app, 'app/resources/user/user.resource.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("read: 'owner | admin'", "read: 'authenticated'"));
  const doctor = run(app, ['doctor', '--ci', '--json']);
  assert.equal(doctor.code, 1);
  const finding = JSON.parse(doctor.out).findings.find((f) => f.id === 'exposure-budget');
  assert.match(finding.title, /Access widened beyond security\.snapshot\.json in \d+ places?/);
  assert.match(finding.detail, /user read user: no -> yes/);

  assert.match(run(app, ['audit', '--accept', '--as', 'Ada']).out, /say why with --reason/);
  const ok = run(app, ['audit', '--accept', '--as', 'Ada', '--reason', 'profiles are public to members']);
  assert.equal(ok.code, 0, ok.out);
  assert.match(ok.out, /Accepted \d+ wider cells?/);
  const budget = JSON.parse(readFileSync(join(app, 'security.snapshot.json'), 'utf8'));
  assert.equal(budget.accepted.at(-1).reason, 'profiles are public to members');
  assert.ok(budget.accepted.at(-1).widened.includes('user read user: no -> yes'));
  assert.equal(run(app, ['doctor', '--ci']).code, 0);
});

test('calm audit reports the budget and --ci fails on wider access', { timeout: 120_000 }, () => {
  const file = join(app, 'app/resources/post/post.resource.js');
  writeFileSync(file, readFileSync(file, 'utf8').replace("delete: 'owner | admin'", "delete: 'authenticated'"));
  const r = run(app, ['audit', '--ci'], { MONGODB_TEST_URI: 'mongodb://127.0.0.1:27017' });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Access widened beyond security\.snapshot\.json/);
  assert.match(r.out, /post delete user: (no|own records) -> yes/);
});

test('compareBudget: new cells count as no access, custom rules count as wider', () => {
  const stored = { resources: [{ name: 'post', actions: { read: { anonymous: 'deny', user: 'allow' } }, fields: { title: { read: { anonymous: 'yes' }, write: { anonymous: 'no' } } } }] };
  const current = {
    resources: [
      { name: 'post', actions: { read: { anonymous: 'custom', user: 'deny' } }, fields: [{ name: 'title', read: { anonymous: 'yes' }, write: { anonymous: 'no' } }] },
      { name: 'secret', actions: { read: { anonymous: 'deny', admin: 'allow' } }, fields: [] },
    ],
  };
  const { wider, narrower } = compareBudget(stored, current);
  assert.deepEqual(wider.map((w) => w.cell).sort(), ['post read anonymous', 'secret read admin']);
  assert.deepEqual(narrower.map((n) => n.cell), ['post read user']);
  assert.equal(matrixCells(current).get('post.title read anonymous'), 'yes');
});
