// Push: every notification the app sent, how it looks on a phone, the exact payload each
// provider receives and what happened on each device. Plus a composer and simulated devices,
// so you can see a notification before any real phone is involved.

import { h, icon, mount, clear, empty, loading, errorBox, relTime, fullDate, clock, tabs, jsonViewer, bar, searchBox, segmented, plural, api, toast, copy, popover, pickerList, userOption, closePopover } from '../lib.js';
import { store, on, emit, loadPushes } from '../store.js';

export default {
  id: 'push',
  label: 'Push',
  badge: () => {
    const unseen = store.pushes.filter((p) => !store.seenPush.has(p.id)).length;
    return unseen ? { text: unseen, tone: 'strong', title: `${unseen} new` } : { text: store.pushes.length || '' };
  },
  mount: mountPush,
};

const PLATFORM = { ios: 'iPhone', android: 'Android', web: 'Web' };
const STATUS = {
  captured: { label: 'Captured', tone: null, note: 'Shown here, not delivered' },
  sent: { label: 'Delivered', tone: 'green', note: 'Accepted by the provider for every device' },
  partial: { label: 'Partly delivered', tone: 'amber', note: 'Some devices failed, see the delivery log' },
  failed: { label: 'Failed', tone: 'red', note: 'No device received it, see the delivery log' },
  'no-devices': { label: 'No devices', tone: 'amber', note: 'Nobody to send to' },
  pending: { label: 'Sending', tone: null, note: 'Waiting for the transport' },
};
// How much a closed notification shows before it cuts off. Matches VISIBLE in calm/push.js.
const VISIBLE = { ios: { title: 36, body: 150 }, android: { title: 40, body: 46 }, web: { title: 45, body: 90 } };
const PROVIDERS = [
  { id: 'apns', label: 'APNs', note: 'Apple Push Notification service, the JSON body of the HTTP/2 request' },
  { id: 'fcm', label: 'FCM', note: 'Firebase Cloud Messaging HTTP v1, the body of messages:send' },
  { id: 'expo', label: 'Expo', note: 'Expo push service, one entry of the messages array' },
  { id: 'web', label: 'Web Push', note: 'What your service worker receives in event.data.json()' },
];

const state = { filter: '', view: 'inbox', expanded: false };
const draft = {
  user: null, // { id, name, email }
  devices: [], // devices of draft.user, from /devices
  picked: null, // Set of device ids; null means all of them
  title: '',
  subtitle: '',
  body: '',
  image: '',
  url: '',
  badge: '',
  sound: 'default',
  channel: '',
  priority: 'high',
  silent: false,
  data: '',
  more: false,
};

const statusBadge = (status) => {
  const s = STATUS[status] ?? { label: status, tone: null };
  return h('span', { class: ['badge', s.tone === 'red' && 'b-red', s.tone === 'amber' && 'b-amber', s.tone === 'green' && 'b-green'], title: s.note ?? null }, s.label);
};
const headline = (m) => m.title ?? m.body ?? (m.silent ? 'Silent push' : '(empty)');
const who = (p) => {
  const names = (p.people ?? []).map((u) => u.name ?? u.email ?? u.id.slice(-6));
  if (names.length) return names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : names.join(', ');
  return p.to.tokens ? plural(p.to.tokens, 'token') : 'nobody';
};
const isHttps = (url) => /^https:\/\//i.test(url ?? '');

// ---- notification previews ----------------------------------------------------------

function appMark(cls) {
  const name = store.overview?.app.name ?? 'App';
  return h('span', { class: cls, 'aria-hidden': 'true' }, name.replace(/[^a-z0-9]/gi, '').charAt(0).toUpperCase() || 'A');
}

function picture(url, cls) {
  if (!url) return null;
  if (!isHttps(url)) return h('span', { class: [cls, 'np-noimg'], title: 'Phones only load https images' }, 'image');
  const img = h('img', { class: cls, src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(h('span', { class: [cls, 'np-noimg'], title: `Could not load ${url}` }, 'image')));
  return img;
}

function silentStage(m) {
  return h(
    'div',
    { class: 'np-silent' },
    h('p', null, h('b', null, 'Silent push. '), 'Nothing is shown. The app wakes in the background and receives this data:'),
    h('pre', { class: 'np-silent-data' }, JSON.stringify(m.data ?? {}, null, 2)),
  );
}

function iosStage(m, expanded) {
  const app = store.overview?.app.name ?? 'App';
  return h(
    'div',
    { class: ['np-stage', 'np-ios', expanded && 'is-expanded'] },
    h('div', { class: 'np-ios-clock', 'aria-hidden': 'true' }, h('span', null, new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' })), h('b', null, new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', hour12: false }))),
    h(
      'div',
      { class: 'np-card' },
      appMark('np-icon'),
      h(
        'div',
        { class: 'np-body' },
        h('div', { class: 'np-head' }, h('span', { class: 'np-title' }, m.title ?? app), h('span', { class: 'np-when' }, 'now')),
        m.subtitle ? h('div', { class: 'np-sub' }, m.subtitle) : null,
        m.body ? h('div', { class: 'np-text' }, m.body) : null,
      ),
      expanded ? null : picture(m.image, 'np-thumb'),
    ),
    expanded && m.image ? picture(m.image, 'np-big') : null,
    m.badge != null ? h('div', { class: 'np-ios-badge', title: 'The number on the app icon' }, h('span', { class: 'np-ios-app' }, appMark('np-icon sm'), h('span', { class: 'np-ios-count' }, m.badge)), h('span', null, 'App icon badge')) : null,
  );
}

function androidStage(m, expanded) {
  const app = store.overview?.app.name ?? 'App';
  return h(
    'div',
    { class: ['np-stage', 'np-android', expanded && 'is-expanded'] },
    h(
      'div',
      { class: 'np-card' },
      h('div', { class: 'np-a-top' }, appMark('np-a-icon'), h('span', { class: 'ellipsis' }, app), h('span', { class: 'np-when' }, 'now'), icon(expanded ? 'chevronUp' : 'chevronDown', 12)),
      h(
        'div',
        { class: 'np-a-main' },
        h('div', { class: 'np-body' }, m.title ? h('div', { class: 'np-title' }, m.title) : null, m.body ? h('div', { class: 'np-text' }, m.body) : null),
        expanded ? null : picture(m.image, 'np-thumb'),
      ),
      expanded && m.image ? picture(m.image, 'np-big') : null,
    ),
    m.channel ? h('div', { class: 'np-foot' }, 'Channel ', h('code', null, m.channel)) : null,
  );
}

function webStage(m, expanded) {
  return h(
    'div',
    { class: ['np-stage', 'np-web', expanded && 'is-expanded'] },
    h(
      'div',
      { class: 'np-card' },
      m.icon ? picture(m.icon, 'np-icon') : appMark('np-icon'),
      h(
        'div',
        { class: 'np-body' },
        h('div', { class: 'np-title' }, m.title ?? store.overview?.app.name ?? 'Notification'),
        h('div', { class: 'np-origin' }, location.host),
        m.body ? h('div', { class: 'np-text' }, m.body) : null,
      ),
    ),
    expanded && m.image ? picture(m.image, 'np-big') : null,
    m.url ? h('div', { class: 'np-foot' }, 'Click opens ', h('code', null, m.url)) : null,
  );
}

const STAGES = { ios: iosStage, android: androidStage, web: webStage };

function cutNote(m, platform) {
  const v = VISIBLE[platform];
  const cut = [m.title && m.title.length > v.title && 'title', m.body && m.body.length > v.body && 'body'].filter(Boolean);
  return cut.length ? h('span', { class: 't-amber' }, `${cut.join(' and ')} cut off when closed`) : null;
}

/** Previews for the given platforms (all three when none are targeted yet). */
function previews(m, platforms) {
  const list = ['ios', 'android', 'web'].filter((p) => !platforms.length || platforms.includes(p));
  return h(
    'div',
    { class: 'np-grid' },
    list.map((p) =>
      h(
        'figure',
        { class: 'np-frame' },
        h('figcaption', { class: 'np-cap' }, h('span', null, p === 'ios' ? 'iPhone lock screen' : p === 'android' ? 'Android notification shade' : 'Desktop browser'), m.silent ? null : cutNote(m, p)),
        m.silent ? silentStage(m) : STAGES[p](m, state.expanded),
      ),
    ),
  );
}

function expandToggle(onchange) {
  return segmented(
    [
      { value: false, label: 'Closed', title: 'How it looks when it arrives' },
      { value: true, label: 'Expanded', title: 'Long press (iPhone) or pull down (Android)' },
    ],
    state.expanded,
    (v) => {
      state.expanded = v;
      onchange();
    },
    'Notification state',
  );
}

// ---- code a developer (or an agent) can paste ---------------------------------------

function asCode(m, target) {
  const fields = { ...target };
  for (const k of ['title', 'subtitle', 'body', 'image', 'url', 'badge', 'channel', 'data']) if (m[k] != null && m[k] !== '') fields[k] = m[k];
  if (m.sound === null) fields.sound = false;
  else if (m.sound && m.sound !== 'default') fields.sound = m.sound;
  if (m.priority === 'normal') fields.priority = 'normal';
  if (m.silent) fields.silent = true;
  const body = JSON.stringify(fields, null, 2).replace(/"([a-zA-Z_]\w*)":/g, '$1:');
  return `await ctx.push.send(${body});`;
}

// ---- panel ----------------------------------------------------------------------------

function mountPush(root, params) {
  let openId = null;
  let tab = 'preview';
  let provider = 'apns';
  const list = h('div', { class: 'mail-list scroll', role: 'listbox', 'aria-label': 'Notifications' });
  const pane = h('section', { class: 'np-pane', 'aria-label': 'Notification' });
  const count = h('span', { class: 'bar-meta' });
  const viewSeg = segmented(
    [
      { value: 'inbox', label: 'Notifications' },
      { value: 'devices', label: 'Devices' },
    ],
    state.view,
    (v) => go(v === 'devices' ? '#/push/devices' : openId ? `#/push/${openId}` : '#/push'),
    'View',
  );
  const search = searchBox({ placeholder: 'Filter notifications', value: state.filter, oninput: (v) => ((state.filter = v), render()) });
  const body = h('div', { class: 'mail-split np-split' }, list, pane);

  const go = (hash) => {
    if (location.hash === hash) apply(parse(hash));
    else location.hash = hash;
  };
  const parse = (hash) => hash.replace(/^#\/?push\/?/, '').split('/').filter(Boolean);

  const visible = () => {
    const q = state.filter.trim().toLowerCase();
    if (!q) return store.pushes;
    return store.pushes.filter((p) => `${p.message.title ?? ''} ${p.message.body ?? ''} ${who(p)} ${p.status} ${p.id}`.toLowerCase().includes(q));
  };

  function paintCount() {
    const transport = store.overview?.push;
    count.textContent = `${plural(store.pushes.length, 'notification')} · ${transport && transport !== 'dev-capture' ? `${transport} transport, real devices receive them` : 'dev capture, nothing leaves this machine'}`;
  }

  function render() {
    if (state.view === 'inbox' && store.pushes.length) {
      const pushes = visible();
      if (openId == null || !store.pushes.some((p) => p.id === openId)) openId = pushes[0]?.id ?? store.pushes[0].id;
      markSeen(openId);
    }
    renderList();
    renderPane();
  }

  function renderList() {
    paintCount();
    viewSeg.set(state.view === 'devices' ? 'devices' : 'inbox');
    // The composer and the device list use the full width.
    search.hidden = state.view !== 'inbox';
    if (state.view !== 'inbox') return mount(list, null);
    const pushes = visible();
    mount(
      list,
      pushes.length
        ? pushes.map((p) =>
            h(
              'button',
              { type: 'button', class: ['mail-item', 'np-item', !store.seenPush.has(p.id) && 'unread'], role: 'option', 'aria-selected': String(state.view === 'inbox' && p.id === openId), onclick: () => go(`#/push/${p.id}`) },
              h('span', { class: 'mail-item-top' }, h('span', { class: 'mail-to ellipsis' }, who(p)), h('span', { class: 'muted num', title: fullDate(p.createdAt) }, relTime(p.createdAt))),
              h('span', { class: 'mail-subject ellipsis' }, headline(p.message)),
              h(
                'span',
                { class: 'np-item-meta' },
                h('span', { class: 'ellipsis' }, p.message.title && p.message.body ? p.message.body : plural(p.devices.length, 'device')),
                p.status !== 'captured' ? statusBadge(p.status) : null,
                p.warnings.some((w) => w.level === 'error') ? h('span', { class: 'badge b-red', title: 'A provider would reject this' }, 'Error') : null,
              ),
            ),
          )
        : store.pushes.length
          ? empty('No notifications match.')
          : null,
    );
  }

  function renderPane() {
    if (state.view === 'devices') return renderDevices();
    if (state.view === 'compose') return renderComposer();
    if (!store.pushes.length) return renderFirstRun();
    renderDetail();
  }

  function markSeen(id) {
    if (id && !store.seenPush.has(id)) {
      store.seenPush.add(id);
      emit('pushes:seen');
    }
  }

  // ---- first run ----------------------------------------------------------------------

  function renderFirstRun() {
    const devicesRoute = store.overview?.routes.find((r) => r.method === 'POST' && r.path.endsWith('/auth/devices'));
    mount(
      pane,
      h(
        'div',
        { class: 'np-intro scroll' },
        h('h2', null, 'No push notifications yet'),
        h('p', null, 'Anything your app sends with ', h('code', null, 'ctx.push.send()'), ' lands here in development: how it looks on an iPhone, an Android phone and a desktop browser, the exact payload APNs, FCM, Expo and Web Push receive, and what happened on each device.'),
        h('p', null, 'No phone yet? Add a simulated device to any user and send them a notification from here.'),
        h('div', { class: 'np-intro-actions' }, h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/push/new') }, 'New notification'), h('button', { class: 'btn', type: 'button', onclick: () => go('#/push/devices') }, 'Devices')),
        h('pre', { class: 'code' }, `// app/resources/order/order.service.js\nawait ctx.push.send({\n  to: order.customer,\n  title: 'Your order shipped',\n  body: 'Arriving Thursday',\n  url: '/orders/' + order.id,\n});`),
        devicesRoute ? h('p', { class: 'muted' }, 'Mobile apps register their token with ', h('code', null, `POST ${devicesRoute.path}`), '.') : null,
      ),
    );
  }

  // ---- detail -------------------------------------------------------------------------

  function renderDetail() {
    const p = store.pushes.find((x) => x.id === openId);
    if (!p) return mount(pane, empty('Select a notification.'));
    const m = p.message;
    const platforms = [...new Set(p.devices.map((d) => d.platform))];
    const errors = p.log.filter((l) => l.level === 'error').length;
    const fromRequest = p.requestId && store.requests.some((r) => r.id === p.requestId);
    const tabDefs = [
      { id: 'preview', label: 'Preview' },
      { id: 'payload', label: 'Payloads' },
      { id: 'log', label: 'Delivery', count: p.log.length || '', tone: errors ? 'red' : null },
      { id: 'raw', label: 'Raw' },
    ];
    const content = h('div', { class: 'np-content scroll' });
    const paint = () => {
      if (tab === 'preview') {
        return mount(
          content,
          h('div', { class: 'np-tools' }, expandToggle(paint), h('span', { class: 'muted' }, platforms.length ? `Sent to ${platforms.map((x) => PLATFORM[x]).join(', ')}` : 'No devices, showing every platform')),
          previews(m, platforms),
          m.data ? h('div', { class: 'np-data' }, h('div', { class: 'sect-title' }, 'Data', h('span', { class: 'sect-note' }, 'delivered to the app, never shown')), jsonViewer(m.data, { open: 2 })) : null,
        );
      }
      if (tab === 'payload') {
        const info = PROVIDERS.find((x) => x.id === provider);
        const pl = p.payloads[provider];
        const pct = Math.min(100, Math.round((pl.bytes / pl.limit) * 100));
        return mount(
          content,
          h(
            'div',
            { class: 'np-tools' },
            segmented(PROVIDERS.map((x) => ({ value: x.id, label: x.label, tone: p.payloads[x.id].bytes > p.payloads[x.id].limit ? 'red' : null })), provider, (v) => ((provider = v), paint()), 'Provider'),
            h('span', { class: 'spacer' }),
            h('span', { class: ['np-size', pl.bytes > pl.limit && 't-red'], title: `${info.label} rejects payloads over ${pl.limit} bytes` }, h('span', { class: 'np-meter', 'aria-hidden': 'true' }, h('span', { style: { width: `${pct}%` } })), `${pl.bytes.toLocaleString()} / ${pl.limit.toLocaleString()} bytes`),
          ),
          h('p', { class: 'muted np-note' }, info.note, '. Device tokens are masked here.'),
          jsonViewer(pl.payload, { open: 4 }),
        );
      }
      if (tab === 'log') {
        if (!p.log.length) return mount(content, empty('Nothing logged.'));
        const names = new Map(p.devices.map((d, i) => [d.id ?? i, d]));
        return mount(
          content,
          h(
            'ol',
            { class: 'np-log' },
            p.log.map((l) => {
              const d = names.get(l.device);
              return h(
                'li',
                { class: ['np-log-row', `lv-${l.level}`] },
                h('span', { class: 'muted num' }, clock(l.time, true)),
                h('span', { class: ['dot', l.level === 'error' ? 'dot-red' : l.level === 'warn' ? 'dot-amber' : l.providerId !== undefined || /^Delivered/.test(l.text) ? 'dot-green' : null] }),
                h('span', { class: 'np-log-dev ellipsis', title: d ? `${PLATFORM[d.platform]} · ${d.token}` : null }, d ? d.name ?? PLATFORM[d.platform] : 'All devices'),
                h('span', { class: 'np-log-text' }, l.text),
              );
            }),
          ),
          fromRequest ? h('p', { class: 'muted np-note np-log-note' }, 'Sent while handling ', h('a', { href: `#/requests/${p.requestId}` }, 'this request'), '.') : null,
        );
      }
      return mount(content, h('div', { class: 'pad' }, jsonViewer(p, { open: 2 })));
    };

    const target = p.to.users.length === 1 ? { to: p.to.users[0] } : p.devices.some((d) => d.id) ? { deviceIds: p.devices.filter((d) => d.id).map((d) => d.id) } : {};
    mount(
      pane,
      h(
        'header',
        { class: 'mail-head np-head-row' },
        h('div', { class: 'np-title-row' }, h('h2', { class: 'mail-title ellipsis' }, headline(m)), statusBadge(p.status), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', title: 'Copy the ctx.push.send() call that sends this', onclick: () => copy(asCode(m, target), 'Code copied') }, icon('copy', 13), 'Copy as code'), h('button', { class: 'btn', type: 'button', onclick: () => sendAgain(p) }, 'Send again')),
        h(
          'dl',
          { class: 'kv mail-meta np-meta' },
          h('dt', null, 'To'), h('dd', null, who(p), h('span', { class: 'muted' }, ` · ${p.devices.length ? p.devices.map((d) => `${PLATFORM[d.platform]}${d.simulated ? ' (sim)' : ''}`).join(', ') : 'no devices'}`)),
          h('dt', null, 'Sent'), h('dd', null, fullDate(p.createdAt), h('span', { class: 'muted' }, ` · ${relTime(p.createdAt)}`)),
          h('dt', null, 'Via'), h('dd', null, p.transport ?? 'nothing (no transport)', fromRequest ? h('span', { class: 'muted' }, ' · sent by ', h('a', { href: `#/requests/${p.requestId}` }, 'this request')) : p.requestId ? h('span', { class: 'muted' }, ' · sent from devtools') : null),
        ),
        p.warnings.length
          ? h(
              'ul',
              { class: 'np-warns' },
              p.warnings.map((w) => h('li', { class: `np-warn lv-${w.level}` }, h('span', { class: ['dot', w.level === 'error' ? 'dot-red' : w.level === 'warn' ? 'dot-amber' : 'dot-blue'] }), h('span', null, w.text))),
            )
          : null,
      ),
      tabs(tabDefs, tab, (t) => ((tab = t), paint())),
      content,
    );
    paint();
  }

  async function sendAgain(p) {
    const m = p.message;
    Object.assign(draft, {
      title: m.title ?? '',
      subtitle: m.subtitle ?? '',
      body: m.body ?? '',
      image: m.image ?? '',
      url: m.url ?? '',
      badge: m.badge ?? '',
      sound: m.sound === null || m.sound === undefined ? (m.silent ? 'default' : '') : m.sound,
      channel: m.channel ?? '',
      priority: m.priority ?? 'high',
      silent: Boolean(m.silent),
      data: m.data ? JSON.stringify(m.data, null, 2) : '',
      more: Boolean(m.image || m.url || m.badge != null || m.channel || m.data || m.silent),
      picked: null,
    });
    const person = p.people?.[0];
    if (person) await chooseUser({ id: person.id, name: person.name, email: person.email }, { keep: new Set(p.devices.map((d) => d.id).filter(Boolean)) });
    go('#/push/new');
  }

  // ---- composer -----------------------------------------------------------------------

  async function chooseUser(u, { keep } = {}) {
    draft.user = u;
    draft.devices = [];
    draft.picked = keep?.size ? keep : null;
    try {
      draft.devices = await api(`/devices?user=${encodeURIComponent(u.id)}`);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  async function simulate(platform) {
    try {
      const d = await api('/devices/simulate', { method: 'POST', body: { userId: draft.user.id, platform } });
      draft.devices = [d, ...draft.devices];
      if (draft.picked) draft.picked.add(d.id);
      toast(`Added ${d.name}`);
    } catch (err) {
      toast(err.message, { tone: 'error' });
    }
  }

  function renderComposer() {
    const errs = {};
    const previewHost = h('div', { class: 'np-live' });
    const counters = {};
    const message = () => {
      let data;
      try {
        data = draft.data.trim() ? JSON.parse(draft.data) : undefined;
      } catch {
        data = undefined;
      }
      const m = {
        title: draft.title.trim() || undefined,
        subtitle: draft.subtitle.trim() || undefined,
        body: draft.body.trim() || undefined,
        image: draft.image.trim() || undefined,
        url: draft.url.trim() || undefined,
        badge: draft.badge === '' ? undefined : Number(draft.badge),
        sound: draft.sound.trim() ? draft.sound.trim() : false,
        channel: draft.channel.trim() || undefined,
        priority: draft.priority,
        silent: draft.silent || undefined,
        data,
      };
      return m;
    };
    const chosen = () => draft.devices.filter((d) => !draft.picked || draft.picked.has(d.id));
    const paintPreview = () => {
      const m = message();
      const platforms = [...new Set(chosen().map((d) => d.platform))];
      mount(previewHost, h('div', { class: 'np-tools' }, expandToggle(paintPreview), h('span', { class: 'muted' }, 'Live preview')), previews({ ...m, sound: m.sound || null }, platforms));
      for (const [field, el] of Object.entries(counters)) {
        const len = (draft[field] ?? '').trim().length;
        const cut = Object.entries(VISIBLE)
          .filter(([pf]) => !platforms.length || platforms.includes(pf))
          .filter(([, v]) => len > v[field])
          .map(([pf]) => PLATFORM[pf]);
        mount(el, len ? h('span', { class: cut.length ? 't-amber' : 'muted' }, `${len}${cut.length ? ` · cut off on ${cut.join(', ')}` : ''}`) : null);
      }
    };

    const field = (key, label, input, hint) => {
      const err = h('span', { class: 'np-err', id: `np-err-${key}` });
      errs[key] = err;
      return h('label', { class: 'np-field' }, h('span', { class: 'np-label' }, label, hint ? h('span', { class: 'np-hint' }, hint) : null), input, err);
    };
    const text = (key, { placeholder = '', type = 'text', rows, mono } = {}) => {
      const el = rows
        ? h('textarea', { class: ['input', 'np-area', mono && 'mono'], rows, placeholder, spellcheck: !mono, value: draft[key] })
        : h('input', { class: ['input', mono && 'mono'], type, placeholder, value: draft[key], spellcheck: false, autocomplete: 'off' });
      el.addEventListener('input', () => {
        draft[key] = el.value;
        if (errs[key]) errs[key].textContent = '';
        paintPreview();
      });
      return el;
    };
    const counted = (key) => {
      counters[key] = h('span', { class: 'np-count num' });
      return counters[key];
    };

    // who
    const userBtn = h('button', { class: 'btn picker-btn np-user-btn', type: 'button', 'aria-haspopup': 'dialog' });
    const deviceBox = h('div', { class: 'np-devices' });
    const paintWho = () => {
      mount(userBtn, draft.user ? h('span', null, draft.user.name ?? draft.user.email ?? draft.user.id) : h('span', { class: 'muted' }, 'Choose a user'), icon('chevronDown', 12));
      if (!draft.user) return mount(deviceBox, h('span', { class: 'muted' }, 'Pick who receives it. Their registered devices show up here.'));
      const sim = h(
        'span',
        { class: 'np-sim' },
        h('span', { class: 'muted' }, draft.devices.length ? 'Add simulated' : 'No devices yet. Add a simulated'),
        ['ios', 'android', 'web'].map((pf) => h('button', { class: 'link-btn', type: 'button', onclick: async () => (await simulate(pf), paintWho(), paintPreview()) }, PLATFORM[pf])),
      );
      mount(
        deviceBox,
        draft.devices.map((d) => {
          const box = h('input', { type: 'checkbox', checked: !draft.picked || draft.picked.has(d.id) });
          box.addEventListener('change', () => {
            if (!draft.picked) draft.picked = new Set(draft.devices.map((x) => x.id));
            if (box.checked) draft.picked.add(d.id);
            else draft.picked.delete(d.id);
            paintPreview();
          });
          return h('label', { class: 'np-dev' }, box, h('span', { class: 'np-plat' }, PLATFORM[d.platform]), h('span', { class: 'ellipsis' }, d.name ?? 'Unnamed device'), d.simulated ? h('span', { class: 'badge' }, 'simulated') : h('span', { class: 'mono muted' }, d.token));
        }),
        sim,
      );
    };
    userBtn.addEventListener('click', () =>
      popover(
        userBtn,
        pickerList({
          placeholder: 'Search users by name or email',
          load: (q) => api(`/users?q=${encodeURIComponent(q)}`),
          render: userOption,
          onPick: async (u) => {
            closePopover();
            await chooseUser(u);
            paintWho();
            paintPreview();
          },
        }),
        { width: 320 },
      ),
    );

    const soundInput = text('sound', { placeholder: 'default' });
    const silentBox = h('input', { type: 'checkbox', checked: draft.silent });
    silentBox.addEventListener('change', () => {
      draft.silent = silentBox.checked;
      paintPreview();
    });
    const prio = segmented(
      [
        { value: 'high', label: 'High', title: 'Shown right away' },
        { value: 'normal', label: 'Normal', title: 'May be delayed to save battery' },
      ],
      draft.priority,
      (v) => ((draft.priority = v), paintPreview()),
      'Priority',
    );
    const more = h(
      'div',
      { class: 'np-more', hidden: !draft.more },
      field('image', 'Image', text('image', { placeholder: 'https://…/photo.jpg', mono: true }), 'https only'),
      field('url', 'Open URL', text('url', { placeholder: '/orders/42 or myapp://orders/42', mono: true }), 'opened on tap, sent as data.url'),
      h('div', { class: 'np-row' }, field('badge', 'Badge', text('badge', { type: 'number', placeholder: 'none' }), 'iPhone'), field('sound', 'Sound', soundInput, 'empty for none'), field('channel', 'Channel', text('channel', { placeholder: 'default' }), 'Android')),
      h('div', { class: 'np-row' }, h('div', { class: 'np-field' }, h('span', { class: 'np-label' }, 'Priority'), prio), h('label', { class: 'np-check' }, silentBox, h('span', null, 'Silent', h('span', { class: 'np-hint' }, 'no banner, data only')))),
      field('data', 'Data', text('data', { rows: 4, placeholder: '{ "orderId": "42" }', mono: true }), 'JSON, for the app'),
    );
    const moreBtn = h('button', { class: 'link-btn', type: 'button', 'aria-expanded': String(draft.more) }, draft.more ? 'Fewer options' : 'Image, link, badge, sound, data');
    moreBtn.addEventListener('click', () => {
      draft.more = !draft.more;
      more.hidden = !draft.more;
      moreBtn.textContent = draft.more ? 'Fewer options' : 'Image, link, badge, sound, data';
      moreBtn.setAttribute('aria-expanded', String(draft.more));
    });

    const sendBtn = h('button', { class: 'btn primary', type: 'submit' }, 'Send');
    const formErr = h('div', { class: 'np-form-err', role: 'alert' });
    const form = h(
      'form',
      { class: 'np-form', novalidate: true },
      h('div', { class: 'np-field' }, h('span', { class: 'np-label' }, 'To'), userBtn, deviceBox),
      field('title', 'Title', text('title', { placeholder: 'Your order shipped' }), counted('title')),
      field('subtitle', 'Subtitle', text('subtitle', { placeholder: 'Optional, iPhone only' })),
      field('body', 'Body', text('body', { rows: 3, placeholder: 'It arrives Thursday between 9 and 12.' }), counted('body')),
      h('div', null, moreBtn),
      more,
      formErr,
      h('div', { class: 'np-actions' }, sendBtn, h('button', { class: 'btn ghost', type: 'button', onclick: () => copy(asCode(message(), draft.user ? (draft.picked ? { deviceIds: chosen().map((d) => d.id) } : { to: draft.user.id }) : { to: '<userId>' }), 'Code copied') }, icon('copy', 13), 'Copy as code'), h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: () => go(openId ? `#/push/${openId}` : '#/push') }, 'Cancel')),
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      clear(formErr);
      for (const el of Object.values(errs)) el.textContent = '';
      if (!draft.user) return mount(formErr, 'Choose who receives it.');
      if (!chosen().length) return mount(formErr, 'No device selected. Add a simulated device to preview it.');
      if (draft.data.trim()) {
        try {
          const parsed = JSON.parse(draft.data);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
        } catch {
          errs.data.textContent = 'Not a JSON object';
          return;
        }
      }
      const m = message();
      const payload = { ...(draft.picked ? { deviceIds: chosen().map((d) => d.id) } : { userId: draft.user.id }) };
      for (const [k, v] of Object.entries(m)) if (v !== undefined) payload[k] = v;
      sendBtn.disabled = true;
      try {
        const res = await api('/push/test', { method: 'POST', body: payload });
        await loadPushes();
        toast(`${STATUS[res.status]?.label ?? res.status}: ${plural(res.devices, 'device')}`);
        state.view = 'inbox';
        go(`#/push/${res.id}`);
      } catch (err) {
        sendBtn.disabled = false;
        if (err.details) {
          for (const [k, msg] of Object.entries(err.details)) {
            if (errs[k]) errs[k].textContent = msg;
            else mount(formErr, msg);
          }
        } else mount(formErr, err.message);
      }
    });
    form.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        form.requestSubmit();
      }
    });

    mount(pane, h('div', { class: 'np-compose' }, h('div', { class: 'np-compose-form scroll' }, h('h2', { class: 'np-h' }, 'New notification'), form), h('div', { class: 'np-compose-preview scroll' }, previewHost)));
    paintWho();
    paintPreview();
  }

  // ---- devices --------------------------------------------------------------------------

  let devices = null;
  async function renderDevices() {
    if (!devices) mount(pane, loading('Loading devices'));
    try {
      devices = await api('/devices');
    } catch (err) {
      return mount(pane, errorBox(err));
    }
    if (state.view !== 'devices') return;
    const addBtn = h('button', { class: 'btn', type: 'button', 'aria-haspopup': 'dialog' }, 'Add simulated device');
    addBtn.addEventListener('click', () => {
      const pop = popover(
        addBtn,
        pickerList({
          placeholder: 'Whose device? Search users',
          load: (q) => api(`/users?q=${encodeURIComponent(q)}`),
          render: userOption,
          onPick: (u) =>
            mount(
              pop.pop,
              h(
                'div',
                { class: 'np-pick-platform' },
                h('div', { class: 'muted' }, `Simulated device for ${u.name ?? u.email}`),
                h(
                  'div',
                  { class: 'np-pick-row' },
                  ['ios', 'android', 'web'].map((pf) =>
                    h(
                      'button',
                      {
                        class: 'btn',
                        type: 'button',
                        onclick: async () => {
                          closePopover();
                          try {
                            await api('/devices/simulate', { method: 'POST', body: { userId: u.id, platform: pf } });
                            renderDevices();
                          } catch (err) {
                            toast(err.message, { tone: 'error' });
                          }
                        },
                      },
                      PLATFORM[pf],
                    ),
                  ),
                ),
              ),
            ),
        }),
        { width: 320 },
      );
    });
    const rows = devices.map((d) =>
      h(
        'tr',
        null,
        h('td', null, h('div', { class: 'ellipsis' }, d.user.name ?? d.user.id), d.user.email ? h('div', { class: 'muted ellipsis' }, d.user.email) : null),
        h('td', null, d.name ?? h('span', { class: 'muted' }, 'Unnamed')),
        h('td', null, PLATFORM[d.platform]),
        h('td', null, d.simulated ? h('span', { class: 'badge' }, 'simulated') : h('span', { class: 'mono' }, d.token)),
        h('td', { class: 'muted', title: d.lastSeenAt ? fullDate(d.lastSeenAt) : '' }, d.lastSeenAt ? relTime(d.lastSeenAt) : ''),
        h(
          'td',
          { class: 'np-dev-actions' },
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              onclick: async () => {
                Object.assign(draft, { title: draft.title || 'Test notification', body: draft.body || `Sent from CalmAPI devtools to ${d.name ?? PLATFORM[d.platform]}` });
                await chooseUser({ id: d.user.id, name: d.user.name, email: d.user.email }, { keep: new Set([d.id]) });
                go('#/push/new');
              },
            },
            'Send test',
          ),
          h(
            'button',
            {
              class: 'btn ghost',
              type: 'button',
              title: d.simulated ? 'Remove this simulated device' : 'Unregister this device (the app registers it again on next launch)',
              onclick: async () => {
                try {
                  await api(`/devices/${d.id}`, { method: 'DELETE' });
                  renderDevices();
                } catch (err) {
                  toast(err.message, { tone: 'error' });
                }
              },
            },
            'Remove',
          ),
        ),
      ),
    );
    mount(
      pane,
      h(
        'div',
        { class: 'np-devlist scroll' },
        h('div', { class: 'np-tools' }, h('span', { class: 'muted' }, devices.length ? `${plural(devices.length, 'device')}. Simulated devices receive previews only and never reach a real provider.` : 'No devices registered.'), h('span', { class: 'spacer' }), addBtn),
        devices.length
          ? h('table', { class: 'tbl np-dev-tbl' }, h('thead', null, h('tr', null, ['User', 'Device', 'Platform', 'Token', 'Last seen', ''].map((t) => h('th', null, t)))), h('tbody', null, rows))
          : empty('Apps register a device with POST /api/auth/devices { token, platform }. Or add a simulated one to preview notifications without a phone.'),
      ),
    );
  }

  // ---- routing --------------------------------------------------------------------------

  function apply(p) {
    if (p[0] === 'devices') state.view = 'devices';
    else if (p[0] === 'new') state.view = 'compose';
    else {
      state.view = 'inbox';
      if (p[0]) openId = p[0];
    }
    render();
  }

  const newBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => go('#/push/new') }, 'New notification');
  mount(root, h('div', { class: 'panel' }, bar('Push', viewSeg, search, h('span', { class: 'spacer' }), count, newBtn), body));
  apply(params);

  const off = [
    on('pushes:reset', (e) => {
      // Never repaint the composer or the device list under someone's cursor.
      if (state.view !== 'inbox') return renderList();
      if (e?.fresh && !openId) openId = e.fresh;
      render();
    }),
    on('overview', paintCount),
  ];
  return {
    destroy: () => off.forEach((fn) => fn()),
    update: apply,
    onKey(e) {
      if (state.view !== 'inbox') return;
      const pushes = visible();
      const i = pushes.findIndex((p) => p.id === openId);
      if (e.key === 'j' || e.key === 'ArrowDown') pushes[i + 1] && go(`#/push/${pushes[i + 1].id}`);
      else if (e.key === 'k' || e.key === 'ArrowUp') pushes[i - 1] && go(`#/push/${pushes[i - 1].id}`);
      else if (e.key === 'n') go('#/push/new');
      else return;
      e.preventDefault();
      list.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
    },
  };
}
