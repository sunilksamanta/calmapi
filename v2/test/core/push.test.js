import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

let project;
let t;
let push;
const devtools = (path, init = {}) =>
  fetch(`${t.origin}/_calm/api${path}`, {
    ...init,
    headers: { host: 'localhost', ...(init.body ? { 'content-type': 'application/json', 'x-calm-devtools': '1' } : {}), ...(init.headers ?? {}) },
  });

before(async () => {
  project = await makeProject({
    files: {
      'app/routes.js': `export default (r) => {
  r.post('/notify-me', { policy: 'authenticated' }, (ctx) => ctx.push.send({ to: ctx.user.id, title: 'Hello', body: 'From a route' }));
};
`,
    },
  });
  t = await project.testApp({ devtools: { enabled: true } });
  push = await project.load('calm/push.js');
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('messages are validated and normalized', () => {
  assert.throws(() => push.normalizeMessage({}), (err) => err.status === 422 && Boolean(err.details.title));
  assert.throws(() => push.normalizeMessage({ silent: true }), (err) => Boolean(err.details.data));
  assert.throws(() => push.normalizeMessage({ title: 'x', badge: -1 }), (err) => Boolean(err.details.badge));
  assert.throws(() => push.normalizeMessage({ title: 'x', data: [1] }), (err) => Boolean(err.details.data));
  const m = push.normalizeMessage({ title: 'Hi', body: 'There' });
  assert.equal(m.sound, 'default');
  assert.equal(m.priority, 'high');
  assert.equal(push.normalizeMessage({ title: 'Hi', sound: false }).sound, undefined);
});

test('provider payloads, sizes and warnings', () => {
  const m = push.normalizeMessage({ title: 'Order shipped', body: 'Arrives Thursday', data: { orderId: 42 }, url: '/orders/42', badge: 3, image: 'https://cdn.example.com/a.png' });
  const p = push.providerPayloads(m, 'tok');
  assert.deepEqual(p.apns.payload.aps.alert, { title: 'Order shipped', body: 'Arrives Thursday' });
  assert.equal(p.apns.payload.aps.badge, 3);
  assert.equal(p.apns.payload.aps['mutable-content'], 1, 'images need a notification service extension on iOS');
  assert.equal(p.fcm.payload.message.data.orderId, '42', 'FCM data values are strings');
  assert.equal(p.fcm.payload.message.data.url, '/orders/42');
  assert.equal(p.expo.payload.to, 'tok');
  assert.ok(p.apns.bytes < p.apns.limit);

  const big = push.normalizeMessage({ title: 'x', data: { blob: 'y'.repeat(5000) } });
  const warnings = push.messageWarnings(big, push.providerPayloads(big), []);
  assert.ok(warnings.some((w) => w.id === 'size-apns' && w.level === 'error'));

  const long = push.normalizeMessage({ title: 'A title that is far too long to fit on one line of a phone', body: 'b'.repeat(200), data: { resetToken: 'abc' } });
  const ws = push.messageWarnings(long, push.providerPayloads(long), [{ platform: 'ios' }, { platform: 'android' }]);
  assert.ok(ws.some((w) => w.id === 'title-ios'));
  assert.ok(ws.some((w) => w.id === 'body-android'));
  assert.ok(ws.some((w) => w.id === 'data-resetToken' && w.level === 'warn'), 'sensitive data in a push payload is flagged');
});

test('devices: register, list masked, move between users, remove', async () => {
  const a = await t.signup();
  const b = await t.signup();
  const token = 'fcm-token-0123456789abcdef';
  const created = await t.post('/auth/devices', { token, platform: 'android', name: 'Pixel' }, a);
  assert.equal(created.status, 201);
  assert.notEqual(created.body.data.token, token, 'tokens are never echoed in full');

  assert.equal((await t.post('/auth/devices', { token: 'x', platform: 'symbian' }, a)).status, 422);
  assert.equal((await t.post('/auth/devices', { token: 'sim_ios_1', platform: 'ios' }, a)).status, 422);
  assert.equal((await t.post('/auth/devices', { token, platform: 'android' })).status, 401);

  assert.equal((await t.get('/auth/devices', a)).body.data.length, 1);
  await t.post('/auth/devices', { token, platform: 'android' }, b);
  assert.equal((await t.get('/auth/devices', a)).body.data.length, 0, 'the same token re-registered by another user moves to them');
  const [mine] = (await t.get('/auth/devices', b)).body.data;
  assert.equal((await t.delete(`/auth/devices/${mine.id}`, a)).status, 404, 'cannot remove someone else\'s device');
  assert.equal((await t.delete(`/auth/devices/${mine.id}`, b)).status, 204);
});

test('send to a user: captured in tests and development, with the request that sent it', async () => {
  const u = await t.signup();
  await t.post('/auth/devices', { token: 'apns-token-aaaaaaaaaaaaaaaa', platform: 'ios' }, u);
  await t.post('/auth/devices', { token: 'fcm-token-bbbbbbbbbbbbbbbbbb', platform: 'android' }, u);
  const before = t.pushes.length;
  const res = await t.post('/notify-me', {}, u);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.status, 'captured');
  assert.equal(res.body.data.devices, 2);

  const record = t.pushes[before];
  assert.equal(record.message.title, 'Hello');
  assert.deepEqual(record.devices.map((d) => d.platform).sort(), ['android', 'ios']);
  assert.ok(record.devices.every((d) => d.token.includes('…')), 'records never hold full tokens');
  assert.ok(record.requestId, 'linked to the request that sent it');
  assert.ok(record.log.every((l) => /captured/.test(l.text)));

  const none = await t.app.push.send({ to: (await t.signup()).id, title: 'Nobody home' });
  assert.equal(none.status, 'no-devices');
});

test('a real transport gets real devices only, and unregistered tokens are removed', async () => {
  const u = await t.signup();
  await t.post('/auth/devices', { token: 'good-token-1111111111111111', platform: 'android' }, u);
  await t.post('/auth/devices', { token: 'dead-token-2222222222222222', platform: 'android' }, u);
  const sim = await devtools('/devices/simulate', { method: 'POST', body: JSON.stringify({ userId: u.id, platform: 'ios' }) });
  assert.equal(sim.status, 201);
  assert.equal((await sim.json()).simulated, true);

  const handed = [];
  t.app.push.use({
    name: 'fake',
    async send(message, devices) {
      handed.push(...devices);
      return devices.map((d) => (d.token.startsWith('good') ? { ok: true, id: 'msg-1' } : { ok: false, error: 'Unregistered', unregistered: true }));
    },
  });
  try {
    const res = await t.app.push.send({ to: u.id, title: 'Real' });
    assert.equal(res.status, 'partial');
    assert.deepEqual(handed.map((d) => d.token).sort(), ['dead-token-2222222222222222', 'good-token-1111111111111111'], 'simulated devices never reach a real transport');
    const left = (await t.get('/auth/devices', u)).body.data;
    assert.equal(left.length, 2, 'the dead token was removed, the good one and the simulated one stay');
    const record = t.pushes.at(-1);
    assert.ok(record.log.some((l) => l.level === 'error' && /device removed/.test(l.text)));
    assert.ok(record.log.some((l) => /^Accepted by simulator/.test(l.text)), 'the simulated device went to the simulator');
  } finally {
    t.app.push.use(null);
  }
});

test('devtools: list notifications, simulate devices, send a test', async () => {
  const u = await t.signup({ name: 'Grace Hopper' });
  assert.equal((await devtools('/devices/simulate', { method: 'POST', body: JSON.stringify({ userId: u.id, platform: 'android' }), headers: { 'x-calm-devtools': '' } })).status, 403);
  const dev = await (await devtools('/devices/simulate', { method: 'POST', body: JSON.stringify({ userId: u.id, platform: 'android' }) })).json();
  const devices = await (await devtools(`/devices?user=${u.id}`)).json();
  assert.equal(devices.length, 1);
  assert.equal(devices[0].user.name, 'Grace Hopper');

  const sent = await devtools('/push/test', { method: 'POST', body: JSON.stringify({ deviceIds: [dev.id], title: 'Test from devtools', body: 'Looks right?', data: { screen: 'home' } }) });
  assert.equal(sent.status, 201);
  assert.equal((await devtools('/push/test', { method: 'POST', body: JSON.stringify({ deviceIds: [dev.id] }) })).status, 422);

  const list = await (await devtools('/pushes')).json();
  const latest = list[0];
  assert.equal(latest.message.title, 'Test from devtools');
  assert.equal(latest.devices[0].platform, 'android');
  assert.ok(latest.payloads.fcm.bytes > 0);
  assert.equal((await (await devtools('/overview')).json()).push, 'dev-capture', 'without a transport, pushes are captured');

  assert.equal((await devtools(`/devices/${dev.id}`, { method: 'DELETE', headers: { 'x-calm-devtools': '1' } })).status, 204);
});

test('production without a transport fails loudly instead of pretending to send', async () => {
  const errors = [];
  const log = { info() {}, warn() {}, error: (msg) => errors.push(msg) };
  const prod = push.createPush({ log, mode: 'production' });
  assert.equal(prod.transport, null);
  const res = await prod.send({ tokens: ['real-token-333333333333333'], title: 'Hi' });
  assert.equal(res.status, 'failed');
  assert.match(errors[0], /no push transport configured/);
  const sim = await prod.send({ tokens: ['sim_ios_abc'], title: 'Hi' });
  assert.equal(sim.status, 'captured', 'simulated devices are never an error');
});

test('device simulator: each behavior answers like a real phone', async () => {
  const u = await t.signup({ name: 'Sim User' });
  const add = async (behavior, platform = 'ios') => (await devtools('/devices', { method: 'POST', body: JSON.stringify({ userId: u.id, platform, behavior, name: `Phone ${behavior}` }) })).json();
  const phones = {};
  for (const b of ['deliver', 'offline', 'muted', 'uninstalled', 'invalid', 'rate-limited']) phones[b] = await add(b, b === 'muted' ? 'android' : 'ios');
  assert.equal(phones.offline.behavior, 'offline');
  assert.equal(phones.deliver.via, 'simulator');

  const opened = [];
  const off = t.app.events.on('push.opened', (payload) => opened.push(payload));
  const res = await t.app.push.send({ to: u.id, title: 'Table ready', url: '/tables/7' });
  assert.equal(res.status, 'partial', 'three devices failed like real ones would');
  const record = t.pushes.at(-1);
  const about = (b) => record.log.filter((l) => l.device === phones[b].id).map((l) => l.text).join(' | ');
  assert.match(about('deliver'), /Accepted by simulator.*Receipt from simulator.*Shown on Phone deliver/);
  assert.match(about('muted'), /Not shown on Phone muted: notifications are turned off/);
  assert.match(about('offline'), /Waiting: Phone offline is offline/);
  assert.match(about('uninstalled'), /DeviceNotRegistered.*device removed/);
  assert.match(about('invalid'), /InvalidRegistration.*device removed/);
  assert.match(about('rate-limited'), /MessageRateExceeded/);

  const left = (await (await devtools(`/devices?user=${u.id}`)).json()).map((d) => d.behavior).sort();
  assert.deepEqual(left, ['deliver', 'muted', 'offline', 'rate-limited'], 'uninstalled and invalid devices were removed');

  const inbox = await (await devtools(`/devices/${phones.offline.id}/inbox`)).json();
  assert.equal(inbox.items[0].state, 'waiting');
  assert.equal((await (await devtools(`/devices/${phones.offline.id}/online`, { method: 'POST', body: '{}' })).json()).shown, 1);
  assert.match(about('offline'), /came back online/);

  const tap = await devtools(`/devices/${phones.deliver.id}/inbox/${record.id}/open`, { method: 'POST', body: '{}' });
  assert.equal(tap.status, 200);
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, '/tables/7');
  assert.match(about('deliver'), /Opened on Phone deliver: the app opens \/tables\/7/);
  assert.equal((await devtools(`/devices/${phones.muted.id}/inbox/${record.id}/open`, { method: 'POST', body: '{}' })).status, 404, 'a hidden notification cannot be tapped');
  off();
});

test('device simulator: rotating a token leaves the old one to fail once, then removed', async () => {
  const u = await t.signup();
  const first = await (await devtools('/devices', { method: 'POST', body: JSON.stringify({ userId: u.id, platform: 'android' }) })).json();
  const rotated = await (await devtools(`/devices/${first.id}/rotate`, { method: 'POST', body: '{}' })).json();
  assert.notEqual(rotated.id, first.id);
  const res = await t.app.push.send({ to: u.id, title: 'After rotation' });
  assert.equal(res.status, 'partial');
  const ids = (await (await devtools(`/devices?user=${u.id}`)).json()).map((d) => d.id);
  assert.deepEqual(ids, [rotated.id], 'the stale token was removed by the failed send');
});

test('devtools: a real token can be added to a user and goes through the real path', async () => {
  const u = await t.signup();
  const real = await (await devtools('/devices', { method: 'POST', body: JSON.stringify({ userId: u.id, platform: 'ios', token: 'ExponentPushToken[pasted-from-my-phone]' }) })).json();
  assert.equal(real.simulated, false);
  assert.equal(real.via, 'dev-capture', 'no transport installed in this test app, so it is captured');
  const behavior = await devtools(`/devices/${real.id}`, { method: 'PATCH', body: JSON.stringify({ behavior: 'offline' }) });
  assert.equal(behavior.status, 400, 'real devices have no simulated behavior');
});

test('push devices follow the session that registered them', async () => {
  const u = await t.signup();
  await t.post('/auth/devices', { token: 'session-bound-token-1', platform: 'ios' }, u);
  assert.equal((await t.get('/auth/devices', u)).body.data[0].signedIn, true);
  const second = (await t.post('/auth/login', { email: u.email, password: u.password })).body.data.token;
  await t.post('/auth/devices', { token: 'session-bound-token-2', platform: 'android' }, second);
  assert.equal((await t.get('/auth/devices', u)).body.data.length, 2);

  assert.equal((await t.post('/auth/logout', {}, second)).status, 204);
  const left = (await t.get('/auth/devices', u)).body.data;
  assert.equal(left.length, 1, 'signing out removed the device that session registered');

  // A session that expired on its own (TTL): the device is skipped and removed at send time.
  await t.app.auth.service.Session.deleteMany({ user: u.id });
  const fresh = (await t.post('/auth/login', { email: u.email, password: u.password })).body.data.token;
  assert.equal((await t.get('/auth/devices', fresh)).body.data.length, 1, 'still stored until a send notices');
  const res = await t.app.push.send({ to: u.id, title: 'Anyone there?' });
  assert.equal(res.status, 'no-devices');
  assert.ok(t.pushes.at(-1).log.some((l) => /the session that registered it has ended/.test(l.text)));
  assert.equal((await t.get('/auth/devices', fresh)).body.data.length, 0);
});

test('apps can unregister by token, and a password reset ends devices with the sessions', async () => {
  const u = await t.signup();
  await t.post('/auth/devices', { token: 'unregister-me-token', platform: 'ios' }, u);
  assert.equal((await t.post('/auth/devices/unregister', { token: 'unregister-me-token' }, u)).status, 204);
  assert.equal((await t.get('/auth/devices', u)).body.data.length, 0);

  await t.post('/auth/devices', { token: 'reset-ends-me-token', platform: 'android' }, u);
  await t.post('/auth/password/forgot', { email: u.email });
  await t.idle();
  const token = t.mails.at(-1).meta.token;
  assert.equal((await t.post('/auth/password/reset', { token, password: 'brand-new-password-9' })).status, 204);
  const device = await t.app.push.devices.findOne({ token: 'reset-ends-me-token' }).lean();
  assert.equal(device, null, 'a password reset signs out everywhere, so no phone keeps getting notifications');
});

test('auth.devicesFollowSessions: false keeps devices after their session ends', async () => {
  const other = await makeProject();
  const t2 = await other.testApp({ auth: { devicesFollowSessions: false } });
  try {
    const u = await t2.signup();
    await t2.post('/auth/devices', { token: 'stays-after-logout-token', platform: 'ios' }, u);
    assert.equal((await t2.post('/auth/logout', {}, u)).status, 204);
    await t2.app.auth.service.Session.deleteMany({ user: u.id });
    const res = await t2.app.push.send({ to: u.id, title: 'Still here?' });
    assert.notEqual(res.status, 'no-devices', 'the device is still a target');
    assert.ok(await t2.app.push.devices.findOne({ token: 'stays-after-logout-token' }).lean());
  } finally {
    await t2.close();
    other.cleanup();
  }
});
