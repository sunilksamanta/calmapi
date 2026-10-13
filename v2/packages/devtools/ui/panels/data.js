// Data: browse documents. The privacy lens puts what MongoDB stores next to what the
// API returns to a given viewer, so you can see exactly what never leaves the server.

import { h, icon, mount, api, inlineValue, jsonViewer, empty, loading, errorBox, segmented, bar, popover, pickerList, userOption, relTime, copy, plural, closePopover, fullDate, toast } from '../lib.js';
import { store } from '../store.js';
import { checkpointButton } from './checkpoints.js';

const PAGE = 10;
const state = { resource: null, skip: 0, view: 'lens', viewer: null };
const ANON = { id: null, name: 'Anonymous', sub: 'Signed out visitor, no session' };

export default {
  id: 'data',
  label: 'Data',
  mount: mountData,
};

function reasonFor(key, field) {
  if (key === '__v') return { text: 'internal', never: true, title: 'Mongoose version key' };
  if (!field) return { text: 'not in schema', never: true, title: 'Stored, but not declared in the resource, so never serialized' };
  if (field.flags.includes('hidden')) return { text: 'hidden', never: true, title: '.hidden(): stored, never returned' };
  if (field.flags.includes('writeOnly') || field.type === 'password') return { text: field.type === 'password' ? 'password' : 'write-only', never: true, title: 'Accepted on input, never returned' };
  if (field.visibleTo) return { text: `${field.visibleTo.replace(/\s*\|\s*/g, ' or ')} only`, never: false, title: `.visibleTo('${field.visibleTo}'): not returned to this viewer` };
  return { text: 'not returned', never: !field.output, title: 'Not part of the response for this viewer' };
}

function mountData(root, params) {
  const ov = store.overview;
  if (params[0] && ov.resources.some((r) => r.name === params[0])) {
    if (state.resource !== params[0]) state.skip = 0;
    state.resource = params[0];
  }
  if (!ov.resources.some((r) => r.name === state.resource)) state.resource = ov.resources[0]?.name ?? null;

  const body = h('div', { class: 'scroll data-scroll' });
  const pager = h('div', { class: 'pager' });
  const viewerBtn = h('button', { class: 'btn ghost picker-btn', type: 'button', 'aria-haspopup': 'dialog', onclick: () => pickViewer() });
  let seq = 0;
  let last = null;

  function paintViewer() {
    const v = state.viewer ?? ANON;
    mount(viewerBtn, h('span', { class: 'muted' }, 'View as'), h('span', null, v.name), icon('chevronDown', 12));
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
      { width: 320 },
    );
  }

  async function sampleData(e) {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      const out = await api('/seed', { method: 'POST', body: { resource: state.resource, count: 10 } });
      const made = Object.entries(out.created).map(([n, k]) => `${k} ${n}`).join(', ');
      toast(out.users.length ? `Added ${made}. Demo users sign in with ${out.users[0].email} / ${out.users[0].password}` : `Added ${made}`, { timeout: out.users.length ? 9000 : undefined });
      state.skip = 0;
      last = null;
      load();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      btn.disabled = false;
    }
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
    const from = out.total ? out.skip + 1 : 0;
    const to = Math.min(out.total, out.skip + out.items.length);
    mount(
      pager,
      h('span', { class: 'bar-meta' }, `${from}–${to} of ${out.total}`),
      h('button', { class: 'icon-btn', 'aria-label': 'Previous page', title: 'Previous page (k)', disabled: out.skip <= 0, onclick: () => ((state.skip = Math.max(0, out.skip - PAGE)), load()) }, icon('chevronLeft', 14)),
      h('button', { class: 'icon-btn', 'aria-label': 'Next page', title: 'Next page (j)', disabled: out.skip + out.items.length >= out.total, onclick: () => ((state.skip = out.skip + PAGE), load()) }, icon('chevronRight', 14)),
    );
    if (!out.total) {
      const route = ov.routes.find((r) => r.resource === res.name && r.action === 'create');
      return mount(
        body,
        empty(`No ${res.name} documents yet. Use **Sample data** above, or from a terminal:`, {
          code: `npx calm seed ${res.name}`,
          action: route ? { label: `Create one with POST ${route.path}`, run: () => ((store.prefill = { method: 'POST', path: route.path, body: sampleBody(res) }), (location.hash = '#/playground')) } : null,
        }),
      );
    }
    if (state.view !== 'lens') {
      const key = state.view === 'stored' ? 'stored' : 'returned';
      return mount(body, h('div', { class: 'pad' }, jsonViewer(out.items.map((it) => it[key]), { open: 2, title: key === 'stored' ? 'Stored in MongoDB' : `Returned to ${viewerName}` })));
    }
    const fields = new Map(res.fields.map((f) => [f.name, f]));
    const canRead = out.viewer || String(res.policy.read).split('|').map((t) => t.trim()).includes('public');
    mount(
      body,
      h(
        'div',
        { class: 'lens', role: 'table', 'aria-label': `${res.name} documents, stored and returned` },
        h(
          'div',
          { class: 'lens-row lens-head', role: 'row' },
          h('span', { role: 'columnheader' }, 'Field'),
          h('span', { role: 'columnheader' }, 'Stored in MongoDB'),
          h(
            'span',
            { role: 'columnheader' },
            `Returned to ${viewerName}`,
            !canRead ? h('span', { class: 't-amber', title: `Read policy: ${res.policy.read}. The lens still shows the field rules.` }, ' · cannot read this route') : null,
          ),
        ),
        out.items.map((it) => lensDoc(it, fields)),
      ),
    );
  }

  function lensDoc(item, fields) {
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
          { class: ['lens-row', reason && 'withheld'], role: 'row' },
          h('span', { class: 'lens-key', role: 'cell' }, k, rk !== k ? h('span', { class: 'muted' }, ` → ${rk}`) : null),
          h(
            'span',
            { class: 'lens-val lens-stored', role: 'cell' },
            h('span', { class: 'lens-v' }, inlineValue(stored[k])),
            reason ? (reason.never ? h('span', { class: 'badge', title: reason.title }, reason.text) : h('span', { class: 'lens-why', title: reason.title }, reason.text)) : null,
          ),
          h('span', { class: 'lens-val', role: 'cell', 'aria-label': inReturned ? null : 'not returned' }, inReturned ? [h('span', { class: 'lens-v' }, inlineValue(returned[rk])), changed ? h('span', { class: 'lens-why', title: 'The API transforms this value' }, 'transformed') : null] : null),
        ),
      );
    }
    for (const k of Object.keys(returned)) {
      if (k in stored || (k === 'id' && '_id' in stored)) continue;
      rows.push(h('div', { class: 'lens-row', role: 'row' }, h('span', { class: 'lens-key', role: 'cell' }, k), h('span', { class: 'lens-val muted', role: 'cell' }, 'computed by the API'), h('span', { class: 'lens-val', role: 'cell' }, h('span', { class: 'lens-v' }, inlineValue(returned[k])))));
    }
    const count = item.notReturned.length;
    return h(
      'div',
      { class: 'lens-doc', role: 'rowgroup' },
      h(
        'div',
        { class: 'lens-doc-head', role: 'row' },
        h('button', { class: 'link-btn mono', title: 'Copy id', onclick: () => copy(item.id, 'Id copied') }, item.id),
        stored.createdAt ? h('span', { class: 'muted', title: fullDate(stored.createdAt) }, `created ${relTime(stored.createdAt)}`) : null,
        h('span', { class: 'spacer' }),
        h('span', { class: 'muted' }, count ? `${plural(count, 'field')} withheld` : 'all fields returned'),
      ),
      rows,
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
      bar(
        'Data',
        ov.resources.length
          ? [
              resSeg,
              h('span', { class: 'bar-sep', 'aria-hidden': 'true' }),
              ov.auth ? viewerBtn : null,
              segmented(
                [
                  { value: 'lens', label: 'Lens', title: 'Privacy lens: the stored document next to exactly what GET /:id returns to the viewer. Withheld fields are struck through.' },
                  { value: 'stored', label: 'Stored', title: 'Raw documents as stored in MongoDB' },
                  { value: 'returned', label: 'Returned', title: 'Documents as the API returns them to the viewer' },
                ],
                state.view,
                (v) => {
                  state.view = v;
                  if (last) render(last, ov.resources.find((r) => r.name === state.resource));
                },
                'View',
              ),
              h('span', { class: 'spacer' }),
              h('button', { class: 'btn ghost', type: 'button', title: 'Create 10 records that look real, from the field definitions, through the service (hooks and validation run)', onclick: sampleData }, 'Sample data'),
              checkpointButton({ onRestored: () => ((state.skip = 0), (last = null), load()) }),
              pager,
              h('button', { class: 'btn ghost', type: 'button', onclick: () => load(), title: 'Reload documents' }, 'Reload'),
            ]
          : null,
      ),
      ov.resources.length ? body : h('div', { class: 'scroll' }, empty('No resources yet. Create one:', { code: 'npx calm make resource post' })),
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
