// Checkpoints: snapshots of the dev database (calm/checkpoints.js). A toolbar button for the
// Data panel opens a popover to take one and to restore or delete the ones you have; the
// Activity panel uses restoreCheckpoint() for its "Restore" buttons.

import { h, icon, mount, api, popover, closePopover, relTime, fullDate, plural, actorMark, toast } from '../lib.js';

const docs = (meta) => meta.collections.reduce((n, c) => n + c.docs, 0);

/** Restore after a confirmation sentence that says what will be replaced. Resolves to the result or null. */
export async function restoreCheckpoint(id, name) {
  if (!window.confirm(`Replace the data in every collection with checkpoint "${name}"? Collections created since are dropped. Take a checkpoint first if you want to keep the current data.`)) return null;
  try {
    const out = await api(`/checkpoints/${encodeURIComponent(id)}/restore`, { method: 'POST', body: {} });
    toast(`Restored "${out.name}": ${plural(out.collections.length, 'collection')}, ${plural(out.collections.reduce((n, c) => n + c.docs, 0), 'document')}${out.dropped.length ? `, dropped ${out.dropped.join(', ')}` : ''}`);
    return out;
  } catch (err) {
    toast(err.message, { tone: 'error' });
    return null;
  }
}

/**
 * The "Checkpoints" toolbar button. onRestored() runs after a restore, so the panel can reload.
 */
export function checkpointButton({ onRestored } = {}) {
  const btn = h('button', { class: 'btn ghost', type: 'button', 'aria-haspopup': 'dialog', title: 'Snapshot the dev database, or put it back as it was' }, icon('bookmark', 13), 'Checkpoints');
  btn.addEventListener('click', () => open());

  function open() {
    const name = h('input', { class: 'input', type: 'text', placeholder: 'manual', 'aria-label': 'Checkpoint name', maxlength: 80, spellcheck: false });
    const take = h('button', { class: 'btn primary', type: 'submit' }, 'Take checkpoint');
    const list = h('div', { class: 'cp-list', role: 'list' }, h('div', { class: 'cp-empty' }, 'Loading checkpoints'));
    const form = h(
      'form',
      {
        class: 'np-actions',
        onsubmit: async (e) => {
          e.preventDefault();
          take.disabled = true;
          try {
            const meta = await api('/checkpoints', { method: 'POST', body: { name: name.value.trim() || 'manual' } });
            toast(`Checkpoint "${meta.name}": ${plural(meta.collections.length, 'collection')}, ${plural(docs(meta), 'document')}`);
            name.value = '';
            refresh();
          } catch (err) {
            toast(err.message, { tone: 'error' });
          } finally {
            take.disabled = false;
          }
        },
      },
      name,
      take,
    );

    async function refresh() {
      try {
        const items = await api('/checkpoints');
        if (!items.length) return mount(list, h('div', { class: 'cp-empty' }, 'No checkpoints yet. One is taken automatically when an agent connects over MCP.'));
        mount(list, items.map(row));
      } catch (err) {
        mount(list, h('div', { class: 'cp-empty' }, err.message));
      }
    }

    function row(meta) {
      const el = h('div', { class: 'cp-row', role: 'listitem' });
      const restore = h('button', { class: 'icon-btn', type: 'button', title: 'Restore this checkpoint', 'aria-label': `Restore ${meta.name}`, onclick: () => confirmRow('restore') }, icon('undo', 13));
      const del = h('button', { class: 'icon-btn', type: 'button', title: 'Delete this checkpoint', 'aria-label': `Delete ${meta.name}`, onclick: () => confirmRow('delete') }, icon('x', 13));
      const paint = (extra = null) =>
        mount(
          el,
          actorMark(meta.actor?.kind === 'agent' ? 'agent' : 'human', meta.actor?.kind === 'agent' ? `Taken by ${meta.actor.name}` : 'Taken by you'),
          h(
            'div',
            { class: 'cp-main' },
            h('span', { class: 'cp-name' }, meta.name, meta.auto ? h('span', { class: 'muted' }, ' (auto)') : null),
            h('span', { class: 'cp-meta', title: fullDate(meta.createdAt) }, `${relTime(meta.createdAt)} · ${plural(meta.collections.length, 'collection')} · ${plural(docs(meta), 'document')}`),
          ),
          h('div', { class: 'cp-actions' }, restore, del),
          extra,
        );
      function confirmRow(kind) {
        const yes = h('button', { class: kind === 'delete' ? 'btn danger' : 'btn primary', type: 'button' }, kind === 'delete' ? 'Delete' : 'Restore');
        const no = h('button', { class: 'btn ghost', type: 'button', onclick: () => paint() }, 'Cancel');
        yes.addEventListener('click', async () => {
          yes.disabled = true;
          try {
            if (kind === 'delete') {
              await api(`/checkpoints/${encodeURIComponent(meta.id)}`, { method: 'DELETE' });
              toast(`Deleted checkpoint "${meta.name}"`);
            } else {
              const out = await api(`/checkpoints/${encodeURIComponent(meta.id)}/restore`, { method: 'POST', body: {} });
              toast(`Restored "${out.name}"${out.dropped.length ? `, dropped ${out.dropped.join(', ')}` : ''}`);
              closePopover();
              onRestored?.(out);
              return;
            }
            refresh();
          } catch (err) {
            toast(err.message, { tone: 'error' });
            yes.disabled = false;
          }
        });
        paint(
          h(
            'div',
            { class: 'cp-confirm' },
            kind === 'delete'
              ? h('span', null, 'Delete ', h('b', null, meta.name), ' from .calm/checkpoints? The data in the database is not touched.')
              : h('span', null, 'Replace the data in every collection with ', h('b', null, meta.name), ` (${plural(docs(meta), 'document')})? Collections created since are dropped.`),
            h('div', { class: 'np-actions' }, yes, no),
          ),
        );
      }
      paint();
      return el;
    }

    popover(btn, h('div', { class: 'cp-pop' }, form, list), { align: 'end', width: 380 });
    refresh();
    name.focus();
  }

  return btn;
}
