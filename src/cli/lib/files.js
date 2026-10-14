import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Root of the calmapi package (where core/, templates/, registry/ live). */
export const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const PKG = JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8'));

export const sha256 = (content) => `sha256:${createHash('sha256').update(content).digest('hex')}`;
export const toPosix = (p) => p.split(sep).join('/');

/** All files under dir, as posix paths relative to dir. */
export function walk(dir, { ignore = [] } = {}) {
  const out = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name);
      const rel = toPosix(relative(dir, full));
      if (ignore.some((pattern) => rel === pattern || rel.startsWith(`${pattern}/`))) continue;
      if (entry.isDirectory()) visit(full);
      else out.push(rel);
    }
  };
  if (existsSync(dir)) visit(dir);
  return out.sort();
}

export function writeFile(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

export const readText = (file) => readFileSync(file, 'utf8');
export const isDir = (p) => existsSync(p) && statSync(p).isDirectory();

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export const writeJson = (file, data) => writeFile(file, `${JSON.stringify(data, null, 2)}\n`);

/** Replace {{key}} placeholders. */
export const render = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (m, key) => (key in vars ? vars[key] : m));
