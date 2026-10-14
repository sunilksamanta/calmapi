# Payments with Stripe (payments-stripe)

Sell subscriptions and one-time purchases with [Stripe Checkout](https://docs.stripe.com/payments/checkout), and let customers manage their plan, card and invoices in the [Stripe customer portal](https://docs.stripe.com/customer-management). The block talks to the Stripe REST API with `fetch` (no SDK, no dependencies), keeps one Stripe customer per user, syncs subscriptions from signed webhooks processed exactly once, and gives your routes a plan check.

```bash
npx calm add payments-stripe
```

| Adds | |
| --- | --- |
| Files | `app/blocks/payments-stripe/index.js` (routes, webhook processing, plan checks), `stripe.js` (the REST client), `signature.js` (Stripe-Signature verification, no imports besides `node:crypto`) |
| Environment | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (both required in production) |
| Collections | `calm_billing_customers`, `calm_billing_subscriptions`, `calm_billing_purchases`, `calm_billing_events` (processed event ids, TTL index) |

## Setup

1. **Products and prices.** In the Stripe dashboard (test mode first), create a product per plan and a price for it: recurring for subscriptions, one-off for one-time purchases. Copy the price ids (`price_...`).
2. **List what you sell** in `calm.config.js`. Only these prices can be bought:

   ```js
   export default defineConfig({
     blocks: {
       'payments-stripe': {
         prices: {
           price_1PmonthlyPro: 'pro',                                  // subscription (the default mode)
           price_1PyearlyPro: { plan: 'pro', mode: 'subscription' },
           price_1Plifetime: { plan: 'lifetime', mode: 'payment' },     // one-time purchase
         },
       },
     },
   });
   ```

3. **API key.** Dashboard > Developers > API keys: put the secret key in `.env` as `STRIPE_SECRET_KEY` (the test key locally, the live key in production; a restricted key with write access to Customers, Checkout Sessions and Customer portal and read access to Subscriptions works too).
4. **Customer portal.** Dashboard > Settings > Billing > Customer portal: turn on what customers may do (update payment method, switch plans between your prices, cancel) and save. The portal refuses to open until this is saved once.
5. **Webhook.** Dashboard > Developers > Webhooks > Add endpoint: URL `https://<your api>/api/billing/webhook`, events `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.paid`, `invoice.payment_failed`. Copy its signing secret into `.env` as `STRIPE_WEBHOOK_SECRET`.
6. Run `npx calm doctor`: it reports a missing key or webhook secret, a test key in production and a live key in development.

### Local testing with the Stripe CLI

```bash
stripe login
stripe listen --forward-to localhost:5001/api/billing/webhook
# prints "Your webhook signing secret is whsec_...": put it in .env as STRIPE_WEBHOOK_SECRET

stripe trigger checkout.session.completed      # or customer.subscription.updated, invoice.payment_failed...
```

Pay in test mode with the card `4242 4242 4242 4242` (any future date, any CVC); `4000 0000 0000 0341` attaches but fails on the first renewal, to try `invoice.payment_failed`.

## Routes

All under `/api/billing`. `checkout`, `portal` and `GET /` need a signed-in user (option `policy`).

### `GET /api/billing/prices` (public)

```json
{ "data": [{ "price": "price_1PmonthlyPro", "plan": "pro", "mode": "subscription" }, { "price": "price_1Plifetime", "plan": "lifetime", "mode": "payment" }] }
```

### `POST /api/billing/checkout`

```json
{ "price": "price_1PmonthlyPro", "successUrl": "https://app.example.com/billing/done?s={CHECKOUT_SESSION_ID}", "cancelUrl": "https://app.example.com/pricing" }
```

Pass `price` (one of the listed ids) or `plan` (when one price sells it). `successUrl` and `cancelUrl` are optional (defaults: `APP_URL/billing/success?session_id={CHECKOUT_SESSION_ID}` and `APP_URL/billing`) and must be on an allowed origin. Answers `201`:

```json
{ "data": { "id": "cs_test_a1b2...", "url": "https://checkout.stripe.com/c/pay/cs_test_a1b2..." } }
```

Errors: `422` unknown price or redirect on another origin, `409 ALREADY_SUBSCRIBED` (a live subscription exists: plans change in the portal; option `oneSubscription`), `502 PAYMENT_PROVIDER_ERROR` (Stripe refused or is unreachable; the details are in your log, not the answer), `503 BILLING_NOT_CONFIGURED`.

### `POST /api/billing/portal`

```json
{ "returnUrl": "https://app.example.com/settings" }
```

`returnUrl` is optional (default `APP_URL/billing`). Answers `{ "data": { "url": "https://billing.stripe.com/p/session/..." } }`, or `404` when the user never started a checkout.

### `GET /api/billing`

```json
{
  "data": {
    "customer": true,
    "plan": "pro",
    "plans": ["pro"],
    "status": "active",
    "priceId": "price_1PmonthlyPro",
    "currentPeriodEnd": "2026-11-13T09:00:00.000Z",
    "cancelAtPeriodEnd": false,
    "trialEnd": null,
    "subscriptions": [{ "id": "sub_...", "status": "active", "plan": "pro", "active": true, "currentPeriodEnd": "...", "cancelAtPeriodEnd": false, "latestInvoiceStatus": "paid" }],
    "purchases": []
  }
}
```

`plan` is the plan of the current subscription when it is active (`activeStatuses`, default `active` and `trialing`), else a plan bought once, else `null`.

### `POST /api/billing/webhook`

For Stripe only. The `Stripe-Signature` header is checked over the raw body; answers `200 { received: true }` (also for duplicates and event types the block does not handle), `400 INVALID_SIGNATURE` otherwise.

## Requiring a plan

```js
// app/routes.js
import { requirePlan } from './blocks/payments-stripe/index.js';

export default (r) => {
  // 402 PLAN_REQUIRED with a readable message (401 signed out)
  r.get('/reports/advanced', { policy: 'authenticated', meta: { plan: 'pro' } }, buildReport);
  r.get('/exports', { policy: 'authenticated', meta: { plan: ['pro', 'team'] } }, exportAll);

  // As a policy (403 without the plan): a named policy per plan, or the helper
  r.get('/insights', { policy: 'plan-pro | admin' }, insights);
  r.get('/team/seats', { policy: requirePlan('team') }, seats);
};
```

Named policies (`plan-pro`, `plan-team`...) work in resource files too: `policy: { create: 'plan-pro' }`. In code: `await app.ext.billing.hasPlan(userId, 'pro')`, `await app.ext.billing.plansOf(userId)`.

## Events

| Event | Payload |
| --- | --- |
| `billing.checkout_completed` | `{ user, sessionId, mode, plan, priceId }` |
| `billing.subscription_updated` | `{ user, subscription, previousStatus, type }` on every change of status, price, period end or cancel flag |
| `billing.subscription_canceled` | same payload, once, when a subscription ends |
| `billing.payment_succeeded` | `{ user, invoiceId, subscriptionId, amount, currency }` |
| `billing.payment_failed` | `{ user, invoiceId, subscriptionId, amount, currency, attemptCount, nextPaymentAttempt, hostedInvoiceUrl }` |

```js
calm.on('billing.subscription_canceled', async ({ user }) => {
  await calm.app.ext.notify?.(user, { title: 'Your subscription ended', body: 'Your data is kept for 30 days.' });
});
```

With the notifications block installed, a failed payment notifies the user (option `notifyPaymentFailed`).

## Options

| Option | Default | |
| --- | --- | --- |
| `prices` | `{}` | `{ price_id: 'plan' }` or `{ price_id: { plan, mode: 'subscription' \| 'payment' } }` |
| `successUrl`, `cancelUrl` | `APP_URL/billing/success?session_id={CHECKOUT_SESSION_ID}`, `APP_URL/billing` | Checkout redirects when the client sends none |
| `portalReturnUrl` | `APP_URL/billing` | |
| `allowedRedirects` | origin of `APP_URL` | Origins clients may redirect to |
| `activeStatuses` | `['active', 'trialing']` | Add `'past_due'` for a grace period while Stripe retries the card |
| `policy` | `'authenticated'` | Who may check out and open the portal |
| `oneSubscription` | `true` | Refuse a second subscription checkout (409) |
| `allowPromotionCodes` | `false` | Promotion code field in Checkout |
| `trialDays` | `0` | Free trial for subscriptions |
| `toleranceSeconds` | `300` | Max age of a webhook signature |
| `keepEventsDays` | `30` | How long processed event ids are kept |
| `notifyPaymentFailed` | `true` | With the notifications block |
| `apiBase` | `https://api.stripe.com/v1` | Point tests at a fake server |
| `apiVersion` | `null` | Pin a Stripe API version (both payload shapes before and after 2025-03-31 are read) |
| `timeoutMs` | `15000` | Per Stripe call |

## Security notes

- **Clients never choose what they pay.** Only listed price ids can be bought, there is no amount or quantity field, and the customer comes from the session, never the request.
- **Redirects are allowlisted.** `successUrl`, `cancelUrl` and `returnUrl` must be on `allowedRedirects` (default: your `APP_URL` origin), so the API cannot be used to bounce people to a phishing page.
- **Webhooks are verified on the raw bytes.** The route declares `rawBody: true`, so the HMAC-SHA256 is computed over exactly what Stripe sent, compared in constant time against every `v1` value (secret rolls), and refused outside a 5 minute window (replays). Without `STRIPE_WEBHOOK_SECRET` webhooks are refused, never accepted unsigned.
- **Exactly once.** Each event id is claimed with a unique index before anything happens. A duplicate answers 200 and does nothing; a failure drops the claim and answers 500 so Stripe retries.
- **Order does not matter.** A subscription is only updated by an event newer than the last applied one, and a canceled subscription is never reactivated by a late event.
- **Plans come from webhooks only.** The success page grants nothing: it should read `GET /api/billing` (the webhook usually arrives first; poll for a few seconds if not).
- **Live and test stay apart.** With a live key, test mode events are ignored. `calm doctor` flags test keys in production and live keys elsewhere.
- **One customer per user** even when two checkouts race: Stripe gets the same Idempotency-Key, the database a unique index. Every create sends an Idempotency-Key, so a retried network call never charges twice.
- Stripe error messages can describe your account; they go to the log, and the client gets `502 PAYMENT_PROVIDER_ERROR`.

## Frontend

```js
const api = (path, body) =>
  fetch(`/api/billing${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: body && JSON.stringify(body),
  }).then((r) => r.json());

// Pricing page: "Subscribe" button
const { data } = await api('/checkout', { plan: 'pro' });
location.assign(data.url);

// Settings page
const { data: billing } = await api('');
if (billing.plan) manageButton.onclick = async () => location.assign((await api('/portal', {})).data.url);
if (billing.cancelAtPeriodEnd) notice.textContent = `Ends on ${new Date(billing.currentPeriodEnd).toLocaleDateString()}`;
```
