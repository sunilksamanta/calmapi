// Blocks as files: turn a block folder into a registry item (shadcn registry-item JSON), check
// it before it is shared, and review what a third-party block's code does before it is added.
//
// A block you write lives in your project like any other:
//   app/blocks/<name>/index.js      export default definePlugin({ name, setup(calm) { ... } })
//   app/blocks/<name>/block.json    what `calm block pack` needs to share it (title, version...)
//   app/blocks/<name>/...           any other file it needs
// block.json "files" can list extra paths outside the folder (app/jobs/digest.js, a resource...).

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, readText, walk, isDir } from './files.js';

export const ITEM_SCHEMA = 'https://ui.shadcn.com/schema/registry-item.json';
const SKIP = new Set(['block.json', 'docs.md', '.DS_Store']);

/** Registry item from block metadata and files ([{ target, content }]). */
export function toRegistryItem(meta, files, { pathFor = (f) => f.target } = {}) {
  return {
    $schema: ITEM_SCHEMA,
    name: meta.name,
    type: 'registry:item',
    title: meta.title ?? meta.name,
    description: meta.description ?? '',
    version: meta.version ?? '0.1.0',
    author: meta.author ?? undefined,
    homepage: meta.homepage ?? undefined,
    license: meta.license ?? undefined,
    categories: meta.categories ?? [],
    dependencies: meta.dependencies ?? [],
    devDependencies: meta.devDependencies ?? [],
    registryDependencies: meta.registryDependencies ?? [],
    envVars: meta.envVars ?? {},
    docs: meta.docs ?? '',
    meta: { calmapi: { minVersion: meta.minVersion ?? '2.0.0-alpha.0', conflicts: meta.conflicts ?? [] } },
    files: files.map((f) => ({ path: pathFor(f), type: 'registry:file', target: f.target, content: f.content })),
  };
}

/** Read a block written in this project: app/blocks/<name>/ plus block.json "files". */
export function readProjectBlock(root, name) {
  const dir = join(root, 'app', 'blocks', name);
  if (!isDir(dir)) throw new Error(`app/blocks/${name}/ does not exist. Create it with \`calm make block ${name}\`.`);
  if (!existsSync(join(dir, 'index.js'))) throw new Error(`app/blocks/${name}/index.js is missing`);
  const meta = { name, ...(readJson(join(dir, 'block.json')) ?? {}) };
  const files = [];
  for (const rel of walk(dir, { ignore: ['node_modules'] })) {
    if (SKIP.has(rel)) continue;
    files.push({ target: `app/blocks/${name}/${rel}`, content: readText(join(dir, rel)) });
  }
  for (const extra of meta.files ?? []) {
    const path = join(root, extra);
    if (!existsSync(path)) throw new Error(`block.json lists ${extra}, which does not exist`);
    const list = isDir(path) ? walk(path).map((rel) => `${extra.replace(/\/$/, '')}/${rel}`) : [extra];
    for (const target of list) if (!files.some((f) => f.target === target)) files.push({ target, content: readText(join(root, target)) });
  }
  return { meta, files, hasMeta: existsSync(join(dir, 'block.json')), docs: existsSync(join(dir, 'docs.md')) ? readText(join(dir, 'docs.md')) : null };
}

// ---- checks ---------------------------------------------------------------------------

const SEMVER = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** Problems with a registry item: [{ level: 'error' | 'warn' | 'info', message }]. */
export function checkItem(item) {
  const out = [];
  const add = (level, message) => out.push({ level, message });
  if (!/^[a-z][a-z0-9-]*$/.test(item.name ?? '')) add('error', `name "${item.name}" must be lowercase letters, digits and dashes`);
  if (!SEMVER.test(item.version ?? '')) add('error', `version "${item.version}" is not semver (1.0.0)`);
  if (!item.description) add('warn', 'no description: people choose blocks by it');
  if (!item.docs) add('warn', 'no docs: `calm add` prints them right after installing (what to set, what to call)');
  if (!Array.isArray(item.files) || !item.files.length) add('error', 'no files');
  const index = item.files?.find((f) => f.target === `app/blocks/${item.name}/index.js`);
  if (!index) add('error', `app/blocks/${item.name}/index.js is missing: the loader only picks up blocks with an index.js`);
  else {
    if (!/definePlugin\s*\(/.test(index.content)) add('error', 'index.js must export default definePlugin({ ... })');
    const declared = [...index.content.matchAll(/^\s+([A-Z][A-Z0-9_]+)\s*:/gm)].map((m) => m[1]);
    for (const key of Object.keys(item.envVars ?? {})) {
      if (!index.content.includes(key)) add('warn', `envVars lists ${key} but index.js never mentions it`);
      else if (!/env\s*:\s*\{/.test(index.content) || !declared.includes(key)) add('info', `declare ${key} in definePlugin({ env }) so calm doctor can report it when missing`);
    }
  }
  for (const f of item.files ?? []) {
    const target = f.target ?? f.path ?? '';
    if (!target || target.startsWith('/') || target.split('/').includes('..')) add('error', `unsafe file target "${target}"`);
    else if (target === 'calm.lock' || target.startsWith('calm/')) add('error', `${target}: blocks cannot overwrite framework files`);
    else if (/^(\.env|package\.json|package-lock\.json)$/.test(target)) add('error', `${target}: use envVars and dependencies instead of shipping this file`);
    else if (!/^(app|test|scripts|public)\//.test(target)) add('warn', `${target}: files usually live in app/, test/, scripts/ or public/`);
    if (typeof f.content === 'string' && f.content.length > 200_000) add('warn', `${target} is ${Math.round(f.content.length / 1000)} KB: blocks are read by people, keep files small`);
  }
  for (const spec of [...(item.dependencies ?? []), ...(item.devDependencies ?? [])]) {
    const at = spec.lastIndexOf('@');
    if (at <= 0 || spec.slice(at + 1) === 'latest' || spec.slice(at + 1) === '*') add('warn', `dependency ${spec} has no version range: pin one (${spec.replace(/@.*$/, '')}@^1.2.3)`);
  }
  const min = item.meta?.calmapi?.minVersion;
  if (min && !SEMVER.test(min)) add('error', `minVersion "${min}" is not semver`);
  for (const r of review(item.files ?? [])) {
    if (r.risk === 'high') add('warn', `${r.file}:${r.line} ${r.what}`);
    if (r.kind === 'secret') add('error', `${r.file}:${r.line} ${r.what}`);
  }
  return out;
}

// ---- review: what does this code do? ----------------------------------------------------

const PATTERNS = [
  { kind: 'shell', risk: 'high', re: /\b(?:from\s+['"](?:node:)?child_process['"]|require\(\s*['"](?:node:)?child_process['"]\s*\))/, what: 'runs other programs (child_process)' },
  { kind: 'eval', risk: 'high', re: /\beval\s*\(|\bnew\s+Function\s*\(/, what: 'evaluates code built at runtime (eval or new Function)' },
  { kind: 'vm', risk: 'high', re: /from\s+['"](?:node:)?vm['"]/, what: 'runs code in a VM context (node:vm)' },
  { kind: 'dynamic-import', risk: 'high', re: /\bimport\s*\(\s*[^'"`\s]/, what: 'imports code from a computed path' },
  { kind: 'native', risk: 'high', re: /process\.dlopen|\.node['"]\s*\)/, what: 'loads native code' },
  { kind: 'network', risk: 'info', re: /\bfetch\s*\(|from\s+['"](?:node:)?(?:https?|net|tls|dgram)['"]/, what: 'makes network requests' },
  { kind: 'files', risk: 'info', re: /\b(?:writeFile|appendFile|rm|rmSync|unlink|unlinkSync|rename|mkdir)(?:Sync)?\s*\(/, what: 'writes or deletes files' },
  { kind: 'listen', risk: 'info', re: /\.listen\s*\(/, what: 'opens a network port' },
  { kind: 'requests', risk: 'info', re: /calm\.(?:use|guard|authenticate)\s*\(/, what: 'sees every request (middleware, guard or authenticator)' },
  { kind: 'login', risk: 'info', re: /calm\.loginChallenge\s*\(/, what: 'takes part in sign-in' },
];
const SECRET = /(?:sk_live_[0-9a-zA-Z]{16,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----|ghp_[0-9A-Za-z]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|AIza[0-9A-Za-z_-]{35})/;

/**
 * Plain-language summary of what block files do, for people deciding whether to add a
 * block from someone else. [{ file, line, kind, risk, what }]
 */
export function review(files) {
  const found = [];
  for (const f of files) {
    const target = f.target ?? f.path;
    if (!/\.(m?js|cjs|ts)$/.test(target ?? '')) continue;
    const lines = String(f.content ?? '').split('\n');
    const seen = new Set();
    lines.forEach((line, i) => {
      if (/^\s*(\/\/|\*)/.test(line)) return;
      for (const p of PATTERNS) {
        if (seen.has(p.kind) || !p.re.test(line)) continue;
        seen.add(p.kind);
        found.push({ file: target, line: i + 1, kind: p.kind, risk: p.risk, what: p.what });
      }
      if (line.length > 400 && !seen.has('minified')) {
        seen.add('minified');
        found.push({ file: target, line: i + 1, kind: 'minified', risk: 'high', what: `a ${line.length}-character line: minified or obfuscated code cannot be reviewed` });
      }
      if (SECRET.test(line)) found.push({ file: target, line: i + 1, kind: 'secret', risk: 'high', what: 'contains what looks like a real secret key' });
    });
    // Env vars and hosts from code only: commented examples do not count.
    const code = String(f.content ?? '').replace(/\/\*[\s\S]*?\*\//g, '').split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
    const env = [...new Set([...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)|process\.env\[['"]([A-Z][A-Z0-9_]*)['"]\]|calm\.env\(\s*['"]([A-Z][A-Z0-9_]*)['"]/g)].map((m) => m[1] ?? m[2] ?? m[3]))];
    if (env.length) found.push({ file: target, line: 0, kind: 'env', risk: 'info', what: `reads ${env.join(', ')}` });
    const hosts = [...new Set([...code.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)].map((m) => m[1].toLowerCase()))].filter((h) => !/^(example\.(com|org)|localhost)$/.test(h));
    if (hosts.length) found.push({ file: target, line: 0, kind: 'hosts', risk: 'info', what: `mentions ${hosts.slice(0, 6).join(', ')}${hosts.length > 6 ? '...' : ''}` });
  }
  return found;
}
