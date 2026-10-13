// A block's AGENTS.md (written by the registry build from block.json, or by the block's
// author): devtools reads back its instructions for AI agents and its official links.

/** The two machine-read sections of a block's AGENTS.md: { agents, links }. */
export function parseBlockGuide(text) {
  const section = (title) => {
    const m = new RegExp(`^## ${title}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(text ?? '');
    return m ? m[1].trim() : '';
  };
  const links = [...section('Official documentation').matchAll(/^- \[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/gm)].map((m) => ({ title: m[1], url: m[2] }));
  return { agents: section('For AI agents'), links };
}
