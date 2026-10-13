// Build registry/r/*.json (shadcn registry-item format) from registry/blocks/<name>/.
//
//   registry/blocks/<name>/block.json   metadata (no file contents)
//   registry/blocks/<name>/files/...    files, mirrored to the same path in the project
//
// Output is bundled with the CLI and published to https://docs.calmapi.dev/r/<name>.json

import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toRegistryItem, blockGuide, cleanLinks, GUIDE_FILE } from '../src/cli/lib/blocks.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'registry', 'blocks');
const OUT = join(ROOT, 'registry', 'r');

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]));

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const index = [];
for (const name of readdirSync(SRC).sort()) {
  const dir = join(SRC, name);
  if (!existsSync(join(dir, 'block.json'))) {
    process.stderr.write(`registry: skipped registry/blocks/${name} (no block.json yet)\n`);
    continue;
  }
  const meta = JSON.parse(readFileSync(join(dir, 'block.json'), 'utf8'));
  if (meta.name !== name) throw new Error(`registry/blocks/${name}/block.json: name must be "${name}"`);
  const filesDir = join(dir, 'files');
  const files = existsSync(filesDir)
    ? walk(filesDir).sort().map((file) => {
        const target = relative(filesDir, file).split(sep).join('/');
        return { path: `registry/blocks/${name}/files/${target}`, type: 'registry:file', target, content: readFileSync(file, 'utf8') };
      })
    : [];
  // Every block ships app/blocks/<name>/AGENTS.md, built from block.json unless the block
  // brings its own: instructions for AI agents and the official documentation, next to the code.
  const guideTarget = `app/blocks/${name}/${GUIDE_FILE}`;
  if (!files.some((f) => f.target === guideTarget)) {
    files.push({ path: `registry/blocks/${name}/block.json`, type: 'registry:file', target: guideTarget, content: blockGuide(meta, { official: true }) });
  }
  const item = toRegistryItem({ author: 'CalmAPI', ...meta }, files.map((f) => ({ target: f.target, content: f.content })), { pathFor: (f) => `registry/blocks/${name}/files/${f.target}` });
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(item, null, 2)}\n`);
  index.push({ name, title: meta.title, description: meta.description, version: meta.version, categories: item.categories, links: cleanLinks(meta.links) });
}

writeFileSync(
  join(OUT, 'index.json'),
  `${JSON.stringify({ $schema: 'https://ui.shadcn.com/schema/registry.json', name: 'calmapi', homepage: 'https://docs.calmapi.dev/blocks', items: index }, null, 2)}\n`,
);
process.stderr.write(`registry: built ${index.length} blocks -> ${relative(ROOT, OUT)}\n`);
