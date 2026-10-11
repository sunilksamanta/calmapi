import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireProject } from '../lib/project.js';
import { walk } from '../lib/files.js';
import { appendActivity, readActivity, lineDiff } from '../lib/activity.js';
import { c, out } from '../lib/ui.js';

export const help = `
${c.bold('calm dev')}

  Start the app in development mode: NODE_ENV=development, file watching
  (app/, calm/, calm.config.js, server.js, .env) and devtools at
  http://localhost:<port>/_calm. Extra arguments are passed to node.

  Every file change (with its diff), restart and crash is recorded in
  .calm/activity.jsonl, so devtools can show what you or your AI agent changed.
`;

const TEXT = /\.(m?js|cjs|ts|json|md|txt|ya?ml|html|css)$/;
const MAX_SNAPSHOT = 256 * 1024;
const AGENT_WINDOW_MS = 20_000;

export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return out(help);
  const root = requireProject();
  const watched = ['app', 'calm', 'calm.config.js', 'server.js', '.env'].filter((p) => existsSync(join(root, p)));

  // ---- the app, restarted by node --watch -------------------------------------------
  const color = process.stdout.isTTY && !process.env.NO_COLOR ? { FORCE_COLOR: process.env.FORCE_COLOR ?? '1' } : {};
  const child = spawn(
    process.execPath,
    [...watched.map((p) => `--watch-path=${join(root, p)}`), '--watch-preserve-output', ...argv, join(root, 'server.js')],
    { cwd: root, stdio: ['inherit', 'pipe', 'pipe'], env: { ...process.env, ...color, NODE_ENV: process.env.NODE_ENV || 'development' } },
  );

  let errBuffer = [];
  let crashTimer = null;
  child.stdout.on('data', (chunk) => {
    process.stdout.write(chunk);
    const text = chunk.toString();
    if (/Restarting '/.test(text)) appendActivity(root, { type: 'restart' });
    if (/MongoDB connected/.test(text)) appendActivity(root, { type: 'ready' });
  });
  child.stderr.on('data', (chunk) => {
    process.stderr.write(chunk);
    errBuffer.push(...chunk.toString().split('\n'));
    errBuffer = errBuffer.slice(-60);
    if (/Failed running|SyntaxError|ReferenceError|TypeError|Error \[ERR_|Cannot find module|Invalid configuration/.test(chunk.toString())) {
      clearTimeout(crashTimer);
      crashTimer = setTimeout(() => {
        const text = errBuffer.join('\n').replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-30).join('\n');
        appendActivity(root, { type: 'crash', text });
        errBuffer = [];
      }, 300);
    }
  });

  // ---- file change recorder ---------------------------------------------------------------
  const snapshots = new Map();
  const readText = (rel) => {
    try {
      const st = statSync(join(root, rel));
      if (!st.isFile()) return undefined;
      if (st.size > MAX_SNAPSHOT || !TEXT.test(rel)) return null;
      return readFileSync(join(root, rel), 'utf8');
    } catch {
      return undefined; // deleted
    }
  };
  for (const dir of ['app', 'calm']) for (const rel of walk(join(root, dir))) snapshots.set(`${dir}/${rel}`, readText(`${dir}/${rel}`));
  for (const f of ['calm.config.js', 'server.js']) if (existsSync(join(root, f))) snapshots.set(f, readText(f));

  const lastAgent = () => {
    const recent = readActivity(root, 30).reverse().find((e) => e.type === 'agent');
    return recent && Date.now() - Date.parse(recent.time) < AGENT_WINDOW_MS ? recent.client : null;
  };

  const timers = new Map();
  const onChange = (rel) => {
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => record(rel), 150));
  };
  const record = (rel) => {
    const agent = lastAgent();
    const actor = agent ? { kind: 'agent', name: agent } : { kind: 'human', name: process.env.USER || 'you' };
    if (rel === '.env') return appendActivity(root, { type: 'file', path: rel, change: 'modified', actor, diff: null, note: 'contents not recorded (secrets)' });
    const before = snapshots.get(rel);
    const after = readText(rel);
    if (before === after) return;
    const change = after === undefined ? 'deleted' : before === undefined ? 'added' : 'modified';
    if (after === undefined) snapshots.delete(rel);
    else snapshots.set(rel, after);
    const diff = typeof before === 'string' || typeof after === 'string' ? lineDiff(before ?? '', after ?? '') : null;
    appendActivity(root, { type: 'file', path: rel, change, actor, diff });
  };

  const watchers = [];
  for (const target of watched) {
    const abs = join(root, target);
    const isDir = statSync(abs).isDirectory();
    try {
      watchers.push(
        watch(abs, { recursive: isDir }, (_ev, filename) => {
          if (!filename) return;
          const rel = isDir ? `${target}/${String(filename).split(sep).join('/')}` : target;
          if (rel.includes('node_modules') || rel.split('/').some((p) => p.startsWith('.') && p !== '.env')) return;
          onChange(isDir ? rel : relative(root, abs).split(sep).join('/'));
        }),
      );
    } catch {
      // recursive watch unsupported: restarts still work, the activity log just has fewer details
    }
  }
  appendActivity(root, { type: 'session', note: 'calm dev started' });

  const stop = (signal) => {
    for (const w of watchers) w.close();
    child.kill(signal);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise((resolve) => child.on('exit', resolve));
  for (const w of watchers) w.close();
}
