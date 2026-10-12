import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

// A block using every extension point: env declarations, options from calm.config.js,
// a custom credential (calm.authenticate), a guard and a named policy.
const files = {
  'calm.config.js': `import { defineConfig } from '#calm';
export default defineConfig({ blocks: { demo: { greeting: 'Hola' } } });
`,
  'app/blocks/demo/index.js': `import { definePlugin, forbidden } from '#calm';

export default definePlugin({
  name: 'demo',
  env: {
    DEMO_SECRET: { required: 'production', secret: true, description: 'Signs demo tokens' },
    DEMO_ALWAYS: { required: true, description: 'Needed everywhere' },
    DEMO_OPTIONAL: 'Nice to have',
  },
  options: { greeting: 'Hello', punctuation: '!' },
  setup(calm, options) {
    calm.authenticate(async (token) => {
      const m = /^demo_([a-f0-9]{24})$/.exec(token);
      if (!m) return null;
      const user = await calm.app.model('user').findById(m[1]).lean();
      return user ? { user, via: 'demo-token', scopes: ['notes:read'], id: 'key-1' } : null;
    });
    calm.guard((ctx) => {
      if (ctx.req.get('x-maintenance')) throw forbidden('Down for maintenance');
    });
    calm.policy('vip', (ctx) => Boolean(ctx.user?.name?.startsWith('VIP')));
    calm.routes((r) => {
      r.get('/demo/greet', { policy: 'public' }, () => ({ text: options.greeting + options.punctuation, same: calm.options === options }));
      r.get('/demo/whoami', { policy: 'authenticated' }, (ctx) => ({ id: ctx.user.id, auth: ctx.auth }));
      r.get('/demo/vip', { policy: 'vip | admin' }, () => ({ ok: true }));
      r.get('/demo/env', { policy: 'public' }, () => ({ optional: calm.env('DEMO_OPTIONAL', 'fallback') }));
      r.get('/demo/undeclared', { policy: 'public' }, () => calm.env('NOT_DECLARED'));
    });
  },
});
`,
};

let project;
let t;
before(async () => {
  project = await makeProject({ files });
  t = await project.testApp();
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('options: defaults merged with calm.config.js blocks.<name>', async () => {
  const res = await t.get('/demo/greet');
  assert.deepEqual(res.body.data, { text: 'Hola!', same: true });
});

test('env: declared variables are read, undeclared ones are refused, doctor reports missing ones', async () => {
  assert.equal((await t.get('/demo/env')).body.data.optional, 'fallback');
  assert.equal((await t.get('/demo/undeclared')).status, 500);
  const findings = await t.app.doctor();
  const always = findings.find((f) => f.id === 'env-DEMO_ALWAYS');
  const secret = findings.find((f) => f.id === 'env-DEMO_SECRET');
  assert.equal(always?.level, 'error', 'required everywhere and missing');
  assert.equal(secret?.level, 'info', 'only required in production');
  assert.equal(findings.find((f) => f.id === 'env-DEMO_OPTIONAL'), undefined, 'optional variables are not findings');
  const env = t.app.plugins.find((p) => p.name === 'demo').env;
  assert.deepEqual(env.map((v) => [v.key, v.secret]), [['DEMO_SECRET', true], ['DEMO_ALWAYS', false], ['DEMO_OPTIONAL', false]]);
});

test('authenticate: a block can accept its own credentials, with scopes on ctx.auth', async () => {
  const u = await t.signup();
  const viaToken = await t.get('/demo/whoami', `demo_${u.id}`);
  assert.equal(viaToken.status, 200);
  assert.equal(viaToken.body.data.id, u.id);
  assert.deepEqual(viaToken.body.data.auth, { via: 'demo-token', scopes: ['notes:read'], id: 'key-1' });
  const viaSession = await t.get('/demo/whoami', u);
  assert.equal(viaSession.body.data.auth.via, 'session');
  assert.equal((await t.get('/demo/whoami', 'demo_000000000000000000000000')).status, 401, 'unknown sessions and tokens are still refused');
});

test('guard: runs before every route and can stop it', async () => {
  const res = await fetch(`${t.origin}/api/demo/greet`, { headers: { 'x-maintenance': '1' } });
  assert.equal(res.status, 403);
  assert.equal((await res.json()).error.message, 'Down for maintenance');
});

test('named policies combine with built-in ones', async () => {
  const regular = await t.signup({ name: 'Regular Joe' });
  const vip = await t.signup({ name: 'VIP Ada' });
  const admin = await t.signup({ name: 'Root', roles: ['user', 'admin'] });
  assert.equal((await t.get('/demo/vip', regular)).status, 403);
  assert.equal((await t.get('/demo/vip', vip)).status, 200);
  assert.equal((await t.get('/demo/vip', admin)).status, 200);
  assert.equal(t.app.routes.find((r) => r.path.endsWith('/demo/vip')).policyLabel, 'vip | admin', 'routes list the named policy');
});
