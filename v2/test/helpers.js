import { mkdtempSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { scaffold } from '../src/cli/lib/scaffold.js';
import { writeFile } from '../src/cli/lib/files.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Scaffold a throwaway project (with extra files) and return helpers bound to it.
 * node_modules is symlinked from the repo, so no install is needed.
 */
export async function makeProject({ template = 'api', files = {} } = {}) {
  const dir = mkdtempSync(join(process.env.CALM_TEST_TMP ?? tmpdir(), 'calm-'));
  rmSync(dir, { recursive: true, force: true });
  scaffold({ dir, name: 'fixture-app', template });
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  for (const [rel, content] of Object.entries(files)) writeFile(join(dir, rel), content);
  const load = (rel) => import(pathToFileURL(join(dir, rel)).href);
  return {
    dir,
    load,
    async testApp(config) {
      const { createTestApp } = await load('calm/testing.js');
      return createTestApp({ root: dir, config });
    },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
