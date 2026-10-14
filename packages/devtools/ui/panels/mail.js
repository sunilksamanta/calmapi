// Mail: everything the app sent through the dev transport, as a two pane inbox.

import { h, mount, empty, relTime, fullDate, linkify, tabs, jsonViewer, bar, searchBox, plural } from '../lib.js';
import { store, on, emit } from '../store.js';

const state = { filter: '' };

export default {
  id: 'mail',
  label: 'Mail',
  badge: () => {
    const unread = store.mails.filter((m) => !store.seenMail.has(m.id)).length;
    return unread ? { text: unread, tone: 'strong', title: `${unread} unread` } : { text: store.mails.length || '' };
  },
  mount: mountMail,
};

const snippet = (text) => String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
const recipients = (to) => (Array.isArray(to) ? to.join(', ') : to ?? '');

function mountMail(root, params) {
  let openId = params[0] ? Number(params[0]) : null;
  let tab = 'text';
  const list = h('div', { class: 'mail-list scroll', role: 'listbox', 'aria-label': 'Inbox' });
  const reader = h('section', { class: 'mail-reader', 'aria-label': 'Message' });
  const count = h('span', { class: 'bar-meta' });

  const visible = () => {
    const q = state.filter.trim().toLowerCase();
    return store.mails.filter((m) => !q || `${m.to} ${m.from} ${m.subject} ${m.text}`.toLowerCase().includes(q));
  };

  function render() {
    const mails = visible();
    count.textContent = `${plural(store.mails.length, 'message')} · ${store.overview?.mail ?? 'no'} transport, nothing is delivered`;
    if (!store.mails.length) {
      const forgot = store.overview?.routes.find((r) => r.path.endsWith('/auth/password/forgot'));
      mount(list, null);
      return mount(
        reader,
        empty('No mail yet. Mail sent in development lands here. Try a password reset:', {
          code: forgot ? `curl -X POST ${location.origin}${forgot.path} -H 'Content-Type: application/json' --data '{"email":"you@example.com"}'` : null,
        }),
      );
    }
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
              { type: 'button', class: ['mail-item', !store.seenMail.has(m.id) && 'unread'], role: 'option', 'aria-selected': String(m.id === openId), onclick: () => open(m.id) },
              h('span', { class: 'mail-item-top' }, h('span', { class: 'mail-to ellipsis' }, recipients(m.to)), h('span', { class: 'muted num', title: fullDate(m.sentAt) }, relTime(m.sentAt))),
              h('span', { class: 'mail-subject ellipsis' }, m.subject),
              h('span', { class: 'mail-snippet ellipsis' }, snippet(m.text)),
            ),
          )
        : empty('No mail matches.'),
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
    if (!m) return mount(reader, empty('Select a message.'));
    const tabDefs = [{ id: 'text', label: 'Text' }, m.html ? { id: 'html', label: 'HTML' } : null, { id: 'raw', label: 'Raw' }].filter(Boolean);
    if (!tabDefs.some((t) => t.id === tab)) tab = 'text';
    const content = h('div', { class: 'mail-content scroll' });
    const paint = () => {
      if (tab === 'text') return mount(content, h('div', { class: 'mail-text' }, linkify(m.text ?? '(no text part)')));
      if (tab === 'html') {
        // Rendered in a sandboxed frame: no scripts, no same-origin access.
        const frame = h('iframe', { class: 'mail-html', sandbox: '', title: 'HTML version', referrerpolicy: 'no-referrer' });
        frame.srcdoc = m.html;
        return mount(content, frame);
      }
      return mount(content, h('div', { class: 'pad' }, jsonViewer(m, { open: 2 })));
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
          { class: 'kv mail-meta' },
          h('dt', null, 'From'), h('dd', null, m.from ?? ''),
          h('dt', null, 'To'), h('dd', null, recipients(m.to)),
          h('dt', null, 'Sent'), h('dd', null, fullDate(m.sentAt), h('span', { class: 'muted' }, ` · ${relTime(m.sentAt)}`)),
          meta.map(([k, v]) => [h('dt', null, k), h('dd', { class: 'mono ellipsis', title: String(v) }, String(v))]),
        ),
      ),
      tabs(tabDefs, tab, (t) => ((tab = t), paint())),
      content,
    );
    paint();
  }

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      bar('Mail', searchBox({ placeholder: 'Filter mail', value: state.filter, oninput: (v) => ((state.filter = v), render()) }), h('span', { class: 'spacer' }), count),
      h('div', { class: 'mail-split' }, list, reader),
    ),
  );
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
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    },
  };
}
