// Who changed a file: an AI agent or you. `calm dev` asks this for every change it records.
//
// The signals, strongest first:
//   hook  the agent's own hook said, just before writing, which file it is about to edit
//         (`calm agent-hook`, wired for Claude Code by .claude/settings.json in new projects)
//   mcp   the agent called a calm mcp tool in the last 20 seconds
//   env   `calm dev` itself was started from an agent's shell (CLAUDECODE=1 for Claude Code),
//         so changes nobody else claimed are most likely the agent's
// Without any of them the change is yours. Every file event records `via`, so devtools can
// say how it knows.

export const AGENT_WINDOW_MS = 20_000;
export const HOOK_WINDOW_MS = 120_000;

/**
 * The agent a shell belongs to, from variables the agent sets for the commands it runs.
 * Only variables we have verified are listed; add yours in your copy if your agent sets one.
 */
export function detectAgentEnv(env = process.env) {
  if (env.CLAUDECODE === '1') return 'claude-code';
  return null;
}

/**
 * @param {string} rel the changed file, relative to the project root
 * @param {object[]} events recent Activity events, oldest first
 * @param {{ now?: number, envAgent?: string | null }} [options]
 * @returns {{ kind: 'agent', name: string, via: 'hook' | 'mcp' | 'env' } | null}
 */
export function attribute(rel, events, { now = Date.now(), envAgent = null } = {}) {
  const recent = [...events].reverse().filter((e) => e.type === 'agent');
  const age = (e) => now - Date.parse(e.time);
  const exact = recent.find((e) => e.path === rel && age(e) < HOOK_WINDOW_MS);
  if (exact) return { kind: 'agent', name: exact.client ?? 'agent', via: String(exact.tool ?? '').startsWith('hook:') ? 'hook' : 'mcp' };
  // A hook event names its own file: it only claims that one. MCP calls claim the window.
  const windowed = recent.find((e) => !e.path && age(e) < AGENT_WINDOW_MS);
  if (windowed) return { kind: 'agent', name: windowed.client ?? 'agent', via: String(windowed.tool ?? '').startsWith('hook:') ? 'hook' : 'mcp' };
  if (envAgent) return { kind: 'agent', name: envAgent, via: 'env' };
  return null;
}
