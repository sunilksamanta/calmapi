// Mail: everything the app sent through the dev transport, as an inbox.

import { h, mount, empty, relTime, fullDate, linkify, avatar, tabs, jsonViewer, panelHead, searchBox } from '../lib.js';
import { store, on, emit } from '../store.js';

const state = { filter: '' };

export default {
  id: 'mail',
  label: 'Mail',
  icon: 'mail',
  badge: () => {
    const unread = store.mails.filter((m) => !store.seenMail.has(m.id)).length;
    return unread ? { text: unread, tone: 'teal' } : { text: store.mails.length || '' };
  },
  mount: mountMail,
};

const snippet = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 110);

function mountMail(root, params) {
  let openId = params[0] ? Number(params[0]) : null;
  let tab = 'text';
  const list = h('div', { class: 'mail-list', role: 'listbox', 'aria-label': 'Inbox' });
  const reader = h('section', { class: 'mail-reader', 'aria-label': 'Message' });
  const split = h('div', { class: 'mail-split' }, h('div', { class: 'mail-list-pane' }, h('div', { class: 'toolbar pad' }, searchBox({ placeholder: 'Filter mail', value: state.filter, oninput: (v) => ((state.filter = v), render()) })), list), reader);

  const visible = () => {
    const q = state.filter.trim().toLowerCase();
    return store.mails.filter((m) => !q || `${m.to} ${m.from} ${m.subject} ${m.text}`.toLowerCase().includes(q));
  };

  function render() {
    const mails = visible();
    if (!store.mails.length) {
      split.classList.add('is-empty');
      const forgot = store.overview?.routes.find((r) => r.path.endsWith('/auth/password/forgot'));
      return mount(
        list,
        empty({
          icon: 'inbox',
          title: 'Emails sent in development land here',
          hint: 'Nothing is delivered for real: the dev transport hands every message to devtools instead. Trigger one, for example a password reset.',
          code: forgot ? `curl -X POST ${location.origin}${forgot.path} -H 'Content-Type: application/json' --data '{"email":"you@example.com"}'` : null,
          action: forgot ? { label: 'Try it in the Playground', icon: 'send', run: () => ((store.prefill = { method: 'POST', path: forgot.path, body: '{\n  "email": "you@example.com"\n}' }), (location.hash = '#/playground')) } : null,
        }),
      );
    }
    split.classList.remove('is-empty');
    if (openId == null && mails[0]) openId = mails[0].id;
    if (openId != null && !store.seenMail.has(openId)) {
      store.seenMail.add(openId);
      emit('mails:seen');
    }
    mount(
      list,
      mails.length
        ? mails.map((m) =>
            h(
              'button',
              { class: ['mail-item', m.id === openId && 'active', !store.seenMail.has(m.id) && 'unread'], role: 'option', 'aria-selected': String(m.id === openId), onclick: () => open(m.id) },
              avatar(m.to, 30),
              h(
                'span',
                { class: 'mail-item-text' },
                h('span', { class: 'mail-item-top' }, h('span', { class: 'mail-to ellipsis' }, m.to), h('span', { class: 'muted small num', title: fullDate(m.sentAt) }, relTime(m.sentAt))),
                h('span', { class: 'mail-subject ellipsis' }, m.subject),
                h('span', { class: 'mail-snippet' }, snippet(m.text)),
              ),
            ),
          )
        : empty({ icon: 'search', title: 'No mail matches', hint: 'Clear the filter to see everything.' }),
    );
    renderReader();
  }

  function open(id) {
    openId = id;
    history.replaceState(null, '', `#/mail/${id}`);
    render();
  }

  function renderReader() {
    const m = store.mails.find((x) => x.id === openId);
    if (!m) return mount(reader, empty({ icon: 'mail', title: 'Select a message', hint: 'Pick an email on the left to read it.' }));
    const tabDefs = [{ id: 'text', label: 'Text' }, m.html ? { id: 'html', label: 'HTML' } : null, { id: 'raw', label: 'Raw' }].filter(Boolean);
    if (!tabDefs.some((t) => t.id === tab)) tab = 'text';
    const content = h('div', { class: 'mail-content' });
    const paint = () => {
      if (tab === 'text') return mount(content, h('div', { class: 'mail-text' }, linkify(m.text ?? '(no text part)')));
      if (tab === 'html') {
        // Rendered in a sandboxed frame: no scripts, no same-origin access.
        const frame = h('iframe', { class: 'mail-html', sandbox: '', title: 'HTML version', referrerpolicy: 'no-referrer' });
        frame.srcdoc = m.html;
        return mount(content, frame);
      }
      return mount(content, jsonViewer(m, { open: 2 }));
    };
    const meta = Object.entries(m.meta ?? {}).filter(([, v]) => v != null && typeof v !== 'object');
    mount(
      reader,
      h(
        'header',
        { class: 'mail-head' },
        h('h2', { class: 'mail-title' }, m.subject),
        h(
          'dl',
          { class: 'mail-meta' },
          h('dt', null, 'From'), h('dd', null, m.from ?? ''),
          h('dt', null, 'To'), h('dd', null, Array.isArray(m.to) ? m.to.join(', ') : m.to),
          h('dt', null, 'Sent'), h('dd', null, fullDate(m.sentAt), h('span', { class: 'muted' }, ` · ${relTime(m.sentAt)}`)),
        ),
        meta.length ? h('div', { class: 'mail-tags' }, meta.map(([k, v]) => h('span', { class: 'badge t-gray', title: `${k}: ${v}` }, h('span', { class: 'muted' }, `${k} `), String(v).length > 28 ? `${String(v).slice(0, 26)}…` : String(v)))) : null,
      ),
      tabs(tabDefs, tab, (t) => ((tab = t), paint())),
      content,
    );
    paint();
  }

  mount(root, h('div', { class: 'panel' }, panelHead({ title: 'Mail', sub: `Development inbox. Transport: ${store.overview?.mail ?? 'none'}. Nothing leaves your machine.` }), split));
  render();
  const off = on('mails:reset', (e) => {
    if (e?.fresh && store.mails[0]) openId = openId ?? store.mails[0].id;
    render();
  });
  return {
    destroy: off,
    update(p) {
      if (p[0] && Number(p[0]) !== openId) open(Number(p[0]));
    },
    onKey(e) {
      const mails = visible();
      const i = mails.findIndex((m) => m.id === openId);
      if (e.key === 'j' || e.key === 'ArrowDown') mails[i + 1] && open(mails[i + 1].id);
      else if (e.key === 'k' || e.key === 'ArrowUp') mails[i - 1] && open(mails[i - 1].id);
      else return;
      e.preventDefault();
      list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
    },
  };
}
