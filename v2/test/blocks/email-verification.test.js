import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t; // required: false (the 'verified' policy only)
let tLogin; // required: 'login'
let tRoutes; // required: 'routes'
const events = [];

// A user resource whose email can change (the template makes it immutable), a resource that
// needs a verified address to write, and a route open to verified users or admins.
const USER = `
import { resource, f } from '#calm';
export default resource('user', {
  owner: '_id',
  fields: {
    name: f.string().required().max(100),
    email: f.email().required().unique().filterable().visibleTo('owner | admin'),
    password: f.password().required(),
    roles: f.array(f.enum(['user', 'admin'])).default(['user']).writableBy('admin').visibleTo('owner | admin'),
    status: f.enum(['active', 'disabled']).default('active').writableBy('admin'),
  },
  policy: { list: 'admin', read: 'owner | admin', create: 'admin', update: 'owner | admin', delete: 'admin' },
});`;
const NOTE = `
import { resource, f } from '#calm';
export default resource('note', {
  fields: { text: f.string().required(), author: f.ref('user').owner() },
  policy: { list: 'owner', read: 'owner', create: 'verified', update: 'owner', delete: 'owner' },
});`;
const ROUTES = `
export default (r) => {
  r.get('/reports', { policy: 'verified | admin' }, () => ({ ok: true }));
};`;

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files: { 'app/resources/user/user.resource.js': USER, 'app/resources/note/note.resource.js': NOTE, 'app/routes.js': ROUTES } });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'email-verification', 'magic-link', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp();
  tLogin = await project.testApp({ blocks: { 'email-verification': { required: 'login' } } });
  tRoutes = await project.testApp({ blocks: { 'email-verification': { required: 'routes' } } });
  for (const app of [t.app, tLogin.app, tRoutes.app]) app.events.on('*', (payload, name) => events.push({ name, payload }));
});
after(async () => {
  await t?.close();
  await tLogin?.close();
  await tRoutes?.close();
  project?.cleanup();
});

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const links = (tt) => tt.app.mongoose.connection.collection('calm_email_verifications');
const mailsTo = (tt, email) => tt.mails.filter((m) => m.to === email);
const tokenFrom = (mail) => decodeURIComponent(/[?&]token=([^\s&]+)/.exec(mail.text)[1]);
const lastToken = (tt, email) => tokenFrom(mailsTo(tt, email).filter((m) => m.meta?.kind === 'email-verification').at(-1));
const endCooldown = (tt, email) =>
  tt.app.mongoose.connection.collection('calm_email_verification_cooldowns').updateOne({ _id: sha(`verify:${email}`) }, { $set: { until: new Date(Date.now() - 1000) } });

async function signup(tt, extra) {
  const u = await tt.signup(extra);
  await tt.idle();
  return u;
}

test('registering sends one link, stored hashed; verifying it marks the account', async () => {
  const u = await signup(t);
  const mails = mailsTo(t, u.email);
  assert.equal(mails.length, 1);
  assert.match(mails[0].subject, /^Verify your email/);
  assert.match(mails[0].text, /\/verify-email\?token=verify_/);
  const token = tokenFrom(mails[0]);
  const raw = await links(t).findOne({ email: u.email });
  assert.equal(raw.tokenHash, sha(token), 'only the hash is stored');
  assert.ok(!JSON.stringify(raw).includes(token));
  assert.ok(raw.expiresAt - Date.now() > 23 * 3_600_000);

  const before = await t.get('/auth/me', u);
  assert.equal(before.body.data.emailVerified, false);
  assert.equal(before.body.data.emailVerifiedAt, undefined);

  const res = await t.post('/auth/verify-email', { token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.data, { verified: true, email: u.email });
  const me = await t.get('/auth/me', u);
  assert.equal(me.body.data.emailVerified, true);
  assert.ok(me.body.data.emailVerifiedAt);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'auth.email_verified' && e.payload.user.id === u.id));

  const again = await t.post('/auth/verify-email', { token });
  assert.equal(again.status, 400);
  assert.equal(again.body.error.code, 'INVALID_TOKEN');
  assert.equal((await t.post('/auth/verify-email', { token: 'verify_made_up' })).status, 400);
});

test('expired links are refused, and clients cannot set the fields themselves', async () => {
  const u = await signup(t);
  const token = lastToken(t, u.email);
  await links(t).updateOne({ tokenHash: sha(token) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const res = await t.post('/auth/verify-email', { token });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'INVALID_TOKEN');

  const patch = await t.patch('/auth/me', { emailVerified: true }, u);
  assert.equal(patch.status, 422, 'read-only');
  assert.equal((await t.get('/auth/me', u)).body.data.emailVerified, false);
});

test('resend: signed in or by address, same answer for unknown addresses, cooldown', async () => {
  const u = await signup(t);
  const first = await t.post('/auth/verify-email/resend', {}, u);
  assert.equal(first.status, 429, 'registration started the cooldown');
  assert.ok(Number(first.headers.get('retry-after')) > 0);

  await endCooldown(t, u.email);
  const ok = await t.post('/auth/verify-email/resend', {}, u);
  assert.equal(ok.status, 202);
  await t.idle();
  assert.equal(mailsTo(t, u.email).length, 2);

  const stranger = 'nobody@example.test';
  const anon = await t.post('/auth/verify-email/resend', { email: stranger });
  assert.equal(anon.status, 202);
  assert.equal(anon.body.data.message, ok.body.data.message);
  assert.equal((await t.post('/auth/verify-email/resend', { email: stranger })).status, 429, 'unknown addresses have a cooldown too');
  await t.idle();
  assert.equal(mailsTo(t, stranger).length, 0);
  assert.equal((await t.post('/auth/verify-email/resend', {})).status, 422, 'signed out needs an email');

  await endCooldown(t, u.email);
  assert.equal((await t.post('/auth/verify-email/resend', { email: u.email })).status, 202);
  await t.idle();
  assert.equal(mailsTo(t, u.email).length, 3);

  // Both links work until one is used; the other ones are spent with it.
  const tokens = mailsTo(t, u.email).map(tokenFrom);
  assert.equal((await t.post('/auth/verify-email', { token: tokens[1] })).status, 200);
  assert.equal((await t.post('/auth/verify-email', { token: tokens[2] })).status, 400);
  const done = await t.post('/auth/verify-email/resend', {}, u);
  assert.equal(done.status, 200);
  assert.equal(done.body.data.verified, true);
});

test("the 'verified' policy answers EMAIL_NOT_VERIFIED, and other alternatives still apply", async () => {
  const u = await signup(t);
  const refused = await t.post('/notes', { text: 'hi' }, u);
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await t.post('/notes', { text: 'hi' })).status, 401, 'signed out is still 401');
  assert.equal((await t.get('/reports', u)).body.error.code, 'EMAIL_NOT_VERIFIED');

  const admin = await signup(t, { roles: ['user', 'admin'] });
  assert.equal((await t.get('/reports', admin)).status, 200, "'verified | admin' lets an unverified admin in");

  assert.equal((await t.post('/auth/verify-email', { token: lastToken(t, u.email) })).status, 200);
  assert.equal((await t.post('/notes', { text: 'hi' }, u)).status, 201);
  assert.equal((await t.get('/reports', u)).status, 200);
});

test('changing the address resets verification, spends old links and tells the old address', async () => {
  const u = await signup(t);
  const oldToken = lastToken(t, u.email);
  const unusedOld = await signup(t);
  assert.equal((await t.post('/auth/verify-email', { token: lastToken(t, unusedOld.email) })).status, 200);

  // A verified user changes address.
  const next = `changed_${Date.now()}@example.test`;
  const res = await t.patch('/auth/me', { email: next }, unusedOld);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.emailVerified, false);
  assert.equal(res.body.data.emailVerifiedAt, undefined);
  await t.idle();
  assert.ok(mailsTo(t, unusedOld.email).some((m) => m.meta?.kind === 'email-changed' && !m.text.includes(next)), 'notice to the old address, new one masked');
  const fresh = lastToken(t, next);
  assert.ok(fresh, 'a link to the new address');

  // An unverified user changes address: the link sent to the old address stops working.
  await t.patch('/auth/me', { email: `second_${Date.now()}@example.test` }, u);
  await t.idle();
  assert.equal((await t.post('/auth/verify-email', { token: oldToken })).status, 400);

  assert.equal((await t.post('/auth/verify-email', { token: fresh })).status, 200);
  assert.equal((await t.get('/auth/me', unusedOld)).body.data.emailVerified, true);
});

test('admins can mark an address verified', async () => {
  const u = await signup(t);
  const admin = await signup(t, { roles: ['user', 'admin'] });
  assert.equal((await t.post(`/admin/users/${u.id}/verify-email`, {}, u)).status, 403);
  assert.equal((await t.post('/admin/users/000000000000000000000000/verify-email', {}, admin)).status, 404);
  assert.equal((await t.post(`/admin/users/${u.id}/verify-email`, {}, admin)).status, 200);
  assert.equal((await t.get('/auth/me', u)).body.data.emailVerified, true);
  assert.equal((await t.post(`/admin/users/${u.id}/verify-email`, {}, admin)).status, 200, 'idempotent');
});

test("required: 'login' refuses sign-in with a fresh link, and the register session is limited", async () => {
  const u = await signup(tLogin, { password: 'quiet-meadow-41' });
  assert.equal(mailsTo(tLogin, u.email).length, 1);

  // The session from register only reaches the verification routes and the profile.
  assert.equal((await tLogin.get('/auth/me', u)).status, 200);
  const blocked = await tLogin.get('/auth/sessions', u);
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await tLogin.get('/posts', u)).status, 200, 'public routes stay open');

  await endCooldown(tLogin, u.email);
  const login = await tLogin.post('/auth/login', { email: u.email, password: 'quiet-meadow-41' });
  assert.equal(login.status, 403);
  assert.equal(login.body.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal(login.body.data, undefined, 'no session');
  await tLogin.idle();
  assert.equal(mailsTo(tLogin, u.email).length, 2, 'a fresh link');
  const again = await tLogin.post('/auth/login', { email: u.email, password: 'quiet-meadow-41' });
  assert.equal(again.status, 403);
  await tLogin.idle();
  assert.equal(mailsTo(tLogin, u.email).length, 2, 'but not one per attempt (cooldown)');
  assert.equal((await tLogin.post('/auth/login', { email: u.email, password: 'wrong-password-1' })).status, 401, 'a wrong password says nothing about verification');

  assert.equal((await tLogin.post('/auth/verify-email', { token: lastToken(tLogin, u.email) })).status, 200);
  const ok = await tLogin.post('/auth/login', { email: u.email, password: 'quiet-meadow-41' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.user.emailVerified, true);
  assert.equal((await tLogin.get('/auth/sessions', ok.body.data.token)).status, 200);
});

test('signing in with a magic link proves the inbox, even when verification is required', async () => {
  const u = await signup(tLogin);
  const asked = await tLogin.post('/auth/magic-link', { email: u.email });
  assert.equal(asked.status, 202);
  await tLogin.idle();
  const mail = tLogin.mails.filter((m) => m.to === u.email && m.meta?.kind === 'magic-link').at(-1);
  const res = await tLogin.post('/auth/magic-link/verify', { token: mail.meta.token, requestId: asked.body.data.requestId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.user.emailVerified, true);
  assert.equal((await tLogin.get('/auth/sessions', res.body.data.token)).status, 200);
});

test("required: 'routes' lets people sign in but closes non public routes", async () => {
  const u = await signup(tRoutes, { password: 'quiet-meadow-41' });
  const login = await tRoutes.post('/auth/login', { email: u.email, password: 'quiet-meadow-41' });
  assert.equal(login.status, 200);
  const token = login.body.data.token;
  assert.equal((await tRoutes.get('/auth/sessions', token)).body.error.code, 'EMAIL_NOT_VERIFIED');
  assert.equal((await tRoutes.post('/posts', { title: 'x', body: 'y' }, token)).status, 403);
  assert.equal((await tRoutes.get('/posts', token)).status, 200);
  assert.equal((await tRoutes.patch('/auth/me', { name: 'Fixed Name' }, token)).status, 200, 'the profile can still be fixed');
  assert.equal((await tRoutes.post('/auth/verify-email', { token: lastToken(tRoutes, u.email) })).status, 200);
  assert.equal((await tRoutes.post('/posts', { title: 'x', body: 'y' }, token)).status, 201);
});

test('doctor stays clean', async () => {
  assert.deepEqual((await t.app.doctor()).filter((f) => f.level === 'error'), []);
  const info = (await tLogin.app.doctor()).filter((f) => f.id === 'email-verification-older-accounts');
  assert.equal(info.length, 0, 'every account here was created with the block');
});
