import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerPolicy, parsePolicy } from '../../core/resource/policy.js';
import { makeProject } from '../helpers.js';

// Extension points for data-dependent access (teams, organizations, plans): namespaced named
// policies, { simulate } for the exposure matrix and the audit, scope() installed by a block,
// and async scopes (awaited by app.canRead, refused where a filter is needed at once).

describe('named policies', () => {
  test('names may be namespaced with ":", role: stays reserved', () => {
    const fn = () => true;
    registerPolicy('ext:editor', fn);
    assert.equal(parsePolicy('ext:editor | admin')[0], fn);
    assert.equal(fn.name, 'ext:editor');
    assert.throws(() => registerPolicy('role:editor', () => true), /reserved/);
    assert.throws(() => registerPolicy('ext:', () => true), /invalid name/);
    assert.throws(() => registerPolicy('a b', () => true), /invalid name/);
    assert.throws(() => registerPolicy('ext:x', () => true, { simulate: 'custom' }), /simulate must be a function/);
    assert.deepEqual(parsePolicy('role:admin'), ['admin'], 'role: still names a role');
  });
});

describe('a block with data-dependent access', () => {
  let project;
  let t;
  let calls = 0;
  before(async () => {
    project = await makeProject({
      files: {
        // 'ext:club' depends on data (a club list); its simulate says so. The scope is installed on
        // the service instance and is async unless the request already loaded the clubs.
        'app/blocks/clubs/index.js': `import { definePlugin, currentRequest } from '#calm';
const loaded = new WeakMap();
export default definePlugin({
  name: 'clubs',
  setup(calm) {
    const clubsOf = async (user) => (await calm.app.model('user').findById(user.id).lean())?.name?.startsWith('Club') ? ['gold'] : [];
    calm.policy('ext:club', async ({ user }) => { globalThis.__clubCalls = (globalThis.__clubCalls ?? 0) + 1; return Boolean(user && (await clubsOf(user)).length); },
      { simulate: ({ user }) => (user ? 'custom' : 'deny') });
    calm.guard(async (ctx) => { if (ctx.user) loaded.set(currentRequest(), await clubsOf(ctx.user)); });
    calm.onService(({ def, service }) => {
      if (def.name !== 'perk') return;
      service.scope = ({ user } = {}) => {
        if (!user) return { club: { $in: [] } };
        const store = currentRequest();
        if (store && loaded.has(store)) return { club: { $in: loaded.get(store) } };
        return clubsOf(user).then((clubs) => ({ club: { $in: clubs } }));
      };
    });
  },
});`,
        'app/resources/perk/perk.resource.js': `import { resource, f } from '#calm';
export default resource('perk', {
  fields: { title: f.string().required(), club: f.string().required() },
  policy: { list: 'ext:club', read: 'ext:club | admin', create: 'admin', update: 'admin', delete: 'none' },
});`,
      },
    });
    t = await project.testApp();
  });
  after(async () => {
    await t?.close();
    project?.cleanup();
  });

  test('the exposure matrix uses simulate() instead of calling the rule with a fake record', async () => {
    calls = globalThis.__clubCalls ?? 0;
    const perk = (await t.app.exposure()).resources.find((r) => r.name === 'perk');
    assert.equal(globalThis.__clubCalls ?? 0, calls, 'the rule itself was not called');
    assert.deepEqual(perk.actions.list, { anonymous: 'deny', user: 'custom', owner: 'custom', admin: 'custom' });
    assert.deepEqual(perk.actions.read, { anonymous: 'deny', user: 'custom', owner: 'custom', admin: 'allow' }, 'another token that allows wins');
    assert.equal(perk.actions.create.user, 'deny');
    assert.equal(perk.customScope, true, 'a scope() installed on the service instance counts');
  });

  test('requests use the loaded scope; canRead awaits an async one; filterFor refuses a pending one', async () => {
    const member = await t.signup({ name: 'Club Kim' });
    const other = await t.signup({ name: 'Lee' });
    const admin = await t.signup({ name: 'Root', roles: ['user', 'admin'] });
    const gold = await t.post('/perks', { title: 'Lounge', club: 'gold' }, admin);
    assert.equal(gold.status, 201);
    await t.post('/perks', { title: 'Hidden', club: 'silver' }, admin);

    assert.deepEqual((await t.get('/perks', member)).body.data.map((p) => p.title), ['Lounge']);
    assert.equal((await t.get('/perks', other)).status, 403);
    assert.equal((await t.get(`/perks/${gold.body.data.id}`, admin)).status, 404, 'the scope applies to admins too');

    const doc = await t.app.model('perk').findById(gold.body.data.id).lean();
    assert.equal(await t.app.canRead('perk', doc, { ...member.user, id: member.id }), true);
    assert.equal(await t.app.canRead('perk', doc, { ...other.user, id: other.id }), false);
    assert.equal(await t.app.inScope('perk', doc, { ...other.user, id: other.id }), false);
    assert.throws(() => t.app.service('perk').filterFor({ user: { ...member.user, id: member.id } }), /scope\(\) returned a Promise/);
    assert.deepEqual(t.app.service('perk').filterFor({ system: true }, { club: 'gold' }), { club: 'gold' }, 'system calls skip scope()');
  });

  test('calm audit skips what it cannot judge and reports no false failures', async () => {
    const { runAudit } = await project.load('calm/security/audit.js');
    const report = await runAudit({ root: project.dir });
    assert.equal(report.ok, true, JSON.stringify(report.results.filter((r) => r.ok === false).concat(report.leaks, report.probes.filter((p) => !p.ok))));
    assert.ok(report.results.some((r) => r.resource === 'perk' && r.action === 'list' && r.ok === null));
  });
});
