// CalmAPI devtools: app shell, navigation, header and keyboard shortcuts.
// Vanilla ES modules, no build step. Every panel lives in ./panels/.

import { h, icon, mount, clear, fmtUptime, storage, closePopover, toast } from './lib.js';
import { store, on, connect, loadOverview, loadRequests, loadLogs, loadMails, loadPushes, loadDoctor, loadActivity, stopActAs } from './store.js';
import requests from './panels/requests.js';
import activity from './panels/activity.js';
import security from './panels/security.js';
import routes from './panels/routes.js';
import resources from './panels/resources.js';
import data from './panels/data.js';
import playground from './panels/playground.js';
import mail from './panels/mail.js';
import push from './panels/push.js';
import logs from './panels/logs.js';
import doctor from './panels/doctor.js';
import { blockPanel } from './panels/block.js';

const CORE = [requests, activity, logs, mail, push, routes, resources, data, playground, doctor, security];
const GROUPS = [
  { label: 'Observe', ids: ['requests', 'activity', 'logs', 'mail', 'push'] },
  { label: 'Explore', ids: ['routes', 'resources', 'data'] },
  { label: 'Tools', ids: ['playground', 'doctor', 'security'] },
];

let blockPanels = [];
let current = null; // { panel, instance }
const allPanels = () => [...CORE, ...blockPanels];
const navOrder = () => [...GROUPS.flatMap((g) => g.ids.map((id) => CORE.find((p) => p.id === id))), ...blockPanels];

// ---- theme -------------------------------------------------------------------------

const THEMES = ['system', 'light', 'dark'];
const THEME_LABEL = { system: 'Theme: match system', light: 'Theme: light', dark: 'Theme: dark' };

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  storage.set('theme', mode);
}

function themeButton() {
  const btn = h('button', { class: 'icon-btn', type: 'button' });
  const paint = (mode) => {
    const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    mount(btn, icon(mode === 'system' ? 'system' : mode === 'light' ? 'sun' : 'moon', 15));
    btn.title = `${THEME_LABEL[mode]} (click for ${next})`;
    btn.setAttribute('aria-label', `${THEME_LABEL[mode]}. Switch to ${next}`);
  };
  btn.addEventListener('click', () => {
    const mode = storage.get('theme', 'system');
    const next = THEMES[(THEMES.indexOf(mode) + 1) % THEMES.length];
    applyTheme(next);
    paint(next);
  });
  paint(storage.get('theme', 'system'));
  return btn;
}

// ---- shell -------------------------------------------------------------------------

const el = {};

function setCollapsed(app, next) {
  app.classList.toggle('collapsed', next);
  storage.set('collapsed', next);
  el.sideBtn.setAttribute('aria-expanded', String(!next));
  el.sideBtn.title = next ? 'Show sidebar' : 'Hide sidebar';
}

function shell() {
  el.appName = h('span', { class: 'app-name' }, 'CalmAPI app');
  el.appVer = h('span', { class: 'app-ver' });
  el.mode = h('span', { class: 'top-mode' });
  el.db = h('span', { class: 'top-db' });
  el.openapi = h('span', { class: 'top-openapi' });
  el.actAs = h('div', { class: 'top-actas' });
  el.nav = h('nav', { class: 'nav', 'aria-label': 'Panels' });
  el.live = h('div', { class: 'live', role: 'status', 'aria-live': 'polite' });
  el.runtime = h('div', { class: 'runtime' });
  el.main = h('main', { class: 'main', id: 'main', tabindex: '-1' });
  el.sideBtn = h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Toggle sidebar', 'aria-controls': 'sidebar' }, icon('sidebar', 15));

  const app = h(
    'div',
    { class: 'app' },
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'top-id' }, el.sideBtn, h('a', { class: 'app-link', href: '#/requests', title: 'CalmAPI devtools' }, el.appName), el.appVer),
      h('div', { class: 'top-main' }, h('span', { class: 'spacer' }), el.actAs, el.mode, el.db, el.openapi, themeButton()),
    ),
    h(
      'aside',
      { class: 'side', id: 'sidebar' },
      el.nav,
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'side-foot' },
        h('div', { class: 'side-foot-row' }, el.live, h('button', { class: 'link-btn muted', type: 'button', title: 'Keyboard shortcuts (?)', onclick: showHelp }, 'Shortcuts')),
        el.runtime,
      ),
    ),
    el.main,
  );
  el.sideBtn.addEventListener('click', () => setCollapsed(app, !app.classList.contains('collapsed')));
  setCollapsed(app, storage.get('collapsed', false));
  document.body.append(h('a', { class: 'skip', href: '#main' }, 'Skip to content'), app);
}

function renderNav() {
  const active = current?.panel.id;
  const order = navOrder();
  const item = (p) => {
    const n = order.indexOf(p) + 1;
    const badge = p.badge?.();
    const show = badge && badge.text !== '' && badge.text != null;
    return h(
      'a',
      { class: 'nav-item', href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null, title: n && n <= 9 ? `${p.label} (${n})` : p.label },
      h('span', { class: 'nav-label' }, p.label),
      show ? h('span', { class: ['nav-count', badge.tone && `t-${badge.tone}`], title: badge.title ?? null }, badge.text) : null,
    );
  };
  const groups = GROUPS.map((g) => h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, g.label), g.ids.map((id) => item(CORE.find((p) => p.id === id)))));
  if (blockPanels.length) groups.push(h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, 'Blocks'), blockPanels.map(item)));
  mount(el.nav, groups);
}

function renderHeader() {
  const ov = store.overview;
  if (!ov) return;
  el.appName.textContent = ov.app.name;
  el.appVer.textContent = ov.app.version ?? '';
  el.mode.textContent = ov.app.mode;
  const db = ov.database;
  mount(el.db, h('span', { class: ['dot', db.connected ? 'dot-green' : 'dot-red'] }), h('span', { class: 'mono' }, db.name ?? 'database'));
  el.db.title = db.connected ? `MongoDB connected: ${db.host}/${db.name}` : 'MongoDB is not connected';
  if (ov.openapi) mount(el.openapi, h('a', { class: 'top-link', href: ov.openapi, target: '_blank', rel: 'noopener', title: `OpenAPI document at ${ov.openapi}` }, 'OpenAPI', icon('external', 12)));
  else clear(el.openapi);
  const uptime = () => {
    const sec = ov.runtime.uptimeSeconds + (Date.now() - store.overviewAt) / 1000;
    return fmtUptime(sec < 60 ? sec : sec - (sec % 60)).replace(/ 0s$/, '');
  };
  el.uptime = h('span', null, uptime());
  mount(el.runtime, h('span', { title: `Node.js ${ov.runtime.node}, pid ${ov.runtime.pid}` }, `Node ${ov.runtime.node.split('.').slice(0, 2).join('.')}`), ' · ', `${ov.runtime.memoryMb} MB`, ' · up ', el.uptime);
  el.runtime.title = `Node.js ${ov.runtime.node} · pid ${ov.runtime.pid} · ${ov.runtime.memoryMb} MB resident · up ${fmtUptime(ov.runtime.uptimeSeconds)}`;
  el.tickUptime = () => {
    if (el.uptime) el.uptime.textContent = uptime();
  };
  document.title = `${current?.panel.label ?? 'Devtools'} · ${ov.app.name} · CalmAPI devtools`;
}

function renderActAs() {
  const a = store.actAs;
  if (!a) return clear(el.actAs);
  const admin = (a.user.roles ?? []).includes('admin');
  mount(
    el.actAs,
    h(
      'span',
      { class: 'actas', title: `Playground requests and Replay send a real session for ${a.user.email ?? a.user.name}` },
      h('span', { class: 'actas-label' }, 'Acting as'),
      h('b', null, a.user.name ?? a.user.email),
      admin ? h('span', { class: 'actas-role' }, 'admin') : null,
      h('button', { class: 'actas-stop', type: 'button', onclick: stopActAs, title: 'Stop acting as this user' }, 'Stop'),
    ),
  );
}

function renderLive() {
  mount(el.live, h('span', { class: ['dot', store.live ? 'dot-green' : 'dot-amber'] }), h('span', null, store.live ? 'Live' : 'Reconnecting'));
  el.live.title = store.live ? 'Streaming requests, logs, mail and push notifications from the server' : 'Lost the event stream. Retrying every 2 seconds.';
}

// ---- routing -----------------------------------------------------------------------

function parseHash() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').map((p) => decodeURIComponent(p));
  const id = parts[0] || 'requests';
  return { id, params: parts.slice(1).filter(Boolean) };
}

export function navigate(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function route() {
  if (!store.overview) return;
  closePopover();
  const { id, params } = parseHash();
  const panel = allPanels().find((p) => p.id === id) ?? requests;
  if (current?.panel === panel && current.instance?.update) {
    current.instance.update(params);
  } else {
    current?.instance?.destroy?.();
    clear(el.main);
    const host = h('div', { class: `panel-host panel-${panel.id.replace(/[^\w-]/g, '-')}` });
    el.main.append(host);
    current = { panel, instance: null };
    current.instance = panel.mount(host, params) ?? {};
  }
  renderNav();
  renderHeader();
}

// ---- keyboard ----------------------------------------------------------------------

const typing = (t) => t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName));

function onKey(e) {
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('dialog[open]')) return;
  if (typing(e.target)) return;
  if (e.key === '/') {
    const input = el.main.querySelector('[data-filter]');
    if (input) {
      e.preventDefault();
      input.focus();
      input.select();
    }
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    return showHelp();
  }
  if (/^[1-9]$/.test(e.key)) {
    const p = navOrder()[Number(e.key) - 1];
    if (p) navigate(`#/${p.id}`);
    return;
  }
  current?.instance?.onKey?.(e);
}

function showHelp() {
  const rows = [
    ['/', 'Focus the filter'],
    ['j / k', 'Next / previous item'],
    ['Enter', 'Open the selected item'],
    ['Esc', 'Close the detail view'],
    ['1 to 9', 'Switch panel'],
    ['Ctrl + Enter', 'Send (Playground, Push)'],
    ['n', 'New notification (Push)'],
    ['?', 'This help'],
  ];
  const dlg = h(
    'dialog',
    { class: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div', { class: 'dialog-head' }, h('h2', null, 'Keyboard shortcuts'), h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 14))),
    h('dl', { class: 'keys' }, rows.map(([k, d]) => [h('dt', null, k.split(' ').map((p) => (/^(\/|or|to|\+)$/.test(p) && p !== '/' ? ` ${p} ` : h('kbd', null, p)))), h('dd', null, d)])),
  );
  dlg.addEventListener('close', () => dlg.remove());
  dlg.addEventListener('click', (e) => e.target === dlg && dlg.close());
  document.body.append(dlg);
  dlg.showModal();
}

// ---- boot --------------------------------------------------------------------------

async function boot() {
  applyTheme(storage.get('theme', 'system'));
  shell();
  renderLive();
  renderNav();

  on('overview', ({ changed }) => {
    blockPanels = (store.overview?.panels ?? []).map(blockPanel);
    renderHeader();
    renderNav();
    if (changed && current) current.instance?.refresh?.();
  });
  for (const ev of ['request', 'requests:reset', 'log', 'logs:reset', 'mails:reset', 'mails:seen', 'pushes:reset', 'pushes:seen', 'doctor', 'actas', 'activity', 'activity:reset', 'activity:seen', 'audit', 'audit:start']) on(ev, () => renderNav());
  on('actas', renderActAs);
  on('live', renderLive);

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  connect();
  try {
    await loadOverview();
  } catch (err) {
    mount(el.main, h('div', { class: 'boot-error' }, h('p', null, h('b', null, 'Devtools cannot reach the app. '), err.message), h('p', { class: 'muted' }, 'Is the server running in development mode? This page reconnects on its own.')));
    // The event stream reconnects and resyncs; mount the first panel when the overview arrives.
    const off = on('overview', () => {
      off();
      route();
    });
  }
  if (store.overview) {
    await Promise.allSettled([loadRequests(), loadLogs(), loadMails(), loadPushes(), loadDoctor(), loadActivity()]);
    route();
  }

  setInterval(() => el.tickUptime?.(), 1000);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadOverview().catch(() => {});
  }, 20_000);
  setInterval(() => {
    if (document.visibilityState === 'visible') loadDoctor().catch(() => {});
  }, 60_000);
  window.addEventListener('unhandledrejection', (e) => {
    toast(e.reason?.message ?? 'Something went wrong', { tone: 'error' });
  });
}

boot();
