// Review: what changed since the last signature, for a person to read and sign. The behavior
// diff, the files AI agents wrote that nobody signed, what agents declared next to what they
// did, the last test run. Signing writes .calm/reviews/ (calm/review.js); commit it.

import { h, mount, api, bar, fileLink, loading, errorBox, plural, relTime, fullDate, toast, actorMark } from '../lib.js';
import { store, on, loadReview } from '../store.js';

export default {
  id: 'review',
  label: 'Review',
  badge: () => {
    const r = store.review;
    if (!r || !r.baseline) return null;
    const n = r.changes.length + r.unreviewed.length;
    if (!n) return null;
    return { text: n, tone: r.summary.widen || r.declared?.ok === false ? 'red' : 'amber', title: `${plural(r.changes.length, 'change')} and ${plural(r.unreviewed.length, 'agent file')} to review` };
  },
  mount: mountReview,
};

const MARK = { added: '+', removed: '-', changed: '~' };
const word = (c) => (c.kind === 'route' ? c.key : c.kind === 'field' ? c.key : `${c.kind} ${c.key}`);

function mountReview(root) {
  const body = h('div', { class: 'scroll rv' }, loading('Reading what changed'));
  const meta = h('span', { class: 'bar-meta' });
  const refresh = h('button', { class: 'btn ghost', type: 'button', onclick: () => load() }, 'Refresh');
  mount(root, h('div', { class: 'panel' }, bar('Review', meta, h('span', { class: 'spacer' }), refresh), body));
  const appRoot = store.overview?.app?.root ?? null;
  const link = (file) => (file ? fileLink(appRoot, file) : null);
  let signer = null;

  async function load() {
    try {
      const [state, who] = await Promise.all([loadReview(), signer ? Promise.resolve(signer) : api('/review/signer')]);
      signer = who;
      render(state);
    } catch (err) {
      mount(body, errorBox(err));
    }
  }

  function render(r) {
    mount(meta, r.baseline ? h('span', { title: fullDate(r.baseline.signedAt) }, `since ${r.baseline.signer?.name ?? 'the last signature'} signed ${relTime(r.baseline.signedAt)}${r.baseline.commit ? ` at ${r.baseline.commit}` : ''}`) : 'nothing signed yet');
    const sections = [];

    if (r.gitignore) sections.push(h('p', { class: 'rv-warn' }, '.gitignore hides .calm/reviews/. Signing changes the line so your reviews are committed.'));

    if (!r.baseline) {
      sections.push(h('section', { class: 'rv-card' }, h('h2', null, 'No signed baseline yet'), h('p', { class: 'muted' }, 'Signing accepts what the app does now. From then on this panel shows what changed: routes and who may call them, fields more people can read, env vars, hosts, events and invariants. CI can fail on wider access with npx calm review --ci.')));
    } else if (!r.changes.length) {
      sections.push(h('section', { class: 'rv-card' }, h('h2', null, 'Behavior'), h('p', { class: 'rv-ok' }, '✔ No behavior changes since the last signature.')));
    } else {
      sections.push(
        h(
          'section',
          { class: 'rv-card' },
          h('h2', null, `Behavior `, h('span', { class: 'muted' }, `${r.changes.length}`), r.summary.widen ? h('span', { class: 'rv-widen' }, `${r.summary.widen} widen access`) : null),
          h(
            'ul',
            { class: 'rv-list' },
            r.changes.map((c) =>
              h(
                'li',
                { class: ['rv-change', c.direction === 'looser' || c.direction === 'mixed' ? 'looser' : c.direction === 'tighter' ? 'tighter' : null] },
                h('span', { class: `rv-mark rv-${c.change}`, 'aria-label': c.change }, MARK[c.change]),
                h('span', { class: 'mono rv-what' }, word(c)),
                h('span', { class: 'rv-detail' }, c.detail),
                c.direction ? h('span', { class: 'rv-dir' }, c.direction === 'mixed' ? 'looser for some' : c.direction) : null,
                c.personal ? h('span', { class: 'rv-tag' }, 'personal data') : null,
                link(c.file),
              ),
            ),
          ),
        ),
      );
    }

    if (r.unreviewed.length) {
      sections.push(
        h(
          'section',
          { class: 'rv-card' },
          h('h2', null, 'Written by agents, not signed ', h('span', { class: 'muted' }, `${r.unreviewed.length}`)),
          h(
            'ul',
            { class: 'rv-list' },
            r.unreviewed.map((f) =>
              h('li', { class: 'rv-file' }, actorMark('agent', `${f.agent}${f.via ? ` (via ${f.via})` : ''}`), link(f.path), h('span', { class: 'rv-agent' }, f.agent), h('span', { class: 'muted', title: fullDate(f.at) }, relTime(f.at)), f.protected ? h('span', { class: 'rv-tag warn' }, f.reason ?? 'protected') : null),
            ),
          ),
        ),
      );
    }

    if (r.declared) {
      const d = r.declared;
      sections.push(
        h(
          'section',
          { class: 'rv-card' },
          h('h2', null, 'Declared by agents'),
          r.declarations.map((x) => h('p', null, actorMark('agent', x.client), ' ', h('b', null, x.client), ` ${x.intent} `, h('span', { class: 'muted' }, relTime(x.declaredAt)))),
          d.ok ? h('p', { class: 'rv-ok' }, '✔ What changed matches what was declared.') : null,
          h(
            'ul',
            { class: 'rv-list' },
            d.undeclared.map((x) => h('li', { class: 'rv-mismatch bad' }, h('b', null, 'Not declared'), h('span', { class: 'mono' }, word(x)), h('span', { class: 'muted' }, x.detail))),
            d.different.map((x) => h('li', { class: 'rv-mismatch bad' }, h('b', null, 'Different'), h('span', { class: 'mono' }, word(x)), h('span', null, `declared ${x.declared}, shipped ${x.shipped}`))),
            d.unmade.map((x) => h('li', { class: 'rv-mismatch' }, h('b', null, 'Declared, not made'), h('span', { class: 'mono' }, word(x)))),
          ),
        ),
      );
    }

    if (r.tests) {
      sections.push(h('section', { class: 'rv-card' }, h('h2', null, 'Tests'), h('p', { class: r.tests.ok ? 'rv-ok' : 'rv-bad' }, r.tests.ok ? `✔ ${r.tests.pass ?? '?'} passed` : `✖ ${r.tests.fail ?? '?'} failed`, h('span', { class: 'muted' }, ` · run by ${r.tests.by}, ${relTime(r.tests.at)}`))));
    }

    sections.push(r.needsSignature ? signForm(r) : h('section', { class: 'rv-card' }, h('p', { class: 'rv-ok' }, '✔ Everything is signed.')));
    mount(body, sections);
  }

  function signForm(r) {
    const name = h('input', { class: 'input', type: 'text', value: signer?.name ?? '', placeholder: 'Your name', 'aria-label': 'Your name', maxlength: 100 });
    const email = h('input', { class: 'input', type: 'email', value: signer?.email ?? '', placeholder: 'you@example.com', 'aria-label': 'Your email', maxlength: 200 });
    const note = h('textarea', { class: 'input', rows: 2, placeholder: 'Note (optional): why these changes are fine', 'aria-label': 'Note' });
    const what = r.baseline ? `${plural(r.changes.length, 'change')}${r.summary.widen ? `, ${r.summary.widen} widening access,` : ''} and ${plural(r.unreviewed.length, 'agent file')}` : 'the current behavior as the baseline';
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign');
    return h(
      'form',
      {
        class: 'rv-card rv-sign',
        onsubmit: async (e) => {
          e.preventDefault();
          if (!name.value.trim()) return toast('Who is signing? Give your name.', { tone: 'error' });
          btn.disabled = true;
          try {
            const out = await api('/review/sign', { method: 'POST', body: { name: name.value.trim(), email: email.value.trim() || null, note: note.value } });
            signer = { name: name.value.trim(), email: email.value.trim() || null };
            toast(`Signed ${out.review.id}. Commit .calm/reviews/ with your change.${out.gitignore ? ' .gitignore was updated so it can be.' : ''}`, { timeout: 8000 });
            load();
          } catch (err) {
            toast(err.message, { tone: 'error' });
            btn.disabled = false;
          }
        },
      },
      h('h2', null, 'Sign'),
      h('p', { class: 'muted' }, `You accept ${what}. This writes .calm/reviews/ (commit it), and the next review starts from here.`),
      h('div', { class: 'rv-fields' }, name, email),
      note,
      h('div', { class: 'np-actions' }, btn),
    );
  }

  const offs = [on('review', () => store.review && render(store.review))];
  load();
  return { destroy: () => offs.forEach((off) => off()) };
}
