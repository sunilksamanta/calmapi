// Playground: send requests to your API, optionally as any user (a real session from
// POST /_calm/api/act-as, kept in memory only).

import { h, icon, mount, clear, methodTag, statusTag, STATUS_TEXT, fmtMs, fmtBytes, jsonViewer, empty, tabs, popover, pickerList, userOption, api, toast, closePopover, policyText, routePath, relTime, bar, copy, joined } from '../lib.js';
import { store, on, startActAs, stopActAs, authHeader } from '../store.js';
import { isExplicit } from './routes.js';
import { sampleBody } from './data.js';

const METHODS = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];
const draft = { method: 'GET', path: '', body: '' };
const history = [];
let lastResponse = null;

export default {
  id: 'playground',
  label: 'Playground',
  badge: () => (store.actAs ? { text: firstName(store.actAs.user.name), title: `Acting as ${store.actAs.user.name}` } : null),
  mount: mountPlayground,
};

const firstName = (n) => String(n ?? '').split(' ')[0];
const withBody = (m) => m !== 'GET' && m !== 'HEAD';
const methodKey = (m) => ({ GET: 'get', POST: 'post', PATCH: 'put', PUT: 'put', DELETE: 'del' })[m] ?? 'other';

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
  const pathInput = h('input', { class: 'input path-input', value: draft.path, placeholder: `${store.overview.app.apiPrefix}/...`, 'aria-label': 'Path', spellcheck: false, autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false' });
  const suggest = h('div', { class: 'suggest', role: 'listbox', hidden: true });
  const sendBtn = h('button', { class: 'btn primary send-btn', type: 'button', title: 'Send (Ctrl + Enter)', onclick: () => send() }, 'Send');
  const asBtn = h('button', { class: 'btn ghost picker-btn', type: 'button', 'aria-haspopup': 'dialog' });
  const tokenBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Copy the bearer token of this session', onclick: () => store.actAs && copy(store.actAs.token, 'Session token copied') }, 'Copy token');
  const bodyArea = h('textarea', { class: 'input body-input', spellcheck: false, placeholder: '{\n  "title": "Hello"\n}', 'aria-label': 'JSON body', value: draft.body });
  const bodyState = h('span', { class: 'muted' });
  const matchLine = h('div', { class: 'pg-match' });
  const historyEl = h('div', { class: 'pg-history' });
  const responseEl = h('section', { class: 'pg-response', 'aria-label': 'Response', 'aria-live': 'polite' });
  const bodyPane = h('div', { class: 'pg-body' });

  // ---- suggestions ---------------------------------------------------------------

  let sugItems = [];
  let sugActive = 0;
  function showSuggest() {
    const q = pathInput.value.trim().toLowerCase();
    const routes = store.overview.routes.filter((r) => !r.hidden);
    sugItems = routes
      .filter((r) => !q || `${r.method} ${r.path} ${r.summary ?? ''}`.toLowerCase().includes(q))
      .sort((a, b) => (a.method === draft.method ? -1 : 0) - (b.method === draft.method ? -1 : 0))
      .slice(0, 10);
    if (!sugItems.length || (sugItems.length === 1 && sugItems[0].path === pathInput.value && sugItems[0].method === draft.method)) return hideSuggest();
    sugActive = Math.min(sugActive, sugItems.length - 1);
    mount(
      suggest,
      sugItems.map((r, i) =>
        h(
          'button',
          { type: 'button', class: ['sug', i === sugActive && 'active'], role: 'option', 'aria-selected': String(i === sugActive), onmousedown: (e) => (e.preventDefault(), pick(r)) },
          methodTag(r.method),
          h('span', { class: 'sug-path' }, routePath(r.path)),
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
    if (!text) {
      bodyState.className = 'muted';
      bodyState.textContent = withBody(draft.method) ? 'empty' : `not sent with ${draft.method}`;
      bodyState.title = '';
      return null;
    }
    try {
      JSON.parse(text);
      bodyState.className = 'muted';
      bodyState.textContent = 'valid JSON';
      bodyState.title = '';
      return true;
    } catch (err) {
      bodyArea.classList.add('invalid');
      bodyState.className = 't-red';
      bodyState.textContent = 'invalid JSON';
      bodyState.title = err.message;
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
    bodyPane.classList.toggle('disabled', !withBody(draft.method));
    methodSel.className = `input method-select m-${methodKey(draft.method)}`;
    validate();
    renderMatch();
  }

  function renderMatch() {
    const r = matchRoute(draft.method, draft.path || '');
    if (!r) return mount(matchLine, h('span', { class: 'muted' }, draft.path ? 'No declared route matches this path. Expect a 404.' : 'Type a path or pick one of your routes.'));
    const needsUser = !String(r.policy).split('|').map((t) => t.trim()).includes('public');
    mount(
      matchLine,
      joined([
        h('span', null, h('span', { class: 'muted' }, 'Route '), h('span', { class: 'mono' }, routePath(r.path))),
        policyText(r.policy, { explicit: isExplicit(r) }),
        r.summary ? h('span', { class: 'muted' }, r.summary) : null,
        needsUser && !store.actAs && store.overview.auth ? h('span', { class: 't-amber' }, 'needs a signed-in user: pick one in As') : null,
      ]),
    );
  }

  // ---- act as ----------------------------------------------------------------------

  function renderAuth() {
    const a = store.actAs;
    if (!store.overview.auth) {
      asBtn.disabled = true;
      asBtn.title = 'Auth is not enabled in this app, so requests are anonymous';
      mount(asBtn, h('span', { class: 'muted' }, 'As'), 'Anonymous');
      tokenBtn.hidden = true;
      return;
    }
    asBtn.title = a ? `Requests carry a real session for ${a.user.email ?? a.user.name}` : 'Send requests as a user (creates a real session, kept in memory)';
    mount(asBtn, h('span', { class: 'muted' }, 'As'), h('span', { class: a ? 'strong' : null }, a ? a.user.name : 'Anonymous'), icon('chevronDown', 12));
    tokenBtn.hidden = !a;
  }

  asBtn.addEventListener('click', () =>
    popover(
      asBtn,
      pickerList({
        placeholder: 'Search users by name or email',
        fixed: [{ id: null, name: 'Anonymous', sub: store.actAs ? 'Stop acting, send no Authorization header' : 'No Authorization header' }],
        load: (q) => api(`/users?q=${encodeURIComponent(q)}`),
        render: userOption,
        onPick: async (u) => {
          closePopover();
          if (!u.id) return stopActAs();
          try {
            await startActAs(u);
          } catch (err) {
            toast(err.message, { tone: 'error' });
          }
        },
      }),
      { width: 320, align: 'end' },
    ),
  );

  // ---- send ----------------------------------------------------------------------

  async function send() {
    hideSuggest();
    let path = pathInput.value.trim();
    if (!path) return pathInput.focus();
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (u.origin !== location.origin) return toast('The Playground only calls this app', { tone: 'warn' });
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
    mount(responseEl, h('div', { class: 'empty loading' }, `${method} ${path}…`));
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
    if (!r) return mount(responseEl, h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'Response')), empty('Nothing sent yet. Ctrl + Enter sends.'));
    if (r.error) return mount(responseEl, h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'Response')), h('div', { class: 'empty is-error' }, `Network error: ${r.error}`));
    let tab = 'body';
    const content = h('div', { class: 'scroll pg-resp-body' });
    const paint = () => {
      if (tab === 'headers') return mount(content, h('dl', { class: 'kv mono pad' }, r.headers.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
      if (r.json !== undefined) return mount(content, h('div', { class: 'pad' }, jsonViewer(r.json, { open: 3 })));
      return mount(content, r.text ? h('pre', { class: 'code plain pad' }, r.text) : empty('Empty body.'));
    };
    mount(
      responseEl,
      h(
        'div',
        { class: 'pane-head' },
        h('span', { class: 'resp-line' }, statusTag(r.status), h('span', null, STATUS_TEXT[r.status] ?? ''), h('span', { class: 'muted' }, joined([h('span', { class: 'mono' }, fmtMs(r.ms)), h('span', { class: 'mono' }, fmtBytes(r.size)), r.as ? `as ${r.as}` : null]))),
        h('span', { class: 'spacer' }),
        r.requestId ? h('a', { class: 'btn ghost', href: `#/requests/${r.requestId}` }, 'Open in Requests') : null,
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
      h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'History'), h('span', { class: 'muted' }, history.length)),
      history.map((x) =>
        h(
          'button',
          {
            type: 'button',
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
          statusTag(x.status),
          methodTag(x.method),
          h('span', { class: 'mono ellipsis' }, x.path),
          h('span', { class: 'mono muted num' }, fmtMs(x.ms)),
          h('span', { class: 'muted num' }, relTime(x.at)),
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

  bodyPane.append(h('div', { class: 'pane-head' }, h('span', { class: 'pane-title' }, 'Body'), bodyState, h('span', { class: 'spacer' }), h('button', { class: 'btn ghost', type: 'button', onclick: format }, 'Format')), bodyArea);

  mount(
    root,
    h(
      'div',
      { class: 'panel' },
      bar('Playground', h('span', { class: 'bar-meta' }, 'Every call is recorded in Requests')),
      h(
        'div',
        { class: 'pg' },
        h('div', { class: 'pg-line' }, methodSel, h('div', { class: 'path-wrap' }, pathInput, suggest), asBtn, tokenBtn, sendBtn),
        matchLine,
        h('div', { class: 'pg-split' }, h('section', { class: 'pg-left', 'aria-label': 'Request body' }, bodyPane, historyEl), responseEl),
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
