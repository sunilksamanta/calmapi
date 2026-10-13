import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { detectAgentEnv } from '../lib/attribution.js';
import { diffRows } from '../lib/snapshot.js';
import { allowReviewsInGit } from '../../../core/review.js';
import { c, out, ok, info, warn, table, confirm } from '../lib/ui.js';

export const help = `
${c.bold('calm review')} [--sign] [--note <text>] [--as "Name <email>"] [--yes] [--list] [--ci] [--json]

  What changed since the last signature, for a person to read and sign: the behavior diff
  (routes, who may call them, which fields more people can see, env vars, hosts, events,
  invariants), the files AI agents changed that nobody has signed, and what agents declared
  they would change next to what they did.

    calm review                 read it
    calm review --sign          accept it: writes .calm/reviews/ (commit it with your change)
    calm review --list          only the files agents changed that are not signed yet
    calm review --ci            exit 1 when access widened since the last signature

  Signing is for a person. It refuses to run in an AI agent's shell (sign in your own
  terminal, or in devtools: Review). The signer is your git user unless you pass --as.
`;

// Runs inside the project with its own calm/ code, without a database connection.
const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
const op = JSON.parse(process.env.CALM_REVIEW);
const root = process.cwd();
let result;
try {
  if (!existsSync(join(root, 'calm', 'review.js'))) throw Object.assign(new Error('This project\\'s calm/ predates reviews. Run npx calm upgrade first.'), { code: 'CALM_OLD' });
  const { createApp } = await import(pathToFileURL(join(root, 'calm', 'index.js')).href);
  const app = await createApp({ root, config: { mode: process.env.CALM_REVIEW_MODE || 'development', log: { level: 'silent' }, devtools: { enabled: false } } });
  result = op.kind === 'sign' ? await app.signReview(op) : await app.review();
  await app.mongoose.disconnect();
} catch (err) {
  result = { error: err.message, code: err.code ?? null };
}
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result));
process.exit(0);
`;

async function runInProject(root, op) {
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env: { CALM_REVIEW: JSON.stringify(op), CALM_SKIP_ENV_FILE: '' } });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Could not load the project:\n${res.stderr || res.stdout}`.trim());
  const result = JSON.parse(res.stdout.slice(marker + 8));
  if (result?.error) throw new Error(result.error);
  return result;
}

async function git(root, args) {
  const res = await capture('git', args, { cwd: root }).catch(() => null);
  return res?.code === 0 ? res.stdout.trim() : null;
}

/** "Ada Lovelace <ada@example.com>" or "Ada Lovelace". */
export function parseSigner(text) {
  const m = /^\s*(.+?)\s*(?:<([^>]+)>)?\s*$/.exec(String(text ?? ''));
  return m && m[1] ? { name: m[1], email: m[2] ?? null } : null;
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      sign: { type: 'boolean' },
      note: { type: 'string' },
      as: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      list: { type: 'boolean' },
      ci: { type: 'boolean' },
      json: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return out(help);
  const root = requireProject();

  if (values.sign) return sign(root, values);

  const state = await runInProject(root, { kind: 'state' });
  if (values.json) out(JSON.stringify(state, null, 2));
  else if (values.list) printUnreviewed(state);
  else print(state);
  if (values.ci) {
    if (!state.baseline) {
      if (!values.json) info('No signed baseline yet: --ci passes. Sign one with calm review --sign and commit .calm/reviews/.');
    } else if (state.summary.widen > 0) {
      process.exitCode = 1;
      if (!values.json) out(`  ${c.red(`✖ Access widened in ${state.summary.widen} place${state.summary.widen === 1 ? '' : 's'} since the last signature.`)} A person signs it (calm review --sign) and commits .calm/reviews/.`, '');
    }
  }
}

async function sign(root, values) {
  const agent = detectAgentEnv(process.env);
  if (agent) throw new Error(`Signing is for a person, and this shell belongs to an AI agent (${agent}). Sign in your own terminal, or in devtools: Review.`);
  const signer = values.as ? parseSigner(values.as) : (await git(root, ['config', 'user.name'])) ? { name: await git(root, ['config', 'user.name']), email: await git(root, ['config', 'user.email']) } : null;
  if (!signer?.name) throw new Error('Who is signing? Set git config user.name, or pass --as "Your Name <you@example.com>".');
  const head = await git(root, ['rev-parse', '--short', 'HEAD']);
  const dirty = head && (await git(root, ['status', '--porcelain']))?.length > 0;
  const commit = head ? `${head}${dirty ? '+changes' : ''}` : null;

  const state = await runInProject(root, { kind: 'state' });
  if (!values.json) print(state);
  if (state.baseline && !state.needsSignature) {
    const fixed = allowReviewsInGit(root);
    if (fixed) warn(fixed);
    return ok('Nothing to sign: nothing changed since the last signature.');
  }
  if (!values.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) throw new Error('Not an interactive terminal: pass --yes to sign.');
    const what = state.baseline ? `${state.changes.length} change${state.changes.length === 1 ? '' : 's'}${state.summary.widen ? `, ${state.summary.widen} widening access` : ''}` : 'the current behavior as the first baseline';
    if (!(await confirm(`Sign ${what} as ${signer.name}${signer.email ? ` <${signer.email}>` : ''}?`, false))) return info('Not signed.');
  }
  const { review, gitignore } = await runInProject(root, { kind: 'sign', signer, note: values.note ?? null, via: 'cli', commit });
  if (values.json) return out(JSON.stringify(review, null, 2));
  ok(`Signed ${c.bold(review.id)} as ${review.signer.name}${commit ? c.dim(` at ${commit}`) : ''}`);
  if (gitignore) warn(gitignore);
  out(c.dim(`  Commit .calm/reviews/ with your change, so the next review and CI start from here.`));
}

const DIR = { looser: (s) => c.red(s), mixed: (s) => c.red(s), tighter: (s) => c.green(s) };

function print(state) {
  const since = state.baseline ? `since ${state.baseline.signer?.name ?? 'the last signature'} signed ${state.baseline.signedAt.slice(0, 16).replace('T', ' ')}` : 'nothing signed yet';
  out('', `  ${c.bold('CalmAPI review')} ${c.dim(`· ${since}`)}`);
  if (state.gitignore) warn('  .gitignore hides .calm/reviews/: signing will fix the line so reviews are committed.');

  if (!state.baseline) {
    out('', `  ${c.dim('There is no signed baseline. Signing accepts the current behavior; later reviews show what changed from it.')}`);
  } else if (!state.changes.length) {
    out('', `  ${c.green('✔')} No behavior changes.`);
  } else {
    out('', `  ${c.bold('Behavior')} ${c.dim(`(${state.changes.length})`)}`);
    const rows = diffRows({ changes: state.changes, summary: state.summary }).map((r) => [r.mark === '+' ? c.green(r.mark) : r.mark === '-' ? c.red(r.mark) : c.yellow(r.mark), r.what, r.detail, (DIR[r.change.direction] ?? c.magenta)(r.note), c.dim(r.file)]);
    out(table(rows, { indent: 4 }));
    if (state.summary.widen) out(`    ${c.red(`${state.summary.widen} widen access.`)}`);
  }

  if (state.unreviewed.length) {
    out('', `  ${c.bold('Written by agents, not signed')} ${c.dim(`(${state.unreviewed.length})`)}`);
    printUnreviewedRows(state.unreviewed);
  }

  if (state.declared) {
    const d = state.declared;
    out('', `  ${c.bold('Declared by agents')} ${c.dim(`(${state.declarations.length} declaration${state.declarations.length === 1 ? '' : 's'}, ${d.declared} changes)`)}`);
    for (const decl of state.declarations) out(`    ${c.magenta(decl.client)} ${decl.intent}`);
    if (d.ok) out(`    ${c.green('✔')} What changed matches what was declared.`);
    for (const x of d.undeclared) out(`    ${c.red('✖ not declared')}  ${x.kind} ${x.key} ${c.dim(x.detail)}`);
    for (const x of d.unmade) out(`    ${c.yellow('! declared, not made')}  ${x.kind} ${x.key}`);
    for (const x of d.different) out(`    ${c.red('✖ different')}  ${x.kind} ${x.key}: declared ${x.declared}, shipped ${x.shipped}`);
  }

  if (state.tests) out('', `  ${c.bold('Tests')} ${state.tests.ok ? c.green(`✔ ${state.tests.pass ?? '?'} passed`) : c.red(`✖ ${state.tests.fail ?? '?'} failed`)} ${c.dim(`(${state.tests.by}, ${state.tests.at.slice(11, 16)})`)}`);
  out('', state.needsSignature ? `  ${c.dim('Sign it with calm review --sign, or in devtools: Review.')}` : `  ${c.green('✔')} Everything is signed.`, '');
}

function printUnreviewedRows(files) {
  out(table(files.map((f) => [f.path, c.magenta(f.agent), c.dim(`${f.at.slice(0, 16).replace('T', ' ')}${f.editedAfter ? ', then edited by you' : ''}`), f.protected ? c.yellow(f.reason ?? 'protected') : '']), { indent: 4 }));
}

function printUnreviewed(state) {
  if (!state.unreviewed.length) return out(`  ${c.green('✔')} No unsigned agent changes${state.baseline ? ' since the last signature' : ''}.`);
  out('', `  ${c.bold('Written by agents, not signed')} ${c.dim(`(${state.unreviewed.length})`)}`);
  printUnreviewedRows(state.unreviewed);
  out('');
}
