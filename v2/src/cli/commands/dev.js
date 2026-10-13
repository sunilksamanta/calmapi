import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync, watch } from 'node:fs';
import { join, sep } from 'node:path';
import { requireProject } from '../lib/project.js';
import { walk } from '../lib/files.js';
import { appendActivity, readActivity, lineDiff } from '../lib/activity.js';
import { protectionReason } from '../lib/protected.js';
import { attribute, detectAgentEnv } from '../lib/attribution.js';
import { readAgentSession, DEFAULT_PROTECTED } from '../lib/agent-scope.js';
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
// Recorded in Activity (with diffs) but not watched for restarts: tests and project files an
// agent may edit too. Folders are recursive; files are at the project root.
const RECORDED_DIRS = ['app', 'calm', 'test'];
const RECORDED_FILES = new Set(['calm.config.js', 'server.js', '.env', '.env.example', 'package.json', 'calm.lock', 'README.md', 'AGENTS.md', 'CLAUDE.md', 'Dockerfile', 'eslint.config.js']);
const MAX_SNAPSHOT = 256 * 1024;

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
  for (const dir of RECORDED_DIRS) for (const rel of walk(join(root, dir), { ignore: ['node_modules'] })) snapshots.set(`${dir}/${rel}`, readText(`${dir}/${rel}`));
  for (const f of RECORDED_FILES) if (f !== '.env' && existsSync(join(root, f))) snapshots.set(f, readText(f));

  // Started from an agent's shell (Claude Code sets CLAUDECODE=1): the weakest signal.
  const envAgent = detectAgentEnv(process.env);
  const whoChanged = (rel) => attribute(rel, readActivity(root, 60), { envAgent });
  // Devtools applied a proposal: it wrote the file and recorded the change itself.
  const appliedFromDevtools = (rel) => readActivity(root, 10).some((e) => e.type === 'file' && e.path === rel && e.actor?.name === 'devtools' && Date.now() - Date.parse(e.time) < 3000);
  // Agent edits to protected paths and access rules get a flag the human can see.
  const guard = (event) => {
    if (event.actor.kind !== 'agent') return event;
    const session = readAgentSession(root) ?? {};
    const reason = protectionReason(event.path, event.diff, { protected: session.protected ?? DEFAULT_PROTECTED, allow: session.allow ?? [] });
    return { ...event, ...(reason ? { protected: true, reason } : {}), ...(session.scope ? { scope: session.scope } : {}) };
  };

  const timers = new Map();
  const onChange = (rel) => {
    clearTimeout(timers.get(rel));
    timers.set(rel, setTimeout(() => record(rel), 150));
  };
  const record = (rel) => {
    const agent = whoChanged(rel);
    const actor = agent ? { kind: 'agent', name: agent.name } : { kind: 'human', name: process.env.USER || 'you' };
    const via = agent?.via ?? null;
    if (rel === '.env') return appendActivity(root, guard({ type: 'file', path: rel, change: 'modified', actor, diff: null, note: 'contents not recorded (secrets)', ...(via ? { via } : {}) }));
    const before = snapshots.get(rel);
    const after = readText(rel);
    if (before === after) return;
    const change = after === undefined ? 'deleted' : before === undefined ? 'added' : 'modified';
    if (after === undefined) snapshots.delete(rel);
    else snapshots.set(rel, after);
    if (appliedFromDevtools(rel)) return;
    const diff = typeof before === 'string' || typeof after === 'string' ? lineDiff(before ?? '', after ?? '') : null;
    appendActivity(root, guard({ type: 'file', path: rel, change, actor, diff, ...(via ? { via } : {}) }));
  };

  const watchers = [];
  const safeWatch = (abs, recursive, fn) => {
    try {
      watchers.push(watch(abs, { recursive }, (_ev, filename) => filename && fn(String(filename).split(sep).join('/'))));
    } catch {
      // recursive watch unsupported: restarts still work, the activity log just has fewer details
    }
  };
  for (const dir of RECORDED_DIRS) {
    if (!existsSync(join(root, dir))) continue;
    safeWatch(join(root, dir), true, (name) => {
      const rel = `${dir}/${name}`;
      if (rel.includes('node_modules') || rel.split('/').some((p) => p.startsWith('.'))) return;
      onChange(rel);
    });
  }
  // The project root, not recursive: only the files listed in RECORDED_FILES.
  safeWatch(root, false, (name) => RECORDED_FILES.has(name) && onChange(name));
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
