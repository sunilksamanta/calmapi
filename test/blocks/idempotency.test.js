import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');

const files = {
  'calm.config.js': `import { defineConfig } from '#calm';
export default defineConfig({ blocks: { idempotency: { required: ['POST /api/payments', 'POST /api/nowhere'], docsUrl: 'https://example.test/docs/idempotency' } } });
`,
  'app/resources/order/order.resource.js': `
import { resource, f } from '#calm';
export default resource('order', {
  fields: { item: f.string().required(), qty: f.integer().min(1).default(1), buyer: f.ref('user').owner() },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/routes.js': `
const runs = (globalThis.idemRuns ??= { slow: 0, flaky: 0, binary: 0 });
export default (r) => {
  r.post('/slow', { policy: 'authenticated' }, async (ctx) => {
    runs.slow += 1;
    await globalThis.idemGate;
    return ctx.reply({ ran: runs.slow }, { status: 201 });
  });
  r.post('/flaky', { policy: 'authenticated' }, () => {
    runs.flaky += 1;
    if (runs.flaky === 1) throw new Error('database hiccup');
    return { ran: runs.flaky };
  });
  r.post('/payments', { policy: 'authenticated' }, () => ({ paid: true }));
  r.post('/echo', { policy: 'public' }, (ctx) => ({ echo: ctx.body, at: Date.now() + Math.random() }));
  r.post('/binary', { policy: 'authenticated' }, (ctx) => {
    runs.binary += 1;
    ctx.res.status(201).type('application/octet-stream');
    ctx.res.write(Buffer.from([0, 1, 2, 255]));
    ctx.res.end(Buffer.from([254, 253]));
  });
};
`,
};

let project;
let t;
let alice;
let bob;

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [CALM, 'add', 'idempotency', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp();
  alice = await t.signup({ name: 'Alice' });
  bob = await t.signup({ name: 'Bob' });
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

/** POST with an Idempotency-Key; returns { status, headers, text, body }. */
async function send(path, body, { key, who, method = 'POST' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key !== undefined) headers['idempotency-key'] = key;
  if (who) headers.authorization = `Bearer ${who.token}`;
  const res = await fetch(`${t.origin}/api${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // binary or empty
  }
  return { status: res.status, headers: res.headers, text, body: json };
}

const orders = (who) => t.app.model('order').countDocuments({ buyer: who.id });
const store = () => t.app.ext.idempotency.model;

describe('replay', () => {
  test('a retry returns the stored response and the handler runs once', async () => {
    const key = randomUUID();
    const first = await send('/orders', { item: 'book', qty: 2 }, { key, who: alice });
    assert.equal(first.status, 201);
    assert.equal(first.headers.get('idempotent-replayed'), null);

    const again = await send('/orders', { item: 'book', qty: 2 }, { key, who: alice });
    assert.equal(again.status, 201);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.equal(again.text, first.text, 'same body, byte for byte');
    assert.equal(again.headers.get('content-type'), first.headers.get('content-type'));
    assert.equal(again.headers.get('etag'), first.headers.get('etag'));
    assert.notEqual(again.headers.get('x-request-id'), first.headers.get('x-request-id'), 'each request keeps its own id');

    // The draft's quoted form names the same key, and key order in the body does not matter.
    const quoted = await send('/orders', { qty: 2, item: 'book' }, { key: `"${key}"`, who: alice });
    assert.equal(quoted.headers.get('idempotent-replayed'), 'true');
    assert.equal(quoted.text, first.text);
    assert.equal(await orders(alice), 1, 'one order, not three');
  });

  test('the same key with a different request is refused with 422', async () => {
    const key = randomUUID();
    assert.equal((await send('/orders', { item: 'pen' }, { key, who: alice })).status, 201);
    const before = await orders(alice);
    const reused = await send('/orders', { item: 'pencil' }, { key, who: alice });
    assert.equal(reused.status, 422);
    assert.equal(reused.body.error.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(reused.headers.get('link'), '<https://example.test/docs/idempotency>; rel="describedby"; type="text/html"');
    const query = await send('/orders?dryRun=1', { item: 'pen' }, { key, who: alice });
    assert.equal(query.status, 422, 'the query string is part of the request fingerprint');
    assert.equal(await orders(alice), before);
  });

  test('keys are per user: the same key from someone else runs normally', async () => {
    const key = randomUUID();
    const mine = await send('/orders', { item: 'lamp' }, { key, who: alice });
    const theirs = await send('/orders', { item: 'lamp' }, { key, who: bob });
    assert.equal(theirs.status, 201);
    assert.equal(theirs.headers.get('idempotent-replayed'), null);
    assert.notEqual(theirs.body.data.id, mine.body.data.id);
    assert.equal(theirs.body.data.buyer, bob.id, "bob never sees alice's response");
    const anonymous = await send('/echo', { hello: 1 }, { key });
    const anonymousAgain = await send('/echo', { hello: 1 }, { key });
    assert.equal(anonymousAgain.headers.get('idempotent-replayed'), 'true', 'anonymous callers are keyed by IP');
    assert.equal(anonymousAgain.text, anonymous.text);
  });

  test('4xx responses are stored, binary and streamed bodies replay exactly', async () => {
    const key = randomUUID();
    const before = await orders(alice);
    const invalid = await send('/orders', { qty: 0 }, { key, who: alice });
    assert.equal(invalid.status, 422);
    const again = await send('/orders', { qty: 0 }, { key, who: alice });
    assert.equal(again.status, 422);
    assert.equal(again.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(again.body.error.details, invalid.body.error.details);
    assert.equal(await orders(alice), before);

    const bin = randomUUID();
    const raw = async () => {
      const res = await fetch(`${t.origin}/api/binary`, { method: 'POST', headers: { 'idempotency-key': bin, authorization: `Bearer ${alice.token}` } });
      return { status: res.status, replayed: res.headers.get('idempotent-replayed'), bytes: [...new Uint8Array(await res.arrayBuffer())] };
    };
    const one = await raw();
    const two = await raw();
    assert.deepEqual(one, { status: 201, replayed: null, bytes: [0, 1, 2, 255, 254, 253] });
    assert.deepEqual(two, { status: 201, replayed: 'true', bytes: [0, 1, 2, 255, 254, 253] });
    assert.equal(globalThis.idemRuns.binary, 1);
  });
});

describe('retries and concurrency', () => {
  test('a duplicate sent while the first is still running gets 409', async () => {
    let release;
    globalThis.idemGate = new Promise((resolve) => (release = resolve));
    const key = randomUUID();
    const first = send('/slow', { n: 1 }, { key, who: alice });
    for (let i = 0; i < 200 && !(await store().exists({ key, status: 'running' })); i++) await new Promise((r) => setTimeout(r, 10));

    const duplicate = await send('/slow', { n: 1 }, { key, who: alice });
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'IDEMPOTENCY_IN_PROGRESS');
    assert.equal(duplicate.headers.get('retry-after'), '1');
    assert.equal((await send('/slow', { n: 2 }, { key, who: alice })).status, 422, 'a different request is still a reuse');

    release();
    const done = await first;
    assert.equal(done.status, 201);
    const later = await send('/slow', { n: 1 }, { key, who: alice });
    assert.equal(later.headers.get('idempotent-replayed'), 'true');
    assert.equal(later.text, done.text);
    assert.equal(globalThis.idemRuns.slow, 1);
  });

  test('5xx responses are not stored, so the retry runs again', async () => {
    const key = randomUUID();
    const failed = await send('/flaky', {}, { key, who: alice });
    assert.equal(failed.status, 500);
    assert.equal(await store().exists({ key }), null, 'the lock is dropped');
    const retried = await send('/flaky', {}, { key, who: alice });
    assert.equal(retried.status, 200);
    assert.equal(retried.headers.get('idempotent-replayed'), null);
    const replayed = await send('/flaky', {}, { key, who: alice });
    assert.equal(replayed.headers.get('idempotent-replayed'), 'true');
    assert.deepEqual(replayed.body, { data: { ran: 2 } });
    assert.equal(globalThis.idemRuns.flaky, 2);
  });

  test('a lock abandoned by a crashed process can be taken over', async () => {
    const key = randomUUID();
    assert.equal((await send('/orders', { item: 'mug' }, { key, who: bob })).status, 201);
    // As if the first attempt died mid-request: running, lock expired.
    await store().updateOne({ key }, { $set: { status: 'running', lockedUntil: new Date(Date.now() - 1000), response: null } });
    const retry = await send('/orders', { item: 'mug' }, { key, who: bob });
    assert.equal(retry.status, 201);
    assert.equal(retry.headers.get('idempotent-replayed'), null);
  });
});

describe('header rules', () => {
  test('required routes need a key; invalid keys are refused; reads ignore the header', async () => {
    const missing = await send('/payments', { amount: 5 }, { who: alice });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'IDEMPOTENCY_KEY_MISSING');
    assert.equal((await send('/payments', { amount: 5 }, { who: alice, key: randomUUID() })).status, 200);
    assert.equal((await send('/orders', { item: 'x' }, { who: alice })).status, 201, 'optional elsewhere');

    for (const bad of ['x'.repeat(256), 'has space', 'tab\there', '"unterminated', '""']) {
      const res = await send('/orders', { item: 'x' }, { who: alice, key: bad });
      assert.equal(res.status, 400, bad);
      assert.equal(res.body.error.code, 'IDEMPOTENCY_KEY_INVALID');
    }
    const key = randomUUID();
    const read = await send('/orders', undefined, { who: alice, key, method: 'GET' });
    assert.equal(read.status, 200);
    assert.equal(await store().exists({ key }), null);
  });

  test('records expire through a TTL index and never store unsafe headers', async () => {
    const indexes = await t.app.mongoose.connection.db.collection('calm_idempotency').indexes();
    const ttl = indexes.find((i) => i.key.expiresAt === 1);
    assert.equal(ttl?.expireAfterSeconds, 0);
    const key = randomUUID();
    await send('/orders', { item: 'tea' }, { key, who: alice });
    const doc = await store().findOne({ key }).lean();
    assert.equal(doc.status, 'done');
    assert.equal(doc.user.toString(), alice.id);
    const hours = (doc.expiresAt - Date.now()) / 3_600_000;
    assert.ok(hours > 23.9 && hours <= 24, `kept 24 hours, got ${hours}`);
    assert.deepEqual(Object.keys(doc.response.headers).sort(), ['content-type', 'etag']);
    assert.notEqual(doc._id, key, 'stored under a hash of user, method, path and key');
  });

  test('doctor warns about required patterns that match no route', async () => {
    const findings = await t.app.doctor();
    const unmatched = findings.filter((f) => f.id === 'idempotency-required-unmatched');
    assert.deepEqual(unmatched.map((f) => f.title), ['idempotency: "POST /api/nowhere" matches no route']);
  });
});
