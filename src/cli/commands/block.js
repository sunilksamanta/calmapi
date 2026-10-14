import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { requireProject, readLock } from '../lib/project.js';
import { readJson, writeJson, readText, sha256, isDir } from '../lib/files.js';
import { readProjectBlock, toRegistryItem, checkItem, review, lockName } from '../lib/blocks.js';
import { fetchItem } from '../lib/registry.js';
import { c, out, ok, warn, info } from '../lib/ui.js';

export const help = `
${c.bold('calm block <command>')}

  Share the blocks you write, and look at the ones you added.

    list                    blocks in this project: version, source, files you changed
    check [name|address]    check a block before sharing or adding it (also reviews what its
                            code does: network, files, child processes, secrets...)
    pack [name...]          write registry items for your blocks to r/ (all blocks that have
                            a block.json when no name is given)

  Options
    --out <dir>             where pack writes (default: r)

  Sharing
    calm make block stripe-billing      start one (app/blocks/stripe-billing/)
    calm block pack                     writes r/stripe-billing.json and r/index.json
    git push                            then anyone can run:
    calm add gh:<you>/<repo>/stripe-billing
    calm add https://<host>/r/stripe-billing.json      (any static host works too)
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string', default: 'r' }, help: { type: 'boolean', short: 'h' } },
  });
  const [sub, ...rest] = positionals;
  if (values.help || !sub) return out(help);
  if (sub === 'list' || sub === 'ls') return list();
  if (sub === 'check') return check(rest[0]);
  if (sub === 'pack') return pack(rest, values.out);
  throw new Error(`Unknown block command "${sub}". Try: list, check, pack`);
}

const localBlocks = (root) => {
  const dir = join(root, 'app', 'blocks');
  return isDir(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(dir, d.name, 'index.js'))).map((d) => d.name).sort() : [];
};

function list() {
  const root = requireProject();
  const lock = readLock(root);
  const installed = lock.blocks ?? {};
  const names = new Set([...localBlocks(root), ...Object.entries(installed).map(([k, e]) => lockName(k, e))]);
  if (!names.size) return info('No blocks yet. `calm add --list` shows the official ones, `calm make block <name>` starts your own.');
  out('');
  for (const name of [...names].sort()) {
    const key = Object.keys(installed).find((k) => lockName(k, installed[k]) === name);
    const entry = key ? installed[key] : null;
    const changed = entry ? Object.entries(entry.files).filter(([f, hash]) => !existsSync(join(root, f)) || sha256(readText(join(root, f))) !== hash).map(([f]) => f) : [];
    const meta = readJson(join(root, 'app', 'blocks', name, 'block.json'));
    const source = entry ? entry.source : meta ? 'written here' : 'local';
    const version = entry?.version ?? meta?.version ?? '';
    out(`  ${c.green(name.padEnd(20))} ${c.dim(version.padEnd(8))} ${c.dim(source)}`);
    if (changed.length) out(`  ${' '.repeat(20)} ${c.yellow(`${changed.length} file(s) changed since added:`)} ${c.dim(changed.join(', '))}`);
  }
  out('');
}

function printFindings(findings) {
  const icon = { error: c.red('error'), warn: c.yellow('warn '), info: c.dim('info ') };
  for (const f of findings) out(`  ${icon[f.level]} ${f.message}`);
}

function printReview(items) {
  const found = review(items);
  if (!found.length) return out(`  ${c.dim('Nothing notable: no network, files, child processes or request hooks.')}`);
  for (const r of found) {
    const where = r.line ? `${r.file}:${r.line}` : r.file;
    out(`  ${r.risk === 'high' ? c.yellow('!') : c.dim('-')} ${r.what} ${c.dim(where)}`);
  }
}

async function check(target) {
  const root = requireProject();
  let item;
  if (target && /^(https?:|gh:|@)|\.json$/.test(target)) item = (await fetchItem(target, { root })).item;
  else {
    const names = target ? [target] : localBlocks(root).filter((n) => existsSync(join(root, 'app', 'blocks', n, 'block.json')));
    if (!names.length) throw new Error('No block to check. Give a name (calm block check stripe-billing) or an address.');
    let failed = 0;
    for (const name of names) failed += checkOne(root, name);
    if (failed) process.exitCode = 1;
    return;
  }
  out('', `  ${c.bold(item.name)} ${c.dim(`v${item.version}`)}`, '');
  const findings = checkItem(item);
  printFindings(findings);
  out('', `  ${c.bold('What the code does')}`);
  printReview(item.files);
  out('');
  if (findings.some((f) => f.level === 'error')) process.exitCode = 1;
}

function checkOne(root, name) {
  const block = readProjectBlock(root, name);
  const item = toRegistryItem(block.meta, block.files);
  out('', `  ${c.bold(name)} ${c.dim(`v${item.version} · ${block.files.length} file(s)`)}`);
  const findings = checkItem(item);
  if (!block.hasMeta) findings.unshift({ level: 'warn', message: `no app/blocks/${name}/block.json: pack would share it as v0.1.0 with no description (calm make block writes one)` });
  if (findings.length) printFindings(findings);
  else out(`  ${c.green('ok')}    nothing to fix`);
  out('', `  ${c.bold('What the code does')}`);
  printReview(item.files);
  out('');
  return findings.some((f) => f.level === 'error') ? 1 : 0;
}

function pack(names, outDir) {
  const root = requireProject();
  const chosen = names.length ? names : localBlocks(root).filter((n) => existsSync(join(root, 'app', 'blocks', n, 'block.json')));
  if (!chosen.length) throw new Error('No block to pack: add a block.json next to app/blocks/<name>/index.js (calm make block writes one).');
  const dir = resolve(root, outDir);
  const written = [];
  for (const name of chosen) {
    const block = readProjectBlock(root, name);
    const item = toRegistryItem(block.meta, block.files);
    const errors = checkItem(item).filter((f) => f.level === 'error');
    if (errors.length) {
      warn(`${name} was not packed:`);
      printFindings(errors);
      process.exitCode = 1;
      continue;
    }
    writeJson(join(dir, `${name}.json`), item);
    written.push(item);
  }
  // The index lists every item in the folder, including ones packed earlier.
  const items = readdirSync(dir).filter((f) => f.endsWith('.json') && f !== 'index.json').sort().map((f) => readJson(join(dir, f))).filter((i) => i?.name);
  const pkg = readJson(join(root, 'package.json'), {});
  writeJson(join(dir, 'index.json'), {
    $schema: 'https://ui.shadcn.com/schema/registry.json',
    name: pkg.name ?? 'blocks',
    homepage: pkg.homepage ?? undefined,
    items: items.map((i) => ({ name: i.name, title: i.title, description: i.description, version: i.version, categories: i.categories })),
  });
  if (!written.length) return;
  ok(`Packed ${written.map((i) => c.bold(i.name)).join(', ')} into ${c.cyan(outDir)}/`);
  out('', `  ${c.dim('Share it')}`, `  Commit ${outDir}/ and push to GitHub, then anyone can run:`, ...written.map((i) => `    npx calm add gh:<you>/<repo>/${i.name}`), `  Or host ${outDir}/ anywhere: npx calm add https://<host>/${outDir}/<name>.json`, '');
}
