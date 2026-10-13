import { parseArgs } from 'node:util';
import { existsSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { requireProject, capture } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { buildSnapshot, diffSnapshots, diffRows } from '../lib/snapshot.js';
import { readJson, writeJson } from '../lib/files.js';
import { c, out, table } from '../lib/ui.js';

export const help = `
${c.bold('calm diff')} [ref] [--json] [--ci] [--save <file>]

  What changed in behavior, not in lines: routes added or removed, policies loosened or
  tightened, fields visible to more people, environment variables, hosts the code can
  reach, events, blocks and invariants. Compares a git ref (default HEAD) with the working
  tree. The ref can also be a snapshot file written with --save.

  calm diff main                  since the main branch
  calm diff v1.2.0 --ci           fails (exit 1) when access got wider
  calm diff --save behavior.json  write the current snapshot (compare later: calm diff behavior.json)
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, ci: { type: 'boolean' }, save: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const ref = positionals[0] ?? 'HEAD';

  if (values.save && !positionals[0]) {
    const current = await snapshotOf(root);
    writeJson(resolve(root, values.save), current);
    if (!values.json) out(`${c.green('✔')} Snapshot written to ${values.save} (${current.routes.length} routes, ${current.resources.length} resources)`);
    return;
  }

  const [before, after] = await Promise.all([snapshotOfRef(root, ref), snapshotOf(root)]);
  if (values.save) writeJson(resolve(root, values.save), after);
  const result = diffSnapshots(before, after);
  const label = before.label ?? ref;

  if (values.json) out(JSON.stringify({ since: label, ...result }, null, 2));
  else print(result, label);
  if (values.ci && result.summary.widen) process.exitCode = 1;
}

async function snapshotOf(root) {
  const info = await introspect(root);
  if (info.error) throw new Error(`The working tree does not load: ${info.error.message}`);
  return buildSnapshot(info, root);
}

/** The snapshot of a git ref: the ref is checked out into a temporary worktree and loaded there. */
async function snapshotOfRef(root, ref) {
  if (/\.json$/i.test(ref) && existsSync(resolve(root, ref))) {
    const snap = readJson(resolve(root, ref));
    if (!snap?.routes) throw new Error(`${ref} is not a behavior snapshot (write one with calm diff --save ${ref})`);
    return { ...snap, label: ref };
  }
  const top = await git(root, ['rev-parse', '--show-toplevel']);
  if (!top) throw new Error('Not a git repository: pass a snapshot file written with `calm diff --save <file>` instead of a ref.');
  const sha = await git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!sha) throw new Error(`Unknown git ref "${ref}".`);
  const prefix = relative(top, root);
  const dir = mkdtempSync(join(tmpdir(), 'calm-diff-'));
  try {
    const added = await capture('git', ['worktree', 'add', '--detach', '--quiet', dir, sha], { cwd: top });
    if (added.code !== 0) throw new Error(`git worktree add failed:\n${added.stderr}`);
    const projectRoot = prefix ? join(dir, prefix) : dir;
    if (!existsSync(join(projectRoot, 'calm.lock'))) throw new Error(`${ref} has no CalmAPI project at ${prefix || '/'} (no calm.lock)`);
    if (!existsSync(join(projectRoot, 'node_modules')) && existsSync(join(root, 'node_modules'))) symlinkSync(join(root, 'node_modules'), join(projectRoot, 'node_modules'), 'dir');
    const info = await introspect(projectRoot);
    if (info.error) throw new Error(`${ref} does not load: ${info.error.message}`);
    return { ...buildSnapshot(info, projectRoot), label: ref === sha ? sha.slice(0, 7) : `${ref} (${sha.slice(0, 7)})` };
  } finally {
    await capture('git', ['worktree', 'remove', '--force', dir], { cwd: top }).catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}

async function git(cwd, args) {
  const res = await capture('git', args, { cwd }).catch(() => null);
  return res?.code === 0 ? res.stdout.trim() : null;
}

const MARK_COLOR = { '+': c.green, '-': c.red, '~': c.yellow };

function print(result, label) {
  const { changes, summary } = result;
  if (!changes.length) return out('', `  ${c.green('✔')} No behavior changes since ${label}.`, '');
  out('', `  ${c.bold(`Behavior changes since ${label}`)} ${c.dim(`(${summary.total})`)}`);
  const rows = diffRows(result).map((r) => [
    MARK_COLOR[r.mark](r.mark),
    r.what,
    r.detail,
    r.note.includes('looser') ? c.red(r.note) : r.note.includes('tighter') ? c.green(r.note) : c.magenta(r.note),
    c.dim(r.file),
  ]);
  out(table(rows, { indent: 2 }));
  const widen = summary.widen ? c.red(`${summary.widen} of ${summary.total} widen access.`) : c.green('Nothing widens access.');
  out('', `  ${widen} ${c.dim('`calm diff --json` for CI, `calm diff --ci` to fail the build on wider access.')}`, '');
}
