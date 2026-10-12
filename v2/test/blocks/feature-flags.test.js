import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// Routes and a resource that use flags the ways the docs show.
const files = {
  'app/routes.js': `import { requireFlag } from '#app/blocks/feature-flags/index.js';

export default (r) => {
  r.get('/flag-check/:key', { policy: 'public' }, (ctx) => ({ enabled: ctx.flags.enabled(ctx.params.key), variant: ctx.flags.variant(ctx.params.key) }));
  r.get('/beta/members', { policy: [requireFlag('beta'), 'authenticated'] }, () => ({ ok: true }));
  r.get('/beta/open', { policy: requireFlag('beta') }, () => ({ ok: true }));
};
`,
  'app/resources/note/note.resource.js': `import { resource, f } from '#calm';
import { requireFlag } from '#app/blocks/feature-flags/index.js';

const notes = requireFlag('notes');
export default resource('note', {
  fields: { text: f.string().required(), author: f.ref('user').owner() },
  policy: { list: [notes, 'owner'], read: [notes, 'owner'], create: [notes, 'authenticated'], update: [notes, 'owner'], delete: [notes, 'owner'] },
});
`,
};

let project;
let t;
let admin;
let alice;
let bob;
const changes = [];

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'feature-flags', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  // A long cache TTL, so the cache tests can tell cached answers from fresh ones.
  t = await project.testApp({ blocks: { 'feature-flags': { cacheTtlMs: 60_000, flags: { 'new-checkout': { description: 'The new checkout', rollout: 0 } } } } });
  t.app.events.on('flag.changed', (payload) => changes.push(payload));
  admin = await t.signup({ name: 'Admin', roles: ['user', 'admin'] });
  alice = await t.signup({ name: 'Alice' });
  bob = await t.signup({ name: 'Bob' });
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const flags = () => t.app.ext.flags;
const ids = Array.from({ length: 1000 }, (_, i) => `fake-user-${i}`);
const check = async (key, auth) => (await t.get(`/flag-check/${key}`, auth)).body.data;
const asVisitor = async (path, anonymousId) => {
  const res = await fetch(`${t.origin}/api${path}`, { headers: anonymousId ? { 'x-anonymous-id': anonymousId } : {} });
  return { status: res.status, body: await res.json() };
};
async function createFlag(body) {
  const res = await t.post('/admin/flags', body, admin);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

test('rollout: deterministic per id, close to the percentage, nobody loses the flag as it grows', async () => {
  await createFlag({ key: 'gradual', rollout: 30 });
  const enabledIds = async () => {
    const on = new Set();
    for (const id of ids) if (await flags().isEnabled('gradual', { userId: id })) on.add(id);
    return on;
  };
  const at30 = await enabledIds();
  assert.ok(at30.size > 250 && at30.size < 350, `${at30.size} of 1000 at 30%`);
  assert.deepEqual(await enabledIds(), at30, 'same ids, same answers');

  await t.patch('/admin/flags/gradual', { rollout: 60 }, admin);
  const at60 = await enabledIds();
  assert.ok(at60.size > 550 && at60.size < 650, `${at60.size} of 1000 at 60%`);
  for (const id of at30) assert.ok(at60.has(id), `${id} kept the flag`);

  // ctx.flags gives signed-in users the same answer as the evaluation API.
  assert.equal((await check('gradual', alice)).enabled, await flags().isEnabled('gradual', { userId: alice.id }));

  // Visitors: off without an id below 100%, bucketed by X-Anonymous-Id otherwise.
  assert.equal((await asVisitor('/flag-check/gradual')).body.data.enabled, false);
  const visitors = await Promise.all(ids.slice(0, 200).map((id) => asVisitor('/flag-check/gradual', id)));
  for (const [i, v] of visitors.entries()) assert.equal(v.body.data.enabled, await flags().isEnabled('gradual', { anonymousId: ids[i] }));
  await t.patch('/admin/flags/gradual', { rollout: 100 }, admin);
  assert.equal((await asVisitor('/flag-check/gradual')).body.data.enabled, true, 'at 100% everyone, ids or not');
});

test('targeting: listed users and roles get the flag at 0%, enabled: false turns it off for all', async () => {
  await createFlag({ key: 'targeted', rollout: 0, users: [alice.id], roles: ['admin'] });
  assert.equal((await check('targeted', alice)).enabled, true);
  assert.equal((await check('targeted', bob)).enabled, false);
  assert.equal((await check('targeted', admin)).enabled, true, 'by role');
  assert.equal((await check('targeted')).enabled, false);
  const viaApi = await flags().evaluate({ user: { _id: bob.id, roles: ['user', 'admin'] } });
  assert.equal(viaApi.enabled('targeted'), true, 'evaluate() reads roles from the user document');

  await t.patch('/admin/flags/targeted', { enabled: false }, admin);
  assert.equal((await check('targeted', alice)).enabled, false, 'kill switch');
  assert.equal((await check('targeted', admin)).enabled, false);
  assert.equal((await check('does-not-exist', alice)).enabled, false, 'unknown flags are off');
});

test('variants: weighted, deterministic, and kept when the rollout changes', async () => {
  await createFlag({ key: 'pricing', rollout: 100, variants: { control: 25, annual: 75 } });
  const pick = () => Promise.all(ids.map((id) => flags().variant('pricing', { userId: id })));
  const first = await pick();
  assert.deepEqual(await pick(), first, 'same ids, same variants');
  const control = first.filter((v) => v === 'control').length;
  assert.ok(control > 200 && control < 300, `${control} of 1000 in control (25%)`);
  assert.equal(first.filter((v) => v === 'annual').length, 1000 - control);

  await t.patch('/admin/flags/pricing', { rollout: 50 }, admin);
  const partial = await pick();
  partial.forEach((v, i) => assert.ok(v === null || v === first[i], 'a user in the rollout keeps their variant'));
  const off = partial.filter((v) => v === null).length;
  assert.ok(off > 400 && off < 600, `${off} of 1000 outside a 50% rollout`);

  assert.equal((await check('pricing', alice)).variant, await flags().variant('pricing', { userId: alice.id }));
  for (const variants of [{ a: -1 }, { 'a.b': 1 }, { a: 1.5 }, { a: 0 }, ['a']]) {
    assert.equal((await t.patch('/admin/flags/pricing', { variants }, admin)).status, 422, JSON.stringify(variants));
  }
});

test('admin API: CRUD for admins only, validation, flag.changed events', async () => {
  assert.equal((await t.get('/admin/flags')).status, 401);
  assert.equal((await t.get('/admin/flags', alice)).status, 403);
  assert.equal((await t.post('/admin/flags', { key: 'nope' }, alice)).status, 403);

  const created = await t.post('/admin/flags', { key: 'crud-test', description: 'For the test' }, admin);
  assert.equal(created.status, 201);
  const { key, description, enabled, rollout, users, roles, variants, clientVisible, updatedBy } = created.body.data;
  assert.deepEqual({ key, description, enabled, rollout, users, roles, variants, clientVisible, updatedBy }, {
    key: 'crud-test',
    description: 'For the test',
    enabled: true,
    rollout: 0,
    users: [],
    roles: [],
    variants: null,
    clientVisible: false,
    updatedBy: admin.id,
  });
  assert.equal((await t.post('/admin/flags', { key: 'crud-test' }, admin)).status, 409);
  for (const bad of [{ key: 'has space' }, { key: '-dash-first' }, { key: 'x', rollout: 101 }, { key: 'x', rollout: 1.5 }, { key: 'x', unknown: 1 }, {}]) {
    assert.equal((await t.post('/admin/flags', bad, admin)).status, 422, JSON.stringify(bad));
  }

  const list = await t.get('/admin/flags', admin);
  assert.ok(list.body.data.some((flag) => flag.key === 'crud-test'));
  assert.equal((await t.get('/admin/flags/crud-test', admin)).body.data.description, 'For the test');

  const patched = await t.patch('/admin/flags/crud-test', { rollout: 25, description: null, roles: ['admin'] }, admin);
  assert.equal(patched.status, 200);
  assert.equal(patched.body.data.rollout, 25);
  assert.equal(patched.body.data.description, '', 'null resets a field');
  assert.deepEqual(patched.body.data.roles, ['admin']);
  assert.equal((await t.patch('/admin/flags/crud-test', { key: 'renamed' }, admin)).status, 422, 'keys cannot change');
  assert.equal((await t.patch('/admin/flags/missing', { rollout: 1 }, admin)).status, 404);

  assert.equal((await t.delete('/admin/flags/crud-test', admin)).status, 204);
  assert.equal((await t.get('/admin/flags/crud-test', admin)).status, 404);
  assert.equal((await t.delete('/admin/flags/crud-test', admin)).status, 404);

  await t.idle();
  const mine = changes.filter((c) => c.key === 'crud-test');
  assert.deepEqual(mine.map((c) => c.action), ['created', 'updated', 'deleted']);
  assert.ok(mine.every((c) => c.user?.id === admin.id));
  assert.equal(mine[1].previous.rollout, 0);
  assert.equal(mine[1].flag.rollout, 25);
  assert.equal(mine[2].flag, null);
});

test('GET /api/flags: clientVisible flags only, evaluated for the caller', async () => {
  await createFlag({ key: 'client-on', rollout: 100, clientVisible: true, variants: { only: 1 } });
  await createFlag({ key: 'client-alice', rollout: 0, users: [alice.id], clientVisible: true });
  await createFlag({ key: 'server-only', rollout: 100 });

  const res = await t.get('/flags', alice);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control'), /no-store/);
  assert.deepEqual(res.body.data['client-on'], { enabled: true, variant: 'only' });
  assert.deepEqual(res.body.data['client-alice'], { enabled: true, variant: null });
  assert.equal('server-only' in res.body.data, false);
  assert.equal('new-checkout' in res.body.data, false);

  assert.deepEqual((await t.get('/flags', bob)).body.data['client-alice'], { enabled: false, variant: null });
  const visitor = await asVisitor('/flags', 'visitor-42');
  assert.equal(visitor.status, 200);
  assert.deepEqual(visitor.body.data['client-on'], { enabled: true, variant: 'only' });
  assert.deepEqual(visitor.body.data['client-alice'], { enabled: false, variant: null });
});

test('cache: changes through the block apply at once, direct database writes after the TTL', async () => {
  await createFlag({ key: 'cached', rollout: 0 });
  assert.equal((await check('cached', bob)).enabled, false);
  await flags().model.updateOne({ key: 'cached' }, { $set: { rollout: 100 } });
  assert.equal((await check('cached', bob)).enabled, false, 'still the cached value');
  await t.patch('/admin/flags/cached', { description: 'touched' }, admin);
  assert.equal((await check('cached', bob)).enabled, true, 'a change through the admin API invalidates the cache');

  await flags().model.updateOne({ key: 'cached' }, { $set: { rollout: 0 } });
  assert.equal((await check('cached', bob)).enabled, true);
  flags().invalidate();
  assert.equal((await check('cached', bob)).enabled, false, 'invalidate() for writes made elsewhere');
});

test('declared flags are created on start, once, and never overwrite admin changes', async () => {
  const declared = (await t.get('/admin/flags/new-checkout', admin)).body.data;
  assert.equal(declared.description, 'The new checkout');
  assert.equal(declared.rollout, 0);
  assert.equal(declared.enabled, true);

  await t.patch('/admin/flags/new-checkout', { rollout: 40, description: 'Edited by an admin' }, admin);
  const edited = (await t.get('/admin/flags/new-checkout', admin)).body.data;
  await t.app.stop();
  await t.app.start(); // runs the declared flags again
  assert.deepEqual((await t.get('/admin/flags/new-checkout', admin)).body.data, edited);
  assert.deepEqual(await flags().ensureDefaults(), []);
  assert.equal(await flags().model.countDocuments({ key: 'new-checkout' }), 1);

  await t.delete('/admin/flags/new-checkout', admin);
  assert.deepEqual(await flags().ensureDefaults(), ['new-checkout'], 'a deleted declared flag comes back, off');
  assert.equal((await t.get('/admin/flags/new-checkout', admin)).body.data.rollout, 0);

  await assert.rejects(
    project.testApp({ blocks: { 'feature-flags': { flags: { 'typo-flag': { rolout: 10 } } } } }),
    /flags\['typo-flag'\] is invalid \(rolout: Unknown field\)/,
    'invalid declarations stop the boot',
  );
});

test('requireFlag: 404 while the flag is off for the caller, the rest of the policy still applies', async () => {
  assert.equal((await t.get('/beta/members', alice)).status, 404, 'no flag yet: off');
  await createFlag({ key: 'beta', rollout: 0, users: [alice.id] });
  assert.equal((await t.get('/beta/members', alice)).status, 200);
  assert.equal((await t.get('/beta/members', bob)).status, 404);
  assert.equal((await t.get('/beta/members')).status, 404);
  assert.equal((await t.get('/beta/open', alice)).status, 200);
  assert.equal((await t.get('/beta/open')).status, 404);

  await t.patch('/admin/flags/beta', { rollout: 100 }, admin);
  assert.equal((await t.get('/beta/members', bob)).status, 200);
  assert.equal((await t.get('/beta/members')).status, 401, 'on for everyone, and the route still needs a signed-in user');
  assert.equal((await t.get('/beta/open')).status, 200, 'a policy made only of gates lets in whoever has the flag');
  assert.equal(t.app.routes.find((r) => r.path === '/beta/members').policyLabel, 'flag:beta | authenticated');
});

test('requireFlag in resource policies keeps owner scoping', async () => {
  assert.equal((await t.post('/notes', { text: 'too early' }, alice)).status, 404);
  await createFlag({ key: 'notes', rollout: 100 });
  const mine = await t.post('/notes', { text: 'alice note' }, alice);
  assert.equal(mine.status, 201, JSON.stringify(mine.body));
  assert.equal((await t.post('/notes', { text: 'bob note' }, bob)).status, 201);

  assert.deepEqual((await t.get('/notes', bob)).body.data.map((n) => n.text), ['bob note'], 'the gate does not widen owner scoping');
  assert.equal((await t.get(`/notes/${mine.body.data.id}`, bob)).status, 404);
  assert.equal((await t.get(`/notes/${mine.body.data.id}`, alice)).status, 200);
  assert.equal((await t.get('/notes')).status, 401);

  await t.patch('/admin/flags/notes', { enabled: false }, admin);
  assert.equal((await t.get(`/notes/${mine.body.data.id}`, alice)).status, 404);
});

test('devtools panel lists flags and their rollout', async () => {
  const panel = await t.app.hooks.devtools['feature-flags'](t.app);
  assert.equal(panel.cacheTtlMs, 60_000);
  assert.equal(panel.flags, panel.list.length);
  const row = panel.list.find((r) => r.key === 'pricing');
  assert.equal(row.rollout, 50);
  assert.equal(row.variants, 'control 25 / annual 75');
});
