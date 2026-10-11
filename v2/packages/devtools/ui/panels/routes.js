// Routes: every endpoint grouped by resource or source, with its policy and file.

import { h, icon, mount, methodChip, policyBadges, fileLink, empty, searchBox, segmented, panelHead, plural } from '../lib.js';
import { store } from '../store.js';

const state = { filter: '', hidden: false, policy: 'all' };

export default {
  id: 'routes',
  label: 'Routes',
  icon: 'route',
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

export function pathParts(path, prefix = '') {
  const rest = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
  return h(
    'span',
    { class: 'route-path' },
    prefix && rest !== path ? h('span', { class: 'route-prefix' }, prefix) : null,
    rest.split(/(:[A-Za-z_][\w]*)/g).map((seg) => (seg.startsWith(':') ? h('span', { class: 'route-param' }, seg) : seg)),
  );
}

function groupKey(r) {
  if (r.resource) return `resource:${r.resource}`;
  return `source:${r.source}`;
}

function groupInfo(key, routes, ov) {
  const [kind, name] = key.split(/:(.*)/s);
  if (kind === 'resource') {
    const res = ov.resources.find((x) => x.name === name);
    return { title: name, kind: 'resource', sub: res?.path, file: res?.files?.resource, icon: 'layers' };
  }
  if (name === 'auth') return { title: 'auth', kind: 'built in', sub: `${ov.app.apiPrefix}/auth`, file: routes[0]?.file, icon: 'key' };
  if (name === 'app') return { title: 'app routes', kind: 'app', sub: 'app/routes.js', file: routes[0]?.file, icon: 'route' };
  if (name.startsWith('block:')) return { title: name.slice(6), kind: 'block', file: routes[0]?.file, icon: 'blocks' };
  return { title: name, kind: 'source', file: routes[0]?.file, icon: 'route' };
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
  const body = h('div', { class: 'panel-body routes-body' });
  const counter = h('span', { class: 'muted small num' });

  function render() {
    const ov = store.overview;
    const all = ov.routes;
    const items = all.filter(matches);
    counter.textContent = `${items.length} of ${all.length}`;
    if (!all.length) return mount(body, empty({ icon: 'route', title: 'No routes yet', hint: 'Create a resource and its CRUD routes appear here.', code: 'npx calm make resource post' }));
    if (!items.length) return mount(body, empty({ icon: 'search', title: 'No routes match', hint: 'Clear the filter or include hidden routes.' }));
    const groups = new Map();
    for (const r of items) {
      const k = groupKey(r);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(r);
    }
    const root = ov.app.root;
    mount(
      body,
      [...groups].map(([key, routes]) => {
        const g = groupInfo(key, routes, ov);
        return h(
          'section',
          { class: 'card route-group', id: `routes-${key.replace(/[^\w-]/g, '-')}` },
          h(
            'header',
            { class: 'card-head' },
            h('span', { class: 'card-icon' }, icon(g.icon, 15)),
            h('h2', { class: 'card-title' }, g.title),
            h('span', { class: 'badge t-gray' }, g.kind),
            g.sub ? h('span', { class: 'mono muted small' }, g.sub) : null,
            h('span', { class: 'spacer' }),
            h('span', { class: 'muted small' }, plural(routes.length, 'route')),
          ),
          h(
            'div',
            { class: 'rt-table', role: 'table', 'aria-label': `${g.title} routes` },
            routes.map((r) => {
              const explicit = isExplicit(r, ov);
              return h(
                'div',
                { class: ['rt-row', r.hidden && 'is-hidden'], role: 'row' },
                h('span', { role: 'cell' }, methodChip(r.method)),
                h('span', { class: 'rt-path', role: 'cell', title: `${r.method} ${r.path}` }, pathParts(r.path, ov.app.apiPrefix), r.hidden ? h('span', { class: 'badge t-gray', title: 'Hidden from OpenAPI (an alias)' }, 'hidden') : null),
                h('span', { class: 'rt-policy', role: 'cell' }, policyBadges(r.policy, { explicit })),
                h('span', { class: 'rt-summary', role: 'cell' }, r.summary ?? h('span', { class: 'muted' }, r.action)),
                h('span', { class: 'rt-file', role: 'cell' }, r.file ? fileLink(root, r.file, { label: r.file.split('/').pop() }) : null),
                h('span', { class: 'rt-try', role: 'cell' }, h('button', { class: 'btn xs', onclick: () => tryIt(r), 'aria-label': `Try ${r.method} ${r.path}` }, icon('send', 12), 'Try it')),
              );
            }),
          ),
        );
      }),
    );
  }

  const implicitCount = store.overview.routes.filter((r) => !isExplicit(r)).length;
  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      panelHead({ title: 'Routes', sub: 'Every endpoint, who may call it, and where it is defined.' }),
      h(
        'div',
        { class: 'toolbar pad' },
        searchBox({ placeholder: 'Filter by path, policy, summary, file', value: state.filter, oninput: (v) => ((state.filter = v), render()) }),
        segmented(
          [
            { value: 'all', label: 'All' },
            { value: 'public', label: 'public' },
            { value: 'authenticated', label: 'authenticated' },
            { value: 'owner', label: 'owner' },
            { value: 'admin', label: 'admin' },
            ...(implicitCount ? [{ value: 'implicit', label: 'Not explicit', count: implicitCount }] : []),
          ],
          state.policy,
          (v) => ((state.policy = v), render()),
          'Policy filter',
        ),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: state.hidden, onchange: (e) => ((state.hidden = e.target.checked), render()) }), 'Show hidden aliases'),
        h('span', { class: 'spacer' }),
        counter,
      ),
      body,
    ),
  );
  render();
  return { refresh: render };
}
