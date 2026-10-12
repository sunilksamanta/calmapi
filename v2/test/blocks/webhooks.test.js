import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// A local receiver. The first path segment decides the answer:
//   /ok/*  200    /flaky/*  500 twice, then 200    /gone/*  410    /fail/*  500 always
//   /redirect/*  302 to the cloud metadata address    /slow/*  never answers
const received = [];
const flakyCount = new Map();
let receiver;
let base;

let project;
let t;
let verifyWebhook;
let ssrf;
let alice;
let bob;
let admin;

// A private resource with a hidden field and an admin-only field, next to the starter's posts.
const files = {
  'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  fields: {
    text: f.string().required(),
    secret: f.string().hidden(),
    staffNote: f.string().readOnly().visibleTo('admin'),
    author: f.ref('user').owner(),
  },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/resources/note/note.service.js': `
import { ResourceService } from '#calm';
export default class NoteService extends ResourceService {
  async beforeCreate(data) { return { ...data, secret: 'classified', staffNote: 'flagged for review' }; }
}`,
};

// Tiny delays so retries take milliseconds: 3 attempts per delivery, 2 failed deliveries turn an endpoint off.
const config = { blocks: { webhooks: { pollMs: 20, retrySchedule: [40, 40], disableAfterFailures: 2, timeoutMs: 300 } } };

before(async () => {
  receiver = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const kind = req.url.split('/')[1];
      if (kind === 'slow') return;
      if (kind === 'redirect') return res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' }).end();
      let status = { gone: 410, fail: 500 }[kind] ?? 200;
      if (kind === 'flaky') {
        const n = flakyCount.get(req.url) ?? 0;
        flakyCount.set(req.url, n + 1);
        if (n < 2) status = 500;
      }
      res.writeHead(status, { 'content-type': 'text/plain' }).end(status === 200 ? 'thanks' : 'nope');
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${receiver.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'webhooks', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1', NO_COLOR: '1' } });
  t = await project.testApp(config);
  ({ verifyWebhook } = await project.load('app/blocks/webhooks/index.js'));
  ssrf = await project.load('app/blocks/webhooks/ssrf.js');
  alice = await t.signup({ name: 'Alice' });
  bob = await t.signup({ name: 'Bob' });
  admin = await t.signup({ name: 'Admin', roles: ['user', 'admin'] });
});

after(async () => {
  await t?.close();
  project?.cleanup();
  receiver?.closeAllConnections();
  await new Promise((resolve) => receiver?.close(resolve) ?? resolve());
});

const at = (path) => received.filter((r) => r.path === path);
const eventsAt = (path) => at(path).map((r) => JSON.parse(r.body));
const publish = (who, title = 'Hello') => t.post('/posts', { title, body: 'World', status: 'published' }, who);

async function waitFor(fn, what, ms = 5000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function endpoint(who, path, events = ['post.*'], extra = {}) {
  const res = await t.post('/webhooks', { url: `${base}${path}`, events, ...extra }, who);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return res.body.data;
}

const deliveriesOf = async (w, who) => (await t.get(`/webhooks/${w.id}/deliveries`, who)).body.data;

test('create: the secret is shown once and stored encrypted', async () => {
  const w = await endpoint(alice, '/ok/created', ['post.created']);
  assert.match(w.secret, /^whsec_[A-Za-z0-9+/]+=*$/);
  assert.equal(Buffer.from(w.secret.slice('whsec_'.length), 'base64').length, 32);
  assert.equal(w.scope, 'own');
  assert.equal(w.status, 'active');

  const one = await t.get(`/webhooks/${w.id}`, alice);
  assert.equal(one.status, 200);
  assert.equal(one.body.data.secret, undefined);
  const list = await t.get('/webhooks', alice);
  assert.ok(list.body.data.some((x) => x.id === w.id));
  assert.ok(!JSON.stringify(list.body).includes('whsec_'), 'never returned again');

  const stored = await t.app.ext.webhooks.Webhook.findById(w.id).select('+secret').lean();
  assert.match(stored.secret, /^enc:v1:/, 'encrypted at rest');
});

test('delivers a signed event that verifyWebhook accepts, and refuses forgeries', async () => {
  const w = await endpoint(alice, '/ok/signed', ['post.created']);
  const post = await publish(alice);
  assert.equal(post.status, 201);
  const [hit] = await waitFor(() => at('/ok/signed').length && at('/ok/signed'), 'the delivery');

  assert.match(hit.headers['webhook-id'], /^msg_[\w-]+$/);
  assert.match(hit.headers['webhook-timestamp'], /^\d+$/);
  assert.match(hit.headers['webhook-signature'], /^v1,[A-Za-z0-9+/]+=*$/);
  assert.equal(hit.headers['content-type'], 'application/json');
  const event = verifyWebhook(w.secret, hit.headers, hit.body);
  assert.equal(event.type, 'post.created');
  assert.ok(!Number.isNaN(Date.parse(event.timestamp)));
  assert.equal(event.data.id, post.body.data.id);
  assert.equal(event.data.title, 'Hello');
  assert.deepEqual(verifyWebhook(w.secret, new Headers(hit.headers), Buffer.from(hit.body)), event, 'fetch Headers and Buffers work too');

  const other = `whsec_${Buffer.alloc(32, 7).toString('base64')}`;
  assert.throws(() => verifyWebhook(other, hit.headers, hit.body), /No matching signature/);
  assert.throws(() => verifyWebhook(w.secret, hit.headers, hit.body.replace('Hello', 'Hacked')), /No matching signature/);
  assert.throws(() => verifyWebhook(w.secret, hit.headers, hit.body, { now: Date.now() + 10 * 60_000 }), /outside the allowed window/);
  assert.throws(() => verifyWebhook(w.secret, hit.headers, JSON.parse(hit.body)), /raw request body/);
  assert.throws(() => verifyWebhook(w.secret, {}, hit.body), /Missing webhook-id/);
});

test('retries a 500 with the same webhook-id, then succeeds; the log shows every attempt', async () => {
  const w = await endpoint(alice, '/flaky/1', ['post.updated']);
  const post = (await publish(alice, 'Retry me')).body.data;
  await t.patch(`/posts/${post.id}`, { title: 'Retried' }, alice);

  await waitFor(() => at('/flaky/1').length >= 3, 'three attempts');
  assert.equal(new Set(at('/flaky/1').map((h) => h.headers['webhook-id'])).size, 1);
  const [d] = await waitFor(async () => {
    const list = await deliveriesOf(w, alice);
    return list[0]?.status === 'succeeded' && list;
  }, 'the delivery to succeed');
  assert.equal(d.type, 'post.updated');
  assert.equal(d.attempts, 3);
  assert.equal(d.statusCode, 200);
  assert.equal(d.response, 'thanks');
  assert.equal(d.nextAttemptAt, null);
  assert.ok(d.durationMs >= 0);
  assert.deepEqual(d.attemptLog.map((a) => a.statusCode), [500, 500, 200]);
  assert.equal(d.attemptLog[0].error, 'HTTP 500');
  assert.equal(JSON.parse(d.payload).data.title, 'Retried');

  const now = (await t.get(`/webhooks/${w.id}`, alice)).body.data;
  assert.equal(now.status, 'active');
  assert.equal(now.failedAttempts, 0);
  assert.ok(now.lastSuccessAt);
});

test('410 Gone turns the endpoint off, emits webhook.disabled and emails the owner', async () => {
  const disabled = [];
  const off = t.app.events.on('webhook.disabled', (payload) => disabled.push(payload));
  const w = await endpoint(bob, '/gone/1', ['post.created']);
  await publish(alice, 'Bye');
  await waitFor(() => disabled.length, 'webhook.disabled');
  off();

  assert.equal(disabled[0].reason, 'gone');
  assert.equal(disabled[0].webhook.id, w.id);
  assert.equal(disabled[0].owner, bob.id);
  assert.equal(at('/gone/1').length, 1, 'never retried');
  const now = (await t.get(`/webhooks/${w.id}`, bob)).body.data;
  assert.equal(now.enabled, false);
  assert.equal(now.disabledReason, 'gone');
  assert.ok(t.mails.some((m) => m.to === bob.email && /Webhook turned off/.test(m.subject)));

  await publish(alice, 'Again');
  await t.idle();
  await t.app.ext.webhooks.drain();
  assert.equal(at('/gone/1').length, 1, 'disabled endpoints receive nothing');
  assert.equal((await t.post(`/webhooks/${w.id}/test`, {}, bob)).status, 400);
});

test('failing endpoints show in doctor and turn off after N deliveries failed every retry', async () => {
  const w = await endpoint(bob, '/fail/1', ['post.created']);
  await publish(alice, 'Fails');
  await waitFor(async () => (await deliveriesOf(w, bob))[0]?.status === 'failed', 'the first delivery to fail');
  assert.equal(at('/fail/1').length, 3, 'first try and two retries');

  let current = (await t.get(`/webhooks/${w.id}`, bob)).body.data;
  assert.equal(current.enabled, true);
  assert.equal(current.status, 'failing');
  assert.equal(current.failedAttempts, 3);
  await t.app.ext.webhooks.refreshStats();
  const failing = (await t.app.doctor()).find((f) => f.id === 'webhooks-failing');
  assert.equal(failing?.level, 'warn');
  assert.match(failing.detail, /127\.0\.0\.1:\d+ since .*HTTP 500/);

  await publish(alice, 'Fails again');
  await waitFor(async () => (await t.get(`/webhooks/${w.id}`, bob)).body.data.enabled === false, 'the endpoint to turn off');
  current = (await t.get(`/webhooks/${w.id}`, bob)).body.data;
  assert.equal(current.disabledReason, 'failing');

  const on = await t.patch(`/webhooks/${w.id}`, { enabled: true }, bob);
  assert.equal(on.status, 200);
  assert.deepEqual([on.body.data.enabled, on.body.data.status, on.body.data.failedAttempts, on.body.data.disabledReason], [true, 'active', 0, null]);

  assert.equal((await t.delete(`/webhooks/${w.id}`, bob)).status, 204);
  assert.equal(await t.app.ext.webhooks.Delivery.countDocuments({ webhook: w.id }), 0, 'its log goes with it');
});

test('visibility: subscribers only get records they may read, serialized for them', async () => {
  const aliceHook = await endpoint(alice, '/ok/alice-vis', ['post.*', 'note.*']);
  const bobHook = await endpoint(bob, '/ok/bob-vis', ['post.*', 'note.*', 'user.updated']);
  assert.equal((await t.post('/webhooks', { url: `${base}/ok/nope`, events: ['*'], scope: 'global' }, bob)).status, 403, 'only admins go global');
  await endpoint(admin, '/ok/admin-vis', ['post.*', 'note.*'], { scope: 'global' });

  const draft = (await t.post('/posts', { title: 'Secret plan', body: 'Draft', status: 'draft' }, alice)).body.data;
  const note = (await t.post('/notes', { text: 'Private' }, alice)).body.data;
  await waitFor(() => eventsAt('/ok/alice-vis').length >= 2 && eventsAt('/ok/admin-vis').length >= 2, 'alice and admin deliveries');

  const forAlice = eventsAt('/ok/alice-vis');
  assert.ok(forAlice.some((e) => e.type === 'post.created' && e.data.id === draft.id), 'authors get their own drafts');
  const aliceNote = forAlice.find((e) => e.type === 'note.created');
  assert.equal(aliceNote.data.text, 'Private');
  assert.equal(aliceNote.data.secret, undefined, 'hidden fields never leave');
  assert.equal(aliceNote.data.staffNote, undefined, "visibleTo('admin') is applied for the owner");

  const forAdmin = eventsAt('/ok/admin-vis');
  const adminNote = forAdmin.find((e) => e.type === 'note.created' && e.data.id === note.id);
  assert.equal(adminNote.data.staffNote, 'flagged for review', 'global endpoints get the admin view');
  assert.equal(adminNote.data.secret, undefined);
  assert.ok(forAdmin.some((e) => e.type === 'post.created' && e.data.id === draft.id));

  // Bob may not read Alice's draft (post scope) nor her note (owner policy), also once deleted.
  await t.delete(`/notes/${note.id}`, alice);
  await waitFor(() => eventsAt('/ok/alice-vis').some((e) => e.type === 'note.deleted'), 'note.deleted for alice');
  await t.idle(); // every event listener has queued its deliveries
  assert.equal(await t.app.ext.webhooks.Delivery.countDocuments({ webhook: bobHook.id }), 0, 'nothing was queued for bob');

  // Published, the post is public: now Bob receives it.
  await t.post(`/posts/${draft.id}/publish`, {}, alice);
  await waitFor(() => at('/ok/bob-vis').length, 'the published post for bob');
  const [published] = eventsAt('/ok/bob-vis');
  assert.equal(published.type, 'post.updated');
  assert.equal(published.data.status, 'published');

  // user.updated: Bob only hears about his own record, with the fields he may see.
  await t.patch(`/users/${alice.id}`, { name: 'Alice A.' }, alice);
  await t.patch(`/users/${bob.id}`, { name: 'Bob B.' }, bob);
  await waitFor(() => eventsAt('/ok/bob-vis').some((e) => e.type === 'user.updated'), 'user.updated for bob');
  await t.idle();
  const userEvents = eventsAt('/ok/bob-vis').filter((e) => e.type === 'user.updated');
  assert.deepEqual(userEvents.map((e) => e.data.id), [bob.id]);
  assert.equal(userEvents[0].data.email, bob.email, "visibleTo('owner | admin') fields reach the owner");
  assert.equal(userEvents[0].data.password, undefined);

  // Endpoints are private to their owner.
  for (const [method, path] of [
    ['GET', `/webhooks/${aliceHook.id}`],
    ['PATCH', `/webhooks/${aliceHook.id}`],
    ['DELETE', `/webhooks/${aliceHook.id}`],
    ['GET', `/webhooks/${aliceHook.id}/deliveries`],
    ['POST', `/webhooks/${aliceHook.id}/rotate-secret`],
    ['POST', `/webhooks/${aliceHook.id}/test`],
  ]) {
    const res = await t.request(method, path, method === 'POST' || method === 'PATCH' ? {} : undefined, bob);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal((await t.get('/webhooks')).status, 401);
});

test('visibility rules (calm/resource/visibility.js): scope() filters are judged on the event copy, and global endpoints stay inside scope()', async () => {
  const { matchesFilter, inScope } = await project.load('calm/resource/visibility.js');
  const { Types } = t.app.mongoose;
  const author = new Types.ObjectId();
  const doc = { _id: new Types.ObjectId(), status: 'draft', author, tags: ['a', 'b'], org: 'acme' };
  assert.equal(matchesFilter({ $or: [{ status: 'published' }, { author: String(author) }] }, doc), true, 'ObjectId and string ids compare equal');
  assert.equal(matchesFilter({ $or: [{ status: 'published' }, { author: String(new Types.ObjectId()) }] }, doc), false);
  assert.equal(matchesFilter({ tags: 'b', status: { $in: ['draft', 'review'] }, deletedAt: null }, doc), true);
  assert.equal(matchesFilter({ status: { $ne: 'draft' } }, doc), false);
  assert.equal(matchesFilter({ $nor: [{ org: 'other' }], archived: { $exists: false } }, doc), true);
  assert.equal(matchesFilter({ title: /secret/ }, doc), null, 'unknown: asked to MongoDB, never guessed');
  assert.equal(matchesFilter({ score: { $gt: 3 } }, doc), null);

  // A tenant scope keeps a tenant admin's global endpoint inside their tenant, deleted records included.
  const tenantEntry = (filter) => ({ service: { scope: () => filter }, model: { exists: async () => { throw new Error('not reached'); } } });
  const otherTenant = { ...doc, org: 'globex' };
  assert.equal(await inScope(tenantEntry({ org: 'acme' }), doc, admin.user, { deleted: true }), true);
  assert.equal(await inScope(tenantEntry({ org: 'acme' }), otherTenant, admin.user, { deleted: true }), false);
  assert.equal(await inScope(tenantEntry({ title: /x/ }), doc, admin.user, { deleted: true }), false, 'a deleted record cannot be checked in MongoDB: refused');
  assert.equal(await inScope(tenantEntry({}), otherTenant, admin.user), true, 'no scope: everything');
});

test('rotate-secret: a new secret is shown once, the old one keeps signing during the grace period', async () => {
  const w = await endpoint(alice, '/ok/rotate', ['post.created']);
  const rotated = await t.post(`/webhooks/${w.id}/rotate-secret`, {}, alice);
  assert.equal(rotated.status, 200);
  const { secret, previousSecretExpiresAt } = rotated.body.data;
  assert.match(secret, /^whsec_/);
  assert.notEqual(secret, w.secret);
  assert.ok(Date.parse(previousSecretExpiresAt) > Date.now() + 23 * 3_600_000);
  assert.equal((await t.get(`/webhooks/${w.id}`, alice)).body.data.secret, undefined);

  await publish(alice, 'Rotated');
  const [hit] = await waitFor(() => at('/ok/rotate').length && at('/ok/rotate'), 'the delivery');
  assert.equal(hit.headers['webhook-signature'].split(' ').length, 2, 'signed with both secrets');
  assert.equal(verifyWebhook(secret, hit.headers, hit.body).type, 'post.created');
  assert.equal(verifyWebhook(w.secret, hit.headers, hit.body).type, 'post.created', 'receivers on the old secret keep working');
});

test('test events are sent at once and any delivery can be sent again', async () => {
  const w = await endpoint(bob, '/ok/ping', ['post.created']);
  const res = await t.post(`/webhooks/${w.id}/test`, {}, bob);
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.data.type, res.body.data.status, res.body.data.statusCode], ['webhook.test', 'succeeded', 200]);
  const [hit] = at('/ok/ping');
  const event = verifyWebhook(w.secret, hit.headers, hit.body);
  assert.equal(event.type, 'webhook.test');
  assert.equal(event.data.webhook, w.id);

  const again = await t.post(`/webhooks/${w.id}/deliveries/${res.body.data.id}/retry`, {}, bob);
  assert.equal(again.status, 200);
  assert.equal(again.body.data.status, 'succeeded');
  assert.equal(again.body.data.attemptLog.length, 2);
  assert.equal(at('/ok/ping').length, 2);
  assert.equal(at('/ok/ping')[1].headers['webhook-id'], hit.headers['webhook-id'], 'same id, so receivers can skip duplicates');
  assert.equal((await t.post(`/webhooks/${w.id}/deliveries/${'0'.repeat(24)}/retry`, {}, bob)).status, 404);
  assert.equal((await t.post(`/webhooks/${w.id}/deliveries/nope/retry`, {}, bob)).status, 404);
});

test('redirects are never followed and slow receivers time out; both are retried', async () => {
  const moved = await endpoint(bob, '/redirect/1', ['post.created']);
  const redirected = (await t.post(`/webhooks/${moved.id}/test`, {}, bob)).body.data;
  assert.deepEqual([redirected.statusCode, redirected.error, redirected.status], [302, 'HTTP 302', 'pending']);
  assert.ok(Date.parse(redirected.nextAttemptAt) > Date.now() - 1000, 'a retry is scheduled');

  const slow = await endpoint(bob, '/slow/1', ['post.created']);
  const timedOut = (await t.post(`/webhooks/${slow.id}/test`, {}, bob)).body.data;
  assert.deepEqual([timedOut.statusCode, timedOut.error, timedOut.status], [null, 'No answer within 0.3s', 'pending']);

  for (const w of [moved, slow]) await t.delete(`/webhooks/${w.id}`, bob);
});

test('validation and limits: URLs, event names, endpoints per user; a deleted user takes their endpoints along', async () => {
  const carol = await t.signup({ name: 'Carol' });
  const problem = async (body, field) => {
    const res = await t.post('/webhooks', body, carol);
    assert.equal(res.status, 422, JSON.stringify(res.body));
    assert.ok(res.body.error.details[field], JSON.stringify(res.body));
    return res.body.error.details[field];
  };
  const url = `${base}/ok/carol`;
  await problem({ url: 'ftp://example.com/hook', events: ['post.*'] }, 'url');
  await problem({ url: `${base}/ok/${'a'.repeat(2100)}`, events: ['post.*'] }, 'url');
  assert.match(await problem({ url: 'https://user:pass@example.com/hook', events: ['post.*'] }, 'url'), /user name or password/);
  assert.match(await problem({ url, events: ['order.created'] }, 'events'), /Unknown resource "order"/);
  assert.match(await problem({ url, events: ['post.published'] }, 'events'), /Unknown event "post.published"/);
  assert.match(await problem({ url, events: ['post'] }, 'events'), /not an event name/);
  await problem({ url, events: [] }, 'events');
  await problem({ url, events: Array.from({ length: 21 }, () => 'post.created') }, 'events');
  await problem({ url, events: ['post.*'], scope: 'everything' }, 'scope');

  const first = await t.post('/webhooks', { url, events: ['post.created', 'post.created', 'note.*'], description: 'CRM sync' }, carol);
  assert.deepEqual(first.body.data.events, ['post.created', 'note.*'], 'duplicates are dropped');
  const patched = await t.patch(`/webhooks/${first.body.data.id}`, { events: ['*'], description: null, url: `${base}/ok/carol2` }, carol);
  assert.equal(patched.status, 200);
  assert.deepEqual([patched.body.data.events, patched.body.data.description, patched.body.data.url], [['*'], null, `${base}/ok/carol2`]);
  assert.equal((await t.patch(`/webhooks/${first.body.data.id}`, { url: 'gopher://x' }, carol)).status, 422);

  for (let i = 1; i < 10; i++) await endpoint(carol, `/ok/carol-${i}`);
  const over = await t.post('/webhooks', { url, events: ['post.*'] }, carol);
  assert.equal(over.status, 409);
  assert.equal(over.body.error.code, 'LIMIT_REACHED');

  assert.equal((await t.delete(`/users/${carol.id}`, admin)).status, 204);
  await t.idle();
  assert.equal(await t.app.ext.webhooks.Webhook.countDocuments({ owner: carol.id }), 0);
});

test('SSRF checks: private, loopback, link-local, CGNAT and metadata addresses are refused', async () => {
  const { isPublicAddress, urlProblem, guardedLookup } = ssrf;
  const refused = [
    '127.0.0.1', '127.8.9.10', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1',
    '100.100.100.200', '192.0.0.192', '0.0.0.0', '224.0.0.1', '255.255.255.255', '::', '::1', 'fe80::1', 'fe80::1%eth0', 'fc00::1',
    'fd00:ec2::254', 'ff02::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::127.0.0.1', '64:ff9b::a9fe:a9fe',
    '2002:7f00:1::1', '2001:db8::1', '2001::1', 'not-an-ip', '',
  ];
  for (const ip of refused) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['8.8.8.8', '1.1.1.1', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808']) {
    assert.equal(isPublicAddress(ip), true, ip);
  }

  const strict = { allowPrivate: false };
  for (const url of [
    'http://127.0.0.1:3000/hook', 'http://localhost/hook', 'http://api.localhost/hook', 'http://LOCALHOST./hook', 'http://2130706433/',
    'http://0x7f.1/', 'http://[::1]:8080/', 'http://[::ffff:169.254.169.254]/latest/meta-data/', 'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.5/', 'http://[fd00:ec2::254]/', 'http://0.0.0.0:5001/',
  ]) {
    assert.match(await urlProblem(url, strict), /public address/, url);
  }
  // Host names: every address they resolve to must be public, and the message never says which.
  const resolvingTo = (...ips) => ({ ...strict, lookup: async () => ips });
  const mixed = await urlProblem('https://hooks.example.com/x', resolvingTo('93.184.216.34', '10.0.0.1'));
  assert.match(mixed, /public address/);
  assert.ok(!mixed.includes('10.0.0.1'), 'internal addresses are not revealed');
  assert.equal(await urlProblem('https://hooks.example.com/x', resolvingTo('93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946')), null);
  assert.match(await urlProblem('https://typo.example/x', { ...strict, lookup: async () => { throw new Error('ENOTFOUND'); } }), /could not be found/);
  assert.equal(await urlProblem('https://8.8.8.8/hook', strict), null);
  assert.equal(await urlProblem('http://127.0.0.1/hook', { allowPrivate: true }), null, 'allowed in development and tests');
  assert.match(await urlProblem('http://8.8.8.8/hook', { ...strict, requireHttps: true }), /https/);

  // At send time the socket only connects to addresses that passed the check.
  const lookup = guardedLookup({ allowPrivate: false });
  const blocked = await new Promise((resolve) => lookup('127.0.0.1', { all: true }, (err) => resolve(err)));
  assert.equal(blocked?.code, 'ESSRF');
  const allowed = await new Promise((resolve) => lookup('8.8.8.8', { all: true }, (err, list) => resolve(err ?? list)));
  assert.deepEqual(allowed.map((a) => a.address), ['8.8.8.8']);
});

test('SSRF: with allowPrivate off, private URLs are refused when saved and when sent', async () => {
  const strict = await project.testApp({ blocks: { webhooks: { allowPrivate: false, pollMs: 20, retrySchedule: [] } } });
  try {
    const u = await strict.signup();
    const res = await strict.post('/webhooks', { url: `${base}/ok/ssrf`, events: ['post.*'] }, u);
    assert.equal(res.status, 422);
    assert.match(res.body.error.details.url, /public address/);

    // An endpoint saved while private addresses were allowed is refused on delivery.
    const { Webhook, Delivery, drain } = strict.app.ext.webhooks;
    await Webhook.create({ owner: u.id, url: `${base}/ok/ssrf`, events: ['post.*'], secret: `whsec_${Buffer.alloc(32, 1).toString('base64')}` });
    await strict.post('/posts', { title: 'Internal', body: 'x', status: 'published' }, u);
    await strict.idle();
    await drain();
    const [d] = await Delivery.find().lean();
    assert.equal(d.status, 'failed');
    assert.match(d.lastError, /^Refused: Must be a public address/);
    assert.equal(at('/ok/ssrf').length, 0, 'nothing reached the private address');
  } finally {
    await strict.close();
  }
});

test('doctor and the devtools panel', async () => {
  await t.app.ext.webhooks.refreshStats();
  const findings = await t.app.doctor();
  const count = findings.find((f) => f.id === 'webhooks-endpoints');
  assert.equal(count?.level, 'info');
  assert.match(count.title, /^\d+ webhook endpoints, \d+ enabled$/);
  assert.deepEqual(findings.filter((f) => f.level === 'error'), []);

  const panel = await t.app.hooks.devtools.webhooks(t.app);
  assert.ok(panel.endpoints.length > 0);
  assert.ok(panel.deliveries.length > 0);
  assert.ok(!JSON.stringify(panel).includes('whsec_'), 'no secrets in devtools');

  const { paths } = t.app.openapi();
  assert.ok(paths['/api/webhooks'].post);
  assert.ok(paths['/api/webhooks/{id}/deliveries/{deliveryId}/retry'].post);
});
