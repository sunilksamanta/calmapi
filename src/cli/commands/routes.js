import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { c, out, table, METHOD_COLOR } from '../lib/ui.js';

export const help = `
${c.bold('calm routes')} [path] [--resource <name>] [--json]

  Every route the app serves, with its access policy and the file it comes from.

  Options
    [path]              only routes whose path contains this text (any case)
    --resource <name>   only routes of this resource (as in --json), e.g. post
    --json              print the routes as JSON
`;

const POLICY_COLOR = (label) => {
  if (label.includes('public')) return c.green(label);
  if (label.includes('admin') && !label.includes('owner')) return c.magenta(label);
  if (label.includes('owner')) return c.blue(label);
  return label;
};

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { json: { type: 'boolean' }, resource: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  if (positionals.length > 1) throw new Error(`calm routes takes one path filter, not ${positionals.length}`);
  const root = requireProject();
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  const all = info.routes.filter((r) => !r.hidden);
  const routes = filterRoutes(all, { path: positionals[0], resource: values.resource });
  if (values.json) return out(JSON.stringify(routes, null, 2));

  const filters = describeFilters({ path: positionals[0], resource: values.resource });
  if (!routes.length) return out(`No routes match ${filters}.`);

  const rows = [[c.dim('METHOD'), c.dim('PATH'), c.dim('POLICY'), c.dim('FROM')]];
  for (const r of routes) {
    rows.push([
      (METHOD_COLOR[r.method] ?? ((s) => s))(r.method),
      r.path,
      r.policyExplicit ? POLICY_COLOR(r.policy) : c.yellow(`${r.policy} (default)`),
      c.dim(r.file ?? r.source),
    ]);
  }
  const count = filters ? `${routes.length} of ${all.length} routes match ${filters}` : `${routes.length} routes`;
  out('', table(rows), '', c.dim(`  ${count} · ${info.resources.length} resources · ${info.blocks.length} blocks`), '');
}

/** Routes whose path contains `path` and whose resource is `resource`, both ignoring case. */
export function filterRoutes(routes, { path, resource } = {}) {
  const needle = path?.toLowerCase();
  const name = resource?.toLowerCase();
  return routes.filter(
    (r) => (!needle || r.path.toLowerCase().includes(needle)) && (!name || r.resource?.toLowerCase() === name),
  );
}

const describeFilters = ({ path, resource }) =>
  [path && `path "${path}"`, resource && `resource "${resource}"`].filter(Boolean).join(' and ');
