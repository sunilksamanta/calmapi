import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { c, out, table } from '../lib/ui.js';

export const help = `
${c.bold('calm audit')} [--json] [--ci]

  Authorization testing for your API. Boots the app on a throwaway database
  (MONGODB_TEST_URI, default mongodb://127.0.0.1:27017), creates a user per
  persona (anonymous, owner, another user, admin, custom roles), seeds records,
  and calls every CRUD route as every persona. It checks:

    - status codes against your policies (the exposure matrix)
    - that no response contains a field the persona must not see
    - mass assignment of read-only, hidden and owner fields
    - query injection, the page size cap, error hygiene and token handling

  Your real database is never touched.
`;

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
let result;
try {
  const { runAudit } = await import(pathToFileURL(join(process.cwd(), 'calm', 'security', 'audit.js')).href);
  result = await runAudit({ root: process.cwd() });
} catch (err) {
  result = { error: err.message, stack: err.stack };
}
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result));
process.exit(0);
`;

export async function runAuditInProject(root) {
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env: { CALM_SKIP_ENV_FILE: '' } });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Audit could not run:\n${res.stderr || res.stdout}`);
  const report = JSON.parse(res.stdout.slice(marker + 8));
  if (report.error) throw new Error(report.error);
  return report;
}

const CELL = {
  allow: (ok) => (ok === false ? c.red('✖ allow') : ok === null ? c.dim('~ allow') : c.green('✔ allow')),
  own: (ok) => (ok === false ? c.red('✖ own') : c.green('✔ own')),
  deny: (ok) => (ok === false ? c.red('✖ deny') : c.dim('✔ deny')),
  custom: () => c.yellow('? custom'),
  off: () => c.dim('off'),
};

export async function run(argv) {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, ci: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return out(help);
  const root = requireProject();
  if (!values.json) out(c.dim('\n  Auditing on a throwaway database...'));
  const report = await runAuditInProject(root);
  if (values.json) {
    const { matrix: _matrix, ...rest } = report;
    out(JSON.stringify(rest, null, 2));
  } else print(report);
  if (values.ci && !report.ok) process.exitCode = 1;
}

function print(report) {
  const { matrix, results, leaks, probes, notes, summary } = report;
  const personas = matrix.personas;
  out('', `  ${c.bold('CalmAPI audit')}`);
  for (const r of matrix.resources) {
    out('', `  ${c.bold(r.name)} ${c.dim(r.path)}${r.customScope ? c.dim('  (custom scope)') : ''}`);
    const rows = [[c.dim('action'), ...personas.map((p) => c.dim(p.label))]];
    for (const action of ['list', 'read', 'create', 'update', 'delete']) {
      rows.push([
        action,
        ...personas.map((p) => {
          const expected = r.actions[action][p.key];
          const res = results.find((x) => x.resource === r.name && x.action === action && x.persona === p.key);
          if (expected === 'off') return CELL.off();
          if (!res) return c.dim('·');
          const cell = (CELL[expected] ?? CELL.custom)(res.ok);
          return res.ok === false ? `${cell} ${c.red(`(${res.status})`)}` : cell;
        }),
      ]);
    }
    out(table(rows, { indent: 4 }));
  }
  if (leaks.length) {
    out('', `  ${c.red(c.bold('Field leaks'))}`);
    for (const l of leaks) out(`  ${c.red('✖')} ${l.resource}.${l.field} returned to ${l.persona} (${l.where})`);
  }
  out('', `  ${c.bold('Probes')}`);
  for (const p of probes) out(`  ${p.ok ? c.green('✔') : c.red('✖')} ${p.name} ${c.dim(p.detail)}`);
  for (const n of notes) out(`  ${c.yellow('!')} ${n}`);
  out(
    '',
    `  ${summary.failed ? c.red(`${summary.failed} failed`) : c.green('All checks passed')} · ${summary.passed} passed · ${summary.skipped} skipped (custom scope or policy) · ${summary.checks} checks`,
    '',
  );
}
