import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');

// Fake keys, built at runtime so nothing key-shaped is committed.
const SECRET_KEY = `sk_${'test'}_${randomBytes(12).toString('hex')}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(18).toString('base64url')}`;
const PRO = 'price_pro_monthly';
const TEAM = 'price_team_monthly';
const LIFETIME = 'price_lifetime';

// A fake Stripe API that records every request. Customers are deduplicated by
// Idempotency-Key like Stripe does; subscriptions for GET /v1/subscriptions/:id come from `subs`.
const requests = [];
const subs = new Map();
const byKey = new Map();
let failNext = 0;
let stripeServer;
let counter = 0;

function fakeStripe(req, res) {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const url = new URL(req.url, 'http://stripe.test');
    const record = { method: req.method, path: url.pathname, headers: req.headers, form: Object.fromEntries(new URLSearchParams(raw)) };
    requests.push(record);
    const send = (status, body) => res.writeHead(status, { 'content-type': 'application/json', 'request-id': 'req_fake' }).end(JSON.stringify(body));
    if (req.headers.authorization !== `Bearer ${SECRET_KEY}`) return send(401, { error: { type: 'invalid_request_error', message: 'Invalid API key' } });
    if (failNext > 0) {
      failNext -= 1;
      return send(400, { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such price: secret_internal_detail' } });
    }
    const key = req.headers['idempotency-key'];
    if (req.method === 'POST' && key && byKey.has(key)) return send(200, byKey.get(key));
    let body;
    if (req.method === 'POST' && url.pathname === '/v1/customers') body = { id: `cus_${++counter}`, object: 'customer', livemode: false, email: record.form.email };
    else if (req.method === 'POST' && url.pathname === '/v1/checkout/sessions') body = { id: `cs_test_${++counter}`, object: 'checkout.session', url: `https://checkout.stripe.test/c/${counter}` };
    else if (req.method === 'POST' && url.pathname === '/v1/billing_portal/sessions') body = { id: `bps_${++counter}`, object: 'billing_portal.session', url: `https://billing.stripe.test/p/${counter}` };
    else if (req.method === 'GET' && url.pathname.startsWith('/v1/subscriptions/')) {
      const sub = subs.get(decodeURIComponent(url.pathname.split('/').pop()));
      return sub ? send(200, sub) : send(404, { error: { type: 'invalid_request_error', message: 'No such subscription' } });
    } else return send(404, { error: { type: 'invalid_request_error', message: 'Unrecognized request URL' } });
    if (key) byKey.set(key, body);
    send(200, body);
  });
}

const files = {
  'app/routes.js': `
import { requirePlan } from './blocks/payments-stripe/index.js';
export default (r) => {
  r.get('/reports/pro', { policy: 'authenticated', meta: { plan: 'pro' } }, () => ({ report: 'pro' }));
  r.get('/reports/named', { policy: 'plan-pro' }, () => ({ report: 'named' }));
  r.get('/reports/helper', { policy: requirePlan('pro', 'team') }, () => ({ report: 'helper' }));
};
`,
};

let project;
let t;
let sign;
let alice;
let bob;
const seen = [];

before(async () => {
  stripeServer = createServer(fakeStripe);
  await new Promise((resolve) => stripeServer.listen(0, '127.0.0.1', resolve));
  process.env.STRIPE_SECRET_KEY = SECRET_KEY;
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files });
  execFileSync(process.execPath, [CALM, 'add', 'payments-stripe', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({
    blocks: {
      'payments-stripe': {
        apiBase: `http://127.0.0.1:${stripeServer.address().port}/v1`,
        prices: { [PRO]: 'pro', [TEAM]: { plan: 'team' }, [LIFETIME]: { plan: 'lifetime', mode: 'payment' } },
        allowedRedirects: ['https://app.example.test'],
      },
    },
  });
  ({ signStripePayload: sign } = await project.load('app/blocks/payments-stripe/signature.js'));
  t.app.events.on('billing.*', (payload, name) => seen.push({ name, payload }));
  alice = await t.signup({ name: 'Alice' });
  bob = await t.signup({ name: 'Bob' });
});
after(async () => {
  await t?.close();
  project?.cleanup();
  await new Promise((resolve) => stripeServer?.close(resolve));
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
});

const now = () => Math.floor(Date.now() / 1000);
let eventCount = 0;
/** A Stripe event. `created` grows with each call so lifecycle events are in order. */
const event = (type, object, extra = {}) => ({
  id: `evt_test_${++eventCount}_${randomBytes(4).toString('hex')}`,
  object: 'event',
  type,
  created: now() - 1000 + eventCount,
  livemode: false,
  data: { object },
  ...extra,
});
const subscription = (id, customer, status, { price = PRO, cancelAtPeriodEnd = false, periodEnd = now() + 30 * 86_400 } = {}) => ({
  id,
  object: 'subscription',
  customer,
  status,
  cancel_at_period_end: cancelAtPeriodEnd,
  items: { data: [{ id: `si_${id}`, price: { id: price }, current_period_end: periodEnd }] },
  metadata: {},
});

/** POST a webhook; options change the signature, timestamp or body to test refusals. */
async function deliver(evt, { secret = WEBHOOK_SECRET, timestamp, header, body } = {}) {
  const payload = JSON.stringify(evt);
  const headers = { 'content-type': 'application/json' };
  const signature = header !== undefined ? header : sign(payload, secret, { timestamp });
  if (signature !== null) headers['stripe-signature'] = signature;
  const res = await fetch(`${t.origin}/api/billing/webhook`, { method: 'POST', headers, body: body ?? payload });
  const json = await res.json();
  await t.idle();
  return { status: res.status, body: json };
}

const billing = () => t.app.ext.billing;
const stripeCalls = (path) => requests.filter((r) => r.path === path);

/** Give a user a Stripe customer through a real checkout, and return its id. */
async function customerOf(who) {
  const res = await t.post('/billing/checkout', { price: PRO }, who);
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return (await billing().Customer.findOne({ user: who.id }).lean()).customerId;
}

test('checkout: allowlisted prices only, redirect allowlist, customer created once and reused, idempotency keys', async () => {
  assert.equal((await t.post('/billing/checkout', { price: PRO })).status, 401);
  const before = requests.length;
  const unknown = await t.post('/billing/checkout', { price: 'price_cheap_old' }, alice);
  assert.equal(unknown.status, 422);
  assert.equal(unknown.body.error.details.price, 'Unknown price');
  const evil = await t.post('/billing/checkout', { price: PRO, successUrl: 'https://evil.test/phish' }, alice);
  assert.equal(evil.status, 422);
  assert.match(evil.body.error.details.successUrl, /app\.example\.test/);
  assert.equal((await t.post('/billing/checkout', { price: PRO, cancelUrl: 'javascript:alert(1)' }, alice)).status, 422);
  assert.equal((await t.post('/billing/checkout', { amount: 1 }, alice)).status, 422, 'no amount field exists');
  assert.equal(requests.length, before, 'refused requests never reach Stripe');

  const first = await t.post('/billing/checkout', { price: PRO, successUrl: 'https://app.example.test/thanks?s={CHECKOUT_SESSION_ID}' }, alice);
  assert.equal(first.status, 201);
  assert.match(first.body.data.url, /^https:\/\/checkout\.stripe\.test\//);
  assert.match(first.body.data.id, /^cs_test_/);
  const second = await t.post('/billing/checkout', { plan: 'team' }, alice);
  assert.equal(second.status, 201);

  const customers = stripeCalls('/v1/customers');
  assert.equal(customers.length, 1, 'the customer is created once');
  assert.equal(customers[0].headers['idempotency-key'], `calm-customer-${alice.id}`);
  assert.equal(customers[0].form['metadata[userId]'], alice.id);
  const sessions = stripeCalls('/v1/checkout/sessions').slice(-2);
  assert.equal(sessions[0].form.customer, sessions[1].form.customer, 'the customer is reused');
  assert.equal(sessions[0].form.mode, 'subscription');
  assert.equal(sessions[0].form['line_items[0][price]'], PRO);
  assert.equal(sessions[0].form['line_items[0][quantity]'], '1');
  assert.equal(sessions[0].form.client_reference_id, alice.id);
  assert.equal(sessions[0].form['subscription_data[metadata][userId]'], alice.id);
  assert.equal(sessions[0].form.success_url, 'https://app.example.test/thanks?s={CHECKOUT_SESSION_ID}');
  assert.equal(sessions[1].form['line_items[0][price]'], TEAM);
  assert.match(sessions[0].headers['idempotency-key'], /^calm-checkout-/);
  assert.notEqual(sessions[0].headers['idempotency-key'], sessions[1].headers['idempotency-key'], 'a new click is a new session');
  assert.equal(sessions[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(sessions[0].headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(await billing().Customer.countDocuments({ user: alice.id }), 1);
});

test('checkout: concurrent first checkouts create one customer', async () => {
  const carol = await t.signup({ name: 'Carol' });
  const results = await Promise.all([1, 2, 3, 4].map(() => t.post('/billing/checkout', { price: PRO }, carol)));
  assert.deepEqual(results.map((r) => r.status), [201, 201, 201, 201]);
  assert.equal(await billing().Customer.countDocuments({ user: carol.id }), 1);
  assert.equal(new Set(stripeCalls('/v1/checkout/sessions').slice(-4).map((s) => s.form.customer)).size, 1);
});

test('checkout: provider errors answer 502 without Stripe details', async () => {
  failNext = 1;
  const res = await t.post('/billing/checkout', { price: PRO }, alice);
  assert.equal(res.status, 502);
  assert.equal(res.body.error.code, 'PAYMENT_PROVIDER_ERROR');
  assert.doesNotMatch(JSON.stringify(res.body), /secret_internal_detail/);
});

test('portal: needs a customer, return URL restricted, default return URL', async () => {
  const dave = await t.signup({ name: 'Dave' });
  assert.equal((await t.post('/billing/portal', {}, dave)).status, 404);
  assert.equal((await t.post('/billing/portal', {})).status, 401);
  const customer = await customerOf(dave);
  assert.equal((await t.post('/billing/portal', { returnUrl: 'https://evil.test/' }, dave)).status, 422);
  const res = await t.post('/billing/portal', {}, dave);
  assert.equal(res.status, 200);
  assert.match(res.body.data.url, /^https:\/\/billing\.stripe\.test\//);
  const call = stripeCalls('/v1/billing_portal/sessions').at(-1);
  assert.equal(call.form.customer, customer);
  assert.match(call.form.return_url, /\/billing$/);
  assert.ok(call.headers['idempotency-key']);
});

test('webhook: signature valid, invalid, expired, tampered, missing; several v1 values', async () => {
  const evt = () => event('customer.created', { id: 'cus_x', object: 'customer' }); // unknown type: answers 200 when the signature is right
  assert.equal((await deliver(evt())).status, 200);

  const wrong = await deliver(evt(), { secret: `whsec_${randomBytes(18).toString('base64url')}` });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.body.error.code, 'INVALID_SIGNATURE');

  const expired = await deliver(evt(), { timestamp: now() - 600 });
  assert.equal(expired.status, 400);
  assert.match(expired.body.error.message, /tolerance/);

  const original = evt();
  const tampered = await deliver(original, { body: JSON.stringify({ ...original, livemode: true }) });
  assert.equal(tampered.status, 400);

  assert.equal((await deliver(evt(), { header: null })).status, 400, 'no Stripe-Signature header');
  assert.equal((await deliver(evt(), { header: 'garbage' })).status, 400);
  assert.equal((await deliver(evt(), { header: `t=${now()}` })).status, 400, 'no v1');

  // During a secret roll Stripe sends one v1 per secret: any match is enough.
  const rolled = evt();
  const payload = JSON.stringify(rolled);
  const good = sign(payload, WEBHOOK_SECRET).split('v1=')[1];
  const ts = now();
  const header = `t=${ts},v1=${'0'.repeat(64)},v1=${sign(payload, WEBHOOK_SECRET, { timestamp: ts }).split('v1=')[1]},v0=${good}`;
  assert.equal((await deliver(rolled, { header })).status, 200);

  // Same body re-serialized differently (whitespace): the bytes changed, so it is refused.
  const spaced = evt();
  const spacedRes = await fetch(`${t.origin}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'stripe-signature': sign(JSON.stringify(spaced), WEBHOOK_SECRET) },
    body: JSON.stringify(spaced, null, 2),
  });
  assert.equal(spacedRes.status, 400);
});

test('webhook: unknown event types are ignored with 200 and not stored', async () => {
  const res = await deliver(event('payment_method.attached', { id: 'pm_1' }));
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data, { received: true, ignored: true });
  assert.equal(await billing().StripeEvent.countDocuments({ type: 'payment_method.attached' }), 0);
});

test('webhook: an event delivered twice is processed once', async () => {
  const customer = await customerOf(bob);
  const evt = event('customer.subscription.created', subscription('sub_dup', customer, 'active'));
  const before = seen.filter((e) => e.name === 'billing.subscription_updated').length;
  const [a, b] = await Promise.all([deliver(evt), deliver(evt)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  assert.equal([a.body.data.duplicate, b.body.data.duplicate].filter(Boolean).length, 1);
  const third = await deliver(evt);
  assert.equal(third.body.data.duplicate, true);
  assert.equal(seen.filter((e) => e.name === 'billing.subscription_updated').length - before, 1);
  assert.equal((await billing().StripeEvent.findById(evt.id).lean()).status, 'done');
  // Clean up: Bob has no subscription for the next tests.
  await billing().Subscription.deleteMany({ user: bob.id });
});

test('subscription lifecycle updates the status, and plan checks follow it', async () => {
  const erin = await t.signup({ name: 'Erin' });
  const customer = await customerOf(erin);
  const id = 'sub_life';

  // No plan yet: 402 with meta.plan, 403 with policies, 401 signed out.
  assert.equal((await t.get('/reports/pro', erin)).status, 402);
  assert.equal((await t.get('/reports/pro', erin)).body.error.code, 'PLAN_REQUIRED');
  assert.equal((await t.get('/reports/named', erin)).status, 403);
  assert.equal((await t.get('/reports/helper', erin)).status, 403);
  assert.equal((await t.get('/reports/pro')).status, 401);
  assert.equal((await t.get('/reports/named')).status, 401);

  await deliver(event('customer.subscription.created', subscription(id, customer, 'incomplete')));
  assert.equal((await t.get('/billing', erin)).body.data.status, 'incomplete');
  assert.equal((await t.get('/reports/pro', erin)).status, 402, 'incomplete is not active');

  const periodEnd = now() + 30 * 86_400;
  await deliver(event('customer.subscription.updated', subscription(id, customer, 'active', { periodEnd })));
  let status = (await t.get('/billing', erin)).body.data;
  assert.equal(status.status, 'active');
  assert.equal(status.plan, 'pro');
  assert.deepEqual(status.plans, ['pro']);
  assert.equal(status.customer, true);
  assert.equal(new Date(status.currentPeriodEnd).getTime(), periodEnd * 1000);
  assert.equal(status.cancelAtPeriodEnd, false);
  assert.equal((await t.get('/reports/pro', erin)).status, 200);
  assert.equal((await t.get('/reports/named', erin)).status, 200);
  assert.equal((await t.get('/reports/helper', erin)).status, 200);
  assert.equal((await t.get('/reports/pro', alice)).status, 402, 'other users still have no plan');

  // A second subscription checkout is refused while one is live: plans change in the portal.
  const again = await t.post('/billing/checkout', { price: TEAM }, erin);
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'ALREADY_SUBSCRIBED');

  const stale = event('customer.subscription.updated', subscription(id, customer, 'past_due'));
  await deliver(event('customer.subscription.updated', subscription(id, customer, 'active', { cancelAtPeriodEnd: true, periodEnd })));
  assert.equal((await t.get('/billing', erin)).body.data.cancelAtPeriodEnd, true);

  const updates = seen.filter((e) => e.name === 'billing.subscription_updated' && e.payload.user === erin.id);
  assert.ok(updates.length >= 3);
  assert.equal(updates.at(-1).payload.subscription.cancelAtPeriodEnd, true);

  await deliver(event('customer.subscription.deleted', subscription(id, customer, 'canceled')));
  status = (await t.get('/billing', erin)).body.data;
  assert.equal(status.status, 'canceled');
  assert.equal(status.plan, null);
  assert.ok(seen.some((e) => e.name === 'billing.subscription_canceled' && e.payload.user === erin.id));
  assert.equal((await t.get('/reports/pro', erin)).status, 402);

  // An older event delivered late never brings a canceled subscription back.
  await deliver(stale);
  await deliver(event('customer.subscription.updated', subscription(id, customer, 'active')));
  assert.equal((await t.get('/billing', erin)).body.data.status, 'canceled');
});

test('checkout.session.completed activates the subscription at once', async () => {
  const frank = await t.signup({ name: 'Frank' });
  const customer = await customerOf(frank);
  subs.set('sub_frank', subscription('sub_frank', customer, 'active', { price: TEAM }));
  const res = await deliver(event('checkout.session.completed', { id: 'cs_test_frank', object: 'checkout.session', mode: 'subscription', customer, subscription: 'sub_frank', client_reference_id: frank.id, payment_status: 'paid', metadata: { userId: frank.id, plan: 'team', priceId: TEAM } }));
  assert.equal(res.status, 200);
  assert.ok(requests.some((r) => r.method === 'GET' && r.path === '/v1/subscriptions/sub_frank'));
  const status = (await t.get('/billing', frank)).body.data;
  assert.equal(status.plan, 'team');
  assert.equal(status.status, 'active');
  assert.equal((await t.get('/reports/helper', frank)).status, 200, "requirePlan('pro', 'team') accepts team");
  assert.equal((await t.get('/reports/pro', frank)).status, 402);
  assert.ok(seen.some((e) => e.name === 'billing.checkout_completed' && e.payload.user === frank.id));
});

test('one-time payments grant their plan', async () => {
  const gina = await t.signup({ name: 'Gina' });
  const start = await t.post('/billing/checkout', { price: LIFETIME }, gina);
  assert.equal(start.status, 201);
  const call = stripeCalls('/v1/checkout/sessions').at(-1);
  assert.equal(call.form.mode, 'payment');
  assert.equal(call.form['payment_intent_data[metadata][userId]'], gina.id);
  const customer = call.form.customer;
  const session = { id: 'cs_test_gina', object: 'checkout.session', mode: 'payment', customer, client_reference_id: gina.id, payment_status: 'paid', amount_total: 9900, currency: 'eur', metadata: { userId: gina.id, plan: 'lifetime', priceId: LIFETIME } };
  await deliver(event('checkout.session.completed', { ...session, payment_status: 'unpaid' }));
  assert.equal((await t.get('/billing', gina)).body.data.plan, null, 'not paid yet');
  await deliver(event('checkout.session.async_payment_succeeded', session));
  const status = (await t.get('/billing', gina)).body.data;
  assert.equal(status.plan, 'lifetime');
  assert.equal(status.purchases[0].amountTotal, 9900);
  assert.deepEqual(await billing().plansOf(gina.id), ['lifetime']);
});

test('invoices: payment_failed is emitted, paid is recorded', async () => {
  const hank = await t.signup({ name: 'Hank' });
  const customer = await customerOf(hank);
  await deliver(event('customer.subscription.created', subscription('sub_hank', customer, 'active')));
  const failed = await deliver(event('invoice.payment_failed', { id: 'in_1', object: 'invoice', customer, parent: { subscription_details: { subscription: 'sub_hank' } }, amount_due: 1500, currency: 'usd', attempt_count: 1, next_payment_attempt: now() + 86_400, hosted_invoice_url: 'https://invoice.stripe.test/i/1' }));
  assert.equal(failed.status, 200);
  const emitted = seen.find((e) => e.name === 'billing.payment_failed' && e.payload.user === hank.id);
  assert.ok(emitted);
  assert.equal(emitted.payload.subscriptionId, 'sub_hank');
  assert.equal(emitted.payload.amount, 1500);
  assert.equal((await billing().Subscription.findById('sub_hank').lean()).latestInvoiceStatus, 'payment_failed');

  await deliver(event('invoice.paid', { id: 'in_2', object: 'invoice', customer, subscription: 'sub_hank', amount_paid: 1500, currency: 'usd' }));
  assert.equal((await billing().Subscription.findById('sub_hank').lean()).latestInvoiceStatus, 'paid');
  assert.ok(seen.some((e) => e.name === 'billing.payment_succeeded' && e.payload.user === hank.id));
});

test('events for customers this app does not know are acknowledged and ignored', async () => {
  const res = await deliver(event('customer.subscription.updated', subscription('sub_ghost', 'cus_unknown', 'active')));
  assert.equal(res.status, 200);
  assert.equal(await billing().Subscription.countDocuments({ _id: 'sub_ghost' }), 0);
});

test('prices route lists what is on sale', async () => {
  const res = await t.get('/billing/prices');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.data.map((p) => p.plan).sort(), ['lifetime', 'pro', 'team']);
});

test('doctor: live key outside production, missing webhook secret', async () => {
  const ids = async () => (await t.app.doctor()).filter((f) => f.id.startsWith('billing-')).map((f) => f.id);
  assert.deepEqual(await ids(), []);
  process.env.STRIPE_SECRET_KEY = `sk_${'live'}_${randomBytes(12).toString('hex')}`;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  try {
    assert.deepEqual((await ids()).sort(), ['billing-live-key', 'billing-webhook-secret']);
    // Without a webhook secret, webhooks are refused (503), never processed unsigned.
    const res = await deliver(event('invoice.paid', { id: 'in_x', object: 'invoice', customer: 'cus_1' }));
    assert.equal(res.status, 503);
  } finally {
    process.env.STRIPE_SECRET_KEY = SECRET_KEY;
    process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  }
});
