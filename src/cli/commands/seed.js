import { parseArgs } from 'node:util';
import { requireProject, capture } from '../lib/project.js';
import { c, out, ok } from '../lib/ui.js';
import { pluralize } from '../../../core/utils/strings.js';

export const help = `
${c.bold('calm seed [resource...]')} [--count 10] [--users 3] [--seed 42]

  Fill the database (MONGODB_URI from .env) with sample records that look real, built
  from your field definitions and created through your services, so hooks run and
  everything passes validation. Referenced resources get a few records first. When
  there are no users, demo users are created and own the records (their email and
  password are printed).

    calm seed                     every resource, 10 records each
    calm seed product --count 50  one resource
    calm seed --seed 42           the same values every run

  Refuses to run in production.
`;

// Runs inside the project with its own calm/ code and database connection.
const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const opts = JSON.parse(process.env.CALM_SEED_OPTIONS);
let result;
try {
  if ((process.env.NODE_ENV ?? '') === 'production') throw new Error('calm seed does not run with NODE_ENV=production.');
  const { createApp } = await import(pathToFileURL(join(process.cwd(), 'calm', 'index.js')).href);
  const { seed } = await import(pathToFileURL(join(process.cwd(), 'calm', 'seed.js')).href);
  const app = await createApp({ root: process.cwd(), config: { mode: 'development', log: { level: 'silent' }, devtools: { enabled: false }, db: { connectRetries: 1 } } });
  await app.start();
  result = await seed(app, opts);
  await app.stop();
} catch (err) {
  result = { error: err.message, details: err.details };
}
// Exit once the pipe took everything: exiting right after a large write cuts the output short.
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result), () => process.exit(0));
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { count: { type: 'string', default: '10' }, users: { type: 'string', default: '3' }, seed: { type: 'string' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const opts = { count: Math.min(Math.max(Number(values.count) || 10, 1), 10_000), users: Number.isInteger(Number(values.users)) && Number(values.users) >= 0 ? Number(values.users) : 3, ...(positionals.length ? { resources: positionals } : {}), ...(values.seed ? { seed: Number(values.seed) } : {}) };
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env: { CALM_SEED_OPTIONS: JSON.stringify(opts) } });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Could not run in the project:\n${res.stderr || res.stdout}`);
  const result = JSON.parse(res.stdout.slice(marker + 8));
  if (result.error) throw new Error(result.details ? `${result.error}: ${JSON.stringify(result.details)}` : result.error);
  ok(`Seeded ${Object.entries(result.created).map(([n, k]) => `${c.bold(k)} ${k === 1 ? n : pluralize(n)}`).join(', ') || 'nothing'}`);
  if (result.users.length) {
    out('', `  ${c.dim('Demo users (sign in with these)')}`);
    for (const u of result.users) out(`  ${u.email}  ${c.dim(u.password)}`);
  }
  out('');
}
