import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { readJson, writeJson } from './files.js';

/** Walk up from `from` to the folder containing calm.lock. */
export function findProjectRoot(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'calm.lock'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A CalmAPI 1.x project (has calmapi.json, no calm.lock). */
export function findV1Root(from = process.cwd()) {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, 'calmapi.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function requireProject() {
  const root = findProjectRoot();
  if (!root) {
    const v1 = findV1Root();
    const err = new Error(
      v1
        ? 'This is a CalmAPI 1.x project. Run `npx calmapi@next doctor` for security advisories, and see the migration guide: https://calmapi.dev/docs/migrate-v1'
        : 'Not inside a CalmAPI project (no calm.lock found). Create one with `npm create calmapi@latest`.',
    );
    err.code = 'CALM_NO_PROJECT';
    throw err;
  }
  return root;
}

export const readLock = (root) => readJson(join(root, 'calm.lock'));
export const writeLock = (root, lock) => writeJson(join(root, 'calm.lock'), lock);

export function detectPackageManager(root) {
  const ua = process.env.npm_config_user_agent ?? '';
  if (existsSync(join(root, 'pnpm-lock.yaml')) || ua.startsWith('pnpm')) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock')) || ua.startsWith('yarn')) return 'yarn';
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb')) || ua.startsWith('bun')) return 'bun';
  return 'npm';
}

/** Run a command, inheriting stdio. Resolves with the exit code. */
export function run(cmd, args, { cwd, env, stdio = 'inherit' } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio, shell: process.platform === 'win32' });
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise(code ?? 1));
  });
}

/** Merge env overrides; a key set to undefined is removed. */
const mergeEnv = (extra = {}) => {
  const out = { ...process.env, ...extra };
  for (const [k, v] of Object.entries(out)) if (v === undefined) delete out[k];
  return out;
};

/** Run a command and capture stdout/stderr. */
export function capture(cmd, args, { cwd, env, input } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, env: mergeEnv(env), shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', reject);
    child.on('exit', (code) => resolvePromise({ code: code ?? 1, stdout, stderr }));
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}
