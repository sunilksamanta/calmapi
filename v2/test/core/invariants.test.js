import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

// A project that breaks most of the named rules on purpose, plus one custom invariant.
const files = {
  'calm.config.js': `import { defineConfig } from '#calm';
export default defineConfig({
  invariants: [
    'no public write routes',
    { rule: 'no public routes', except: ['GET /api/pulse', 'GET /api/leads*', 'GET /api/posts*', 'POST /api/contact'] },
    'personal data is never public',
    'auth routes are rate limited',
    'every route has an explicit policy',
    'resource order requires idempotency',
    'routes under /api/admin require admin',
    function noPulse(app) { return app.routes.filter((r) => r.path === '/pulse'); },
    (app) => app.routes.length > 0,
  ],
  plugins: [{ kind: 'calm.plugin', name: 'idempotency', env: {}, options: { required: ['POST /api/orders'] }, setup() {} }],
});
`,
  'app/routes.js': `export default (r) => {
  r.post('/contact', { policy: 'public' }, () => ({ ok: true }));
  r.get('/pulse', { policy: 'public' }, () => ({ ok: true }));
  r.get('/admin/stats', { policy: 'authenticated' }, () => ({ ok: true }));
  r.get('/admin/ok', { policy: 'admin' }, () => ({ ok: true }));
  r.get('/unnamed', () => ({ ok: true }));
};
`,
  'app/resources/lead/lead.resource.js': `import { resource, f } from '#calm';
export default resource('lead', {
  fields: { name: f.string(), email: f.email(), phone: f.string().visibleTo('admin') },
  policy: { list: 'public', read: 'public', create: 'admin', update: 'admin', delete: 'admin' },
});
`,
  'app/resources/order/order.resource.js': `import { resource, f } from '#calm';
export default resource('order', {
  fields: { item: f.string().required(), buyer: f.ref('user').owner() },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});
`,
};

let project;
let t;
before(async () => {
  project = await makeProject({ files });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

const byRule = (results) => Object.fromEntries(results.map((r) => [r.rule, r]));

test('named rules report what they found, with files', async () => {
  const r = byRule(await t.app.invariants());
  assert.equal(r['no public write routes'].ok, false);
  assert.deepEqual(r['no public write routes'].violations.map((v) => v.what), ['POST /api/contact is public']);
  assert.equal(r['no public write routes'].violations[0].file, 'app/routes.js');

  assert.equal(r['no public routes'].ok, true, 'except patterns cover the public routes');

  assert.equal(r['personal data is never public'].ok, false);
  assert.deepEqual(r['personal data is never public'].violations.map((v) => v.what), ['lead.email is personal data and anyone can read it']);
  assert.equal(r['personal data is never public'].violations[0].file, 'app/resources/lead/lead.resource.js');

  assert.equal(r['auth routes are rate limited'].ok, true, 'register, login and password routes have the auth limiter');

  assert.equal(r['every route has an explicit policy'].ok, false);
  assert.deepEqual(r['every route has an explicit policy'].violations.map((v) => v.what), ['GET /api/unnamed has no explicit policy']);

  assert.equal(r['resource order requires idempotency'].ok, false);
  assert.deepEqual(
    r['resource order requires idempotency'].violations.map((v) => v.what).sort(),
    ['DELETE /api/orders/:id is not in blocks.idempotency.required', 'PATCH /api/orders/:id is not in blocks.idempotency.required', 'PUT /api/orders/:id is not in blocks.idempotency.required'],
  );

  assert.equal(r['routes under /api/admin require admin'].ok, false);
  assert.deepEqual(r['routes under /api/admin require admin'].violations.map((v) => v.what), ['GET /api/admin/stats is "authenticated", not "admin"']);
});

test('custom invariants: a function returning routes, or a boolean', async () => {
  const results = await t.app.invariants();
  const pulse = results.find((r) => r.rule === 'noPulse');
  assert.equal(pulse.kind, 'custom');
  assert.equal(pulse.ok, false);
  assert.deepEqual(pulse.violations, [{ what: 'GET /api/pulse is "public"', file: 'app/routes.js' }]);
  const anon = results.find((r) => r.rule === 'custom invariant #9');
  assert.equal(anon.ok, true);
});

test('doctor shows broken invariants as errors and devtools serves them', async () => {
  const findings = (await t.app.doctor()).filter((f) => f.id === 'invariant');
  assert.equal(findings.length, 6);
  const contact = findings.find((f) => f.title === 'Invariant broken: no public write routes');
  assert.match(contact.detail, /POST \/api\/contact is public \(app\/routes\.js\)/);
  assert.match(contact.detail, /In production the app refuses to start/);
  assert.equal(contact.file, 'app/routes.js');

  const res = await fetch(`${t.origin}/_calm/api/invariants`, { headers: { host: 'localhost' } });
  assert.equal(res.status, 200);
  const list = await res.json();
  assert.equal(list.length, 9);
  assert.equal(list.filter((r) => !r.ok).length, 6);
});

test('the behavior snapshot lists routes with access per persona, fields and invariants', async () => {
  const snap = await t.app.snapshot();
  assert.equal(snap.version, 1);
  assert.deepEqual(snap.personas, ['anonymous', 'user', 'owner', 'admin']);
  const contact = snap.routes.find((r) => r.method === 'POST' && r.path === '/api/contact');
  assert.deepEqual(contact.access, { anonymous: 'allow', user: 'allow', owner: 'allow', admin: 'allow' });
  const orders = snap.routes.find((r) => r.method === 'GET' && r.path === '/api/orders');
  assert.deepEqual(orders.access, { anonymous: 'deny', user: 'own', owner: 'own', admin: 'allow' });
  const login = snap.routes.find((r) => r.path === '/api/auth/login');
  assert.equal(login.rateLimit, 'auth');
  const lead = snap.resources.find((r) => r.name === 'lead');
  const phone = lead.fields.find((f) => f.name === 'phone');
  assert.deepEqual(phone.read, { anonymous: 'no', user: 'no', owner: 'no', admin: 'yes' });
  assert.equal(phone.pii, true);
  // The email of a user is visible to the owner by its rule, but the resource is not public: nobody else sees it.
  const user = snap.resources.find((r) => r.name === 'user');
  assert.deepEqual(user.fields.find((f) => f.name === 'name').read, { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' });
  assert.equal(snap.invariants.length, 9);
  assert.deepEqual(snap.invariants[1], { rule: 'no public routes', except: ['GET /api/pulse', 'GET /api/leads*', 'GET /api/posts*', 'POST /api/contact'] });
  assert.deepEqual(snap.blocks, [{ name: 'idempotency', file: null }]);
  const res = await fetch(`${t.origin}/_calm/api/snapshot`, { headers: { host: 'localhost' } });
  assert.equal((await res.json()).routes.length, snap.routes.length);
});

test('an unknown rule is a configuration error', async () => {
  const bad = await makeProject({
    files: { 'calm.config.js': `import { defineConfig } from '#calm';\nexport default defineConfig({ invariants: ['no cookies ever'] });\n` },
  });
  try {
    await assert.rejects(bad.testApp(), (err) => {
      assert.equal(err.code, 'CALM_CONFIG');
      assert.match(err.message, /unknown rule "no cookies ever"/);
      assert.match(err.message, /Known rules: no public write routes/);
      return true;
    });
  } finally {
    bad.cleanup();
  }
});

test('in production a broken invariant stops the boot', async () => {
  const { createApp } = await project.load('calm/index.js');
  const url = new URL(t.app.config.db.uri);
  url.pathname = `${url.pathname}_prod`;
  const previous = process.env.APP_URL;
  process.env.APP_URL = 'https://api.example.test';
  let app;
  try {
    app = await createApp({ root: project.dir, config: { mode: 'production', db: { uri: url.toString(), connectRetries: 1 }, log: { level: 'silent' } } });
    await assert.rejects(app.start(), (err) => {
      assert.equal(err.code, 'CALM_INVARIANT');
      assert.match(err.message, /Refusing to start: 6 invariants are broken/);
      assert.match(err.message, /no public write routes\n\s+POST \/api\/contact is public/);
      return true;
    });
    assert.equal(app.started, false);
  } finally {
    if (previous === undefined) delete process.env.APP_URL;
    else process.env.APP_URL = previous;
    await app?.mongoose.connection.dropDatabase().catch(() => {});
    await app?.stop();
  }
});
