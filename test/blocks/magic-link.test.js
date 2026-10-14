import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t; // defaults
let t2; // createAccount and requireSameDevice on, its own database
let totp;
const events = [];

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  // totp too: magic links must still ask for the second factor.
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'magic-link', 'totp', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp();
  t2 = await project.testApp({ blocks: { 'magic-link': { createAccount: true, requireSameDevice: true } } });
  totp = await project.load('app/blocks/totp/totp.js');
  for (const app of [t.app, t2.app]) app.events.on('*', (payload, name) => events.push({ name, payload }));
});
after(async () => {
  await t?.close();
  await t2?.close();
  project?.cleanup();
});

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const links = (tt) => tt.app.mongoose.connection.collection('calm_magic_links');
const mailsTo = (tt, email) => tt.mails.filter((m) => m.to === email);
const tokenFrom = (mail) => decodeURIComponent(/[?&]token=([^\s&]+)/.exec(mail.text)[1]);
const endCooldown = (tt, email) =>
  tt.app.mongoose.connection.collection('calm_magic_link_cooldowns').updateOne({ _id: sha(`magic:${email}`) }, { $set: { until: new Date(Date.now() - 1000) } });

/** Ask for a link and return the answer plus the token from the email (null when none was sent). */
async function requestLink(tt, email, extra = {}) {
  const res = await tt.post('/auth/magic-link', { email, ...extra });
  assert.equal(res.status, 202, JSON.stringify(res.body));
  await tt.idle();
  const mails = mailsTo(tt, email);
  return { res, requestId: res.body.data.requestId, token: mails.length ? tokenFrom(mails.at(-1)) : null, mails };
}

test('an existing account gets one email with a single use link, stored hashed', async () => {
  const u = await t.signup();
  const { res, token, mails } = await requestLink(t, u.email);
  assert.match(res.body.data.message, /link is on its way/);
  assert.match(res.body.data.requestId, /^[\w-]{16}$/);
  assert.equal(res.body.data.expiresIn, 15 * 60);

  assert.equal(mails.length, 1);
  assert.equal(mails[0].subject, `Sign in to ${t.app.config.app.name}`);
  assert.match(mails[0].text, new RegExp(`^${escapeRe(t.app.config.app.url)}/auth/magic\\?token=magic_`, 'm'));
  assert.match(token, /^magic_/);

  const raw = await links(t).findOne({ email: u.email });
  assert.equal(raw.tokenHash, sha(token), 'only the hash is stored');
  assert.ok(!JSON.stringify(raw).includes(token));
  assert.equal(raw.usedAt, null);
  assert.ok(raw.expiresAt - Date.now() > 14 * 60_000 && raw.expiresAt - Date.now() <= 15 * 60_000);
  assert.ok(events.some((e) => e.name === 'auth.magic_link_requested' && e.payload.user?.id === u.id && e.payload.signup === false));
});

test('an unknown address gets the same answer and no email', async () => {
  const known = await t.signup();
  const a = await t.post('/auth/magic-link', { email: known.email });
  const b = await t.post('/auth/magic-link', { email: 'nobody@example.test' });
  assert.equal(b.status, a.status);
  assert.equal(b.body.data.message, a.body.data.message);
  assert.deepEqual(Object.keys(b.body.data).sort(), Object.keys(a.body.data).sort());
  await t.idle();
  assert.equal(mailsTo(t, 'nobody@example.test').length, 0);
  assert.equal(await links(t).countDocuments({ email: 'nobody@example.test' }), 0);
  assert.equal((await t.post('/auth/magic-link', { email: 'not-an-email' })).status, 422);
});

test('verify signs in, and the link cannot be used twice', async () => {
  const u = await t.signup();
  const { token, requestId } = await requestLink(t, u.email);
  const ok = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.data.token, /^calm_/);
  assert.equal(ok.body.data.user.id, u.id);
  assert.equal(ok.body.data.redirect, undefined);

  const me = await t.get('/auth/me', ok.body.data.token);
  assert.equal(me.status, 200);
  assert.equal(me.body.data.email, u.email);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'auth.login' && e.payload.user.id === u.id));

  const again = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'INVALID_TOKEN');
  assert.equal((await t.post('/auth/magic-link/verify', { token: 'magic_made_up' })).status, 400);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'security.invalid_magic_link' && e.payload.reason === 'used'));
  assert.ok(events.some((e) => e.name === 'security.invalid_magic_link' && e.payload.reason === 'unknown'));
});

test('expired links are refused', async () => {
  const u = await t.signup();
  const { token, requestId } = await requestLink(t, u.email);
  await links(t).updateOne({ tokenHash: sha(token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const res = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_TOKEN');
  await t.idle();
  assert.ok(events.some((e) => e.name === 'security.invalid_magic_link' && e.payload.reason === 'expired'));
});

test('redirect: paths and the app origin are kept, anything else is refused', async () => {
  const u = await t.signup();
  const origin = new URL(t.app.config.app.url).origin;
  const bad = ['https://evil.example/phish', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', `${origin}@evil.example/`, 'evil.example', 'ftp://localhost/x'];
  for (const redirect of bad) {
    const res = await t.post('/auth/magic-link', { email: u.email, redirect });
    assert.equal(res.status, 422, redirect);
    assert.ok(res.body.error.details.redirect, redirect);
  }
  await t.idle();
  assert.equal(mailsTo(t, u.email).length, 0, 'refused requests send nothing and do not start the cooldown');

  const { token, requestId } = await requestLink(t, u.email, { redirect: '/welcome?tab=1' });
  const res = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(res.status, 200);
  assert.equal(res.body.data.redirect, `${origin}/welcome?tab=1`);
});

test('cooldown: one link per address at a time, registered or not', async () => {
  const u = await t.signup();
  await requestLink(t, u.email);
  const second = await t.post('/auth/magic-link', { email: u.email });
  assert.equal(second.status, 429);
  assert.ok(Number(second.headers.get('retry-after')) > 0);
  await t.idle();
  assert.equal(mailsTo(t, u.email).length, 1);

  const stranger = 'stranger@example.test';
  assert.equal((await t.post('/auth/magic-link', { email: stranger })).status, 202);
  assert.equal((await t.post('/auth/magic-link', { email: stranger })).status, 429, 'unknown addresses behave the same');

  await endCooldown(t, u.email);
  await requestLink(t, u.email);
  assert.equal(mailsTo(t, u.email).length, 2, 'a new link once the cooldown is over');
});

test('requestId binds the link to the browser that asked for it', async () => {
  const u = await t.signup();
  const { token, requestId } = await requestLink(t, u.email);
  const wrong = await t.post('/auth/magic-link/verify', { token, requestId: 'someone-elses-id' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'OTHER_DEVICE');
  assert.equal((await t.post('/auth/magic-link/verify', { token, requestId })).status, 200, 'a refused browser does not burn the link');

  const u2 = await t.signup();
  const other = await requestLink(t, u2.email);
  assert.equal((await t.post('/auth/magic-link/verify', { token: other.token })).status, 200, 'by default a link also works on another device');

  // requireSameDevice: without the requestId the link is refused.
  const v = await t2.signup();
  const strict = await requestLink(t2, v.email);
  const res = await t2.post('/auth/magic-link/verify', { token: strict.token });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OTHER_DEVICE');
  assert.equal((await t2.post('/auth/magic-link/verify', { token: strict.token, requestId: strict.requestId })).status, 200);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'security.invalid_magic_link' && e.payload.reason === 'other_device'));
});

test('login challenges still apply: with 2FA on, the link answers with a challenge', async () => {
  const u = await t.signup({ password: 'quiet-meadow-41' });
  const { secret } = (await t.post('/auth/2fa/setup', {}, u)).body.data;
  assert.equal((await t.post('/auth/2fa/enable', { code: totp.codeAt(secret, totp.currentStep()) }, u)).status, 200);

  const { token, requestId } = await requestLink(t, u.email, { redirect: '/after' });
  const res = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.mfaRequired, true);
  assert.equal(res.body.data.token, undefined, 'no session before the second factor');
  assert.equal(res.body.data.redirect, `${new URL(t.app.config.app.url).origin}/after`, 'the redirect survives the challenge');

  const done = await t.post('/auth/2fa/verify', { mfaToken: res.body.data.mfaToken, code: totp.codeAt(secret, totp.currentStep() + 1) });
  assert.equal(done.status, 200);
  assert.match(done.body.data.token, /^calm_/);
});

test('locked and disabled accounts cannot sign in with a link', async () => {
  const u = await t.signup();
  const { token, requestId } = await requestLink(t, u.email);
  for (let i = 0; i < 5; i++) await t.post('/auth/login', { email: u.email, password: 'wrong-password-123' });
  const locked = await t.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(locked.status, 429);
  await t.app.auth.service.LoginAttempt.deleteOne({ _id: sha(`login:${u.email}`) });
  assert.equal((await t.post('/auth/magic-link/verify', { token, requestId })).status, 200, 'the lock did not burn the link');

  const d = await t.signup();
  const link = await requestLink(t, d.email);
  await t.app.model('user').updateOne({ _id: d.id }, { $set: { status: 'disabled' } });
  assert.equal((await t.post('/auth/magic-link/verify', { token: link.token, requestId: link.requestId })).status, 403);
  await endCooldown(t, d.email);
  const after = await requestLink(t, d.email);
  assert.equal(after.mails.length, 1, 'disabled accounts get no new links');
});

test('createAccount: unknown addresses get a sign-up link that creates the account on verify', async () => {
  const email = 'new.person@example.test';
  const { token, requestId, mails } = await requestLink(t2, email, { name: 'New Person' });
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Finish signing up/);
  assert.equal(await t2.app.model('user').countDocuments({ email }), 0, 'no account until the link is used');

  const res = await t2.post('/auth/magic-link/verify', { token, requestId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.created, true);
  assert.equal(res.body.data.user.name, 'New Person');
  const me = await t2.get('/auth/me', res.body.data.token);
  assert.equal(me.body.data.email, email);
  await t2.idle();
  assert.ok(events.some((e) => e.name === 'auth.registered' && e.payload.via === 'magic-link' && e.payload.user.email === email));

  // Existing addresses still get a normal sign-in link.
  const known = await t2.signup();
  assert.match((await requestLink(t2, known.email)).mails[0].subject, /^Sign in/);

  // Registration closed in config: no sign-up links, same answer.
  t2.app.config.auth.register = false;
  try {
    const closed = await requestLink(t2, 'another.person@example.test');
    assert.equal(closed.mails.length, 0);
  } finally {
    t2.app.config.auth.register = true;
  }
});
