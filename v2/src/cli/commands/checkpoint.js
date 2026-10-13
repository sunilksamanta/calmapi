import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { c, out, ok, info, table } from '../lib/ui.js';

export const help = `
${c.bold('calm checkpoint')} [name] [--note <text>] [--json]
${c.bold('calm checkpoint list')} [--json]
${c.bold('calm checkpoint delete')} <id>

  Snapshot the development database (MONGODB_URI from .env) to .calm/checkpoints/<id>/,
  one file per collection, so you can try something and put the data back with
  ${c.bold('calm restore')}. The default name is "manual"; the id is the time plus the name.

    calm checkpoint                          before a risky change
    calm checkpoint "before migration"       a name you will recognize in the list
    calm checkpoint list                     what you have, newest first
    calm checkpoint delete 20260413-141500-manual

  Checkpoints store documents only (not indexes, which the models create again at
  boot). .calm/ is ignored by git. Refuses to run in production.
`;

// Runs inside the project with its own calm/ code and database connection.
const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const op = JSON.parse(process.env.CALM_CHECKPOINT);
const root = process.cwd();
let result;
try {
  if ((process.env.NODE_ENV ?? '') === 'production') throw new Error('Checkpoints are a development tool: they do not run with NODE_ENV=production.');
  const cp = await import(pathToFileURL(join(root, 'calm', 'checkpoints.js')).href);
  if (op.kind === 'list') result = await cp.listCheckpoints(root);
  else if (op.kind === 'delete') result = await cp.deleteCheckpoint(root, op.id, { actor: op.actor });
  else {
    const { createApp } = await import(pathToFileURL(join(root, 'calm', 'index.js')).href);
    const app = await createApp({ root, config: { mode: 'development', log: { level: 'silent' }, devtools: { enabled: false }, db: { connectRetries: 1 } } });
    await app.start();
    try {
      if (op.kind === 'create') result = await app.checkpoints.create({ name: op.name, note: op.note, actor: op.actor });
      else if (op.kind === 'restore') result = await app.checkpoints.restore(op.id, { actor: op.actor });
      else if (op.kind === 'plan') {
        // What a restore would do: the checkpoint next to what the database holds now.
        const meta = op.id ? await app.checkpoints.read(op.id) : (await app.checkpoints.list())[0];
        if (!meta) throw new Error('No checkpoints yet. Take one with calm checkpoint.');
        const db = app.mongoose.connection.db;
        const now = (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => !n.startsWith('system.')).sort();
        const counts = {};
        for (const name of now) counts[name] = await db.collection(name).estimatedDocumentCount();
        result = { checkpoint: meta, now: counts, dropped: now.filter((n) => !meta.collections.some((x) => x.name === n)) };
      }
    } finally {
      await app.stop();
    }
  }
} catch (err) {
  result = { error: err.message };
}
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result));
process.exit(0);
`;

/** Run one checkpoint operation inside the project. Shared with `calm restore`. */
export async function runCheckpointOp(root, op) {
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env: { CALM_CHECKPOINT: JSON.stringify({ actor: { kind: 'human', name: 'cli' }, ...op }) } });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Could not run in the project:\n${res.stderr || res.stdout}`);
  const result = JSON.parse(res.stdout.slice(marker + 8));
  if (result?.error) throw new Error(result.error);
  return result;
}

export const docCount = (meta) => meta.collections.reduce((n, x) => n + x.docs, 0);
export const whoText = (actor) => (actor?.kind === 'agent' ? `${actor.name} (agent)` : 'you');

/** "2 minutes ago", "3 days ago": enough for a list of snapshots. */
export function since(when) {
  const sec = Math.max(0, Math.round((Date.now() - Date.parse(when)) / 1000));
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} minute${min === 1 ? '' : 's'} ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const day = Math.floor(hr / 24);
  return `${day} day${day === 1 ? '' : 's'} ago`;
}

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { note: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const [first, ...rest] = positionals;

  if (first === 'list' || first === 'ls') {
    const list = await runCheckpointOp(root, { kind: 'list' });
    if (values.json) return out(JSON.stringify(list, null, 2));
    if (!list.length) return info('No checkpoints yet. Take one with `calm checkpoint`.');
    const rows = [[c.dim('id'), c.dim('name'), c.dim('when'), c.dim('collections'), c.dim('docs'), c.dim('by')]];
    for (const m of list) rows.push([m.id, m.name + (m.auto ? c.dim(' (auto)') : ''), since(m.createdAt), String(m.collections.length), String(docCount(m)), whoText(m.actor)]);
    return out('', table(rows), '');
  }
  if (first === 'delete' || first === 'rm') {
    if (!rest[0]) throw new Error('Which one? calm checkpoint delete <id> (calm checkpoint list shows the ids)');
    const meta = await runCheckpointOp(root, { kind: 'delete', id: rest[0] });
    return ok(`Deleted checkpoint ${c.bold(meta.id)} (${meta.name})`);
  }

  // Anything else is a name; `create` is accepted so a checkpoint can be called "list".
  const name = (first === 'create' ? rest[0] : first) ?? 'manual';
  const meta = await runCheckpointOp(root, { kind: 'create', name, note: values.note ?? null });
  if (values.json) return out(JSON.stringify(meta, null, 2));
  ok(`Checkpoint ${c.bold(meta.id)}: ${meta.collections.length} collections, ${docCount(meta)} documents ${c.dim(`(.calm/checkpoints/${meta.id})`)}`);
  out(c.dim(`  Put the data back with: calm restore ${meta.id}`));
}
