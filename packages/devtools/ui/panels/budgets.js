// Budgets: what each route costs (MongoDB queries, p95 time, response size) next to the
// budget in calm.config.js. Measured on every request while the dev server runs; the same
// numbers from your tests come from `npx calm budgets --ci`.

import { h, mount, api, bar, loading, errorBox, empty, plural, toast } from '../lib.js';
import { on, store } from '../store.js';

let last = null;

export default {
  id: 'budgets',
  label: 'Budgets',
  badge: () => {
    // Before the panel is opened, the requests seen so far tell which routes went over.
    const over = last ? last.over : new Set(store.requests.filter((r) => r.overBudget?.length).map((r) => `${r.method} ${r.route ?? r.path}`)).size;
    return over ? { text: over, tone: 'red', title: `${plural(over, 'route')} over budget` } : null;
  },
  mount: mountBudgets,
};

const size = (n) => (n == null ? '' : n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);
const ms = (n) => (n == null ? '' : `${Math.round(n)} ms`);

const EXAMPLE = `// calm.config.js
budgets: {
  'GET /api/feed': { queries: 4, p95: '150ms', response: '200kb' },
  '*': { queries: 12, p95: '400ms' },
},`;

function mountBudgets(root) {
  const body = h('div', { class: 'scroll bg' }, loading('Measuring'));
  const reset = h('button', { class: 'btn ghost', type: 'button', title: 'Forget the measurements so far', onclick: () => clearAll() }, 'Reset');
  const refresh = h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, 'Refresh');
  mount(root, h('div', { class: 'panel' }, bar('Budgets', h('span', { class: 'bar-meta' }, 'what each route costs'), h('span', { class: 'spacer' }), reset, refresh), body));

  async function load() {
    try {
      last = await api('/budgets');
      render(last);
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  async function clearAll() {
    await api('/budgets', { method: 'DELETE' }).catch((err) => toast(err.message, { tone: 'error' }));
    load();
  }

  function cell(value, limit, fmt, bad) {
    return h('td', { class: ['num', bad && 'bad'] }, fmt(value), limit != null ? h('span', { class: 'lim' }, ` / ${fmt(limit)}`) : null);
  }

  function render(r) {
    const parts = [];
    if (!r.configured) parts.push(h('p', { class: 'bg-intro muted' }, 'No budgets set yet. The numbers below are measured anyway; give a route a budget in calm.config.js and devtools and npx calm budgets --ci hold it to it:'), h('pre', { class: 'bg-code' }, EXAMPLE));
    else if (r.over) parts.push(h('p', { class: 'bg-intro bg-over' }, `${plural(r.over, 'route')} over budget.`));
    else if (r.routes.length) parts.push(h('p', { class: 'bg-intro muted' }, 'Every measured route is within its budget.'));
    if (!r.routes.length) {
      parts.push(empty('No requests measured yet. Call your API and the routes show up here.'));
      return mount(body, parts);
    }
    parts.push(
      h(
        'table',
        { class: 'bg-table' },
        h('thead', null, h('tr', null, h('th', null, 'Route'), h('th', { class: 'num' }, 'Requests'), h('th', { class: 'num' }, 'Max queries'), h('th', { class: 'num' }, 'p95'), h('th', { class: 'num' }, 'Max size'), h('th', null, 'Budget'))),
        h(
          'tbody',
          null,
          r.routes.map((x) =>
            h(
              'tr',
              { class: !x.ok && 'over', title: x.over.join('\n') || null },
              h('td', { class: 'mono' }, `${x.method} ${x.route}`),
              h('td', { class: 'num' }, x.count),
              cell(x.maxQueries, x.limits.queries, String, x.limits.queries != null && x.maxQueries > x.limits.queries),
              cell(x.p95Ms, x.limits.p95Ms, ms, x.limits.p95Ms != null && x.p95Ms > x.limits.p95Ms),
              cell(x.maxBytes, x.limits.responseBytes, size, x.limits.responseBytes != null && x.maxBytes > x.limits.responseBytes),
              h('td', { class: 'mono muted' }, x.budget ?? 'none'),
            ),
          ),
        ),
      ),
    );
    mount(body, parts);
  }

  let timer = null;
  const off = on('request', () => {
    clearTimeout(timer);
    timer = setTimeout(load, 800);
  });
  load();
  return { destroy: () => (off(), clearTimeout(timer)) };
}
