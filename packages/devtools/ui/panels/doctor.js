// Doctor: runtime checks against config, resources and routes, as a linter style list.

import { h, mount, richText, fileLink, bar, plural, empty, joined, toast } from '../lib.js';
import { store, on, loadDoctor } from '../store.js';

const LEVELS = [
  { id: 'error', one: 'error', tone: 'red' },
  { id: 'warn', one: 'warning', tone: 'amber' },
  { id: 'info', one: 'note', tone: 'blue' },
];

export default {
  id: 'doctor',
  label: 'Doctor',
  badge: () => {
    const f = store.doctor ?? [];
    const errors = f.filter((x) => x.level === 'error').length;
    const warns = f.filter((x) => x.level === 'warn').length;
    if (errors) return { text: errors, tone: 'red', title: plural(errors, 'error') };
    if (warns) return { text: warns, tone: 'amber', title: plural(warns, 'warning') };
    return null;
  },
  mount: mountDoctor,
};

function mountDoctor(root) {
  const body = h('div', { class: 'scroll' });
  const counts = h('span', { class: 'bar-meta' });
  const rerun = h('button', { class: 'btn ghost', type: 'button', onclick: run }, 'Run again');

  async function run() {
    rerun.disabled = true;
    try {
      await loadDoctor();
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      rerun.disabled = false;
    }
  }

  function render() {
    const findings = store.doctor ?? [];
    const ov = store.overview;
    mount(counts, findings.length ? joined(LEVELS.map((l) => {
      const n = findings.filter((f) => f.level === l.id).length;
      return n ? h('span', { class: `t-${l.tone}` }, plural(n, l.one)) : null;
    })) : `${plural(ov.resources.length, 'resource')}, ${plural(ov.routes.length, 'route')} checked`);
    if (!findings.length) return mount(body, empty('No issues. For static checks on your source files run', { code: 'npx calm doctor' }));
    const order = Object.fromEntries(LEVELS.map((l, i) => [l.id, i]));
    const sorted = [...findings].sort((a, b) => (order[a.level] ?? 9) - (order[b.level] ?? 9));
    mount(
      body,
      h(
        'ul',
        { class: 'issues' },
        sorted.map((f) => {
          const l = LEVELS.find((x) => x.id === f.level) ?? LEVELS[2];
          return h(
            'li',
            { class: 'issue' },
            h('span', { class: `dot dot-${l.tone}`, title: l.one, 'aria-label': l.one }),
            h('div', { class: 'issue-text' }, h('div', { class: 'issue-title' }, richText(f.title)), f.detail ? h('div', { class: 'issue-detail' }, richText(f.detail)) : null),
            h('div', { class: 'issue-meta' }, f.file ? fileLink(ov.app.root, f.file) : null, h('span', { class: 'mono muted' }, f.id)),
          );
        }),
      ),
    );
  }

  mount(root, h('div', { class: 'panel' }, bar('Doctor', counts, h('span', { class: 'spacer' }), rerun), body));
  render();
  const off = on('doctor', render);
  return { destroy: off, refresh: () => loadDoctor() };
}
