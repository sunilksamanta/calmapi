import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// A fake Sentry ingest: stores every envelope it receives, split into its three lines.
const envelopes = [];
let server;
let origin;
let project;
let t;
let alice;

const files = {
  'app/routes.js': `
import { badRequest } from '#calm';
export default (r) => {
  r.post('/boom/:kind', { policy: 'public' }, (ctx) => {
    ctx.log.info('loading cart ?token=abc123&page=2');
    ctx.log.warn('cart service slow');
    throw new Error('kaboom ' + ctx.params.kind + ' Bearer abc.def.ghi');
  });
  r.get('/bad', { policy: 'public' }, () => { throw badRequest('nope'); });
  r.get('/denied', { policy: 'admin' }, () => 'never');
};`,
};

const waitFor = async (fn, what, ms = 3000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

const request = (path, { method = 'POST', body, headers = {} } = {}) =>
  fetch(`${t.origin}/api${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, body: body ? JSON.stringify(body) : undefined });

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const lines = Buffer.concat(chunks).toString().split('\n');
      envelopes.push({ url: req.url, headers: req.headers, header: JSON.parse(lines[0]), item: JSON.parse(lines[1]), event: JSON.parse(lines[2]), raw: lines });
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ id: JSON.parse(lines[0]).event_id }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `127.0.0.1:${server.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  calm(project.dir, 'add', 'sentry', '--yes', '--no-install');
  process.env.SENTRY_DSN = `http://publickey123@${origin}/42`;
  process.env.SENTRY_RELEASE = 'fixture@1.2.3';
  t = await project.testApp({ blocks: { sentry: { sendBody: true, sensitiveKeys: ['internalNote'] } } });
  alice = await t.signup({ name: 'Alice' });
});

after(async () => {
  await t?.close();
  project?.cleanup();
  delete process.env.SENTRY_DSN;
  delete process.env.SENTRY_RELEASE;
  await new Promise((resolve) => server.close(resolve));
});

test('sentry: parses the DSN and sends a well formed envelope for a 5xx', async () => {
  const { parseDsn } = await project.load('app/blocks/sentry/index.js');
  assert.deepEqual(parseDsn('https://abc@o1.ingest.sentry.io/123'), { publicKey: 'abc', projectId: '123', host: 'o1.ingest.sentry.io', envelopeUrl: 'https://o1.ingest.sentry.io/api/123/envelope/', dsn: 'https://abc@o1.ingest.sentry.io/123' });
  assert.equal(parseDsn('https://abc:legacy@host.test/sub/7').dsn, 'https://abc@host.test/sub/7', 'the legacy secret key never travels');
  assert.throws(() => parseDsn('not a dsn'), /not a URL/);
  assert.throws(() => parseDsn('https://host.test/1'), /must look like/);

  const res = await request('/boom/one?token=abc123&page=2', {
    headers: { authorization: `Bearer ${alice.token}`, cookie: 'sid=s3cr3t', 'user-agent': 'tests/1.0' },
    body: { password: 'hunter2', item: 'book', nested: { apiKey: 'k', list: [{ refresh_token: 'r' }], internalNote: 'x' } },
  });
  assert.equal(res.status, 500);
  await t.idle();
  assert.equal(envelopes.length, 1);
  const [{ url, headers, header, item, event, raw }] = envelopes;

  assert.equal(url, '/api/42/envelope/');
  assert.equal(headers['content-type'], 'application/x-sentry-envelope');
  assert.match(headers['x-sentry-auth'], /^Sentry sentry_version=7, sentry_key=publickey123, sentry_client=calmapi-sentry\/1\.0\.0$/);
  assert.equal(raw.length, 4, 'three lines and a trailing newline');
  assert.equal(header.event_id, event.event_id);
  assert.match(header.event_id, /^[a-f0-9]{32}$/);
  assert.equal(header.dsn, `http://publickey123@${origin}/42`);
  assert.ok(header.sent_at);
  assert.deepEqual({ type: item.type, length: item.length }, { type: 'event', length: Buffer.byteLength(raw[2]) });

  assert.equal(event.platform, 'node');
  assert.equal(event.level, 'error');
  assert.equal(event.release, 'fixture@1.2.3');
  assert.equal(event.environment, 'test');
  const ex = event.exception.values.at(-1);
  assert.equal(ex.type, 'Error');
  assert.equal(ex.value, 'kaboom one Bearer [Filtered]', 'tokens inside messages are scrubbed');
  const frames = ex.stacktrace.frames;
  assert.ok(frames.length > 1);
  const top = frames.at(-1);
  assert.equal(top.filename, 'app/routes.js', 'paths are relative to the project');
  assert.equal(top.in_app, true);
  assert.ok(top.lineno > 0 && top.colno > 0);
  assert.ok(frames.some((f) => !f.in_app), 'framework and node_modules frames are marked');

  assert.equal(event.transaction, 'POST /api/boom/:kind');
  assert.equal(event.tags.route, 'POST /api/boom/:kind');
  assert.equal(event.tags.status_code, '500');
  assert.ok(event.tags.request_id);
  assert.equal(event.request.method, 'POST');
  assert.match(event.request.url, /^http:\/\/127\.0\.0\.1:\d+\/api\/boom\/one$/, 'no query string in the URL');
  assert.equal(event.request.query_string, 'token=%5BFiltered%5D&page=2');
  assert.equal(event.request.headers.authorization, undefined);
  assert.equal(event.request.headers.cookie, undefined);
  assert.equal(event.request.headers['user-agent'], 'tests/1.0');
  assert.deepEqual(event.request.data, { password: '[Filtered]', item: 'book', nested: { apiKey: '[Filtered]', list: [{ refresh_token: '[Filtered]' }], internalNote: '[Filtered]' } });
  assert.deepEqual(event.user, { id: alice.id }, 'the user id only: no email, no IP');

  const crumbs = event.breadcrumbs.values.map((b) => [b.level, b.message]);
  assert.deepEqual(crumbs.slice(0, 2), [['info', 'loading cart ?token=[Filtered]&page=2'], ['warning', 'cart service slow']]);
  assert.ok(!JSON.stringify(envelopes[0]).includes('hunter2'));
  assert.ok(!JSON.stringify(envelopes[0]).includes(alice.token));
  assert.ok(!JSON.stringify(envelopes[0]).includes('abc123'));
  assert.ok(!JSON.stringify(envelopes[0]).includes(alice.email));
});

test('sentry: 4xx are never reported', async () => {
  const before = envelopes.length;
  assert.equal((await request('/bad', { method: 'GET' })).status, 400);
  assert.equal((await request('/denied', { method: 'GET', headers: { authorization: `Bearer ${alice.token}` } })).status, 403);
  assert.equal((await request('/nope', { method: 'GET' })).status, 404);
  assert.equal((await t.post('/auth/login', { email: alice.email, password: 'wrong-password-123' })).status, 401);
  await t.idle();
  assert.equal(envelopes.length, before);
});

test('sentry: bursts of the same error are sent once', async () => {
  const before = envelopes.length;
  const deduped = t.app.ext.sentry.stats.deduped;
  for (let i = 0; i < 5; i++) assert.equal((await request('/boom/burst')).status, 500);
  await t.idle();
  assert.equal(envelopes.length - before, 1);
  assert.equal(t.app.ext.sentry.stats.deduped - deduped, 4);
  assert.equal((await request('/boom/other')).status, 500, 'another error still goes through');
  await t.idle();
  assert.equal(envelopes.length - before, 2);
});

test('sentry: failed background work and manual captures are reported', async () => {
  const before = envelopes.length;
  t.app.background(() => {
    throw new TypeError('background job exploded');
  });
  await t.idle();
  const bg = await waitFor(() => envelopes.slice(before).find((e) => e.event.exception?.values.at(-1).value === 'background job exploded'), 'background event');
  assert.equal(bg.event.exception.values.at(-1).type, 'TypeError');
  assert.equal(bg.event.tags.source, 'log');
  assert.equal(bg.event.extra.log, 'Background task failed');

  const id = t.app.ext.sentry.captureException(new Error('outer', { cause: new RangeError('inner') }), { tags: { feature: 'checkout' }, extra: { secretToken: 'x', orderId: 7 } });
  await t.idle();
  const manual = envelopes.find((e) => e.event.event_id === id);
  assert.deepEqual(manual.event.exception.values.map((v) => v.type), ['RangeError', 'Error'], 'causes are chained, outermost last');
  assert.equal(manual.event.tags.feature, 'checkout');
  assert.deepEqual(manual.event.extra, { secretToken: '[Filtered]', orderId: 7 });

  const msgId = t.app.ext.sentry.captureMessage('Nightly import finished with warnings', { level: 'warning' });
  await t.idle();
  const msg = envelopes.find((e) => e.event.event_id === msgId);
  assert.equal(msg.event.message.formatted, 'Nightly import finished with warnings');
  assert.equal(msg.event.level, 'warning');
});

test('sentry: sample rate, ignored errors and beforeSend', async () => {
  const sampled = await project.testApp({ blocks: { sentry: { sampleRate: 0 } } });
  try {
    const before = envelopes.length;
    for (let i = 0; i < 3; i++) sampled.app.ext.sentry.captureException(new Error(`sampled ${i}`));
    await sampled.idle();
    assert.equal(envelopes.length, before, 'sampleRate 0 sends nothing');
    assert.equal(sampled.app.ext.sentry.stats.sampledOut, 3);
  } finally {
    await sampled.close();
  }

  const filtered = await project.testApp({ blocks: { sentry: { ignoreErrors: ['ECONNRESET', /^Expected:/], beforeSend: (e) => (e.tags.drop ? null : { ...e, tags: { ...e.tags, edited: 'yes' } }) } } });
  try {
    const before = envelopes.length;
    const s = filtered.app.ext.sentry;
    assert.equal(s.captureException(new Error('read ECONNRESET')), null);
    assert.equal(s.captureException(new Error('Expected: nothing')), null);
    assert.equal(s.captureException(new Error('dropped'), { tags: { drop: '1' } }), null);
    const kept = s.captureException(new Error('kept'));
    await filtered.idle();
    assert.equal(envelopes.length - before, 1);
    assert.equal(envelopes.at(-1).event.event_id, kept);
    assert.equal(envelopes.at(-1).event.tags.edited, 'yes');
  } finally {
    await filtered.close();
  }
});

test('sentry: scrub() helper and doctor', async () => {
  const { scrub } = await project.load('app/blocks/sentry/index.js');
  assert.deepEqual(scrub({ Authorization: 'x', 'X-Api-Key': 'y', set_cookie: 'z', footprint: 'ok', zip: '1', user: { otp: '1', name: 'A' } }), { Authorization: '[Filtered]', 'X-Api-Key': '[Filtered]', set_cookie: '[Filtered]', footprint: 'ok', zip: '1', user: { otp: '[Filtered]', name: 'A' } });

  process.env.SENTRY_DSN = 'oops';
  const bad = await project.testApp();
  try {
    assert.ok((await bad.app.doctor()).some((f) => f.id === 'sentry-dsn' && f.level === 'error'));
    assert.equal(bad.app.ext.sentry.enabled, false);
    assert.equal(bad.app.ext.sentry.captureException(new Error('x')), null);
  } finally {
    await bad.close();
    process.env.SENTRY_DSN = `http://publickey123@${origin}/42`;
  }
});
