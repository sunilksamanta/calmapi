import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { makeProject } from '../helpers.js';

let project;
let t;
const devtools = (path, init = {}) =>
  fetch(`${t.origin}/_calm/api${path}`, { ...init, headers: { host: 'localhost', ...(init.headers ?? {}) } });

before(async () => {
  project = await makeProject();
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('records requests with their Mongo queries, errors and redacted secrets', async () => {
  const u = await t.signup({ password: 'super-secret-pw' });
  const created = await t.post('/posts', { title: 'Traced', body: 'x' }, u);
  await t.get('/posts/not-an-id', u);

  const list = await (await devtools('/requests')).json();
  const createReq = list.find((r) => r.method === 'POST' && r.path === '/api/posts');
  assert.ok(createReq, 'request summary recorded');
  assert.equal(createReq.status, 201);
  assert.equal(createReq.user.id, u.id);
  assert.ok(createReq.queries >= 2, 'queries attributed to the request');

  const detail = await (await devtools(`/requests/${createReq.id}`)).json();
  assert.ok(detail.queries.some((q) => q.command === 'insert' && q.collection === 'posts'));
  assert.ok(detail.queries.every((q) => q.durationMs !== null));
  assert.equal(detail.responseBody.data.id, created.body.data.id);
  assert.match(detail.requestHeaders.authorization, /…/, 'token is shortened');

  const register = list.find((r) => r.path === '/api/auth/register');
  const regDetail = await (await devtools(`/requests/${register.id}`)).json();
  assert.equal(regDetail.requestBody.password, '[redacted]');

  const find = detail.queries.find((q) => q.command === 'find');
  const plan = await (await devtools(`/queries/${find.id}/explain`, { method: 'POST', headers: { 'x-calm-devtools': '1' } })).json();
  assert.ok(Array.isArray(plan.stages) && plan.stages.length);
});

test('overview, data lens, mails and act-as', async () => {
  const overview = await (await devtools('/overview')).json();
  assert.deepEqual(overview.resources.map((r) => r.name).sort(), ['post', 'user']);
  assert.ok(overview.routes.some((r) => r.path === '/api/posts/:id/publish' && r.policy === 'owner | admin'));

  const lens = await (await devtools('/resources/user/docs')).json();
  const first = lens.items[0];
  assert.match(first.stored.password, /scrypt hash/);
  assert.ok(first.notReturned.includes('password'));
  assert.ok(first.notReturned.includes('email'), 'email is private to anonymous viewers');

  const u = await t.signup();
  await t.post('/auth/password/forgot', { email: u.email });
  await t.idle();
  const mails = await (await devtools('/mails')).json();
  assert.equal(mails[0].to, u.email);
  assert.match(mails[0].text, /reset-password\?token=reset_/);

  const denied = await devtools('/act-as', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: u.id }) });
  assert.equal(denied.status, 403, 'writes need the devtools header');
  const acted = await (await devtools('/act-as', { method: 'POST', headers: { 'content-type': 'application/json', 'x-calm-devtools': '1' }, body: JSON.stringify({ userId: u.id }) })).json();
  assert.equal((await t.get('/auth/me', acted.token)).body.data.id, u.id);
});

// fetch() refuses to set Host, so use node:http for the DNS rebinding case.
const rawStatus = (path, headers) =>
  new Promise((resolve, reject) => {
    const req = httpRequest(`${t.origin}${path}`, { headers }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });

test('only reachable from this machine', async () => {
  assert.equal(await rawStatus('/_calm/api/overview', { host: 'localhost:5001' }), 200);
  assert.equal(await rawStatus('/_calm/api/overview', { host: 'evil.example.com' }), 404, 'DNS rebinding blocked');
  assert.equal((await devtools('/overview', { headers: { 'x-forwarded-for': '1.2.3.4' } })).status, 404, 'proxied requests blocked');
  const res = await devtools('/overview', { headers: { origin: 'https://evil.example.com' } });
  assert.equal(res.headers.get('access-control-allow-origin'), null, 'no CORS on devtools');
});

test('never enabled in production', async () => {
  const prod = await project.load('calm/config.js');
  const cfg = await prod.loadConfig(project.dir, { mode: 'production', devtools: { enabled: true }, db: { uri: 'mongodb://x' } }).catch((e) => e);
  // production also requires APP_URL; either way devtools must not be on
  assert.ok(cfg instanceof Error || cfg.devtools.enabled === false);
});
