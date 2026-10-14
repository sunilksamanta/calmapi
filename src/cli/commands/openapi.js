import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { writeJson } from '../lib/files.js';
import { c, out, ok } from '../lib/ui.js';

export const help = `
${c.bold('calm openapi')} [--out openapi.json] [--stdout]

  Write the OpenAPI 3.1 document generated from your resources and routes.
  The running app also serves it at /api/openapi.json.
`;

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string', default: 'openapi.json' }, stdout: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const info = await introspect(root);
  if (info.error) throw new Error(info.error.message);
  if (values.stdout) return out(JSON.stringify(info.openapi, null, 2));
  writeJson(resolve(root, values.out), info.openapi);
  ok(`Wrote ${values.out} ${c.dim(`(${Object.keys(info.openapi.paths).length} paths)`)}`);
}
