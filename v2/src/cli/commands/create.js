import { existsSync, readdirSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { scaffold, TEMPLATES } from '../lib/scaffold.js';
import { detectPackageManager, run as runCommand, capture } from '../lib/project.js';
import { PKG } from '../lib/files.js';
import { kebab } from '../lib/strings.js';
import { c, out, ok, warn, ask, choose, confirm, banner } from '../lib/ui.js';

export const help = `
${c.bold('calm create [directory]')}     also: npm create calmapi@latest [directory]

  Options
    --template <api|minimal>   api: users, auth and an example resource (default)
                               minimal: an empty app/ to start from scratch
    --db <uri>                 MongoDB connection string (default: local server)
    --pm <npm|pnpm|yarn|bun>   package manager to install with
    --no-install               skip installing dependencies
    --no-git                   skip git init
    -y, --yes                  accept every default, no prompts
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      template: { type: 'string' },
      db: { type: 'string' },
      pm: { type: 'string' },
      'no-install': { type: 'boolean', default: false },
      'no-git': { type: 'boolean', default: false },
      yes: { type: 'boolean', short: 'y', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return out(help);
  const prompt = !values.yes;

  banner(`create · v${PKG.version}`);
  const rawDir = positionals[0] ?? (prompt ? await ask('Project folder:', 'my-api') : 'my-api');
  const dir = resolve(rawDir);
  const name = kebab(basename(dir)) || 'calm-app';
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${rawDir} already exists and is not empty`);

  const template =
    values.template ??
    (prompt
      ? await choose('Template', [
          { value: 'api', label: 'api', hint: 'users, auth, sessions and an example "post" resource' },
          { value: 'minimal', label: 'minimal', hint: 'just the framework, bring your own resources' },
        ])
      : 'api');
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}"`);

  const defaultDb = `mongodb://127.0.0.1:27017/${name.replace(/-/g, '_')}`;
  const mongoUri = values.db ?? (prompt ? await ask('MongoDB URI:', defaultDb) : defaultDb);
  const pm = values.pm ?? detectPackageManager(process.cwd());
  const install = !values['no-install'] && (!prompt || (await confirm(`Install dependencies with ${pm}?`)));
  const git = !values['no-git'] && (!prompt || (await confirm('Initialize a git repository?')));

  const { files } = scaffold({ dir, name, template, mongoUri });
  ok(`Created ${c.bold(name)} ${c.dim(`(${files.length} files, template: ${template})`)}`);

  if (install) {
    out(c.dim(`  Installing with ${pm}...`));
    const code = await runCommand(pm, ['install'], { cwd: dir, stdio: ['ignore', 'ignore', 'inherit'] });
    if (code === 0) ok('Dependencies installed');
    else warn(`${pm} install failed (exit ${code}). Run it yourself inside ${rawDir}.`);
  }
  if (git) {
    const init = await capture('git', ['init', '-q'], { cwd: dir }).catch(() => ({ code: 1 }));
    if (init.code === 0) {
      await capture('git', ['add', '-A'], { cwd: dir });
      const commit = await capture('git', ['commit', '-q', '-m', 'Create CalmAPI project'], { cwd: dir });
      if (commit.code === 0) ok('Git repository initialized');
      else ok('Git repository initialized (commit skipped: set git user.name/user.email)');
    }
  }

  const cd = rawDir === '.' ? null : rawDir;
  out(
    '',
    c.bold('  Next steps'),
    '',
    ...(cd ? [`  ${c.dim('$')} cd ${cd}`] : []),
    ...(install ? [] : [`  ${c.dim('$')} ${pm} install`]),
    `  ${c.dim('$')} ${pm === 'npm' ? 'npm run' : pm} dev`,
    '',
    `  API        ${c.cyan('http://localhost:5001/api')}`,
    `  Devtools   ${c.cyan('http://localhost:5001/_calm')}`,
    '',
    c.dim(`  MongoDB must be running at ${redact(mongoUri)} (edit .env to change it).`),
    c.dim(`  Agents: AGENTS.md is ready, and \`npx calm mcp\` gives them project tools.`),
    '',
  );
  if (!existsSync(join(dir, 'node_modules')) && install) warn('node_modules is missing, the install probably failed.');
}

const redact = (uri) => uri.replace(/\/\/([^@/]+)@/, '//***@');
