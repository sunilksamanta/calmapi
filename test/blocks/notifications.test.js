import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
const devtools = (path, body) =>
  fetch(`${t.origin}/_calm/api${path}`, { method: body ? 'POST' : 'GET', headers: { host: 'localhost', ...(body ? { 'content-type': 'application/json', 'x-calm-devtools': '1' } : {}) }, body: body ? JSON.stringify(body) : undefined }).then((r) => r.json());

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({
    files: {
      'app/notifications/order-shipped.js': `export default {
  title: ({ number }) => \`Order #\${number} shipped\`,
  body: 'It arrives Thursday.',
  url: ({ number }) => \`/orders/\${number}\`,
  category: 'orders',
  channels: ['inbox', 'push', 'email'],
};
`,
      'app/notifications/new-sign-in.js': `export default {
  title: 'New sign-in to your account',
  body: 'If this was not you, change your password.',
  channels: ['inbox', 'push', 'email'],
  required: true,
};
`,
      'app/routes.js': `export default (r) => {
  r.post('/demo/ship/:number', { policy: 'authenticated' }, (ctx) => ctx.notify(ctx.user.id, 'order-shipped', { number: ctx.params.number }));
};
`,
    },
  });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'notifications', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

test('one call writes the inbox, sends a push with the unread badge and an email', async () => {
  const u = await t.signup({ name: 'Ada' });
  await t.post('/auth/devices', { token: 'phone-token-aaaaaaaaaaaa', platform: 'ios' }, u);
  const res = await t.post('/demo/ship/1042', {}, u);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.channels, { inbox: true, push: 'captured', email: 'sent' });

  const list = (await t.get('/notifications', u)).body.data;
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'Order #1042 shipped');
  assert.equal(list[0].url, '/orders/1042');
  assert.equal(list[0].readAt, undefined);

  const push = t.pushes.at(-1);
  assert.equal(push.message.title, 'Order #1042 shipped');
  assert.equal(push.message.badge, 1, 'the badge is the unread count');
  assert.equal(push.message.data.notificationId, list[0].id);
  await t.idle();
  const mail = t.mails.at(-1);
  assert.equal(mail.subject, 'Order #1042 shipped');
  assert.match(mail.text, /It arrives Thursday\.\n\nhttp.*\/orders\/1042/);
});

test('inbox: unread count, mark read, read all, and only your own', async () => {
  const a = await t.signup();
  const b = await t.signup();
  await t.app.ext.notify(a.id, { title: 'One' });
  await t.app.ext.notify(a.id, { title: 'Two' });
  const [first] = (await t.get('/notifications', a)).body.data;
  assert.equal((await t.get('/notifications/unread-count', a)).body.data.count, 2);
  assert.equal((await t.get(`/notifications/${first.id}`, b)).status, 404, 'someone else cannot read it');
  assert.equal((await t.post(`/notifications/${first.id}/read`, {}, b)).status, 404);
  assert.ok((await t.post(`/notifications/${first.id}/read`, {}, a)).body.data.readAt);
  assert.equal((await t.get('/notifications/unread-count', a)).body.data.count, 1);
  assert.equal((await t.post('/notifications/read-all', {}, a)).body.data.marked, 1);
  assert.equal((await t.post('/notifications', { title: 'Forged' }, a)).status, 403, 'nobody creates notifications through the API');
});

test('preferences: per category, quiet hours, required types ignore them', async () => {
  const u = await t.signup();
  await t.post('/auth/devices', { token: 'phone-token-bbbbbbbbbbbb', platform: 'android' }, u);
  const prefs = (await t.get('/notifications/preferences', u)).body.data;
  assert.deepEqual(prefs.types.map((x) => x.type).sort(), ['new-sign-in', 'order-shipped', 'welcome']);

  assert.equal((await t.patch('/notifications/preferences', { channels: { orders: { push: false, email: false } } }, u)).status, 200);
  assert.deepEqual((await t.app.ext.notify(u.id, 'order-shipped', { number: 7 })).channels, { inbox: true });

  const bad = await t.patch('/notifications/preferences', { channels: { nope: { push: false } }, quietHours: { start: '25:00', end: '07:00' } }, u);
  assert.equal(bad.status, 422);

  const now = new Date();
  const hh = (d) => `${String(d.getUTCHours()).padStart(2, '0')}:00`;
  await t.patch('/notifications/preferences', { channels: { orders: { push: true } }, quietHours: { start: hh(new Date(now - 3_600_000)), end: hh(new Date(+now + 7_200_000)), timeZone: 'UTC' } }, u);
  const quiet = await t.app.ext.notify(u.id, 'order-shipped', { number: 8 });
  assert.equal(quiet.quietHours, true);
  assert.equal(quiet.channels.push, undefined, 'no push during quiet hours');

  await t.patch('/notifications/preferences', { channels: { 'new-sign-in': { push: false } } }, u);
  const required = await t.app.ext.notify(u.id, 'new-sign-in');
  assert.ok(required.channels.push && required.channels.email, 'security notices go out whatever the preferences say');
});

test('tapping the push on a simulated phone marks the inbox entry read', async () => {
  const u = await t.signup();
  const phone = await devtools('/devices', { userId: u.id, platform: 'ios' });
  const sent = await t.app.ext.notify(u.id, { title: 'Tap me', url: '/x' });
  const pushId = t.pushes.at(-1).id;
  await devtools(`/devices/${phone.id}/inbox/${pushId}/open`, {});
  await t.idle();
  const entry = (await t.get(`/notifications/${sent.id}`, u)).body.data;
  assert.ok(entry.readAt, 'push.opened marked it read');
});

test('a real app reports opens with POST /auth/devices/opened, only for its own entries', async () => {
  const owner = await t.signup();
  const stranger = await t.signup();
  const sent = await t.app.ext.notify(owner.id, { title: 'Hello' });

  const sneaky = await t.post('/auth/devices/opened', { data: { notificationId: sent.id } }, stranger);
  assert.equal(sneaky.status, 204);
  await t.idle();
  assert.ok(!(await t.get(`/notifications/${sent.id}`, owner)).body.data.readAt, 'another user cannot mark it read');

  assert.equal((await t.post('/auth/devices/opened', { pushId: 'abc', data: { notificationId: sent.id } }, owner)).status, 204);
  await t.idle();
  assert.ok((await t.get(`/notifications/${sent.id}`, owner)).body.data.readAt, 'the owner opening it marks it read');
  assert.equal((await t.post('/auth/devices/opened', {})).status, 401);
});

test('unknown types are a clear error', async () => {
  const u = await t.signup();
  await assert.rejects(() => t.app.ext.notify(u.id, 'does-not-exist'), /Create app\/notifications\/does-not-exist\.js/);
});
