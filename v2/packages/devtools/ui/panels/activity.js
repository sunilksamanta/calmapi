// Activity: what happened in the project, newest first. File changes (with diffs),
// restarts and crashes come from `calm dev`; tool calls come from `calm mcp`, so you can
// watch an AI agent work and see exactly what it changed.

import { h, mount, clock, fullDate, relTime, empty, bar, segmented, plural, fileLink, actorMark, joined, fmtMs, methodTag, statusTag, codeBlock, api, toast, loading } from '../lib.js';
import { store, on, markActivitySeen, unseenActivity, loadOverview } from '../store.js';

const SERVER = new Set(['restart', 'ready', 'session', 'crash']);
const state = { filter: 'all', follow: true };
const expanded = new Set(); // keys of rows the user opened
const collapsed = new Set(); // keys of rows open by default that the user closed

export default {
  id: 'activity',
  label: 'Activity',
  badge: () => {
    const fresh = unseenActivity();
    if (!fresh.length) return null;
    const crash = fresh.some((e) => e.type === 'crash');
    return { text: fresh.length, tone: crash ? 'red' : 'strong', title: `${plural(fresh.length, 'new event')} since you last looked${crash ? ', including a crash' : ''}` };
  },
  mount: mountActivity,
};

// ---- event helpers ---------------------------------------------------------------------

// Ids are assigned by the dev server and change when it restarts; this key does not.
const keyOf = (e) => `${e.time}|${e.type}|${e.path ?? e.tool ?? ''}`;
const actorKind = (e) => (typeof e.actor === 'string' ? e.actor : e.actor?.kind) ?? 'human';
export const isAgentEvent = (e) => e.type === 'agent' || e.type === 'proposal' || (e.type === 'file' && actorKind(e) === 'agent');

function actorName(e) {
  if (e.type === 'agent' || e.type === 'proposal') return e.client ?? 'agent';
  if (e.type === 'file') return actorKind(e) === 'agent' ? (e.actor?.name ?? e.client ?? 'agent') : 'you';
  return 'server';
}

const FILTERS = {
  all: () => true,
  agent: isAgentEvent,
  files: (e) => e.type === 'file',
  server: (e) => SERVER.has(e.type),
};

function parseArgs(e) {
  if (e.args && typeof e.args === 'object') return e.args;
  try {
    return JSON.parse(e.args ?? '{}');
  } catch {
    return null;
  }
}

/** Server output is mixed with log lines; start the excerpt at the first line that is not one. */
function crashExcerpt(text) {
  const lines = String(text ?? '').split('\n');
  const logLine = /^\s*$|^\d{2}:\d{2}:\d{2}(\.\d+)? [A-Z]{3} /;
  const start = lines.findIndex((l) => !logLine.test(l));
  return (start < 0 ? lines : lines.slice(start)).join('\n').trim();
}

const firstErrorLine = (text) => crashExcerpt(text).split('\n').find((l) => /\w*Error\b|ERR_|Cannot find module|Invalid configuration/.test(l)) ?? crashExcerpt(text).split('\n')[0] ?? '';

/** Restart followed by ready becomes one row: "Server restarted · ready in 640 ms". */
function fold(events) {
  const chrono = [...events].reverse();
  const readyIn = new Map();
  const hidden = new Set();
  chrono.forEach((e, i) => {
    if (e.type !== 'ready') return;
    const prev = chrono[i - 1];
    if (prev && (prev.type === 'restart' || prev.type === 'session') && !readyIn.has(prev)) {
      readyIn.set(prev, Date.parse(e.time) - Date.parse(prev.time));
      hidden.add(e);
    }
  });
  return { list: events.filter((e) => !hidden.has(e)), readyIn };
}

// ---- rows ------------------------------------------------------------------------------

const tool = (name) => h('span', { class: 'act-tool' }, name);

function agentLine(e) {
  const a = parseArgs(e) ?? {};
  const out = String(e.summary ?? '');
  if (e.tool === 'connect') return [h('span', null, 'connected over MCP')];
  if (e.tool === 'calm_http') {
    const status = /"status":\s*(\d{3})/.exec(out)?.[1];
    const rid = /"requestId":\s*"([^"]+)"/.exec(out)?.[1];
    return [
      tool('calm_http'),
      a.method ? methodTag(a.method) : null,
      h('span', { class: 'mono act-path' }, a.path ?? ''),
      a.as && a.as !== 'anonymous' ? h('span', { class: 'muted' }, `as ${a.as}`) : null,
      status ? h('span', { class: 'act-arrow', 'aria-hidden': 'true' }, '→') : null,
      status ? (rid && store.requests.some((r) => r.id === rid) ? h('a', { href: `#/requests/${rid}`, title: 'Open this request' }, statusTag(Number(status))) : statusTag(Number(status))) : null,
    ];
  }
  if (e.tool === 'calm_make_resource') {
    return [tool(e.tool), h('span', { class: 'mono' }, a.name ?? ''), Array.isArray(a.fields) ? h('span', { class: 'mono muted act-args' }, a.fields.join('  ')) : null];
  }
  const args = Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join('  ');
  return [tool(e.tool ?? 'tool'), args ? h('span', { class: 'mono muted act-args' }, args) : null];
}

// "Refused: scope "read" cannot run calm_make_resource. Ask the developer..." without the advice.
const refusalReason = (e) => String(e.summary ?? '').split('\n')[0].replace(/^Refused:\s*/, '').split('. ')[0];

function describe(e, readyIn) {
  switch (e.type) {
    case 'agent':
      if (e.refused) return [agentLine(e), h('span', { class: 'badge b-red', title: e.summary ?? '' }, 'refused'), h('span', { class: 't-red act-fail' }, refusalReason(e))];
      return [agentLine(e), e.ok === false ? h('span', { class: 't-red act-fail' }, `failed: ${String(e.summary ?? '').split('\n')[0]}`) : null];
    case 'file':
      return [
        h('span', { class: `act-change act-${e.change}` }, e.change),
        h('span', { class: 'mono act-path' }, e.path),
        e.protected ? h('span', { class: 'badge b-amber', title: e.reason === 'access rules' ? 'An agent changed a policy or field visibility line. Review it before committing.' : 'An agent changed a protected path (agents.protected in calm.config.js). Review it before committing.' }, e.reason ?? 'protected') : null,
        e.note ? h('span', { class: 'muted' }, e.note) : null,
      ];
    case 'proposal':
      return [h('span', { class: 'act-strong' }, 'Proposal'), h('span', { class: 'act-path' }, e.title ?? e.id), h('span', { class: 'mono muted act-args' }, (e.files ?? []).join('  '))];
    case 'restart':
      return [h('span', null, 'Server restarted'), readyIn.has(e) ? h('span', { class: 'muted' }, `ready in ${fmtMs(readyIn.get(e))}`) : null];
    case 'ready':
      return [h('span', null, 'Server ready')];
    case 'session':
      return [h('span', null, e.note ?? 'Session started'), readyIn.has(e) ? h('span', { class: 'muted' }, `ready in ${fmtMs(readyIn.get(e))}`) : null];
    case 'crash':
      return [h('span', { class: 't-red act-strong' }, 'Crashed'), h('span', { class: 'mono act-err' }, firstErrorLine(e.text))];
    default:
      return [h('span', null, e.type), e.note ? h('span', { class: 'muted' }, e.note) : null];
  }
}

function meta(e) {
  if (e.type === 'agent') return h('span', { class: 'mono muted' }, e.ms != null && e.tool !== 'connect' ? fmtMs(e.ms) : '');
  if (e.type === 'file' && e.diff) return h('span', { class: 'mono act-stat' }, h('span', { class: 't-green' }, `+${e.diff.added ?? 0}`), ' ', h('span', { class: 't-red' }, `-${e.diff.removed ?? 0}`));
  if (e.type === 'proposal') return h('span', { class: 'mono muted' }, plural((e.files ?? []).length, 'file'));
  return h('span');
}

function markFor(e) {
  if (e.type === 'crash') return actorMark('crash', 'Crash');
  if (e.type === 'agent' && e.refused) return actorMark('agent-fail', `${e.client ?? 'Agent'} (refused by scope ${e.scope ?? ''})`);
  if (e.type === 'agent' && e.ok === false) return actorMark('agent-fail', `${e.client ?? 'Agent'} (tool call failed)`);
  if (isAgentEvent(e)) return actorMark('agent', `AI agent: ${actorName(e)}`);
  if (e.type === 'file') return actorMark('human', 'You (a human edit)');
  return actorMark('server', 'Dev server');
}

/** Unified diff: old and new line numbers, +/- tinted lines. Accepts string or tuple lines. */
export function diffView(diff) {
  const rows = [];
  for (const hunk of diff.hunks ?? []) {
    let o = hunk.oldStart ?? null;
    let n = hunk.newStart ?? null;
    rows.push(h('div', { class: 'df-hunk' }, hunk.header ?? `@@ -${hunk.oldStart ?? '?'} +${hunk.newStart ?? '?'} @@`));
    for (const line of hunk.lines ?? []) {
      let op;
      let text;
      let oldNo;
      let newNo;
      if (Array.isArray(line)) [op, text, oldNo, newNo] = line;
      else {
        op = line[0] === '+' || line[0] === '-' ? line[0] : ' ';
        text = line.slice(1);
        oldNo = op === '+' ? null : o;
        newNo = op === '-' ? null : n;
        if (op !== '+' && o != null) o++;
        if (op !== '-' && n != null) n++;
      }
      rows.push(h('div', { class: ['df-line', op === '+' && 'df-add', op === '-' && 'df-del'] }, h('span', { class: 'df-no' }, oldNo ?? ''), h('span', { class: 'df-no' }, newNo ?? ''), h('span', { class: 'df-op' }, op === ' ' ? '' : op), h('span', { class: 'df-text' }, text || ' ')));
    }
  }
  if (!rows.length) rows.push(h('div', { class: 'df-more' }, 'No line changes.'));
  if (diff.truncated) rows.push(h('div', { class: 'df-more' }, 'Diff truncated.'));
  return h('div', { class: 'diff' }, rows);
}

function details(e) {
  const root = store.overview?.app.root;
  if (e.type === 'file') {
    return [
      e.diff ? diffView(e.diff) : h('p', { class: 'muted' }, e.note ?? 'No diff recorded for this file.'),
      e.change !== 'deleted' ? h('div', { class: 'act-foot' }, fileLink(root, e.path, { label: `Open ${e.path}` })) : null,
    ];
  }
  if (e.type === 'crash') return h('pre', { class: 'act-stderr' }, crashExcerpt(e.text));
  if (e.type === 'agent') {
    const args = parseArgs(e);
    const rid = /"requestId":\s*"([^"]+)"/.exec(String(e.summary ?? ''))?.[1];
    return [
      h('div', { class: 'act-io' }, h('span', { class: 'act-io-label' }, 'Arguments'), args && Object.keys(args).length ? codeBlock(args) : h('span', { class: 'muted' }, 'none')),
      h('div', { class: 'act-io' }, h('span', { class: 'act-io-label' }, e.refused ? `Refused (scope ${e.scope ?? '?'})` : e.ok === false ? 'Error' : 'Result'), h('pre', { class: ['code plain', e.ok === false && 't-red'] }, e.summary || ' ')),
      rid ? h('div', { class: 'act-foot' }, h('a', { href: `#/requests/${rid}` }, 'Open the request')) : null,
    ];
  }
  if (e.type === 'proposal') return proposalView(e);
  return null;
}

/** A proposal's reason, per-file diffs and the Apply button; the full record comes from the API. */
function proposalView(e) {
  const box = h('div', { class: 'prop' }, loading('Loading proposal'));
  const show = (p) => {
    const apply = h('button', { class: 'btn primary', type: 'button', disabled: Boolean(p.appliedAt) }, p.appliedAt ? 'Applied' : 'Apply');
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const out = await api(`/proposals/${encodeURIComponent(p.id)}/apply`, { method: 'POST' });
        toast(`Applied ${plural(out.applied.length, 'file')} from "${p.title}"`);
        show({ ...p, appliedAt: out.appliedAt });
      } catch (err) {
        toast(err.message, { tone: 'error' });
        apply.disabled = false;
      }
    });
    mount(
      box,
      h('div', { class: 'prop-head' }, h('span', { class: 'prop-title' }, p.title), h('span', { class: 'spacer' }), p.appliedAt ? h('span', { class: 'muted', title: fullDate(p.appliedAt) }, `applied ${relTime(p.appliedAt)}`) : null, apply),
      p.reason ? h('p', { class: 'prop-reason' }, p.reason) : null,
      (p.files ?? []).map((f) => h('div', { class: 'act-io' }, h('span', { class: 'act-io-label mono' }, f.path, ' ', h('span', { class: 't-green' }, `+${f.diff?.added ?? 0}`), ' ', h('span', { class: 't-red' }, `-${f.diff?.removed ?? 0}`)), f.diff ? diffView(f.diff) : null)),
      h('p', { class: 'muted prop-note' }, 'Applying writes these files as you (the agent proposed, you decide). The dev server restarts as for any edit.'),
    );
  };
  api(`/proposals/${encodeURIComponent(e.id)}`).then(show, (err) => mount(box, h('p', { class: 't-red' }, err.message)));
  return box;
}

const expandable = (e) => e.type === 'file' || e.type === 'crash' || e.type === 'proposal' || (e.type === 'agent' && e.tool !== 'connect');

// ---- panel -----------------------------------------------------------------------------

function mountActivity(root) {
  const list = h('div', { class: 'act-list', role: 'list', 'aria-label': 'Project activity' });
  const scroller = h('div', { class: 'scroll act-scroll' }, list);
  const summary = h('span', { class: 'bar-meta' });
  // The agent connected over MCP right now (.calm/agent-session.json, via the overview).
  const sessionEl = h('span', { class: 'act-session' });
  const renderSession = () => {
    const s = store.overview?.agentSession;
    if (!s) return mount(sessionEl);
    const paths = (s.protected ?? []).filter((p) => !(s.allow ?? []).includes(p));
    const tip = [`Connected ${relTime(s.startedAt)} in scope ${s.scope}.`, paths.length ? `Protected paths: ${paths.join(', ')}.` : 'No protected paths.', s.allow?.length ? `Allowed this session: ${s.allow.join(', ')}.` : null].filter(Boolean).join('\n');
    mount(sessionEl, actorMark('agent'), h('span', { class: 'act-session-text', title: tip }, `${s.client ?? 'agent'} · scope ${s.scope}`));
  };
  const followBtn = h('button', { class: 'btn ghost', type: 'button', title: 'Keep the newest event in view', onclick: () => setFollow(!state.follow) });
  const counts = () => Object.fromEntries(Object.entries(FILTERS).map(([k, fn]) => [k, store.activity.filter(fn).length]));

  function setFollow(v) {
    state.follow = v;
    followBtn.setAttribute('aria-pressed', String(v));
    followBtn.textContent = v ? 'Following' : 'Follow';
    if (v) scroller.scrollTop = 0;
  }

  const segOptions = () => {
    const c = counts();
    return [
      { value: 'all', label: 'All', count: c.all },
      { value: 'agent', label: 'Agent', count: c.agent, title: 'Tool calls and file edits by AI agents' },
      { value: 'files', label: 'Files', count: c.files },
      { value: 'server', label: 'Server', count: c.server, title: 'Restarts, crashes and dev sessions' },
    ];
  };
  const seg = segmented(segOptions(), state.filter, (v) => ((state.filter = v), render()), 'Filter activity');

  function row(e, readyIn, latest) {
    const key = keyOf(e);
    const canOpen = expandable(e);
    const isOpen = canOpen && (expanded.has(key) || (e.type === 'crash' && latest && !collapsed.has(key)));
    // A div, not a button: the description can hold links (a request status, for example).
    const head = h(
      'div',
      { class: ['act-line', canOpen && 'can-open'], role: canOpen ? 'button' : null, tabindex: canOpen ? '0' : null, 'aria-expanded': canOpen ? String(isOpen) : null },
      h('span', { class: 'act-time mono', title: `${fullDate(e.time)} (${relTime(e.time)})` }, clock(e.time)),
      markFor(e),
      h('span', { class: ['act-actor', isAgentEvent(e) && 'is-agent'] }, actorName(e)),
      h('span', { class: 'act-desc' }, describe(e, readyIn)),
      meta(e),
    );
    const el = h('div', { class: ['act-row', `act-${e.type}`, isOpen && 'open', isAgentEvent(e) && 'by-agent'], role: 'listitem' }, head, isOpen ? h('div', { class: 'act-body' }, details(e)) : null);
    if (canOpen) {
      head.addEventListener('keydown', (ev) => {
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        ev.preventDefault();
        head.click();
      });
      head.addEventListener('click', (ev) => {
        if (ev.target.closest('a')) return;
        if (!el.classList.contains('open')) {
          expanded.add(key);
          collapsed.delete(key);
        } else {
          expanded.delete(key);
          collapsed.add(key);
        }
        const fresh = row(e, readyIn, latest);
        el.replaceWith(fresh);
        fresh.querySelector('.act-line')?.focus({ preventScroll: true });
      });
    }
    return el;
  }

  function render() {
    seg.setOptions(segOptions());
    const agentCalls = store.activity.filter((e) => e.type === 'agent' && e.tool !== 'connect').length;
    const files = new Set(store.activity.filter((e) => e.type === 'file').map((e) => e.path)).size;
    mount(summary, store.activity.length ? joined([agentCalls ? plural(agentCalls, 'agent call') : null, files ? plural(files, 'file') + ' changed' : null, `last ${relTime(store.activity[0].time)}`]) : '');
    if (!store.activity.length) {
      return mount(list, empty('No activity yet. `calm dev` records file changes, restarts and crashes; connect an agent with', { code: 'claude mcp add calm -- npx calm mcp' }));
    }
    const { list: events, readyIn } = fold(store.activity.filter(FILTERS[state.filter]));
    if (!events.length) return mount(list, empty('Nothing here for this filter.'));
    const newest = store.activity[0];
    const top = scroller.scrollTop;
    const height = scroller.scrollHeight;
    mount(list, events.map((e) => row(e, readyIn, e === newest)));
    if (state.follow) scroller.scrollTop = 0;
    else scroller.scrollTop = top + (scroller.scrollHeight - height);
  }

  scroller.addEventListener('scroll', () => {
    const atTop = scroller.scrollTop < 8;
    if (atTop !== state.follow) setFollow(atTop);
  });

  mount(root, h('div', { class: 'panel' }, bar('Activity', seg, h('span', { class: 'spacer' }), sessionEl, summary, followBtn), scroller));
  setFollow(state.follow);
  render();
  renderSession();
  markActivitySeen();

  const offs = [
    on('activity', (e) => {
      render();
      markActivitySeen();
      if (e?.type === 'agent' && e.tool === 'connect') loadOverview().catch(() => {});
    }),
    on('overview', renderSession),
    on('activity:reset', () => {
      render();
      markActivitySeen();
    }),
    // Status links depend on which requests are recorded.
    on('requests:reset', render),
  ];
  const timer = setInterval(() => store.activity.length && render(), 30_000);
  return {
    destroy: () => {
      offs.forEach((off) => off());
      clearInterval(timer);
    },
    refresh: render,
  };
}
