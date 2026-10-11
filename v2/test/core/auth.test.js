import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

let project;
let t;
const mails = [];

before(async () => {
  project = await makeProject();
  t = await project.testApp();
  t.app.mailer.observe((m) => mails.push(m));
});
after(async () => {
  await t.close();
  project.cleanup();
});

const lastResetToken = async (email) => {
  await t.idle();
  const mail = mails.filter((m) => m.to === email && m.meta?.kind === 'password-reset').at(-1);
  return mail?.meta.token;
};

describe('register and login', () => {
  test('register signs you in and never returns secrets', async () => {
    const res = await t.post('/auth/register', { name: 'Ada', email: 'ADA@Example.com', password: 'analytical-engine' });
    assert.equal(res.status, 201);
    const { user, token, expiresAt } = res.body.data;
    assert.match(token, /^calm_/);
    assert.ok(expiresAt);
    assert.equal(user.email, 'ada@example.com');
    assert.deepEqual(user.roles, ['user']);
    assert.equal(user.password, undefined);

    const me = await t.get('/auth/me', token);
    assert.equal(me.status, 200);
    assert.equal(me.body.data.name, 'Ada');
  });

  test('register rejects duplicates, weak passwords and role escalation', async () => {
    const dup = await t.post('/auth/register', { name: 'Ada 2', email: 'ada@example.com', password: 'analytical-engine' });
    assert.equal(dup.status, 409);
    const weak = await t.post('/auth/register', { name: 'Weak', email: 'weak@example.com', password: 'short' });
    assert.equal(weak.status, 422);
    assert.ok(weak.body.error.details.password);
    const sneaky = await t.post('/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'long-enough-pw', roles: ['admin'] });
    assert.equal(sneaky.status, 422);
    assert.match(sneaky.body.error.details.roles, /not allowed/);
  });

  test('login errors do not reveal whether an account exists', async () => {
    const unknown = await t.post('/auth/login', { email: 'nobody@example.com', password: 'whatever-123' });
    const wrong = await t.post('/auth/login', { email: 'ada@example.com', password: 'whatever-123' });
    assert.equal(unknown.status, 401);
    assert.equal(wrong.status, 401);
    assert.equal(unknown.body.error.message, wrong.body.error.message);
  });

  test('login works and sessions are independent', async () => {
    const a = await t.post('/auth/login', { email: 'ada@example.com', password: 'analytical-engine' });
    assert.equal(a.status, 200);
    const b = await t.post('/auth/login', { email: 'ada@example.com', password: 'analytical-engine' });
    const sessions = await t.get('/auth/sessions', a.body.data.token);
    assert.ok(sessions.body.data.length >= 2);
    assert.equal(sessions.body.data.filter((s) => s.current).length, 1);

    assert.equal((await t.post('/auth/logout', {}, a.body.data.token)).status, 204);
    assert.equal((await t.get('/auth/me', a.body.data.token)).status, 401, 'logged out token is dead');
    assert.equal((await t.get('/auth/me', b.body.data.token)).status, 200, 'other session still alive');
  });

  test('tokens are only accepted as a Bearer header, never in the query string', async () => {
    const { token } = await t.signup();
    assert.equal((await t.get(`/auth/me?token=${token}`)).status, 401);
    assert.equal((await t.get('/auth/me', 'calm_not-a-real-token')).status, 401);
    const raw = await fetch(`${t.origin}/api/auth/me`, { headers: { authorization: `Token ${token}` } });
    assert.equal(raw.status, 401);
  });

  test('sessions are stored hashed', async () => {
    const { token } = await t.signup();
    const stored = await t.app.auth.service.Session.findOne({}).sort({ _id: -1 }).lean();
    assert.notEqual(stored.tokenHash, token);
    assert.equal(stored.tokenHash.length, 64);
  });
});

describe('profile', () => {
  test('PATCH /auth/me cannot touch roles, status, email or password', async () => {
    const u = await t.signup();
    const ok = await t.patch('/auth/me', { name: 'New Name' }, u);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.data.name, 'New Name');
    for (const body of [{ roles: ['admin'] }, { status: 'active' }, { email: 'x@y.io' }, { password: 'new-password-1' }]) {
      const res = await t.patch('/auth/me', body, u);
      assert.equal(res.status, 422, JSON.stringify(body));
    }
  });

  test('disabled users lose access immediately', async () => {
    const u = await t.signup();
    await t.app.model('user').updateOne({ _id: u.id }, { $set: { status: 'disabled' } });
    assert.equal((await t.get('/auth/me', u)).status, 401);
    const login = await t.post('/auth/login', { email: u.email, password: u.password });
    assert.equal(login.status, 403);
  });
});

describe('passwords', () => {
  test('changing your password needs the current one and signs out other sessions', async () => {
    const u = await t.signup();
    const other = (await t.post('/auth/login', { email: u.email, password: u.password })).body.data.token;

    const wrong = await t.post('/auth/password', { currentPassword: 'nope-nope-nope', newPassword: 'brand-new-password' }, u);
    assert.equal(wrong.status, 422);

    const ok = await t.post('/auth/password', { currentPassword: u.password, newPassword: 'brand-new-password' }, u);
    assert.equal(ok.status, 204);
    assert.equal((await t.get('/auth/me', other)).status, 401, 'other session revoked');
    assert.equal((await t.get('/auth/me', u)).status, 200, 'current session kept');
    assert.equal((await t.post('/auth/login', { email: u.email, password: 'brand-new-password' })).status, 200);
  });

  test('reset flow: same answer for unknown emails, single-use token, all sessions revoked', async () => {
    const u = await t.signup();
    const unknown = await t.post('/auth/password/forgot', { email: 'ghost@example.com' });
    const known = await t.post('/auth/password/forgot', { email: u.email });
    assert.equal(unknown.status, 202);
    assert.equal(known.status, 202);
    assert.deepEqual(unknown.body, known.body);

    const token = await lastResetToken(u.email);
    assert.match(token, /^reset_/);
    assert.equal(await lastResetToken('ghost@example.com'), undefined);

    const stored = await t.app.auth.service.PasswordReset.findOne({ user: u.id }).lean();
    assert.notEqual(stored.tokenHash, token, 'reset tokens are stored hashed');

    const reset = await t.post('/auth/password/reset', { token, password: 'reset-password-1' });
    assert.equal(reset.status, 204);
    assert.equal((await t.get('/auth/me', u)).status, 401, 'old sessions revoked after reset');
    assert.equal((await t.post('/auth/login', { email: u.email, password: 'reset-password-1' })).status, 200);

    const again = await t.post('/auth/password/reset', { token, password: 'another-password-2' });
    assert.equal(again.status, 400, 'token is single use');
    assert.equal(again.body.error.code, 'INVALID_TOKEN');
  });

  test('expired reset tokens are refused', async () => {
    const u = await t.signup();
    await t.post('/auth/password/forgot', { email: u.email });
    const token = await lastResetToken(u.email);
    await t.app.auth.service.PasswordReset.updateMany({ user: u.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    const res = await t.post('/auth/password/reset', { token, password: 'reset-password-1' });
    assert.equal(res.status, 400);
  });

  test('stored password hashes are never readable through the API', async () => {
    const admin = await t.signup({ roles: ['user', 'admin'] });
    const list = await t.get('/users?limit=100', admin);
    assert.equal(list.status, 200);
    for (const u of list.body.data) {
      assert.equal(u.password, undefined);
      assert.ok(!JSON.stringify(u).includes('scrypt$'));
    }
  });
});

describe('rate limiting', () => {
  test('auth endpoints are rate limited', async () => {
    const limited = await project.testApp({ rateLimit: { enabled: true, auth: { windowMs: 60_000, max: 3 } } });
    try {
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await limited.post('/auth/login', { email: 'x@example.com', password: 'whatever-123' })).status);
      assert.deepEqual(codes, [401, 401, 401, 429, 429]);
      const res = await limited.post('/auth/login', { email: 'x@example.com', password: 'whatever-123' });
      assert.ok(res.headers.get('retry-after'));
    } finally {
      await limited.close();
    }
  });
});
