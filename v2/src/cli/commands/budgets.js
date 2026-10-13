import { parseArgs } from 'node:util';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { requireProject, capture } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { parseBudgets, budgetReport, fmtBytes } from '../../../core/budgets.js';
import { c, out, ok, table } from '../lib/ui.js';

export const help = `
${c.bold('calm budgets')} [test files...] [--ci] [--json]

  Runs your tests (node --test) with the meter on, then shows what each route cost:
  MongoDB queries per request, the p95 time and the largest response, next to its budget
  in calm.config.js:

    budgets: {
      'GET /api/feed': { queries: 4, p95: '150ms', response: '200kb' },
      '*': { queries: 12, p95: '400ms' },
    },

  --ci exits 1 when a route is over budget (or a test fails). The dev server measures the
  same numbers live: devtools, Budgets.
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: { ci: { type: 'boolean' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return out(help);
  const root = requireProject();
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const budgets = parseBudgets(info.budgets ?? {});

  const dir = mkdtempSync(join(tmpdir(), 'calm-budgets-'));
  let tests;
  try {
    if (!values.json) out(c.dim('\n  Running the tests with the meter on...'));
    const { NODE_TEST_CONTEXT: _ctx, ...env } = process.env;
    const res = await capture(process.execPath, ['--test', '--test-reporter=tap', '--test-concurrency=1', ...positionals], { cwd: root, env: { ...env, NODE_TEST_CONTEXT: undefined, CALM_BUDGETS_DIR: dir } });
    const num = (k) => Number(new RegExp(`^# ${k} (\\d+)`, 'm').exec(res.stdout)?.[1] ?? 0);
    tests = { pass: num('pass'), fail: num('fail'), code: res.code };
    const merged = new Map();
    for (const f of readdirSync(dir)) {
      const { routes } = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      for (const r of routes) {
        const key = `${r.method} ${r.route}`;
        if (!merged.has(key)) merged.set(key, { method: r.method, route: r.route, samples: [] });
        merged.get(key).samples.push(...r.samples);
      }
    }
    const report = budgetReport(budgets, [...merged.values()]);
    if (values.json) out(JSON.stringify({ tests, ...report }, null, 2));
    else print(report, tests);
    if (values.ci && (report.over || tests.fail || tests.code !== 0)) process.exitCode = 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function print(report, tests) {
  out(`  Tests: ${tests.fail ? c.red(`${tests.fail} failed`) : c.green(`${tests.pass} passed`)}`);
  if (!report.routes.length) return out(c.dim('  No API requests were made by the tests, so nothing was measured.'), '');
  if (!report.configured) out(c.dim('  No budgets in calm.config.js yet: the numbers are measured anyway (calm budgets --help shows how to set them).'));
  const lim = (v, l, fmt) => (l == null ? fmt(v) : `${fmt(v)} ${c.dim(`/ ${fmt(l)}`)}`);
  const rows = [[c.dim('ROUTE'), c.dim('REQUESTS'), c.dim('MAX QUERIES'), c.dim('P95'), c.dim('MAX SIZE'), c.dim('BUDGET')]];
  for (const r of report.routes) {
    const paint = r.ok ? (s) => s : c.red;
    rows.push([paint(`${r.method} ${r.route}`), String(r.count), lim(r.maxQueries, r.limits.queries, String), lim(r.p95Ms, r.limits.p95Ms, (x) => `${Math.round(x)}ms`), lim(r.maxBytes, r.limits.responseBytes, fmtBytes), c.dim(r.budget ?? 'none')]);
  }
  out('', table(rows), '');
  if (report.over) {
    out(`  ${c.red(`${report.over} route${report.over === 1 ? '' : 's'} over budget`)}`);
    for (const r of report.routes.filter((x) => !x.ok)) out(`    ${r.method} ${r.route}: ${r.over.join(', ')}`);
    out('');
  } else if (report.configured) ok('Every measured route is within its budget.');
}
