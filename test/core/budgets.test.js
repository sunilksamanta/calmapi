import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';
import { parseBudgets, budgetFor, parseDuration, parseSize, budgetReport } from '../../core/budgets.js';

test('budgets config: units, keys and clear errors', () => {
  assert.equal(parseDuration('150ms'), 150);
  assert.equal(parseDuration('1.5s'), 1500);
  assert.equal(parseSize('200kb'), 204800);
  assert.equal(parseSize('1mb'), 1048576);
  const list = parseBudgets({ '*': { queries: 12 }, 'GET /api/posts/*': { queries: 6 }, 'GET /api/posts/:id': { queries: 2 } });
  assert.equal(budgetFor(list, 'GET', '/api/posts/:id').key, 'GET /api/posts/:id', 'exact beats wildcard');
  assert.equal(budgetFor(list, 'GET', '/api/posts/featured').key, 'GET /api/posts/*');
  assert.equal(budgetFor(list, 'POST', '/api/posts').key, '*');
  const err = (spec, re) => assert.throws(() => parseBudgets(spec), (e) => e.code === 'CALM_CONFIG' && re.test(e.message));
  err({ 'GET /x': { queries: 1.5 } }, /queries must be a whole number/);
  err({ 'GET /x': { p95: 'fast' } }, /not a duration/);
  err({ 'GET /x': { response: 'big' } }, /not a size/);
  err({ 'GET /x': { speed: 1 } }, /unknown limit speed/);
  err({ 'posts': { queries: 1 } }, /METHOD \/path/);
  err([], /budgets is an object/);
});

test('budgetReport: p95 and maxima against limits', () => {
  const samples = Array.from({ length: 20 }, (_, i) => ({ ms: i + 1, queries: i === 19 ? 9 : 2, bytes: 100 }));
  const report = budgetReport(parseBudgets({ 'GET /api/a': { queries: 5, p95: '15ms', response: '1kb' } }), [{ method: 'GET', route: '/api/a', samples }]);
  const r = report.routes[0];
  assert.equal(r.p95Ms, 19);
  assert.equal(r.maxQueries, 9);
  assert.deepEqual(r.over, ['queries 9 > 5', 'p95 19ms > 15ms']);
  assert.equal(report.over, 1);
});

let project;
let t;
before(async () => {
  project = await makeProject({
    files: { 'calm.config.js': "import { defineConfig } from '#calm';\nexport default defineConfig({ budgets: { 'GET /api/posts': { queries: 1 } } });\n" },
  });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('the dev server measures every route and marks requests over budget', async () => {
  await t.get('/posts');
  await new Promise((r) => setTimeout(r, 40));
  const api = (p) => fetch(`${t.origin}/_calm/api${p}`, { headers: { host: 'localhost' } }).then((r) => r.json());
  const report = await api('/budgets');
  const row = report.routes.find((r) => r.route === '/api/posts' && r.method === 'GET');
  assert.equal(row.count, 1);
  assert.ok(row.maxQueries >= 2, `the list counts and finds: ${row.maxQueries}`);
  assert.equal(row.ok, false);
  const list = await api('/requests');
  const req = list.find((r) => r.path === '/api/posts' && r.method === 'GET');
  assert.match(req.overBudget[0], /queries \(budget 1\)/);
});

test('a bad budget stops the boot with a readable error', async () => {
  const bad = await makeProject({ files: { 'calm.config.js': "import { defineConfig } from '#calm';\nexport default defineConfig({ budgets: { 'GET /x': { p95: 'soon' } } });\n" } });
  try {
    await assert.rejects(bad.testApp(), /budgets\["GET \/x"\]\.p95: "soon" is not a duration/);
  } finally {
    bad.cleanup();
  }
});
