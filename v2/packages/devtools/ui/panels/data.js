// Data: browse documents. The privacy lens puts what MongoDB stores next to what the
// API returns to a given viewer, so you can see exactly what never leaves the server.

import { h, icon, mount, api, inlineValue, jsonViewer, empty, loading, errorBox, segmented, panelHead, popover, pickerList, userOption, avatar, relTime, copy, plural, closePopover } from '../lib.js';
import { store } from '../store.js';

const PAGE = 10;
const state = { resource: null, skip: 0, view: 'lens', viewer: null };
const ANON = { id: null, name: 'Anonymous', sub: 'Signed out visitor, no session' };

export default {
  id: 'data',
  label: 'Data',
  icon: 'database',
  mount: mountData,
};

function reasonFor(key, field) {
  if (key === '__v') return { text: 'internal', never: true, title: 'Mongoose version key' };
  if (!field) return { text: 'not in schema', never: true, title: 'Stored, but not declared in the resource, so never serialized' };
  if (field.flags.includes('hidden')) return { text: 'hidden', never: true, title: '.hidden(): stored, never returned' };
  if (field.flags.includes('writeOnly') || field.type === 'password') return { text: field.type === 'password' ? 'password' : 'write only', never: true, title: 'Accepted on input, never returned' };
  if (field.visibleTo) return { text: `visible to ${field.visibleTo.replace(/\s*\|\s*/g, ' or ')}`, never: false, title: `.visibleTo('${field.visibleTo}')` };
  return { text: 'not returned', never: !field.output, title: 'Not part of the response for this viewer' };
}

function mountData(root, params) {
  const ov = store.overview;
  if (params[0] && ov.resources.some((r) => r.name === params[0])) {
    if (state.resource !== params[0]) state.skip = 0;
    state.resource = params[0];
  }
  if (!ov.resources.some((r) => r.name === state.resource)) state.resource = ov.resources[0]?.name ?? null;

  const body = h('div', { class: 'panel-body data-body' });
  const pager = h('div', { class: 'pager' });
  const banner = h('div', { class: 'lens-banner' });
  const viewerBtn = h('button', { class: 'btn viewer-btn', 'aria-haspopup': 'dialog', onclick: () => pickViewer() });
  let seq = 0;
  let last = null;

  function paintViewer() {
    const v = state.viewer ?? ANON;
    mount(viewerBtn, v.id ? avatar(v.name, 18) : icon('eyeOff', 14), h('span', null, h('span', { class: 'muted' }, 'View as '), h('b', null, v.name)), icon('chevronDown', 14));
  }

  function pickViewer() {
    popover(
      viewerBtn,
      pickerList({
        placeholder: 'Search users by name or email',
        fixed: [ANON],
        load: (q) => api(`/users?q=${encodeURIComponent(q)}`),
        render: userOption,
        onPick: (u) => {
          closePopover();
          state.viewer = u.id ? u : null;
          state.skip = 0;
          paintViewer();
          load();
        },
      }),
      { width: 340 },
    );
  }

  async function load() {
    if (!state.resource) return;
    const mine = ++seq;
    const res = ov.resources.find((r) => r.name === state.resource);
    if (!last) mount(body, loading('Loading documents'));
    else body.classList.add('busy');
    try {
      const qs = new URLSearchParams({ limit: PAGE, skip: state.skip });
      if (state.viewer) qs.set('as', state.viewer.id);
      const out = await api(`/resources/${encodeURIComponent(state.resource)}/docs?${qs}`);
      if (mine !== seq) return;
      last = out;
      render(out, res);
    } catch (err) {
      if (mine === seq) mount(body, errorBox(err));
    } finally {
      body.classList.remove('busy');
    }
  }

  function render(out, res) {
    const viewerName = out.viewer?.name ?? 'Anonymous';
    const withheld = out.items.reduce((n, it) => n + it.notReturned.length, 0);
    const from = out.total ? out.skip + 1 : 0;
    const to = Math.min(out.total, out.skip + out.items.length);
    mount(
      pager,
      h('span', { class: 'muted num' }, `${from}–${to} of ${out.total}`),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous page', disabled: out.skip <= 0, onclick: () => ((state.skip = Math.max(0, out.skip - PAGE)), load()) }, icon('chevronLeft', 16)),
      h('button', { class: 'icon-btn', 'aria-label': 'Next page', disabled: out.skip + out.items.length >= out.total, onclick: () => ((state.skip = out.skip + PAGE), load()) }, icon('chevronRight', 16)),
    );
    mount(
      banner,
      h('span', { class: 'lens-icon' }, icon('eye', 16)),
      h(
        'div',
        null,
        h('b', null, 'Privacy lens. '),
        'Left is the raw document in MongoDB. Right is exactly what ',
        h('code', null, `GET ${res.path}/:id`),
        ' returns to ',
        h('b', null, viewerName),
        '. ',
        withheld ? h('span', null, h('span', { class: 'strike-demo' }, 'Struck'), ' fields never leave the server for this viewer.') : 'Nothing is withheld from this viewer on this page.',
        !out.viewer && !String(res.policy.read).split('|').map((t) => t.trim()).includes('public')
          ? h('div', { class: 'lens-note' }, icon('info', 12), `Anonymous cannot call this route at all (read policy: ${String(res.policy.read).replace(/\s*\|\s*/g, ' or ')}). The lens still shows the field rules.`)
          : null,
      ),
    );
    if (!out.total) {
      const route = ov.routes.find((r) => r.resource === res.name && r.action === 'create');
      return mount(
        body,
        empty({
          icon: 'database',
          title: `No ${res.name} documents yet`,
          hint: route ? `Create one with \`POST ${route.path}\` from the Playground, or from your app.` : 'Documents appear here as your app writes them.',
          action: route ? { label: 'Open in Playground', icon: 'send', run: () => ((store.prefill = { method: 'POST', path: route.path, body: sampleBody(res) }), (location.hash = '#/playground')) } : null,
        }),
      );
    }
    if (state.view !== 'lens') {
      const key = state.view === 'stored' ? 'stored' : 'returned';
      return mount(body, jsonViewer(out.items.map((it) => it[key]), { open: 2, title: key === 'stored' ? 'Stored in MongoDB' : `Returned to ${viewerName}` }));
    }
    const fields = new Map(res.fields.map((f) => [f.name, f]));
    mount(body, h('div', { class: 'lens-list' }, out.items.map((it) => lensCard(it, fields, viewerName))));
  }

  function lensCard(item, fields, viewerName) {
    const { stored, returned } = item;
    const withheld = new Set(item.notReturned);
    const rows = [];
    for (const k of Object.keys(stored)) {
      const rk = k === '_id' ? 'id' : k;
      const reason = withheld.has(k) ? reasonFor(k, fields.get(k)) : null;
      const inReturned = rk in returned;
      const changed = inReturned && JSON.stringify(stored[k]) !== JSON.stringify(returned[rk]);
      rows.push(
        h(
          'div',
          { class: ['lens-row', reason && 'withheld', reason?.never && 'never'] },
          h('div', { class: 'lens-cell stored' }, h('span', { class: 'lens-key' }, k), h('span', { class: 'lens-val' }, inlineValue(stored[k])), reason ? h('span', { class: ['lens-reason', reason.never ? 't-red' : 't-amber'], title: reason.title }, icon(reason.never ? 'lock' : 'eyeOff', 11), reason.text) : null),
          h(
            'div',
            { class: 'lens-cell returned' },
            inReturned
              ? [h('span', { class: 'lens-key' }, rk), h('span', { class: 'lens-val' }, inlineValue(returned[rk])), changed ? h('span', { class: 'lens-changed', title: 'The API transforms this value' }, 'transformed') : null]
              : h('span', { class: 'lens-gap' }, icon('lock', 11), reason?.never ? 'never leaves the server' : `not returned to ${viewerName}`),
          ),
        ),
      );
    }
    for (const k of Object.keys(returned)) {
      if (k in stored || (k === 'id' && '_id' in stored)) continue;
      rows.push(h('div', { class: 'lens-row added' }, h('div', { class: 'lens-cell stored' }, h('span', { class: 'lens-gap soft' }, 'computed by the API')), h('div', { class: 'lens-cell returned' }, h('span', { class: 'lens-key' }, k), h('span', { class: 'lens-val' }, inlineValue(returned[k])))));
    }
    const count = item.notReturned.length;
    return h(
      'article',
      { class: 'card lens-card' },
      h(
        'header',
        { class: 'lens-head' },
        h('button', { class: 'chip-btn mono', title: 'Copy id', onclick: () => copy(item.id, 'Id copied') }, item.id, icon('copy', 12)),
        stored.createdAt ? h('span', { class: 'muted small', title: stored.createdAt }, `created ${relTime(stored.createdAt)}`) : null,
        h('span', { class: 'spacer' }),
        count ? h('span', { class: 'badge t-red' }, icon('lock', 11), `${plural(count, 'field')} withheld`) : h('span', { class: 'badge t-green' }, icon('check', 11), 'all fields returned'),
      ),
      h('div', { class: 'lens-cols' }, h('div', { class: 'lens-colhead' }, icon('database', 13), 'Stored in MongoDB'), h('div', { class: 'lens-colhead' }, icon('send', 13), `Returned to ${viewerName}`)),
      h('div', { class: 'lens-grid' }, rows),
    );
  }

  const resSeg = segmented(
    ov.resources.map((r) => ({ value: r.name, label: r.name })),
    state.resource,
    (v) => {
      state.resource = v;
      state.skip = 0;
      last = null;
      history.replaceState(null, '', `#/data/${v}`);
      load();
    },
    'Resource',
  );

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      panelHead({ title: 'Data', sub: 'Documents as stored, and as your API returns them to each viewer.', actions: [h('button', { class: 'btn ghost', onclick: () => load(), title: 'Reload' }, icon('refresh', 14), 'Reload')] }),
      ov.resources.length
        ? [
            h(
              'div',
              { class: 'toolbar pad' },
              resSeg,
              ov.auth ? viewerBtn : null,
              segmented(
                [
                  { value: 'lens', label: 'Lens', icon: 'eye' },
                  { value: 'stored', label: 'Stored' },
                  { value: 'returned', label: 'Returned' },
                ],
                state.view,
                (v) => {
                  state.view = v;
                  if (last) render(last, ov.resources.find((r) => r.name === state.resource));
                },
                'View',
              ),
              h('span', { class: 'spacer' }),
              pager,
            ),
            h('div', { class: 'lens-banner-wrap' }, banner),
            body,
          ]
        : h('div', { class: 'panel-body' }, empty({ icon: 'database', title: 'No resources yet', hint: 'Create a resource and browse its documents here.', code: 'npx calm make resource post' })),
    ),
  );
  paintViewer();
  load();
  return {
    update(p) {
      if (p[0] && p[0] !== state.resource && ov.resources.some((r) => r.name === p[0])) {
        state.resource = p[0];
        state.skip = 0;
        last = null;
        resSeg.set(p[0]);
        load();
      }
    },
    onKey(e) {
      if (!last) return;
      if (e.key === 'j' || e.key === 'ArrowRight') {
        if (last.skip + last.items.length < last.total) (state.skip = last.skip + PAGE), load();
      } else if (e.key === 'k' || e.key === 'ArrowLeft') {
        if (last.skip > 0) (state.skip = Math.max(0, last.skip - PAGE)), load();
      }
    },
  };
}

export function sampleBody(res) {
  const out = {};
  for (const f of res.fields) {
    if (!f.input || f.flags.includes('owner')) continue;
    if (!f.flags.includes('required') && Object.keys(out).length >= 3) continue;
    if (f.values) out[f.name] = f.values[0];
    else if (f.type === 'ref') out[f.name] = '<id>';
    else if (f.type === 'boolean') out[f.name] = false;
    else if (f.type === 'number' || f.type === 'integer') out[f.name] = 1;
    else if (f.type.endsWith('[]')) out[f.name] = [];
    else if (f.type === 'email') out[f.name] = 'someone@example.com';
    else if (f.type === 'password') out[f.name] = 'a-long-password';
    else if (f.type === 'date') out[f.name] = new Date().toISOString();
    else out[f.name] = `Sample ${f.name}`;
  }
  return JSON.stringify(out, null, 2);
}
