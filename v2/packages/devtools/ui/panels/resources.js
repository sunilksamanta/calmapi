// Resources: a relationship diagram from ref fields, then one card per resource with
// its policies and fields.

import { h, s, icon, mount, policyBadges, fileLink, empty, panelHead, plural } from '../lib.js';
import { store } from '../store.js';

const ACTIONS = ['list', 'read', 'create', 'update', 'delete'];

export default {
  id: 'resources',
  label: 'Resources',
  icon: 'layers',
  badge: () => ({ text: store.overview?.resources.length ?? '' }),
  mount: mountResources,
};

const FLAG_TONE = {
  required: 'strong', unique: 'blue', hidden: 'red', writeOnly: 'red', readOnly: 'gray', immutable: 'gray',
  filterable: 'teal', sortable: 'teal', searchable: 'teal', owner: 'blue', populate: 'purple',
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

function mountResources(root, params) {
  const body = h('div', { class: 'panel-body res-body' });

  function render() {
    const ov = store.overview;
    if (!ov.resources.length) {
      return mount(body, empty({ icon: 'layers', title: 'No resources yet', hint: 'A resource is a model, its API and its rules in one file.', code: 'npx calm make resource post' }));
    }
    mount(
      body,
      h(
        'section',
        { class: 'card diagram-card' },
        h('header', { class: 'card-head' }, h('span', { class: 'card-icon' }, icon('link', 15)), h('h2', { class: 'card-title' }, 'Relationships'), h('span', { class: 'muted small' }, 'From ref fields. Click a resource to jump to it.')),
        h('div', { class: 'diagram-wrap' }, diagram(ov)),
      ),
      h('nav', { class: 'res-index', 'aria-label': 'Resources' }, ov.resources.map((r) => h('a', { href: `#/resources/${r.name}`, class: 'chip-btn' }, icon('layers', 12), r.name, h('span', { class: 'muted num' }, r.fields.length)))),
      ov.resources.map((r) => resourceCard(r, ov)),
    );
  }

  function focus(name) {
    if (!name) return;
    const card = body.querySelector(`#res-${CSS.escape(name)}`);
    if (!card) return;
    card.scrollIntoView({ block: 'start', behavior: 'smooth' });
    card.classList.remove('flash');
    void card.offsetWidth;
    card.classList.add('flash');
  }

  mount(root, h('div', { class: 'panel' }, panelHead({ title: 'Resources', sub: 'Your models, their API rules and how they relate. Defined in app/resources.' }), body));
  render();
  requestAnimationFrame(() => focus(params[0]));
  return { update: (p) => focus(p[0]), refresh: render };
}

// ---- cards -------------------------------------------------------------------------

function resourceCard(r, ov) {
  const root = ov.app.root;
  const files = Object.entries(r.files ?? {}).filter(([, f]) => f);
  return h(
    'section',
    { class: 'card res-card', id: `res-${r.name}` },
    h(
      'header',
      { class: 'res-head' },
      h(
        'div',
        { class: 'res-title-row' },
        h('span', { class: 'res-mark', style: { '--h': 168 } }, r.name[0].toUpperCase()),
        h('h2', { class: 'res-name' }, r.name),
        h('span', { class: 'mono res-path' }, r.path),
        h('span', { class: 'spacer' }),
        h('a', { class: 'btn xs', href: `#/data/${r.name}` }, icon('database', 12), 'Browse data'),
      ),
      h(
        'div',
        { class: 'res-facts' },
        h('span', null, h('span', { class: 'muted' }, 'collection '), h('code', null, r.collection)),
        r.ownerField ? h('span', { title: 'The owner policy compares this field with the signed-in user' }, h('span', { class: 'muted' }, 'owner field '), h('code', null, r.ownerField)) : null,
        files.map(([kind, f]) => h('span', { class: 'res-file' }, h('span', { class: 'muted' }, `${kind} `), fileLink(root, f, { label: f.split('/').pop() }))),
      ),
    ),
    h(
      'div',
      { class: 'res-policies' },
      ACTIONS.map((a) => {
        const defaulted = r.defaultedPolicies?.includes(a);
        return h('div', { class: 'res-policy' }, h('span', { class: 'res-policy-label' }, a), policyBadges(r.policy[a], { explicit: !defaulted, title: defaulted ? `Defaulted to "${r.policy[a]}". Write policy.${a} out so the intent is visible.` : null }));
      }),
    ),
    fieldsTable(r, ov),
  );
}

function fieldsTable(r, ov) {
  const head = h('div', { class: 'fd-row fd-head', role: 'row' }, ['Field', 'Type', 'Values', 'Flags', 'Access'].map((t) => h('span', { role: 'columnheader' }, t)));
  const rows = r.fields.map((f) => {
    const details = [];
    if (f.ref) {
      const known = ov.resources.some((x) => x.name === f.ref);
      details.push(known ? h('a', { class: 'ref-link', href: `#/resources/${f.ref}` }, icon('arrowRight', 12), f.ref) : h('span', { class: 'badge t-red', title: 'Unknown resource' }, `${f.ref}?`));
    }
    if (f.values) details.push(h('span', { class: 'enum' }, f.values.map((v) => h('span', { class: 'enum-v' }, String(v)))));
    if (f.default != null && !(Array.isArray(f.default) && !f.default.length && f.values)) details.push(h('span', { class: 'fd-default' }, h('span', { class: 'muted' }, 'default '), h('code', null, typeof f.default === 'string' ? f.default : JSON.stringify(f.default))));
    const flags = f.flags.map((fl) => h('span', { class: ['flag', `t-${FLAG_TONE[fl] ?? 'gray'}`], title: FLAG_HINT[fl] ?? fl }, fl === 'hidden' || fl === 'writeOnly' ? icon('eyeOff', 11) : null, fl));
    const access = [];
    if (!f.output) access.push(h('span', { class: 'access never', title: 'This field never leaves the server' }, icon('lock', 11), 'never returned'));
    if (f.visibleTo) access.push(h('span', { class: 'access' }, h('span', { class: 'muted' }, 'visible to'), policyBadges(f.visibleTo)));
    if (f.writableBy) access.push(h('span', { class: 'access' }, h('span', { class: 'muted' }, 'writable by'), policyBadges(f.writableBy)));
    if (!access.length) access.push(h('span', { class: 'muted small' }, f.input ? 'read, write' : 'read'));
    return h(
      'div',
      { class: ['fd-row', !f.output && 'is-private'], role: 'row' },
      h('span', { class: 'fd-name', role: 'cell' }, h('code', null, f.name), h('span', { class: 'io', title: `${f.output ? 'Returned' : 'Not returned'}, ${f.input ? 'accepted on input' : 'not accepted on input'}` }, h('span', { class: ['io-dot', f.output && 'on'] }, 'R'), h('span', { class: ['io-dot', f.input && 'on'] }, 'W'))),
      h('span', { class: 'fd-type mono', role: 'cell' }, f.type),
      h('span', { class: 'fd-details', role: 'cell' }, details),
      h('span', { class: 'fd-flags', role: 'cell' }, flags),
      h('span', { class: 'fd-access', role: 'cell' }, access),
    );
  });
  return h('div', { class: 'fd-table', role: 'table', 'aria-label': `${r.name} fields` }, head, rows, h('div', { class: 'fd-foot' }, `Plus id, createdAt and updatedAt on every document. ${plural(r.fields.length, 'field')} defined.`));
}

// ---- diagram -----------------------------------------------------------------------

const W = 176;
const H = 60;
const GAP_X = 150;
const GAP_Y = 26;
const PAD = 24;

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
  const laneSpace = longEdges.length ? longEdges.length * 16 + 20 : 0;
  const tallest = Math.max(...cols.map((c) => c.length));
  const width = PAD * 2 + cols.length * W + (cols.length - 1) * GAP_X + 40;
  const height = PAD * 2 + laneSpace + tallest * H + (tallest - 1) * GAP_Y + 10;
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
  // Lane edges leave and arrive at the top anchors so they never cross the direct ones.
  const isLong = (p) => longEdges.some((e) => e.from === p.from && e.to === p.to && e.field === p.field);
  plan.sort((x, y) => Number(isLong(y)) - Number(isLong(x)));
  for (const p of plan) {
    for (const k of [sideKey(p.from, p.out), sideKey(p.to, p.inn)]) sideCount.set(k, (sideCount.get(k) ?? 0) + 1);
  }
  const offset = (n, side) => {
    const k = sideKey(n, side);
    const i = sideIndex.get(k) ?? 0;
    sideIndex.set(k, i + 1);
    const total = sideCount.get(k);
    return (i - (total - 1) / 2) * 14;
  };

  const svg = s('svg', { class: 'diagram', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img', 'aria-label': `Resource relationships: ${edges.map((e) => `${e.from}.${e.field} references ${e.to}`).join('; ') || 'no references'}` });
  svg.style.maxWidth = `${width}px`;
  const defs = s('defs', null, s('marker', { id: 'dg-arrow', viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, s('path', { d: 'M0,1 L9,5 L0,9 z', class: 'dg-head' })));
  const edgeLayer = s('g', { class: 'dg-edges' });
  const labelLayer = s('g', { class: 'dg-labels' });
  const nodeLayer = s('g', { class: 'dg-nodes' });
  svg.append(defs, edgeLayer, nodeLayer, labelLayer);

  for (const p of plan) {
    const { a, b } = p;
    const oy = offset(p.from, p.out);
    const iy = offset(p.to, p.inn);
    let d;
    let mid;
    if (p.kind === 'self') {
      const x = a.x + W;
      const y1 = a.y + H / 2 - 10;
      const y2 = a.y + H / 2 + 10;
      d = `M${x},${y1} C${x + 56},${y1 - 34} ${x + 56},${y2 + 34} ${x},${y2}`;
      mid = { x: x + 44, y: a.y + H / 2 };
    } else {
      const x1 = p.out === 'right' ? a.x + W : a.x;
      const y1 = a.y + H / 2 + oy;
      const x2 = p.inn === 'left' ? b.x : b.x + W;
      const y2 = b.y + H / 2 + iy;
      let c1x;
      let c2x;
      const lane = longEdges.findIndex((e) => e.from === p.from && e.to === p.to && e.field === p.field);
      if (lane >= 0) {
        const yL = PAD + 4 + lane * 16;
        const dir = p.kind === 'back' ? -1 : 1;
        const k = 46 * dir;
        d = `M${x1},${y1} C${x1 + k},${y1} ${x1 + k},${yL} ${x1 + 2 * k},${yL} L${x2 - 2 * k},${yL} C${x2 - k},${yL} ${x2 - k},${y2} ${x2},${y2}`;
        mid = { x: (x1 + x2) / 2, y: yL + 1 };
      } else {
        if (p.kind === 'fwd' || p.kind === 'back') {
          const dx = (x2 - x1) / 2;
          c1x = x1 + dx;
          c2x = x2 - dx;
        } else {
          const bulge = 60 + Math.abs(y2 - y1) * 0.15;
          c1x = x1 + bulge;
          c2x = x2 + bulge;
        }
        d = `M${x1},${y1} C${c1x},${y1} ${c2x},${y2} ${x2},${y2}`;
        mid = { x: (x1 + 3 * c1x + 3 * c2x + x2) / 8, y: (y1 + 3 * y1 + 3 * y2 + y2) / 8 };
      }
    }
    edgeLayer.append(s('path', { d, class: ['dg-edge', b.missing && 'missing'].filter(Boolean).join(' '), 'marker-end': 'url(#dg-arrow)', 'data-from': p.from, 'data-to': p.to }));
    labelLayer.append(s('text', { x: mid.x, y: mid.y - 6, class: 'dg-label', 'text-anchor': 'middle', 'data-from': p.from, 'data-to': p.to }, `${p.field}${p.many ? '[]' : ''}`));
  }

  for (const [name, n] of nodes) {
    const p = pos.get(name);
    const sub = n.missing ? 'unknown resource' : `${n.res.collection} · ${plural(n.res.fields.length, 'field')}`;
    const g = s(
      'g',
      { class: ['dg-node', n.missing && 'missing'].filter(Boolean).join(' '), transform: `translate(${p.x},${p.y})`, tabindex: n.missing ? null : '0', role: n.missing ? null : 'link', 'aria-label': n.missing ? null : `Resource ${name}` },
      s('rect', { width: W, height: H, rx: 10, class: 'dg-box' }),
      s('rect', { x: 12, y: 16, width: 28, height: 28, rx: 7, class: 'dg-mark' }),
      s('text', { x: 26, y: 35, 'text-anchor': 'middle', class: 'dg-mark-text' }, name[0].toUpperCase()),
      s('text', { x: 50, y: 28, class: 'dg-name' }, name),
      s('text', { x: 50, y: 45, class: 'dg-sub' }, sub),
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

  if (!edges.length) {
    return h('div', null, svg, h('p', { class: 'muted small center' }, 'No ref fields yet. Add one with ', h('code', null, "f.ref('user')"), ' to link resources.'));
  }
  return svg;
}
