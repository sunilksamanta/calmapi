import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// A fake siteverify endpoint on node:http. The token decides the answer:
//   good-*      success (score 0.9, action 'login', hostname 'app.example.test')
//   low-*       success with score 0.1
//   action-*    success with action 'signup'
//   post-*      success with action 'post'
//   anything    { success: false, error-codes: ['invalid-input-response'] }

const SECRET = randomBytes(12).toString('hex'); // fake secret, built at runtime

function fakeSiteverify() {
  const requests = [];
  const server = createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(data));
      requests.push({ form, contentType: req.headers['content-type'] });
      const ok = (extra = {}) => ({ success: true, challenge_ts: new Date().toISOString(), hostname: 'app.example.test', score: 0.9, action: 'login', ...extra });
      let body;
      if (form.secret !== SECRET) body = { success: false, 'error-codes': ['invalid-input-secret'] };
      else if (form.response.startsWith('good-')) body = ok();
      else if (form.response.startsWith('low-')) body = ok({ score: 0.1 });
      else if (form.response.startsWith('action-')) body = ok({ action: 'signup' });
      else if (form.response.startsWith('post-')) body = ok({ action: 'post' });
      else body = { success: false, 'error-codes': ['invalid-input-response'] };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}/siteverify`, requests, close: () => new Promise((r) => server.close(r)) }));
  });
}

let fake;
let project;
let t; // turnstile, default routes
let t2; // recaptcha v3, custom routes, minScore and actions
let tNoKey; // no secret key set (test mode)
const events = [];
const DOWN = 'http://127.0.0.1:9/siteverify';

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  fake = await fakeSiteverify();
  project = await makeProject();
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'captcha', 'magic-link', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  tNoKey = await project.testApp();
  t = await project.testApp({ blocks: { captcha: { verifyUrl: fake.url } } });
  t2 = await project.testApp({
    blocks: {
      captcha: {
        provider: 'recaptcha',
        verifyUrl: fake.url,
        routes: ['POST /auth/login', 'POST /api/posts'],
        minScore: 0.5,
        action: { 'POST /auth/login': 'login', 'POST /posts': 'post' },
      },
    },
  });
  for (const app of [t.app, t2.app, tNoKey.app]) app.events.on('security.*', (payload, name) => events.push({ name, payload }));
});
after(async () => {
  await t?.close();
  await t2?.close();
  await tNoKey?.close();
  await fake?.close();
  project?.cleanup();
});

// Secrets are read on each request: set them only around the requests that need them.
const withKeys = () => {
  process.env.TURNSTILE_SECRET_KEY = SECRET;
  process.env.RECAPTCHA_SECRET_KEY = SECRET;
  process.env.TURNSTILE_SITE_KEY = 'site-key-for-tests';
};
const withoutKeys = () => {
  for (const k of ['TURNSTILE_SECRET_KEY', 'RECAPTCHA_SECRET_KEY', 'TURNSTILE_SITE_KEY']) delete process.env[k];
};
afterEach(() => {
  withoutKeys();
  for (const tt of [t, t2]) {
    const opts = tt.app.plugins.find((p) => p.name === 'captcha').options;
    Object.assign(opts, { failOpen: false, verifyUrl: fake.url });
  }
});
const optionsOf = (tt) => tt.app.plugins.find((p) => p.name === 'captcha').options;

/** POST with JSON and extra headers. */
async function send(tt, path, body, headers = {}) {
  const res = await fetch(`${tt.origin}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}
const account = () => ({ name: 'Captcha Person', email: `cap_${randomBytes(4).toString('hex')}@example.test`, password: 'correct-horse-battery' });
const lastEvent = async (tt, name) => {
  await tt.idle();
  return events.filter((e) => e.name === name).at(-1)?.payload;
};

test('a missing token is refused with CAPTCHA_REQUIRED, before the route runs', async () => {
  withKeys();
  const a = account();
  const res = await send(t, '/auth/register', a);
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'CAPTCHA_REQUIRED');
  assert.equal(await t.app.model('user').countDocuments({ email: a.email }), 0, 'the handler never ran');
  assert.equal((await lastEvent(t, 'security.captcha_failed')).reason, 'missing');
  assert.equal((await send(t, '/auth/password/forgot', { email: a.email })).body.error.code, 'CAPTCHA_REQUIRED');
  assert.equal((await send(t, '/auth/magic-link', { email: a.email })).body.error.code, 'CAPTCHA_REQUIRED', 'magic-link is protected when installed');
});

test('an invalid token is refused with CAPTCHA_INVALID', async () => {
  withKeys();
  const res = await send(t, '/auth/login', { email: 'a@example.test', password: 'x' }, { 'x-captcha-token': 'forged' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'CAPTCHA_INVALID');
  assert.equal((await lastEvent(t, 'security.captcha_failed')).reason, 'rejected:invalid-input-response');
  const long = await send(t, '/auth/login', { email: 'a@example.test', password: 'x' }, { 'x-captcha-token': `good-${'x'.repeat(3000)}` });
  assert.equal(long.body.error.code, 'CAPTCHA_INVALID', 'oversized tokens are not even sent');
});

test('a valid token passes: header or body field, sent with secret and remote IP', async () => {
  withKeys();
  const a = account();
  const viaHeader = await send(t, '/auth/register', a, { 'x-captcha-token': 'good-1' });
  assert.equal(viaHeader.status, 201, JSON.stringify(viaHeader.body));
  const req = fake.requests.at(-1);
  assert.equal(req.contentType, 'application/x-www-form-urlencoded');
  assert.deepEqual(Object.keys(req.form).sort(), ['remoteip', 'response', 'secret']);
  assert.equal(req.form.response, 'good-1');
  assert.equal(req.form.secret, SECRET);
  assert.match(req.form.remoteip, /127\.0\.0\.1/);

  // The body field is removed before the route validates its input (unknown fields are refused).
  const viaBody = await send(t, '/auth/login', { email: a.email, password: a.password, captchaToken: 'good-2' });
  assert.equal(viaBody.status, 200, JSON.stringify(viaBody.body));
  assert.match(viaBody.body.data.token, /^calm_/);
});

test('reCAPTCHA v3: low scores and wrong actions are refused', async () => {
  withKeys();
  const u = await t2.signup();
  const login = (token) => send(t2, '/auth/login', { email: u.email, password: u.password }, { 'x-captcha-token': token });

  const low = await login('low-1');
  assert.equal(low.status, 400);
  assert.equal(low.body.error.code, 'CAPTCHA_INVALID');
  const { ip: _ip, ...event } = await lastEvent(t2, 'security.captcha_failed');
  assert.deepEqual(event, { path: 'POST /auth/login', reason: 'low_score', score: 0.1 });

  const action = await login('action-1');
  assert.equal(action.body.error.code, 'CAPTCHA_INVALID');
  assert.equal((await lastEvent(t2, 'security.captcha_failed')).reason, 'wrong_action');

  assert.equal((await login('good-1')).status, 200);

  // minScore is an option.
  optionsOf(t2).minScore = 0.05;
  try {
    assert.equal((await login('low-2')).status, 200);
  } finally {
    optionsOf(t2).minScore = 0.5;
  }
});

test('the provider not answering: closed by default (503), open when asked', async () => {
  withKeys();
  optionsOf(t).verifyUrl = DOWN;
  const closed = await send(t, '/auth/register', account(), { 'x-captcha-token': 'good-1' });
  assert.equal(closed.status, 503);
  assert.equal(closed.body.error.code, 'CAPTCHA_UNAVAILABLE');
  assert.equal((await lastEvent(t, 'security.captcha_unavailable')).failOpen, false);

  optionsOf(t).failOpen = true;
  const open = await send(t, '/auth/register', account(), { 'x-captcha-token': 'good-1' });
  assert.equal(open.status, 201);
  assert.equal((await lastEvent(t, 'security.captcha_unavailable')).failOpen, true);
  // Failing open never turns a rejected token into a pass: only a missing answer does.
  optionsOf(t).verifyUrl = fake.url;
  assert.equal((await send(t, '/auth/register', account(), { 'x-captcha-token': 'forged' })).status, 400);
});

test('routes not in the list are unaffected, and the list is configurable', async () => {
  withKeys();
  // Default list: profile updates and logout are not protected.
  const u = await t.signup().catch(() => null);
  assert.equal(u, null, 'register is protected, so t.signup (no token) fails');
  const reg = await send(t, '/auth/register', account(), { 'x-captcha-token': 'good-1' });
  const token = reg.body.data.token;
  assert.equal((await t.get('/auth/me', token)).status, 200);
  assert.equal((await t.post('/posts', { title: 'Hello', body: 'x' }, token)).status, 201);

  // Custom list on t2: register is free, posts need a token (prefix '/api' accepted in the list).
  const v = await t2.signup();
  assert.ok(v.token, 'register is not in the custom list');
  const post = await t2.post('/posts', { title: 'Hello', body: 'x' }, v);
  assert.equal(post.status, 400);
  assert.equal(post.body.error.code, 'CAPTCHA_REQUIRED');
  const res = await fetch(`${t2.origin}/api/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${v.token}`, 'x-captcha-token': 'action-2' },
    body: JSON.stringify({ title: 'Hello', body: 'x' }),
  });
  assert.equal(res.status, 400, 'action "signup" is not the "post" action this route expects');
  const ok = await fetch(`${t2.origin}/api/posts`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${v.token}`, 'x-captcha-token': 'post-1' },
    body: JSON.stringify({ title: 'Hello', body: 'x', captchaToken: 'ignored-when-the-header-is-set' }),
  });
  assert.equal(ok.status, 201, 'the right action passes, and the body field is removed');
});

test('GET /api/captcha gives the frontend the site key, never the secret', async () => {
  withKeys();
  const res = await t.get('/captcha');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, {
    provider: 'turnstile',
    siteKey: 'site-key-for-tests',
    header: 'x-captcha-token',
    field: 'captchaToken',
    routes: ['POST /auth/register', 'POST /auth/login', 'POST /auth/password/forgot', 'POST /auth/magic-link'],
  });
  assert.ok(!JSON.stringify(res.body).includes(SECRET));
  const r2 = await t2.get('/captcha');
  assert.deepEqual(r2.body.data.actions, { 'POST /auth/login': 'login', 'POST /posts': 'post' });
});

test('no secret key: skipped in test mode, refused when bypass is off, doctor warns', async () => {
  const u = await tNoKey.signup();
  assert.ok(u.token, 'register works without a token');
  const findings = await tNoKey.app.doctor();
  assert.equal(findings.find((f) => f.id === 'captcha-no-secret')?.level, 'warn');

  optionsOf(tNoKey).bypass = false;
  try {
    const res = await send(tNoKey, '/auth/login', { email: u.email, password: u.password }, { 'x-captcha-token': 'good-1' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'CAPTCHA_UNAVAILABLE');
  } finally {
    optionsOf(tNoKey).bypass = null;
  }

  withKeys();
  assert.ok(!(await t2.app.doctor()).some((f) => f.id === 'captcha-no-secret'));
  optionsOf(t2).routes = ['POST /auth/login', 'POST /nope'];
  try {
    assert.ok((await t2.app.doctor()).some((f) => f.id === 'captcha-unknown-route-POST /nope'));
  } finally {
    optionsOf(t2).routes = ['POST /auth/login', 'POST /api/posts'];
  }
});
