// CalmAPI devtools: app shell, navigation, header and keyboard shortcuts.
// Vanilla ES modules, no build step. Every panel lives in ./panels/.

import { h, icon, logo, mount, clear, fmtUptime, storage, segmented, closePopover, toast } from './lib.js';
import { store, on, connect, loadOverview, loadRequests, loadLogs, loadMails, loadDoctor, stopActAs } from './store.js';
import requests from './panels/requests.js';
import routes from './panels/routes.js';
import resources from './panels/resources.js';
import data from './panels/data.js';
import playground from './panels/playground.js';
import mail from './panels/mail.js';
import logs from './panels/logs.js';
import doctor from './panels/doctor.js';
import { blockPanel } from './panels/block.js';

const CORE = [requests, logs, mail, routes, resources, data, playground, doctor];
const GROUPS = [
  { label: 'Observe', ids: ['requests', 'logs', 'mail'] },
  { label: 'Explore', ids: ['routes', 'resources', 'data'] },
  { label: 'Tools', ids: ['playground', 'doctor'] },
];

let blockPanels = [];
let current = null; // { panel, instance, key }
const allPanels = () => [...CORE, ...blockPanels];

// ---- theme -------------------------------------------------------------------------

function applyTheme(mode) {
  if (mode === 'light' || mode === 'dark') document.documentElement.dataset.theme = mode;
  else delete document.documentElement.dataset.theme;
  storage.set('theme', mode);
}

function themeToggle() {
  const mode = storage.get('theme', 'system');
  return segmented(
    [
      { value: 'light', icon: 'sun', aria: 'Light theme', title: 'Light' },
      { value: 'system', icon: 'monitor', aria: 'System theme', title: 'Match system' },
      { value: 'dark', icon: 'moon', aria: 'Dark theme', title: 'Dark' },
    ],
    mode,
    applyTheme,
    'Theme',
  );
}

// ---- shell -------------------------------------------------------------------------

const el = {};

function shell() {
  el.appName = h('span', { class: 'app-name' }, 'CalmAPI app');
  el.appVer = h('span', { class: 'app-ver' });
  el.mode = h('span', { class: 'mode-badge' });
  el.status = h('div', { class: 'top-status' });
  el.actAs = h('div', { class: 'top-actas' });
  el.nav = h('nav', { class: 'nav', 'aria-label': 'Panels' });
  el.live = h('div', { class: 'live', role: 'status', 'aria-live': 'polite' });
  el.main = h('main', { class: 'main', id: 'main', tabindex: '-1' });

  const collapsed = storage.get('collapsed', false);
  const app = h(
    'div',
    { class: ['app', collapsed && 'collapsed'] },
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'brand-zone' },
        h('a', { class: 'brand', href: '#/requests', 'aria-label': 'CalmAPI devtools home' }, logo(22), h('span', { class: 'wordmark' }, 'Calm', h('b', null, 'API'))),
      ),
      h('div', { class: 'app-id' }, el.appName, el.appVer, el.mode),
      h('div', { class: 'spacer' }),
      el.actAs,
      el.status,
      themeToggle(),
    ),
    h(
      'aside',
      { class: 'sidebar' },
      el.nav,
      h('div', { class: 'spacer' }),
      h(
        'div',
        { class: 'side-foot' },
        el.live,
        h(
          'div',
          { class: 'side-tools' },
          h('button', { class: 'icon-btn ghost', 'aria-label': 'Keyboard shortcuts', title: 'Keyboard shortcuts (?)', onclick: showHelp }, icon('keyboard', 16)),
          h(
            'button',
            {
              class: 'icon-btn ghost collapse-btn',
              'aria-label': 'Toggle sidebar',
              title: 'Collapse sidebar',
              onclick: () => {
                const next = !app.classList.contains('collapsed');
                app.classList.toggle('collapsed', next);
                storage.set('collapsed', next);
              },
            },
            icon('sidebar', 16),
          ),
        ),
      ),
    ),
    el.main,
  );
  document.body.append(h('a', { class: 'skip', href: '#main' }, 'Skip to content'), app);
}

function renderNav() {
  const active = current?.panel.id;
  const items = [];
  let n = 0;
  const item = (p) => {
    n++;
    const badge = p.badge?.();
    return h(
      'a',
      { class: 'nav-item', href: `#/${p.id}`, 'aria-current': p.id === active ? 'page' : null, title: `${p.label}${n <= 9 ? ` (${n})` : ''}`, 'aria-label': p.label },
      icon(p.icon, 16),
      h('span', { class: 'nav-label' }, p.label),
      badge && badge.text !== '' && badge.text != null ? h('span', { class: ['nav-badge', badge.tone && `t-${badge.tone}`] }, badge.text) : null,
    );
  };
  for (const g of GROUPS) {
    items.push(h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, g.label), g.ids.map((id) => item(CORE.find((p) => p.id === id)))));
  }
  if (blockPanels.length) items.push(h('div', { class: 'nav-group' }, h('div', { class: 'nav-group-label' }, 'Blocks'), blockPanels.map(item)));
  mount(el.nav, items);
}

function renderHeader() {
  const ov = store.overview;
  if (!ov) return;
  el.appName.textContent = ov.app.name;
  el.appVer.textContent = ov.app.version ? `v${ov.app.version}` : '';
  el.mode.textContent = ov.app.mode;
  el.mode.className = `mode-badge mode-${ov.app.mode}`;
  const db = ov.database;
  const uptime = () => fmtUptime(ov.runtime.uptimeSeconds + (Date.now() - store.overviewAt) / 1000);
  el.uptime = h('span', { class: 'num' }, uptime());
  mount(
    el.status,
    h('span', { class: 'top-stat', title: db.connected ? `MongoDB connected: ${db.host}/${db.name}` : 'MongoDB is not connected' }, h('span', { class: ['dot', db.connected ? 'dot-ok' : 'dot-bad'] }), icon('database', 14), h('span', { class: 'top-stat-text' }, db.name ?? 'database')),
    h('span', { class: 'top-stat hide-md', title: `Node.js ${ov.runtime.node}, pid ${ov.runtime.pid}` }, h('span', { class: 'muted' }, 'Node'), h('span', { class: 'num' }, ov.runtime.node)),
    h('span', { class: 'top-stat hide-md', title: `Uptime, ${ov.runtime.memoryMb} MB resident memory` }, icon('clock', 14), el.uptime),
    ov.openapi ? h('a', { class: 'top-stat link', href: ov.openapi, target: '_blank', rel: 'noopener', title: `OpenAPI document at ${ov.openapi}` }, icon('braces', 14), h('span', { class: 'top-stat-text' }, 'OpenAPI'), icon('external', 12, 'ext')) : null,
  );
  el.tickUptime = () => {
    if (el.uptime) el.uptime.textContent = uptime();
  };
  document.title = `${current?.panel.label ?? 'Devtools'} · ${ov.app.name} · CalmAPI devtools`;
}

function renderActAs() {
  const a = store.actAs;
  if (!a) return clear(el.actAs);
  mount(
    el.actAs,
    h(
      'span',
      { class: 'actas-pill', title: `Requests from the Playground and Replay use a real session for ${a.user.email ?? a.user.name}` },
      icon('user', 13),
      h('span', null, 'Acting as ', h('b', null, a.user.name ?? a.user.email)),
      h('button', { class: 'actas-stop', 'aria-label': 'Stop acting as this user', title: 'Stop', onclick: stopActAs }, icon('x', 12)),
    ),
  );
}

function renderLive() {
  mount(el.live, h('span', { class: ['dot', store.live ? 'dot-live' : 'dot-warn'] }), h('span', { class: 'live-text' }, store.live ? 'Live' : 'Reconnecting'));
  el.live.title = store.live ? 'Streaming requests, logs and mail from the server' : 'Lost the event stream. Retrying every 2 seconds.';
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
  const panel = allPanels().find((p) => p.id === id) ?? (store.overview ? requests : null);
  if (!panel) return;
  if (current?.panel === panel && current.instance?.update) {
    current.instance.update(params);
  } else {
    current?.instance?.destroy?.();
    clear(el.main);
    const host = h('div', { class: `panel-host panel-${panel.id}` });
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
    const order = [...GROUPS.flatMap((g) => g.ids.map((id) => CORE.find((p) => p.id === id))), ...blockPanels];
    const p = order[Number(e.key) - 1];
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
    ['Ctrl + Enter', 'Send (Playground)'],
    ['?', 'This help'],
  ];
  const dlg = h(
    'dialog',
    { class: 'dialog', 'aria-label': 'Keyboard shortcuts' },
    h('div', { class: 'dialog-head' }, h('h2', null, 'Keyboard shortcuts'), h('button', { class: 'icon-btn ghost', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('x', 16))),
    h('dl', { class: 'keys' }, rows.map(([k, d]) => [h('dt', null, k.split(' ').map((p) => (/^(\/|or|to)$/.test(p) && p !== '/' ? ` ${p} ` : h('kbd', null, p)))), h('dd', null, d)])),
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
  for (const ev of ['request', 'requests:reset', 'log', 'logs:reset', 'mails:reset', 'mails:seen', 'doctor']) on(ev, () => renderNav());
  on('actas', renderActAs);
  on('live', renderLive);

  window.addEventListener('hashchange', route);
  document.addEventListener('keydown', onKey);
  connect();
  try {
    await loadOverview();
  } catch (err) {
    mount(el.main, h('div', { class: 'boot-error' }, h('h1', null, 'Devtools cannot reach the app'), h('p', null, err.message), h('p', { class: 'muted' }, 'Is the server still running in development mode? This page reconnects on its own as soon as it is back.')));
    // The event stream reconnects and resyncs; mount the first panel when the overview arrives.
    const off = on('overview', () => {
      off();
      route();
    });
  }
  if (store.overview) {
    await Promise.allSettled([loadRequests(), loadLogs(), loadMails(), loadDoctor()]);
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
