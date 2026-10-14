import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { c, out, ok, info, confirm, table } from '../lib/ui.js';
import { runCheckpointOp, docCount, whoText, since } from './checkpoint.js';

export const help = `
${c.bold('calm restore')} [id] [--yes] [--json]

  Put the development database (MONGODB_URI from .env) back as it was in a checkpoint
  taken with ${c.bold('calm checkpoint')}. Without an id, the latest checkpoint is restored.

  Every collection in the checkpoint is emptied and refilled from it, and collections
  that did not exist at the time are dropped. The command shows what it is about to do
  and asks before touching anything; pass --yes to skip the question (required when
  there is no terminal, for example in a script).

    calm restore                              the latest checkpoint
    calm restore 20260413-141500-manual       a specific one (calm checkpoint list)
    calm restore --yes                        no questions asked

  Refuses to run in production.
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { yes: { type: 'boolean', short: 'y' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const id = positionals[0] ?? null;

  const plan = await runCheckpointOp(root, { kind: 'plan', id });
  const meta = plan.checkpoint;
  if (!values.json) {
    out('', `  Restore ${c.bold(meta.id)} ${c.dim(`(${meta.name}, ${since(meta.createdAt)}, by ${whoText(meta.actor)})`)}`);
    const rows = meta.collections.map((col) => {
      const now = plan.now[col.name];
      return [`    ${col.name}`, `${col.docs} documents`, now === undefined ? c.dim('(missing now)') : now === col.docs ? c.dim(`(${now} now)`) : c.yellow(`(${now} now)`)];
    });
    for (const name of plan.dropped) rows.push([`    ${name}`, c.red('drop'), c.dim(`(${plan.now[name]} now, not in the checkpoint)`)]);
    out(table(rows, { indent: 0 }), '');
  }

  if (!values.yes) {
    if (!process.stdin.isTTY || !process.stdout.isTTY || process.env.CI) throw new Error('Not an interactive terminal: pass --yes to restore without confirmation.');
    const go = await confirm(`Replace the current data with checkpoint ${meta.id}?`, false);
    if (!go) return info('Nothing changed.');
  }

  const result = await runCheckpointOp(root, { kind: 'restore', id: meta.id });
  if (values.json) return out(JSON.stringify(result, null, 2));
  const dropped = result.dropped.length ? `, dropped ${result.dropped.join(', ')}` : '';
  ok(`Restored ${c.bold(result.id)}: ${result.collections.length} collections, ${docCount(result)} documents${dropped}`);
}
