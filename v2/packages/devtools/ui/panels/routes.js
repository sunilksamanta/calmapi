// Routes: one dense table of every endpoint, grouped by resource or source, with its
// policy, summary and file.

import { h, mount, methodTag, policyText, routePath, fileLink, empty, searchBox, segmented, bar, plural, unsignedBadge } from '../lib.js';
import { store, unsignedAgentFiles } from '../store.js';

const state = { filter: '', hidden: false, policy: 'all' };

export default {
  id: 'routes',
  label: 'Routes',
  badge: () => ({ text: store.overview?.routes.filter((r) => !r.hidden).length ?? '' }),
  mount: mountRoutes,
};

/** CRUD routes report explicit even when the resource policy was defaulted; fix that up here. */
export function isExplicit(route, ov = store.overview) {
  if (!route.policyExplicit) return false;
  if (route.source === 'crud' && route.resource) {
    const res = ov?.resources.find((r) => r.name === route.resource);
    if (res?.defaultedPolicies?.includes(route.action)) return false;
  }
  return true;
}

function groupKey(r) {
  if (r.resource) return `resource:${r.resource}`;
  return `source:${r.source}`;
}

function groupInfo(key, routes, ov) {
  const [kind, name] = key.split(/:(.*)/s);
  if (kind === 'resource') {
    const res = ov.resources.find((x) => x.name === name);
    return { title: name, kind: 'resource', sub: res?.path };
  }
  if (name === 'auth') return { title: 'auth', kind: 'built in', sub: `${ov.app.apiPrefix}/auth` };
  if (name === 'app') return { title: 'app', kind: 'app/routes.js', sub: null };
  if (name.startsWith('block:')) return { title: name.slice(6), kind: 'block', sub: null };
  return { title: name, kind: 'source', sub: null };
}

function matches(r) {
  if (!state.hidden && r.hidden) return false;
  if (state.policy !== 'all') {
    const tokens = String(r.policy).split('|').map((t) => t.trim());
    if (state.policy === 'implicit' ? isExplicit(r) : !tokens.includes(state.policy)) return false;
  }
  const q = state.filter.trim().toLowerCase();
  if (!q) return true;
  return q.split(/\s+/).every((t) => `${r.method} ${r.path} ${r.policy} ${r.summary ?? ''} ${r.resource ?? ''} ${r.source} ${r.file ?? ''}`.toLowerCase().includes(t));
}

function tryIt(r) {
  store.prefill = { method: r.method, path: r.path, body: '', route: r };
  location.hash = '#/playground';
}

function mountRoutes(root) {
  const body = h('div', { class: 'scroll' });
  const counter = h('span', { class: 'bar-meta' });

  function render() {
    const ov = store.overview;
    const all = ov.routes;
    const items = all.filter(matches);
    counter.textContent = items.length === all.length ? plural(all.length, 'route') : `${items.length} of ${all.length} routes`;
    if (!all.length) return mount(body, empty('No routes yet. Create a resource:', { code: 'npx calm make resource post' }));
    if (!items.length) return mount(body, empty('No routes match. Clear the filter or include hidden aliases.'));
    const groups = new Map();
    for (const r of items) {
      const k = groupKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const appRoot = ov.app.root;
    const unsigned = unsignedAgentFiles();
    mount(
      body,
      h(
        'div',
        { class: 'rt', role: 'table', 'aria-label': 'Routes' },
        h('div', { class: 'rt-row rt-head', role: 'row' }, ['Method', 'Path', 'Policy', 'Summary', 'File'].map((t) => h('span', { role: 'columnheader' }, t)), h('span', { 'aria-hidden': 'true' })),
        [...groups].map(([key, routes]) => {
          const g = groupInfo(key, routes, ov);
          return h(
            'div',
            { role: 'rowgroup', id: `routes-${key.replace(/[^\w-]/g, '-')}` },
            h('div', { class: 'rt-group', role: 'row' }, h('span', { class: 'rt-group-name', role: 'rowheader' }, g.title), g.sub ? h('span', { class: 'mono muted' }, g.sub) : null, h('span', { class: 'muted' }, g.kind), h('span', { class: 'spacer' }), h('span', { class: 'muted num' }, routes.length)),
            routes.map((r) =>
              h(
                'div',
                { class: ['rt-row', r.hidden && 'is-hidden'], role: 'row' },
                h('span', { role: 'cell' }, methodTag(r.method)),
                h('span', { class: 'rt-path', role: 'cell', title: `${r.method} ${r.path}${r.hidden ? '\nHidden from OpenAPI (an alias)' : ''}` }, routePath(r.path, ov.app.apiPrefix), r.hidden ? h('span', { class: 'muted rt-alias' }, 'alias') : null),
                h('span', { class: 'rt-policy', role: 'cell' }, policyText(r.policy, { explicit: isExplicit(r, ov) })),
                h('span', { class: 'rt-summary', role: 'cell', title: r.summary ?? r.action ?? null }, r.summary ?? h('span', { class: 'muted' }, r.action)),
                h('span', { class: 'rt-file', role: 'cell' }, r.file ? fileLink(appRoot, r.file) : null, r.file && unsigned.has(r.file) ? unsignedBadge() : null),
                h('span', { class: 'row-actions', role: 'cell' }, h('button', { class: 'btn', type: 'button', onclick: () => tryIt(r), 'aria-label': `Try ${r.method} ${r.path} in the Playground` }, 'Try')),
              ),
            ),
          );
        }),
      ),
    );
  }

  const implicitCount = store.overview.routes.filter((r) => !isExplicit(r)).length;
  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      bar(
        'Routes',
        searchBox({ placeholder: 'Filter path, policy, file', value: state.filter, oninput: (v) => ((state.filter = v), render()) }),
        segmented(
          [
            { value: 'all', label: 'All' },
            { value: 'public', label: 'public' },
            { value: 'authenticated', label: 'authenticated' },
            { value: 'owner', label: 'owner' },
            { value: 'admin', label: 'admin' },
            ...(implicitCount ? [{ value: 'implicit', label: 'Not explicit', count: implicitCount, tone: 'amber', title: 'Routes whose policy was defaulted instead of written out' }] : []),
          ],
          state.policy,
          (v) => ((state.policy = v), render()),
          'Policy filter',
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.hidden, onchange: (e) => ((state.hidden = e.target.checked), render()) }), 'Aliases'),
        h('span', { class: 'spacer' }),
        counter,
      ),
      body,
    ),
  );
  render();
  return { refresh: render };
}
