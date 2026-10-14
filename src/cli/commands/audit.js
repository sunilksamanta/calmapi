import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { c, out, ok, warn, table } from '../lib/ui.js';
import { introspect } from '../lib/introspect.js';
import { detectAgentEnv } from '../lib/attribution.js';
import { readBudget, compareBudget, acceptBudget, BUDGET_FILE } from '../../../core/security/budget.js';
import { parseSigner, gitIdentity } from './review.js';

export const help = `
${c.bold('calm audit')} [--json] [--ci]
${c.bold('calm audit --accept')} [--reason <why>] [--as "Name <email>"]

  Authorization testing for your API. Boots the app on a throwaway database
  (MONGODB_TEST_URI, default mongodb://127.0.0.1:27017), creates a user per
  persona (anonymous, owner, another user, admin, custom roles), seeds records,
  and calls every CRUD route as every persona. It checks:

    - status codes against your policies (the exposure matrix)
    - that no response contains a field the persona must not see
    - mass assignment of read-only, hidden and owner fields
    - query injection, the page size cap, error hygiene and token handling

  Your real database is never touched.

  The exposure budget: ${c.bold('calm audit --accept')} writes who may do what to
  security.snapshot.json (commit it). From then on any access wider than the snapshot is an
  error in calm audit --ci and calm doctor --ci, until a person accepts it with --accept and
  a --reason, recorded next to their name. --accept needs no database.
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
// Exit once the pipe took everything: exiting right after a large write cuts the output short.
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result), () => process.exit(0));
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
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: 'boolean' }, ci: { type: 'boolean' }, accept: { type: 'boolean' }, reason: { type: 'string' }, as: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  if (values.accept) return accept(root, values);
  if (!values.json) out(c.dim('\n  Auditing on a throwaway database...'));
  const report = await runAuditInProject(root);
  const budget = await checkBudget(root);
  if (values.json) {
    const { matrix: _matrix, ...rest } = report;
    out(JSON.stringify({ ...rest, budget }, null, 2));
  } else {
    print(report);
    printBudget(budget);
  }
  if (values.ci && (!report.ok || budget?.wider?.length)) process.exitCode = 1;
}

/** The current matrix against security.snapshot.json: null when there is no snapshot. */
export async function checkBudget(root) {
  const stored = readBudget(root);
  if (!stored) return null;
  if (stored.error) return { error: stored.error, wider: [{ text: stored.error }], narrower: [] };
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const { wider, narrower } = compareBudget(stored.matrix, info.exposure);
  return { updatedAt: stored.updatedAt, wider, narrower: narrower.length };
}

function printBudget(budget) {
  if (!budget) return out(c.dim(`  No exposure budget yet. Write one with calm audit --accept, commit ${BUDGET_FILE}, and CI will fail when access widens.`), '');
  if (!budget.wider.length) return out(`  ${c.green('✔')} Within the exposure budget (${BUDGET_FILE})${budget.narrower ? c.dim(`, ${budget.narrower} cells narrower`) : ''}`, '');
  out(`  ${c.red('✖')} ${c.bold(`Access widened beyond ${BUDGET_FILE} in ${budget.wider.length} place${budget.wider.length === 1 ? '' : 's'}`)}`);
  for (const w of budget.wider.slice(0, 30)) out(`    ${w.text}`);
  if (budget.wider.length > 30) out(c.dim(`    ...and ${budget.wider.length - 30} more`));
  out(c.dim('  Intended? npx calm audit --accept --reason "why". Otherwise fix the policy or field rule.'), '');
}

async function accept(root, values) {
  const agent = detectAgentEnv(process.env);
  if (agent) throw new Error(`Accepting wider access is for a person, and this shell belongs to an AI agent (${agent}). Run it in your own terminal.`);
  const by = values.as ? parseSigner(values.as) : await gitIdentity(root);
  if (!by?.name) throw new Error('Who accepts it? Set git config user.name, or pass --as "Your Name <you@example.com>".');
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const { budget, wider, unchanged } = acceptBudget(root, info.exposure, { by, reason: values.reason });
  if (values.json) return out(JSON.stringify({ file: BUDGET_FILE, unchanged: Boolean(unchanged), wider, accepted: budget.accepted.at(-1) }, null, 2));
  if (unchanged) return ok(`${BUDGET_FILE} already matches who may do what: nothing to accept.`);
  if (wider.length) {
    warn(`Accepted ${wider.length} wider cell${wider.length === 1 ? '' : 's'}:`);
    for (const w of wider.slice(0, 30)) out(`    ${w.text}`);
  }
  ok(`${BUDGET_FILE} written: ${budget.matrix.resources.length} resources, ${budget.matrix.personas.length} personas, accepted by ${by.name}. Commit it.`);
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
    for (const res of results.filter((x) => x.resource === r.name && x.ok === false)) {
      const who = personas.find((p) => p.key === res.persona)?.label ?? res.persona;
      const why = res.note ?? `expected ${res.expected}, got ${res.status}`;
      out(`    ${c.red('✖')} ${res.action} as ${who}: ${why}`);
    }
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
