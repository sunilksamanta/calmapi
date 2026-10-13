// Proposals: a change an agent describes instead of making (calm_propose), stored in
// .calm/proposals/<id>.json with a diff against the current file. The developer reviews
// and applies it from devtools Activity, which records the write as its own.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { appendActivity, lineDiff } from './activity.js';

const MAX_FILES = 20;
const MAX_CONTENT = 512 * 1024;

export const proposalsDir = (root) => join(root, '.calm', 'proposals');

/** A path inside the project, as posix, never node_modules or .git. */
export function projectPath(root, path) {
  if (typeof path !== 'string' || !path.trim()) throw new Error('Each file needs a path');
  const rel = relative(root, resolve(root, path)).split(sep).join('/');
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error(`${path}: outside the project`);
  if (rel.split('/').some((seg) => seg === 'node_modules' || seg === '.git')) throw new Error(`${path}: node_modules and .git cannot be changed`);
  return rel;
}

export function writeProposal(root, { title, reason, files, client = 'agent' }) {
  if (typeof title !== 'string' || !title.trim()) throw new Error('A proposal needs a title');
  if (!Array.isArray(files) || !files.length) throw new Error('A proposal needs at least one file: [{ path, content }]');
  if (files.length > MAX_FILES) throw new Error(`At most ${MAX_FILES} files per proposal`);
  const entries = files.map((f) => {
    const path = projectPath(root, f?.path);
    if (typeof f.content !== 'string') throw new Error(`${path}: content must be a string (the whole file)`);
    if (f.content.length > MAX_CONTENT) throw new Error(`${path}: content is too large`);
    const current = existsSync(join(root, path)) ? readFileSync(join(root, path), 'utf8') : '';
    return { path, diff: lineDiff(current, f.content), content: f.content };
  });
  const id = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const proposal = { id, title: title.trim().slice(0, 200), reason: typeof reason === 'string' ? reason.trim().slice(0, 2000) : '', client, createdAt: new Date().toISOString(), files: entries };
  mkdirSync(proposalsDir(root), { recursive: true });
  writeFileSync(join(proposalsDir(root), `${id}.json`), `${JSON.stringify(proposal, null, 2)}\n`);
  appendActivity(root, { type: 'proposal', id, title: proposal.title, client, files: entries.map((f) => f.path) });
  return proposal;
}
