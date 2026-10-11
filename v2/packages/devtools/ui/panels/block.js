// Block panels: blocks register them with calm.devtools.panel(name, fn). The data is
// arbitrary JSON, rendered generically: arrays of objects as tables, the rest as a tree.

import { h, icon, mount, api, inlineValue, jsonViewer, empty, loading, errorBox, panelHead, plural, clock, relTime } from '../lib.js';

const title = (name) => name.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export function blockPanel(name) {
  return {
    id: `panel:${name}`,
    label: title(name),
    icon: 'blocks',
    mount: (root) => mountBlock(root, name),
  };
}

const isPlainObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function table(rows, caption) {
  const keys = [];
  for (const r of rows) for (const k of Object.keys(r)) if (!keys.includes(k)) keys.push(k);
  const cols = keys.slice(0, 14);
  return h(
    'div',
    { class: 'gt-wrap' },
    h(
      'table',
      { class: 'gt' },
      caption ? h('caption', null, caption) : null,
      h('thead', null, h('tr', null, cols.map((k) => h('th', { scope: 'col' }, k)))),
      h('tbody', null, rows.map((r) => h('tr', null, cols.map((k) => h('td', null, k in r ? cell(r[k]) : h('span', { class: 'muted' }, '')))))),
    ),
  );
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;

function cell(v) {
  if (typeof v === 'string') {
    if (ISO.test(v) && !Number.isNaN(Date.parse(v))) return h('span', { title: v }, clock(v), h('span', { class: 'muted' }, ` · ${relTime(v)}`));
    return h('span', { class: 'gt-text', title: v.length > 60 ? v : null }, v);
  }
  if (typeof v === 'number') return h('span', { class: 'num' }, String(v));
  if (typeof v === 'boolean') return h('span', { class: v ? 't-green-text' : 'muted' }, String(v));
  if (v == null) return h('span', { class: 'muted' }, 'null');
  return inlineValue(v, { max: 80 });
}

const isScalar = (v) => v == null || typeof v !== 'object';
const kvList = (entries) => h('dl', { class: 'kv block-kv' }, entries.map(([k, v]) => [h('dt', null, k), h('dd', null, cell(v))]));

function nested(v) {
  if (Array.isArray(v)) {
    if (!v.length) return h('p', { class: 'muted small' }, 'Empty');
    if (v.every(isPlainObject)) return table(v);
    if (v.every(isScalar)) return h('div', { class: 'enum' }, v.map((x) => h('span', { class: 'enum-v' }, String(x))));
  } else if (Object.values(v).every(isScalar)) {
    return h('section', { class: 'card block-facts' }, kvList(Object.entries(v)));
  }
  return jsonViewer(v, { open: 2 });
}

export function renderGeneric(data) {
  if (Array.isArray(data)) {
    if (!data.length) return empty({ icon: 'blocks', title: 'Nothing here yet', hint: 'This panel returned an empty list.' });
    if (data.every(isPlainObject)) return table(data, plural(data.length, 'row'));
    return jsonViewer(data, { open: 2 });
  }
  if (isPlainObject(data)) {
    const entries = Object.entries(data);
    const scalars = entries.filter(([, v]) => !v || typeof v !== 'object');
    return h(
      'div',
      { class: 'stack' },
      scalars.length ? h('section', { class: 'card block-facts' }, kvList(scalars)) : null,
      entries.filter(([, v]) => v && typeof v === 'object').map(([k, v]) => h('section', { class: 'sect' }, h('h3', null, k, Array.isArray(v) ? h('span', { class: 'muted' }, ` ${v.length}`) : null), nested(v))),
    );
  }
  return h('pre', { class: 'code' }, JSON.stringify(data, null, 2));
}

function mountBlock(root, name) {
  const body = h('div', { class: 'panel-body' });
  let timer = null;
  const autoBtn = h('button', { class: 'btn ghost', 'aria-pressed': 'false', onclick: () => setAuto(!timer) });

  async function load(quiet) {
    if (!quiet) mount(body, loading(`Loading ${name}`));
    try {
      const data = await api(`/panels/${encodeURIComponent(name)}`);
      mount(body, renderGeneric(data));
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  function setAuto(on) {
    clearInterval(timer);
    timer = on ? setInterval(() => load(true), 3000) : null;
    autoBtn.setAttribute('aria-pressed', String(on));
    mount(autoBtn, icon(on ? 'pause' : 'play', 13), on ? 'Auto refresh on' : 'Auto refresh');
  }

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      panelHead({
        title: title(name),
        sub: h('span', null, 'Provided by a block with ', h('code', null, `calm.devtools.panel('${name}', fn)`)),
        actions: [autoBtn, h('button', { class: 'btn', onclick: () => load() }, icon('refresh', 14), 'Refresh')],
      }),
      body,
    ),
  );
  setAuto(false);
  load();
  return { destroy: () => clearInterval(timer), refresh: () => load(true) };
}
