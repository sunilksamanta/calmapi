import { isAbsolute, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { findProjectRoot } from '../lib/project.js';
import { appendActivity } from '../lib/activity.js';
import { c, out } from '../lib/ui.js';

export const help = `
${c.bold('calm agent-hook')} [--client <name>]

  Tells ${c.bold('calm dev')} that an AI agent is about to change a file, so devtools Activity
  shows the change as the agent's and not yours. Agents call it from their hooks with
  one JSON object on stdin. It only appends a line to .calm/activity.jsonl, prints
  nothing and always exits 0, so it can never block the agent.

  Claude Code (new projects have this in .claude/settings.json):
    { "hooks": { "PreToolUse": [{ "matcher": "Edit|MultiEdit|Write|NotebookEdit",
      "hooks": [{ "type": "command", "command": "npx --no-install calm agent-hook" }] }] } }

  Any other agent: pipe { "tool": "edit", "path": "app/routes.js" } into
    npx calm agent-hook --client <name>
`;

const MAX_INPUT = 1024 * 1024;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let text = '';
  for await (const chunk of process.stdin) {
    text += chunk;
    if (text.length > MAX_INPUT) break;
  }
  return text;
}

/** The hook payload as { tool, file, cwd }: Claude Code's format or the generic one. */
export function parsePayload(input) {
  const tool = input.tool_name ?? input.tool ?? 'edit';
  const ti = input.tool_input ?? {};
  const file = ti.file_path ?? ti.notebook_path ?? ti.path ?? input.path ?? input.file ?? null;
  return { tool: String(tool).slice(0, 60), file: typeof file === 'string' ? file : null, cwd: typeof input.cwd === 'string' ? input.cwd : null };
}

export async function run(argv) {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { client: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }));
  } catch {
    return;
  }
  if (values.help) return out(help);
  try {
    const text = await readStdin();
    const input = text.trim() ? JSON.parse(text) : {};
    const { tool, file, cwd } = parsePayload(input);
    const base = cwd ?? process.cwd();
    const root = findProjectRoot(file && isAbsolute(file) ? resolve(file, '..') : base) ?? findProjectRoot(base);
    if (!root) return;
    const client = String(values.client ?? 'claude-code').slice(0, 60);
    let path = null;
    if (file) {
      const rel = relative(root, resolve(base, file)).split(sep).join('/');
      if (rel && !rel.startsWith('..') && !isAbsolute(rel)) path = rel;
    }
    appendActivity(root, {
      type: 'agent',
      client,
      tool: `hook:${tool}`,
      ...(path ? { path } : {}),
      ok: true,
      ms: 0,
      summary: path ? `${client} is editing ${path}` : `${client} used ${tool}`,
    });
  } catch {
    // never fail the agent's tool call over a log line
  }
}
