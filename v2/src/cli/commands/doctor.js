import { parseArgs } from 'node:util';
import { findProjectRoot, findV1Root, readLock } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { scanAdvisories, staticChecks } from '../lib/static-checks.js';
import { PKG } from '../lib/files.js';
import { c, out } from '../lib/ui.js';

export const help = `
${c.bold('calm doctor')} [--prod] [--ci] [--strict] [--json]

  Security and correctness checks: config, policies, private fields, risky code
  patterns, framework drift and known advisories. Also works inside CalmAPI 1.x
  projects, where it reports the published security advisories.

  --prod     evaluate as production (NODE_ENV=production rules)
  --ci       exit with code 1 when there are errors (with --strict: also warnings)
  --json     machine readable output
`;

const ICON = { error: c.red('✖ error'), warn: c.yellow('! warn '), info: c.cyan('• info ') };
const ORDER = { error: 0, warn: 1, info: 2 };

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      prod: { type: 'boolean' },
      ci: { type: 'boolean' },
      strict: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return out(help);

  const root = findProjectRoot();
  let findings;
  let title;
  if (!root) {
    const v1 = findV1Root();
    if (!v1) throw new Error('Not inside a CalmAPI project (no calm.lock or calmapi.json found).');
    title = 'CalmAPI 1.x project';
    findings = scanAdvisories(v1, 'v1');
    findings.push({
      level: 'info',
      id: 'v1-eol',
      title: 'CalmAPI 1.x is no longer developed',
      detail: 'CalmAPI 2 fixes these issues by design. Migration guide: https://calmapi.dev/docs/migrate-v1',
    });
  } else {
    const lock = readLock(root);
    const info = await introspect(root, { mode: values.prod ? 'production' : undefined });
    title = info.app?.name ?? 'project';
    findings = [];
    if (info.error) {
      findings.push({ level: 'error', id: info.error.code === 'CALM_CONFIG' ? 'config' : 'boot', title: 'The app does not start', detail: info.error.message });
    } else {
      findings.push(...info.doctor);
    }
    findings.push(...staticChecks(root, lock), ...scanAdvisories(root, 'v2'));
    if (lock?.calmapi && lock.calmapi !== PKG.version) {
      findings.push({ level: 'info', id: 'upgrade', title: `calm/ is from calmapi ${lock.calmapi}, this CLI is ${PKG.version}`, detail: 'Run `npx calm upgrade` to merge framework updates into calm/.' });
    }
  }

  findings.sort((a, b) => ORDER[a.level] - ORDER[b.level]);
  const count = (level) => findings.filter((f) => f.level === level).length;
  const errors = count('error');
  const warnings = count('warn');

  if (values.json) out(JSON.stringify({ findings, errors, warnings }, null, 2));
  else {
    out('', `  ${c.bold('CalmAPI doctor')} ${c.dim(`· ${title}${values.prod ? ' · production rules' : ''}`)}`, '');
    if (!findings.length) out(`  ${c.green('✔ All clear.')} No problems found.`);
    for (const f of findings) {
      out(`  ${ICON[f.level]}  ${c.bold(f.title)}${f.file ? `  ${c.dim(f.file)}` : ''}`);
      if (f.detail) for (const line of String(f.detail).split('\n')) out(`           ${c.dim(line)}`);
    }
    out('', `  ${errors ? c.red(`${errors} error${errors === 1 ? '' : 's'}`) : c.green('0 errors')} · ${warnings} warning${warnings === 1 ? '' : 's'} · ${count('info')} info`, '');
  }
  if (values.ci && (errors || (values.strict && warnings))) process.exitCode = 1;
}
