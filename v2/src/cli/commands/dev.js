import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireProject } from '../lib/project.js';
import { c, out } from '../lib/ui.js';

export const help = `
${c.bold('calm dev')}

  Start the app in development mode: NODE_ENV=development, file watching
  (node --watch) and devtools at http://localhost:<port>/_calm.
  Extra arguments are passed to node.
`;

export async function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return out(help);
  const root = requireProject();
  // Watch folders, not just the import graph, so a brand new resource folder
  // (calm make resource) restarts the server too.
  const watch = ['app', 'calm', 'calm.config.js', 'server.js', '.env']
    .filter((p) => existsSync(join(root, p)))
    .map((p) => `--watch-path=${join(root, p)}`);
  const child = spawn(process.execPath, [...watch, '--watch-preserve-output', ...argv, join(root, 'server.js')], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'development' },
  });
  const forward = (signal) => child.kill(signal);
  process.on('SIGINT', forward);
  process.on('SIGTERM', forward);
  await new Promise((resolve) => child.on('exit', resolve));
}
