// A recorded request as text: the path it took through the code, one step per line.
// Used by the calm_explain MCP tool, so an agent reads why a request was denied
// instead of guessing.
//
//   GET /api/orders/66f1…c2 -> 403 FORBIDDEN   as Grace Hopper (user)
//     auth session              calm/auth/index.js            Grace Hopper (user)
//     policy "owner | admin"    app/resources/order/order.resource.js:19
//       owner: doc.customer 66e0…9a is not user 66f3…11
//       admin: user has roles [user]
//     service and hooks did not run

const STATUS = { 200: 'OK', 201: 'CREATED', 204: 'NO CONTENT', 400: 'BAD REQUEST', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT FOUND', 409: 'CONFLICT', 422: 'UNPROCESSABLE', 429: 'TOO MANY REQUESTS', 500: 'SERVER ERROR' };
const short = (id) => (typeof id === 'string' && id.length > 10 ? `${id.slice(0, 4)}…${id.slice(-2)}` : id);
const shortPath = (path) => String(path ?? '').replace(/[a-f\d]{24}/gi, (m) => short(m));

function label(step) {
  const name = step.kind === 'policy' || step.kind === 'rateLimit' ? `"${step.name}"` : step.name;
  return `${step.kind} ${name}`.trim();
}

const where = (step) => (step.file ? `${step.file}${step.line ? `:${step.line}` : ''}` : '');

function detailText(step) {
  if (Array.isArray(step.detail)) return ''; // tokens and the note follow on their own lines
  if (step.detail == null) return step.outcome && step.outcome !== 'passed' ? step.outcome : '';
  return typeof step.detail === 'string' ? step.detail : JSON.stringify(step.detail);
}

export function explainText(record) {
  const steps = record.steps ?? [];
  const who = record.user ? `as ${record.user.name ?? record.user.email ?? record.user.id} (${(record.user.roles ?? []).join(', ') || 'no roles'})` : 'as anonymous';
  const head = `${record.method} ${shortPath(record.path)} -> ${record.status ?? '…'} ${STATUS[record.status] ?? ''}`.trimEnd();
  const lines = [`${head}   ${who}`];
  if (!steps.length) {
    lines.push('  no steps recorded (devtools off, or a request from before the dev server restarted)');
    return lines.join('\n');
  }
  const rows = steps.map((s) => [label(s), where(s), detailText(s), s]);
  const w0 = Math.min(30, Math.max(...rows.map((r) => r[0].length)));
  const w1 = Math.min(48, Math.max(...rows.map((r) => r[1].length)));
  for (const [name, file, detail, s] of rows) {
    const mark = s.outcome === 'denied' || s.outcome === 'failed' ? '✖ ' : s.outcome === 'answered' ? '↩ ' : '  ';
    const long = file.length > w1;
    lines.push(`${mark}${name.padEnd(w0)}  ${long ? file : file.padEnd(w1)}${detail && !long ? `  ${detail}` : ''}`.trimEnd());
    if (detail && long) lines.push(`    ${detail}`);
    if (Array.isArray(s.detail)) for (const t of s.detail) lines.push(`    ${t.token}: ${t.why}`);
    if (Array.isArray(s.detail) && s.note) lines.push(`    ${s.note}`);
  }
  const ran = steps.some((s) => s.kind === 'handler' || s.kind === 'hook');
  if (!ran) lines.push('  service and hooks did not run');
  return lines.join('\n');
}
