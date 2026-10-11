// Logs: live tail with level chips, text filter and links to the request that logged.

import { h, icon, mount, clock, fullDate, empty, searchBox, panelHead } from '../lib.js';
import { store, on } from '../store.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const state = { levels: new Set(LEVELS), filter: '', follow: true };

export default {
  id: 'logs',
  label: 'Logs',
  icon: 'logs',
  badge: () => {
    const errors = store.logs.filter((l) => l.level === 'error').length;
    const warns = store.logs.filter((l) => l.level === 'warn').length;
    if (errors) return { text: errors, tone: 'red' };
    if (warns) return { text: warns, tone: 'amber' };
    return { text: store.logs.length || '' };
  },
  mount: mountLogs,
};

function fieldValue(v) {
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** One log line. Also used inside the request detail. */
const reqLink = (requestId) => h('a', { class: 'log-req mono', href: `#/requests/${requestId}`, title: `Open request ${requestId}` }, icon('activity', 12), requestId.slice(0, 8));

export function logRow(entry, { linkRequest = true } = {}) {
  const { time, level, msg, requestId, ...fields } = entry;
  const errField = Object.entries(fields).find(([, v]) => v && typeof v === 'object' && v.stack);
  const extras = Object.entries(fields).filter(([k]) => !errField || k !== errField[0]);
  return h(
    'div',
    { class: ['log-row', `lv-${level}`] },
    h('span', { class: 'log-time num', title: fullDate(time) }, clock(time, true)),
    h('span', { class: `log-lvl lvl-${level}` }, level),
    h(
      'div',
      { class: 'log-main' },
      h('span', { class: 'log-msg' }, msg),
      extras.map(([k, v]) => h('span', { class: 'log-field' }, h('span', { class: 'log-k' }, k), '=', h('span', { class: 'log-v' }, fieldValue(v)))),
      errField ? h('details', { class: 'log-stack' }, h('summary', null, `${errField[1].name ?? 'Error'}: ${errField[1].message ?? ''}`), h('pre', null, errField[1].stack)) : null,
    ),
    linkRequest && requestId
      ? store.requests.some((r) => r.id === requestId)
        ? reqLink(requestId)
        : h('span', { class: 'log-req gone mono', dataset: { rid: requestId }, title: `Request ${requestId} is not recorded (a devtools call, still running, or rotated out)` }, requestId.slice(0, 8))
      : h('span'),
  );
}

function mountLogs(root) {
  const list = h('div', { class: 'log-list', role: 'log', 'aria-live': 'off' });
  const scroller = h('div', { class: 'log-scroll' }, list);
  const chips = h('div', { class: 'lvl-chips', role: 'group', 'aria-label': 'Levels' });
  const followBtn = h('button', { class: 'btn ghost', 'aria-pressed': String(state.follow), onclick: () => setFollow(!state.follow) });

  const matches = (l) => {
    if (!state.levels.has(l.level)) return false;
    const q = state.filter.trim().toLowerCase();
    return !q || JSON.stringify(l).toLowerCase().includes(q);
  };

  function setFollow(v) {
    state.follow = v;
    followBtn.setAttribute('aria-pressed', String(v));
    mount(followBtn, icon(v ? 'arrowDown' : 'pause', 14), v ? 'Following' : 'Paused');
    if (v) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderChips() {
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const l of store.logs) counts[l.level] = (counts[l.level] ?? 0) + 1;
    mount(
      chips,
      LEVELS.map((lv) =>
        h(
          'button',
          {
            class: ['lvl-chip', `lvl-${lv}`],
            'aria-pressed': String(state.levels.has(lv)),
            onclick: () => {
              if (state.levels.has(lv)) state.levels.delete(lv);
              else state.levels.add(lv);
              render();
            },
          },
          h('span', { class: 'lvl-dot' }),
          lv,
          h('span', { class: 'num muted' }, counts[lv]),
        ),
      ),
    );
  }

  function render() {
    renderChips();
    const items = store.logs.filter(matches);
    if (!store.logs.length) mount(list, empty({ icon: 'logs', title: 'No logs yet', hint: 'Everything your app logs (access lines, `ctx.log.info()`, warnings) streams here, linked to its request.' }));
    else if (!items.length) mount(list, empty({ icon: 'search', title: 'No log lines match', hint: 'Turn a level back on or clear the filter.' }));
    else mount(list, items.map((l) => logRow(l)));
    if (state.follow) scroller.scrollTop = scroller.scrollHeight;
  }

  scroller.addEventListener('scroll', () => {
    const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 24;
    if (atBottom !== state.follow) setFollow(atBottom);
  });

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      panelHead({ title: 'Logs', sub: 'Live tail of your app logs. Click a request id to open that request.', actions: [followBtn] }),
      h('div', { class: 'toolbar pad' }, searchBox({ placeholder: 'Filter log lines', value: state.filter, oninput: (v) => ((state.filter = v), render()) }), chips),
      scroller,
    ),
  );
  setFollow(state.follow);
  render();

  const offs = [
    on('log', (entry) => {
      renderChips();
      if (!matches(entry)) return;
      if (!list.querySelector('.log-row')) return render();
      const row = logRow(entry);
      row.classList.add('fresh');
      list.append(row);
      while (list.children.length > 1000) list.firstChild.remove();
      if (state.follow) scroller.scrollTop = scroller.scrollHeight;
    }),
    on('logs:reset', render),
    // Lines logged during a request arrive before the request itself finishes.
    on('request', (r) => {
      for (const el of list.querySelectorAll(`.log-req.gone[data-rid="${CSS.escape(r.id)}"]`)) el.replaceWith(reqLink(r.id));
    }),
  ];
  return {
    destroy: () => offs.forEach((off) => off()),
    onKey(e) {
      if (e.key === 'End' || e.key === 'G') setFollow(true);
    },
  };
}
