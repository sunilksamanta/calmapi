// Requests: live list (SSE) and a resizable detail pane with timeline, queries, request,
// response, logs and error tabs.

import {
  h, icon, mount, clear, api, fmtMs, relTime, clock, fullDate, methodTag, statusTag, statusClass, pathView, STATUS_TEXT,
  codeBlock, jsonLine, jsonViewer, empty, loading, errorBox, searchBox, segmented, tabs, copy, toast, plural, editorUrl, relPath,
  bar, joined, hoverTip, hideTip, storage, actorMark, fileLink, popover,
} from '../lib.js';
import { store, on, getRecord, clearRequests, authHeader, startActAs } from '../store.js';
import { logRow } from './logs.js';

const SLOW_MS = 300;
const MANY_QUERIES = 10;
const READS = new Set(['find', 'aggregate', 'count', 'distinct', 'getMore']);
const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify']);

const state = { filter: '', quick: 'all', mode: 'requests', tab: 'timeline', selected: null };

export default {
  id: 'requests',
  label: 'Requests',
  badge: () => {
    return { text: store.requests.length || '' };
  },
  mount: mountRequests,
};

function matches(r) {
  if (state.quick === 'errors' && !(r.status >= 400)) return false;
  if (state.quick === 'slow' && !(r.durationMs >= SLOW_MS)) return false;
  if (state.quick === 'heavy' && !(r.queries > MANY_QUERIES)) return false;
  if (state.quick === 'agent' && !r.agent) return false;
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((term) => {
    if (/^[1-5]xx$/.test(term)) return String(r.status ?? '').startsWith(term[0]);
    const hay = `${r.method} ${r.path} ${routeOf(r) ?? ''} ${r.status ?? ''} ${r.user?.name ?? 'anonymous'} ${r.error ?? ''} ${r.agent ? `agent ${r.agent}` : ''}`.toLowerCase();
    return hay.includes(term);
  });
}

function percentile(values, p) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
}

/** Error responses are recorded without the API prefix (req.baseUrl is reset by then). */
function routeOf(r) {
  const prefix = store.overview?.app.apiPrefix ?? '';
  if (!r.route || !prefix || r.route.startsWith(prefix) || !r.path.startsWith(prefix)) return r.route ?? null;
  return `${prefix}${r.route}`;
}

const clamp = (n, a, b) => Math.max(a, Math.min(b, n));

function mountRequests(root, params) {
  let openId = params[0] ?? null;
  let maxDur = 1;
  const rows = new Map();

  const head = h(
    'div',
    { class: 'rq-row rq-head', 'aria-hidden': 'true' },
    h('span', null, 'Status'),
    h('span', null, 'Method'),
    h('span', null, 'Path'),
    h('span', { class: 'c-user' }, 'User'),
    h('span', { class: 'num' }, 'Duration'),
    h('span', { class: 'num c-q' }, 'Queries'),
    h('span', { class: 'c-bar', title: 'Duration, with time spent in MongoDB shaded' }, 'Time split'),
    h('span', { class: 'num' }, 'When'),
  );
  const list = h('div', { class: 'rq-rows', role: 'listbox', 'aria-label': 'Requests', tabindex: '0', onpointerdown: () => list.classList.remove('kbd') });
  const scroll = h('div', { class: 'scroll rq-scroll' }, head, list);
  const listPane = h('section', { class: 'rq-list' }, scroll);
  const detail = h('section', { class: 'rq-detail', 'aria-label': 'Request detail' });
  const handle = h('div', { class: 'split-handle', role: 'separator', 'aria-orientation': 'vertical', 'aria-label': 'Resize detail pane', tabindex: '0', title: 'Drag to resize' });
  const split = h('div', { class: 'rq-split' }, listPane, handle, detail);
  const summary = h('span', { class: 'bar-meta' });

  // ---- split pane ------------------------------------------------------------------

  let frac = clamp(Number(storage.get('rq-split', 0.56)) || 0.56, 0.3, 0.78);
  const applyFrac = () => {
    split.style.setProperty('--dw', `${(frac * 100).toFixed(2)}%`);
    handle.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
  };
  applyFrac();
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    handle.setPointerCapture(e.pointerId);
    split.classList.add('resizing');
    const rect = split.getBoundingClientRect();
    const max = Math.min(0.78, 1 - 320 / rect.width);
    const move = (ev) => {
      frac = clamp((rect.right - ev.clientX) / rect.width, 0.3, max);
      applyFrac();
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      split.classList.remove('resizing');
      storage.set('rq-split', frac);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    frac = clamp(frac + (e.key === 'ArrowLeft' ? 0.03 : -0.03), 0.3, 0.78);
    applyFrac();
    storage.set('rq-split', frac);
    e.preventDefault();
    e.stopPropagation();
  });

  // ---- toolbar ---------------------------------------------------------------------

  const quickSeg = segmented(
    [
      { value: 'all', label: 'All' },
      { value: 'errors', label: 'Errors', title: 'Status 400 and above' },
      { value: 'slow', label: 'Slow', title: `${SLOW_MS} ms or more` },
      { value: 'heavy', label: 'N+1', title: `More than ${MANY_QUERIES} queries` },
      { value: 'agent', label: 'Agent', title: 'Sent by an AI agent (X-Calm-Agent header)' },
    ],
    state.quick,
    (v) => {
      state.quick = v;
      renderList();
    },
    'Quick filter',
  );

  const bgBtn = h('button', { class: 'btn ghost', type: 'button', 'aria-pressed': String(state.mode === 'background'), title: 'Queries that ran outside any request (jobs, startup)' }, 'Background queries');
  bgBtn.addEventListener('click', () => {
    state.mode = state.mode === 'background' ? 'requests' : 'background';
    bgBtn.setAttribute('aria-pressed', String(state.mode === 'background'));
    if (openId) close();
    renderList();
  });

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      bar(
        'Requests',
        searchBox({ placeholder: 'Filter path, status, user', value: state.filter, oninput: (v) => ((state.filter = v), renderList()) }),
        quickSeg,
        h('span', { class: 'spacer' }),
        summary,
        bgBtn,
        h('button', { class: 'btn ghost', type: 'button', title: 'Send the recorded reads again against the code as it is now, as the users who made them, and see which answers changed', onclick: (e) => replayTraffic(e.currentTarget) }, 'Replay all'),
        h('button', { class: 'btn ghost', type: 'button', title: 'Clear all recorded requests', onclick: () => clearRequests() }, 'Clear'),
      ),
      split,
    ),
  );

  // ---- list --------------------------------------------------------------------

  function renderSummary(items) {
    const durs = items.map((r) => r.durationMs).filter((d) => d != null);
    const errors = items.filter((r) => r.status >= 400).length;
    mount(
      summary,
      joined([
        plural(items.length, 'request'),
        errors ? h('span', { class: 't-red' }, plural(errors, 'error')) : null,
        durs.length ? `p50 ${fmtMs(percentile(durs, 50))}` : null,
        durs.length ? `p95 ${fmtMs(percentile(durs, 95))}` : null,
      ]),
    );
  }

  function row(r) {
    const w = r.durationMs ? Math.max(3, (Math.log1p(r.durationMs) / Math.log1p(maxDur)) * 100) : 0;
    const dbShare = r.durationMs ? clamp((r.queryMs ?? 0) / r.durationMs, 0, 1) * 100 : 0;
    const heavy = r.queries > MANY_QUERIES;
    const el = h(
      'div',
      {
        class: ['rq-row', r.agent && 'by-agent'],
        role: 'option',
        id: `rq-${r.id}`,
        'aria-selected': String(r.id === openId),
        dataset: { id: r.id },
        onclick: () => open(r.id),
      },
      r.agent ? actorMark('agent', `Sent by an AI agent: ${r.agent}`) : null,
      statusTag(r.status),
      methodTag(r.method),
      h('span', { class: 'rq-path', title: routeOf(r) ? `${r.path}\nRoute ${routeOf(r)}` : r.path }, pathView(r.path, routeOf(r)), r.error ? h('span', { class: ['rq-err', statusClass(r.status)] }, r.error) : null, r.overBudget?.length ? h('a', { class: 'rq-over', href: '#/budgets', title: `Over budget: ${r.overBudget.join('; ')}` }, 'over budget') : null, r.replay ? h('span', { class: 'rq-replay', title: 'Sent by calm replay (or Replay all) to compare with a recorded request. Not recorded as traffic and not measured for budgets.' }, 'replay') : null),
      h('span', { class: ['c-user', !r.user && 'faint'] }, r.user ? r.user.name : 'anonymous'),
      h('span', { class: ['mono num', r.durationMs >= SLOW_MS && 't-amber'] }, fmtMs(r.durationMs)),
      h('span', { class: ['mono num c-q', heavy ? 't-amber' : !r.queries && 'faint'], title: heavy ? `${r.queries} queries (${fmtMs(r.queryMs)}): likely N+1` : `${plural(r.queries, 'query', 'queries')}, ${fmtMs(r.queryMs)} in MongoDB` }, r.queries),
      h('span', { class: 'c-bar', 'aria-hidden': 'true' }, h('span', { class: 'dur-bar', style: { width: `${w}%` } }, h('span', { class: 'dur-db', style: { width: `${dbShare}%` } }))),
      h('span', { class: 'num muted', dataset: { time: r.startedAt }, title: fullDate(r.startedAt) }, relTime(r.startedAt)),
    );
    if (r.id === state.selected) el.classList.add('cursor');
    rows.set(r.id, el);
    return el;
  }

  const visible = () => store.requests.filter(matches);

  function renderList() {
    rows.clear();
    quickSeg.hidden = state.mode === 'background';
    if (state.mode === 'background') return renderBackground();
    listPane.classList.remove('bg-mode');
    head.hidden = false;
    const items = visible();
    maxDur = Math.max(1, ...store.requests.map((r) => r.durationMs ?? 0));
    renderSummary(items);
    if (!store.requests.length) {
      return mount(list, empty('No requests yet. Call your API and they show up here.', { code: `curl ${location.origin}${store.overview?.app.apiPrefix ?? '/api'}/posts` }));
    }
    if (!items.length) return mount(list, empty('No requests match. Try `4xx`, `POST`, a user or an error code.'));
    mount(list, items.map(row));
  }

  async function renderBackground() {
    listPane.classList.add('bg-mode');
    head.hidden = true;
    clear(summary);
    mount(list, loading('Loading background queries'));
    try {
      const queries = await api('/queries');
      if (state.mode !== 'background') return;
      const q = state.filter.trim().toLowerCase();
      const items = queries.filter((x) => !q || `${x.command} ${x.collection} ${JSON.stringify(x.summary)}`.toLowerCase().includes(q));
      mount(summary, joined([plural(items.length, 'query', 'queries'), `${fmtMs(items.reduce((n, x) => n + (x.durationMs ?? 0), 0))} total`]));
      if (!queries.length) return mount(list, empty('No background queries. Queries from jobs and startup tasks show up here.'));
      mount(list, h('div', { class: 'ql' }, items.map((x) => queryRow(x, { absolute: true }))));
    } catch (err) {
      mount(list, errorBox(err));
    }
  }

  function setSelected(id, scroll = true) {
    rows.get(state.selected)?.classList.remove('cursor');
    state.selected = id;
    const el = rows.get(id);
    if (el) {
      el.classList.add('cursor');
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
    hideTip();
    markOpen();
    if (location.hash.startsWith('#/requests/')) history.replaceState(null, '', '#/requests');
    rows.get(state.selected)?.scrollIntoView({ block: 'nearest' });
  }

  async function show(id) {
    if (state.mode !== 'requests') {
      state.mode = 'requests';
      bgBtn.setAttribute('aria-pressed', 'false');
      renderList();
    }
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
      mount(detail, h('div', { class: 'dt-head' }, h('div', { class: 'dt-line1' }, h('span', { class: 'spacer' }), h('button', { class: 'icon-btn', 'aria-label': 'Close detail', onclick: close }, icon('x', 14)))), errorBox(err));
    }
  }

  function step(delta) {
    const items = state.mode === 'requests' ? visible() : [];
    if (!items.length) return;
    const ref = openId ?? state.selected;
    let i = items.findIndex((r) => r.id === ref);
    i = i < 0 ? 0 : clamp(i + delta, 0, items.length - 1);
    const id = items[i].id;
    if (openId) open(id);
    else setSelected(id);
  }

  function renderDetail(rec) {
    hideTip();
    const dbMs = unionMs(rec.queries);
    const heavy = rec.queries.length > MANY_QUERIES;
    const tabDefs = [
      { id: 'timeline', label: 'Timeline' },
      rec.steps?.length ? { id: 'path', label: 'Path', dot: rec.steps.some((x) => x.outcome === 'denied' || x.outcome === 'failed') ? 'amber' : null } : null,
      { id: 'queries', label: 'Queries', count: rec.queries.length, tone: heavy ? 'amber' : null },
      { id: 'request', label: 'Request' },
      { id: 'response', label: 'Response' },
      { id: 'logs', label: 'Logs', count: rec.logs?.length || '' },
      rec.error ? { id: 'error', label: 'Error', dot: rec.error.status >= 500 ? 'red' : 'amber' } : null,
    ].filter(Boolean);
    if (!tabDefs.some((t) => t.id === state.tab)) state.tab = 'timeline';

    const body = h('div', { class: 'dt-body scroll' });
    const renderTab = (id) => {
      state.tab = id;
      hideTip();
      body.scrollTop = 0;
      const views = { timeline: timelineView, path: pathTraceView, queries: queriesView, request: requestView, response: responseView, logs: logsView, error: errorView };
      mount(body, views[id](rec, { goTo }));
    };
    const tabBar = tabs(tabDefs, state.tab, renderTab);
    const goTo = (tab, queryId) => {
      tabBar.set(tab);
      renderTab(tab);
      if (queryId != null) {
        const qr = body.querySelector(`[data-qid="${queryId}"]`);
        qr?.querySelector('.qr-line')?.click();
        qr?.classList.add('target');
        qr?.scrollIntoView({ block: 'center' });
      }
    };

    const items = visible();
    const idx = items.findIndex((r) => r.id === rec.id);
    const replayLabel = store.actAs ? `Replay as ${firstName(store.actAs.user.name)}` : 'Replay';

    mount(
      detail,
      h(
        'header',
        { class: 'dt-head' },
        h(
          'div',
          { class: 'dt-line1' },
          methodTag(rec.method),
          h('h2', { class: 'dt-path', title: rec.path }, pathView(rec.path, routeOf(rec))),
          h(
            'span',
            { class: 'dt-actions' },
            h('button', { class: 'btn ghost', onclick: () => copy(toCurl(rec), 'curl command copied') }, 'Copy as curl'),
            h('button', { class: 'btn ghost', onclick: () => openInPlayground(rec), title: 'Edit and resend in the Playground' }, 'Edit in Playground'),
            rec.route && !rec.replay ? h('button', { class: 'btn ghost', onclick: () => saveAsTest(rec), title: 'Write test/recorded/<name>.test.js: the same request as the same kind of user, on a throwaway database' }, 'Save as test') : null,
            h('button', { class: 'btn primary', onclick: () => replay(rec), title: store.actAs ? `Replay as ${store.actAs.user.name}` : 'Replay this request' }, replayLabel),
          ),
          h(
            'div',
            { class: 'dt-nav' },
            h('button', { class: 'icon-btn', 'aria-label': 'Newer request (k)', title: 'Newer (k)', disabled: idx <= 0, onclick: () => step(-1) }, icon('chevronUp', 14)),
            h('button', { class: 'icon-btn', 'aria-label': 'Older request (j)', title: 'Older (j)', disabled: idx < 0 || idx >= items.length - 1, onclick: () => step(1) }, icon('chevronDown', 14)),
            h('button', { class: 'icon-btn', 'aria-label': 'Close detail (Esc)', title: 'Close (Esc)', onclick: close }, icon('x', 14)),
          ),
        ),
        h(
          'div',
          { class: 'dt-line2' },
          h(
            'span',
            { class: 'dt-meta' },
            joined([
              h('span', null, statusTag(rec.status), ' ', STATUS_TEXT[rec.status] ?? ''),
              h('span', { class: ['mono', rec.durationMs >= SLOW_MS && 't-amber'] }, fmtMs(rec.durationMs)),
              h('span', { class: heavy ? 't-amber' : null }, plural(rec.queries.length, 'query', 'queries'), rec.queries.length ? h('span', { class: 'mono' }, ` ${fmtMs(dbMs)}`) : null),
              rec.user ? h('span', { title: [rec.user.email, (rec.user.roles ?? []).join(', ')].filter(Boolean).join(' · ') }, rec.user.name) : 'anonymous',
              rec.agent ? h('span', { class: 'dt-agent', title: `Sent by an AI agent (X-Calm-Agent: ${rec.agent})` }, actorMark('agent'), rec.agent) : null,
              h('span', { class: 'mono', title: fullDate(rec.startedAt) }, clock(rec.startedAt)),
              h('button', { class: 'link-btn mono', title: `Copy request id ${rec.id}`, onclick: () => copy(rec.id, 'Request id copied') }, rec.id.slice(0, 8)),
            ]),
          ),
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
      renderSummary(visible());
      if (!matches(r)) return;
      if (!list.querySelector('.rq-row')) return renderList();
      const el = row(r);
      const keep = scroll.scrollTop > 4;
      const before = scroll.scrollHeight;
      list.prepend(el);
      if (keep) scroll.scrollTop += scroll.scrollHeight - before;
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
      hideTip();
    },
    onKey(e) {
      if (e.key === 'j' || e.key === 'ArrowDown') (list.classList.add('kbd'), step(1));
      else if (e.key === 'k' || e.key === 'ArrowUp') (list.classList.add('kbd'), step(-1));
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

const kindOf = (cmd) => (READS.has(cmd) ? 'read' : WRITES.has(cmd) ? 'write' : 'other');
const offText = (ms) => `+${Math.round(ms * 10) / 10} ms`;

function timelineView(rec, { goTo }) {
  const t0 = rec.startedAtMs ?? Date.parse(rec.startedAt);
  const qs = rec.queries.map((q, i) => ({ ...q, i, off: Math.max(0, q.startedAt - t0), dur: q.durationMs ?? 0 }));
  const logs = (rec.logs ?? []).map((l) => ({ ...l, off: Math.max(0, Date.parse(l.time) - t0) }));
  const total = Math.max(rec.durationMs ?? 0, ...qs.map((q) => q.off + q.dur), ...logs.map((l) => l.off), 0.5);
  const pct = (ms) => `${Math.min(100, (ms / total) * 100)}%`;
  const db = unionMs(rec.queries);
  const dbShare = rec.durationMs ? Math.min(100, (db / rec.durationMs) * 100) : 0;
  const tickStep = niceStep(total / 5);
  const ticks = [];
  for (let t = 0; t <= total + 1e-9 && ticks.length < 9; t += tickStep) ticks.push(t);

  const n1 = repeated(rec.queries);
  const notes = [];
  if (rec.error) {
    notes.push(
      h(
        'div',
        { class: 'note' },
        h('span', { class: ['mono', statusClass(rec.error.status)] }, `${rec.error.status} ${rec.error.code}`),
        h('span', { class: 'note-text' }, rec.error.message),
        h('button', { class: 'link-btn', onclick: () => goTo('error') }, 'View error'),
      ),
    );
  }
  if (n1.length) {
    const parts = n1.slice(0, 3).map((g) => `${g.length} ${g[0].command} on ${g[0].collection}`);
    notes.push(
      h(
        'div',
        { class: 'note' },
        h('span', { class: 'badge b-amber' }, 'N+1'),
        h('span', { class: 'note-text' }, `${parts.join(', ')} with the same shape. Batch with `, h('code', null, '$in'), ' or ', h('code', null, '?include='), '.'),
        h('button', { class: 'link-btn', onclick: () => goTo('queries', n1[0][0].id) }, 'Show queries'),
      ),
    );
  }

  const tipFor = (q) => () => [
    h('div', { class: 'tip-title mono' }, `${q.command} ${q.collection ?? ''}`),
    h('div', { class: 'tip-row' }, joined([fmtMs(q.durationMs), `starts ${offText(q.off)}`, q.docs != null ? plural(q.docs, 'doc') : null, q.ok === false ? h('span', { class: 't-red' }, 'failed') : null])),
  ];

  const trackRow = (label, content, cls) => h('div', { class: ['wf-row', cls] }, h('div', { class: 'wf-label' }, label), h('div', { class: 'wf-track' }, content));
  const barEl = (left, width, cls, text, tip, onclick, aria) => {
    const b = h('button', { class: ['wf-bar', cls], style: { left: pct(left), width: `max(2px, ${pct(width)})` }, onclick, tabindex: onclick ? '0' : '-1', 'aria-label': aria });
    if (tip) hoverTip(b, tip);
    return [b, h('span', { class: 'wf-val mono', style: { left: `calc(${pct(left + width)} + 6px)` } }, text)];
  };

  return h(
    'div',
    { class: 'tl' },
    notes.length ? h('div', { class: 'notes' }, notes) : null,
    h(
      'div',
      { class: 'tl-sum' },
      h('span', null, h('span', { class: 'mono strong' }, fmtMs(rec.durationMs)), ' total'),
      h('span', null, h('i', { class: 'sw sw-db' }), h('span', { class: 'mono' }, fmtMs(db)), ` in MongoDB (${Math.round(dbShare)}%)`),
      h('span', null, h('i', { class: 'sw sw-app' }), h('span', { class: 'mono' }, fmtMs(Math.max(0, (rec.durationMs ?? 0) - db))), ' in your code and the framework'),
    ),
    h(
      'div',
      { class: 'wf' },
      h('div', { class: 'wf-row wf-axis' }, h('div', { class: 'wf-label' }, plural(qs.length, 'query', 'queries')), h('div', { class: 'wf-track' }, ticks.map((t) => h('span', { class: 'wf-tick mono', style: { left: pct(t) } }, t === 0 ? '0' : fmtMs(t))))),
      h(
        'div',
        { class: 'wf-rows' },
        h('div', { class: 'wf-grid', 'aria-hidden': 'true' }, ticks.map((t) => h('span', { style: { left: pct(t) } }))),
        trackRow(
          [h('span', { class: 'wf-idx' }), methodTag(rec.method), h('span', { class: 'wf-coll' }, 'request')],
          barEl(0, rec.durationMs ?? 0, 'b-req', fmtMs(rec.durationMs), () => [h('div', { class: 'tip-title mono' }, `${rec.method} ${rec.path}`), h('div', { class: 'tip-row' }, `${fmtMs(rec.durationMs)} total`)], null, `${rec.method} ${rec.path}, ${fmtMs(rec.durationMs)}`),
          'wf-req',
        ),
        qs.map((q) =>
          trackRow(
            [h('span', { class: 'wf-idx' }, q.i + 1), h('span', { class: 'wf-cmd' }, q.command), h('span', { class: 'wf-coll' }, q.collection ?? '')],
            barEl(q.off, q.dur, `b-${q.ok === false ? 'fail' : kindOf(q.command)}`, fmtMs(q.durationMs), tipFor(q), () => goTo('queries', q.id), `${q.command} ${q.collection ?? ''}, ${fmtMs(q.durationMs)} at ${offText(q.off)}. Show query`),
            q.ok === false && 'failed',
          ),
        ),
        logs.length
          ? trackRow(
              [h('span', { class: 'wf-idx' }), h('span', { class: 'wf-cmd' }, 'logs'), h('span', { class: 'wf-coll' }, logs.length)],
              logs.map((l) => {
                const b = h('button', { class: `wf-log lv-${l.level}`, style: { left: pct(l.off) }, onclick: () => goTo('logs'), 'aria-label': `${l.level} at ${offText(l.off)}: ${l.msg}` });
                hoverTip(b, () => [h('div', { class: 'tip-title' }, l.msg), h('div', { class: 'tip-row' }, `${l.level} at ${offText(l.off)}`)]);
                return b;
              }),
            )
          : null,
      ),
    ),
    !qs.length ? h('p', { class: 'muted pad-x' }, 'No database queries ran during this request.') : null,
    h('div', { class: 'wf-legend' }, h('span', null, h('i', { class: 'sw b-read' }), 'read'), h('span', null, h('i', { class: 'sw b-write' }), 'write'), h('span', null, h('i', { class: 'sw b-other' }), 'other'), h('span', null, h('i', { class: 'sw b-fail' }), 'failed'), h('span', { class: 'spacer' }), h('span', null, 'Click a bar for the query')),
  );
}

function queriesView(rec) {
  if (!rec.queries.length) return empty('No queries. This request did not touch MongoDB.');
  const t0 = rec.startedAtMs ?? Date.parse(rec.startedAt);
  const n1 = repeated(rec.queries);
  const flagged = new Set(n1.flat().map((q) => q.id));
  return h('div', { class: 'ql' }, rec.queries.map((q, i) => queryRow(q, { index: i + 1, offset: q.startedAt - t0, repeated: flagged.has(q.id) })));
}

function stripUndefined(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj;
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && !(typeof v === 'object' && !Array.isArray(v) && !Object.keys(v).length)));
}

/** One query as a compact row; expands to the full command, explain and copy. */
export function queryRow(q, { index, offset, absolute, repeated: rep } = {}) {
  const summary = stripUndefined(q.summary);
  const value = !summary || !Object.keys(summary).length ? q.raw : summary;
  const canExplain = ['find', 'aggregate', 'count', 'distinct', 'update', 'delete', 'findAndModify'].includes(q.command);
  const body = h('div', { class: 'qr-body', hidden: true });
  let built = false;
  const build = () => {
    built = true;
    const explainHost = h('div', { class: 'qr-explain' });
    const explainBtn = canExplain ? h('button', { class: 'btn', onclick: () => explain(q, explainHost, explainBtn) }, 'Explain') : null;
    mount(
      body,
      codeBlock(value, 'qr-code'),
      q.error ? h('div', { class: 'note' }, h('span', { class: 'badge b-red' }, 'failed'), h('span', { class: 'note-text' }, q.error)) : null,
      h('div', { class: 'qr-actions' }, explainBtn, h('button', { class: 'btn ghost', onclick: () => copy(JSON.stringify(q.raw, null, 2), 'Command copied') }, 'Copy command'), h('span', { class: 'spacer' }), h('span', { class: 'muted mono' }, q.database)),
      explainHost,
    );
  };
  const line = h(
    'button',
    { class: ['qr-line', index == null && 'no-idx'], 'aria-expanded': 'false', type: 'button' },
    index != null ? h('span', { class: 'qr-idx num' }, index) : null,
    h('span', { class: 'qr-cmd' }, rep ? h('span', { class: 'dot dot-amber', title: 'Repeated with the same shape in this request (possible N+1)' }) : null, q.command),
    h('span', { class: 'qr-coll' }, q.collection ?? q.database),
    h('span', { class: 'qr-sum' }, jsonLine(value)),
    h('span', { class: 'qr-docs num' }, q.ok === false ? h('span', { class: 'badge b-red' }, 'failed') : q.docs != null ? plural(q.docs, 'doc') : ''),
    h('span', { class: 'qr-off num', title: absolute ? fullDate(q.startedAt) : 'Offset from request start' }, absolute ? clock(q.startedAt) : offset != null ? offText(offset) : ''),
    h('span', { class: ['qr-dur num', q.durationMs > 50 && 't-amber'] }, fmtMs(q.durationMs)),
  );
  const el = h('div', { class: ['qr', q.ok === false && 'failed'], dataset: { qid: q.id } }, line, body);
  line.addEventListener('click', () => {
    const open = body.hidden;
    if (open && !built) build();
    body.hidden = !open;
    el.classList.toggle('open', open);
    line.setAttribute('aria-expanded', String(open));
    if (!open) el.classList.remove('target');
  });
  return el;
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
    const chain = h('span', { class: 'plan-chain mono' }, stages.map((st, i) => [i ? h('span', { class: 'plan-arrow', 'aria-hidden': 'true' }, ' → ') : null, st.stage === 'COLLSCAN' ? h('span', { class: 'badge b-red' }, 'COLLSCAN') : h('span', { class: st.stage === 'IXSCAN' ? 't-green' : null }, st.stage, st.index ? h('span', { class: 'muted' }, ` ${st.index}`) : null)]));
    let hint;
    if (plan.collscan) {
      hint = emptyFilterHint(fields, plan.namespace ?? q.collection);
    } else if (plan.indexes.length) {
      hint = h('span', null, 'Uses index ', plan.indexes.map((x, i) => [i ? ', ' : '', h('code', null, x)]), '.');
    } else hint = 'No collection scan in the winning plan.';
    mount(host, h('div', { class: 'plan' }, h('span', { class: 'plan-label' }, 'Plan'), chain, h('div', { class: 'plan-hint' }, hint)));
  } catch (err) {
    mount(host, h('div', { class: 'plan t-red' }, err.message));
  } finally {
    btn.disabled = false;
  }
}

function emptyFilterHint(fields, ns) {
  if (!fields.length) return `Reads every document in ${ns}. There is no filter, which is fine while the collection is small; paginate or sort on an indexed field as it grows.`;
  return h('span', null, `Reads every document in ${ns}. Index `, fields.map((f, i) => [i ? ', ' : '', h('code', null, f)]), ' with ', h('code', null, '.index()'), ' or ', h('code', null, '.unique()'), ' on the field.');
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

const section = (title, note, ...kids) => h('section', { class: 'sect' }, h('h3', { class: 'sect-title' }, title, note ? h('span', { class: 'sect-note' }, note) : null), kids);

function requestView(rec) {
  const url = `${location.origin}${rec.path}`;
  const hasAuth = Boolean(rec.requestHeaders?.authorization);
  return h(
    'div',
    { class: 'stack' },
    section(
      'General',
      null,
      h(
        'dl',
        { class: 'kv' },
        h('dt', null, 'URL'), h('dd', { class: 'mono' }, url),
        h('dt', null, 'Route'), h('dd', { class: 'mono' }, routeOf(rec) ?? h('span', { class: 'muted' }, 'no route matched')),
        h('dt', null, 'Status'), h('dd', null, statusTag(rec.status), ' ', STATUS_TEXT[rec.status] ?? ''),
        h('dt', null, 'Client IP'), h('dd', { class: 'mono' }, rec.ip ?? ''),
        h('dt', null, 'Request id'), h('dd', { class: 'mono' }, rec.id),
        h('dt', null, 'Started'), h('dd', null, fullDate(rec.startedAt)),
        h('dt', null, 'User'), h('dd', null, rec.user ? `${rec.user.name} <${rec.user.email ?? ''}> ${(rec.user.roles ?? []).join(', ')}` : h('span', { class: 'muted' }, 'anonymous')),
      ),
    ),
    section('Headers', hasAuth ? 'Authorization is redacted, cookies are never stored' : null, kvTable(rec.requestHeaders)),
    section('Body', rec.requestBody != null ? 'Secret looking fields are recorded as [redacted]' : null, rec.requestBody == null ? h('p', { class: 'muted' }, 'No body') : jsonViewer(rec.requestBody, { open: 3 })),
  );
}

function responseView(rec) {
  return h(
    'div',
    { class: 'stack' },
    h('div', { class: 'resp-line' }, statusTag(rec.status), h('span', null, STATUS_TEXT[rec.status] ?? ''), h('span', { class: 'muted mono' }, fmtMs(rec.durationMs))),
    rec.responseBody == null
      ? empty(rec.status === 204 ? 'No content.' : 'No JSON body.')
      : rec.responseBody?.truncated
        ? [h('p', { class: 'muted' }, 'Body larger than 64 KB, showing a preview.'), h('pre', { class: 'code' }, rec.responseBody.preview)]
        : jsonViewer(rec.responseBody, { open: 3 }),
  );
}

function logsView(rec) {
  if (!rec.logs?.length) return empty('No logs for this request. Lines from `ctx.log.info()` are linked here by request id.');
  return h('div', { class: 'log-list' }, rec.logs.map((l) => logRow(l, { linkRequest: false })));
}

function errorView(rec) {
  const err = rec.error;
  const root = store.overview?.app.root;
  const details = err.details;
  const sameMessage = err.internal && err.internal === err.message;
  return h(
    'div',
    { class: 'stack' },
    h(
      'div',
      { class: 'err-head' },
      h('div', { class: 'err-title' }, h('span', { class: ['mono', statusClass(err.status)] }, `${err.status} ${err.code}`), h('span', null, err.message)),
      h('div', { class: 'muted' }, 'Sent to the client as ', h('code', null, `{ error: { code: "${err.code}", message } }`)),
    ),
    err.internal && !sameMessage ? section('Internal message', 'never sent to the client', h('pre', { class: 'code plain' }, err.internal)) : null,
    details
      ? section(
          'Details',
          null,
          details && typeof details === 'object' && !Array.isArray(details) && Object.values(details).every((v) => typeof v === 'string')
            ? h('dl', { class: 'kv' }, Object.entries(details).map(([k, v]) => [h('dt', { class: 'mono' }, k), h('dd', { class: 't-amber' }, v)]))
            : jsonViewer(details, { open: 3 }),
        )
      : null,
    err.stack ? section('Stack trace', null, stackView(err.stack, root)) : null,
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
  const lostAuth = !store.actAs && rec.requestHeaders?.authorization;
  const who = store.actAs ? ` as ${firstName(store.actAs.user.name)}` : lostAuth ? ' without auth' : '';
  const note = redacted ? ', secrets sent as [redacted]' : '';
  const opener = id ? { label: 'Open', run: () => (location.hash = `#/requests/${id}`) } : null;
  const actAs = lostAuth && rec.user && store.overview?.auth ? { label: `Act as ${firstName(rec.user.name)}`, run: async () => { await startActAs(rec.user); replay(rec); } } : null;
  toast(`Replayed${who}: ${res.status} ${STATUS_TEXT[res.status] ?? ''} in ${fmtMs(ms)}${note}`, { tone: res.ok ? 'info' : 'warn', action: actAs ?? opener });
}

// ---- path: the way a request took through the code ---------------------------------

const STEP_GLYPH = { rateLimit: '⏱', auth: '◉', guard: '◆', policy: '§', input: '✓', service: '▸', hook: '↳', handler: 'ƒ', event: '✦', error: '✖', middleware: '·' };

function pathTraceView(rec) {
  const root = store.overview?.app?.root ?? null;
  const steps = rec.steps ?? [];
  const items = steps.map((st) => {
    const bad = st.outcome === 'denied' || st.outcome === 'failed';
    const detail = Array.isArray(st.detail)
      ? h('div', { class: 'pt-tokens' }, st.detail.map((t) => h('div', { class: ['pt-token', `pt-${t.result}`] }, h('span', { class: 'mono' }, t.token), h('span', null, t.why))), st.note ? h('div', { class: 'pt-note' }, st.note) : null)
      : st.detail != null
        ? h('div', { class: 'pt-detail' }, typeof st.detail === 'string' ? st.detail : JSON.stringify(st.detail))
        : null;
    return h(
      'li',
      { class: ['pt-step', bad && 'pt-bad', st.outcome === 'answered' && 'pt-answered'] },
      h('span', { class: 'pt-at mono' }, `${st.at ?? 0} ms`),
      h('span', { class: 'pt-glyph', 'aria-hidden': 'true' }, STEP_GLYPH[st.kind] ?? '·'),
      h(
        'div',
        { class: 'pt-main' },
        h('div', { class: 'pt-head' }, h('span', { class: 'pt-kind' }, st.kind), h('span', { class: 'pt-name mono' }, st.name), st.ms != null ? h('span', { class: 'muted mono' }, `${st.ms} ms`) : null, st.file ? fileLink(root, st.file, { line: st.line ?? undefined }) : null),
        detail,
      ),
    );
  });
  const ran = steps.some((st) => st.kind === 'handler' || st.kind === 'hook');
  return h(
    'div',
    { class: 'pt' },
    h('p', { class: 'muted pt-intro' }, 'The path this request took through the code, in order. Agents read the same with calm_explain.'),
    h('ol', { class: 'pt-list' }, items),
    ran ? null : h('p', { class: 'pt-stop' }, 'The service and hooks did not run.'),
  );
}

// ---- recorded tests and replay (calm/replay.js) --------------------------------------

async function saveAsTest(rec) {
  try {
    const out = await api(`/requests/${encodeURIComponent(rec.id)}/test`, { method: 'POST', body: {} });
    toast(`Wrote ${out.file}. Run it with npm test.`, { timeout: 7000 });
  } catch (err) {
    toast(err.message, { tone: 'error' });
  }
}

async function replayTraffic(btn) {
  btn.disabled = true;
  const old = btn.textContent;
  btn.textContent = 'Replaying…';
  try {
    const r = await api('/replay', { method: 'POST', body: { limit: 200 } });
    if (!r.total) return toast('Nothing recorded yet: use the API first. Requests are kept in .calm/traffic.jsonl.');
    const lines = [h('p', null, h('b', null, `${r.identical} of ${r.total}`), ' answers are identical', r.skipped.length ? `, ${r.skipped.length} skipped` : '', r.failed.length ? `, ${r.failed.length} failed` : '', '.')];
    for (const c of r.changed.slice(0, 20)) {
      lines.push(h('div', { class: ['rp-row', c.newFields && 'bad'] }, h('div', { class: 'mono' }, c.request), c.differences.slice(0, 6).map((d) => h('div', { class: ['rp-diff', d.kind === 'added' && 'bad'] }, d.text))));
    }
    if (r.changed.length > 20) lines.push(h('p', { class: 'muted' }, `…and ${r.changed.length - 20} more: npx calm replay --json`));
    popover(btn, h('div', { class: 'rp-pop' }, h('h3', null, r.changed.length ? `${r.changed.length} answer${r.changed.length === 1 ? '' : 's'} changed` : 'Nothing changed'), lines), { align: 'end', width: 460 });
  } catch (err) {
    toast(err.message, { tone: 'error' });
  } finally {
    btn.disabled = false;
    btn.textContent = old;
  }
}
