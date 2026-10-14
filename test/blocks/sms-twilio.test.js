import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// Credentials are built at runtime: no secret-shaped literals in the repository.
const accountSid = `AC${randomBytes(16).toString('hex')}`;
const authToken = randomBytes(16).toString('hex');
const serviceSid = `MG${randomBytes(16).toString('hex')}`;
const callbackUrl = 'https://api.acme.test/api/sms/twilio/status';

// A fake Twilio Messages API. +15005550001 is refused like Twilio refuses invalid numbers.
const seen = [];
let server;
let origin;
let project;
let t;
const events = [];

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      seen.push({ url: req.url, headers: req.headers, form });
      const json = (status, body) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
      if (req.url !== `/2010-04-01/Accounts/${accountSid}/Messages.json`) return json(404, { code: 20404, message: 'The requested resource was not found', status: 404 });
      if (req.headers.authorization !== `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`) return json(401, { code: 20003, message: 'Authenticate', status: 401 });
      if (form.To === '+15005550001') return json(400, { code: 21211, message: `The 'To' number ${form.To} is not a valid phone number.`, more_info: 'https://www.twilio.com/docs/errors/21211', status: 400 });
      json(201, { sid: `SM${randomBytes(16).toString('hex')}`, status: 'accepted', to: form.To, body: form.Body, messaging_service_sid: form.MessagingServiceSid ?? null });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  calm(project.dir, 'add', 'sms-twilio', '--yes', '--no-install');
  Object.assign(process.env, { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_MESSAGING_SERVICE_SID: serviceSid });
  t = await project.testApp({ blocks: { 'sms-twilio': { apiBase: origin, statusCallbackUrl: callbackUrl, verification: { limits: { perPhone: { max: 3, windowMinutes: 60 } } } } } });
  t.app.events.on('*', (payload, name) => events.push({ name, payload }));
});

after(async () => {
  await t?.close();
  project?.cleanup();
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
  await new Promise((resolve) => server.close(resolve));
});

const lastCode = (phone) => /^(\d{6}) /.exec(seen.filter((s) => s.form.To === phone).at(-1).form.Body)[1];
const models = () => t.app.ext.sms.models;
const userId = (u) => u.id;
const backdate = (u, field, ms) => models().Verification.updateOne({ _id: userId(u) }, { $set: { [field]: new Date(Date.now() - ms) } });

// Twilio's algorithm, written again here so the test does not trust the block's version.
function sign(url, params, token = authToken) {
  const data = Object.keys(params).sort().reduce((acc, k) => acc + k + params[k], url);
  return createHmac('sha1', token).update(data).digest('base64');
}
const callback = (params, signature) =>
  fetch(`${t.origin}/api/sms/twilio/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', ...(signature ? { 'x-twilio-signature': signature } : {}) }, body: new URLSearchParams(params) });

test('sms-twilio: send() posts the documented request with basic auth', async () => {
  assert.equal(t.app.ext.sms.transport, 'twilio');
  const out = await t.app.ext.sms.send({ to: '+1 (415) 555-0100', body: 'Your order shipped' });
  const call = seen.at(-1);
  assert.equal(call.url, `/2010-04-01/Accounts/${accountSid}/Messages.json`);
  assert.equal(call.headers.authorization, `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`);
  assert.equal(call.headers['content-type'], 'application/x-www-form-urlencoded');
  assert.deepEqual(call.form, { To: '+14155550100', Body: 'Your order shipped', MessagingServiceSid: serviceSid, StatusCallback: callbackUrl });
  assert.match(out.sid, /^SM[0-9a-f]{32}$/);
  assert.equal(out.to, '+14155550100');
  const logged = await models().Message.findOne({ sid: out.sid }).lean();
  assert.equal(logged.to, '+14*****0100', 'the delivery log keeps a masked number');
  assert.equal(logged.status, 'accepted');

  const before = seen.length;
  await assert.rejects(() => t.app.ext.sms.send({ to: '415-555-0100', body: 'x' }), (err) => err.name === 'SmsError' && err.code === 'INVALID_NUMBER');
  await assert.rejects(() => t.app.ext.sms.send({ to: '+15005550001', body: 'x' }), (err) => err.code === 21211 && err.status === 400 && /not a valid phone number/.test(err.message));
  assert.equal(seen.length - before, 1, 'invalid numbers never reach Twilio; Twilio errors are not retried');

  const { normalizePhone, maskPhone } = await project.load('app/blocks/sms-twilio/index.js');
  assert.equal(normalizePhone('0044 20 7946 0000'), '+442079460000');
  assert.equal(normalizePhone('+0123456789'), null);
  assert.equal(normalizePhone('+1234'), null);
  assert.equal(maskPhone('+442079460000'), '+44******0000');
});

test('sms-twilio: phone verification with a 6-digit code stored hashed', async () => {
  const alice = await t.signup();
  const phone = '+14155550111';
  const start = await t.post('/auth/phone/start', { phone: '+1 415 555 0111' }, alice);
  assert.equal(start.status, 202);
  assert.deepEqual(start.body.data, { message: 'Code sent', phone: '+14*****0111', expiresIn: 600, resendIn: 60 });
  const code = lastCode(phone);
  assert.match(seen.at(-1).form.Body, new RegExp(`^${code} is your .* verification code\\. It expires in 10 minutes\\.`));
  const stored = await models().Verification.findById(alice.id).lean();
  assert.ok(stored.codeHash && !JSON.stringify(stored).includes(code), 'only a salted hash is stored');
  assert.equal((await t.post('/auth/phone/start', { phone: 'not a phone' }, alice)).status, 422);
  assert.equal((await t.post('/auth/phone/start', { phone }, null)).status, 401);

  const ok = await t.post('/auth/phone/verify', { phone, code }, alice);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.data.phone, phone);
  const me = (await t.get('/auth/me', alice)).body.data;
  assert.equal(me.phone, phone);
  assert.ok(me.phoneVerifiedAt);
  assert.equal((await t.patch('/auth/me', { phone: '+14155550999' }, alice)).status, 422, 'the phone can only be set by verifying it');
  assert.equal((await t.post('/auth/phone/verify', { phone, code }, alice)).status, 400, 'codes work once');
  await t.idle();
  assert.ok(events.some((e) => e.name === 'auth.phone_verified' && e.payload.phone === '+14*****0111'));

  const again = await t.post('/auth/phone/start', { phone }, alice);
  assert.deepEqual([again.status, again.body.data.verified], [200, true], 'nothing is sent for a number already verified');

  // Another account proves it holds the same number: refused, the number stays with Alice.
  const bob = await t.signup();
  assert.equal((await t.post('/auth/phone/start', { phone }, bob)).status, 202);
  const taken = await t.post('/auth/phone/verify', { phone, code: lastCode(phone) }, bob);
  assert.equal(taken.status, 409);
  assert.equal((await t.get('/auth/me', bob)).body.data.phone, undefined);

  assert.equal((await t.delete('/auth/phone', alice)).status, 204);
  assert.equal((await t.get('/auth/me', alice)).body.data.phone, undefined);
});

test('sms-twilio: wrong codes lock the verification after maxAttempts', async () => {
  const carol = await t.signup();
  const phone = '+14155550222';
  await t.post('/auth/phone/start', { phone }, carol);
  const code = lastCode(phone);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let left = 4; left >= 1; left--) {
    const res = await t.post('/auth/phone/verify', { phone, code: wrong }, carol);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message, `Wrong code, ${left} attempt${left === 1 ? '' : 's'} left`);
  }
  const locked = await t.post('/auth/phone/verify', { phone, code: wrong }, carol);
  assert.deepEqual([locked.status, locked.body.error.code], [429, 'TOO_MANY_ATTEMPTS']);
  const late = await t.post('/auth/phone/verify', { phone, code }, carol);
  assert.deepEqual([late.status, late.body.error.code], [400, 'INVALID_CODE'], 'the right code no longer works');
  await t.idle();
  assert.equal(events.filter((e) => e.name === 'security.phone_code_failed' && e.payload.userId === carol.id).length, 5);
  assert.ok(events.some((e) => e.name === 'security.phone_verification_locked' && e.payload.userId === carol.id));
});

test('sms-twilio: codes expire, and a code for another number does not count', async () => {
  const dan = await t.signup();
  const phone = '+14155550333';
  await t.post('/auth/phone/start', { phone }, dan);
  const code = lastCode(phone);
  assert.equal((await t.post('/auth/phone/verify', { phone: '+14155550334', code }, dan)).status, 400);
  await backdate(dan, 'expiresAt', 1000);
  const res = await t.post('/auth/phone/verify', { phone, code }, dan);
  assert.deepEqual([res.status, res.body.error.code], [400, 'INVALID_CODE']);
});

test('sms-twilio: resend cooldown and per number limits', async () => {
  const erin = await t.signup();
  const phone = '+14155550444';
  assert.equal((await t.post('/auth/phone/start', { phone }, erin)).status, 202);
  const before = seen.length;
  const cooling = await t.post('/auth/phone/start', { phone }, erin);
  assert.equal(cooling.status, 429);
  assert.ok(Number(cooling.headers.get('retry-after')) > 55);
  assert.match(cooling.body.error.message, /^Wait \d+ seconds/);
  assert.equal(seen.length, before, 'nothing sent during the cooldown');

  await backdate(erin, 'sentAt', 61_000);
  assert.equal((await t.post('/auth/phone/start', { phone }, erin)).status, 202);
  await backdate(erin, 'sentAt', 61_000);
  assert.equal((await t.post('/auth/phone/start', { phone }, erin)).status, 202, 'third code: the per number limit is 3 here');
  await backdate(erin, 'sentAt', 61_000);
  const limited = await t.post('/auth/phone/start', { phone }, erin);
  assert.equal(limited.status, 429);
  assert.match(limited.body.error.message, /this number/);
  // The limit is per number, whoever asks: another account cannot keep texting it.
  const frank = await t.signup();
  assert.equal((await t.post('/auth/phone/start', { phone }, frank)).status, 429);
  assert.equal((await t.post('/auth/phone/start', { phone: '+14155550555' }, frank)).status, 202);
  await t.idle();
  assert.ok(events.some((e) => e.name === 'security.sms_limit_reached' && e.payload.limit === 'phone'));

  const bad = await t.post('/auth/phone/start', { phone: '+15005550001' }, frank);
  assert.equal(bad.status, 429, 'cooldown first');
  await backdate(frank, 'sentAt', 61_000);
  const refused = await t.post('/auth/phone/start', { phone: '+15005550001' }, frank);
  assert.deepEqual([refused.status, refused.body.error.details], [422, { phone: 'This number cannot receive text messages' }]);
});

test('sms-twilio: delivery reports need a valid X-Twilio-Signature', async () => {
  const { sid } = await t.app.ext.sms.send({ to: '+14155550666', body: 'Report me' });
  const params = { AccountSid: accountSid, MessageSid: sid, MessageStatus: 'delivered', To: '+14155550666', ApiVersion: '2010-04-01' };

  const ok = await callback(params, sign(callbackUrl, params));
  assert.equal(ok.status, 204);
  assert.equal((await models().Message.findOne({ sid }).lean()).status, 'delivered');
  await t.idle();
  assert.ok(events.some((e) => e.name === 'sms.status' && e.payload.sid === sid && e.payload.status === 'delivered' && e.payload.to === '+14*****0666'));

  const late = { ...params, MessageStatus: 'sent' };
  assert.equal((await callback(late, sign(callbackUrl, late))).status, 204);
  assert.equal((await models().Message.findOne({ sid }).lean()).status, 'delivered', 'a late report does not go backwards');

  const forged = { ...params, MessageStatus: 'failed' };
  assert.equal((await callback(forged, sign(callbackUrl, params))).status, 403, 'parameters changed after signing');
  assert.equal((await callback(params, sign(`${t.origin}/api/sms/twilio/status`, params))).status, 403, 'signed for another URL');
  assert.equal((await callback(params, sign(callbackUrl, params, 'wrong-token'))).status, 403, 'signed with another token');
  assert.equal((await callback(params)).status, 403, 'unsigned');
  assert.equal((await models().Message.findOne({ sid }).lean()).status, 'delivered');
  await t.idle();
  assert.equal(events.filter((e) => e.name === 'security.twilio_signature_invalid').length, 4);

  const json = await fetch(`${t.origin}/api/sms/twilio/status`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) });
  assert.equal(json.status, 400);

  const { twilioSignature } = await project.load('app/blocks/sms-twilio/index.js');
  assert.equal(twilioSignature(authToken, callbackUrl, params), sign(callbackUrl, params));
  // The example from Twilio's documentation and helper libraries.
  const example = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
  assert.equal(twilioSignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', example), '0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
});

test('sms-twilio: without credentials, the dev transport keeps everything local', async () => {
  for (const k of ['TWILIO_ACCOUNT_SID', 'TWILIO_AUTH_TOKEN', 'TWILIO_MESSAGING_SERVICE_SID']) delete process.env[k];
  const dev = await project.testApp();
  try {
    assert.equal(dev.app.ext.sms.transport, 'dev-console');
    const got = [];
    dev.app.ext.sms.observe((m) => got.push(m));
    const before = seen.length;
    const u = await dev.signup();
    assert.equal((await dev.post('/auth/phone/start', { phone: '+447700900123' }, u)).status, 202);
    assert.equal(seen.length, before, 'nothing reached Twilio');
    const code = /^(\d{6})/.exec(got[0].body)[1];
    assert.equal(got[0].meta.kind, 'phone-verification');
    assert.equal((await dev.post('/auth/phone/verify', { phone: '+447700900123', code }, u)).status, 200);
    // Without the auth token no signature can be valid.
    const res = await fetch(`${dev.origin}/api/sms/twilio/status`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'x' }, body: 'MessageSid=SM1&MessageStatus=delivered' });
    assert.equal(res.status, 403);
  } finally {
    await dev.close();
    Object.assign(process.env, { TWILIO_ACCOUNT_SID: accountSid, TWILIO_AUTH_TOKEN: authToken, TWILIO_MESSAGING_SERVICE_SID: serviceSid });
  }
});
