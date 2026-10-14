// Block panels: blocks register them with calm.devtools.panel(name, fn). The data is
// arbitrary JSON, rendered generically: facts as a key/value grid, arrays of objects as
// dense tables, anything else as a JSON tree.

import { h, mount, api, inlineValue, jsonViewer, empty, loading, errorBox, bar, plural, clock, relTime, fullDate } from '../lib.js';

const title = (name) => name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function blockPanel(name) {
  return {
    id: `panel:${name}`,
    label: title(name),
    mount: (root) => mountBlock(root, name),
  };
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
const isScalar = (v) => v == null || typeof v !== 'object';
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const isNumericCol = (rows, k) => rows.every((r) => r[k] == null || typeof r[k] === 'number') && rows.some((r) => typeof r[k] === 'number');

function table(rows) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const cols = keys.slice(0, 14);
  const numeric = new Set(cols.filter((k) => isNumericCol(rows, k)));
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
      { class: 'tbl' },
      h('thead', null, h('tr', null, cols.map((k) => h('th', { scope: 'col', class: numeric.has(k) ? 'num' : null }, k)))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map((k) => h('td', { class: numeric.has(k) ? 'num' : null }, k in r ? cell(r[k], k) : null))))),
    ),
  );
}

function cell(v, key = '') {
  if (typeof v === 'string') {
    if (ISO.test(v) && !Number.isNaN(Date.parse(v))) return h('span', { class: 'mono', title: fullDate(v) }, clock(v), h('span', { class: 'muted' }, ` ${relTime(v)}`));
    if (key === 'status' || key === 'state') return h('span', { class: statusTone(v) }, v);
    if (/^[a-f0-9]{24}$/.test(v)) return h('span', { class: 'mono muted', title: v }, v.slice(-8));
    return h('span', { class: 'cell-text', title: v.length > 60 ? v : null }, v);
  }
  if (typeof v === 'number') return h('span', { class: 'mono' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: v ? null : 'muted' }, String(v));
  if (v == null) return h('span', { class: 'faint' }, 'null');
  return inlineValue(v, { max: 80 });
}

function statusTone(v) {
  const s = String(v).toLowerCase();
  if (/fail|error|dead|crash/.test(s)) return 't-red';
  if (/retry|wait|delay|pending|queued|running|active/.test(s)) return 't-amber';
  return null;
}

const kvList = (entries) => h('dl', { class: 'kv' }, entries.map(([k, v]) => [h('dt', null, k), h('dd', null, cell(v, k))]));

function nested(v) {
  if (Array.isArray(v)) {
    if (!v.length) return h('p', { class: 'muted' }, 'Empty');
    if (v.every(isPlainObject)) return table(v);
    if (v.every(isScalar)) return h('p', { class: 'mono' }, v.map(String).join(', '));
  } else if (Object.values(v).every(isScalar)) {
    return kvList(Object.entries(v));
  } else if (Object.values(v).every(isPlainObject) && Object.values(v).every((x) => Object.values(x).every(isScalar))) {
    return table(Object.entries(v).map(([k, x]) => ({ name: k, ...x })));
  }
  return jsonViewer(v, { open: 2 });
}

export function renderGeneric(data) {
  if (Array.isArray(data)) {
    if (!data.length) return empty('This panel returned an empty list.');
    if (data.every(isPlainObject)) return h('div', { class: 'stack' }, h('section', { class: 'sect' }, h('h3', { class: 'sect-title' }, plural(data.length, 'row')), table(data)));
    return h('div', { class: 'pad' }, jsonViewer(data, { open: 2 }));
  }
  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    const scalars = entries.filter(([, v]) => isScalar(v));
    return h(
      'div',
      { class: 'stack' },
      scalars.length ? h('section', { class: 'sect' }, kvList(scalars)) : null,
      entries.filter(([, v]) => !isScalar(v)).map(([k, v]) => h('section', { class: 'sect' }, h('h3', { class: 'sect-title' }, k, Array.isArray(v) ? h('span', { class: 'sect-note' }, v.length) : null), nested(v))),
    );
  }
  return h('pre', { class: 'code pad' }, JSON.stringify(data, null, 2));
}

function mountBlock(root, name) {
  const body = h('div', { class: 'scroll' });
  const updated = h('span', { class: 'bar-meta' });
  let timer = null;
  const autoBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': 'false', title: 'Refresh every 3 seconds', onclick: () => setAuto(!timer) }, 'Auto refresh');

  async function load(quiet) {
    if (!quiet) mount(body, loading(`Loading ${name}`));
    try {
      const data = await api(`/panels/${encodeURIComponent(name)}`);
      const top = body.scrollTop;
      mount(body, renderGeneric(data));
      body.scrollTop = top;
      updated.textContent = `Updated ${clock(Date.now())}`;
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  function setAuto(on) {
    clearInterval(timer);
    timer = on ? setInterval(() => load(true), 3000) : null;
    autoBtn.setAttribute('aria-pressed', String(on));
  }

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      bar(title(name), h('span', { class: 'bar-meta mono', title: 'Registered by a block with calm.devtools.panel(name, fn)' }, `panel('${name}')`), h('span', { class: 'spacer' }), updated, autoBtn, h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, 'Refresh')),
      body,
    ),
  );
  setAuto(false);
  load();
  return { destroy: () => clearInterval(timer), refresh: () => load(true) };
}
