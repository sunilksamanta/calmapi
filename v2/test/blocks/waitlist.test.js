import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t; // open registration
let gated; // gate: true, with magic-link sign-ups
let admin;
let gatedAdmin;
const events = [];

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'waitlist', 'magic-link', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({ blocks: { waitlist: { confirmationEmail: true } } });
  gated = await project.testApp({ blocks: { waitlist: { gate: true }, 'magic-link': { createAccount: true } } });
  for (const app of [t.app, gated.app]) app.events.on('*', (payload, name) => events.push({ name, payload }));
  admin = await t.signup({ roles: ['user', 'admin'] });
  // The gate lets admins create users, so the first admin of a gated app is made directly.
  const user = await gated.app.service('user').create({ name: 'Admin', email: 'admin@example.test', password: 'correct-horse-battery', roles: ['user', 'admin'] }, { system: true });
  gatedAdmin = (await gated.post('/auth/login', { email: user.email, password: 'correct-horse-battery' })).body.data;
});
after(async () => {
  await t?.close();
  await gated?.close();
  project?.cleanup();
});

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const entries = (tt) => tt.app.mongoose.connection.collection('calm_waitlist');
const inviteFrom = (tt, email) => {
  const mail = tt.mails.filter((m) => m.to === email && m.meta?.kind === 'waitlist-invite').at(-1);
  return mail ? decodeURIComponent(/[?&]invite=([^\s&]+)/.exec(mail.text)[1]) : null;
};

test('joining gives a place and a referral code; joining again changes nothing', async () => {
  const a = await t.post('/waitlist', { email: 'Ada@Example.test', name: 'Ada' });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.data.status, 'waiting');
  assert.equal(a.body.data.position, 1);
  assert.match(a.body.data.referralCode, /^[A-Z2-9]{10}$/);
  assert.equal(a.body.data.referralUrl, `${t.app.config.app.url}/waitlist?ref=${a.body.data.referralCode}`);

  const again = await t.post('/waitlist', { email: 'ada@example.test', name: 'Someone else', referralCode: 'NOPE' });
  assert.equal(again.status, 200);
  assert.equal(again.body.data.referralCode, a.body.data.referralCode);
  assert.equal(await entries(t).countDocuments({ email: 'ada@example.test' }), 1);
  assert.equal((await entries(t).findOne({ email: 'ada@example.test' })).name, 'Ada', 'a second join cannot rename the entry');

  const b = await t.post('/waitlist', { email: 'bob@example.test' });
  assert.equal(b.body.data.position, 2);
  assert.equal(b.body.data.waiting, 2);
  assert.equal((await t.post('/waitlist', { email: 'not-an-email' })).status, 422);

  const status = await t.get(`/waitlist/${a.body.data.referralCode.toLowerCase()}`);
  assert.equal(status.status, 200);
  assert.equal(status.body.data.position, 1);
  assert.equal((await t.get('/waitlist/ZZZZZZZZZZ')).status, 404);
  await t.idle();
  assert.ok(t.mails.some((m) => m.to === 'bob@example.test' && m.meta?.kind === 'waitlist-joined' && /number 2 in line/.test(m.text)));
});

test('referrals move people up, within the cap', async () => {
  await entries(t).deleteMany({});
  const first = (await t.post('/waitlist', { email: 'r1@example.test' })).body.data;
  for (let i = 2; i <= 8; i++) await t.post('/waitlist', { email: `r${i}@example.test` });
  const last = (await t.post('/waitlist', { email: 'r9@example.test' })).body.data;
  assert.equal(last.position, 9);

  // Two friends join with r9's code: 2 x 5 places.
  await t.post('/waitlist', { email: 'friend1@example.test', referralCode: last.referralCode });
  await t.post('/waitlist', { email: 'friend2@example.test', referralCode: last.referralCode.toLowerCase() });
  const moved = (await t.get(`/waitlist/${last.referralCode}`)).body.data;
  assert.equal(moved.referrals, 2);
  assert.equal(moved.position, 1, 'from 9th to the front');
  assert.equal((await t.get(`/waitlist/${first.referralCode}`)).body.data.position, 2);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'waitlist.referred'));

  // The cap: maxReferrals counts at most.
  const capped = await project.testApp({ blocks: { waitlist: { maxReferrals: 1 } } });
  try {
    const owner = (await capped.post('/waitlist', { email: 'owner@example.test' })).body.data;
    for (const n of [1, 2, 3]) await capped.post('/waitlist', { email: `f${n}@example.test`, referralCode: owner.referralCode });
    assert.equal((await capped.get(`/waitlist/${owner.referralCode}`)).body.data.referrals, 1);
  } finally {
    await capped.close();
  }
});

test('admins list in line order, see stats, invite and remove; others cannot', async () => {
  await entries(t).deleteMany({});
  for (let i = 1; i <= 5; i++) await t.post('/waitlist', { email: `line${i}@example.test`, name: `Line ${i}` });
  const user = await t.signup();
  assert.equal((await t.get('/admin/waitlist', user)).status, 403);
  assert.equal((await t.get('/admin/waitlist')).status, 401);
  assert.equal((await t.post('/admin/waitlist/invite', { count: 1 }, user)).status, 403);

  const list = await t.get('/admin/waitlist?limit=2&page=2', admin);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.data.map((e) => [e.email, e.position]), [['line3@example.test', 3], ['line4@example.test', 4]]);
  assert.equal(list.body.meta.total, 5);
  assert.equal((await t.get('/admin/waitlist?q=line5', admin)).body.data[0].position, 5);
  assert.equal((await t.get('/admin/waitlist?status=nope', admin)).status, 400);

  const bulk = await t.post('/admin/waitlist/invite', { count: 2 }, admin);
  assert.equal(bulk.status, 200, JSON.stringify(bulk.body));
  assert.deepEqual(bulk.body.data.invited.map((e) => e.email), ['line1@example.test', 'line2@example.test']);
  await t.idle();
  const token = inviteFrom(t, 'line1@example.test');
  assert.match(token, /^invite_/);
  const raw = await entries(t).findOne({ email: 'line1@example.test' });
  assert.equal(raw.status, 'invited');
  assert.equal(raw.inviteTokenHash, sha(token), 'only the hash is stored');
  assert.equal((await t.get('/admin/waitlist', admin)).body.data[0].email, 'line3@example.test', 'invited people leave the line');

  const line5 = (await t.get('/admin/waitlist?q=line5', admin)).body.data[0];
  const one = await t.post(`/admin/waitlist/${line5.id}/invite`, {}, admin);
  assert.equal(one.body.data.status, 'invited');
  assert.equal((await t.post('/admin/waitlist/000000000000000000000000/invite', {}, admin)).status, 404);

  // Registering (no gate here) completes the entry.
  await t.signup({ email: 'line1@example.test' });
  await t.idle();
  assert.equal((await entries(t).findOne({ email: 'line1@example.test' })).status, 'registered');

  const stats = (await t.get('/admin/waitlist/stats', admin)).body.data;
  assert.deepEqual({ total: stats.total, waiting: stats.waiting, invited: stats.invited, registered: stats.registered }, { total: 5, waiting: 2, invited: 2, registered: 1 });
  assert.equal(stats.conversion, 0.333);
  assert.equal(stats.joined.last24h, 5);

  const line4 = (await t.get('/admin/waitlist?q=line4', admin)).body.data[0];
  assert.equal((await t.delete(`/admin/waitlist/${line4.id}`, admin)).status, 204);
  assert.equal((await t.delete(`/admin/waitlist/${line4.id}`, admin)).status, 404);
});

test('gate: only invited addresses register, with their own single use token', async () => {
  const password = 'correct-horse-battery';
  const refused = await gated.post('/auth/register', { name: 'X', email: 'nobody@example.test', password });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'INVITE_REQUIRED');

  await gated.post('/waitlist', { email: 'invitee@example.test' });
  await gated.post('/waitlist', { email: 'other@example.test' });
  const entry = (await gated.get('/admin/waitlist?q=invitee', gatedAdmin.token)).body.data[0];
  await gated.post(`/admin/waitlist/${entry.id}/invite`, {}, gatedAdmin.token);
  await gated.idle();
  const token = inviteFrom(gated, 'invitee@example.test');

  assert.equal((await gated.post('/auth/register', { name: 'I', email: 'invitee@example.test', password })).status, 403, 'the token is required');
  assert.equal((await gated.post('/auth/register', { name: 'I', email: 'invitee@example.test', password, inviteToken: 'invite_wrong' })).status, 403);
  assert.equal((await gated.post('/auth/register', { name: 'O', email: 'other@example.test', password, inviteToken: token })).status, 403, 'bound to the invited address');

  const ok = await gated.post('/auth/register', { name: 'Invitee', email: 'invitee@example.test', password, inviteToken: token });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  await gated.idle();
  const raw = await entries(gated).findOne({ email: 'invitee@example.test' });
  assert.equal(raw.status, 'registered');
  assert.equal(raw.inviteTokenHash, null, 'the token is spent');
  assert.equal(String(raw.user), ok.body.data.user.id);
  assert.equal((await gated.post('/auth/register', { name: 'Again', email: 'invitee@example.test', password, inviteToken: token })).status, 403);

  // An expired invite is refused too.
  const late = (await gated.get('/admin/waitlist?q=other', gatedAdmin.token)).body.data[0];
  await gated.post(`/admin/waitlist/${late.id}/invite`, {}, gatedAdmin.token);
  await gated.idle();
  await entries(gated).updateOne({ email: 'other@example.test' }, { $set: { inviteExpiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await gated.post('/auth/register', { name: 'O', email: 'other@example.test', password, inviteToken: inviteFrom(gated, 'other@example.test') })).status, 403);
  await gated.idle();
  assert.ok(events.some((e) => e.name === 'security.invite_refused'));
});

test('gate: other sign-up paths need an invited address; admins can still create users', async () => {
  // magic-link sign-up for an address that is not invited: refused when the account would be created.
  await gated.post('/auth/magic-link', { email: 'stranger@example.test' });
  await gated.idle();
  const mail = gated.mails.filter((m) => m.to === 'stranger@example.test').at(-1);
  const token = decodeURIComponent(/[?&]token=([^\s&]+)/.exec(mail.text)[1]);
  const res = await gated.post('/auth/magic-link/verify', { token });
  assert.equal(res.status, 403);
  assert.equal(res.body.error.code, 'INVITE_REQUIRED');

  // Invited: the magic link proves the inbox, so no invite token is needed.
  await gated.post('/waitlist', { email: 'linked@example.test' });
  const entry = (await gated.get('/admin/waitlist?q=linked', gatedAdmin.token)).body.data[0];
  await gated.post(`/admin/waitlist/${entry.id}/invite`, {}, gatedAdmin.token);
  await gated.post('/auth/magic-link', { email: 'linked@example.test' });
  await gated.idle();
  const link = gated.mails.filter((m) => m.to === 'linked@example.test' && m.meta?.kind === 'magic-link').at(-1);
  const ok = await gated.post('/auth/magic-link/verify', { token: decodeURIComponent(/[?&]token=([^\s&]+)/.exec(link.text)[1]) });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.data.created, true);

  const created = await gated.post('/users', { name: 'Made', email: 'made@example.test', password: 'correct-horse-battery' }, gatedAdmin.token);
  assert.equal(created.status, 201, 'admins are not gated');
});

test('without the gate an inviteToken in the register body is ignored, and doctor is clean', async () => {
  const res = await t.post('/auth/register', { name: 'N', email: 'free@example.test', password: 'correct-horse-battery', inviteToken: 'anything' });
  assert.equal(res.status, 201);
  assert.deepEqual((await t.app.doctor()).filter((x) => x.level === 'error'), []);
});
