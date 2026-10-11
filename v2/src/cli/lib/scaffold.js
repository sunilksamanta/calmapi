import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PKG, PKG_ROOT, walk, writeFile, readText, render, sha256, writeJson } from './files.js';
import { humanize } from './strings.js';

const RENAME = { gitignore: '.gitignore', dockerignore: '.dockerignore', 'env.example': '.env.example' };
export const TEMPLATES = ['api', 'minimal'];
export const CORE_DIR = join(PKG_ROOT, 'core');

/** Files of the owned core, as { 'calm/app.js': content }. */
export function coreFiles() {
  const out = {};
  for (const rel of walk(CORE_DIR)) out[`calm/${rel}`] = readText(join(CORE_DIR, rel));
  return out;
}

/**
 * Create a new project. Pure file work: no install, no git (the command does those).
 * @returns {{ files: string[] }}
 */
export function scaffold({ dir, name, template = 'api', mongoUri, calmVersion = PKG.version }) {
  if (!TEMPLATES.includes(template)) throw new Error(`Unknown template "${template}". Available: ${TEMPLATES.join(', ')}`);
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} already exists and is not empty`);

  const vars = {
    name,
    title: humanize(name),
    mongoUri: mongoUri ?? `mongodb://127.0.0.1:27017/${name.replace(/[^\w-]/g, '_')}`,
    calmVersion,
  };
  const files = [];
  const put = (rel, content) => {
    writeFile(join(dir, rel), content);
    files.push(rel);
  };

  for (const source of ['shared', template]) {
    const base = join(PKG_ROOT, 'templates', source);
    for (const rel of walk(base)) {
      const target = RENAME[rel] ?? rel;
      if (target.endsWith('.gitkeep')) {
        put(target, '');
        continue;
      }
      put(target, render(readText(join(base, rel)), vars));
    }
  }
  put('.env', render(readText(join(PKG_ROOT, 'templates', 'shared', 'env.example')), vars));

  const core = coreFiles();
  for (const [rel, content] of Object.entries(core)) put(rel, content);

  writeJson(join(dir, 'calm.lock'), {
    lockfileVersion: 1,
    calmapi: calmVersion,
    template,
    core: Object.fromEntries(Object.entries(core).map(([rel, content]) => [rel, sha256(content)])),
    blocks: {},
  });
  files.push('calm.lock');
  return { files };
}
