// Build registry/r/*.json (shadcn registry-item format) from registry/blocks/<name>/.
//
//   registry/blocks/<name>/block.json   metadata (no file contents)
//   registry/blocks/<name>/files/...    files, mirrored to the same path in the project
//
// Output is bundled with the CLI and published to https://calmapi.dev/r/<name>.json

import { readdirSync, readFileSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  const meta = JSON.parse(readFileSync(join(dir, 'block.json'), 'utf8'));
  if (meta.name !== name) throw new Error(`registry/blocks/${name}/block.json: name must be "${name}"`);
  const filesDir = join(dir, 'files');
  const files = existsSync(filesDir)
    ? walk(filesDir).sort().map((file) => {
        const target = relative(filesDir, file).split(sep).join('/');
        return { path: `registry/blocks/${name}/files/${target}`, type: 'registry:file', target, content: readFileSync(file, 'utf8') };
      })
    : [];
  const item = {
    $schema: 'https://ui.shadcn.com/schema/registry-item.json',
    name,
    type: 'registry:item',
    title: meta.title,
    description: meta.description,
    version: meta.version,
    author: meta.author ?? 'CalmAPI',
    categories: meta.categories ?? [],
    dependencies: meta.dependencies ?? [],
    devDependencies: meta.devDependencies ?? [],
    registryDependencies: meta.registryDependencies ?? [],
    envVars: meta.envVars ?? {},
    docs: meta.docs ?? '',
    meta: { calmapi: { minVersion: meta.minVersion ?? '2.0.0-alpha.0', conflicts: meta.conflicts ?? [] } },
    files,
  };
  writeFileSync(join(OUT, `${name}.json`), `${JSON.stringify(item, null, 2)}\n`);
  index.push({ name, title: meta.title, description: meta.description, version: meta.version, categories: item.categories });
}

writeFileSync(
  join(OUT, 'index.json'),
  `${JSON.stringify({ $schema: 'https://ui.shadcn.com/schema/registry.json', name: 'calmapi', homepage: 'https://calmapi.dev', items: index }, null, 2)}\n`,
);
process.stderr.write(`registry: built ${index.length} blocks -> ${relative(ROOT, OUT)}\n`);
