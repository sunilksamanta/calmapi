import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// A fake Expo push service and a fake Google (OAuth token endpoint and FCM HTTP v1), so the
// blocks run their real fetch code without any network.
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const seen = { expo: [], token: [], fcm: [] };
let server;
let origin;

const read = (req) => new Promise((resolve) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => resolve(body));
});
const reply = (res, status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  server = createServer(async (req, res) => {
    const body = await read(req);
    if (req.url === '/expo') {
      const messages = JSON.parse(body);
      seen.expo.push({ auth: req.headers.authorization, messages });
      return reply(res, 200, {
        data: messages.map((m) => (m.to.includes('gone') ? { status: 'error', message: `${m.to} is not a registered push notification recipient`, details: { error: 'DeviceNotRegistered' } } : { status: 'ok', id: `ticket-${m.to.length}` })),
      });
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

async function withBlock(block, env, fn) {
  const p = await makeProject();
  Object.assign(process.env, env);
  try {
    calm(p.dir, 'add', block, '--yes', '--no-install');
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

test('push-expo: batches to Expo, removes DeviceNotRegistered tokens, keeps simulated devices local', async () => {
  await withBlock('push-expo', { EXPO_PUSH_URL: `${origin}/expo`, EXPO_ACCESS_TOKEN: 'expo-secret' }, async (t) => {
    assert.equal(t.app.push.transport, 'expo');
    const u = await t.signup();
    await t.post('/auth/devices', { token: 'ExponentPushToken[good-aaaaaaaaaaaa]', platform: 'ios' }, u);
    await t.post('/auth/devices', { token: 'ExponentPushToken[gone-bbbbbbbbbbbb]', platform: 'android' }, u);
    await t.post('/auth/devices', { token: 'fcm-style-token-cccccccccccc', platform: 'android' }, u);
    await t.app.push.send({ tokens: ['sim_ios_local'], platform: 'ios', title: 'Never leaves' });
    assert.equal(seen.expo.length, 0, 'simulated devices are never sent to Expo');

    const res = await t.app.push.send({ to: u.id, title: 'Order shipped', body: 'Arrives Thursday', data: { orderId: 42 }, url: '/orders/42' });
    assert.equal(res.status, 'partial');
    assert.equal(seen.expo.length, 1, 'one batched request');
    const [call] = seen.expo;
    assert.equal(call.auth, 'Bearer expo-secret');
    assert.equal(call.messages.length, 2, 'the non-Expo token is rejected locally');
    assert.deepEqual(call.messages[0].data, { orderId: 42, url: '/orders/42' });
    assert.equal(call.messages[0].title, 'Order shipped');

    const record = t.pushes.at(-1);
    assert.ok(record.log.some((l) => /^Delivered to expo \(ticket-/.test(l.text)));
    assert.ok(record.log.some((l) => /DeviceNotRegistered.*device removed/.test(l.text)));
    assert.ok(record.log.some((l) => /Not an Expo push token/.test(l.text)));
    const left = (await t.get('/auth/devices', u)).body.data.map((d) => d.platform);
    assert.equal(left.length, 2, 'the unregistered token was removed');
  });
});

test('push-fcm: signs a service account JWT, caches the token, removes UNREGISTERED tokens', async () => {
  const account = JSON.stringify({ type: 'service_account', project_id: 'demo-app', client_email: 'push@demo-app.iam.gserviceaccount.com', private_key: privateKey, token_uri: `${origin}/token` });
  await withBlock('push-fcm', { FCM_SERVICE_ACCOUNT: account, FCM_API_URL: origin }, async (t) => {
    assert.equal(t.app.push.transport, 'fcm');
    const u = await t.signup();
    await t.post('/auth/devices', { token: 'fcm-live-token-1111111111', platform: 'android' }, u);
    await t.post('/auth/devices', { token: 'fcm-dead-token-2222222222', platform: 'ios' }, u);

    const res = await t.app.push.send({ to: u.id, title: 'Hello', body: 'From FCM', data: { n: 1 }, image: 'https://cdn.example.com/a.png' });
    assert.equal(res.status, 'partial');
    assert.equal(seen.token.length, 1);
    assert.equal(seen.token[0].valid, true, 'the JWT is signed with the service account key');
    assert.equal(seen.token[0].grant, 'urn:ietf:params:oauth:grant-type:jwt-bearer');
    assert.equal(seen.token[0].claims.iss, 'push@demo-app.iam.gserviceaccount.com');
    assert.equal(seen.token[0].claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
    assert.equal(seen.fcm.length, 2, 'one request per device');
    assert.ok(seen.fcm.every((c) => c.auth === 'Bearer ya29.fake'));
    const live = seen.fcm.find((c) => c.message.token.includes('live')).message;
    assert.equal(live.notification.title, 'Hello');
    assert.equal(live.data.n, '1', 'FCM data values are strings');
    assert.equal(live.apns.headers['apns-push-type'], 'alert');

    const record = t.pushes.at(-1);
    assert.ok(record.log.some((l) => /^Delivered to fcm \(projects\/demo-app\/messages\//.test(l.text)));
    assert.ok(record.log.some((l) => /UNREGISTERED.*device removed/.test(l.text)));
    assert.equal((await t.get('/auth/devices', u)).body.data.length, 1);

    await t.app.push.send({ to: u.id, silent: true, data: { sync: 'cart' } });
    assert.equal(seen.token.length, 1, 'the access token is cached');
    assert.equal(seen.fcm.at(-1).message.apns.headers['apns-push-type'], 'background');
  });
});

test('push-fcm: an unreadable service account is a doctor error, and tests keep capturing', async () => {
  await withBlock('push-fcm', { FCM_SERVICE_ACCOUNT: '{"project_id":"x"}' }, async (t) => {
    const findings = await t.app.doctor();
    const f = findings.find((x) => x.id === 'fcm-service-account');
    assert.equal(f?.level, 'error');
    assert.match(f.detail, /client_email, private_key/);
    assert.equal(t.app.push.transport, 'dev-capture');
  });
});
