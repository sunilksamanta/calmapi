import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { c, out, table } from '../lib/ui.js';

export const help = `
${c.bold('calm about')} [--json]

  The transparency report: everything the framework does that you did not write. The
  request pipeline in the order it runs, the headers it sets, what it stores and for how
  long, what it logs, which hosts the code can reach, and every file the CLI writes.
  Generated from your project's own calm/ and app/ code, so it cannot drift from it.
  Devtools shows the same under About; agents read it with calm_about.
`;

const duration = (s) => (s === 0 ? 'until the date in' : s % 86_400 === 0 ? `${s / 86_400} days` : s % 3600 === 0 ? `${s / 3600} hours` : s % 60 === 0 ? `${s / 60} minutes` : `${s} s`);
const title = (t) => out('', `  ${c.bold(t)}`);

export async function run(argv) {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return out(help);
  const root = requireProject();
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const a = info.about;
  if (!a) throw new Error('This project\'s calm/ predates the transparency report. Run `npx calm upgrade` first.');
  if (values.json) return out(JSON.stringify(a, null, 2));

  const f = a.framework;
  out('', `  ${c.bold('CalmAPI about')} ${c.dim(`· calmapi ${f.calmapi ?? '?'} · node ${f.node} · express ${f.express ?? '?'} · mongoose ${f.mongoose ?? '?'} · ${f.mode}`)}`);

  title('Request pipeline (in the order it runs)');
  out(table(a.pipeline.map((p, i) => [c.dim(String(i + 1).padStart(2)), p.name, c.dim(p.from === 'calm' ? (p.file ?? '') : `${p.from} ${p.file ?? ''}`), p.purpose + (p.when ? c.dim(` (${p.when})`) : '')])));

  title('Headers on every response');
  const h = a.headers;
  out(table([...h.always, ...h.rateLimit].map((x) => [x.name, c.dim(x.value), x.when ? c.dim(x.when) : ''])));
  out(c.dim(`  Removed: ${h.removed.join(', ')}`));
  const origins = typeof h.cors.origins === 'string' ? h.cors.origins : h.cors.origins.join(', ') || 'none';
  out(c.dim(`  CORS: origins ${origins}${h.cors.credentials ? ', with credentials' : ''}; exposes ${h.cors.exposeHeaders.join(', ')}${h.cors.notProduction ? ` (${h.cors.notProduction})` : ''}`));

  title('Stored data');
  out(table(a.stored.collections.map((s) => [s.collection, c.dim(s.owner), s.ttl ? (s.ttl.seconds === 0 ? `deleted at ${s.ttl.field}` : `deleted ${duration(s.ttl.seconds)} after ${s.ttl.field}`) : c.dim('kept until deleted'), s.encryptedFields.length ? `encrypted: ${s.encryptedFields.join(', ')}` : '', c.dim(s.note ?? '')])));
  for (const m of a.stored.memory) out(`  ${m.name}: ${m.what} ${c.dim(`(${m.where}; ${m.retention})`)}`);

  title('Logging');
  out(`  ${a.logging.level}, ${a.logging.format}. Access log: ${a.logging.accessLog.when}, ${a.logging.accessLog.fields.join(', ')}.`);
  out(`  ${a.logging.never}.`);
  out(c.dim(`  Devtools ${a.logging.devtools.when}: ${a.logging.devtools.where}.`));

  title('Hosts the code can reach');
  const o = a.outbound;
  out(`  ${o.promise.ok ? c.green('✔') : c.red('✖')} ${o.promise.text} ${c.dim(`(${o.promise.detail})`)}`);
  if (o.hosts.length) out(table(o.hosts.map((x) => [x.host, c.dim(x.files.join(', '))])));
  else out(c.dim('  No host names in app/ or calm/.'));
  for (const d of o.dynamic) out(c.dim(`  ${d.file}: ${d.note}`));

  title('Files the CLI writes');
  for (const x of a.files) out(`  ${x.path}`, c.dim(`      ${x.by}: ${x.when}`));

  if (a.blocks.length) {
    title('Blocks');
    out(table(a.blocks.map((b) => [b.name, c.dim(b.file ?? ''), b.env.length ? `env: ${b.env.join(', ')}` : '', b.models.length ? `models: ${b.models.join(', ')}` : ''])));
  }
  out('');
}
