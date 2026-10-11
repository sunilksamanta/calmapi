// Requests: live list (SSE) and a detail view with timeline, queries, request,
// response, logs and error tabs.

import {
  h, icon, mount, clear, api, fmtMs, relTime, clock, fullDate, methodChip, statusChip, avatar, STATUS_TEXT, statusTone,
  codeBlock, jsonViewer, empty, loading, errorBox, searchBox, segmented, tabs, copy, toast, plural, editorUrl, relPath, panelHead,
} from '../lib.js';
import { store, on, getRecord, clearRequests, authHeader, startActAs } from '../store.js';
import { logRow } from './logs.js';

const SLOW_MS = 300;
const MANY_QUERIES = 10;
const READS = new Set(['find', 'aggregate', 'count', 'distinct', 'getMore']);

const state = { filter: '', quick: 'all', mode: 'requests', tab: 'timeline', selected: null };

export default {
  id: 'requests',
  label: 'Requests',
  icon: 'activity',
  badge: () => {
    const errors = store.requests.filter((r) => r.status >= 500).length;
    return { text: store.requests.length || '', tone: errors ? 'red' : null };
  },
  mount: mountRequests,
};

function matches(r) {
  if (state.quick === 'errors' && !(r.status >= 400)) return false;
  if (state.quick === 'slow' && !(r.durationMs >= SLOW_MS)) return false;
  if (state.quick === 'heavy' && !(r.queries > MANY_QUERIES)) return false;
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => {
    if (/^[1-5]xx$/.test(term)) return String(r.status ?? '').startsWith(term[0]);
    const hay = `${r.method} ${r.path} ${r.route ?? ''} ${r.status ?? ''} ${r.user?.name ?? 'anonymous'} ${r.error ?? ''}`.toLowerCase();
    return hay.includes(term);
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

function pathEl(path) {
  const [p, qs] = String(path).split(/\?(.*)/s);
  return h('span', { class: 'path' }, p, qs ? h('span', { class: 'path-qs' }, `?${qs}`) : null);
}

function mountRequests(root, params) {
  let openId = params[0] ?? null;
  let maxDur = 1;
  const rows = new Map();

  const list = h('div', { class: 'rq-list', role: 'listbox', 'aria-label': 'Requests', tabindex: '0' });
  const stats = h('div', { class: 'rq-stats' });
  const detail = h('section', { class: 'rq-detail', 'aria-label': 'Request detail' });
  const listWrap = h('div', { class: 'rq-scroll' });
  const split = h('div', { class: 'rq-split' });

  const modeSeg = segmented(
    [
      { value: 'requests', label: 'Requests' },
      { value: 'background', label: 'Background queries', title: 'Queries that ran outside any request (jobs, startup, devtools itself)' },
    ],
    state.mode,
    (v) => {
      state.mode = v;
      renderList();
    },
    'Source',
  );

  const quickSeg = segmented(
    [
      { value: 'all', label: 'All' },
      { value: 'errors', label: 'Errors' },
      { value: 'slow', label: 'Slow', title: `${SLOW_MS} ms or more` },
      { value: 'heavy', label: 'N+1', title: `More than ${MANY_QUERIES} queries` },
    ],
    state.quick,
    (v) => {
      state.quick = v;
      renderList();
    },
    'Quick filter',
  );

  const toolbar = h(
    'div',
    { class: 'toolbar' },
    searchBox({ placeholder: 'Filter by path, status, user, error', value: state.filter, oninput: (v) => ((state.filter = v), renderList()) }),
    quickSeg,
  );

  const head = panelHead({
    title: 'Requests',
    sub: 'Every API call with its queries, logs and errors, live.',
    extra: modeSeg,
    actions: [
      h('button', { class: 'btn ghost', title: 'Clear all recorded requests', onclick: async () => { await clearRequests(); toast('Cleared all requests', { tone: 'ok' }); } }, icon('trash', 14), 'Clear all'),
    ],
  });

  const listPane = h(
    'section',
    { class: 'rq-list-pane' },
    toolbar,
    stats,
    h('div', { class: 'rq-row rq-head', 'aria-hidden': 'true' }, h('span', null, 'Method'), h('span', null, 'Path'), h('span', null, 'Status'), h('span', { class: 'right' }, 'Duration'), h('span', { class: 'rq-q-h' }, 'Queries'), h('span', { class: 'rq-user-h' }, 'User'), h('span', { class: 'right' }, 'When')),
    listWrap,
    h('footer', { class: 'list-foot' }, h('span', null, h('kbd', null, 'j'), h('kbd', null, 'k'), ' move'), h('span', null, h('kbd', null, 'Enter'), ' open'), h('span', null, h('kbd', null, 'Esc'), ' close'), h('span', null, h('kbd', null, '/'), ' filter')),
  );
  listWrap.append(list);
  split.append(listPane, detail);
  mount(root, h('div', { class: 'panel rq' }, head, split));

  // ---- list --------------------------------------------------------------------

  function renderStats(items) {
    const durs = items.map((r) => r.durationMs).filter((d) => d != null);
    const errors = items.filter((r) => r.status >= 400).length;
    const queries = items.reduce((n, r) => n + (r.queries ?? 0), 0);
    const stat = (label, value, tone) => h('div', { class: ['stat', tone && `t-${tone}`] }, h('span', { class: 'stat-label' }, label), h('span', { class: 'stat-value num' }, value));
    mount(
      stats,
      stat('Requests', items.length),
      stat('Errors', errors, errors ? 'amber' : null),
      stat('p50', durs.length ? fmtMs(percentile(durs, 50)) : '·'),
      stat('p95', durs.length ? fmtMs(percentile(durs, 95)) : '·'),
      stat('Queries / req', items.length ? (queries / items.length).toFixed(1) : '·'),
    );
  }

  function row(r) {
    const w = r.durationMs ? Math.max(4, (Math.log1p(r.durationMs) / Math.log1p(maxDur)) * 100) : 0;
    const el = h(
      'div',
      {
        class: ['rq-row', r.status >= 500 && 'is-5xx'],
        role: 'option',
        id: `rq-${r.id}`,
        'aria-selected': String(r.id === openId),
        dataset: { id: r.id },
        onclick: () => open(r.id),
      },
      methodChip(r.method),
      h('span', { class: 'rq-path', title: r.route ? `Route ${r.route}` : r.path }, pathEl(r.path), r.error ? h('span', { class: `rq-err t-${statusTone(r.status)}` }, r.error) : null),
      statusChip(r.status),
      h('span', { class: ['rq-dur', 'num', r.durationMs >= SLOW_MS && 'slow'], title: `${r.durationMs} ms total, ${r.queryMs} ms in MongoDB` }, h('span', { class: 'rq-dur-bar', style: { '--w': `${w}%` } }), h('span', { class: 'rq-dur-text' }, fmtMs(r.durationMs))),
      h('span', { class: ['rq-q', 'num', r.queries > MANY_QUERIES && 'warn'], title: r.queries > MANY_QUERIES ? `${r.queries} queries: likely an N+1 pattern` : `${plural(r.queries, 'query', 'queries')}, ${r.queryMs} ms` }, icon('database', 12), r.queries),
      h('span', { class: 'rq-user' }, r.user ? [avatar(r.user.name, 18), h('span', { class: 'ellipsis' }, r.user.name)] : h('span', { class: 'muted' }, 'anonymous')),
      h('span', { class: 'rq-time num', dataset: { time: r.startedAt }, title: fullDate(r.startedAt) }, relTime(r.startedAt)),
    );
    if (r.id === state.selected) el.classList.add('kbd');
    rows.set(r.id, el);
    return el;
  }

  const visible = () => store.requests.filter(matches);

  async function renderList() {
    rows.clear();
    if (state.mode === 'background') return renderBackground();
    listPane.classList.remove('bg-mode');
    const items = visible();
    maxDur = Math.max(1, ...store.requests.map((r) => r.durationMs ?? 0));
    renderStats(items);
    if (!store.requests.length) {
      return mount(list, empty({ icon: 'activity', title: 'Waiting for requests', hint: 'Call your API and requests appear here instantly, with their queries and logs.', code: `curl ${location.origin}${store.overview?.app.apiPrefix ?? '/api'}/posts` }));
    }
    if (!items.length) return mount(list, empty({ icon: 'search', title: 'No requests match', hint: 'Try a shorter filter, or `4xx`, `POST`, a user name or an error code.' }));
    mount(list, items.map(row));
  }

  async function renderBackground() {
    listPane.classList.add('bg-mode');
    clear(stats);
    mount(list, loading('Loading background queries'));
    try {
      const queries = await api('/queries');
      if (state.mode !== 'background') return;
      if (!queries.length) return mount(list, empty({ icon: 'database', title: 'No background queries', hint: 'Queries that run outside a request (jobs, startup tasks) show up here.' }));
      const q = state.filter.trim().toLowerCase();
      const items = queries.filter((x) => !q || `${x.command} ${x.collection} ${JSON.stringify(x.summary)}`.toLowerCase().includes(q));
      mount(
        stats,
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Queries'), h('span', { class: 'stat-value num' }, items.length)),
        h('div', { class: 'stat' }, h('span', { class: 'stat-label' }, 'Total time'), h('span', { class: 'stat-value num' }, fmtMs(items.reduce((n, x) => n + (x.durationMs ?? 0), 0)))),
      );
      mount(list, h('div', { class: 'q-list bg' }, items.map((x) => queryCard(x, { absolute: true }))));
    } catch (err) {
      mount(list, errorBox(err));
    }
  }

  function setSelected(id, scroll = true) {
    rows.get(state.selected)?.classList.remove('kbd');
    state.selected = id;
    const el = rows.get(id);
    if (el) {
      el.classList.add('kbd');
      if (scroll) el.scrollIntoView({ block: 'nearest' });
    }
  }

  function markOpen() {
    for (const [id, el] of rows) el.setAttribute('aria-selected', String(id === openId));
  }

  // ---- detail ------------------------------------------------------------------

  function open(id) {
    if (location.hash !== `#/requests/${id}`) location.hash = `#/requests/${id}`;
    else show(id);
  }

  function close() {
    openId = null;
    split.classList.remove('open');
    clear(detail);
    markOpen();
    if (location.hash.startsWith('#/requests/')) history.replaceState(null, '', '#/requests');
    rows.get(state.selected)?.scrollIntoView({ block: 'nearest' });
  }

  async function show(id) {
    openId = id;
    setSelected(id);
    markOpen();
    split.classList.add('open');
    mount(detail, loading('Loading request'));
    try {
      const rec = await getRecord(id);
      if (openId !== id) return;
      renderDetail(rec);
    } catch (err) {
      if (openId !== id) return;
      mount(detail, h('div', { class: 'dt-pad' }, h('button', { class: 'btn ghost', onclick: close }, icon('chevronLeft', 14), 'Back'), errorBox(err)));
    }
  }

  function step(delta) {
    const items = state.mode === 'requests' ? visible() : [];
    if (!items.length) return;
    const ref = openId ?? state.selected;
    let i = items.findIndex((r) => r.id === ref);
    i = i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + delta));
    const id = items[i].id;
    if (openId) open(id);
    else setSelected(id);
  }

  function renderDetail(rec) {
    const dbMs = unionMs(rec.queries);
    const tabDefs = [
      { id: 'timeline', label: 'Timeline' },
      { id: 'queries', label: 'Queries', count: rec.queries.length, tone: rec.queries.length > MANY_QUERIES ? 'warn' : null },
      { id: 'request', label: 'Request' },
      { id: 'response', label: 'Response' },
      { id: 'logs', label: 'Logs', count: rec.logs?.length || '' },
      rec.error ? { id: 'error', label: 'Error', dot: rec.error.status >= 500 ? 'red' : 'amber' } : null,
    ].filter(Boolean);
    if (!tabDefs.some((t) => t.id === state.tab)) state.tab = 'timeline';

    const body = h('div', { class: 'dt-body' });
    const renderTab = (id) => {
      state.tab = id;
      body.scrollTop = 0;
      const views = { timeline: timelineView, queries: queriesView, request: requestView, response: responseView, logs: logsView, error: errorView };
      mount(body, views[id](rec, { goTo }));
    };
    const tabBar = tabs(tabDefs, state.tab, renderTab);
    const goTo = (tab, queryId) => {
      tabBar.set(tab);
      renderTab(tab);
      if (queryId != null) {
        const card = body.querySelector(`[data-qid="${queryId}"]`);
        card?.scrollIntoView({ block: 'center' });
        card?.classList.add('flash');
      }
    };

    const items = visible();
    const idx = items.findIndex((r) => r.id === rec.id);
    const meta = [
      h('span', { class: 'dt-status' }, statusChip(rec.status), h('span', null, STATUS_TEXT[rec.status] ?? '')),
      h('span', { class: 'num' }, icon('clock', 13), fmtMs(rec.durationMs)),
      h('span', { class: ['num', rec.queries.length > MANY_QUERIES && 't-amber'] }, icon('database', 13), `${plural(rec.queries.length, 'query', 'queries')}`, rec.queries.length ? h('span', { class: 'muted' }, ` · ${fmtMs(dbMs)}`) : null),
      rec.user ? h('span', { title: `${rec.user.email ?? ''} ${(rec.user.roles ?? []).join(', ')}` }, avatar(rec.user.name, 18), rec.user.name, (rec.user.roles ?? []).includes('admin') ? h('span', { class: 'badge t-purple' }, 'admin') : null) : h('span', { class: 'muted' }, icon('user', 13), 'anonymous'),
      h('span', { class: 'muted num', title: fullDate(rec.startedAt) }, clock(rec.startedAt), ` · ${relTime(rec.startedAt)}`),
    ];

    mount(
      detail,
      h(
        'header',
        { class: 'dt-head' },
        h(
          'div',
          { class: 'dt-title-row' },
          h('button', { class: 'icon-btn ghost dt-back', 'aria-label': 'Back to list', onclick: close }, icon('chevronLeft', 16)),
          methodChip(rec.method, 'lg'),
          h('h2', { class: 'dt-path', title: rec.path }, pathEl(rec.path)),
          h(
            'div',
            { class: 'dt-nav' },
            h('button', { class: 'icon-btn ghost', 'aria-label': 'Newer request (k)', title: 'Newer (k)', disabled: idx <= 0, onclick: () => step(-1) }, icon('chevronLeft', 16)),
            h('button', { class: 'icon-btn ghost', 'aria-label': 'Older request (j)', title: 'Older (j)', disabled: idx < 0 || idx >= items.length - 1, onclick: () => step(1) }, icon('chevronRight', 16)),
            h('button', { class: 'icon-btn ghost', 'aria-label': 'Close detail (Esc)', title: 'Close (Esc)', onclick: close }, icon('x', 16)),
          ),
        ),
        h('div', { class: 'dt-meta' }, meta),
        h(
          'div',
          { class: 'dt-actions' },
          rec.route ? h('span', { class: 'dt-route', title: 'Matched route' }, icon('route', 13), rec.route) : null,
          h('button', { class: 'chip-btn mono', title: 'Copy request id', onclick: () => copy(rec.id, 'Request id copied') }, `id ${rec.id.slice(0, 8)}`, icon('copy', 12)),
          h('span', { class: 'spacer' }),
          h('button', { class: 'btn', onclick: () => copy(toCurl(rec), 'curl command copied'), title: 'Copy as curl' }, icon('terminal', 14), 'Copy as curl'),
          h('button', { class: 'btn', onclick: () => openInPlayground(rec), title: 'Edit and resend in the Playground' }, icon('send', 14), 'Edit in Playground'),
          h('button', { class: 'btn primary', onclick: () => replay(rec), title: store.actAs ? `Replay as ${store.actAs.user.name}` : 'Replay this request' }, icon('play', 13), store.actAs ? `Replay as ${firstName(store.actAs.user.name)}` : 'Replay'),
        ),
      ),
      tabBar,
      body,
    );
    renderTab(state.tab);
  }

  // ---- events ------------------------------------------------------------------

  const offs = [
    on('request', (r) => {
      if (state.mode !== 'requests') return;
      const prevMax = maxDur;
      maxDur = Math.max(maxDur, r.durationMs ?? 0);
      if (maxDur !== prevMax) return renderList();
      renderStats(visible());
      if (!matches(r)) return;
      if (!list.querySelector('.rq-row')) return renderList();
      const el = row(r);
      el.classList.add('fresh');
      const keep = listWrap.scrollTop > 4;
      const before = listWrap.scrollHeight;
      list.prepend(el);
      if (keep) listWrap.scrollTop += listWrap.scrollHeight - before;
      // Rows that rotated out of the server ring buffer
      for (const node of [...list.children].slice(300)) node.remove();
    }),
    on('requests:reset', () => {
      renderList();
      if (openId && !store.requests.some((r) => r.id === openId)) close();
    }),
    on('actas', () => {
      if (openId && store.records.has(openId)) renderDetail(store.records.get(openId));
    }),
  ];
  const timer = setInterval(() => {
    const now = Date.now();
    for (const el of list.querySelectorAll('[data-time]')) el.textContent = relTime(el.dataset.time, now);
  }, 10_000);

  renderList();
  if (openId) show(openId);
  else if (store.requests[0] && !state.selected) setSelected(store.requests[0].id, false);
  else if (state.selected) setSelected(state.selected);

  return {
    update(p) {
      const id = p[0] ?? null;
      if (id && id !== openId) show(id);
      else if (!id && openId) close();
    },
    refresh: renderList,
    destroy() {
      offs.forEach((off) => off());
      clearInterval(timer);
    },
    onKey(e) {
      if (e.key === 'j' || e.key === 'ArrowDown') step(1);
      else if (e.key === 'k' || e.key === 'ArrowUp') step(-1);
      else if (e.key === 'Enter' && state.selected && !openId) open(state.selected);
      else if (e.key === 'Escape' && openId) close();
      else return;
      e.preventDefault();
    },
  };
}

// ---- detail views --------------------------------------------------------------------

const firstName = (n) => String(n ?? '').split(' ')[0];

function unionMs(queries) {
  const spans = queries.filter((q) => q.durationMs != null).map((q) => [q.startedAt, q.startedAt + q.durationMs]).sort((a, b) => a[0] - b[0]);
  let total = 0;
  let end = -Infinity;
  for (const [a, b] of spans) {
    if (b <= end) continue;
    total += b - Math.max(a, end);
    end = b;
  }
  return Math.round(total * 10) / 10;
}

function shape(value) {
  return JSON.stringify(value, (k, v) => (v !== null && typeof v === 'object' ? v : k === '' ? v : '?'));
}

function repeated(queries) {
  const groups = new Map();
  for (const q of queries) {
    const key = `${q.command}:${q.collection}:${shape(q.summary)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(q);
  }
  return [...groups.values()].filter((g) => g.length >= 4).sort((a, b) => b.length - a.length);
}

function niceStep(raw) {
  const pow = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

const kindOf = (cmd) => (READS.has(cmd) ? 'read' : ['insert', 'update', 'delete', 'findAndModify'].includes(cmd) ? 'write' : 'other');

function timelineView(rec, { goTo }) {
  const t0 = Date.parse(rec.startedAt);
  const qs = rec.queries.map((q, i) => ({ ...q, i, off: Math.max(0, q.startedAt - t0), dur: q.durationMs ?? 0 }));
  const logs = (rec.logs ?? []).map((l) => ({ ...l, off: Math.max(0, Date.parse(l.time) - t0) }));
  const total = Math.max(rec.durationMs ?? 0, ...qs.map((q) => q.off + q.dur), ...logs.map((l) => l.off), 0.5);
  const pct = (ms) => `${Math.min(100, (ms / total) * 100)}%`;
  const db = unionMs(rec.queries);
  const dbShare = rec.durationMs ? Math.min(100, (db / rec.durationMs) * 100) : 0;
  const step = niceStep(total / 4);
  const ticks = [];
  for (let t = 0; t <= total + 1e-9 && ticks.length < 8; t += step) ticks.push(t);

  const grid = h('div', { class: 'wf-grid', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { style: { left: pct(t) } })));
  const label = (q) => h('span', { class: 'wf-label' }, h('span', { class: 'wf-idx num' }, q.i + 1), h('span', { class: `wf-cmd k-${kindOf(q.command)}` }, q.command), h('span', { class: 'wf-coll' }, q.collection ?? ''));
  const bar = (left, width, cls, text, title, onclick) => {
    const end = left + width;
    return h(
      'div',
      { class: 'wf-track' },
      h('button', { class: ['wf-bar', cls], style: { left: pct(left), width: `max(3px, ${pct(width)})` }, title, onclick, tabindex: onclick ? '0' : '-1' }),
      h('span', { class: 'wf-val num', style: { left: `calc(${pct(end)} + 6px)` } }, text),
    );
  };

  const n1 = repeated(rec.queries);
  const callouts = [];
  if (rec.error) {
    callouts.push(
      h('div', { class: `callout t-${rec.error.status >= 500 ? 'red' : 'amber'}` }, icon(rec.error.status >= 500 ? 'alertCircle' : 'alert', 16), h('div', null, h('b', null, `${rec.error.status} ${rec.error.code}`), ` ${rec.error.message}`), h('button', { class: 'btn xs', onclick: () => goTo('error') }, 'See error')),
    );
  }
  if (n1.length) {
    const parts = n1.slice(0, 3).map((g) => `${g.length} ${g[0].command} on ${g[0].collection}`);
    callouts.push(
      h(
        'div',
        { class: 'callout t-amber' },
        icon('alert', 16),
        h('div', null, h('b', null, 'Possible N+1: '), `${parts.join(', ')}, each with the same shape. `, 'Batch them with ', h('code', null, '$in'), ' or ', h('code', null, '?include='), ' instead of querying inside a loop.'),
        h('button', { class: 'btn xs', onclick: () => goTo('queries', n1[0][0].id) }, 'Show'),
      ),
    );
  }

  return h(
    'div',
    { class: 'dt-pad timeline' },
    callouts,
    h(
      'div',
      { class: 'tl-summary' },
      h('div', { class: 'tl-stat' }, h('span', { class: 'stat-label' }, 'Total'), h('span', { class: 'tl-big num' }, fmtMs(rec.durationMs))),
      h('div', { class: 'tl-stat' }, h('span', { class: 'stat-label' }, h('i', { class: 'sw sw-db' }), 'MongoDB'), h('span', { class: 'tl-big num' }, fmtMs(db), h('small', null, `${Math.round(dbShare)}%`))),
      h('div', { class: 'tl-stat' }, h('span', { class: 'stat-label' }, h('i', { class: 'sw sw-app' }), 'Your code + framework'), h('span', { class: 'tl-big num' }, fmtMs(Math.max(0, (rec.durationMs ?? 0) - db)))),
      h('div', { class: 'tl-share', role: 'img', 'aria-label': `${Math.round(dbShare)}% of the time was spent in MongoDB` }, h('span', { class: 'tl-share-db', style: { width: `${dbShare}%` } })),
    ),
    h(
      'div',
      { class: 'wf' },
      h('div', { class: 'wf-row wf-axis' }, h('span', { class: 'wf-label muted' }, `${plural(qs.length, 'query', 'queries')}`), h('div', { class: 'wf-track' }, ticks.map((t) => h('span', { class: 'wf-tick num', style: { left: pct(t) } }, t === 0 ? '0' : fmtMs(t))))),
      h(
        'div',
        { class: 'wf-rows' },
        grid,
        h('div', { class: 'wf-row' }, h('span', { class: 'wf-label' }, methodChip(rec.method, 'sm'), h('span', { class: 'wf-coll strong' }, 'Request')), bar(0, rec.durationMs ?? 0, 'b-req', fmtMs(rec.durationMs), `${rec.method} ${rec.path}: ${fmtMs(rec.durationMs)}`)),
        qs.map((q) =>
          h(
            'div',
            { class: ['wf-row', q.ok === false && 'failed'] },
            label(q),
            bar(q.off, q.dur, `b-${q.ok === false ? 'fail' : kindOf(q.command)}`, fmtMs(q.durationMs), `${q.command} ${q.collection ?? ''}\nstarts +${q.off} ms, takes ${fmtMs(q.durationMs)}${q.docs != null ? `, ${q.docs} docs` : ''}\nClick to see the query`, () => goTo('queries', q.id)),
          ),
        ),
        logs.length
          ? h(
              'div',
              { class: 'wf-row' },
              h('span', { class: 'wf-label' }, h('span', { class: 'wf-cmd k-log' }, 'logs'), h('span', { class: 'wf-coll' }, logs.length)),
              h('div', { class: 'wf-track' }, logs.map((l) => h('button', { class: `wf-log lv-${l.level}`, style: { left: pct(l.off) }, title: `+${l.off} ms ${l.level}: ${l.msg}`, onclick: () => goTo('logs') }))),
            )
          : null,
      ),
      !qs.length ? h('p', { class: 'wf-note' }, 'No database queries ran during this request.') : null,
    ),
    h('div', { class: 'wf-legend' }, h('span', null, h('i', { class: 'sw b-req' }), 'request'), h('span', null, h('i', { class: 'sw b-read' }), 'read'), h('span', null, h('i', { class: 'sw b-write' }), 'write'), h('span', null, h('i', { class: 'sw b-other' }), 'other'), h('span', { class: 'muted' }, 'Offsets have millisecond precision.')),
  );
}

function queriesView(rec) {
  if (!rec.queries.length) return empty({ icon: 'database', title: 'No queries', hint: 'This request did not touch MongoDB.' });
  const t0 = Date.parse(rec.startedAt);
  const n1 = repeated(rec.queries);
  const flagged = new Set(n1.flat().map((q) => q.id));
  return h('div', { class: 'dt-pad q-list' }, rec.queries.map((q, i) => queryCard(q, { index: i + 1, offset: q.startedAt - t0, repeated: flagged.has(q.id) })));
}

function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
}

export function queryCard(q, { index, offset, absolute, repeated: rep } = {}) {
  const explainHost = h('div', { class: 'q-explain' });
  const summary = stripUndefined(q.summary);
  const showRaw = !summary || !Object.keys(summary).length;
  const canExplain = ['find', 'aggregate', 'count', 'distinct', 'update', 'delete', 'findAndModify'].includes(q.command);
  const explainBtn = canExplain
    ? h('button', { class: 'btn xs', onclick: () => explain(q, explainHost, explainBtn) }, icon('zap', 12), 'Explain')
    : null;
  return h(
    'article',
    { class: ['q-card', q.ok === false && 'failed', rep && 'repeated'], dataset: { qid: q.id } },
    h(
      'header',
      { class: 'q-head' },
      index != null ? h('span', { class: 'q-idx num' }, index) : null,
      h('span', { class: `q-cmd k-${kindOf(q.command)}` }, q.command),
      h('span', { class: 'q-coll' }, q.collection ?? q.database),
      rep ? h('span', { class: 'badge t-amber', title: 'Same command and filter shape repeated in this request' }, 'repeated') : null,
      h('span', { class: 'spacer' }),
      q.docs != null ? h('span', { class: 'q-meta num' }, plural(q.docs, 'doc')) : null,
      absolute ? h('span', { class: 'q-meta num', title: fullDate(q.startedAt) }, clock(q.startedAt)) : offset != null ? h('span', { class: 'q-meta num', title: 'Offset from request start' }, `+${offset} ms`) : null,
      h('span', { class: ['q-dur', 'num', q.durationMs > 50 && 't-amber'] }, fmtMs(q.durationMs)),
      q.ok === false ? h('span', { class: 'badge t-red' }, 'failed') : null,
    ),
    codeBlock(showRaw ? q.raw : summary, 'q-code'),
    q.error ? h('div', { class: 'callout t-red sm' }, icon('alertCircle', 14), q.error) : null,
    h('footer', { class: 'q-foot' }, explainBtn, h('button', { class: 'btn ghost xs', onclick: () => copy(JSON.stringify(q.raw, null, 2), 'Command copied') }, icon('copy', 12), 'Copy command'), h('span', { class: 'muted small' }, q.database)),
    explainHost,
  );
}

async function explain(q, host, btn) {
  btn.disabled = true;
  mount(host, loading('Asking MongoDB for the plan'));
  try {
    const plan = await api(`/queries/${q.id}/explain`, { method: 'POST' });
    if (plan.error) throw new Error(plan.error);
    const stages = [...plan.stages].reverse();
    const filter = q.summary?.filter ?? q.summary?.query ?? q.summary?.pipeline?.[0]?.$match ?? q.summary?.updates?.[0]?.q ?? q.summary?.deletes?.[0]?.q;
    const fields = filterFields(filter);
    const emptyFilter = !fields.length;
    mount(
      host,
      h(
        'div',
        { class: 'plan' },
        h('div', { class: 'plan-stages' }, stages.map((st, i) => [i ? icon('arrowRight', 12, 'plan-arrow') : null, h('span', { class: ['plan-stage', st.stage === 'COLLSCAN' && 'bad', st.stage === 'IXSCAN' && 'good'] }, st.stage, st.index ? h('small', null, st.index) : null)])),
        plan.collscan
          ? h('div', { class: 'callout t-red sm' }, icon('alert', 14), h('div', null, h('b', null, 'COLLSCAN: '), `MongoDB reads every document in ${plan.namespace ?? q.collection}. `, emptyFilter ? 'There is no filter here, which is fine for small collections; paginate or sort on an indexed field as it grows.' : h('span', null, 'Add an index on ', fields.map((f, i) => [i ? ', ' : '', h('code', null, f)]), ', for example ', h('code', null, '.index()'), ' or ', h('code', null, '.unique()'), ' on the field in the resource.')))
          : plan.indexes.length
            ? h('div', { class: 'callout t-green sm' }, icon('checkCircle', 14), h('div', null, 'Uses index ', plan.indexes.map((x, i) => [i ? ', ' : '', h('code', null, x)])))
            : h('div', { class: 'callout sm' }, icon('info', 14), 'No collection scan in the winning plan.'),
      ),
    );
  } catch (err) {
    mount(host, h('div', { class: 'callout t-red sm' }, icon('alertCircle', 14), err.message));
  } finally {
    btn.disabled = false;
  }
}

function filterFields(filter, out = new Set()) {
  if (!filter || typeof filter !== 'object') return [...out];
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') (Array.isArray(v) ? v : []).forEach((x) => filterFields(x, out));
    else if (!k.startsWith('$')) out.add(k);
  }
  return [...out];
}

function kvTable(obj, { mono = true } = {}) {
  const entries = Object.entries(obj ?? {});
  if (!entries.length) return h('p', { class: 'muted' }, 'None');
  return h('dl', { class: ['kv', mono && 'mono'] }, entries.map(([k, v]) => [h('dt', null, k), h('dd', null, typeof v === 'object' ? JSON.stringify(v) : String(v))]));
}

function requestView(rec) {
  const url = `${location.origin}${rec.path}`;
  const hasAuth = Boolean(rec.requestHeaders?.authorization);
  return h(
    'div',
    { class: 'dt-pad stack' },
    h(
      'section',
      { class: 'sect' },
      h('h3', null, 'General'),
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'URL'), h('dd', { class: 'mono' }, url),
        h('dt', null, 'Route'), h('dd', { class: 'mono' }, rec.route ?? h('span', { class: 'muted' }, 'no route matched')),
        h('dt', null, 'Status'), h('dd', null, statusChip(rec.status), ' ', STATUS_TEXT[rec.status] ?? ''),
        h('dt', null, 'Client IP'), h('dd', { class: 'mono' }, rec.ip ?? ''),
        h('dt', null, 'Request id'), h('dd', { class: 'mono' }, rec.id),
        h('dt', null, 'Started'), h('dd', null, fullDate(rec.startedAt)),
        h('dt', null, 'User'), h('dd', null, rec.user ? `${rec.user.name} <${rec.user.email ?? ''}> ${(rec.user.roles ?? []).join(', ')}` : h('span', { class: 'muted' }, 'anonymous')),
      ),
    ),
    h('section', { class: 'sect' }, h('h3', null, 'Headers'), hasAuth ? h('p', { class: 'note' }, icon('lock', 12), 'Authorization is redacted in recordings. Cookies are never stored.') : null, kvTable(rec.requestHeaders)),
    h('section', { class: 'sect' }, h('h3', null, 'Body'), rec.requestBody == null ? h('p', { class: 'muted' }, 'No body.') : [h('p', { class: 'note' }, icon('lock', 12), 'Fields that look secret (password, token, otp, api key) are recorded as [redacted].'), jsonViewer(rec.requestBody, { open: 3 })]),
  );
}

function responseView(rec) {
  return h(
    'div',
    { class: 'dt-pad stack' },
    h('div', { class: 'resp-line' }, statusChip(rec.status, 'lg'), h('b', null, STATUS_TEXT[rec.status] ?? ''), h('span', { class: 'muted num' }, fmtMs(rec.durationMs))),
    rec.responseBody == null
      ? empty({ icon: 'braces', title: 'No JSON body', hint: rec.status === 204 ? '204 No Content: nothing to show.' : 'The handler did not respond with JSON (or the body was empty).' })
      : rec.responseBody?.truncated
        ? [h('p', { class: 'note' }, 'Body larger than 64 KB, showing a preview.'), h('pre', { class: 'code' }, rec.responseBody.preview)]
        : jsonViewer(rec.responseBody, { open: 3, title: 'Response body' }),
  );
}

function logsView(rec) {
  if (!rec.logs?.length) return empty({ icon: 'logs', title: 'No logs for this request', hint: 'Anything you log with `ctx.log.info()` during the request is linked here by request id.' });
  return h('div', { class: 'dt-pad' }, h('div', { class: 'log-list in-detail' }, rec.logs.map((l) => logRow(l, { linkRequest: false }))));
}

function errorView(rec) {
  const err = rec.error;
  const root = store.overview?.app.root;
  const details = err.details;
  const sameMessage = err.internal && err.internal === err.message;
  return h(
    'div',
    { class: 'dt-pad stack' },
    h(
      'div',
      { class: `err-hero t-${err.status >= 500 ? 'red' : 'amber'}` },
      h('div', { class: 'err-code' }, h('span', { class: 'num' }, err.status), err.code),
      h('div', { class: 'err-msg' }, err.message),
      h('div', { class: 'err-sub' }, 'Sent to the client as ', h('code', null, `{ error: { code: "${err.code}", message } }`)),
    ),
    err.internal && !sameMessage
      ? h('section', { class: 'sect' }, h('h3', null, 'Internal message'), h('p', { class: 'note' }, icon('lock', 12), 'Only visible here and in your logs. The client never sees it.'), h('pre', { class: 'code plain' }, err.internal))
      : null,
    details
      ? h(
          'section',
          { class: 'sect' },
          h('h3', null, 'Details'),
          details && typeof details === 'object' && !Array.isArray(details) && Object.values(details).every((v) => typeof v === 'string')
            ? h('dl', { class: 'kv' }, Object.entries(details).map(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', { class: 't-amber-text' }, v)]))
            : jsonViewer(details, { open: 3 }),
        )
      : null,
    err.stack ? h('section', { class: 'sect' }, h('h3', null, 'Stack trace'), stackView(err.stack, root)) : null,
  );
}

function stackView(stack, root) {
  const lines = String(stack).split('\n');
  const frame = /^\s*at (?:async )?(?:(.*?) \()?((?:file:\/\/)?[^()]*?):(\d+):(\d+)\)?\s*$/;
  return h(
    'div',
    { class: 'stack-trace' },
    lines.map((line, i) => {
      if (i === 0) return h('div', { class: 'st-head' }, line);
      const m = frame.exec(line);
      if (!m) return h('div', { class: 'st-frame dim' }, line.trim());
      const [, fn, file, ln, col] = m;
      const path = file.replace(/^file:\/\//, '');
      const internal = path.startsWith('node:') || path.includes('/node_modules/');
      const inApp = root && path.startsWith(root) && !internal;
      return h(
        'div',
        { class: ['st-frame', internal && 'dim', inApp && 'st-app', inApp && relPath(root, path).startsWith('calm/') && 'st-core'] },
        h('span', { class: 'st-fn' }, fn ?? '<anonymous>'),
        internal ? h('span', { class: 'st-file' }, `${path}:${ln}`) : h('a', { class: 'st-file', href: editorUrl(root, path, ln, col), title: 'Open in VS Code' }, `${relPath(root, path)}:${ln}:${col}`),
      );
    }),
  );
}

// ---- actions ----------------------------------------------------------------------

const hasBody = (rec) => rec.requestBody != null && !['GET', 'HEAD'].includes(rec.method);
const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

function toCurl(rec) {
  const parts = [`curl${rec.method === 'GET' ? '' : ` -X ${rec.method}`} ${shq(location.origin + rec.path)}`];
  if (store.actAs) parts.push(`-H ${shq(`Authorization: Bearer ${store.actAs.token}`)}`);
  else if (rec.requestHeaders?.authorization) parts.push(`-H ${shq('Authorization: Bearer <token>')}`);
  if (hasBody(rec)) {
    parts.push(`-H ${shq('Content-Type: application/json')}`);
    parts.push(`--data ${shq(JSON.stringify(rec.requestBody))}`);
  }
  return parts.join(' \\\n  ');
}

function openInPlayground(rec) {
  store.prefill = { method: rec.method, path: rec.path, body: hasBody(rec) ? JSON.stringify(rec.requestBody, null, 2) : '' };
  location.hash = '#/playground';
}

async function replay(rec) {
  const headers = { ...authHeader() };
  if (hasBody(rec)) headers['Content-Type'] = 'application/json';
  const redacted = hasBody(rec) && JSON.stringify(rec.requestBody).includes('[redacted]');
  const started = performance.now();
  let res;
  try {
    res = await fetch(rec.path, { method: rec.method, headers, body: hasBody(rec) ? JSON.stringify(rec.requestBody) : undefined });
  } catch (err) {
    return toast(`Replay failed: ${err.message}`, { tone: 'error' });
  }
  const ms = performance.now() - started;
  const id = res.headers.get('x-request-id');
  const who = store.actAs ? `as ${store.actAs.user.name} (act-as token)` : 'without auth';
  const notes = [];
  if (!store.actAs && rec.requestHeaders?.authorization) notes.push('The original token is redacted, so this ran anonymously.');
  if (redacted) notes.push('Secret fields were redacted in the recording and were sent as "[redacted]".');
  const opener = id ? { label: 'Open', run: () => (location.hash = `#/requests/${id}`) } : null;
  const actAs = !store.actAs && rec.user && store.overview?.auth ? { label: `Act as ${firstName(rec.user.name)} and replay`, run: async () => { await startActAs(rec.user); replay(rec); } } : null;
  toast(`Replayed ${who}: ${res.status} ${STATUS_TEXT[res.status] ?? ''} in ${fmtMs(ms)}`, { tone: res.ok ? 'ok' : 'warn', detail: notes.join(' ') || null, action: actAs ?? opener, timeout: actAs ? 9000 : 5000 });
}
