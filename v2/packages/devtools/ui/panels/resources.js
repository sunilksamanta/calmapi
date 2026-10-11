// Resources: a relationship diagram from ref fields, then one section per resource with
// its policies and a dense field table.

import { h, s, mount, policyText, fileLink, empty, bar, plural, joined } from '../lib.js';
import { store } from '../store.js';

const ACTIONS = ['list', 'read', 'create', 'update', 'delete'];

export default {
  id: 'resources',
  label: 'Resources',
  badge: () => ({ text: store.overview?.resources.length ?? '' }),
  mount: mountResources,
};

const FLAG_HINT = {
  hidden: 'Stored, never returned by the API',
  writeOnly: 'Accepted on input, never returned',
  readOnly: 'Returned, but clients cannot set it',
  immutable: 'Can be set on create, never changed after',
  unique: 'Unique index',
  filterable: 'Usable in ?field= filters',
  sortable: 'Usable in ?sort=',
  searchable: 'Matched by ?q= search',
  owner: 'Set from the session; powers the owner policy',
  populate: 'Populated by default',
  required: 'Required on create',
};
const FLAG_ORDER = ['required', 'unique', 'readOnly', 'immutable', 'owner', 'filterable', 'sortable', 'searchable', 'populate'];

function mountResources(root, params) {
  const body = h('div', { class: 'scroll res-scroll' });
  const jump = h('nav', { class: 'bar-links', 'aria-label': 'Jump to resource' });

  function render() {
    const ov = store.overview;
    mount(jump, ov.resources.map((r) => h('a', { href: `#/resources/${r.name}` }, r.name)));
    if (!ov.resources.length) return mount(body, empty('No resources yet. Create one:', { code: 'npx calm make resource post' }));
    mount(body, h('section', { class: 'res-diagram', 'aria-label': 'Relationships' }, diagram(ov)), ov.resources.map((r) => resourceSection(r, ov)));
  }

  function focus(name) {
    if (!name) return;
    const sec = body.querySelector(`#res-${CSS.escape(name)}`);
    if (!sec) return;
    sec.scrollIntoView({ block: 'start' });
    for (const x of body.querySelectorAll('.res.target')) x.classList.remove('target');
    sec.classList.add('target');
  }

  mount(root, h('div', { class: 'panel' }, bar('Resources', jump), body));
  render();
  requestAnimationFrame(() => focus(params[0]));
  return { update: (p) => focus(p[0]), refresh: render };
}

// ---- sections ----------------------------------------------------------------------

function resourceSection(r, ov) {
  const appRoot = ov.app.root;
  const resFile = r.files?.resource;
  return h(
    'section',
    { class: 'res', id: `res-${r.name}` },
    h(
      'header',
      { class: 'res-head' },
      h('h2', { class: 'res-name' }, r.name),
      h('span', { class: 'res-facts' }, joined([
        h('span', { class: 'mono' }, r.path),
        h('span', null, h('span', { class: 'muted' }, 'collection '), h('span', { class: 'mono' }, r.collection)),
        r.ownerField ? h('span', { title: 'The owner policy compares this field with the signed-in user' }, h('span', { class: 'muted' }, 'owner '), h('span', { class: 'mono' }, r.ownerField)) : null,
      ])),
      h('span', { class: 'spacer' }),
      resFile ? fileLink(appRoot, resFile) : null,
      h('a', { class: 'btn ghost', href: `#/data/${r.name}` }, 'Browse data'),
    ),
    h(
      'dl',
      { class: 'res-policy' },
      ACTIONS.map((a) => {
        const defaulted = r.defaultedPolicies?.includes(a);
        return h('div', { class: 'res-policy-item' }, h('dt', null, a), h('dd', null, policyText(r.policy[a], { explicit: !defaulted, title: defaulted ? `Defaulted to "${r.policy[a]}". Write policy.${a} out so the intent is visible.` : null })));
      }),
    ),
    fieldsTable(r, ov),
  );
}

function fieldsTable(r, ov) {
  const head = h('tr', null, ['Field', 'Type', 'Values', 'Flags', 'Access'].map((t) => h('th', { scope: 'col' }, t)));
  const rows = r.fields.map((f) => {
    const details = [];
    if (f.ref) {
      const known = ov.resources.some((x) => x.name === f.ref);
      details.push(known ? h('a', { class: 'mono', href: `#/resources/${f.ref}`, title: `References ${f.ref}` }, `→ ${f.ref}`) : h('span', { class: 'mono t-red', title: 'Unknown resource' }, `→ ${f.ref}?`));
    }
    if (f.values) details.push(h('span', { class: 'mono' }, f.values.map(String).join(' | ')));
    if (f.default != null && !(Array.isArray(f.default) && !f.default.length && f.values)) details.push(h('span', null, h('span', { class: 'muted' }, 'default '), h('span', { class: 'mono' }, typeof f.default === 'string' ? f.default : JSON.stringify(f.default))));
    const special = f.flags.filter((fl) => fl === 'hidden' || fl === 'writeOnly');
    const plain = FLAG_ORDER.filter((fl) => f.flags.includes(fl));
    const access = [];
    if (!f.output) access.push(h('span', { class: 't-red', title: 'This field never leaves the server' }, 'never returned'));
    if (f.visibleTo) access.push(h('span', null, h('span', { class: 'muted' }, 'visible to '), policyText(f.visibleTo)));
    if (f.writableBy) access.push(h('span', null, h('span', { class: 'muted' }, 'writable by '), policyText(f.writableBy)));
    if (!access.length) access.push(h('span', { class: 'muted' }, f.input ? 'read, write' : 'read only'));
    return h(
      'tr',
      { class: !f.output ? 'is-private' : null },
      h('td', { class: 'mono strong' }, f.name),
      h('td', { class: 'mono muted' }, f.type),
      h('td', null, joined(details)),
      h(
        'td',
        { class: 'fd-flags' },
        special.map((fl) => h('span', { class: 'badge', title: FLAG_HINT[fl] }, fl === 'writeOnly' ? 'write-only' : fl)),
        h('span', { class: 'muted' }, joined(plain.map((fl) => h('span', { title: FLAG_HINT[fl] ?? fl }, fl)))),
      ),
      h('td', null, joined(access, ', ')),
    );
  });
  return h(
    'table',
    { class: 'tbl fields' },
    h('caption', { class: 'sr-only' }, `${r.name} fields`),
    h('thead', null, head),
    h('tbody', null, rows),
    h('tfoot', null, h('tr', null, h('td', { colspan: '5', class: 'muted' }, `${plural(r.fields.length, 'field')}, plus id, createdAt and updatedAt.`))),
  );
}

// ---- diagram -----------------------------------------------------------------------

const W = 148;
const H = 40;
const GAP_X = 120;
const GAP_Y = 22;
const PAD = 20;

function diagram(ov) {
  const edges = [];
  for (const r of ov.resources) for (const f of r.fields) if (f.ref) edges.push({ from: r.name, to: f.ref, field: f.name, many: f.type.endsWith('[]') });
  const nodes = new Map(ov.resources.map((r) => [r.name, { name: r.name, res: r }]));
  for (const e of edges) if (!nodes.has(e.to)) nodes.set(e.to, { name: e.to, missing: true });

  const memo = new Map();
  const depth = (n, seen = new Set()) => {
    if (memo.has(n)) return memo.get(n);
    if (seen.has(n)) return 0;
    seen.add(n);
    const outs = edges.filter((e) => e.from === n && e.to !== n);
    const d = outs.length ? 1 + Math.max(...outs.map((e) => depth(e.to, seen))) : 0;
    seen.delete(n);
    memo.set(n, d);
    return d;
  };
  const maxD = Math.max(0, ...[...nodes.keys()].map((n) => depth(n)));
  const cols = Array.from({ length: maxD + 1 }, () => []);
  const degree = (n) => edges.filter((e) => e.from === n || e.to === n).length;
  for (const n of nodes.keys()) cols[maxD - depth(n)].push(n);
  cols.forEach((c) => c.sort((a, b) => degree(b) - degree(a) || a.localeCompare(b)));

  const colOf = (n) => maxD - depth(n);
  // Edges that skip a column would cross the nodes in between: they get a lane above.
  const longEdges = edges.filter((e) => e.from !== e.to && Math.abs(colOf(e.from) - colOf(e.to)) > 1);
  const laneSpace = longEdges.length ? longEdges.length * 16 + 12 : 0;
  const tallest = Math.max(...cols.map((c) => c.length));
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * GAP_X + 30;
  const height = PAD * 2 + laneSpace + tallest * H + (tallest - 1) * GAP_Y;
  const pos = new Map();
  cols.forEach((c, ci) => {
    const colH = c.length * H + (c.length - 1) * GAP_Y;
    const top = PAD + laneSpace + (tallest * H + (tallest - 1) * GAP_Y - colH) / 2;
    c.forEach((n, ri) => pos.set(n, { x: PAD + ci * (W + GAP_X), y: top + ri * (H + GAP_Y), col: ci }));
  });

  // spread anchors when several edges share a side
  const sideCount = new Map();
  const sideIndex = new Map();
  const sideKey = (n, side) => `${n}:${side}`;
  const plan = edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    const kind = e.from === e.to ? 'self' : a.col < b.col ? 'fwd' : a.col > b.col ? 'back' : 'same';
    const out = kind === 'back' ? 'left' : 'right';
    const inn = kind === 'fwd' ? 'left' : 'right';
    return { ...e, a, b, kind, out, inn };
  });
  // Lane edges leave and enter through the top of the nodes, so direct edges stay straight.
  const isLong = (p) => longEdges.some((e) => e.from === p.from && e.to === p.to && e.field === p.field);
  for (const p of plan) {
    if (isLong(p)) continue;
    for (const k of [sideKey(p.from, p.out), sideKey(p.to, p.inn)]) sideCount.set(k, (sideCount.get(k) ?? 0) + 1);
  }
  const offset = (n, side) => {
    const k = sideKey(n, side);
    const i = sideIndex.get(k) ?? 0;
    sideIndex.set(k, i + 1);
    const total = sideCount.get(k);
    return (i - (total - 1) / 2) * 10;
  };

  const svg = s('svg', { class: 'diagram', viewBox: `0 0 ${width} ${height}`, width: '100%', role: 'img', 'aria-label': `Resource relationships: ${edges.map((e) => `${e.from}.${e.field} references ${e.to}`).join('; ') || 'no references'}` });
  svg.style.maxWidth = `${width}px`;
  const defs = s('defs', null, s('marker', { id: 'dg-arrow', viewBox: '0 0 8 8', refX: 7.5, refY: 4, markerWidth: 7, markerHeight: 7, markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' }, s('path', { d: 'M0,0.5 L7.5,4 L0,7.5', class: 'dg-head' })));
  const edgeLayer = s('g', { class: 'dg-edges' });
  const labelLayer = s('g', { class: 'dg-labels' });
  const nodeLayer = s('g', { class: 'dg-nodes' });
  svg.append(defs, edgeLayer, nodeLayer, labelLayer);

  for (const p of plan) {
    const { a, b } = p;
    const lane = longEdges.findIndex((e) => e.from === p.from && e.to === p.to && e.field === p.field);
    const oy = lane >= 0 ? 0 : offset(p.from, p.out);
    const iy = lane >= 0 ? 0 : offset(p.to, p.inn);
    let d;
    let mid;
    if (p.kind === 'self') {
      const x = a.x + W;
      const y1 = a.y + H / 2 - 8;
      const y2 = a.y + H / 2 + 8;
      d = `M${x},${y1} C${x + 44},${y1 - 26} ${x + 44},${y2 + 26} ${x},${y2}`;
      mid = { x: x + 36, y: a.y + H / 2 };
    } else {
      const x1 = p.out === 'right' ? a.x + W : a.x;
      const y1 = a.y + H / 2 + oy;
      const x2 = p.inn === 'left' ? b.x : b.x + W;
      const y2 = b.y + H / 2 + iy;
      if (lane >= 0) {
        const yL = PAD + 4 + lane * 16;
        const dir = p.kind === 'back' ? -1 : 1;
        const r = 6;
        const sx = a.x + W / 2 + dir * (W / 4) - lane * 8 * dir;
        const tx = b.x + W / 2 - dir * (W / 4) + lane * 8 * dir;
        d = `M${sx},${a.y} L${sx},${yL + r} Q${sx},${yL} ${sx + dir * r},${yL} L${tx - dir * r},${yL} Q${tx},${yL} ${tx},${yL + r} L${tx},${b.y}`;
        mid = { x: (sx + tx) / 2, y: yL };
      } else if (p.kind === 'fwd' || p.kind === 'back') {
        const dx = (x2 - x1) / 2;
        d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
        mid = { x: (x1 + x2) / 2, y: (y1 + y2) / 2 };
      } else {
        const bulge = 50 + Math.abs(y2 - y1) * 0.15;
        d = `M${x1},${y1} C${x1 + bulge},${y1} ${x2 + bulge},${y2} ${x2},${y2}`;
        mid = { x: x1 + bulge * 0.75, y: (y1 + y2) / 2 };
      }
    }
    edgeLayer.append(s('path', { d, class: ['dg-edge', b.missing && 'missing'].filter(Boolean).join(' '), 'marker-end': 'url(#dg-arrow)', 'data-from': p.from, 'data-to': p.to }));
    labelLayer.append(s('text', { x: mid.x, y: mid.y - 5, class: 'dg-label', 'text-anchor': 'middle', 'data-from': p.from, 'data-to': p.to }, `${p.field}${p.many ? '[]' : ''}`));
  }

  for (const [name, n] of nodes) {
    const p = pos.get(name);
    const sub = n.missing ? 'unknown resource' : `${n.res.collection} · ${plural(n.res.fields.length, 'field')}`;
    const g = s(
      'g',
      { class: ['dg-node', n.missing && 'missing'].filter(Boolean).join(' '), transform: `translate(${p.x},${p.y})`, tabindex: n.missing ? null : '0', role: n.missing ? null : 'link', 'aria-label': n.missing ? null : `Resource ${name}` },
      s('rect', { x: 0.5, y: 0.5, width: W - 1, height: H - 1, rx: 3, class: 'dg-box' }),
      s('text', { x: 10, y: 17, class: 'dg-name' }, name),
      s('text', { x: 10, y: 31, class: 'dg-sub' }, sub),
    );
    if (!n.missing) {
      const go = () => (location.hash = `#/resources/${name}`);
      g.addEventListener('click', go);
      g.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), go()));
      const hl = (on) => {
        svg.classList.toggle('dim', on);
        for (const el of svg.querySelectorAll(`[data-from="${name}"], [data-to="${name}"]`)) el.classList.toggle('hl', on);
        g.classList.toggle('hl', on);
      };
      g.addEventListener('mouseenter', () => hl(true));
      g.addEventListener('mouseleave', () => hl(false));
      g.addEventListener('focus', () => hl(true));
      g.addEventListener('blur', () => hl(false));
    }
    nodeLayer.append(g);
  }

  if (!edges.length) return h('div', null, svg, h('p', { class: 'muted' }, 'No ref fields yet. Link resources with ', h('code', null, "f.ref('user')"), '.'));
  return svg;
}
