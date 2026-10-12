import { existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireProject, readLock, writeLock, detectPackageManager, run as runCmd } from '../lib/project.js';
import { resolveAll, splitDep, OFFICIAL, OFFICIAL_URL } from '../lib/registry.js';
import { review } from '../lib/blocks.js';
import { compareVersions } from '../lib/semver.js';
import { PKG_ROOT, readJson, writeJson, writeFile, readText, sha256 } from '../lib/files.js';
import { c, out, ok, warn, info, confirm } from '../lib/ui.js';

export const help = `
${c.bold('calm add <block...>')}

  Copy a block's source into your project (app/blocks/...), install its
  dependencies and record it in calm.lock. The code is yours from then on.

    calm add jobs api-docs          official blocks (same as @calmapi/jobs)
    calm add @acme/billing          from a registry in package.json "calm.registries"
    calm add https://x.dev/r/y.json from any URL
    calm add gh:user/repo/name      r/<name>.json in a GitHub repository (calm block pack)

  Blocks from anyone but CalmAPI are reviewed first: what their code does (network,
  files, child processes, request hooks, secrets) is listed before you confirm.

  Options
    --dry-run       show what would change, write nothing
    --overwrite     replace files that already exist with different content
    --no-install    do not run the package manager
    --remote        fetch official blocks from docs.calmapi.dev instead of the bundled copy
    -y, --yes       do not ask for confirmation
    --trust         with --yes, also add third-party blocks whose review found risky code

  ${c.dim('calm add --list')}   list official blocks
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'no-install': { type: 'boolean' },
      remote: { type: 'boolean' },
      yes: { type: 'boolean', short: 'y' },
      trust: { type: 'boolean' },
      list: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.list) return listBlocks();
  if (values.help || !positionals.length) return out(help);

  const root = requireProject();
  const items = await resolveAll(positionals, { root, remote: values.remote });
  const lock0 = readLock(root);
  for (const { key, item } of items) {
    const min = item.meta?.calmapi?.minVersion;
    if (min && lock0.calmapi && compareVersions(lock0.calmapi, min) < 0) {
      throw new Error(`${key} needs CalmAPI ${min} or newer in calm/ (yours is ${lock0.calmapi}). Run \`calm upgrade\` first.`);
    }
  }
  const installed = Object.keys(lock0.blocks ?? {}).map((k) => k.split('/').pop());
  for (const { key, item } of items) {
    const clash = (item.meta?.calmapi?.conflicts ?? []).find((n) => installed.includes(n) || items.some((i) => i.item.name === n));
    if (clash) throw new Error(`${key} cannot be installed together with ${clash} (they do the same job; pick one).`);
  }
  const plan = planChanges(root, items, values);

  out('', `  ${c.bold('Blocks')}`);
  for (const { key, item, source } of items) out(`  ${c.green('+')} ${c.bold(key)} ${c.dim(`v${item.version ?? '0.0.0'} · ${source}`)}${item.description ? `\n    ${c.dim(item.description)}` : ''}`);
  out('', `  ${c.bold('Files')}`);
  for (const f of plan.files) {
    const label = { create: c.green('create   '), same: c.dim('unchanged'), conflict: c.yellow('conflict '), overwrite: c.yellow('overwrite') }[f.action];
    out(`  ${label} ${f.target}`);
  }
  if (Object.keys(plan.deps).length || Object.keys(plan.devDeps).length) {
    out('', `  ${c.bold('Dependencies')}`);
    for (const [n, v] of Object.entries(plan.deps)) out(`  ${c.green('+')} ${n}@${v}`);
    for (const [n, v] of Object.entries(plan.devDeps)) out(`  ${c.green('+')} ${n}@${v} ${c.dim('(dev)')}`);
  }
  if (plan.env.length) {
    out('', `  ${c.bold('Environment')} ${c.dim('(.env.example and .env)')}`);
    for (const [k, v] of plan.env) out(`  ${c.green('+')} ${k}=${v}`);
  }
  out('');

  // Someone else's code is about to land in the project: say what it does.
  let risky = false;
  for (const { key, item, source } of items) {
    if (source.startsWith(`${OFFICIAL} (bundled)`) || source.startsWith(OFFICIAL_URL.replace('{name}.json', ''))) continue;
    const findings = review(item.files);
    risky ||= findings.some((r) => r.risk === 'high');
    out(`  ${c.bold('Review')} ${c.dim(`${key} is not an official block: read it before you trust it`)}`);
    if (!findings.length) out(`  ${c.dim('- nothing notable: no network, files, child processes or request hooks')}`);
    for (const r of findings) out(`  ${r.risk === 'high' ? c.yellow('!') : c.dim('-')} ${r.what} ${c.dim(r.line ? `${r.file}:${r.line}` : r.file)}`);
    out('');
  }
  if (risky && values.yes && !values.trust && !values['dry-run']) throw new Error('The review found risky code in a third-party block. Read it, then add --trust to install it non-interactively.');

  const conflicts = plan.files.filter((f) => f.action === 'conflict');
  if (conflicts.length) warn(`${conflicts.length} file(s) already exist with different content and will be kept. Use --overwrite to replace them.`);
  if (values['dry-run']) return info('Dry run: nothing was written.');
  if (!values.yes && !(await confirm(risky ? 'This block has code worth reading (marked !). Add it anyway?' : 'Apply these changes?'))) return info('Cancelled.');

  for (const f of plan.files) if (f.action === 'create' || f.action === 'overwrite') writeFile(join(root, f.target), f.content);

  const pkgFile = join(root, 'package.json');
  const pkg = readJson(pkgFile);
  pkg.dependencies = sortKeys({ ...pkg.dependencies, ...plan.deps });
  if (Object.keys(plan.devDeps).length) pkg.devDependencies = sortKeys({ ...pkg.devDependencies, ...plan.devDeps });
  writeJson(pkgFile, pkg);

  for (const file of ['.env.example', '.env']) {
    const path = join(root, file);
    if (!existsSync(path)) continue;
    const existing = readText(path);
    const missing = plan.env.filter(([k]) => !new RegExp(`^#?\\s*${k}=`, 'm').test(existing));
    if (missing.length) appendFileSync(path, `${existing.endsWith('\n') ? '' : '\n'}${missing.map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  }

  const lock = readLock(root);
  lock.blocks ??= {};
  for (const { key, item, source } of items) {
    lock.blocks[key] = {
      version: item.version ?? '0.0.0',
      source,
      files: Object.fromEntries(item.files.map((f) => [f.target ?? f.path, sha256(f.content)])),
    };
  }
  writeLock(root, lock);

  if (!values['no-install'] && (Object.keys(plan.deps).length || Object.keys(plan.devDeps).length)) {
    const pm = detectPackageManager(root);
    out(c.dim(`  Installing with ${pm}...`));
    const code = await runCmd(pm, ['install'], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
    if (code !== 0) warn(`${pm} install failed (exit ${code}); run it yourself.`);
  }

  ok(`Added ${items.map((i) => c.bold(i.key)).join(', ')}`);
  for (const { item } of items) if (item.docs) out('', ...item.docs.trim().split('\n').map((l) => `  ${l}`));
  out('');
}

function planChanges(root, items, values) {
  const files = [];
  const deps = {};
  const devDeps = {};
  const env = [];
  const pkg = readJson(join(root, 'package.json'), {});
  for (const { item } of items) {
    for (const f of item.files) {
      const target = f.target ?? f.path;
      const path = join(root, target);
      let action = 'create';
      if (existsSync(path)) {
        const current = readText(path);
        action = current === f.content ? 'same' : values.overwrite ? 'overwrite' : 'conflict';
      }
      files.push({ target, content: f.content, action });
    }
    for (const spec of item.dependencies ?? []) {
      const [n, v] = splitDep(spec);
      if (!pkg.dependencies?.[n]) deps[n] = v;
    }
    for (const spec of item.devDependencies ?? []) {
      const [n, v] = splitDep(spec);
      if (!pkg.devDependencies?.[n] && !pkg.dependencies?.[n]) devDeps[n] = v;
    }
    for (const [k, v] of Object.entries(item.envVars ?? {})) if (!env.some(([e]) => e === k)) env.push([k, v]);
  }
  return { files, deps, devDeps, env };
}

const sortKeys = (obj) => Object.fromEntries(Object.entries(obj).sort(([a], [b]) => a.localeCompare(b)));

function listBlocks() {
  const index = readJson(join(PKG_ROOT, 'registry', 'r', 'index.json'), { items: [] });
  out('', `  ${c.bold('Official blocks')} ${c.dim('(calm add <name>)')}`, '');
  for (const item of index.items) out(`  ${c.green(item.name.padEnd(18))} ${item.description ?? ''}`);
  out('');
}
