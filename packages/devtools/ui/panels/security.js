// Security: who can do what (the exposure matrix, computed from your resources), a live
// audit that calls every route as every persona, security events and the posture.

import { h, icon, mount, clock, fullDate, relTime, empty, loading, errorBox, bar, segmented, plural, joined, popover, richText } from '../lib.js';
import { store, on, loadSecurity, runAudit } from '../store.js';

const ACTIONS = ['list', 'read', 'create', 'update', 'delete'];
const state = { tab: 'access', fieldMode: 'read', open: new Set() };

const ACCESS = {
  allow: { cls: 'acl-allow', title: 'Allowed' },
  own: { cls: 'acl-own', title: 'Only records they own' },
  deny: { cls: 'acl-deny', title: 'Denied' },
  off: { cls: 'acl-off', title: 'Route not enabled for this resource' },
  custom: { cls: 'acl-custom', title: 'Custom policy function: the answer depends on the data' },
};
const FIELD = {
  yes: { cls: 'acl-yes', text: 'yes' },
  no: { cls: 'acl-deny', text: 'no' },
  never: { cls: 'acl-off', text: 'never' },
};
const EVENT_TONE = {
  account_locked: 't-red', locked_login_attempt: 't-red', '2fa_failed': 't-amber', login_failed: 't-amber',
  invalid_token: 't-amber', rate_limited: 't-amber', write_rejected: 't-amber', forbidden: null,
};

export default {
  id: 'security',
  label: 'Security',
  badge: () => {
    if (store.auditRunning) return { text: '…', title: 'Audit running' };
    const s = store.audit?.summary;
    if (s?.failed) return { text: s.failed, tone: 'red', title: `${plural(s.failed, 'failed check')} in the last audit` };
    return null;
  },
  mount: mountSecurity,
};

// ---- audit lookups -----------------------------------------------------------------------

function auditIndex(report) {
  const cells = new Map();
  const leaks = new Map();
  for (const r of report?.results ?? []) cells.set(`${r.resource}|${r.action}|${r.persona}`, r);
  for (const l of report?.leaks ?? []) {
    const k = `${l.resource}|${l.field}|${l.persona}`;
    if (!leaks.has(k)) leaks.set(k, []);
    leaks.get(k).push(l);
  }
  return { cells, leaks };
}

const personaLabel = (matrix, key) => matrix.personas.find((p) => p.key === key)?.label ?? key;
const expectText = (r) => (r.expected === 'allow' || r.expected === 'own' ? 'allowed' : r.expected === 'deny' ? 'denied' : r.expected);

function resultTitle(matrix, r) {
  const who = personaLabel(matrix, r.persona);
  if (r.ok === true) return `${r.action} as ${who}: ${expectText(r)}, got ${r.status} as expected`;
  if (r.ok === null) return `${r.action} as ${who}: skipped (${r.note ?? 'not checked'}), got ${r.status}`;
  return `${r.action} as ${who}: expected ${expectText(r)}, got ${r.status}${r.note ? `. ${r.note}` : ''}`;
}

// ---- panel ---------------------------------------------------------------------------------

function mountSecurity(root) {
  const body = h('div', { class: 'scroll sec-scroll' });
  const meta = h('span', { class: 'bar-meta' });
  const runBtn = h('button', { class: 'btn primary', type: 'button', onclick: () => runAudit() });
  let ticker = null;
  let started = 0;

  const tabSeg = segmented(tabOptions(), state.tab, (v) => ((state.tab = v), render()), 'Security view');

  function tabOptions() {
    const n = store.security?.events.length;
    return [
      { value: 'access', label: 'Access', title: 'Who can call each route and see each field' },
      { value: 'events', label: 'Events', count: n || null, title: 'Failed logins, lockouts, rejected writes, forbidden requests' },
      { value: 'posture', label: 'Posture', title: 'Sessions, passwords, lockout, rate limits, CORS, encryption' },
    ];
  }

  function paintRun() {
    clearInterval(ticker);
    runBtn.disabled = store.auditRunning;
    if (store.auditRunning) {
      started ||= Date.now();
      const tick = () => (runBtn.textContent = `Running audit ${Math.floor((Date.now() - started) / 1000)}s`);
      tick();
      ticker = setInterval(tick, 1000);
    } else {
      started = 0;
      runBtn.textContent = store.audit ? 'Run audit again' : 'Run audit';
    }
    runBtn.title = 'Boots the app on a throwaway database and calls every route as every persona (3 to 10 seconds)';
    const s = store.audit?.summary;
    if (store.auditRunning) mount(meta, 'Calling every route as every persona on a throwaway database');
    else if (store.audit?.error) mount(meta, h('span', { class: 't-red' }, `Audit failed: ${store.audit.error}`));
    else if (s) {
      mount(
        meta,
        joined([
          plural(s.checks, 'check'),
          s.failed ? h('span', { class: 't-red' }, `${s.failed} failed`) : h('span', { class: 't-green' }, 'all passed'),
          s.skipped ? `${s.skipped} skipped` : null,
          s.leaks ? h('span', { class: 't-red' }, plural(s.leaks, 'leak')) : null,
          store.audit.elsewhere ? 'ran elsewhere' : null,
        ]),
      );
    } else mount(meta, 'Not audited yet');
  }

  function render() {
    tabSeg.setOptions(tabOptions());
    paintRun();
    const sec = store.security;
    if (!sec) return mount(body, loading('Loading security'));
    if (state.tab === 'events') return mount(body, eventsView(sec.events));
    if (state.tab === 'posture') return mount(body, postureView(sec.posture));
    const top = body.scrollTop;
    mount(body, accessView(sec.matrix));
    body.scrollTop = top;
  }

  // ---- access ---------------------------------------------------------------------------

  function accessView(matrix) {
    const report = store.audit?.results ? store.audit : null;
    const idx = auditIndex(report);
    return h(
      'div',
      { class: ['sec-access', store.auditRunning && 'is-running'] },
      report || store.audit?.elsewhere ? findings(matrix, report) : null,
      matrix.resources.map((r) => resourceGrid(matrix, r, idx)),
      h('p', { class: 'sec-legend muted' }, joined([h('span', null, h('span', { class: 'acl-allow' }, 'allow')), h('span', null, h('span', { class: 'acl-own' }, 'own'), ' only their records'), h('span', null, h('span', { class: 'acl-deny' }, 'deny')), h('span', null, h('span', { class: 'acl-off' }, 'off'), ' route disabled'), h('span', null, h('span', { class: 'acl-custom' }, 'custom'), ' policy function')])),
    );
  }

  function findings(matrix, report) {
    if (!report) {
      const s = store.audit.summary;
      return h('section', { class: 'sec-findings' }, h('p', { class: 'muted' }, `An audit ran outside this page: ${plural(s.checks, 'check')}, ${s.failed} failed. Run it here to see the details on the matrix.`));
    }
    const failed = report.results.filter((r) => r.ok === false);
    const badProbes = report.probes.filter((p) => !p.ok);
    const goodProbes = report.probes.filter((p) => p.ok);
    const issues = [
      ...failed.map((r) => ({ title: `${r.resource} ${r.action} as ${personaLabel(matrix, r.persona)}`, detail: `Expected ${expectText(r)}, got ${r.status}${r.note ? `. ${r.note}` : ''}`, tag: 'access', target: r.resource })),
      ...report.leaks.map((l) => ({ title: `${l.resource}.${l.field} leaked to ${personaLabel(matrix, l.persona)}`, detail: `In ${l.where}`, tag: 'leak', target: l.resource, fields: true })),
      ...badProbes.map((p) => ({ title: p.name, detail: p.detail, tag: 'probe' })),
    ];
    return h(
      'section',
      { class: 'sec-findings' },
      issues.length
        ? h('ul', { class: 'issues' }, issues.map((i) => h('li', { class: 'issue' }, h('span', { class: 'dot dot-red', 'aria-label': 'failed' }), h('div', { class: 'issue-text' }, h('div', { class: 'issue-title' }, i.target ? h('button', { class: 'link-btn sec-jump', type: 'button', title: 'Show it in the matrix', onclick: () => jump(i.target, i.fields) }, i.title) : i.title), h('div', { class: 'issue-detail' }, i.detail)), h('div', { class: 'issue-meta' }, h('span', { class: 'mono muted' }, i.tag)))))
        : h('p', { class: 'sec-ok' }, h('span', { class: 't-green' }, `All ${plural(report.summary.checks, 'check')} passed`), report.summary.skipped ? h('span', { class: 'muted' }, `, ${report.summary.skipped} skipped`) : null, '.'),
      report.notes?.length ? h('ul', { class: 'sec-notes' }, report.notes.map((n) => h('li', { class: 'muted' }, richText(n)))) : null,
      goodProbes.length
        ? h(
            'details',
            { class: 'sec-probes' },
            h('summary', null, `${plural(goodProbes.length, 'probe')} passed`, h('span', { class: 'muted' }, ' (mass assignment, query injection, tokens, error hygiene)')),
            h('ul', null, goodProbes.map((p) => h('li', null, icon('check', 12, 't-green'), h('span', null, p.name), h('span', { class: 'mono muted' }, p.detail)))),
          )
        : null,
    );
  }

  function jump(name, fields) {
    if (fields && !state.open.has(name)) {
      state.open.add(name);
      render();
    }
    const sec = body.querySelector(`#sec-${CSS.escape(name)}`);
    sec?.scrollIntoView({ block: 'start' });
    sec?.querySelector('.cell-fail')?.focus({ preventScroll: true });
  }

  function resourceGrid(matrix, r, idx) {
    const people = matrix.personas;
    const open = state.open.has(r.name);
    const cell = (action, p) => {
      const value = r.actions[action][p.key];
      const a = ACCESS[value] ?? { cls: '', title: value };
      const res = idx.cells.get(`${r.name}|${action}|${p.key}`);
      const td = h('td', { class: ['acl-cell', res?.ok === false && 'cell-fail', res?.ok === null && 'cell-skip'], title: res ? resultTitle(matrix, res) : `${action} as ${p.label}: ${a.title}` }, h('span', { class: a.cls }, value));
      if (res?.ok === true) td.append(icon('check', 11, 'cell-pass'));
      if (res?.ok === false) {
        td.append(h('span', { class: 'cell-got mono' }, res.status));
        td.tabIndex = 0;
        td.setAttribute('role', 'button');
        const show = () => popover(td, h('div', { class: 'sec-pop' }, h('div', { class: 'strong' }, `${r.name} ${action} as ${p.label}`), h('div', null, `Expected ${expectText(res)}, got ${res.status}.`), res.note ? h('div', { class: 'muted' }, res.note) : null), { width: 280 });
        td.addEventListener('click', show);
        td.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), show()));
      }
      return td;
    };
    const fieldCell = (f, p) => {
      const value = f[state.fieldMode][p.key];
      const v = FIELD[value] ?? { cls: '', text: value };
      const leak = state.fieldMode === 'read' ? idx.leaks.get(`${r.name}|${f.name}|${p.key}`) : null;
      const exposed = state.fieldMode === 'read' && value === 'yes' && f.pii && p.key === 'anonymous' && (r.actions.read.anonymous === 'allow' || r.actions.list.anonymous === 'allow');
      return h(
        'td',
        { class: ['acl-cell', leak && 'cell-fail'], title: leak ? `Leaked: returned to ${p.label} in ${leak.map((l) => l.where).join(', ')}` : exposed ? 'Personal data that anyone can read' : `${f.name}: ${state.fieldMode === 'read' ? 'visible' : 'writable'} for ${p.label}: ${value}` },
        h('span', { class: exposed ? 't-amber' : v.cls }, leak ? 'leaked' : v.text),
      );
    };
    const toggle = h('button', { class: 'sec-fields-toggle', type: 'button', 'aria-expanded': String(open) }, icon(open ? 'chevronDown' : 'chevronRight', 12), `Fields`, h('span', { class: 'muted' }, ` ${r.fields.length}`));
    toggle.addEventListener('click', () => {
      if (state.open.has(r.name)) state.open.delete(r.name);
      else state.open.add(r.name);
      render();
    });
    const marks = (f) => [f.pii ? h('span', { class: 'fd-mark', title: 'Looks like personal data' }, 'pii') : null, f.encrypted ? h('span', { class: 'fd-mark', title: 'Encrypted at rest (AES-256-GCM)' }, 'encrypted') : null];
    const leakCount = [...idx.leaks.keys()].filter((k) => k.startsWith(`${r.name}|`)).length;
    return h(
      'section',
      { class: 'sec-res', id: `sec-${r.name}` },
      h(
        'header',
        { class: 'sec-res-head' },
        h('h2', { class: 'res-name' }, r.name),
        h('span', { class: 'res-facts' }, joined([h('span', { class: 'mono' }, `${store.overview?.app.apiPrefix ?? ''}${r.path}`), r.ownerField ? h('span', null, h('span', { class: 'muted' }, 'owner '), h('span', { class: 'mono' }, r.ownerField)) : null, r.customScope ? h('span', { title: 'The service defines scope(): lists and reads can return fewer records than the policy alone says' }, h('span', { class: 'dot dot-amber' }), ' custom scope()') : null])),
      ),
      h(
        'table',
        { class: 'acl' },
        h('thead', null, h('tr', null, h('th', { scope: 'col' }), people.map((p) => h('th', { scope: 'col' }, p.label)))),
        h('tbody', null, ACTIONS.map((a) => h('tr', null, h('th', { scope: 'row', class: 'mono' }, a), people.map((p) => cell(a, p))))),
        h(
          'tbody',
          { class: 'acl-fields-head' },
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, toggle),
            h('td', { colspan: String(people.length) }, open ? segmented([{ value: 'read', label: 'Read' }, { value: 'write', label: 'Write' }], state.fieldMode, (v) => ((state.fieldMode = v), render()), 'Field access') : leakCount ? h('span', { class: 't-red' }, plural(leakCount, 'leak')) : h('span', { class: 'muted' }, r.fields.filter((f) => f.pii).length ? `${plural(r.fields.filter((f) => f.pii).length, 'personal field')}` : '')),
          ),
        ),
        open ? h('tbody', { class: 'acl-fields' }, r.fields.map((f) => h('tr', null, h('th', { scope: 'row' }, h('span', { class: 'mono' }, f.name), marks(f)), people.map((p) => fieldCell(f, p))))) : null,
      ),
    );
  }

  // ---- events ---------------------------------------------------------------------------

  function eventsView(events) {
    if (!events.length) return empty('No security events yet. Failed logins, lockouts, invalid tokens, rate limits and rejected writes show up here live.');
    return h(
      'table',
      { class: 'tbl sec-events' },
      h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Time'), h('th', { scope: 'col' }, 'Event'), h('th', { scope: 'col' }, 'Details'), h('th', { scope: 'col' }, 'IP'))),
      h('tbody', null, events.map(eventRow)),
    );
  }

  function eventRow(e) {
    const { id: _id, time, type, ip, ...rest } = e;
    const parts = [];
    if (rest.email) parts.push(h('span', { class: 'mono' }, rest.email));
    if (rest.method || rest.path) parts.push(h('span', { class: 'mono' }, [rest.method, rest.path].filter(Boolean).join(' ')));
    if (rest.fields) parts.push(h('span', null, h('span', { class: 'muted' }, 'fields '), h('span', { class: 'mono' }, [].concat(rest.fields).join(', '))));
    if (rest.reason) parts.push(h('span', { class: 'muted' }, String(rest.reason).replace(/_/g, ' ')));
    if (rest.until) parts.push(h('span', null, h('span', { class: 'muted' }, 'until '), h('span', { class: 'mono' }, clock(rest.until))));
    if (rest.limiter) parts.push(h('span', null, h('span', { class: 'muted' }, 'limiter '), h('span', { class: 'mono' }, rest.limiter)));
    if (rest.userId) parts.push(h('span', { title: rest.userId }, h('span', { class: 'muted' }, 'user '), h('span', { class: 'mono' }, String(rest.userId).slice(-8))));
    const known = new Set(['email', 'method', 'path', 'fields', 'reason', 'until', 'limiter', 'userId', 'resource']);
    for (const [k, v] of Object.entries(rest)) if (!known.has(k) && v != null && typeof v !== 'object') parts.push(h('span', null, h('span', { class: 'muted' }, `${k} `), h('span', { class: 'mono' }, String(v))));
    return h(
      'tr',
      null,
      h('td', { class: 'mono muted', title: `${fullDate(time)} (${relTime(time)})` }, clock(time)),
      h('td', { class: ['mono', EVENT_TONE[type] ?? null] }, type),
      h('td', null, joined(parts)),
      h('td', { class: 'mono muted' }, ip ?? ''),
    );
  }

  // ---- posture --------------------------------------------------------------------------

  function postureView(p) {
    const win = (ms) => (ms % 60000 === 0 ? `${ms / 60000} min` : `${Math.round(ms / 1000)} s`);
    const rate = (r) => (r ? `${r.max} per ${win(r.windowMs)}` : 'off');
    const lock = p.lockout;
    const rows = [
      ['Auth', p.auth ? 'on' : h('span', { class: 't-amber' }, 'off')],
      ['Sessions', p.sessions ?? 'none'],
      ['Passwords', p.passwords],
      ['Lockout', !lock || !lock.maxAttempts ? h('span', { class: 't-amber' }, 'off') : `${plural(lock.maxAttempts, 'failed attempt')} in ${lock.windowMinutes} min locks the account for ${lock.lockMinutes} min`],
      ['Rate limits', p.rateLimit === 'off' ? h('span', { class: 't-amber' }, 'off') : joined([h('span', null, h('span', { class: 'muted' }, 'global '), rate(p.rateLimit.global)), h('span', null, h('span', { class: 'muted' }, 'auth '), rate(p.rateLimit.auth))])],
      ['CORS', p.cors === '*' || (Array.isArray(p.cors) && p.cors.includes('*')) ? h('span', { title: 'Any origin. Fine in development; set CORS_ORIGINS in production.' }, h('span', { class: 'mono' }, '*'), h('span', { class: 'muted' }, ' any origin')) : h('span', { class: 'mono' }, [].concat(p.cors ?? []).join(', ') || 'none')],
      ['Encryption', p.encryption.fields.length || p.encryption.keys.length ? joined([h('span', null, h('span', { class: 'muted' }, 'keys '), h('span', { class: 'mono' }, p.encryption.keys.join(', ') || 'none')), h('span', null, h('span', { class: 'muted' }, 'fields '), h('span', { class: 'mono' }, p.encryption.fields.join(', ') || 'none'))]) : h('span', { class: 'muted' }, 'no encrypted fields')],
      ['JSON limits', p.jsonLimits ? `depth ${p.jsonLimits.maxDepth}, ${p.jsonLimits.maxKeys} keys` : 'default'],
      ['Headers', h('span', { class: 'mono' }, p.headers.join(', '))],
    ];
    return h('div', { class: 'stack' }, h('dl', { class: 'kv sec-posture' }, rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])));
  }

  // ---- wiring ---------------------------------------------------------------------------

  mount(root, h('div', { class: 'panel' }, bar('Security', tabSeg, h('span', { class: 'spacer' }), meta, runBtn), body));
  render();
  if (!store.security) loadSecurity().catch((err) => mount(body, errorBox(err)));
  else loadSecurity().catch(() => {});

  const offs = [
    on('security:reset', render),
    on('security', () => {
      tabSeg.setOptions(tabOptions());
      if (state.tab === 'events') render();
    }),
    on('audit:start', render),
    on('audit', () => {
      render();
      if (store.audit?.results) body.scrollTop = 0;
    }),
  ];
  return {
    destroy: () => {
      offs.forEach((off) => off());
      clearInterval(ticker);
    },
    refresh: () => loadSecurity().catch(() => {}),
  };
}
