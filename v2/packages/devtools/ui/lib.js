// Shared helpers: DOM building, icons, API calls, formatting, JSON views, toasts, popovers.

export const API = './api';

// ---- DOM ------------------------------------------------------------------------

const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'open', 'indeterminate', 'spellcheck']);

/** Create an element: h('div', { class: 'x', onclick }, 'text', child, [more]). */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

/** Same as h() for SVG elements. */
export function s(tag, props, ...kids) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  setProps(el, props);
  append(el, kids);
  return el;
}

function setProps(el, props) {
  if (!props) return;
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.setAttribute('class', Array.isArray(v) ? v.filter(Boolean).join(' ') : v);
    else if (k === 'style' && typeof v === 'object') {
      for (const [sk, sv] of Object.entries(v)) if (sv != null) el.style.setProperty(sk.startsWith('--') ? sk : sk.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), sv);
    } else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') el.innerHTML = v;
    else if (PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

export function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false || kid === true) continue;
    if (Array.isArray(kid)) append(el, kid);
    else el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const clear = (el) => {
  while (el.firstChild) el.firstChild.remove();
  return el;
};

export const mount = (el, ...kids) => append(clear(el), kids);

// ---- icons (lucide style, 24px grid, stroke) -----------------------------------------

const ICONS = {
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  route: '<circle cx="6" cy="19" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/><circle cx="18" cy="5" r="3"/>',
  layers: '<path d="m12 2 10 5-10 5L2 7l10-5z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4 3 9 3s9-1.34 9-3"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  mail: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="m22 7-8.97 5.7a1.94 1.94 0 0 1-2.06 0L2 7"/>',
  logs: '<path d="M4 6h16"/><path d="M4 12h10"/><path d="M4 18h13"/>',
  terminal: '<path d="m4 17 6-6-6-6"/><path d="M12 19h8"/>',
  doctor: '<path d="M11 2v2"/><path d="M5 2v2"/><path d="M5 3H4a2 2 0 0 0-2 2v4a6 6 0 0 0 12 0V5a2 2 0 0 0-2-2h-1"/><path d="M8 15a6 6 0 0 0 12 0v-3"/><circle cx="20" cy="10" r="2"/>',
  blocks: '<rect width="7" height="7" x="14" y="3" rx="1"/><path d="M10 21V8a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-5a1 1 0 0 0-1-1H3"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>',
  moon: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  monitor: '<rect width="20" height="14" x="2" y="3" rx="2"/><path d="M8 21h8M12 17v4"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  chevronRight: '<path d="m9 18 6-6-6-6"/>',
  chevronLeft: '<path d="m15 18-6-6 6-6"/>',
  chevronDown: '<path d="m6 9 6 6 6-6"/>',
  external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  checkCircle: '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4M12 17h.01"/>',
  alertCircle: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
  eyeOff: '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/>',
  eye: '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  play: '<path d="m7 4 13 8-13 8V4z"/>',
  code: '<path d="m16 18 6-6-6-6"/><path d="m8 6-6 6 6 6"/>',
  clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
  zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  inbox: '<path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  sidebar: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
  braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
  file: '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  keyboard: '<rect width="20" height="16" x="2" y="4" rx="2"/><path d="M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10"/>',
  pause: '<rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  sparkle: '<path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  stop: '<rect width="14" height="14" x="5" y="5" rx="2"/>',
  wrap: '<path d="M3 6h18"/><path d="M3 12h15a3 3 0 1 1 0 6h-4"/><path d="m16 16-2 2 2 2"/><path d="M3 18h7"/>',
};

/** Inline SVG icon. */
export function icon(name, size = 16, cls = '') {
  const el = s('svg', { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.75, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: ['icon', cls] });
  el.innerHTML = ICONS[name] ?? ICONS.info;
  return el;
}

/** The CalmAPI mark: two calm waves in a rounded square. */
export function logo(size = 22) {
  const el = s('svg', { viewBox: '0 0 32 32', width: size, height: size, 'aria-hidden': 'true', class: 'logo' });
  el.innerHTML =
    '<rect width="32" height="32" rx="9" fill="var(--accent)"/>' +
    '<path d="M8 13.5c2.7-2.6 5.3-2.6 8 0s5.3 2.6 8 0" fill="none" stroke="var(--on-accent)" stroke-width="2.4" stroke-linecap="round"/>' +
    '<path d="M8 19.5c2.7-2.6 5.3-2.6 8 0s5.3 2.6 8 0" fill="none" stroke="var(--on-accent)" stroke-width="2.4" stroke-linecap="round" opacity=".55"/>';
  return el;
}

// ---- API ------------------------------------------------------------------------

export class ApiError extends Error {}

/** Call the devtools API. Mutations carry the X-Calm-Devtools header the server requires. */
export async function api(path, { method = 'GET', body } = {}) {
  const headers = {};
  if (method !== 'GET') headers['X-Calm-Devtools'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store' });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = new ApiError(data?.error ?? `Request failed with ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---- formatting -----------------------------------------------------------------

export function fmtMs(ms) {
  if (ms == null || Number.isNaN(ms)) return '…';
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 1 : 2)} s`;
  if (ms >= 100) return `${Math.round(ms)} ms`;
  if (ms >= 10) return `${ms.toFixed(1).replace(/\.0$/, '')} ms`;
  return `${ms.toFixed(1).replace(/\.0$/, '')} ms`;
}

export function relTime(when, now = Date.now()) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!t) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function clock(when, ms = false) {
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n, l = 2) => String(n).padStart(l, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${ms ? `.${pad(d.getMilliseconds(), 3)}` : ''}`;
}

export function fullDate(when) {
  const d = new Date(when);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'medium' });
}

export function fmtUptime(sec) {
  sec = Math.max(0, Math.floor(sec));
  const d = Math.floor(sec / 86400), hr = Math.floor((sec % 86400) / 3600), m = Math.floor((sec % 3600) / 60), s2 = sec % 60;
  if (d) return `${d}d ${hr}h`;
  if (hr) return `${hr}h ${m}m`;
  if (m) return `${m}m ${s2}s`;
  return `${s2}s`;
}

export function fmtBytes(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export const STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified',
  400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 409: 'Conflict',
  413: 'Payload Too Large', 415: 'Unsupported Media Type', 422: 'Unprocessable Entity', 429: 'Too Many Requests',
  500: 'Internal Server Error', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout',
};

export const statusTone = (status) => (!status ? 'muted' : status >= 500 ? 'red' : status >= 400 ? 'amber' : status >= 300 ? 'blue' : 'green');

export function methodChip(method, cls = '') {
  const m = String(method || '').toUpperCase();
  const tone = { GET: 'green', POST: 'blue', PATCH: 'amber', PUT: 'amber', DELETE: 'red' }[m] ?? 'muted';
  return h('span', { class: ['chip', 'method', `t-${tone}`, cls] }, m === 'DELETE' ? 'DEL' : m);
}

export function statusChip(status, cls = '') {
  return h('span', { class: ['chip', 'status', `t-${statusTone(status)}`, cls], title: STATUS_TEXT[status] ?? '' }, status ?? '…');
}

const POLICY_TONE = { public: 'green', admin: 'purple', owner: 'blue', authenticated: 'gray' };

/** 'owner | admin' -> badges joined by a quiet "or". */
export function policyBadges(label, { explicit = true, title } = {}) {
  const tokens = String(label ?? '').split('|').map((t) => t.trim()).filter(Boolean);
  const wrap = h('span', { class: ['policy', !explicit && 'implicit'], title: title ?? (explicit ? `Policy: ${label}` : `Not explicit: defaulted to "${label}". Write it out so the intent is visible.`) });
  if (!explicit) wrap.append(icon('alert', 12, 'policy-warn'));
  if (!tokens.length) wrap.append(h('span', { class: 'badge t-gray' }, 'none'));
  tokens.forEach((t, i) => {
    if (i) wrap.append(h('span', { class: 'policy-or' }, 'or'));
    wrap.append(h('span', { class: ['badge', `t-${POLICY_TONE[t] ?? 'teal'}`] }, t));
  });
  return wrap;
}

const HUES = [168, 200, 225, 262, 300, 340, 24, 40, 140];
export function hueOf(str) {
  let x = 0;
  for (const c of String(str)) x = (x * 31 + c.charCodeAt(0)) >>> 0;
  return HUES[x % HUES.length];
}

export function initials(name) {
  const text = String(name ?? '?').trim();
  const parts = (text.includes('@') && !text.includes(' ') ? text.split('@')[0] : text).split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

export function avatar(name, size = 20) {
  return h('span', { class: 'avatar', style: { '--h': hueOf(name), width: `${size}px`, height: `${size}px`, fontSize: `${Math.round(size * 0.42)}px` }, 'aria-hidden': 'true' }, initials(name));
}

export function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

/** `code` spans in plain text (doctor details, hints). */
export function richText(text) {
  const out = [];
  String(text ?? '').split(/(`[^`]+`)/g).forEach((part) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) out.push(h('code', null, part.slice(1, -1)));
    else if (part) out.push(part);
  });
  return out;
}

/** Text with clickable URLs. */
export function linkify(text) {
  const out = [];
  const re = /\bhttps?:\/\/[^\s<>"')\]]+/g;
  let last = 0;
  for (const m of String(text ?? '').matchAll(re)) {
    let url = m[0];
    const trail = /[.,;:!?]+$/.exec(url)?.[0] ?? '';
    if (trail) url = url.slice(0, -trail.length);
    out.push(text.slice(last, m.index));
    out.push(h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url));
    last = m.index + url.length;
  }
  out.push(String(text ?? '').slice(last));
  return out;
}

// ---- editor links ---------------------------------------------------------------

export function editorUrl(root, file, line, col) {
  if (!file) return null;
  let path = String(file).replace(/^file:\/\//, '').replace(/\\/g, '/');
  const absolute = path.startsWith('/') || /^[A-Za-z]:\//.test(path);
  if (!absolute && root) path = `${String(root).replace(/\\/g, '/').replace(/\/$/, '')}/${path}`;
  return `vscode://file/${path.replace(/^\/+/, '')}${line ? `:${line}${col ? `:${col}` : ''}` : ''}`;
}

export function relPath(root, file) {
  const f = String(file ?? '').replace(/^file:\/\//, '');
  const r = String(root ?? '').replace(/\/$/, '');
  return r && f.startsWith(`${r}/`) ? f.slice(r.length + 1) : f;
}

/** A file link that opens the editor, showing the relative path. */
export function fileLink(root, file, { line, label, cls } = {}) {
  if (!file) return h('span', { class: 'muted' }, '');
  const rel = relPath(root, file);
  return h('a', { class: ['file-link', cls], href: editorUrl(root, file, line), title: `${rel}${line ? `:${line}` : ''}\nOpen in VS Code` }, icon('file', 12), h('span', null, label ?? rel + (line ? `:${line}` : '')));
}

// ---- JSON views ------------------------------------------------------------------

const JSON_TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g;

/** JSON.stringify with short objects and arrays kept on one line. */
export function prettyJson(value, indent = 2, width = 72) {
  const entries = (v) => Object.entries(v).filter(([, x]) => x !== undefined);
  const inline = (v) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    if (Array.isArray(v)) return v.length ? `[${v.map(inline).join(', ')}]` : '[]';
    const e = entries(v);
    return e.length ? `{ ${e.map(([k, x]) => `${JSON.stringify(k)}: ${inline(x)}`).join(', ')} }` : '{}';
  };
  const walk = (v, depth) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
    const one = inline(v);
    if (one.length + depth * indent <= width) return one;
    const pad = ' '.repeat((depth + 1) * indent);
    const end = ' '.repeat(depth * indent);
    if (Array.isArray(v)) return `[\n${v.map((x) => pad + walk(x, depth + 1)).join(',\n')}\n${end}]`;
    return `{\n${entries(v).map(([k, x]) => `${pad}${JSON.stringify(k)}: ${walk(x, depth + 1)}`).join(',\n')}\n${end}}`;
  };
  return walk(value, 0);
}

/** Pretty JSON as highlighted HTML (all content escaped). */
export function highlightJson(value, indent = 2) {
  const json = typeof value === 'string' ? value : prettyJson(value, indent);
  let out = '';
  let last = 0;
  for (const m of json.matchAll(JSON_TOKEN)) {
    out += escapeHtml(json.slice(last, m.index));
    if (m[1]) out += m[2] ? `<span class="j-key">${escapeHtml(m[1])}</span>${m[2]}` : `<span class="j-str">${escapeHtml(m[1])}</span>`;
    else if (m[3]) out += `<span class="${m[3] === 'null' ? 'j-null' : 'j-bool'}">${m[3]}</span>`;
    else out += `<span class="j-num">${m[4]}</span>`;
    last = m.index + m[0].length;
  }
  return out + escapeHtml(json.slice(last));
}

export const codeBlock = (value, cls = '') => h('pre', { class: ['code', cls], html: highlightJson(value) });

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/;
const OBJECT_ID = /^[a-f0-9]{24}$/;

function scalar(v) {
  if (v === null) return h('span', { class: 'j-null' }, 'null');
  if (typeof v === 'string') {
    if (OBJECT_ID.test(v)) return h('span', { class: 'j-str j-id' }, `"${v}"`);
    if (ISO_DATE.test(v)) return h('span', { class: 'j-str', title: fullDate(v) }, `"${v}"`);
    return h('span', { class: 'j-str' }, JSON.stringify(v));
  }
  if (typeof v === 'number') return h('span', { class: 'j-num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: 'j-bool' }, String(v));
  return h('span', { class: 'j-null' }, String(v));
}

function preview(value) {
  const text = JSON.stringify(value);
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

/** Collapsible JSON tree. Children render lazily the first time a node opens. */
export function jsonTree(value, { open = 2 } = {}) {
  const root = h('div', { class: 'jt' });
  root.append(treeNode(undefined, value, 0, open, true));
  return root;
}

function treeNode(key, value, depth, open, last) {
  const comma = last ? '' : ',';
  const keyEl = key === undefined ? null : [h('span', { class: 'j-key' }, JSON.stringify(key)), h('span', { class: 'j-punc' }, ': ')];
  if (value && typeof value === 'object') {
    const isArr = Array.isArray(value);
    const entries = isArr ? value.map((v, i) => [i, v]) : Object.entries(value);
    const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) return h('div', { class: 'jt-line' }, keyEl, h('span', { class: 'j-punc' }, o + c + comma));
    const details = h('details', { class: 'jt-node' });
    const summary = h(
      'summary',
      { class: 'jt-line' },
      h('span', { class: 'jt-caret' }, icon('chevronRight', 12)),
      keyEl,
      h('span', { class: 'j-punc' }, o),
      h('span', { class: 'jt-preview' }, h('span', { class: 'jt-ellipsis' }, preview(value).length < 48 ? preview(value).slice(1, -1) : `${entries.length} ${isArr ? 'items' : 'keys'}`), h('span', { class: 'j-punc' }, c + comma)),
    );
    const body = h('div', { class: 'jt-children' });
    let filled = false;
    const fill = () => {
      if (filled) return;
      filled = true;
      entries.forEach(([k, v], i) => body.append(treeNode(isArr ? undefined : k, v, depth + 1, open, i === entries.length - 1)));
    };
    if (depth < open && entries.length <= 200) {
      details.open = true;
      fill();
    }
    details.addEventListener('toggle', () => details.open && fill());
    details.append(summary, body, h('div', { class: 'jt-line jt-close' }, h('span', { class: 'j-punc' }, c + comma)));
    return details;
  }
  return h('div', { class: 'jt-line' }, keyEl, scalar(value), comma ? h('span', { class: 'j-punc' }, comma) : null);
}

/** JSON tree with a small toolbar (expand, collapse, copy). */
export function jsonViewer(value, { open = 2, title } = {}) {
  const tree = jsonTree(value, { open });
  const body = h('div', { class: 'jv-body' }, tree);
  const setAll = (state) => {
    // Expanding renders children lazily, so walk until no closed node is left.
    for (let pass = 0; pass < 12; pass++) {
      const nodes = [...body.querySelectorAll(state ? 'details:not([open])' : 'details[open]')];
      if (!nodes.length) break;
      nodes.forEach((d) => {
        d.open = state;
        if (state) d.dispatchEvent(new Event('toggle'));
      });
      if (!state) break;
    }
  };
  return h(
    'div',
    { class: 'jv' },
    h(
      'div',
      { class: 'jv-bar' },
      title ? h('span', { class: 'jv-title' }, title) : null,
      h('span', { class: 'spacer' }),
      h('button', { class: 'btn ghost xs', onclick: () => setAll(true) }, 'Expand all'),
      h('button', { class: 'btn ghost xs', onclick: () => setAll(false) }, 'Collapse'),
      h('button', { class: 'btn ghost xs', onclick: () => copy(JSON.stringify(value, null, 2), 'JSON copied') }, icon('copy', 13), 'Copy'),
    ),
    body,
  );
}

/** Compact one-line value for tables and the privacy lens. */
export function inlineValue(v, { max = 140 } = {}) {
  if (v === undefined) return h('span', { class: 'j-null' }, 'undefined');
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'string' && v.length > max) {
      const el = h('span', { class: 'j-str', title: v }, JSON.stringify(`${v.slice(0, max)}…`));
      return el;
    }
    return scalar(v);
  }
  const text = JSON.stringify(v);
  const el = h('span', { class: 'j-obj', title: text.length > max ? JSON.stringify(v, null, 2).slice(0, 2000) : '' });
  el.innerHTML = highlightJson(text.length > max ? `${text.slice(0, max)}…` : text, 0);
  return el;
}

// ---- clipboard, toasts ---------------------------------------------------------------

export async function copy(text, message = 'Copied to clipboard') {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.append(ta);
    ta.select();
    try {
      document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
  }
  toast(message, { tone: 'ok' });
}

let toastHost;
export function toast(message, { tone = 'info', action, timeout = 4200, detail } = {}) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const name = { ok: 'checkCircle', error: 'alertCircle', warn: 'alert', info: 'info' }[tone];
  const close = () => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 200);
  };
  const el = h(
    'div',
    { class: ['toast', `toast-${tone}`] },
    icon(name, 16),
    h('div', { class: 'toast-text' }, h('div', null, message), detail ? h('div', { class: 'toast-detail' }, detail) : null),
    action ? h('button', { class: 'btn xs', onclick: () => (action.run(), close()) }, action.label) : null,
    h('button', { class: 'icon-btn ghost xs', 'aria-label': 'Dismiss', onclick: close }, icon('x', 14)),
  );
  toastHost.append(el);
  if (timeout) setTimeout(close, timeout);
  return close;
}

// ---- small building blocks ---------------------------------------------------------

export function empty({ icon: name = 'inbox', title, hint, code, action, tone }) {
  return h(
    'div',
    { class: ['empty', tone && `empty-${tone}`] },
    h('div', { class: 'empty-icon' }, icon(name, 22)),
    h('div', { class: 'empty-title' }, title),
    hint ? h('div', { class: 'empty-hint' }, richText(hint)) : null,
    code ? h('div', { class: 'empty-code' }, h('code', null, code), h('button', { class: 'icon-btn ghost xs', 'aria-label': 'Copy command', onclick: () => copy(code) }, icon('copy', 13))) : null,
    action ? h('button', { class: 'btn', onclick: action.run }, action.icon ? icon(action.icon, 14) : null, action.label) : null,
  );
}

export function loading(text = 'Loading') {
  return h('div', { class: 'loading' }, h('span', { class: 'spinner' }), text);
}

export function errorBox(err) {
  return empty({ icon: 'alertCircle', title: 'Could not load this', hint: err?.message ?? String(err), tone: 'error' });
}

export function panelHead({ title, sub, actions = [], extra }) {
  return h('header', { class: 'panel-head' }, h('div', { class: 'panel-titles' }, h('h1', { class: 'panel-title' }, title), sub ? h('p', { class: 'panel-sub' }, sub) : null), extra, h('div', { class: 'panel-actions' }, actions));
}

export function searchBox({ placeholder = 'Filter', value = '', oninput, label = 'Filter' }) {
  const input = h('input', { class: 'input', type: 'search', placeholder, value, 'aria-label': label, 'data-filter': '', spellcheck: false, autocomplete: 'off' });
  input.addEventListener('input', () => oninput(input.value));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (input.value) {
        input.value = '';
        oninput('');
      } else input.blur();
      e.stopPropagation();
    }
  });
  return h('label', { class: 'search' }, icon('search', 14), input, h('kbd', { 'aria-hidden': 'true' }, '/'));
}

/** Segmented control. options: [{ value, label, count? }] */
export function segmented(options, value, onchange, label = 'Options') {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const render = (current) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(
        h(
          'button',
          { type: 'button', 'aria-pressed': String(o.value === current), title: o.title ?? null, 'aria-label': o.aria ?? null, onclick: () => (render(o.value), onchange(o.value)) },
          o.icon ? icon(o.icon, 14) : null,
          o.label,
          o.count != null ? h('span', { class: 'seg-count' }, o.count) : null,
        ),
      );
    }
  };
  render(value);
  wrap.set = render;
  return wrap;
}

export function tabs(items, active, onchange) {
  const bar = h('div', { class: 'tabs', role: 'tablist' });
  const render = (current) => {
    clear(bar);
    for (const t of items) {
      bar.append(
        h(
          'button',
          { class: ['tab', t.tone && `tab-${t.tone}`], role: 'tab', 'aria-selected': String(t.id === current), tabindex: t.id === current ? '0' : '-1', onclick: () => (render(t.id), onchange(t.id)) },
          t.label,
          t.count != null && t.count !== '' ? h('span', { class: 'tab-count' }, t.count) : null,
          t.dot ? h('span', { class: `dot dot-${t.dot}` }) : null,
        ),
      );
    }
  };
  bar.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const btns = [...bar.querySelectorAll('.tab')];
    const i = btns.indexOf(document.activeElement);
    if (i < 0) return;
    const next = btns[(i + (e.key === 'ArrowRight' ? 1 : -1) + btns.length) % btns.length];
    next.focus();
    next.click();
    e.stopPropagation();
  });
  render(active);
  bar.set = render;
  return bar;
}

// ---- popovers -----------------------------------------------------------------------

let openPop = null;
export function closePopover() {
  openPop?.close();
}

/** Anchored floating panel. Closes on outside click and Escape. */
export function popover(anchor, content, { align = 'start', width } = {}) {
  closePopover();
  const pop = h('div', { class: 'popover', role: 'dialog', style: { width: width ? `${width}px` : null } }, content);
  document.body.append(pop);
  const place = () => {
    const r = anchor.getBoundingClientRect();
    const pw = pop.offsetWidth;
    let left = align === 'end' ? r.right - pw : r.left;
    left = Math.max(8, Math.min(left, window.innerWidth - pw - 8));
    let top = r.bottom + 6;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 6);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  };
  place();
  const onDown = (e) => {
    if (!pop.contains(e.target) && !anchor.contains(e.target)) close();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      anchor.focus?.();
    }
  };
  const close = () => {
    pop.remove();
    document.removeEventListener('mousedown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', close);
    if (openPop?.pop === pop) openPop = null;
  };
  setTimeout(() => document.addEventListener('mousedown', onDown, true));
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', close);
  openPop = { pop, close, place };
  return openPop;
}

/** A list of options with a search box, keyboard navigation and async loading. */
export function pickerList({ load, render, onPick, placeholder = 'Search', fixed = [] }) {
  const input = h('input', { class: 'input', type: 'search', placeholder, 'aria-label': placeholder, autocomplete: 'off', spellcheck: false });
  const list = h('div', { class: 'pick-list', role: 'listbox' });
  let items = [];
  let active = 0;
  let seq = 0;
  const paint = () => {
    clear(list);
    const all = [...fixed, ...items];
    if (!all.length) list.append(h('div', { class: 'pick-empty' }, 'No matches'));
    all.forEach((item, i) => {
      const el = h('button', { type: 'button', class: ['pick-item', i === active && 'active'], role: 'option', 'aria-selected': String(i === active), onclick: () => onPick(item), onmousemove: () => { if (active !== i) { active = i; paint(); } } }, render(item));
      list.append(el);
    });
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const refresh = async () => {
    const mine = ++seq;
    list.classList.add('busy');
    try {
      const out = await load(input.value.trim());
      if (mine !== seq) return;
      items = out;
      active = 0;
      paint();
    } catch (err) {
      mount(list, h('div', { class: 'pick-empty' }, err.message));
    } finally {
      list.classList.remove('busy');
    }
  };
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 120);
  });
  input.addEventListener('keydown', (e) => {
    const all = [...fixed, ...items];
    if (e.key === 'ArrowDown') active = Math.min(all.length - 1, active + 1);
    else if (e.key === 'ArrowUp') active = Math.max(0, active - 1);
    else if (e.key === 'Enter') {
      if (all[active]) onPick(all[active]);
      e.preventDefault();
      return;
    } else return;
    e.preventDefault();
    paint();
  });
  refresh();
  setTimeout(() => input.focus());
  return h('div', { class: 'picker' }, h('label', { class: 'search' }, icon('search', 14), input), list);
}

/** Users from /users as picker options. */
export function userOption(u) {
  if (!u.id) return h('span', { class: 'user-opt' }, h('span', { class: 'avatar anon' }, icon('eyeOff', 12)), h('span', { class: 'user-opt-text' }, h('span', { class: 'user-opt-name' }, u.name), h('span', { class: 'user-opt-sub' }, u.sub ?? 'No session')));
  return h(
    'span',
    { class: 'user-opt' },
    avatar(u.name ?? u.email, 24),
    h('span', { class: 'user-opt-text' }, h('span', { class: 'user-opt-name' }, u.name ?? u.id), h('span', { class: 'user-opt-sub' }, u.email ?? u.id)),
    h('span', { class: 'user-opt-roles' }, (u.roles ?? []).filter((r) => r !== 'user').map((r) => h('span', { class: `badge t-${r === 'admin' ? 'purple' : 'gray'}` }, r)), u.status && u.status !== 'active' ? h('span', { class: 'badge t-red' }, u.status) : null),
  );
}

export const debounce = (fn, ms = 150) => {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
};

/** Safe localStorage access (private windows and blocked storage throw). */
export const storage = {
  get(key, fallback = null) {
    try {
      const v = localStorage.getItem(`calm-devtools:${key}`);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(`calm-devtools:${key}`, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};
