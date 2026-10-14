import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { c, out, table, METHOD_COLOR } from '../lib/ui.js';

export const help = `
${c.bold('calm routes')} [--json]

  Every route the app serves, with its access policy and the file it comes from.
`;

const POLICY_COLOR = (label) => {
  if (label.includes('public')) return c.green(label);
  if (label.includes('admin') && !label.includes('owner')) return c.magenta(label);
  if (label.includes('owner')) return c.blue(label);
  return label;
};

export async function run(argv) {
  const { values } = parseArgs({ args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } });
  if (values.help) return out(help);
  const root = requireProject();
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const routes = info.routes.filter((r) => !r.hidden);
  if (values.json) return out(JSON.stringify(routes, null, 2));

  const rows = [[c.dim('METHOD'), c.dim('PATH'), c.dim('POLICY'), c.dim('FROM')]];
  for (const r of routes) {
    rows.push([
      (METHOD_COLOR[r.method] ?? ((s) => s))(r.method),
      r.path,
      r.policyExplicit ? POLICY_COLOR(r.policy) : c.yellow(`${r.policy} (default)`),
      c.dim(r.file ?? r.source),
    ]);
  }
  out('', table(rows), '', c.dim(`  ${routes.length} routes · ${info.resources.length} resources · ${info.blocks.length} blocks`), '');
}
