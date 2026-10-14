import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

// A fake OAuth 2.0 / OpenID Connect provider (and GitHub look-alike) on node:http: discovery,
// authorize, token (checks client credentials, redirect_uri and PKCE), userinfo, GitHub's
// /user and /user/emails, and a JWKS with a real RSA key.

const b64 = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');
const s256 = (v) => createHash('sha256').update(v).digest('base64url');
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');
const secret = () => randomBytes(12).toString('hex'); // fake client secrets, built at runtime

function fakeProvider() {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rogue = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'k1', use: 'sig', alg: 'RS256' };
  const clients = new Map(); // clientId -> secret
  const codes = new Map();
  const tokens = new Map();
  const fake = {
    origin: null,
    clients,
    authorizeRequests: [],
    tokenRequests: [],
    nextUser: null, // { sub, email, email_verified, name, emails? } for the next authorize
    tweak: null, // (claims) => claims, for the next ID token
    signWith: null, // another private key, for the next ID token
    signJwt(claims, privateKey = key.privateKey, header = { alg: 'RS256', kid: 'k1', typ: 'JWT' }) {
      const input = `${b64(header)}.${b64(claims)}`;
      return `${input}.${sign('sha256', Buffer.from(input), privateKey).toString('base64url')}`;
    },
    rogueKey: rogue.privateKey,
    reset() {
      Object.assign(fake, { nextUser: null, tweak: null, signWith: null });
    },
  };

  const json = (res, status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req) => new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => resolve(data));
  });
  const bearer = (req) => tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1]);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, fake.origin);
    if (url.pathname === '/.well-known/openid-configuration') {
      return json(res, 200, {
        issuer: fake.origin,
        authorization_endpoint: `${fake.origin}/authorize`,
        token_endpoint: `${fake.origin}/token`,
        userinfo_endpoint: `${fake.origin}/userinfo`,
        jwks_uri: `${fake.origin}/jwks`,
      });
    }
    if (url.pathname === '/jwks') return json(res, 200, { keys: [jwk] });
    if (url.pathname === '/authorize') {
      const q = Object.fromEntries(url.searchParams);
      fake.authorizeRequests.push(q);
      if (!clients.has(q.client_id) || q.response_type !== 'code') return json(res, 400, { error: 'invalid_request' });
      const code = randomBytes(16).toString('hex');
      codes.set(code, { ...q, user: fake.nextUser ?? { sub: 'default-sub', email: 'default@example.test', email_verified: true } });
      const back = new URL(q.redirect_uri);
      back.searchParams.set('code', code);
      back.searchParams.set('state', q.state);
      res.writeHead(302, { location: back.href });
      return res.end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
      fake.tokenRequests.push(form);
      const grant = codes.get(form.code);
      if (!grant || clients.get(form.client_id) !== form.client_secret || grant.client_id !== form.client_id) return json(res, 400, { error: 'invalid_client' });
      codes.delete(form.code); // codes work once
      if (form.redirect_uri !== grant.redirect_uri) return json(res, 400, { error: 'invalid_grant', error_description: 'redirect_uri' });
      // PKCE (RFC 7636 4.6): the verifier must hash to the challenge sent on authorize.
      if (grant.code_challenge && (grant.code_challenge_method !== 'S256' || s256(form.code_verifier ?? '') !== grant.code_challenge)) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
      }
      const access = randomBytes(16).toString('hex');
      tokens.set(access, grant.user);
      const out = { access_token: access, token_type: 'Bearer', expires_in: 3600 };
      if (grant.scope.split(' ').includes('openid')) {
        const now = Math.floor(Date.now() / 1000);
        let claims = { iss: fake.origin, aud: form.client_id, sub: grant.user.sub, iat: now, exp: now + 300, nonce: grant.nonce, email: grant.user.email, email_verified: grant.user.email_verified, name: grant.user.name };
        if (fake.tweak) claims = fake.tweak(claims);
        out.id_token = fake.signJwt(claims, fake.signWith ?? key.privateKey);
      }
      return json(res, 200, out);
    }
    if (url.pathname === '/userinfo') {
      const user = bearer(req);
      return user ? json(res, 200, user) : json(res, 401, { error: 'invalid_token' });
    }
    // GitHub look-alike: numeric ids, a public (unverified) email on /user, the real ones on /user/emails.
    if (url.pathname === '/user') {
      const user = bearer(req);
      if (!user || !req.headers['user-agent']) return json(res, 401, { message: 'Bad credentials' });
      return json(res, 200, { id: user.id, login: user.login, name: user.name, email: user.publicEmail ?? null, avatar_url: 'https://avatars.example.test/1' });
    }
    if (url.pathname === '/user/emails') {
      const user = bearer(req);
      return user ? json(res, 200, user.emails ?? []) : json(res, 401, { message: 'Bad credentials' });
    }
    json(res, 404, { error: 'not_found' });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.origin = `http://127.0.0.1:${server.address().port}`;
      fake.close = () => new Promise((r) => server.close(r));
      resolve(fake);
    });
  });
}

let fake;
let project;
let t; // defaults
let t2; // createAccount and linkVerifiedEmail off, a half-configured provider
let totp;
const events = [];

const google = { clientId: 'google-client', clientSecret: secret() };
const acme = { clientId: 'acme-client', clientSecret: secret() };
const github = { clientId: 'github-client', clientSecret: secret() };

function providerConfig() {
  for (const c of [google, acme, github]) fake.clients.set(c.clientId, c.clientSecret);
  const o = fake.origin;
  return {
    // The Google preset with its endpoints pointed at the fake server.
    google: { ...google, issuer: o, authorizationUrl: `${o}/authorize`, tokenUrl: `${o}/token`, jwksUrl: `${o}/jwks`, userinfoUrl: `${o}/userinfo` },
    // A generic OpenID Connect provider found by discovery.
    acme: { ...acme, type: 'oidc', name: 'Acme ID', issuer: o },
    github: { ...github, authorizationUrl: `${o}/authorize`, tokenUrl: `${o}/token`, userinfoUrl: `${o}/user`, emailsUrl: `${o}/user/emails` },
    // A provider whose token endpoint is down.
    down: { type: 'oauth2', ...acme, authorizationUrl: `${o}/authorize`, tokenUrl: 'http://127.0.0.1:9/token', userinfoUrl: `${o}/userinfo`, name: 'Down' },
  };
}

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  fake = await fakeProvider();
  project = await makeProject();
  // totp too: provider sign-in must still ask for the second factor.
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'oauth', 'totp', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({ blocks: { oauth: { providers: providerConfig(), timeoutMs: 2000 } } });
  t2 = await project.testApp({
    blocks: { oauth: { providers: { ...providerConfig(), okta: { type: 'oidc', issuer: fake.origin, clientId: 'okta-client' } }, createAccount: false, linkVerifiedEmail: false } },
  });
  totp = await project.load('app/blocks/totp/totp.js');
  for (const app of [t.app, t2.app]) app.events.on('*', (payload, name) => events.push({ name, payload }));
});
after(async () => {
  await t?.close();
  await t2?.close();
  await fake?.close();
  project?.cleanup();
});
afterEach(() => fake.reset());

const flows = (tt) => tt.app.mongoose.connection.collection('calm_oauth_flows');
const identities = (tt) => tt.app.mongoose.connection.collection('calm_oauth_identities');
const lastEvent = async (tt, name) => {
  await tt.idle();
  return events.filter((e) => e.name === name).at(-1)?.payload;
};
let n = 0;
const person = (extra = {}) => {
  n += 1;
  return { sub: `sub-${n}-${randomBytes(3).toString('hex')}`, email: `person${n}_${randomBytes(2).toString('hex')}@example.test`, email_verified: true, name: `Person ${n}`, ...extra };
};

/** Start a flow, let the fake provider "approve" it, and return what the callback page would get. */
async function begin(tt, provider, { user, redirect, auth, path = 'start' } = {}) {
  fake.nextUser = user ?? person();
  const start = await tt.post(`/auth/oauth/${provider}/${path}`, redirect ? { redirect } : {}, auth);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const res = await fetch(start.body.data.url, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const back = new URL(res.headers.get('location'));
  const code = back.searchParams.get('code');
  const state = back.searchParams.get('state');
  return {
    start: start.body.data,
    back,
    code,
    state,
    finish: (body = {}, who = auth) => tt.post('/auth/oauth/callback', { code, state, requestId: start.body.data.requestId, ...body }, who),
  };
}

test('lists the providers that are turned on, without secrets', async () => {
  const res = await t.get('/auth/oauth/providers');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((p) => p.id).sort(), ['acme', 'down', 'github', 'google']);
  assert.deepEqual(res.body.data.find((p) => p.id === 'acme'), { id: 'acme', name: 'Acme ID', type: 'oidc' });
  assert.ok(!JSON.stringify(res.body).includes('secret'));
  assert.equal((await t.post('/auth/oauth/nope/start', {})).status, 404);
});

test('OpenID Connect happy path: PKCE, state and nonce, a new account, a session', async () => {
  const user = person({ name: 'Ada Lovelace' });
  const flow = await begin(t, 'acme', { user });
  const auth = fake.authorizeRequests.at(-1);
  assert.equal(auth.code_challenge_method, 'S256');
  assert.match(auth.code_challenge, /^[\w-]{43}$/);
  assert.match(auth.nonce, /^[\w-]{32}$/);
  assert.equal(auth.scope, 'openid email profile');
  assert.equal(auth.redirect_uri, `${t.app.config.app.url}/auth/oauth/callback`);
  assert.equal(flow.back.origin + flow.back.pathname, auth.redirect_uri);

  const raw = await flows(t).findOne({ stateHash: sha(flow.state) });
  assert.ok(raw, 'the state is stored as a hash');
  assert.ok(!JSON.stringify(raw).includes(flow.state) && !JSON.stringify(raw).includes(auth.nonce));
  assert.equal(raw.requestHash, sha(flow.start.requestId));
  assert.equal(flow.start.expiresIn, 600);

  const res = await flow.finish();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match(res.body.data.token, /^calm_/);
  assert.equal(res.body.data.created, true);
  assert.equal(res.body.data.provider, 'acme');
  assert.equal(res.body.data.user.email, user.email);
  assert.equal(res.body.data.user.name, 'Ada Lovelace');
  assert.equal(res.body.data.user.oauthNoPassword, undefined, 'the flag stays hidden');

  // The fake provider checked the verifier against the challenge; it was sent.
  const tokenReq = fake.tokenRequests.at(-1);
  assert.equal(s256(tokenReq.code_verifier), auth.code_challenge);
  assert.equal(tokenReq.client_id, 'acme-client');

  const me = await t.get('/auth/me', res.body.data.token);
  assert.equal(me.body.data.email, user.email);
  const identity = await identities(t).findOne({ provider: 'acme', subject: user.sub });
  assert.equal(String(identity.user), res.body.data.user.id);
  assert.equal((await lastEvent(t, 'auth.registered')).via, 'oauth');

  // Second sign-in: the identity is found, no new account.
  const again = await (await begin(t, 'acme', { user })).finish();
  assert.equal(again.status, 200);
  assert.equal(again.body.data.user.id, res.body.data.user.id);
  assert.equal(again.body.data.created, undefined);
});

test('PKCE: a wrong verifier is refused by the provider and the sign-in fails', async () => {
  const flow = await begin(t, 'google');
  await flows(t).updateOne({ stateHash: sha(flow.state) }, { $set: { verifier: 'x'.repeat(43) } });
  const res = await flow.finish();
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OAUTH_FAILED');
  assert.equal((await lastEvent(t, 'security.oauth_failed')).reason, 'token_invalid_grant');
});

test('state: unknown, reused and expired flows are refused', async () => {
  const unknown = await t.post('/auth/oauth/callback', { code: 'abc', state: 'made-up-state', requestId: 'x' });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, 'INVALID_STATE');
  assert.equal((await lastEvent(t, 'security.invalid_oauth_state')).reason, 'unknown');

  const flow = await begin(t, 'google');
  assert.equal((await flow.finish()).status, 200);
  const reused = await flow.finish();
  assert.equal(reused.status, 400);
  assert.equal(reused.body.error.code, 'INVALID_STATE');
  assert.equal((await lastEvent(t, 'security.invalid_oauth_state')).reason, 'used');

  const old = await begin(t, 'google');
  await flows(t).updateOne({ stateHash: sha(old.state) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const expired = await old.finish();
  assert.equal(expired.status, 400);
  assert.equal(expired.body.error.code, 'INVALID_STATE');
  assert.equal((await lastEvent(t, 'security.invalid_oauth_state')).reason, 'expired');
});

test('the flow is bound to the browser that started it (login CSRF)', async () => {
  const flow = await begin(t, 'google');
  const wrong = await flow.finish({ requestId: 'someone-elses-id' });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'OTHER_DEVICE');
  const missing = await t.post('/auth/oauth/callback', { code: flow.code, state: flow.state });
  assert.equal(missing.body.error.code, 'OTHER_DEVICE', 'no requestId at all is refused too');
  assert.equal((await flow.finish()).status, 200, 'a refused browser does not burn the flow');
});

test('a mismatched state (code from another flow) does not sign in', async () => {
  const a = await begin(t, 'google');
  const b = await begin(t, 'google');
  // The state of flow b with the requestId of flow a: refused before the code is used.
  const res = await t.post('/auth/oauth/callback', { code: a.code, state: b.state, requestId: a.start.requestId });
  assert.equal(res.body.error.code, 'OTHER_DEVICE');
});

test('ID token: wrong nonce, bad signature, wrong audience, wrong issuer, expired and alg none are refused', async () => {
  const cases = [
    ['wrong_nonce', () => (fake.tweak = (c) => ({ ...c, nonce: 'another-flow' }))],
    ['bad_signature', () => (fake.signWith = fake.rogueKey)],
    ['wrong_audience', () => (fake.tweak = (c) => ({ ...c, aud: 'someone-else' }))],
    ['wrong_audience', () => (fake.tweak = (c) => ({ ...c, aud: [c.aud, 'other'], azp: 'other' }))],
    ['wrong_issuer', () => (fake.tweak = (c) => ({ ...c, iss: 'https://evil.example' }))],
    ['expired', () => (fake.tweak = (c) => ({ ...c, exp: Math.floor(Date.now() / 1000) - 3600 }))],
  ];
  for (const [reason, arrange] of cases) {
    const flow = await begin(t, 'google');
    arrange();
    const res = await flow.finish();
    assert.equal(res.status, 400, reason);
    assert.equal(res.body.error.code, 'OAUTH_FAILED', reason);
    assert.equal((await lastEvent(t, 'security.oauth_failed')).reason, `id_token_${reason}`);
    fake.reset();
  }

  // An unsigned token (alg none) is refused before any key is looked up.
  const { decodeJwt, candidateKeys } = await project.load('app/blocks/oauth/jwt.js');
  const none = `${b64({ alg: 'none' })}.${b64({ sub: 'x' })}.`;
  assert.throws(() => candidateKeys(decodeJwt(none).header, []), (err) => err.reason === 'bad_alg');
  assert.throws(() => candidateKeys({ alg: 'HS256' }, []), (err) => err.reason === 'bad_alg');
});

test('an existing account with an unverified email is not linked', async () => {
  const owner = await t.signup();
  const flow = await begin(t, 'acme', { user: person({ email: owner.email, email_verified: false }) });
  const res = await flow.finish();
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ACCOUNT_EXISTS');
  assert.equal(await identities(t).countDocuments({ user: t.app.mongoose.Types.ObjectId.createFromHexString(owner.id) }), 0);
  assert.equal((await lastEvent(t, 'security.oauth_link_refused')).reason, 'email_not_verified');
});

test('an existing account with a verified email is linked and signed in', async () => {
  const owner = await t.signup();
  const res = await (await begin(t, 'google', { user: person({ email: owner.email.toUpperCase() }) })).finish();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.user.id, owner.id);
  assert.equal(res.body.data.created, undefined);
  const list = await t.get('/auth/oauth/identities', owner);
  assert.deepEqual(list.body.data.map((i) => i.provider), ['google']);
  assert.equal((await lastEvent(t, 'security.oauth_linked')).via, 'verified_email');
});

test('linkVerifiedEmail off: even a verified email is not linked', async () => {
  const owner = await t2.signup();
  const res = await (await begin(t2, 'google', { user: person({ email: owner.email }) })).finish();
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'ACCOUNT_EXISTS');
});

test('new accounts: only with a verified email, only while createAccount and registration are on', async () => {
  const unverified = await (await begin(t, 'acme', { user: person({ email_verified: false }) })).finish();
  assert.equal(unverified.status, 400);
  assert.equal(unverified.body.error.code, 'EMAIL_NOT_VERIFIED');

  const off = await (await begin(t2, 'acme')).finish();
  assert.equal(off.status, 403, 'createAccount: false');

  t.app.config.auth.register = false;
  try {
    const user = person();
    const closed = await (await begin(t, 'acme', { user })).finish();
    assert.equal(closed.status, 403, 'registration closed');
    assert.equal(await t.app.model('user').countDocuments({ email: user.email }), 0);
  } finally {
    t.app.config.auth.register = true;
  }
});

test('disabled and locked accounts cannot sign in', async () => {
  const d = await t.signup();
  await t.app.model('user').updateOne({ _id: d.id }, { $set: { status: 'disabled' } });
  const disabled = await (await begin(t, 'google', { user: person({ email: d.email }) })).finish();
  assert.equal(disabled.status, 403);
  assert.equal(await identities(t).countDocuments({ user: t.app.mongoose.Types.ObjectId.createFromHexString(d.id) }), 0, 'nothing is linked to a disabled account');

  const l = await t.signup();
  for (let i = 0; i < 5; i++) await t.post('/auth/login', { email: l.email, password: 'wrong-password-123' });
  const locked = await (await begin(t, 'google', { user: person({ email: l.email }) })).finish();
  assert.equal(locked.status, 429);
  assert.equal((await lastEvent(t, 'security.locked_login_attempt')).via, 'oauth');
});

test('login challenges still apply: with 2FA on, the callback answers with a challenge', async () => {
  const u = await t.signup({ password: 'quiet-meadow-41' });
  const { secret: totpSecret } = (await t.post('/auth/2fa/setup', {}, u)).body.data;
  assert.equal((await t.post('/auth/2fa/enable', { code: totp.codeAt(totpSecret, totp.currentStep()) }, u)).status, 200);

  const res = await (await begin(t, 'google', { user: person({ email: u.email }), redirect: '/after' })).finish();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.mfaRequired, true);
  assert.equal(res.body.data.token, undefined, 'no session before the second factor');
  assert.equal(res.body.data.redirect, `${new URL(t.app.config.app.url).origin}/after`);

  const done = await t.post('/auth/2fa/verify', { mfaToken: res.body.data.mfaToken, code: totp.codeAt(totpSecret, totp.currentStep() + 1) });
  assert.equal(done.status, 200);
  assert.match(done.body.data.token, /^calm_/);
});

test('redirect: paths and the app origin are kept, anything else is refused', async () => {
  const origin = new URL(t.app.config.app.url).origin;
  for (const redirect of ['https://evil.example/phish', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', `${origin}@evil.example/`]) {
    const res = await t.post('/auth/oauth/google/start', { redirect });
    assert.equal(res.status, 422, redirect);
    assert.ok(res.body.error.details.redirect);
  }
  const res = await (await begin(t, 'google', { redirect: '/welcome?tab=1' })).finish();
  assert.equal(res.status, 200);
  assert.equal(res.body.data.redirect, `${origin}/welcome?tab=1`);
});

test('the provider refusing (error=access_denied) uses up the flow', async () => {
  const flow = await begin(t, 'google');
  const res = await t.post('/auth/oauth/callback', { state: flow.state, requestId: flow.start.requestId, error: 'access_denied' });
  assert.equal(res.status, 400);
  assert.equal(res.body.error.code, 'OAUTH_DENIED');
  assert.equal((await flow.finish()).body.error.code, 'INVALID_STATE');
});

test('GitHub: only the primary verified email from /user/emails counts', async () => {
  const email = `octo_${randomBytes(3).toString('hex')}@example.test`;
  const gh = {
    id: 1000 + n++,
    login: 'octocat',
    name: 'The Octocat',
    publicEmail: 'typed-anything@example.test',
    emails: [
      { email: 'secondary@example.test', primary: false, verified: true },
      { email, primary: true, verified: true },
    ],
  };
  const flow = await begin(t, 'github', { user: gh });
  assert.equal(fake.authorizeRequests.at(-1).scope, 'read:user user:email');
  assert.equal(fake.authorizeRequests.at(-1).nonce, undefined, 'no nonce outside OpenID Connect');
  const res = await flow.finish();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.user.email, email);
  assert.equal(res.body.data.user.name, 'The Octocat');
  assert.ok(await identities(t).findOne({ provider: 'github', subject: String(gh.id) }));

  // Primary address not verified: no email at all (the public one on /user is never used).
  const unverified = { id: 5000 + n++, login: 'mallory', publicEmail: email, emails: [{ email: 'mallory@example.test', primary: true, verified: false }] };
  const refused = await (await begin(t, 'github', { user: unverified })).finish();
  assert.equal(refused.status, 400);
  assert.equal(refused.body.error.code, 'EMAIL_NOT_VERIFIED');
});

test('link and unlink providers from a signed-in account', async () => {
  const u = await t.signup();
  const gh = { id: 9000 + n++, login: 'linker', emails: [{ email: 'whatever@example.test', primary: true, verified: false }] };

  // The link callback needs the same signed-in user.
  const anon = await begin(t, 'github', { user: gh, auth: u, path: 'link' });
  const noAuth = await anon.finish({}, null);
  assert.equal(noAuth.status, 403);
  const other = await t.signup();
  assert.equal((await anon.finish({}, other)).status, 403, 'another user cannot finish it');

  const res = await anon.finish();
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.data.linked, true);
  assert.equal(res.body.data.identity.provider, 'github');
  assert.equal((await lastEvent(t, 'security.oauth_linked')).via, 'link');

  // Signing in with that GitHub account now opens u, whatever its email.
  const login = await (await begin(t, 'github', { user: gh })).finish();
  assert.equal(login.body.data.user.id, u.id);

  // The same GitHub account cannot be linked to another user.
  const taken = await (await begin(t, 'github', { user: gh, auth: other, path: 'link' })).finish();
  assert.equal(taken.status, 409);
  assert.equal(taken.body.error.code, 'IDENTITY_IN_USE');

  const list = await t.get('/auth/oauth/identities', u);
  assert.equal(list.body.data.length, 1);
  assert.equal((await t.delete(`/auth/oauth/identities/${list.body.data[0].id}`, other)).status, 404, 'only your own');
  assert.equal((await t.delete(`/auth/oauth/identities/${list.body.data[0].id}`, u)).status, 204, 'u has a password');
  assert.equal((await t.get('/auth/oauth/identities', u)).body.data.length, 0);
  assert.equal((await lastEvent(t, 'security.oauth_unlinked')).provider, 'github');
  assert.equal((await t.post('/auth/oauth/github/link', {})).status, 401);
});

test('the last way into an account without a password cannot be removed', async () => {
  const user = person();
  const created = await (await begin(t, 'acme', { user })).finish();
  assert.equal(created.body.data.created, true);
  const token = created.body.data.token;
  const [identity] = (await t.get('/auth/oauth/identities', token)).body.data;

  const refused = await t.delete(`/auth/oauth/identities/${identity.id}`, token);
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'LAST_SIGN_IN_METHOD');

  // Setting a password through the reset flow makes it removable.
  await t.post('/auth/password/forgot', { email: user.email });
  await t.idle();
  const mail = t.mails.filter((m) => m.to === user.email).at(-1);
  assert.equal((await t.post('/auth/password/reset', { token: mail.meta.token, password: 'brand-new-pass-77' })).status, 204);
  await t.idle();
  const login = await t.post('/auth/login', { email: user.email, password: 'brand-new-pass-77' });
  assert.equal(login.status, 200);
  assert.equal((await t.delete(`/auth/oauth/identities/${identity.id}`, login.body.data.token)).status, 204);
});

test('GET start redirects to the provider and binds the flow with an HttpOnly cookie', async () => {
  fake.nextUser = person();
  const res = await fetch(`${t.origin}/api/auth/oauth/google/start?redirect=/home`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = new URL(res.headers.get('location'));
  assert.equal(location.origin, fake.origin);
  const setCookie = res.headers.get('set-cookie');
  assert.match(setCookie, /^calm_oauth_rid=[\w-]+; Path=\/api\/auth\/oauth; Max-Age=600; HttpOnly; SameSite=Lax/);
  const cookie = setCookie.split(';')[0];

  const approved = await fetch(location.href, { redirect: 'manual' });
  const back = new URL(approved.headers.get('location'));
  const body = JSON.stringify({ code: back.searchParams.get('code'), state: back.searchParams.get('state') });
  const post = (headers) => fetch(`${t.origin}/api/auth/oauth/callback`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });
  assert.equal((await post({})).status, 400, 'without the cookie');
  const ok = await post({ cookie });
  assert.equal(ok.status, 200);
  assert.match(ok.headers.get('set-cookie'), /calm_oauth_rid=; .*Max-Age=0/);
  assert.equal((await ok.json()).data.redirect, `${new URL(t.app.config.app.url).origin}/home`);
});

test('a provider that does not answer gives 502', async () => {
  const res = await (await begin(t, 'down')).finish();
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'OAUTH_PROVIDER_ERROR');
});

test('doctor: half-configured providers are errors', async () => {
  const findings = await t2.app.doctor();
  assert.ok(findings.some((f) => f.id === 'oauth-okta-credentials' && f.level === 'error'));
  assert.ok(!(await t.app.doctor()).some((f) => f.id.startsWith('oauth-')), JSON.stringify((await t.app.doctor()).filter((f) => f.id.startsWith('oauth-'))));
  assert.ok(!(await t2.get('/auth/oauth/providers')).body.data.some((p) => p.id === 'okta'), 'not listed');
});
