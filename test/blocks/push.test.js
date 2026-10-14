import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// Fakes of the Expo push service and of Google (OAuth token endpoint and FCM HTTP v1) that
// answer in the formats of their documentation, so the blocks run their real code offline.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const seen = { expo: [], receipts: [], token: [], fcm: [] };
const fake = { expo429: 0, receipts: {} };
let ticketCount = 0;
let server;
let origin;

const read = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    resolve(req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw).toString() : raw.toString());
  });
});
const reply = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  server = createServer(async (req, res) => {
    const body = await read(req);
    if (req.url === '/expo/push/send') {
      if (fake.expo429 > 0) {
        fake.expo429 -= 1;
        return reply(res, 429, { errors: [{ code: 'TOO_MANY_REQUESTS', message: 'Slow down' }] });
      }
      const messages = JSON.parse(body);
      const projects = new Set(messages.map((m) => (m.to.includes('projB') ? '@acme/b' : '@acme/a')));
      seen.expo.push({ auth: req.headers.authorization, gzip: req.headers['content-encoding'] === 'gzip', messages, rejected: projects.size > 1 });
      if (projects.size > 1) {
        const details = {};
        for (const m of messages) (details[m.to.includes('projB') ? '@acme/b' : '@acme/a'] ??= []).push(m.to);
        return reply(res, 400, { errors: [{ code: 'PUSH_TOO_MANY_EXPERIENCE_IDS', message: 'All push notification messages in the same request must be for the same project', details }] });
      }
      return reply(res, 200, {
        data: messages.map((m) => (m.to.includes('gone') ? { status: 'error', message: `"${m.to}" is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `ticket-${++ticketCount}` })),
      });
    }
    if (req.url === '/expo/push/getReceipts') {
      const { ids } = JSON.parse(body);
      seen.receipts.push(ids);
      return reply(res, 200, { data: Object.fromEntries(ids.filter((id) => fake.receipts[id]).map((id) => [id, fake.receipts[id]])) });
    }
    if (req.url === '/token') {
      const assertion = new URLSearchParams(body).get('assertion');
      const [h, p, sig] = assertion.split('.');
      const valid = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
      const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
      seen.token.push({ valid, claims, grant: new URLSearchParams(body).get('grant_type') });
      return valid ? reply(res, 200, { access_token: 'ya29.fake', expires_in: 3600, token_type: 'Bearer' }) : reply(res, 400, { error: 'invalid_grant' });
    }
    if (req.url === '/v1/projects/demo-app/messages:send') {
      const { message } = JSON.parse(body);
      seen.fcm.push({ auth: req.headers.authorization, message });
      if (message.token.includes('dead')) {
        return reply(res, 404, { error: { code: 404, message: 'Requested entity was not found.', status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } });
      }
      return reply(res, 200, { name: `projects/demo-app/messages/0:${seen.fcm.length}` });
    }
    reply(res, 404, {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const serviceAccount = () => JSON.stringify({ type: 'service_account', project_id: 'demo-app', client_email: 'push@demo-app.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${origin}/token` });

async function withBlocks(blocks, env, fn) {
  const p = await makeProject();
  Object.assign(process.env, env);
  try {
    calm(p.dir, 'add', ...blocks, '--yes', '--no-install');
    const t = await p.testApp();
    try {
      await fn(t);
    } finally {
      await t.close();
    }
  } finally {
    for (const k of Object.keys(env)) delete process.env[k];
    p.cleanup();
  }
}

test('push-expo: tickets, receipts, DeviceNotRegistered, simulated devices stay local', async () => {
  await withBlocks(['push-expo'], { EXPO_API_URL: `${origin}/expo`, EXPO_ACCESS_TOKEN: 'expo-secret' }, async (t) => {
    assert.equal(t.app.push.transport, 'expo');
    const u = await t.signup();
    await t.post('/auth/devices', { token: 'ExponentPushToken[good-aaaaaaaaaaaa]', platform: 'ios' }, u);
    await t.post('/auth/devices', { token: 'ExpoPushToken[later-bbbbbbbbbbbb]', platform: 'android' }, u);
    await t.post('/auth/devices', { token: 'ExponentPushToken[gone-cccccccccccc]', platform: 'android' }, u);
    await t.post('/auth/devices', { token: 'fcm-style-token-dddddddddddd', platform: 'android' }, u);
    await t.app.push.send({ tokens: ['sim_ios_local'], platform: 'ios', title: 'Never leaves' });
    assert.equal(seen.expo.length, 0, 'simulated devices are never sent to Expo');

    const res = await t.app.push.send({ to: u.id, title: 'Order shipped', body: 'Arrives Thursday', data: { orderId: 42 }, url: '/orders/42', image: 'https://cdn.example.com/a.png', collapseId: 'order-42' });
    assert.equal(res.status, 'partial');
    assert.equal(seen.expo.length, 1, 'one batched request');
    const [call] = seen.expo;
    assert.equal(call.auth, 'Bearer expo-secret');
    assert.equal(call.messages.length, 3, 'the non-Expo token is not sent to Expo');
    const [m] = call.messages;
    assert.deepEqual(m.data, { orderId: 42, url: '/orders/42' });
    assert.deepEqual(m.richContent, { image: 'https://cdn.example.com/a.png' }, 'images use richContent');
    assert.equal(m.mutableContent, true);
    assert.equal(m.collapseId, 'order-42');
    assert.equal(m._contentAvailable, undefined, 'the deprecated field is not used');

    const record = t.pushes.at(-1);
    assert.ok(record.log.some((l) => /^Accepted by expo \(ticket-/.test(l.text)));
    assert.ok(record.log.some((l) => /DeviceNotRegistered.*device removed/.test(l.text)));
    assert.ok(record.log.some((l) => /none of the installed transports \(expo\)/.test(l.text)));
    assert.equal((await t.get('/auth/devices', u)).body.data.length, 3, 'the device Expo rejected at once is removed');

    // Receipts: one handed to Apple, one whose app was uninstalled meanwhile.
    const tickets = record.log.filter((l) => l.ok).map((l) => l.providerId);
    fake.receipts[tickets[0]] = { status: 'ok' };
    fake.receipts[tickets[1]] = { status: 'error', message: 'The device is not registered', details: { error: 'DeviceNotRegistered' } };
    const summary = await t.app.ext.pushExpo.checkReceipts({ olderThan: 0 });
    assert.deepEqual({ checked: summary.checked, ok: summary.ok, removed: summary.removed }, { checked: 2, ok: 1, removed: 1 });
    assert.ok(record.log.some((l) => l.receipt && l.level === 'info'), 'the receipt lands in the same delivery log');
    assert.ok(record.log.some((l) => l.receipt && /DeviceNotRegistered/.test(l.text)));
    assert.equal((await t.get('/auth/devices', u)).body.data.length, 2);
    assert.equal((await t.app.ext.pushExpo.checkReceipts({ olderThan: 0 })).checked, 0, 'read receipts are not asked for again');
  });
});

test('push-expo: retries 429, gzips large bodies, splits tokens of different Expo projects', async () => {
  await withBlocks(['push-expo'], { EXPO_API_URL: `${origin}/expo` }, async (t) => {
    const before = seen.expo.length;
    fake.expo429 = 1;
    const res = await t.app.push.send({
      tokens: ['ExponentPushToken[projA-1111]', 'ExponentPushToken[projB-2222]', 'ExponentPushToken[projA-3333]'],
      platform: 'android',
      title: 'Weekly digest',
      body: 'x'.repeat(600),
    });
    assert.equal(res.status, 'sent');
    const calls = seen.expo.slice(before);
    assert.equal(fake.expo429, 0, 'the 429 was retried');
    for (const c of calls) assert.equal(c.gzip, JSON.stringify(c.messages).length > 1024, 'bodies over 1 KB are gzipped, smaller ones are not');
    assert.deepEqual(calls.filter((c) => c.rejected).map((c) => c.messages.length), [3], 'Expo refused the mixed batch once');
    assert.deepEqual(calls.filter((c) => !c.rejected).map((c) => c.messages.length).sort(), [1, 2], 'then one request per Expo project');
  });
});

test('push-fcm: signs a service account JWT, caches the token, removes UNREGISTERED tokens', async () => {
  await withBlocks(['push-fcm'], { FCM_SERVICE_ACCOUNT: serviceAccount(), FCM_API_URL: origin }, async (t) => {
    assert.equal(t.app.push.transport, 'fcm');
    const u = await t.signup();
    await t.post('/auth/devices', { token: 'fcm-live-token-1111111111', platform: 'android' }, u);
    await t.post('/auth/devices', { token: 'fcm-dead-token-2222222222', platform: 'ios' }, u);

    const before = seen.fcm.length;
    const res = await t.app.push.send({ to: u.id, title: 'Hello', body: 'From FCM', data: { n: 1 }, image: 'https://cdn.example.com/a.png', collapseId: 'greeting' });
    assert.equal(res.status, 'partial');
    assert.equal(seen.token.length, 1);
    assert.equal(seen.token[0].valid, true, 'the JWT is signed with the service account key');
    assert.equal(seen.token[0].grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(seen.token[0].claims.iss, 'push@demo-app.iam.gserviceaccount.com');
    assert.equal(seen.token[0].claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    const calls = seen.fcm.slice(before);
    assert.equal(calls.length, 2, 'one request per device');
    assert.ok(calls.every((c) => c.auth === 'Bearer ya29.fake'));
    const live = calls.find((c) => c.message.token.includes('live')).message;
    assert.equal(live.notification.title, 'Hello');
    assert.equal(live.data.n, '1', 'FCM data values are strings');
    assert.equal(live.apns.headers['apns-push-type'], 'alert');
    assert.equal(live.apns.headers['apns-collapse-id'], 'greeting');
    assert.equal(live.android.collapse_key, 'greeting');

    const record = t.pushes.at(-1);
    assert.ok(record.log.some((l) => /^Accepted by fcm \(projects\/demo-app\/messages\//.test(l.text)));
    assert.ok(record.log.some((l) => /UNREGISTERED.*device removed/.test(l.text)));
    assert.equal((await t.get('/auth/devices', u)).body.data.length, 1);

    await t.app.push.send({ to: u.id, silent: true, data: { sync: 'cart' } });
    assert.equal(seen.token.length, 1, 'the access token is cached');
    assert.equal(seen.fcm.at(-1).message.apns.headers['apns-push-type'], 'background');
  });
});

test('push-expo and push-fcm together: each token goes to its own service', async () => {
  await withBlocks(['push-expo', 'push-fcm'], { EXPO_API_URL: `${origin}/expo`, FCM_SERVICE_ACCOUNT: serviceAccount(), FCM_API_URL: origin }, async (t) => {
    assert.equal(t.app.push.transport, 'expo + fcm');
    const u = await t.signup();
    await t.post('/auth/devices', { token: 'ExponentPushToken[both-eeeeeeeeeeee]', platform: 'ios' }, u);
    await t.post('/auth/devices', { token: 'fcm-native-token-ffffffffff', platform: 'android' }, u);
    const expoBefore = seen.expo.length;
    const fcmBefore = seen.fcm.length;

    const res = await t.app.push.send({ to: u.id, title: 'Both ways' });
    assert.equal(res.status, 'sent');
    assert.deepEqual(seen.expo.slice(expoBefore).flatMap((c) => c.messages.map((m) => m.to)), ['ExponentPushToken[both-eeeeeeeeeeee]']);
    assert.deepEqual(seen.fcm.slice(fcmBefore).map((c) => c.message.token), ['fcm-native-token-ffffffffff']);
    const record = t.pushes.at(-1);
    assert.deepEqual(record.devices.map((d) => d.via).sort(), ['expo', 'fcm']);
    assert.deepEqual(res.results.map((r) => r.transport).sort(), ['expo', 'fcm']);
  });
});

test('push-fcm: an unreadable service account is a doctor error, and tests keep capturing', async () => {
  await withBlocks(['push-fcm'], { FCM_SERVICE_ACCOUNT: '{"project_id":"x"}' }, async (t) => {
    const findings = await t.app.doctor();
    const f = findings.find((x) => x.id === 'fcm-service-account');
    assert.equal(f?.level, 'error');
    assert.match(f.detail, /client_email, private_key/);
    assert.equal(t.app.push.transport, 'dev-capture');
  });
});
