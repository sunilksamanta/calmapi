import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';
import { explainText } from '../../src/cli/lib/explain-text.js';

const files = {
  'app/resources/order/order.resource.js': `import { resource, f } from '#calm';

export default resource('order', {
  fields: { item: f.string().required(), buyer: f.ref('user').owner() },
  policy: {
    list: 'owner | admin',
    read: 'owner | admin',
    create: 'authenticated',
    update: 'owner | admin',
    delete: 'owner | admin',
  },
});
`,
  'app/resources/order/order.service.js': `import { ResourceService } from '#calm';
export default class OrderService extends ResourceService {
  async beforeCreate(data) { return { ...data, item: data.item.trim() }; }
}
`,
};

let project;
let t;
const record = async (id) => (await fetch(`${t.origin}/_calm/api/requests/${id}`, { headers: { host: 'localhost' } })).json();
const idOf = (res) => res.headers.get('x-request-id');
const settle = () => new Promise((r) => setTimeout(r, 30));

before(async () => {
  project = await makeProject({ files });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('a create shows auth, policy, handler, hook and event steps in order', async () => {
  const alice = await t.signup({ name: 'Alice' });
  const res = await t.post('/orders', { item: ' book ' }, alice);
  assert.equal(res.status, 201);
  await settle();
  const rec = await record(idOf(res));
  const kinds = rec.steps.map((s) => s.kind);
  for (const k of ['auth', 'policy', 'handler', 'hook', 'event']) assert.ok(kinds.includes(k), `${k} in ${kinds.join(',')}`);
  assert.ok(kinds.indexOf('auth') < kinds.indexOf('policy') && kinds.indexOf('policy') < kinds.indexOf('handler'));
  const ats = rec.steps.map((s) => s.at);
  assert.deepEqual([...ats].sort((a, b) => a - b), ats, 'steps are in time order');
  assert.equal(rec.steps.find((s) => s.kind === 'auth').name, 'session');
  assert.equal(rec.steps.find((s) => s.kind === 'hook').name, 'OrderService.beforeCreate');
  assert.equal(rec.steps.find((s) => s.kind === 'hook').file, 'app/resources/order/order.service.js');
  assert.equal(rec.steps.find((s) => s.kind === 'event').name, 'order.created');
  const policy = rec.steps.find((s) => s.kind === 'policy');
  assert.equal(policy.outcome, 'passed');
  assert.equal(policy.line, 5, 'the line of policy: in the resource file');
});

test("someone else's record: the policy step says why, token by token", async () => {
  const owner = await t.signup({ name: 'Owner' });
  const other = await t.signup({ name: 'Grace Hopper' });
  const order = (await t.post('/orders', { item: 'x' }, owner)).body.data;
  const res = await t.patch(`/orders/${order.id}`, { item: 'y' }, other);
  assert.equal(res.status, 404);
  await settle();
  const rec = await record(idOf(res));
  const policy = rec.steps.find((s) => s.kind === 'policy');
  assert.equal(policy.outcome, 'denied');
  const owner_ = policy.detail.find((d) => d.token === 'owner');
  assert.equal(owner_.result, 'deny');
  assert.match(owner_.why, /^doc\.buyer \w{4}…\w{2} is not user \w{4}…\w{2}$/);
  assert.match(policy.detail.find((d) => d.token === 'admin').why, /user has roles \[user\]/);
  assert.match(policy.note, /may not even read/);
  assert.ok(!rec.steps.some((s) => s.kind === 'handler'), 'the handler never ran');

  const text = explainText(rec);
  assert.match(text, /^PATCH \/api\/orders\/\w{4}…\w{2} -> 404 NOT FOUND {3}as Grace Hopper \(user\)/);
  assert.match(text, /✖ policy "owner \| admin"/);
  assert.match(text, /owner: doc\.buyer/);
  assert.match(text, /service and hooks did not run/);
});

test('anonymous: the auth step says so and the policy step names the 401', async () => {
  const res = await t.get('/orders');
  assert.equal(res.status, 401);
  await settle();
  const rec = await record(idOf(res));
  assert.equal(rec.steps.find((s) => s.kind === 'auth').name, 'anonymous');
  assert.equal(rec.steps.find((s) => s.kind === 'error').name, 'UNAUTHORIZED');
});

test('trace() outside a request is a no-op, and policies explain only when asked', async () => {
  const { trace, evaluatePolicy, parsePolicy } = await project.load('calm/index.js');
  assert.equal(trace({ kind: 'event', name: 'x' }), null);
  const plain = await evaluatePolicy(parsePolicy('admin'), { user: { id: '1', roles: ['user'] } });
  assert.equal(plain.trace, undefined);
  const told = await evaluatePolicy(parsePolicy('owner | admin'), { user: { id: '1', roles: ['user'] }, action: 'read', explain: true });
  assert.deepEqual(told.trace.map((x) => [x.token, x.result]), [['owner', 'allow'], ['admin', 'deny']]);
});

test('without devtools nothing is collected', async () => {
  const { requestContext } = await project.load('calm/http/middleware.js');
  const { currentRequest } = await project.load('calm/context.js');
  const fakeReq = { get: () => undefined };
  const fakeRes = { setHeader() {} };
  const seen = {};
  await new Promise((done) => requestContext()(fakeReq, fakeRes, () => ((seen.off = currentRequest().steps), done())));
  await new Promise((done) => requestContext({ trace: true })(fakeReq, fakeRes, () => ((seen.on = currentRequest().steps), done())));
  assert.equal(seen.off, null);
  assert.deepEqual(seen.on, []);
});
