// Project activity log: .calm/activity.jsonl
//
// `calm dev` writes file changes (with diffs), restarts and crashes; `calm mcp` writes
// every tool call an AI agent makes. Devtools streams the file live, so a human can
// watch an agent work, and agents can read it back (calm_activity) to see what broke.

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BYTES = 4 * 1024 * 1024;

export const activityFile = (root) => join(root, '.calm', 'activity.jsonl');

export function appendActivity(root, event) {
  const file = activityFile(root);
  mkdirSync(join(root, '.calm'), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  try {
    if (statSync(file).size > MAX_BYTES) {
      const lines = readFileSync(file, 'utf8').trimEnd().split('\n');
      writeFileSync(file, `${lines.slice(-2000).join('\n')}\n`);
    }
  } catch {
    // best effort
  }
}

export function readActivity(root, limit = 100) {
  const file = activityFile(root);
  if (!existsSync(file)) return [];
  const lines = readFileSync(file, 'utf8').trimEnd().split('\n').filter(Boolean);
  return lines.slice(-limit).map((l) => {
    try {
      return JSON.parse(l);
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Minimal line diff (LCS) as unified-style hunks with 2 lines of context.
 * Good enough for source files; capped so huge rewrites stay readable.
 */
export function lineDiff(before, after, { context = 2, maxLines = 160 } = {}) {
  // A final newline ends the last line; it is not an empty line of its own.
  const split = (text) => (text ? text.replace(/\n$/, '').split('\n') : []);
  const a = split(before);
  const b = split(after);
  if (a.length * b.length > 4_000_000) return { added: b.length, removed: a.length, hunks: [], truncated: true };
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push([' ', a[i], i + 1, j + 1]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push(['-', a[i], ++i, null]);
    else ops.push(['+', b[j], null, ++j]);
  }
  while (i < n) ops.push(['-', a[i], ++i, null]);
  while (j < m) ops.push(['+', b[j], null, ++j]);

  const added = ops.filter((o) => o[0] === '+').length;
  const removed = ops.filter((o) => o[0] === '-').length;
  const keep = new Set();
  ops.forEach((o, k) => {
    if (o[0] === ' ') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep.add(x);
  });
  const hunks = [];
  let current = null;
  let lines = 0;
  let truncated = false;
  ops.forEach((o, k) => {
    if (!keep.has(k)) {
      current = null;
      return;
    }
    if (lines >= maxLines) {
      truncated = true;
      return;
    }
    if (!current) {
      current = { oldStart: o[2] ?? (ops.slice(0, k).reverse().find((p) => p[2])?.[2] ?? 0) + 1, newStart: o[3] ?? 1, lines: [] };
      hunks.push(current);
    }
    current.lines.push(`${o[0]}${o[1]}`);
    lines++;
  });
  return { added, removed, hunks, truncated };
}
