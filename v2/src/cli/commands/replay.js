import { parseArgs } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { requireProject } from '../lib/project.js';
import { readText } from '../lib/files.js';
import { c, out, ok, info } from '../lib/ui.js';

export const help = `
${c.bold('calm replay')} [--limit <n>] [--writes] [--json] [--ci]

  Replay recorded requests against the code as it is now and see which answers changed.
  The dev server records every API request to .calm/traffic.jsonl (method, path, who made
  it, the body with secrets redacted, the status and the shape of the answer, never its
  values). Replay sends them again as the same users and compares status and shape: fields
  newly returned (a possible leak), fields gone, types changed, lists that grew or shrank.

    calm replay                 the last 200 reads (GET)
    calm replay --limit 500
    calm replay --writes        writes too: a checkpoint is taken first and restored after,
                                so your data ends as it began
    calm replay --ci            exit 1 when an answer changed

  Needs the dev server (npm run dev). Development only.
`;

function devServerUrl(root) {
  const env = existsSync(join(root, '.env')) ? readText(join(root, '.env')) : '';
  const port = process.env.PORT ?? /^PORT=(\d+)/m.exec(env)?.[1] ?? '5001';
  return `http://localhost:${port}`;
}

export async function run(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { limit: { type: 'string' }, writes: { type: 'boolean' }, json: { type: 'boolean' }, ci: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
  });
  if (values.help) return out(help);
  const root = requireProject();
  const limit = values.limit === undefined ? 200 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error('--limit is a number from 1 to 1000');
  const base = devServerUrl(root);
  let res;
  try {
    res = await fetch(`${base}/_calm/api/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-calm-devtools': '1' },
      body: JSON.stringify({ limit, writes: Boolean(values.writes) }),
      signal: AbortSignal.timeout(10 * 60_000),
    });
  } catch {
    throw new Error(`The dev server is not reachable at ${base}. Replay runs inside it: start it with npm run dev.`);
  }
  const report = await res.json().catch(() => null);
  if (!res.ok) throw new Error(report?.error ?? `Replay failed with ${res.status}`);
  if (values.json) out(JSON.stringify(report, null, 2));
  else print(report);
  if (values.ci && (report.changed.length || report.failed.length)) process.exitCode = 1;
}

function print(r) {
  if (!r.total) return info('Nothing recorded yet. Use the API while npm run dev is running (requests are kept in .calm/traffic.jsonl), then replay.');
  out('', `  ${c.bold('Replayed')} ${r.total} recorded request${r.total === 1 ? '' : 's'} ${c.dim(`against the code as it is now (${(r.durationMs / 1000).toFixed(1)} s${r.writes ? ', writes restored from a checkpoint' : ''})`)}`);
  out(`    ${c.green(String(r.identical).padStart(4))} identical`);
  if (r.changed.length) out(`    ${c.yellow(String(r.changed.length).padStart(4))} changed`);
  if (r.skipped.length) out(`    ${c.dim(String(r.skipped.length).padStart(4))} skipped`);
  if (r.failed.length) out(`    ${c.red(String(r.failed.length).padStart(4))} failed`);
  // The same request as the same user with the same differences prints once, with a count.
  const groups = new Map();
  for (const ch of r.changed) {
    const who = ch.user ? `as user ${ch.user.id} [${ch.user.roles.join(', ')}]` : 'anonymous';
    const key = `${ch.request} ${who} ${ch.differences.map((d) => d.text).join('|')}`;
    if (groups.has(key)) groups.get(key).count++;
    else groups.set(key, { ch, who, count: 1 });
  }
  const shown = [...groups.values()];
  for (const { ch, who, count } of shown.slice(0, 30)) {
    out('', `  ${ch.newFields ? c.red('✖') : c.yellow('~')} ${c.bold(ch.request)} ${c.dim(who)}${count > 1 ? c.dim(` (${count} times)`) : ''}`);
    for (const d of ch.differences.slice(0, 8)) out(`      ${d.kind === 'added' ? c.red(d.text) : d.text}`);
  }
  if (shown.length > 30) out(c.dim(`  ...and ${shown.length - 30} more (--json for all)`));
  for (const f of r.failed.slice(0, 10)) out(`  ${c.red('✖')} ${f.request}: ${f.error}`);
  const reasons = new Map();
  for (const sk of r.skipped) reasons.set(sk.reason, [...(reasons.get(sk.reason) ?? []), sk.request]);
  if (reasons.size) out('');
  for (const [reason, requests] of reasons) {
    const names = [...new Set(requests)];
    out(c.dim(`  Skipped ${requests.length}: ${reason} (${names.slice(0, 3).join(', ')}${names.length > 3 ? ', ...' : ''})`));
  }
  out('');
  if (!r.changed.length && !r.failed.length) ok('Every answer has the same status and shape as when it was recorded.');
}
