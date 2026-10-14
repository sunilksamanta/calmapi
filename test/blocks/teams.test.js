import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// Named policies (calm.policy) are registered per process, so this file runs one app at a time:
// the main app first, then the tests that boot their own (options, audit) at the end.

let project;
let t;
const events = [];

const files = {
  // The key feature: team-scoped data. 'member' and 'team:admin' come from the block.
  'app/resources/project/project.resource.js': `
import { resource, f } from '#calm';
export default resource('project', {
  team: true,
  fields: {
    name: f.string().required().max(100).filterable().sortable(),
    budget: f.number().visibleTo('team:admin'),
    author: f.ref('user').owner(),
  },
  policy: { list: 'member', read: 'member', create: 'member', update: 'team:admin | owner', delete: 'team:admin' },
});`,
  // Team-scoped with loose policies: isolation must not depend on the policy.
  'app/resources/memo/memo.resource.js': `
import { resource, f } from '#calm';
export default resource('memo', {
  team: true,
  fields: { text: f.string().required().max(200) },
  policy: { list: 'authenticated', read: 'authenticated', create: 'authenticated', update: 'authenticated', delete: 'admin' },
});`,
  // Listed by admins only: the list shows only teams where the caller is an admin.
  'app/resources/ledger/ledger.resource.js': `
import { resource, f } from '#calm';
export default resource('ledger', {
  team: true,
  fields: { label: f.string().required().max(100) },
  policy: { list: 'team:admin', read: 'team:admin', create: 'team:admin', update: 'team:admin', delete: 'team:owner' },
});`,
  'app/routes.js': `
export default (r) => {
  r.get('/reports/:teamId', { policy: 'team:admin', summary: 'A team report' }, (ctx) => ({ team: ctx.params.teamId }));
  r.get('/active-team', { policy: 'member', summary: 'The X-Team team' }, (ctx) => ctx.team);
};`,
};

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'teams', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp();
  t.app.events.on('*', (payload, name) => events.push({ name, payload }));
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const invitations = (tt = t) => tt.app.mongoose.connection.collection('calm_team_invitations');
const tokenFrom = (mail) => decodeURIComponent(/[?&]token=([^\s&]+)/.exec(mail.text)[1]);
const lastMailTo = (email, tt = t) => tt.mails.filter((m) => m.to === email).at(-1);
const ext = () => t.app.ext.teams;

/** A request with an X-Team header. */
async function withTeam(method, path, team, who, body) {
  const res = await fetch(`${t.origin}/api${path}`, {
    method,
    headers: { 'x-team': team, ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function makeTeam(owner, name = 'Acme') {
  const res = await t.post('/teams', { name }, owner);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data.id;
}

/** Invite through the API and accept with the emailed token; returns the token. */
async function inviteAndAccept(teamId, by, who, role) {
  const res = await t.post(`/teams/${teamId}/invitations`, { email: who.email, ...(role ? { role } : {}) }, by);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  await t.idle();
  const token = tokenFrom(lastMailTo(who.email));
  const ok = await t.post('/teams/invitations/accept', { token }, who);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  return token;
}

// ---- teams -------------------------------------------------------------------------------

test('creating a team makes you its owner; list, get, update, delete', async () => {
  const owner = await t.signup({ name: 'Olive' });
  const stranger = await t.signup();
  const res = await t.post('/teams', { name: 'Acme Rockets' }, owner);
  assert.equal(res.status, 201);
  assert.equal(res.body.data.name, 'Acme Rockets');
  assert.equal(res.body.data.slug, 'acme-rockets');
  assert.equal(res.body.data.role, 'owner');
  const id = res.body.data.id;
  assert.ok(events.some((e) => e.name === 'team.created' && e.payload.team.id === id && e.payload.userId === owner.id));

  // Slugs stay unique.
  const again = await t.post('/teams', { name: 'Acme Rockets' }, stranger);
  assert.match(again.body.data.slug, /^acme-rockets-[a-z0-9]+$/);
  assert.equal((await t.post('/teams', { name: 'X', slug: 'acme-rockets' }, stranger)).status, 409);
  assert.equal((await t.post('/teams', { name: 'X', slug: 'Not A Slug' }, stranger)).status, 422);
  assert.equal((await t.post('/teams', { name: 'X', role: 'owner' }, stranger)).status, 422, 'unknown fields are refused');
  assert.equal((await t.post('/teams', { name: 'X' })).status, 401);

  const mine = await t.get('/teams', owner);
  assert.deepEqual(mine.body.data.map((x) => [x.id, x.role]), [[id, 'owner']]);
  assert.equal((await t.get(`/teams/${id}`, owner)).body.data.name, 'Acme Rockets');
  assert.equal((await t.get(`/teams/${id}`, stranger)).status, 403);
  assert.equal((await t.get('/teams/not-an-id', stranger)).status, 403);
  assert.equal((await t.get(`/teams/${'f'.repeat(24)}`, stranger)).status, 403, 'unknown and foreign teams look the same');

  assert.equal((await t.patch(`/teams/${id}`, { name: 'Acme' }, stranger)).status, 403);
  const renamed = await t.patch(`/teams/${id}`, { name: 'Acme', slug: 'acme-co' }, owner);
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.data.slug, 'acme-co');

  const member = await t.signup();
  await ext().addMember(id, member.id, 'member');
  assert.equal((await t.patch(`/teams/${id}`, { name: 'Hijacked' }, member)).status, 403, 'members cannot rename');
  assert.equal((await t.delete(`/teams/${id}`, member)).status, 403);
  const admin = await t.signup();
  await ext().addMember(id, admin.id, 'admin');
  assert.equal((await t.patch(`/teams/${id}`, { name: 'Acme Inc' }, admin)).status, 200, 'admins can rename');
  assert.equal((await t.delete(`/teams/${id}`, admin)).status, 403, 'only owners delete');

  const project1 = await t.post('/projects', { name: 'Doomed', team: id }, owner);
  assert.equal(project1.status, 201);
  assert.equal((await t.delete(`/teams/${id}`, owner)).status, 204);
  assert.equal((await t.get(`/teams/${id}`, owner)).status, 403);
  assert.equal((await t.get('/teams', member)).body.data.length, 0);
  assert.equal(await t.app.model('project').countDocuments({ team: id }), 0, 'team records are deleted with the team');
  assert.ok(events.some((e) => e.name === 'team.deleted' && e.payload.team.id === id && e.payload.records.project === 1));
});

// ---- invitations ---------------------------------------------------------------------------

test('an invitation is emailed with a single use link, stored hashed, accepted by the invited address', async () => {
  const owner = await t.signup({ name: 'Olga' });
  const teamId = await makeTeam(owner, 'Invites');
  const bob = await t.signup({ name: 'Bob' });
  const carol = await t.signup();

  const res = await t.post(`/teams/${teamId}/invitations`, { email: bob.email.toUpperCase(), role: 'admin' }, owner);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  assert.equal(res.body.data.email, bob.email, 'addresses are lowercased');
  assert.equal(res.body.data.status, 'pending');
  assert.equal(res.body.data.token, undefined);
  await t.idle();
  const mail = lastMailTo(bob.email);
  assert.equal(mail.subject, `Olga invited you to Invites on ${t.app.config.app.name}`);
  assert.match(mail.text, new RegExp(`${t.app.config.app.url.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/invite\\?token=invite_`));
  const token = tokenFrom(mail);
  const raw = await invitations().findOne({ _id: t.app.mongoose.Types.ObjectId.createFromHexString(res.body.data.id) });
  assert.equal(raw.tokenHash, sha(token), 'only the hash is stored');
  assert.ok(!JSON.stringify(raw).includes(token));
  assert.ok(events.some((e) => e.name === 'team.invitation_sent' && e.payload.email === bob.email && e.payload.role === 'admin'));

  // The link page can show what it is about before anyone signs in.
  const look = await t.post('/teams/invitations/lookup', { token });
  assert.equal(look.status, 200);
  assert.deepEqual([look.body.data.team.name, look.body.data.role, look.body.data.email, look.body.data.invitedBy.name], ['Invites', 'admin', bob.email, 'Olga']);
  assert.equal((await t.post('/teams/invitations/lookup', { token: 'invite_nope' })).status, 400);

  // Someone else holding the link cannot use it, and does not burn it.
  const wrong = await t.post('/teams/invitations/accept', { token }, carol);
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.error.code, 'INVITATION_EMAIL');
  assert.equal((await t.post('/teams/invitations/accept', { token })).status, 401);

  const ok = await t.post('/teams/invitations/accept', { token }, bob);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.deepEqual([ok.body.data.id, ok.body.data.role], [teamId, 'admin']);
  assert.ok(events.some((e) => e.name === 'team.member_added' && e.payload.userId === bob.id && e.payload.via === 'invitation'));
  assert.equal((await t.get(`/teams/${teamId}`, bob)).status, 200);

  const twice = await t.post('/teams/invitations/accept', { token }, bob);
  assert.equal(twice.status, 400, 'single use');
  assert.equal(twice.body.error.code, 'INVALID_INVITATION');
  assert.equal((await t.post('/teams/invitations/lookup', { token })).status, 400);
  assert.equal((await t.post('/teams/invitations/accept', { token: 'invite_made_up' }, bob)).status, 400);
  assert.ok(events.some((e) => e.name === 'security.invalid_team_invitation' && e.payload.reason === 'wrong_email'));

  const members = await t.get(`/teams/${teamId}/members`, bob);
  assert.deepEqual(members.body.data.map((m) => [m.user.name, m.role]), [['Olga', 'owner'], ['Bob', 'admin']]);
  assert.equal(members.body.data[1].user.email, bob.email);
  assert.equal((await t.get(`/teams/${teamId}/members`, carol)).status, 403);
});

test('expired, revoked and replaced invitations do not work; resend has a cooldown', async () => {
  const owner = await t.signup();
  const teamId = await makeTeam(owner, 'Expiry');
  const dave = await t.signup();
  const erin = await t.signup();

  const first = await t.post(`/teams/${teamId}/invitations`, { email: dave.email }, owner);
  assert.equal(first.body.data.role, 'member', 'defaultRole');
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: dave.email }, owner)).body.error.code, 'ALREADY_INVITED');
  await t.idle();
  const oldToken = tokenFrom(lastMailTo(dave.email));

  // Resend: refused during the cooldown, then a new link that replaces the old one.
  const early = await t.post(`/teams/${teamId}/invitations/${first.body.data.id}/resend`, {}, owner);
  assert.equal(early.status, 429);
  assert.ok(Number(early.headers.get('retry-after')) > 0);
  await invitations().updateOne({ tokenHash: sha(oldToken) }, { $set: { lastSentAt: new Date(Date.now() - 120_000) } });
  const resent = await t.post(`/teams/${teamId}/invitations/${first.body.data.id}/resend`, {}, owner);
  assert.equal(resent.status, 200, JSON.stringify(resent.body));
  await t.idle();
  const newToken = tokenFrom(lastMailTo(dave.email));
  assert.notEqual(newToken, oldToken);
  assert.equal((await t.post('/teams/invitations/accept', { token: oldToken }, dave)).status, 400, 'the old link stopped working');

  // Expired.
  await invitations().updateOne({ tokenHash: sha(newToken) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  assert.equal((await t.post('/teams/invitations/accept', { token: newToken }, dave)).status, 400);
  assert.equal((await t.get(`/teams/${teamId}`, dave)).status, 403);
  // An expired invitation no longer blocks a new one, and cannot be revived by a resend.
  const fresh = await t.post(`/teams/${teamId}/invitations`, { email: dave.email }, owner);
  assert.equal(fresh.status, 201);
  await invitations().updateOne({ tokenHash: sha(newToken) }, { $set: { lastSentAt: new Date(Date.now() - 120_000) } });
  assert.equal((await t.post(`/teams/${teamId}/invitations/${first.body.data.id}/resend`, {}, owner)).status, 404);

  // Revoked.
  const toErin = await t.post(`/teams/${teamId}/invitations`, { email: erin.email }, owner);
  await t.idle();
  const erinToken = tokenFrom(lastMailTo(erin.email));
  const listed = await t.get(`/teams/${teamId}/invitations`, owner);
  assert.deepEqual(listed.body.data.map((i) => i.email).sort(), [dave.email, erin.email].sort());
  assert.equal((await t.delete(`/teams/${teamId}/invitations/${toErin.body.data.id}`, owner)).status, 204);
  assert.equal((await t.delete(`/teams/${teamId}/invitations/${toErin.body.data.id}`, owner)).status, 404);
  assert.equal((await t.post('/teams/invitations/accept', { token: erinToken }, erin)).status, 400);
  assert.ok(events.some((e) => e.name === 'security.invalid_team_invitation' && e.payload.reason === 'revoked'));

  // Invitations of one team cannot be touched through another.
  const other = await t.signup();
  const otherTeam = await makeTeam(other, 'Other');
  assert.equal((await t.delete(`/teams/${otherTeam}/invitations/${fresh.body.data.id}`, other)).status, 404);
  assert.equal((await t.delete(`/teams/${teamId}/invitations/${fresh.body.data.id}`, other)).status, 403);

  // Members already in the team cannot be invited again.
  await ext().addMember(teamId, erin.id, 'member');
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: erin.email }, owner)).body.error.code, 'ALREADY_MEMBER');
});

test('who may invite, and which roles they may give', async () => {
  const owner = await t.signup();
  const teamId = await makeTeam(owner, 'Roles');
  const admin = await t.signup();
  const member = await t.signup();
  await ext().addMember(teamId, admin.id, 'admin');
  await ext().addMember(teamId, member.id, 'member');

  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: 'x1@example.test' }, member)).status, 403, 'members cannot invite by default');
  assert.equal((await t.get(`/teams/${teamId}/invitations`, member)).status, 403);
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: 'x2@example.test', role: 'owner' }, admin)).status, 403, 'admins cannot invite owners');
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: 'x3@example.test', role: 'admin' }, admin)).status, 201);
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: 'x4@example.test', role: 'owner' }, owner)).status, 201, 'owners can');
  assert.equal((await t.post(`/teams/${teamId}/invitations`, { email: 'x5@example.test', role: 'boss' }, owner)).status, 422);
});

// ---- members and roles --------------------------------------------------------------------

test('role rules: admins manage members but not owners, only owners make owners, the last owner stays', async () => {
  const owner = await t.signup();
  const teamId = await makeTeam(owner, 'Rules');
  const admin = await t.signup();
  const member = await t.signup();
  const other = await t.signup();
  await inviteAndAccept(teamId, owner, admin, 'admin');
  await inviteAndAccept(teamId, owner, member);
  await ext().addMember(teamId, other.id, 'member');
  const role = (u, r, by) => t.patch(`/teams/${teamId}/members/${u.id}`, { role: r }, by);

  assert.equal((await role(other, 'admin', member)).status, 403, 'members cannot change roles');
  assert.equal((await role(member, 'owner', admin)).status, 403, 'admins cannot make owners');
  assert.equal((await role(owner, 'member', admin)).status, 403, 'admins cannot demote owners');
  assert.equal((await t.delete(`/teams/${teamId}/members/${owner.id}`, admin)).status, 403, 'admins cannot remove owners');
  assert.equal((await role(member, 'superuser', owner)).status, 422);
  assert.equal((await role({ id: 'f'.repeat(24) }, 'admin', owner)).status, 404);

  const promoted = await role(member, 'admin', admin);
  assert.equal(promoted.status, 200);
  assert.ok(events.some((e) => e.name === 'team.role_changed' && e.payload.userId === member.id && e.payload.from === 'member' && e.payload.to === 'admin'));
  assert.equal((await role(member, 'member', admin)).status, 200, 'admins manage admins');

  // The last owner.
  const lastOwner = await role(owner, 'admin', owner);
  assert.equal(lastOwner.status, 409);
  assert.equal(lastOwner.body.error.code, 'LAST_OWNER');
  assert.equal((await t.post(`/teams/${teamId}/leave`, {}, owner)).body.error.code, 'LAST_OWNER');
  assert.equal((await t.delete(`/teams/${teamId}/members/${owner.id}`, owner)).body.error.code, 'LAST_OWNER');

  // Owners make owners; then the first owner may step down.
  assert.equal((await role(admin, 'owner', owner)).status, 200);
  assert.equal((await role(owner, 'admin', owner)).status, 200);
  assert.equal((await role(admin, 'member', owner)).status, 403, 'a new admin cannot demote the owner');

  // Removing and leaving.
  assert.equal((await t.delete(`/teams/${teamId}/members/${other.id}`, member)).status, 403);
  assert.equal((await t.delete(`/teams/${teamId}/members/${other.id}`, owner)).status, 204, 'admins remove members');
  assert.ok(events.some((e) => e.name === 'team.member_removed' && e.payload.userId === other.id && e.payload.reason === 'removed'));
  assert.equal((await t.post(`/teams/${teamId}/leave`, {}, member)).status, 204);
  assert.ok(events.some((e) => e.name === 'team.member_removed' && e.payload.userId === member.id && e.payload.reason === 'left'));
  assert.equal((await t.get(`/teams/${teamId}`, member)).status, 403);
  assert.equal((await t.post(`/teams/${teamId}/leave`, {}, member)).status, 403);
});

test('transfer ownership', async () => {
  const owner = await t.signup();
  const teamId = await makeTeam(owner, 'Transfer');
  const next = await t.signup();
  const outsider = await t.signup();
  await ext().addMember(teamId, next.id, 'member');

  assert.equal((await t.post(`/teams/${teamId}/transfer`, { userId: owner.id }, next)).status, 403, 'members cannot transfer');
  assert.equal((await t.post(`/teams/${teamId}/transfer`, { userId: outsider.id }, owner)).status, 422, 'only to a member');
  assert.equal((await t.post(`/teams/${teamId}/transfer`, { userId: owner.id }, owner)).status, 422);
  const res = await t.post(`/teams/${teamId}/transfer`, { userId: next.id }, owner);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const roles = Object.fromEntries((await t.get(`/teams/${teamId}/members`, next)).body.data.map((m) => [m.user.id, m.role]));
  assert.deepEqual(roles, { [owner.id]: 'admin', [next.id]: 'owner' });
  assert.equal((await t.delete(`/teams/${teamId}`, owner)).status, 403, 'the previous owner is an admin now');
  assert.equal((await t.post(`/teams/${teamId}/leave`, {}, owner)).status, 204);
});

// ---- team-scoped resources -----------------------------------------------------------------

test('team-scoped records never cross teams: list, read, update, delete, guessed ids', async () => {
  const alice = await t.signup();
  const bob = await t.signup();
  const teamA = await makeTeam(alice, 'Team A');
  const teamB = await makeTeam(bob, 'Team B');

  const a1 = await t.post('/projects', { name: 'Alpha', team: teamA }, alice);
  assert.equal(a1.status, 201, JSON.stringify(a1.body));
  assert.equal(a1.body.data.team, teamA);
  const b1 = (await t.post('/projects', { name: 'Bravo', team: teamB }, bob)).body.data;

  const listA = await t.get('/projects', alice);
  assert.deepEqual(listA.body.data.map((p) => p.name), ['Alpha']);
  assert.equal(listA.body.meta.total, 1);
  assert.equal((await t.get(`/projects?team=${teamB}`, alice)).status, 403, 'asking for a foreign team is refused');
  assert.equal((await t.get(`/projects/${b1.id}`, alice)).status, 404, 'a guessed id is not found');
  assert.equal((await t.patch(`/projects/${b1.id}`, { name: 'Pwned' }, alice)).status, 404);
  assert.equal((await t.delete(`/projects/${b1.id}`, alice)).status, 404);
  assert.equal((await t.get(`/projects?name=Bravo`, alice)).body.data.length, 0, 'filters cannot reach other teams');
  assert.equal((await t.get('/projects')).status, 401);

  // Creating in a team you are not in, with the body or the header.
  assert.equal((await t.post('/projects', { name: 'Intruder', team: teamB }, alice)).status, 403);
  assert.equal((await withTeam('POST', '/projects', teamB, alice, { name: 'Intruder' })).status, 403);
  assert.equal((await t.post('/projects', { name: 'Nowhere' }, alice)).status, 422, 'a team is required');
  assert.equal((await t.post('/projects', { name: 'Bad', team: 'nope' }, alice)).status, 403);
  assert.equal((await t.post('/projects', { name: 'Bad', team: { $ne: null } }, alice)).status, 403);
  assert.equal(await t.app.model('project').countDocuments({ team: teamB }), 1);

  // Moving a record to another team.
  const move = await t.patch(`/projects/${a1.body.data.id}`, { team: teamB }, alice);
  assert.equal(move.status, 422);
  assert.equal((await t.get(`/projects/${a1.body.data.id}`, alice)).body.data.team, teamA);

  // Loose policies ('authenticated') do not weaken isolation.
  const m = await t.post('/memos', { text: 'B only', team: teamB }, bob);
  assert.equal(m.status, 201);
  assert.equal((await t.get('/memos', alice)).body.data.length, 0);
  assert.equal((await t.get(`/memos/${m.body.data.id}`, alice)).status, 404);
  assert.equal((await t.patch(`/memos/${m.body.data.id}`, { text: 'x' }, alice)).status, 404);
  assert.equal((await t.post('/memos', { text: 'sneaky', team: teamB }, alice)).status, 403);

  // Global admins are not members either: tenants stay apart.
  const root = await t.signup({ roles: ['user', 'admin'] });
  assert.equal((await t.get('/memos', root)).body.data.length, 0);
  assert.equal((await t.delete(`/memos/${m.body.data.id}`, root)).status, 404);

  // Services from your own code keep the rule too.
  await assert.rejects(t.app.service('project').update(a1.body.data.id, { team: teamB }, { user: { ...alice.user, id: alice.id } }), /another team|scope\(\)/);
});

test('a user in two teams, the X-Team header and ?team=', async () => {
  const carol = await t.signup();
  const dan = await t.signup();
  const teamA = await makeTeam(carol, 'Carol A');
  const teamB = await makeTeam(dan, 'Dan B');
  await ext().addMember(teamB, carol.id, 'member');
  await t.post('/projects', { name: 'In A', team: teamA }, carol);
  await t.post('/projects', { name: 'In B', team: teamB }, dan);

  assert.deepEqual((await t.get('/projects?sort=name', carol)).body.data.map((p) => p.name), ['In A', 'In B']);
  assert.deepEqual((await t.get(`/projects?team=${teamB}`, carol)).body.data.map((p) => p.name), ['In B']);
  const viaHeader = await withTeam('GET', '/projects', teamA, carol);
  assert.deepEqual(viaHeader.body.data.map((p) => p.name), ['In A']);
  const created = await withTeam('POST', '/projects', teamB, carol, { name: 'Header made' });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.team, teamB);
  assert.equal((await withTeam('GET', '/projects', teamA, dan)).status, 403, 'a header naming a foreign team is refused');
  assert.equal((await withTeam('GET', '/projects', 'garbage', dan)).status, 403);
  assert.deepEqual((await withTeam('GET', '/active-team', teamB, carol)).body.data, { id: teamB, role: 'member' });
  assert.equal((await t.get('/active-team', carol)).status, 403, "'member' needs a team to be about");
});

test('role policies on records, fields, lists and custom routes', async () => {
  const owner = await t.signup();
  const member = await t.signup();
  const teamId = await makeTeam(owner, 'Policies');
  await ext().addMember(teamId, member.id, 'member');
  const p = (await t.post('/projects', { name: 'Secret plan', budget: 1000, team: teamId }, owner)).body.data;
  assert.equal(p.budget, 1000, 'admins see the budget');

  const seen = await t.get(`/projects/${p.id}`, member);
  assert.equal(seen.status, 200);
  assert.equal(seen.body.data.budget, undefined, "visibleTo('team:admin') hides it from members");
  assert.equal((await t.patch(`/projects/${p.id}`, { name: 'Mine now' }, member)).status, 403, 'members can read, not update');
  assert.equal((await t.delete(`/projects/${p.id}`, member)).status, 403);
  const own = await t.post('/projects', { name: 'My own', team: teamId }, member);
  assert.equal((await t.patch(`/projects/${own.body.data.id}`, { name: 'Still mine' }, member)).status, 200, "'team:admin | owner': authors edit their records");

  // 'team:admin' on a list: only teams where the caller is an admin.
  const theirTeam = await makeTeam(member, 'Member owns this');
  await t.post('/ledgers', { label: 'Visible', team: theirTeam }, member);
  await t.post('/ledgers', { label: 'Admins only', team: teamId }, owner);
  assert.equal((await t.post('/ledgers', { label: 'nope', team: teamId }, member)).status, 403);
  assert.deepEqual((await t.get('/ledgers', member)).body.data.map((l) => l.label), ['Visible']);
  assert.equal((await t.get(`/ledgers?team=${teamId}`, member)).status, 403);
  assert.deepEqual((await t.get('/ledgers', owner)).body.data.map((l) => l.label), ['Admins only']);

  // Custom routes with :teamId.
  assert.equal((await t.get(`/reports/${teamId}`, owner)).status, 200);
  assert.equal((await t.get(`/reports/${teamId}`, member)).status, 403);
  assert.equal((await t.get(`/reports/${theirTeam}`, owner)).status, 403);
});

test('removing a member revokes access at once', async () => {
  const owner = await t.signup();
  const ex = await t.signup();
  const teamId = await makeTeam(owner, 'Revocation');
  await ext().addMember(teamId, ex.id, 'admin');
  const p = (await t.post('/projects', { name: 'Shared', team: teamId }, owner)).body.data;
  assert.equal((await t.get(`/projects/${p.id}`, ex)).status, 200);
  assert.equal((await t.get('/projects', ex)).body.data.length, 1);

  assert.equal((await t.delete(`/teams/${teamId}/members/${ex.id}`, owner)).status, 204);
  assert.equal((await t.get(`/projects/${p.id}`, ex)).status, 404);
  assert.equal((await t.get('/projects', ex)).body.data.length, 0);
  assert.equal((await t.patch(`/projects/${p.id}`, { name: 'x' }, ex)).status, 404);
  assert.equal((await t.post('/projects', { name: 'x', team: teamId }, ex)).status, 403);
  assert.equal((await withTeam('GET', '/projects', teamId, ex)).status, 403);
  assert.equal((await t.get(`/teams/${teamId}`, ex)).status, 403);
});

test('app.canRead (realtime, webhooks) follows memberships outside the request', async () => {
  const owner = await t.signup();
  const outsider = await t.signup();
  const teamId = await makeTeam(owner, 'Streams');
  const p = (await t.post('/projects', { name: 'Live', team: teamId }, owner)).body.data;
  const doc = await t.app.model('project').findById(p.id).lean();
  const as = (u) => ({ ...u.user, id: u.id });
  assert.equal(await t.app.canRead('project', doc, as(owner)), true);
  assert.equal(await t.app.canRead('project', doc, as(outsider)), false);
  assert.equal(await t.app.inScope('project', doc, as(outsider)), false);
  await ext().addMember(teamId, outsider.id, 'member');
  assert.equal(await t.app.canRead('project', doc, as(outsider)), true);
  // Outside a request, a service call for some user cannot be scoped synchronously: refused, not leaked.
  assert.throws(() => t.app.service('project').filterFor({ user: as(outsider) }), /scope\(\) returned a Promise/);
});

test('a deleted account leaves its teams; an heir becomes owner', async () => {
  const owner = await t.signup();
  const admin = await t.signup();
  const root = await t.signup({ roles: ['user', 'admin'] });
  const teamId = await makeTeam(owner, 'Heirs');
  const solo = await makeTeam(owner, 'Solo');
  await ext().addMember(teamId, admin.id, 'admin');
  assert.equal((await t.delete(`/users/${owner.id}`, root)).status, 204);
  await t.idle();
  const members = (await t.get(`/teams/${teamId}/members`, admin)).body.data;
  assert.deepEqual(members.map((m) => [m.user.id, m.role]), [[admin.id, 'owner']]);
  assert.equal(await t.app.model('team').countDocuments({ _id: solo }), 0, 'a team left empty is deleted');
});

test('doctor and the exposure matrix understand team-scoped resources', async () => {
  const findings = await t.app.doctor();
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
  assert.ok(findings.some((f) => f.id === 'teams-scoped' && /project, memo, ledger|ledger/.test(f.title)));
  const matrix = await t.app.exposure();
  const project1 = matrix.resources.find((r) => r.name === 'project');
  assert.equal(project1.customScope, true);
  assert.equal(project1.actions.read.anonymous, 'deny');
  assert.equal(project1.actions.read.user, 'custom');
  assert.equal(project1.actions.read.admin, 'custom');
  assert.equal(project1.actions.update.owner, 'allow', "'owner' in 'team:admin | owner'");
  const memo = matrix.resources.find((r) => r.name === 'memo');
  assert.equal(memo.actions.read.user, 'allow');
  const team = matrix.resources.find((r) => r.name === 'team');
  assert.ok(Object.values(team.actions).every((a) => Object.values(a).every((v) => v === 'off')));
});

// ---- other apps (run last: named policies are per process) ----------------------------------

test('options: everyone may invite (up to their own role), custom roles, accept by verified email', async () => {
  await t.close();
  t = null;
  const p = await makeProject({
    files: {
      'app/resources/user/user.resource.js': `
import { resource, f } from '#calm';
export default resource('user', {
  owner: '_id',
  fields: {
    name: f.string().required().max(100),
    email: f.email().required().unique().immutable().filterable().visibleTo('owner | admin'),
    password: f.password().required(),
    roles: f.array(f.enum(['user', 'admin'])).default(['user']).writableBy('admin').visibleTo('owner | admin'),
    status: f.enum(['active', 'disabled']).default('active').writableBy('admin'),
    emailVerifiedAt: f.date().readOnly(),
  },
  policy: { list: 'admin', read: 'owner | admin', create: 'admin', update: 'owner | admin', delete: 'admin' },
});`,
    },
  });
  try {
    execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'teams', '--yes', '--no-install'], { cwd: p.dir, env: { ...process.env, CI: '1' } });
    const s = await p.testApp({ blocks: { teams: { inviteRole: 'viewer', roles: ['owner', 'admin', 'member', 'viewer'], verifiedEmailField: 'emailVerifiedAt', maxOpenInvitations: 3 } } });
    try {
      const owner = await s.signup();
      const viewer = await s.signup();
      const verified = await s.signup();
      const unverified = await s.signup();
      await s.app.model('user').updateOne({ _id: verified.id }, { $set: { emailVerifiedAt: new Date() } });
      const teamId = (await s.post('/teams', { name: 'Open' }, owner)).body.data.id;
      await s.app.ext.teams.addMember(teamId, viewer.id, 'viewer');

      assert.equal((await s.post(`/teams/${teamId}/invitations`, { email: 'v1@example.test', role: 'member' }, viewer)).status, 403, 'not above your own role');
      const byViewer = await s.post(`/teams/${teamId}/invitations`, { email: verified.email, role: 'viewer' }, viewer);
      assert.equal(byViewer.status, 201);
      await s.post(`/teams/${teamId}/invitations`, { email: unverified.email }, owner);

      // Verified address: the invitation is listed and accepted without the link.
      const mine = await s.get('/teams/invitations', verified);
      assert.deepEqual(mine.body.data.map((i) => [i.teamName, i.role]), [['Open', 'viewer']]);
      assert.equal((await s.post(`/teams/invitations/${byViewer.body.data.id}/accept`, {}, unverified)).status, 403);
      assert.equal((await s.post(`/teams/invitations/${byViewer.body.data.id}/accept`, {}, verified)).status, 200);
      assert.equal((await s.app.ext.teams.memberships(verified.user)).get(teamId), 'viewer');
      // Unverified: nothing listed, and the id alone is not enough.
      assert.deepEqual((await s.get('/teams/invitations', unverified)).body.data, []);
      const unverifiedInvite = (await s.get(`/teams/${teamId}/invitations`, owner)).body.data.find((i) => i.email === unverified.email);
      assert.equal((await s.post(`/teams/invitations/${unverifiedInvite.id}/accept`, {}, unverified)).status, 403);
      // The cap on open invitations (one accepted, one open so far).
      assert.equal((await s.post(`/teams/${teamId}/invitations`, { email: 'cap1@example.test' }, owner)).status, 201);
      assert.equal((await s.post(`/teams/${teamId}/invitations`, { email: 'cap2@example.test' }, owner)).status, 201);
      assert.equal((await s.post(`/teams/${teamId}/invitations`, { email: 'cap3@example.test' }, owner)).body.error.code, 'INVITATION_LIMIT');
      // Script removal: no role checks, reason 'script'.
      await s.app.ext.teams.removeMember(teamId, viewer.id);
      assert.equal((await s.get(`/teams/${teamId}`, viewer)).status, 403);
      // Custom roles become policies.
      assert.ok(s.app.plugins.find((x) => x.name === 'teams').uses.some((u) => u.kind === 'policy' && u.name === 'team:viewer'));
    } finally {
      await s.close();
    }
  } finally {
    p.cleanup();
  }
});

test('calm audit on a project with team-scoped resources has no false failures', async () => {
  const { runAudit } = await project.load('calm/security/audit.js');
  const report = await runAudit({ root: project.dir });
  const failed = [...report.results.filter((r) => r.ok === false), ...report.leaks, ...report.probes.filter((x) => !x.ok)];
  assert.deepEqual(failed, []);
  assert.equal(report.ok, true);
  assert.ok(report.results.some((r) => r.resource === 'project' && r.ok === null), 'team rules are reported as custom, not guessed');
});
