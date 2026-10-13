// Agent scopes: what an AI agent may do over `calm mcp`.
//
//   read      inspect only (plus calm_http with GET)
//   scaffold  read, plus scaffolding tools and calm_http with any method
//   full      everything (today's behaviour)
//
// The scope comes from `calm mcp --scope`, else calm.config.js `agents.scope`, else full.
// Protected paths (`agents.protected`, minus `--allow` globs) are not enforced here: the
// MCP server only scaffolds, agents edit files with their own tools. `calm dev` marks
// agent edits to those paths in Activity and `calm doctor` warns until they are committed.
// The session is written to .calm/agent-session.json so both can read it.

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { introspect } from './introspect.js';

export const SCOPES = ['read', 'scaffold', 'full'];
export const DEFAULT_PROTECTED = ['calm/security/**', 'calm/auth/**', 'calm.config.js'];

const READ = [
  'calm_project', 'calm_routes', 'calm_resource', 'calm_doctor', 'calm_blocks', 'calm_openapi', 'calm_recent_requests', 'calm_request', 'calm_logs',
  'calm_test', 'calm_audit', 'calm_security', 'calm_activity', 'calm_mails', 'calm_pushes', 'calm_diff', 'calm_explain', 'calm_about', 'calm_propose', 'calm_review', 'calm_declare',
];
const SCAFFOLD = ['calm_make_resource', 'calm_add_block', 'calm_checkpoint'];

/** Tool names by the lowest scope that allows them. Anything else (calm_restore, new tools) is full only. */
export const TOOL_SETS = { read: READ, scaffold: SCAFFOLD };

/** The lowest scope that allows this call. */
export function neededScope(tool, args = {}) {
  if (tool === 'calm_http') return String(args.method ?? 'GET').toUpperCase() === 'GET' ? 'read' : 'scaffold';
  if (READ.includes(tool)) return 'read';
  if (SCAFFOLD.includes(tool)) return 'scaffold';
  return 'full';
}

export const allowedIn = (scope, tool, args = {}) => SCOPES.indexOf(scope) >= SCOPES.indexOf(neededScope(tool, args));

export function refusalText(scope, tool, args = {}) {
  const what = tool === 'calm_http' && neededScope(tool, args) !== 'read' ? `calm_http with ${String(args.method).toUpperCase()}` : tool;
  return `Refused: scope "${scope}" cannot run ${what}. Ask the developer to start the server with \`calm mcp --scope ${neededScope(tool, args)}\`, or describe the change with calm_propose so they can apply it.`;
}

/** Every tool stays listed (so agents know what exists); the ones out of scope say so. */
export function annotateTools(tools, scope) {
  return tools.map((t) => {
    if (t.name === 'calm_http' && scope === 'read') return { ...t, description: `${t.description} Only GET is available in the current scope (read): ask the developer to run calm mcp --scope scaffold for other methods.` };
    if (allowedIn(scope, t.name, {})) return t;
    return { ...t, description: `${t.description} Not available in the current scope (${scope}): ask the developer to run calm mcp --scope ${neededScope(t.name)}.` };
  });
}

const SCOPE_WORDS = { read: 'inspect only, no scaffolding or writes', scaffold: 'inspect and scaffold', full: 'all tools' };

/** One sentence for the MCP `initialize` instructions. */
export function scopeSentence({ scope, protected: paths = [] }) {
  const guarded = paths.length ? ` protected paths (${paths.join(', ')}) and access rules in resources are the developer's: describe changes there with calm_propose instead of editing.` : '';
  return `This session runs in scope "${scope}" (${SCOPE_WORDS[scope]});${guarded || ' no paths are protected.'}`;
}

/** `--scope <name>` and repeatable `--allow <glob>` from argv. Unknown flags are left to the command. */
export function parseScopeArgs(argv) {
  const out = { scope: null, allow: [] };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (flag !== '--scope' && flag !== '--allow') continue;
    const value = inline ?? argv[++i];
    if (!value) throw new Error(`${flag} needs a value`);
    if (flag === '--allow') out.allow.push(value);
    else if (SCOPES.includes(value)) out.scope = value;
    else throw new Error(`Unknown scope "${value}". Use one of: ${SCOPES.join(', ')}`);
  }
  return out;
}

/**
 * The scope and protected paths for this MCP session: project config (`agents` in
 * calm.config.js, read by booting the project once) overridden by the CLI flags.
 * A project that cannot boot gets the defaults, so inspection tools keep working.
 */
export async function resolveAgentSession(root, { scope = null, allow = [] } = {}) {
  let config = {};
  try {
    const info = await introspect(root);
    if (!info.error) config = info.agents ?? {};
  } catch {
    // falls back to the defaults below
  }
  const fromConfig = SCOPES.includes(config.scope) ? config.scope : 'full';
  const protectedPaths = Array.isArray(config.protected) ? config.protected.map(String) : DEFAULT_PROTECTED;
  return { scope: scope ?? fromConfig, allow, protected: protectedPaths };
}

// ---- .calm/agent-session.json ---------------------------------------------------------

export const sessionFile = (root) => join(root, '.calm', 'agent-session.json');

export function writeAgentSession(root, session) {
  mkdirSync(join(root, '.calm'), { recursive: true });
  const data = { client: session.client, scope: session.scope, allow: session.allow ?? [], protected: session.protected ?? [], startedAt: new Date().toISOString(), pid: process.pid };
  writeFileSync(sessionFile(root), `${JSON.stringify(data, null, 2)}\n`);
  return data;
}

/** Only this server's own file is removed: another agent may have connected since. */
export function clearAgentSession(root) {
  const current = readAgentSession(root);
  if (!current || current.pid !== process.pid) return;
  try {
    unlinkSync(sessionFile(root));
  } catch {
    // already gone
  }
}

export function readAgentSession(root) {
  if (!existsSync(sessionFile(root))) return null;
  try {
    return JSON.parse(readFileSync(sessionFile(root), 'utf8'));
  } catch {
    return null;
  }
}
