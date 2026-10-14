import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject } from '../helpers.js';

// MONGODB_TEST_URI can live in the project's .env (an Atlas user puts it there): createTestApp
// reads it before choosing the server. A child process, so this run's environment does not leak in.
test('createTestApp takes MONGODB_TEST_URI from .env when the environment has none', async () => {
  const project = await makeProject();
  try {
    const server = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
    const url = new URL(server);
    url.searchParams.set('appName', 'from-dotenv');
    writeFileSync(join(project.dir, '.env'), `MONGODB_TEST_URI=${url}\n`);
    const script = `
      const { createTestApp } = await import('./calm/testing.js');
      const t = await createTestApp({ root: process.cwd() });
      process.stdout.write(t.app.config.db.uri);
      await t.close();
    `;
    const env = { ...process.env };
    delete env.MONGODB_TEST_URI;
    const uri = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: project.dir, env, encoding: 'utf8' });
    assert.match(uri, /appName=from-dotenv/);
    assert.match(uri, /\/calm_test_/, 'still a throwaway database');
  } finally {
    project.cleanup();
  }
});
