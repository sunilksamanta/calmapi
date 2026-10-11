import { PKG } from './lib/files.js';
import { findProjectRoot } from './lib/project.js';
import { c, out, fail } from './lib/ui.js';

const COMMANDS = {
  create: () => import('./commands/create.js'),
  dev: () => import('./commands/dev.js'),
  make: () => import('./commands/make.js'),
  add: () => import('./commands/add.js'),
  routes: () => import('./commands/routes.js'),
  openapi: () => import('./commands/openapi.js'),
  doctor: () => import('./commands/doctor.js'),
  upgrade: () => import('./commands/upgrade.js'),
  admin: () => import('./commands/admin.js'),
  mcp: () => import('./commands/mcp.js'),
};
const ALIASES = { new: 'create', init: 'create', generate: 'make', g: 'make', m: 'make' };

const HELP = `
  ${c.bold(c.green('CalmAPI'))} ${c.dim(`v${PKG.version}`)}  The backend framework you own.

  ${c.bold('Usage')}  calm <command> [options]

  ${c.bold('Start')}
    create [dir]                 new project (also: npm create calmapi@latest)
    dev                          run with watch mode and devtools at /_calm

  ${c.bold('Build')}
    make resource <name> [fields...]   scaffold a resource (calm make --help)
    add <block...>               add a block: jobs, storage-local, realtime-sse... (--list)

  ${c.bold('Inspect')}
    routes                       every route with its access policy
    openapi                      write openapi.json
    doctor                       security and correctness checks (--ci for pipelines)
    admin <email>                give a user the admin role (--revoke to remove)

  ${c.bold('Maintain')}
    upgrade                      merge framework updates into calm/, keeping your edits
    mcp                          MCP server for AI coding agents

  ${c.dim('calm <command> --help for details · https://calmapi.dev')}
`;

export async function main(argv) {
  const [first, ...rest] = argv;
  if (first === '--version' || first === '-v' || first === 'version') return out(PKG.version);
  if (first === '--help' || first === '-h' || first === 'help') return out(HELP);
  if (!first) {
    // Bare `calmapi` outside a project starts the project wizard (as in 1.x).
    if (!findProjectRoot()) return (await COMMANDS.create()).run([]);
    return out(HELP);
  }
  const name = ALIASES[first] ?? first;
  const load = COMMANDS[name];
  if (!load) {
    fail(`Unknown command "${first}".`);
    out(HELP);
    process.exitCode = 1;
    return;
  }
  try {
    await (await load()).run(rest);
  } catch (err) {
    fail(err.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `${err.message}. See calm ${name} --help` : err.message);
    if (process.env.CALM_DEBUG) console.error(err.stack);
    process.exitCode = 1;
  }
}
