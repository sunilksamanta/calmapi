// Blocks: what each installed block adds to the app. Where it came from, the files you
// changed since, the extension points it uses, its env vars (set or missing, secret values
// never leave the server), its options and its routes.

import { h, mount, fileLink, empty, bar, plural, joined, methodTag, policyText, jsonViewer, richText } from '../lib.js';
import { store } from '../store.js';

const DOCS = 'https://docs.calmapi.dev/blocks';

const USE_LABEL = {
  guard: 'Guard',
  authenticator: 'Authenticator',
  'login challenge': 'Login challenge',
  middleware: 'Middleware',
  policy: 'Policy',
  provide: 'Provides',
  event: 'Listens to',
  'resource hook': 'Resource hook',
  'service hook': 'Service hook',
  'mail transport': 'Mail transport',
  'push transport': 'Push transport',
  'doctor check': 'Doctor check',
  'devtools panel': 'Panel',
};
const USE_HINT = {
  guard: 'Runs before every route and can stop the request',
  authenticator: 'Accepts its own credentials in Authorization: Bearer',
  'login challenge': 'Takes part in sign-in (a second factor, for example)',
  middleware: 'Sees every request',
  policy: 'A named policy you can use in resources and routes',
  provide: 'Adds a helper on app.ext',
  event: 'Reacts to app events',
  'mail transport': 'Sends the app\'s mail',
  'push transport': 'Delivers push notifications to devices',
};

const missingEnv = (b) => b.env.filter((v) => !v.set && v.required);

export default {
  id: 'blocks',
  label: 'Blocks',
  badge: () => {
    const blocks = store.overview?.blocks ?? [];
    const missing = blocks.filter((b) => missingEnv(b).length).length;
    if (missing) return { text: missing, tone: 'amber', title: `${plural(missing, 'block')} missing env vars` };
    return { text: blocks.length || '' };
  },
  mount: mountBlocks,
};

function mountBlocks(root, params) {
  const body = h('div', { class: 'scroll res-scroll' });
  const jump = h('nav', { class: 'bar-links', 'aria-label': 'Jump to block' });

  function render() {
    const ov = store.overview;
    const blocks = ov.blocks ?? [];
    mount(jump, blocks.map((b) => h('a', { href: `#/blocks/${b.name}` }, b.name)), h('a', { href: DOCS, target: '_blank', rel: 'noopener' }, 'Find more ↗'));
    if (!blocks.length) return mount(body, empty('No blocks yet. Blocks add features as plain files you own, for example:', { code: 'npx calm add notifications' }));
    mount(body, blocks.map((b) => blockSection(b, ov)));
  }

  function focus(name) {
    if (!name) return;
    const sec = body.querySelector(`#blk-${CSS.escape(name)}`);
    if (!sec) return;
    sec.scrollIntoView({ block: 'start' });
    for (const x of body.querySelectorAll('.res.target')) x.classList.remove('target');
    sec.classList.add('target');
  }

  mount(root, h('div', { class: 'panel' }, bar('Blocks', jump), body));
  render();
  requestAnimationFrame(() => focus(params[0]));
  return { update: (p) => focus(p[0]), refresh: render };
}

function origin(b) {
  if (!b.installed) return h('span', { class: 'muted', title: 'Not in calm.lock: written in this project (calm make block) or registered in calm.config.js' }, 'your own block');
  const official = String(b.installed.key).startsWith('@calmapi/');
  return h(
    'span',
    null,
    h('span', { class: 'mono' }, `v${b.installed.version ?? '0.0.0'}`),
    h('span', { class: 'muted' }, official ? ' · official' : ' · from '),
    official ? null : h('span', { class: 'mono', title: b.installed.source ?? '' }, b.installed.key),
  );
}

function blockSection(b, ov) {
  const missing = missingEnv(b);
  const head = h(
    'header',
    { class: 'res-head' },
    h('h2', { class: 'res-name' }, b.name),
    h('span', { class: 'res-facts' }, joined([
      origin(b),
      b.routes.length ? h('span', null, plural(b.routes.length, 'route')) : null,
      missing.length ? h('span', { class: 't-amber' }, `${plural(missing.length, 'env var')} missing`) : null,
      b.changed.length ? h('span', { class: 'b-changed', title: b.changed.join('\n') }, `${plural(b.changed.length, 'file')} changed by you`) : null,
    ])),
    h('span', { class: 'spacer' }),
    b.installed && String(b.installed.key).startsWith('@calmapi/') ? h('a', { class: 'btn ghost', href: `${DOCS}/${b.name}`, target: '_blank', rel: 'noopener', title: 'This block on docs.calmapi.dev' }, 'Docs ↗') : null,
    b.file ? fileLink(ov.app.root, b.file) : null,
    ...b.panels.map((p) => h('a', { class: 'btn ghost', href: `#/panel:${p}` }, `Open ${p}`)),
  );

  // Left: what it needs and what it adds. Right: how it is configured and what you changed.
  const main = [];
  if (b.env.length) main.push(sect('Environment', envTable(b.env), 'Values of secrets are never shown here'));
  if (b.uses.length) main.push(sect('Hooks into', usesList(b.uses)));
  if (b.routes.length) main.push(sect('Routes', routesTable(b.routes)));
  const side = [];
  if (b.guide?.links?.length) side.push(sect('Official documentation', linkList(b.guide.links), 'Read these before changing the block'));
  if (b.guide?.agents) side.push(sect('For AI agents', agentNotes(b.guide.agents, ov.app.root, b.guide.file), 'Agents read the same notes in AGENTS.md'));
  if (Object.keys(b.options).length) side.push(sect('Options', jsonViewer(b.options, { open: 1 }), `Change them in calm.config.js: blocks: { '${b.name}': { ... } }`));
  if (b.changed.length) side.push(sect('Changed since install', h('ul', { class: 'blk-files' }, b.changed.map((f) => h('li', null, fileLink(ov.app.root, f)))), 'Your edits are yours: the block is plain code in your project'));

  const columns = [main, side].filter((c) => c.length).map((c) => h('div', { class: 'blk-col' }, c));
  return h('section', { class: 'res blk', id: `blk-${b.name}` }, head, columns.length ? h('div', { class: ['blk-grid', columns.length === 1 && 'one'] }, columns) : h('p', { class: 'muted' }, 'Nothing to configure.'));
}

function linkList(links) {
  return h('ul', { class: 'blk-links' }, links.map((l) => h('li', null, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer', title: l.url }, l.title, h('span', { class: 'muted' }, ' ↗')), h('span', { class: 'blk-host muted' }, hostOf(l.url)))));
}

const hostOf = (url) => {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** The "For AI agents" notes: markdown lists and paragraphs, `code` and **bold**, collapsed after a few lines. */
function agentNotes(text, root, file) {
  const inline = (line) => line.split(/(\*\*[^*]+\*\*)/g).map((part) => (/^\*\*[^*]+\*\*$/.test(part) ? h('strong', null, richText(part.slice(2, -2))) : richText(part)));
  const blocks = [];
  let list = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const item = /^(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (item) {
      if (!list) blocks.push((list = h('ul', null)));
      list.append(h('li', null, inline(item[1])));
    } else {
      list = null;
      if (line) blocks.push(h('p', null, inline(line.replace(/^#+\s*/, ''))));
    }
  }
  const body = h('div', { class: 'blk-agents' }, blocks);
  const long = text.split('\n').length > 6;
  return h(
    'div',
    null,
    long ? h('details', { class: 'blk-agents-more' }, h('summary', null, `${plural(text.split('\n').filter((l) => l.trim()).length, 'line')}: show`), body) : body,
    file ? h('div', { class: 'blk-agents-file' }, fileLink(root, file)) : null,
  );
}

const sect = (title, content, note) => h('section', { class: 'sect' }, h('h3', { class: 'sect-title' }, title, note ? h('span', { class: 'sect-note' }, note) : null), content);

function envTable(env) {
  return h('ul', { class: 'blk-env' }, env.map((v) => {
    const [tone, label] = v.set ? ['green', 'set'] : v.required ? ['red', 'missing'] : v.requiredIn === 'production' ? ['amber', 'needed in production'] : ['blue', 'not set'];
    return h(
      'li',
      null,
      h(
        'div',
        { class: 'blk-env-line' },
        h('span', { class: 'mono strong' }, v.key),
        h('span', { class: tone === 'red' ? 't-red' : tone === 'amber' ? 't-amber' : 'muted' }, h('span', { class: `dot dot-${tone}`, 'aria-hidden': 'true' }), ` ${label}`),
        v.set ? h('span', { class: 'mono muted' }, v.secret ? 'secret' : v.value) : null,
      ),
      v.description ? h('div', { class: 'muted' }, v.description) : null,
    );
  }));
}

function usesList(uses) {
  return h('div', { class: 'blk-uses' }, uses.map((u) => {
    const label = USE_LABEL[u.kind] ?? u.kind;
    return h('span', { class: 'badge', title: USE_HINT[u.kind] ?? null }, u.name ? [label, ' ', h('span', { class: 'mono' }, u.name)] : label);
  }));
}

function routesTable(routes) {
  return h(
    'div',
    { class: 'tbl-wrap' },
    h(
      'table',
    { class: 'tbl' },
      h('tbody', null, routes.map((r) => h('tr', null, h('td', { class: 'blk-method' }, methodTag(r.method)), h('td', null, h('a', { class: 'mono', href: '#/routes' }, r.path)), h('td', null, policyText(r.policy))))),
    ),
  );
}
