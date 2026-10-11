import { existsSync, mkdtempSync, writeFileSync, rmSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { parseArgs } from 'node:util';
import { requireProject, readLock, writeLock, capture } from '../lib/project.js';
import { coreFiles, CORE_DIR } from '../lib/scaffold.js';
import { PKG, walk, readText, writeFile, sha256, isDir } from '../lib/files.js';
import { c, out, ok, warn, info, confirm } from '../lib/ui.js';

export const help = `
${c.bold('calm upgrade')} [--dry-run] [--base <dir>] [-y]

  Bring framework fixes into calm/ without losing your edits.

  calm.lock remembers the exact framework files you started from. For each file:
    untouched by you      replaced with the new version
    edited by you         3-way merged (your edits + upstream changes)
    conflicting edits     written with <<<<<<< markers for you to resolve
    new upstream          added; removed upstream (and untouched) deleted

  The original files come from the calmapi package of the version in calm.lock
  (downloaded from npm once and cached), or from --base <dir> (a calmapi checkout).
`;

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'dry-run': { type: 'boolean' },
      base: { type: 'string' },
      yes: { type: 'boolean', short: 'y' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  if (values.help) return out(help);

  const root = requireProject();
  const lock = readLock(root);
  const next = coreFiles();
  const from = lock.calmapi;

  const baseDir = values.base ? join(values.base, 'core') : await baseCore(from);
  const base = {};
  if (baseDir) for (const rel of walk(baseDir)) base[`calm/${rel}`] = readText(join(baseDir, rel));

  const plan = [];
  const all = new Set([...Object.keys(lock.core ?? {}), ...Object.keys(next)]);
  for (const rel of [...all].sort()) {
    const path = join(root, rel);
    const mine = existsSync(path) ? readText(path) : null;
    const theirs = next[rel] ?? null;
    const pristineHash = lock.core?.[rel];
    const untouched = mine !== null && pristineHash && sha256(mine) === pristineHash;

    if (theirs === null) {
      if (mine === null) continue;
      plan.push({ rel, action: untouched ? 'delete' : 'keep-removed' });
    } else if (mine === null) {
      plan.push({ rel, action: pristineHash ? 'skip-deleted' : 'add', content: theirs });
    } else if (mine === theirs) {
      plan.push({ rel, action: 'same' });
    } else if (untouched || !pristineHash) {
      plan.push({ rel, action: pristineHash ? 'update' : 'conflict-new', content: theirs, mine });
    } else if (base[rel] !== undefined && sha256(base[rel]) === pristineHash) {
      const merged = await merge3(mine, base[rel], theirs);
      if (!merged.conflicts && merged.text === mine) plan.push({ rel, action: 'same' }); // upstream had nothing new for it
      else plan.push({ rel, action: merged.conflicts ? 'conflict' : 'merge', content: merged.text });
    } else {
      plan.push({ rel, action: 'manual', content: theirs });
    }
  }

  const changes = plan.filter((p) => p.action !== 'same');
  out('', `  ${c.bold('calm upgrade')} ${c.dim(`${from} → ${PKG.version}`)}`, '');
  if (!changes.length) {
    ok('calm/ is already up to date.');
    if (from !== PKG.version) {
      lock.calmapi = PKG.version;
      if (!values['dry-run']) writeLock(root, lock);
    }
    return;
  }
  const LABEL = {
    update: c.green('update   '), add: c.green('add      '), merge: c.cyan('merge    '), delete: c.yellow('delete   '),
    conflict: c.red('conflict '), 'conflict-new': c.red('conflict '), manual: c.yellow('review   '),
    'keep-removed': c.dim('kept     '), 'skip-deleted': c.dim('skipped  '),
  };
  for (const p of changes) out(`  ${LABEL[p.action]} ${p.rel}${p.action === 'manual' ? c.dim('  (no base to merge from: new version written to .calm-new)') : ''}`);
  out('');
  if (!baseDir) warn(`Could not get calmapi@${from} to merge against; edited files get a .calm-new copy instead.`);
  if (values['dry-run']) return info('Dry run: nothing was written.');
  if (!values.yes && !(await confirm('Apply?'))) return info('Cancelled.');

  for (const p of changes) {
    const path = join(root, p.rel);
    if (['update', 'add', 'merge', 'conflict'].includes(p.action)) writeFile(path, p.content);
    if (p.action === 'delete') unlinkSync(path);
    if (p.action === 'manual' || p.action === 'conflict-new') writeFile(`${path}.calm-new`, p.content);
  }

  lock.calmapi = PKG.version;
  lock.core = Object.fromEntries(Object.entries(next).map(([rel, content]) => [rel, sha256(content)]));
  writeLock(root, lock);

  const conflicts = changes.filter((p) => p.action === 'conflict');
  const manual = changes.filter((p) => p.action === 'manual' || p.action === 'conflict-new');
  ok(`calm/ upgraded to ${PKG.version}`);
  if (conflicts.length) warn(`Resolve conflict markers in: ${conflicts.map((p) => p.rel).join(', ')}`);
  if (manual.length) warn(`Compare and merge by hand: ${manual.map((p) => `${p.rel}.calm-new`).join(', ')}`);
  info('Run `npx calm doctor` and your tests.');
}

/** git merge-file based 3-way merge. */
export async function merge3(mine, base, theirs) {
  const dir = mkdtempSync(join(tmpdir(), 'calm-merge-'));
  try {
    const [a, o, b] = ['mine', 'base', 'theirs'].map((n) => join(dir, n));
    writeFileSync(a, mine);
    writeFileSync(o, base);
    writeFileSync(b, theirs);
    const res = await capture('git', ['merge-file', '-p', '-L', 'yours', '-L', 'original', '-L', `calmapi@${PKG.version}`, a, o, b]);
    if (res.code < 0 || res.code > 127) throw new Error(`git merge-file failed: ${res.stderr}`);
    return { text: res.stdout, conflicts: res.code };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Fetch calm/ as shipped in calmapi@version (npm pack, cached in ~/.calm/cache). */
async function baseCore(version) {
  if (!version) return null;
  if (version === PKG.version) return CORE_DIR;
  const cache = join(homedir(), '.calm', 'cache', `calmapi-${version}`);
  if (isDir(join(cache, 'package', 'core'))) return join(cache, 'package', 'core');
  mkdirSync(cache, { recursive: true });
  const packed = await capture('npm', ['pack', `calmapi@${version}`, '--silent', '--pack-destination', cache]).catch(() => null);
  const tgz = packed?.code === 0 ? packed.stdout.trim().split('\n').pop() : null;
  if (!tgz) return null;
  const untar = await capture('tar', ['-xzf', join(cache, tgz), '-C', cache]);
  return untar.code === 0 && isDir(join(cache, 'package', 'core')) ? join(cache, 'package', 'core') : null;
}
