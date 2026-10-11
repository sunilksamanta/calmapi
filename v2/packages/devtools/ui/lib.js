// Shared helpers: DOM building, a few functional icons, API calls, formatting, JSON views,
// toasts, tooltips and popovers.

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

/** Join nodes with a separator node (" · " by default). */
export function joined(items, sep = ' · ') {
  const out = [];
  items.filter((x) => x != null && x !== false && x !== '').forEach((x, i) => {
    if (i) out.push(h('span', { class: 'sep', 'aria-hidden': 'true' }, sep));
    out.push(x);
  });
  return out;
}

// ---- icons: only functional ones, 16px grid, 1.5 stroke ----------------------------

const ICONS = {
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  chevronRight: '<path d="M6 3.5L10.5 8 6 12.5"/>',
  chevronLeft: '<path d="M10 3.5L5.5 8l4.5 4.5"/>',
  chevronDown: '<path d="M3.5 6L8 10.5 12.5 6"/>',
  chevronUp: '<path d="M3.5 10L8 5.5l4.5 4.5"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 5.5V3.75c0-.69-.56-1.25-1.25-1.25h-5.5c-.69 0-1.25.56-1.25 1.25v5.5c0 .69.56 1.25 1.25 1.25H5.5"/>',
  external: '<path d="M9.5 2.5h4v4M13.5 2.5L7.5 8.5M11.5 9.5v3c0 .55-.45 1-1 1h-7c-.55 0-1-.45-1-1v-7c0-.55.45-1 1-1h3"/>',
  sun: '<circle cx="8" cy="8" r="2.75"/><path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M3.4 12.6l.9-.9M11.7 4.3l.9-.9"/>',
  moon: '<path d="M13.25 9.6A5.5 5.5 0 0 1 6.4 2.75a5.5 5.5 0 1 0 6.85 6.85z"/>',
  system: '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25v11.5" /><path d="M8 2.25a5.75 5.75 0 0 1 0 11.5z" fill="currentColor" stroke="none"/>',
  sidebar: '<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><path d="M6 2.5v11"/>',
};

/** Inline SVG icon (functional icons only: close, chevrons, copy, theme, external). */
export function icon(name, size = 16, cls = '') {
  const el = s('svg', { viewBox: '0 0 16 16', width: size, height: size, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.5, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: ['icon', cls].filter(Boolean).join(' ') });
  el.innerHTML = ICONS[name] ?? '';
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
  return `${ms.toFixed(1).replace(/\.0$/, '')} ms`;
}

export function relTime(when, now = Date.now()) {
  const t = typeof when === 'number' ? when : Date.parse(when);
  if (!t) return '';
  const sec = Math.max(0, Math.round((now - t) / 1000));
  if (sec < 5) return 'now';
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

/** Status class for color: s2 (green), s3 (muted), s4 (amber), s5 (red). */
export const statusClass = (status) => (!status ? 's0' : status >= 500 ? 's5' : status >= 400 ? 's4' : status >= 300 ? 's3' : 's2');

/** HTTP method as colored monospace text. No background. */
export function methodTag(method, cls = '') {
  const m = String(method || '').toUpperCase();
  const key = { GET: 'get', POST: 'post', PATCH: 'put', PUT: 'put', DELETE: 'del' }[m] ?? 'other';
  return h('span', { class: ['method', `m-${key}`, cls] }, m === 'DELETE' ? 'DEL' : m);
}

/** Status code as colored monospace text. */
export function statusTag(status, cls = '') {
  return h('span', { class: ['status', statusClass(status), cls], title: STATUS_TEXT[status] ?? null }, status ?? '…');
}

/** A policy label ('owner | admin') as monospace text; defaulted policies get an amber dot. */
export function policyText(label, { explicit = true, title } = {}) {
  const text = String(label ?? '').split('|').map((t) => t.trim()).filter(Boolean).join(' | ') || 'none';
  return h(
    'span',
    { class: ['policy', !explicit && 'implicit'], title: title ?? (explicit ? null : `Not explicit: defaulted to "${text}". Write it out so the intent is visible.`) },
    !explicit ? h('span', { class: 'dot dot-amber', 'aria-label': 'defaulted' }) : null,
    text,
  );
}

const ID_SEG = /^([a-f0-9]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d+)$/i;

/** A concrete request path; segments that fill a route param are highlighted, the query string muted. */
export function pathView(path, route = null) {
  const [p, qs] = String(path).split(/\?(.*)/s);
  const segs = p.split('/');
  const tpl = route ? String(route).split('/') : null;
  const usable = tpl && tpl.length === segs.length;
  return h(
    'span',
    { class: 'path' },
    segs.map((seg, i) => {
      const isParam = usable ? tpl[i].startsWith(':') : ID_SEG.test(seg);
      return [i ? '/' : '', isParam && seg ? h('span', { class: 'path-param' }, seg) : seg];
    }),
    qs ? h('span', { class: 'path-qs' }, `?${qs}`) : null,
  );
}

/** A route template: prefix muted, :params highlighted. */
export function routePath(path, prefix = '') {
  const rest = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return h(
    'span',
    { class: 'path' },
    prefix && rest !== path ? h('span', { class: 'path-prefix' }, prefix) : null,
    rest.split(/(:[A-Za-z_][\w]*)/g).map((seg) => (seg.startsWith(':') ? h('span', { class: 'path-param' }, seg) : seg)),
  );
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

/** A muted monospace link that opens the file in VS Code. Long paths are cut at the start. */
export function fileLink(root, file, { line, label, cls } = {}) {
  if (!file) return null;
  const rel = relPath(root, file);
  const text = label ?? rel + (line ? `:${line}` : '');
  return h('a', { class: ['file', cls], href: editorUrl(root, file, line), title: `${rel}${line ? `:${line}` : ''}  (open in VS Code)` }, h('bdi', { dir: 'ltr' }, text));
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

/** One-line JSON for previews: compact, highlighted. */
export function jsonLine(value, max = 240) {
  let text = JSON.stringify(value) ?? '';
  if (text.length > max) text = `${text.slice(0, max)}…`;
  return h('span', { class: 'json-line', html: highlightJson(text, 0) });
}

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
    if (depth > 0) {
      const one = prettyJson(value, 2, Infinity);
      if (one.length <= 44) return h('div', { class: 'jt-line' }, keyEl, h('span', { html: highlightJson(one) }), comma ? h('span', { class: 'j-punc' }, comma) : null);
    }
    const details = h('details', { class: 'jt-node' });
    const summary = h(
      'summary',
      { class: 'jt-line' },
      h('span', { class: 'jt-caret', 'aria-hidden': 'true' }),
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

/** JSON tree with quiet actions (expand, collapse, copy). */
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
      h('button', { class: 'link-btn', onclick: () => setAll(true) }, 'Expand all'),
      h('button', { class: 'link-btn', onclick: () => setAll(false) }, 'Collapse'),
      h('button', { class: 'link-btn', onclick: () => copy(JSON.stringify(value, null, 2), 'JSON copied') }, 'Copy'),
    ),
    body,
  );
}

/** Compact one-line value for tables and the privacy lens. */
export function inlineValue(v, { max = 140 } = {}) {
  if (v === undefined) return h('span', { class: 'j-null' }, 'undefined');
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'string' && v.length > max) return h('span', { class: 'j-str', title: v }, JSON.stringify(`${v.slice(0, max)}…`));
    return scalar(v);
  }
  const text = JSON.stringify(v);
  const el = h('span', { class: 'j-obj', title: text.length > max ? JSON.stringify(v, null, 2).slice(0, 2000) : null });
  el.innerHTML = highlightJson(text.length > max ? `${text.slice(0, max)}…` : text, 0);
  return el;
}

// ---- clipboard, toasts ---------------------------------------------------------------

export async function copy(text, message = 'Copied') {
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
  toast(message);
}

let toastHost;
/** A short, single line notice, bottom left. Errors and actions stay a little longer. */
export function toast(message, { tone = 'info', action, timeout } = {}) {
  toastHost ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  let timer;
  const close = () => {
    clearTimeout(timer);
    el.classList.add('out');
    setTimeout(() => el.remove(), 130);
  };
  const el = h(
    'div',
    { class: ['toast', `toast-${tone}`] },
    tone === 'error' || tone === 'warn' ? h('span', { class: `dot dot-${tone === 'error' ? 'red' : 'amber'}` }) : null,
    h('span', { class: 'toast-text' }, message),
    action ? h('button', { class: 'toast-action', onclick: () => (action.run(), close()) }, action.label) : null,
  );
  const ms = timeout ?? (action || tone === 'error' ? 6000 : 3000);
  const arm = () => (timer = setTimeout(close, ms));
  el.addEventListener('mouseenter', () => clearTimeout(timer));
  el.addEventListener('mouseleave', arm);
  toastHost.append(el);
  while (toastHost.children.length > 3) toastHost.firstChild.remove();
  arm();
  return close;
}

// ---- tooltips ------------------------------------------------------------------------

let tipEl;
/** Lightweight hover tooltip that follows the pointer. content(): string | Node. */
export function hoverTip(el, content) {
  const move = (e) => {
    const r = tipEl.getBoundingClientRect();
    let x = e.clientX + 12;
    let y = e.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = e.clientX - r.width - 12;
    if (y + r.height > window.innerHeight - 8) y = e.clientY - r.height - 10;
    tipEl.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  };
  el.addEventListener('mouseenter', (e) => {
    tipEl ??= document.body.appendChild(h('div', { class: 'tip', role: 'tooltip' }));
    mount(tipEl, content());
    tipEl.hidden = false;
    move(e);
  });
  el.addEventListener('mousemove', (e) => tipEl && move(e));
  el.addEventListener('mouseleave', () => tipEl && (tipEl.hidden = true));
}

export function hideTip() {
  if (tipEl) tipEl.hidden = true;
}

// ---- small building blocks ---------------------------------------------------------

/** Empty state: one muted line, optionally the exact command to run. */
export function empty(text, { code, action } = {}) {
  return h(
    'div',
    { class: 'empty' },
    h('span', null, richText(text)),
    code ? h('span', { class: 'empty-code' }, h('code', null, code), h('button', { class: 'icon-btn sm', 'aria-label': 'Copy command', title: 'Copy', onclick: () => copy(code) }, icon('copy', 13))) : null,
    action ? h('button', { class: 'link-btn', onclick: action.run }, action.label) : null,
  );
}

export function loading(text = 'Loading') {
  return h('div', { class: 'empty loading' }, `${text}…`);
}

export function errorBox(err) {
  return h('div', { class: 'empty is-error' }, err?.message ?? String(err));
}

/** The one toolbar row every panel starts with: name, then filters and actions inline. */
export function bar(title, ...kids) {
  return h('header', { class: 'bar' }, h('h1', { class: 'bar-title' }, title), kids);
}

export function searchBox({ placeholder = 'Filter', value = '', oninput, label = 'Filter', width }) {
  const input = h('input', { class: 'input search-input', type: 'search', placeholder, value, 'aria-label': label, 'data-filter': '', spellcheck: false, autocomplete: 'off', style: width ? { width: `${width}px` } : null });
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
  return h('label', { class: 'search' }, input, h('kbd', { 'aria-hidden': 'true' }, '/'));
}

/** Text toggles (one active). options: [{ value, label, count?, title? }] */
export function segmented(options, value, onchange, label = 'Options') {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': label });
  const render = (current) => {
    clear(wrap);
    for (const o of options) {
      wrap.append(
        h(
          'button',
          { type: 'button', class: 'seg-btn', 'aria-pressed': String(o.value === current), title: o.title ?? null, onclick: () => (render(o.value), onchange(o.value)) },
          o.label,
          o.count != null ? h('span', { class: ['seg-count', o.tone && `t-${o.tone}`] }, o.count) : null,
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
          { class: 'tab', role: 'tab', 'aria-selected': String(t.id === current), tabindex: t.id === current ? '0' : '-1', onclick: () => (render(t.id), onchange(t.id)) },
          t.label,
          t.count != null && t.count !== '' ? h('span', { class: ['tab-count', t.tone && `t-${t.tone}`] }, t.count) : null,
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
    let top = r.bottom + 4;
    if (top + pop.offsetHeight > window.innerHeight - 8) top = Math.max(8, r.top - pop.offsetHeight - 4);
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
  return h('div', { class: 'picker' }, h('div', { class: 'picker-search' }, input), list);
}

/** Users from /users as picker options: name, email, roles. No avatars. */
export function userOption(u) {
  const roles = (u.roles ?? []).filter((r) => r !== 'user');
  return h(
    'span',
    { class: 'user-opt' },
    h('span', { class: 'user-opt-name' }, u.name ?? u.id),
    h('span', { class: 'user-opt-sub' }, u.id ? u.email ?? u.id : u.sub ?? 'No session'),
    h('span', { class: 'user-opt-meta' }, [roles.join(', '), u.status && u.status !== 'active' ? h('span', { class: 't-red' }, u.status) : null].filter(Boolean).map((x, i) => [i ? ' · ' : '', x])),
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
