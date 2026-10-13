import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

// Route option rawBody: true keeps the exact bytes of a JSON body as ctx.rawBody, for
// signature checks (Stripe, GitHub...). Other routes do not keep a second copy.
const files = {
  'app/routes.js': `
const show = (ctx) => ({ raw: ctx.rawBody ? ctx.rawBody.toString('utf8') : null, buffer: Buffer.isBuffer(ctx.rawBody), body: ctx.body });
export default (r) => {
  r.post('/signed', { policy: 'public', rawBody: true }, show);
  r.post('/hooks/:source', { policy: 'public', rawBody: true }, show);
  r.post('/normal', { policy: 'public' }, show);
  r.put('/hooks/:source', { policy: 'public' }, show);
};
`,
};

let project;
let t;
before(async () => {
  project = await makeProject({ files });
  t = await project.testApp();
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const send = async (method, path, text) => {
  const res = await fetch(`${t.origin}/api${path}`, { method, headers: { 'content-type': 'application/json' }, body: text });
  return { status: res.status, body: await res.json() };
};

test('rawBody: true gives the exact bytes next to the parsed body', async () => {
  const text = '{ "b" : 2,\n  "a": [1, 2] }';
  const res = await send('POST', '/signed', text);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.raw, text);
  assert.equal(res.body.data.buffer, true);
  assert.deepEqual(res.body.data.body, { b: 2, a: [1, 2] });
  assert.equal((await send('POST', '/hooks/github', text)).body.data.raw, text, 'path parameters match one segment');
});

test('other routes, methods and paths get ctx.rawBody = null', async () => {
  assert.equal((await send('POST', '/normal', '{"a":1}')).body.data.raw, null);
  assert.equal((await send('PUT', '/hooks/github', '{"a":1}')).body.data.raw, null, 'same path, another method');
  assert.equal((await send('POST', '/hooks/github/extra', '{"a":1}')).status, 404);
});

test('rawBodyMatcher: method and segments, null when no route asks', async () => {
  const { rawBodyMatcher } = await project.load('calm/http/router.js');
  assert.equal(rawBodyMatcher([{ method: 'POST', path: '/a', rawBody: false }]), null);
  const match = rawBodyMatcher([{ method: 'POST', path: '/billing/webhook', rawBody: true }, { method: 'POST', path: '/in/:id', rawBody: true }]);
  assert.equal(match({ method: 'POST', path: '/billing/webhook' }), true);
  assert.equal(match({ method: 'POST', path: '/billing/webhook/' }), true);
  assert.equal(match({ method: 'GET', path: '/billing/webhook' }), false);
  assert.equal(match({ method: 'POST', path: '/billing' }), false);
  assert.equal(match({ method: 'POST', path: '/in/42' }), true);
  assert.equal(match({ method: 'POST', path: '/in/42/x' }), false);
});
