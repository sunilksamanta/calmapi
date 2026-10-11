// Playground: send requests to your API, optionally as any user (a real session from
// POST /_calm/api/act-as, kept in memory only).

import { h, icon, mount, clear, methodChip, statusChip, STATUS_TEXT, fmtMs, fmtBytes, jsonViewer, empty, tabs, popover, pickerList, userOption, avatar, api, toast, closePopover, policyBadges, relTime, panelHead, copy } from '../lib.js';
import { store, on, startActAs, stopActAs, authHeader } from '../store.js';
import { pathParts, isExplicit } from './routes.js';
import { sampleBody } from './data.js';

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const draft = { method: 'GET', path: '', body: '' };
const history = [];
let lastResponse = null;

export default {
  id: 'playground',
  label: 'Playground',
  icon: 'send',
  badge: () => (store.actAs ? { text: firstName(store.actAs.user.name), tone: 'teal' } : null),
  mount: mountPlayground,
};

const firstName = (n) => String(n ?? '').split(' ')[0];
const withBody = (m) => m !== 'GET' && m !== 'HEAD';

function routeRegex(path) {
  return new RegExp(`^${path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:[A-Za-z_]\w*/g, '[^/]+')}/?$`);
}

function matchRoute(method, path) {
  const bare = path.split('?')[0];
  const candidates = (store.overview?.routes ?? []).filter((r) => r.method === method && routeRegex(r.path).test(bare));
  return candidates.sort((a, b) => (a.path.match(/:/g)?.length ?? 0) - (b.path.match(/:/g)?.length ?? 0))[0] ?? null;
}

function mountPlayground(root) {
  if (store.prefill) {
    const p = store.prefill;
    store.prefill = null;
    draft.method = p.method;
    draft.path = p.path;
    draft.body = p.body ?? '';
    if (!draft.body && withBody(p.method) && p.route?.resource && ['create', 'update'].includes(p.route.action)) {
      const res = store.overview.resources.find((r) => r.name === p.route.resource);
      if (res) draft.body = sampleBody(res);
    }
  }

  const methodSel = h('select', { class: 'input method-select', 'aria-label': 'HTTP method', onchange: () => { draft.method = methodSel.value; syncMethod(); } }, METHODS.map((m) => h('option', { value: m, selected: m === draft.method }, m)));
  const pathInput = h('input', { class: 'input mono path-input', value: draft.path, placeholder: `${store.overview.app.apiPrefix}/...`, 'aria-label': 'Path', spellcheck: false, autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false' });
  const suggest = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const sendBtn = h('button', { class: 'btn primary send-btn', onclick: () => send() }, icon('send', 14), 'Send', h('kbd', { class: 'on-accent' }, 'Ctrl ↵'));
  const bodyArea = h('textarea', { class: 'input mono body-input', spellcheck: false, placeholder: '{\n  "title": "Hello"\n}', 'aria-label': 'JSON body', value: draft.body });
  const bodyState = h('span', { class: 'body-state' });
  const matchLine = h('div', { class: 'pg-match' });
  const authLine = h('div', { class: 'pg-auth' });
  const historyEl = h('div', { class: 'pg-history' });
  const responseEl = h('section', { class: 'card pg-response', 'aria-label': 'Response', 'aria-live': 'polite' });
  const bodyWrap = h('div', { class: 'pg-body' });

  // ---- suggestions ---------------------------------------------------------------

  let sugItems = [];
  let sugActive = 0;
  function showSuggest() {
    const q = pathInput.value.trim().toLowerCase();
    const routes = store.overview.routes.filter((r) => !r.hidden);
    sugItems = routes
      .filter((r) => !q || `${r.method} ${r.path} ${r.summary ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.method === draft.method ? -1 : 0) - (b.method === draft.method ? -1 : 0))
      .slice(0, 9);
    if (!sugItems.length || (sugItems.length === 1 && sugItems[0].path === pathInput.value && sugItems[0].method === draft.method)) return hideSuggest();
    sugActive = Math.min(sugActive, sugItems.length - 1);
    mount(
      suggest,
      sugItems.map((r, i) =>
        h(
          'button',
          { type: 'button', class: ['sug', i === sugActive && 'active'], role: 'option', 'aria-selected': String(i === sugActive), onmousedown: (e) => (e.preventDefault(), pick(r)) },
          methodChip(r.method, 'sm'),
          h('span', { class: 'sug-path mono' }, pathParts(r.path)),
          h('span', { class: 'sug-sum' }, r.summary ?? ''),
        ),
      ),
    );
    suggest.hidden = false;
    pathInput.setAttribute('aria-expanded', 'true');
  }
  function hideSuggest() {
    suggest.hidden = true;
    pathInput.setAttribute('aria-expanded', 'false');
  }
  function pick(r) {
    draft.method = r.method;
    methodSel.value = r.method;
    pathInput.value = r.path;
    draft.path = r.path;
    if (withBody(r.method) && !bodyArea.value.trim() && r.resource && ['create', 'update'].includes(r.action)) {
      const res = store.overview.resources.find((x) => x.name === r.resource);
      if (res) bodyArea.value = draft.body = sampleBody(res);
    }
    hideSuggest();
    syncMethod();
    pathInput.focus();
    const m = /:[A-Za-z_]\w*/.exec(r.path);
    if (m) pathInput.setSelectionRange(m.index, m.index + m[0].length);
  }
  pathInput.addEventListener('focus', showSuggest);
  pathInput.addEventListener('blur', () => setTimeout(hideSuggest, 100));
  pathInput.addEventListener('input', () => {
    draft.path = pathInput.value;
    sugActive = 0;
    showSuggest();
    renderMatch();
  });
  pathInput.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') return (e.preventDefault(), send());
    if (suggest.hidden) {
      if (e.key === 'Enter') (e.preventDefault(), send());
      else if (e.key === 'ArrowDown') showSuggest();
      return;
    }
    if (e.key === 'ArrowDown') sugActive = Math.min(sugItems.length - 1, sugActive + 1);
    else if (e.key === 'ArrowUp') sugActive = Math.max(0, sugActive - 1);
    else if (e.key === 'Enter' || e.key === 'Tab') {
      if (sugItems[sugActive] && (e.key === 'Tab' || pathInput.value !== sugItems[sugActive].path)) {
        e.preventDefault();
        return pick(sugItems[sugActive]);
      }
      hideSuggest();
      if (e.key === 'Enter') (e.preventDefault(), send());
      return;
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      return hideSuggest();
    } else return;
    e.preventDefault();
    showSuggest();
  });

  // ---- body editor ---------------------------------------------------------------

  function validate() {
    const text = bodyArea.value.trim();
    bodyArea.classList.remove('invalid');
    if (!text) return mount(bodyState, h('span', { class: 'muted' }, withBody(draft.method) ? 'Empty body' : 'No body for GET'));
    try {
      JSON.parse(text);
      mount(bodyState, h('span', { class: 't-green-text' }, icon('check', 12), 'Valid JSON'));
      return true;
    } catch (err) {
      bodyArea.classList.add('invalid');
      mount(bodyState, h('span', { class: 't-red-text', title: err.message }, icon('alertCircle', 12), 'Invalid JSON'));
      return false;
    }
  }
  bodyArea.addEventListener('input', () => {
    draft.body = bodyArea.value;
    validate();
  });
  bodyArea.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') return (e.preventDefault(), send());
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      bodyArea.setRangeText('  ', bodyArea.selectionStart, bodyArea.selectionEnd, 'end');
      draft.body = bodyArea.value;
    }
    if (e.key === 'Escape') bodyArea.blur();
  });

  function syncMethod() {
    bodyWrap.classList.toggle('disabled', !withBody(draft.method));
    methodSel.dataset.method = draft.method;
    validate();
    renderMatch();
  }

  function renderMatch() {
    const r = matchRoute(draft.method, draft.path || '');
    if (!r) return mount(matchLine, draft.path ? h('span', { class: 'muted' }, icon('info', 13), 'No declared route matches; you will probably get a 404.') : h('span', { class: 'muted' }, 'Type a path or pick a route. Suggestions come from your routes.'));
    const needsUser = !String(r.policy).split('|').map((t) => t.trim()).includes('public');
    mount(
      matchLine,
      h('span', { class: 'pg-match-route' }, icon('route', 13), methodChip(r.method, 'sm'), h('span', { class: 'mono' }, r.path)),
      policyBadges(r.policy, { explicit: isExplicit(r) }),
      r.summary ? h('span', { class: 'muted' }, r.summary) : null,
      needsUser && !store.actAs && store.overview.auth ? h('span', { class: 't-amber-text' }, icon('alert', 12), 'Needs a signed-in user: act as someone first.') : null,
    );
  }

  // ---- act as ----------------------------------------------------------------------

  function renderAuth() {
    if (!store.overview.auth) return mount(authLine, h('span', { class: 'muted' }, icon('info', 13), 'Auth is not enabled in this app, so requests are anonymous.'));
    const a = store.actAs;
    if (a) {
      return mount(
        authLine,
        h(
          'div',
          { class: 'actas-card' },
          avatar(a.user.name, 28),
          h('div', { class: 'actas-text' }, h('div', null, 'Acting as ', h('b', null, a.user.name), (a.user.roles ?? []).filter((r) => r !== 'user').map((r) => h('span', { class: `badge t-${r === 'admin' ? 'purple' : 'gray'}` }, r))), h('div', { class: 'muted small' }, `${a.user.email ?? a.user.id} · real session token, kept in memory`)),
          h('button', { class: 'btn ghost', onclick: () => copy(a.token, 'Session token copied'), title: 'Copy the bearer token' }, icon('key', 13), 'Token'),
          h('button', { class: 'btn', onclick: stopActAs }, icon('stop', 12), 'Stop'),
        ),
      );
    }
    const btn = h('button', { class: 'btn', 'aria-haspopup': 'dialog' }, icon('users', 14), 'Act as a user', icon('chevronDown', 14));
    btn.addEventListener('click', () =>
      popover(
        btn,
        pickerList({
          placeholder: 'Search users by name or email',
          load: (q) => api(`/users?q=${encodeURIComponent(q)}`),
          render: userOption,
          onPick: async (u) => {
            closePopover();
            try {
              await startActAs(u);
              toast(`Acting as ${u.name}`, { tone: 'ok', detail: 'Playground requests and Replay now carry a real session for this user.' });
            } catch (err) {
              toast(err.message, { tone: 'error' });
            }
          },
        }),
        { width: 340 },
      ),
    );
    mount(authLine, h('div', { class: 'actas-card off' }, h('span', { class: 'avatar anon lg' }, icon('eyeOff', 14)), h('div', { class: 'actas-text' }, h('div', null, 'Anonymous'), h('div', { class: 'muted small' }, 'No Authorization header is sent.')), btn));
  }

  // ---- send ----------------------------------------------------------------------

  async function send() {
    hideSuggest();
    let path = pathInput.value.trim();
    if (!path) return pathInput.focus();
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (u.origin !== location.origin) return toast('The Playground only calls this app (same origin).', { tone: 'warn' });
      path = u.pathname + u.search;
    }
    if (!path.startsWith('/')) path = `/${path}`;
    const method = draft.method;
    const headers = { Accept: 'application/json', ...authHeader() };
    let body;
    if (withBody(method) && bodyArea.value.trim()) {
      if (validate() === false) return toast('The body is not valid JSON', { tone: 'error' });
      body = bodyArea.value;
      headers['Content-Type'] = 'application/json';
    }
    sendBtn.disabled = true;
    mount(responseEl, h('div', { class: 'pg-wait' }, h('span', { class: 'spinner' }), `${method} ${path}`));
    const started = performance.now();
    try {
      const res = await fetch(path, { method, headers, body });
      const text = await res.text();
      const ms = performance.now() - started;
      let json;
      try {
        json = text ? JSON.parse(text) : undefined;
      } catch {
        json = undefined;
      }
      lastResponse = { method, path, status: res.status, ms, size: new Blob([text]).size, text, json, headers: [...res.headers], requestId: res.headers.get('x-request-id'), as: store.actAs?.user.name ?? null };
      history.unshift({ method, path, body: body ?? '', status: res.status, ms, at: Date.now() });
      history.length = Math.min(history.length, 12);
    } catch (err) {
      lastResponse = { method, path, error: err.message };
    } finally {
      sendBtn.disabled = false;
    }
    renderResponse();
    renderHistory();
  }

  function renderResponse() {
    const r = lastResponse;
    if (!r) {
      return mount(responseEl, empty({ icon: 'send', title: 'Send a request', hint: 'The response shows up here. It is also recorded in Requests, with its queries and logs. Tip: Ctrl + Enter sends.' }));
    }
    if (r.error) return mount(responseEl, empty({ icon: 'alertCircle', title: 'Network error', hint: r.error, tone: 'error' }));
    let tab = 'body';
    const content = h('div', { class: 'pg-resp-body' });
    const paint = () => {
      if (tab === 'headers') return mount(content, h('dl', { class: 'kv mono' }, r.headers.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      if (r.json !== undefined) return mount(content, jsonViewer(r.json, { open: 3 }));
      return mount(content, r.text ? h('pre', { class: 'code plain' }, r.text) : empty({ icon: 'braces', title: 'Empty body', hint: `${r.status} ${STATUS_TEXT[r.status] ?? ''}` }));
    };
    mount(
      responseEl,
      h(
        'header',
        { class: 'pg-resp-head' },
        statusChip(r.status, 'lg'),
        h('b', null, STATUS_TEXT[r.status] ?? ''),
        h('span', { class: 'muted num' }, fmtMs(r.ms)),
        h('span', { class: 'muted num' }, fmtBytes(r.size)),
        r.as ? h('span', { class: 'muted small' }, icon('user', 12), `as ${r.as}`) : null,
        h('span', { class: 'spacer' }),
        r.requestId ? h('a', { class: 'btn xs', href: `#/requests/${r.requestId}` }, icon('activity', 12), 'Open in Requests') : null,
      ),
      tabs(
        [
          { id: 'body', label: 'Body' },
          { id: 'headers', label: 'Headers', count: r.headers.length },
        ],
        tab,
        (t) => ((tab = t), paint()),
      ),
      content,
    );
    paint();
  }

  function renderHistory() {
    if (!history.length) return clear(historyEl);
    mount(
      historyEl,
      h('div', { class: 'section-label' }, 'Recent'),
      history.map((x) =>
        h(
          'button',
          {
            class: 'hist-row',
            title: 'Load this request',
            onclick: () => {
              draft.method = x.method;
              draft.path = x.path;
              draft.body = x.body;
              methodSel.value = x.method;
              pathInput.value = x.path;
              bodyArea.value = x.body;
              syncMethod();
            },
          },
          methodChip(x.method, 'sm'),
          h('span', { class: 'mono ellipsis' }, x.path),
          statusChip(x.status, 'sm'),
          h('span', { class: 'muted num small' }, fmtMs(x.ms)),
          h('span', { class: 'muted small' }, relTime(x.at)),
        ),
      ),
    );
  }

  const format = () => {
    try {
      bodyArea.value = draft.body = JSON.stringify(JSON.parse(bodyArea.value), null, 2);
      validate();
    } catch {
      toast('Cannot format: the body is not valid JSON', { tone: 'warn' });
    }
  };

  bodyWrap.append(h('div', { class: 'pg-body-head' }, h('span', { class: 'section-label' }, 'Body', h('span', { class: 'muted' }, ' JSON')), bodyState, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost xs', onclick: format }, icon('wrap', 12), 'Format')), bodyArea);

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      panelHead({ title: 'Playground', sub: 'Call your API as anyone. Every call is recorded in Requests with its queries.' }),
      h(
        'div',
        { class: 'panel-body pg' },
        h(
          'section',
          { class: 'card pg-builder', 'aria-label': 'Request' },
          h('div', { class: 'pg-line' }, methodSel, h('div', { class: 'path-wrap' }, pathInput, suggest), sendBtn),
          matchLine,
          h('div', { class: 'section-label' }, 'Auth'),
          authLine,
          bodyWrap,
          historyEl,
        ),
        responseEl,
      ),
    ),
  );
  syncMethod();
  renderAuth();
  renderResponse();
  renderHistory();
  if (!draft.path) setTimeout(() => pathInput.focus());
  else if (/:[A-Za-z_]\w*/.test(draft.path)) {
    const m = /:[A-Za-z_]\w*/.exec(draft.path);
    setTimeout(() => {
      pathInput.focus({ preventScroll: true });
      pathInput.setSelectionRange(m.index, m.index + m[0].length);
      hideSuggest();
    });
  }
  const off = on('actas', () => {
    renderAuth();
    renderMatch();
  });
  return {
    destroy: off,
    onKey(e) {
      if (e.key === 'Escape') hideSuggest();
    },
  };
}
