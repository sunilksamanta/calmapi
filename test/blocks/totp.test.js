import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
let totp;

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'totp', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp();
  totp = await project.load('app/blocks/totp/totp.js');
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

test('RFC 6238 test vector', () => {
  // RFC 6238 appendix B, SHA-1, T = 59s -> 94287082 (8 digits); 6-digit form is 287082.
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.codeAt(secret, Math.floor(59 / 30)), '287082');
  assert.equal(totp.base32Decode(secret).toString(), '12345678901234567890');
});

test('full flow: setup, enable, challenge on login, verify, replay, recovery, disable', async () => {
  const u = await t.signup({ password: 'quiet-meadow-41' });
  const setup = await t.post('/auth/2fa/setup', {}, u);
  assert.equal(setup.status, 200);
  assert.match(setup.body.data.otpauthUrl, /^otpauth:\/\/totp\//);
  const secret = setup.body.data.secret;

  assert.equal((await t.post('/auth/2fa/enable', { code: '000000' }, u)).status, 422);
  const now = totp.codeAt(secret, totp.currentStep());
  const enabled = await t.post('/auth/2fa/enable', { code: now }, u);
  assert.equal(enabled.status, 200);
  const recovery = enabled.body.data.recoveryCodes;
  assert.equal(recovery.length, 10);

  const raw = await t.app.model('user').collection.findOne({ email: u.email });
  assert.match(raw.totpSecret, /^enc:v1:/, 'secret encrypted at rest');
  assert.ok(raw.totpRecovery.every((h) => h.length === 64), 'recovery codes hashed');
  const me = await t.get('/auth/me', u);
  assert.equal(me.body.data.totpSecret, undefined);
  assert.ok(me.body.data.twoFactorEnabledAt);

  const login = await t.post('/auth/login', { email: u.email, password: u.password });
  assert.equal(login.status, 200);
  assert.equal(login.body.data.mfaRequired, true);
  assert.equal(login.body.data.token, undefined, 'no session before the second factor');
  const { mfaToken } = login.body.data;

  assert.equal((await t.post('/auth/2fa/verify', { mfaToken, code: '123456' })).status, 401);
  const reused = await t.post('/auth/2fa/verify', { mfaToken, code: now });
  assert.equal(reused.status, 401, 'the code used to enable cannot be replayed');

  const next = totp.codeAt(secret, totp.currentStep() + 1);
  const ok = await t.post('/auth/2fa/verify', { mfaToken, code: next });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.match(ok.body.data.token, /^calm_/);
  assert.equal((await t.post('/auth/2fa/verify', { mfaToken, code: next })).status, 401, 'challenges are single use');

  const login2 = await t.post('/auth/login', { email: u.email, password: u.password });
  const viaRecovery = await t.post('/auth/2fa/verify', { mfaToken: login2.body.data.mfaToken, recoveryCode: recovery[0] });
  assert.equal(viaRecovery.status, 200);
  const login3 = await t.post('/auth/login', { email: u.email, password: u.password });
  assert.equal((await t.post('/auth/2fa/verify', { mfaToken: login3.body.data.mfaToken, recoveryCode: recovery[0] })).status, 401, 'recovery codes are single use');

  const token = ok.body.data.token;
  assert.equal((await t.post('/auth/2fa/disable', { password: 'nope-nope-nope' }, token)).status, 422);
  assert.equal((await t.post('/auth/2fa/disable', { password: u.password }, token)).status, 204);
  const plain = await t.post('/auth/login', { email: u.email, password: u.password });
  assert.match(plain.body.data.token, /^calm_/);
});

test('challenges allow 5 attempts', async () => {
  const u = await t.signup({ password: 'quiet-meadow-41' });
  const { secret } = (await t.post('/auth/2fa/setup', {}, u)).body.data;
  await t.post('/auth/2fa/enable', { code: totp.codeAt(secret, totp.currentStep()) }, u);
  const { mfaToken } = (await t.post('/auth/login', { email: u.email, password: u.password })).body.data;
  for (let i = 0; i < 5; i++) await t.post('/auth/2fa/verify', { mfaToken, code: '000000' });
  const good = await t.post('/auth/2fa/verify', { mfaToken, code: totp.codeAt(secret, totp.currentStep() + 1) });
  assert.equal(good.status, 401, 'locked after 5 attempts');
});
