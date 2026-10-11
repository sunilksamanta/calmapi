// Logs: live tail with level toggles, text filter and links to the request that logged.

import { h, mount, clock, fullDate, empty, searchBox, bar, plural } from '../lib.js';
import { store, on } from '../store.js';

const LEVELS = ['debug', 'info', 'warn', 'error'];
const SHORT = { debug: 'DBG', info: 'INF', warn: 'WRN', error: 'ERR', fatal: 'FTL', trace: 'TRC' };
const state = { levels: new Set(LEVELS), filter: '', follow: true };

export default {
  id: 'logs',
  label: 'Logs',
  badge: () => {
    const errors = store.logs.filter((l) => l.level === 'error').length;
    const warns = store.logs.filter((l) => l.level === 'warn').length;
    if (errors) return { text: errors, tone: 'red', title: plural(errors, 'error') };
    if (warns) return { text: warns, tone: 'amber', title: plural(warns, 'warning') };
    return { text: store.logs.length || '' };
  },
  mount: mountLogs,
};

function fieldValue(v) {
  if (v && typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

const reqLink = (requestId) => h('a', { class: 'log-req', href: `#/requests/${requestId}`, title: `Open request ${requestId}` }, requestId.slice(0, 8));

/** One log line. Also used inside the request detail. */
export function logRow(entry, { linkRequest = true } = {}) {
  const { time, level, msg, requestId, ...fields } = entry;
  const errField = Object.entries(fields).find(([, v]) => v && typeof v === 'object' && v.stack);
  const extras = Object.entries(fields).filter(([k]) => !errField || k !== errField[0]);
  return h(
    'div',
    { class: ['log-row', `lv-${level}`] },
    h('span', { class: 'log-time', title: fullDate(time) }, clock(time, true)),
    h('span', { class: `log-lvl lvl-${level}`, title: level }, SHORT[level] ?? String(level).slice(0, 3).toUpperCase()),
    h(
      'div',
      { class: 'log-main' },
      h('span', { class: 'log-msg' }, msg),
      extras.map(([k, v]) => h('span', { class: 'log-field' }, `${k}=`, h('span', { class: 'log-v' }, fieldValue(v)))),
      errField ? h('details', { class: 'log-stack' }, h('summary', null, `${errField[1].name ?? 'Error'}: ${errField[1].message ?? ''}`), h('pre', null, errField[1].stack)) : null,
    ),
    linkRequest && requestId
      ? store.requests.some((r) => r.id === requestId)
        ? reqLink(requestId)
        : h('span', { class: 'log-req gone', dataset: { rid: requestId }, title: `Request ${requestId} is not recorded (a devtools call, still running, or rotated out)` }, requestId.slice(0, 8))
      : h('span'),
  );
}

function mountLogs(root) {
  const list = h('div', { class: 'log-list', role: 'log', 'aria-live': 'off' });
  const scroller = h('div', { class: 'scroll log-scroll' }, list);
  const levels = h('div', { class: 'seg', role: 'group', 'aria-label': 'Levels' });
  const followBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Keep the newest line in view (End)', onclick: () => setFollow(!state.follow) });

  const matches = (l) => {
    if (!state.levels.has(l.level)) return false;
    const q = state.filter.trim().toLowerCase();
    return !q || JSON.stringify(l).toLowerCase().includes(q);
  };

  function setFollow(v) {
    state.follow = v;
    followBtn.setAttribute('aria-pressed', String(v));
    followBtn.textContent = v ? 'Following' : 'Follow';
    if (v) scroller.scrollTop = scroller.scrollHeight;
  }

  function renderLevels() {
    const counts = Object.fromEntries(LEVELS.map((l) => [l, 0]));
    for (const l of store.logs) counts[l.level] = (counts[l.level] ?? 0) + 1;
    mount(
      levels,
      LEVELS.map((lv) =>
        h(
          'button',
          {
            type: 'button',
            class: ['seg-btn', 'lvl-toggle', `lvl-${lv}`],
            'aria-pressed': String(state.levels.has(lv)),
            title: state.levels.has(lv) ? `Hide ${lv}` : `Show ${lv}`,
            onclick: () => {
              if (state.levels.has(lv)) state.levels.delete(lv);
              else state.levels.add(lv);
              render();
            },
          },
          lv,
          h('span', { class: 'seg-count' }, counts[lv]),
        ),
      ),
    );
  }

  function render() {
    renderLevels();
    const items = store.logs.filter(matches);
    if (!store.logs.length) mount(list, empty('No logs yet. Access lines and `ctx.log.info()` stream here.'));
    else if (!items.length) mount(list, empty('No log lines match. Turn a level back on or clear the filter.'));
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
      bar('Logs', searchBox({ placeholder: 'Filter lines', value: state.filter, oninput: (v) => ((state.filter = v), render()) }), levels, h('span', { class: 'spacer' }), followBtn),
      scroller,
    ),
  );
  setFollow(state.follow);
  render();

  const offs = [
    on('log', (entry) => {
      renderLevels();
      if (!matches(entry)) return;
      if (!list.querySelector('.log-row')) return render();
      list.append(logRow(entry));
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
