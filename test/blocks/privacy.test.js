import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');

// notes are deleted with their owner (default, soft-delete on), comments are anonymized,
// invoices are kept.
const files = {
  'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  softDelete: true,
  fields: {
    text: f.string().required(),
    secret: f.string().hidden(),
    diary: f.string().encrypted().visibleTo('owner'),
    staffNote: f.string().writableBy('admin').visibleTo('admin'),
    author: f.ref('user').owner(),
  },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/resources/note/note.service.js': `
import { ResourceService } from '#calm';
export default class NoteService extends ResourceService {
  async beforeCreate(data) { return { ...data, secret: 'classified-' + data.text }; }
  async afterDelete(doc) { (globalThis.privacyNoteDeletes ??= []).push(String(doc._id)); }
}`,
  'app/resources/comment/comment.resource.js': `
import { resource, f } from '#calm';
export default resource('comment', {
  onOwnerDelete: 'anonymize',
  personalFields: ['authorName'],
  fields: { body: f.string().required(), authorName: f.string(), mentions: f.array(f.ref('user')).default([]), author: f.ref('user').owner() },
  policy: { list: 'public', read: 'public', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/resources/invoice/invoice.resource.js': `
import { resource, f } from '#calm';
export default resource('invoice', {
  onOwnerDelete: 'keep',
  fields: { amount: f.number().required(), customer: f.ref('user').owner() },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'admin', delete: 'admin' },
});`,
};

let project;
let t;
let admin;
const events = [];

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [CALM, 'add', 'privacy', 'soft-delete', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({
    rateLimit: { enabled: true, global: { windowMs: 60_000, max: 10_000 }, auth: { windowMs: 60_000, max: 1000 } },
    blocks: { privacy: { batchSize: 2, exportLimit: { windowMs: 60_000, max: 2 } } },
  });
  t.app.events.on('privacy.*', (payload, name) => events.push({ name, payload }));
  admin = await t.signup({ name: 'Admin', roles: ['user', 'admin'] });
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const del = (path, body, who) => t.request('DELETE', path, body, who);
const count = (model, filter) => t.app.model(model).countDocuments(filter);

/** A user with notes, a comment, an invoice, a push device and two sessions. */
async function seed(name) {
  const u = await t.signup({ name });
  const notes = [];
  for (const text of ['one', 'two', 'three']) {
    const res = await t.post('/notes', { text: `${name}-${text}`, diary: `${name} dear diary ${text}` }, u);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    notes.push(res.body.data);
  }
  await t.app.model('note').updateOne({ _id: notes[0].id }, { $set: { staffNote: `${name} is a VIP` } });
  assert.equal((await t.post('/comments', { body: `${name} says hi`, authorName: `${name} Lastname` }, u)).status, 201);
  assert.equal((await t.post('/invoices', { amount: 42 }, u)).status, 201);
  assert.equal((await t.post('/auth/devices', { token: `fcm-${name}-0123456789abcdef`, platform: 'android' }, u)).status, 201);
  const login = await t.post('/auth/login', { email: u.email, password: u.password });
  assert.equal(login.status, 200);
  return { ...u, notes, token2: login.body.data.token };
}

describe('export', () => {
  let alice;
  let bob;
  before(async () => {
    alice = await seed('Alice');
    bob = await seed('Bob');
  });

  test('a JSON download of everything the user owns, as the owner sees it', async () => {
    const res = await fetch(`${t.origin}/api/auth/me/export`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment; filename="fixture-app-export-\d{4}-\d{2}-\d{2}\.json"$/);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const text = await res.text();
    const data = JSON.parse(text);

    assert.equal(data.userId, alice.id);
    assert.equal(data.profile.email, alice.email);
    assert.equal(data.profile.password, undefined);
    assert.equal(data.profile.deletion, undefined);
    assert.equal(data.resources.note.length, 3);
    assert.ok(data.resources.note.every((n) => n.author === alice.id));
    assert.deepEqual(data.resources.note.map((n) => n.diary).sort(), ['Alice dear diary one', 'Alice dear diary three', 'Alice dear diary two'], 'encrypted fields decrypted for the owner');
    assert.ok(data.resources.note.every((n) => n.secret === undefined && n.staffNote === undefined), 'hidden and admin-only fields are not exported');
    assert.equal(data.resources.comment.length, 1);
    assert.equal(data.resources.invoice.length, 1);
    assert.equal(data.sessions.length, 2);
    assert.ok(data.sessions.every((s) => s.tokenHash === undefined && s.id && s.expiresAt));
    assert.equal(data.devices.length, 1);
    assert.notEqual(data.devices[0].token, 'fcm-Alice-0123456789abcdef', 'push tokens are masked');
    assert.deepEqual(data.manifest.counts, { profile: 1, comment: 1, invoice: 1, note: 3, post: 0, sessions: 2, devices: 1 });
    assert.deepEqual(data.manifest.resources, ['comment', 'invoice', 'note', 'post']);
    assert.ok(data.manifest.generatedAt);

    for (const leak of ['scrypt$', 'classified', 'VIP', 'Bob', alice.token, alice.token2, 'fcm-Alice-0123456789abcdef', 'enc:v1:']) {
      assert.ok(!text.includes(leak), `export must not contain ${leak}`);
    }
    await t.idle();
    const exported = events.find((e) => e.name === 'privacy.exported' && e.payload.userId === alice.id);
    assert.equal(exported.payload.by, 'self');
    assert.equal(exported.payload.counts.note, 3);
  });

  test('an account without records still exports valid JSON; exports are rate limited per user', async () => {
    const carol = await t.signup({ name: 'Carol' });
    const first = await t.get('/auth/me/export', carol);
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.resources, { comment: [], invoice: [], note: [], post: [] });
    assert.equal((await t.get('/auth/me/export', carol)).status, 200);
    assert.equal((await t.get('/auth/me/export', carol)).status, 429);
    assert.equal((await t.get('/auth/me/export', bob)).status, 200, 'the limit is per user');
    assert.equal((await t.get('/auth/me/export')).status, 401);
  });

  test('a failure halfway cuts the download instead of sending half a file', async () => {
    const lea = await t.signup({ name: 'Lea' });
    // Encrypted with a key this app does not have: decrypting it fails in the middle of the file.
    await t.app.model('note').collection.insertOne({ text: 'unreadable', diary: 'enc:v1:gone:AAAA:AAAA:AAAA', author: new t.app.mongoose.Types.ObjectId(lea.id) });
    await assert.rejects(async () => {
      const res = await fetch(`${t.origin}/api/auth/me/export`, { headers: { authorization: `Bearer ${lea.token}` } });
      JSON.parse(await res.text());
    });
    assert.equal((await t.get('/auth/me', lea)).status, 200, 'the server carries on');
  });

  test('admins export any user for a support request', async () => {
    assert.equal((await t.delete(`/notes/${bob.notes[0].id}`, bob)).status, 204);
    const res = await t.post(`/admin/users/${bob.id}/export`, {}, admin);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /^attachment;/);
    assert.equal(res.body.profile.id, bob.id);
    assert.equal(res.body.resources.note.length, 3, 'soft-deleted records are still stored data');
    assert.ok(res.body.resources.note.every((n) => n.staffNote === undefined), 'serialized as the owner sees it, not as the admin');
    assert.equal((await t.post(`/admin/users/${bob.id}/export`, {}, alice)).status, 403);
    assert.equal((await t.post('/admin/users/000000000000000000000000/export', {}, admin)).status, 404);
    await t.idle();
    const exported = events.find((e) => e.name === 'privacy.exported' && e.payload.userId === bob.id && e.payload.by === 'admin');
    assert.equal(exported.payload.adminId, admin.id);
  });
});

describe('delete', () => {
  test('wrong or missing password is refused and changes nothing', async () => {
    const u = await seed('Dan');
    const wrong = await del('/auth/me', { password: 'not-my-password' }, u);
    assert.equal(wrong.status, 422);
    assert.equal(wrong.body.error.details.password, 'Password is incorrect');
    assert.equal((await del('/auth/me', undefined, u)).status, 422);
    assert.equal((await del('/auth/me', { password: u.password })).status, 401);
    assert.equal((await t.get('/auth/me', u)).status, 200);
    assert.equal(await count('note', { author: u.id }), 3);
  });

  test('removes owned records, sessions, devices and resets; anonymizes and keeps per resource', async () => {
    const erin = await seed('Erin');
    const frank = await seed('Frank');
    await t.post('/comments', { body: 'Frank mentions Erin', mentions: [erin.id] }, frank);
    await t.post('/auth/password/forgot', { email: erin.email });
    await t.idle();
    const { Session, PasswordReset } = t.app.auth.service;
    assert.equal(await PasswordReset.countDocuments({ user: erin.id }), 1);
    const idem = t.app.mongoose.connection.db.collection('calm_idempotency');
    await idem.insertOne({ _id: `erin-${erin.id}`, user: new t.app.mongoose.Types.ObjectId(erin.id) });
    assert.equal((await t.delete(`/notes/${erin.notes[0].id}`, erin)).status, 204, 'soft-deleted');
    globalThis.privacyNoteDeletes = [];

    const res = await del('/auth/me', { password: erin.password }, erin);
    assert.equal(res.status, 204, JSON.stringify(res.body));

    assert.equal(await t.app.model('user').countDocuments({ _id: erin.id }), 0);
    assert.equal(await t.app.model('note').collection.countDocuments({ author: new t.app.mongoose.Types.ObjectId(erin.id) }), 0, 'soft-deleted ones too');
    assert.deepEqual(globalThis.privacyNoteDeletes.sort(), erin.notes.map((n) => n.id).sort(), 'service hooks ran for each deleted record');
    assert.equal(await Session.countDocuments({ user: erin.id }), 0);
    assert.equal(await PasswordReset.countDocuments({ user: erin.id }), 0);
    assert.equal(await t.app.push.devices.countDocuments({ user: erin.id }), 0);
    assert.equal(await idem.countDocuments({ user: new t.app.mongoose.Types.ObjectId(erin.id) }), 0);

    const comment = await t.app.model('comment').findOne({ body: 'Erin says hi' }).lean();
    assert.ok(comment, 'anonymized records stay');
    assert.equal(comment.author, undefined);
    assert.equal(comment.authorName, undefined);
    assert.equal(await count('invoice', { customer: erin.id }), 1, "'keep' keeps the record");

    // Frank is untouched.
    assert.equal(await count('note', { author: frank.id }), 3);
    assert.equal((await t.app.model('comment').findOne({ body: 'Frank says hi' }).lean()).authorName, 'Frank Lastname');
    assert.equal(await Session.countDocuments({ user: frank.id }), 2);
    assert.equal(await t.app.push.devices.countDocuments({ user: frank.id }), 1);
    assert.equal((await t.get('/auth/me', frank)).status, 200);

    assert.equal((await t.get('/auth/me', erin)).status, 401);
    assert.equal((await t.get('/auth/me', erin.token2)).status, 401);
    assert.equal((await t.post('/auth/login', { email: erin.email, password: erin.password })).status, 401);

    await t.idle();
    const deleted = events.find((e) => e.name === 'privacy.account_deleted' && e.payload.userId === erin.id);
    assert.deepEqual(Object.keys(deleted.payload).sort(), ['by', 'resources', 'userId']);
    assert.deepEqual(deleted.payload.resources.note, { deleted: 3 });
    assert.deepEqual(deleted.payload.resources.comment, { anonymized: 1 });
    assert.deepEqual(deleted.payload.resources.invoice, { kept: 1 });
    assert.ok(!JSON.stringify(deleted.payload).includes(erin.email), 'no personal data in the event');
  });

  test('admins delete accounts for support requests; the user CRUD delete erases the same way', async () => {
    const gus = await seed('Gus');
    assert.equal((await del(`/admin/users/${gus.id}`, undefined, gus)).status, 403);
    assert.equal((await del(`/admin/users/${gus.id}`, undefined, admin)).status, 204);
    assert.equal(await t.app.model('user').countDocuments({ _id: gus.id }), 0);
    assert.equal(await count('note', { author: gus.id }), 0);

    const hal = await seed('Hal');
    assert.equal((await t.delete(`/users/${hal.id}`, admin)).status, 204);
    assert.equal(await count('note', { author: hal.id }), 0);
    assert.equal(await t.app.auth.service.Session.countDocuments({ user: hal.id }), 0);
    await t.idle();
    assert.equal(events.find((e) => e.name === 'privacy.account_deleted' && e.payload.userId === hal.id).payload.by, 'admin');
  });

  test('a user marked deleting is locked out, and an interrupted deletion is finished by the sweep', async () => {
    const ivy = await seed('Ivy');
    // As if the process died right after marking the account.
    await t.app.model('user').collection.updateOne(
      { _id: new t.app.mongoose.Types.ObjectId(ivy.id) },
      { $set: { status: 'deleting', deletion: { requestedAt: new Date(), scheduledFor: new Date(), by: 'self' } } },
    );
    assert.equal((await t.get('/auth/me', ivy)).status, 401);
    assert.equal((await t.post('/auth/login', { email: ivy.email, password: ivy.password })).status, 403);
    assert.equal(await t.app.ext.privacy.sweep(), 1);
    assert.equal(await t.app.model('user').countDocuments({ _id: ivy.id }), 0);
    assert.equal(await count('note', { author: ivy.id }), 0);
    assert.equal(await t.app.ext.privacy.sweep(), 0, 'nothing left to do');
  });
});

describe('grace period', () => {
  let g;
  before(async () => {
    g = await project.testApp({ blocks: { privacy: { graceDays: 7 } } });
  });
  after(async () => {
    await g?.close();
  });

  test('the account is locked at once and erased when the grace period ends; admins can cancel', async () => {
    const boss = await g.signup({ name: 'Boss', roles: ['user', 'admin'] });
    const jo = await g.signup({ name: 'Jo' });
    assert.equal((await g.post('/notes', { text: 'keep me for now' }, jo)).status, 201);

    const res = await g.request('DELETE', '/auth/me', { password: jo.password }, jo);
    assert.equal(res.status, 202);
    assert.equal(res.body.data.status, 'scheduled');
    const days = (new Date(res.body.data.scheduledFor) - Date.now()) / 86_400_000;
    assert.ok(days > 6.9 && days <= 7, `scheduled in 7 days, got ${days}`);
    assert.equal((await g.get('/auth/me', jo)).status, 401, 'sessions are revoked right away');
    assert.equal((await g.post('/auth/login', { email: jo.email, password: jo.password })).status, 403);
    assert.equal(await g.app.ext.privacy.sweep(), 0, 'not due yet');
    assert.equal(await g.app.model('note').countDocuments({}), 1);

    assert.equal((await g.post(`/admin/users/${jo.id}/cancel-deletion`, {}, boss)).status, 204);
    const back = await g.post('/auth/login', { email: jo.email, password: jo.password });
    assert.equal(back.status, 200);
    assert.equal(back.body.data.user.status, 'active');
    assert.equal((await g.post(`/admin/users/${jo.id}/cancel-deletion`, {}, boss)).status, 404, 'nothing to cancel');

    assert.equal((await g.request('DELETE', '/auth/me', { password: jo.password }, back.body.data.token)).status, 202);
    await g.app.model('user').collection.updateOne({ _id: new g.app.mongoose.Types.ObjectId(jo.id) }, { $set: { 'deletion.scheduledFor': new Date(Date.now() - 1000) } });
    assert.equal(await g.app.ext.privacy.sweep(), 1);
    assert.equal(await g.app.model('user').countDocuments({ _id: jo.id }), 0);
    assert.equal(await g.app.model('note').countDocuments({}), 0);
  });

  test('admins can skip the grace period', async () => {
    const boss = await g.signup({ name: 'Boss2', roles: ['user', 'admin'] });
    const kim = await g.signup({ name: 'Kim' });
    const scheduled = await g.request('DELETE', `/admin/users/${kim.id}`, undefined, boss);
    assert.equal(scheduled.status, 202);
    assert.equal((await g.request('DELETE', `/admin/users/${kim.id}`, { immediate: true }, boss)).status, 204);
    assert.equal(await g.app.model('user').countDocuments({ _id: kim.id }), 0);
  });
});

test('doctor lists what deletion does and warns about kept data', async () => {
  const findings = await t.app.doctor();
  const plan = findings.find((f) => f.id === 'privacy-plan');
  assert.equal(plan.level, 'info');
  assert.match(plan.detail, /note deleted/);
  assert.match(plan.detail, /comment kept without owner \(author, authorName removed\)/);
  assert.match(plan.detail, /invoice kept as is/);
  const keep = findings.find((f) => f.id === 'privacy-keep-invoice');
  assert.equal(keep.level, 'warn');
  assert.equal(keep.file, 'app/resources/invoice/invoice.resource.js');
  assert.match(findings.find((f) => f.id === 'privacy-user-refs').detail, /comment\.mentions/);
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
});

test('invalid settings fail at boot', async () => {
  await assert.rejects(project.testApp({ blocks: { privacy: { resources: { note: 'shred' } } } }), /onOwnerDelete "shred"/);
  await assert.rejects(project.testApp({ blocks: { privacy: { personalFields: { comment: ['nope'] } } } }), /personal field\(s\) nope do not exist on comment/);
});
