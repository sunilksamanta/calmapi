// Doctor: runtime checks against config, resources and routes, grouped by level.

import { h, icon, mount, richText, fileLink, panelHead, copy, toast } from '../lib.js';
import { store, on, loadDoctor } from '../store.js';

const LEVELS = [
  { id: 'error', label: 'Errors', one: 'error', icon: 'alertCircle', tone: 'red' },
  { id: 'warn', label: 'Warnings', one: 'warning', icon: 'alert', tone: 'amber' },
  { id: 'info', label: 'Info', one: 'note', icon: 'info', tone: 'blue' },
];

export default {
  id: 'doctor',
  label: 'Doctor',
  icon: 'doctor',
  badge: () => {
    const f = store.doctor ?? [];
    const errors = f.filter((x) => x.level === 'error').length;
    const warns = f.filter((x) => x.level === 'warn').length;
    if (errors) return { text: errors, tone: 'red' };
    if (warns) return { text: warns, tone: 'amber' };
    return store.doctor ? { text: '✓', tone: 'green' } : null;
  },
  mount: mountDoctor,
};

function mountDoctor(root) {
  const body = h('div', { class: 'panel-body doctor-body' });
  const rerun = h('button', { class: 'btn', onclick: run }, icon('refresh', 14), 'Run again');

  async function run() {
    rerun.disabled = true;
    try {
      await loadDoctor();
      toast('Checks finished', { tone: 'ok', timeout: 1800 });
    } catch (err) {
      toast(err.message, { tone: 'error' });
    } finally {
      rerun.disabled = false;
    }
  }

  function render() {
    const findings = store.doctor ?? [];
    const ov = store.overview;
    if (!findings.length) {
      return mount(
        body,
        h(
          'div',
          { class: 'all-clear' },
          h('div', { class: 'all-clear-mark' }, icon('checkCircle', 40)),
          h('h2', null, 'All clear'),
          h('p', null, `No issues in the config, ${ov.resources.length} resources or ${ov.routes.length} routes.`),
          h('div', { class: 'empty-code' }, h('code', null, 'npx calm doctor'), h('button', { class: 'icon-btn ghost xs', 'aria-label': 'Copy command', onclick: () => copy('npx calm doctor') }, icon('copy', 13))),
          h('p', { class: 'muted small' }, 'Run it in your terminal to add static checks on your source files.'),
        ),
      );
    }
    mount(
      body,
      h(
        'div',
        { class: 'doc-tiles' },
        LEVELS.map((l) => {
          const n = findings.filter((f) => f.level === l.id).length;
          return h('a', { class: ['doc-tile', `t-${l.tone}`, !n && 'zero'], href: n ? `#/doctor` : null, onclick: (e) => { e.preventDefault(); body.querySelector(`#doc-${l.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, icon(l.icon, 18), h('span', { class: 'doc-tile-n num' }, n), h('span', { class: 'doc-tile-label' }, l.label));
        }),
      ),
      LEVELS.map((l) => {
        const items = findings.filter((f) => f.level === l.id);
        if (!items.length) return null;
        return h(
          'section',
          { class: 'doc-group', id: `doc-${l.id}` },
          h('h2', { class: 'doc-group-title' }, h('span', { class: `dot dot-${l.tone}` }), l.label, h('span', { class: 'muted num' }, items.length)),
          items.map((f) =>
            h(
              'article',
              { class: ['doc-item', `t-${l.tone}`] },
              h('span', { class: 'doc-icon' }, icon(l.icon, 16)),
              h(
                'div',
                { class: 'doc-text' },
                h('div', { class: 'doc-title' }, richText(f.title)),
                f.detail ? h('div', { class: 'doc-detail' }, richText(f.detail)) : null,
                h('div', { class: 'doc-foot' }, f.file ? fileLink(ov.app.root, f.file) : null, h('span', { class: 'doc-id mono' }, f.id)),
              ),
            ),
          ),
        );
      }),
    );
  }

  mount(root, h('div', { class: 'panel' }, panelHead({ title: 'Doctor', sub: 'Live checks against your config, resources and routes.', actions: [rerun] }), body));
  render();
  const off = on('doctor', render);
  return { destroy: off, refresh: () => loadDoctor() };
}
