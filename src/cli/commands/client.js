import { dirname, extname, relative, resolve } from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { introspect } from '../lib/introspect.js';
import { generateClient, clientOperations } from '../../../core/client.js';
import { c, out, ok, info } from '../lib/ui.js';

export const help = `
${c.bold('calm client')} [--out <file>] [--js] [--stdout]

  A typed client for your web or mobile app, generated from this API's OpenAPI document:
  one file, no dependencies (fetch), every route a function with its input and output types.

    npx calm client --out ../web/src/api/calm-client.ts
    npx calm client --out ../app/api/calm-client.js --js     JavaScript plus a .d.ts for editors

    import { createClient } from './calm-client';
    const api = createClient({ baseUrl: 'http://localhost:5001', token: () => localStorage.token });
    const { token } = await api.auth.login({ email, password });
    const page = await api.products.list({ sort: '-price' });   // Page<Product>

  Default --out: client.out in calm.config.js, else calm-client.ts. With client: { out } in
  calm.config.js, calm dev writes it again whenever the API changes.
`;

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { out: { type: 'string' }, js: { type: 'boolean' }, stdout: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const meta = await introspect(root);
  if (meta.error) throw new Error(meta.error.message);
  const outFile = values.out ?? meta.client?.out ?? (values.js ? 'calm-client.js' : 'calm-client.ts');
  const lang = values.js || extname(outFile) === '.js' || extname(outFile) === '.mjs' ? 'js' : 'ts';
  const prefix = meta.app?.apiPrefix ?? '/api';
  const code = generateClient(meta.openapi, { lang, prefix });
  if (values.stdout) return out(lang === 'ts' ? code : code.js);

  const file = resolve(root, outFile);
  mkdirSync(dirname(file), { recursive: true });
  const written = [];
  const write = (path, text) => {
    // Unchanged files are left alone, so bundlers in watch mode do not rebuild for nothing.
    if (!existsSync(path) || readFileSync(path, 'utf8') !== text) writeFileSync(path, text);
    written.push(relative(root, path) || path);
  };
  if (lang === 'ts') write(file, code);
  else {
    write(file, code.js);
    write(file.replace(/\.m?js$/, '.d.ts'), code.dts);
  }
  const ops = clientOperations(meta.openapi, { prefix });
  ok(`Wrote ${written.join(' and ')} ${c.dim(`(${ops.length} routes in ${new Set(ops.map((o) => o.group)).size} groups)`)}`);
  info(`Use it: import { createClient } from '<path to ${written[0].split('/').pop().replace(/\.(ts|m?js)$/, '')}>'`);
}
