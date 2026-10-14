import { randomUUID } from 'node:crypto';
import { definePlugin, f, CalmError, unauthorized, notFound, validationError } from '#calm';
import { createStripe, StripeError } from './stripe.js';
import { verifyStripeSignature, StripeSignatureError } from './signature.js';

// Stripe Checkout, subscriptions and the customer portal, without the SDK.
//
//  - Prices are allowlisted in calm.config.js: a client picks one of them by id or plan name,
//    and never sends an amount. Stripe charges what the price says, nothing else.
//  - Success, cancel and portal return URLs must be on APP_URL's origin (or allowedRedirects),
//    so the checkout flow cannot be used to send people to another site.
//  - One Stripe customer per user, created on first checkout, once: the insert is guarded by
//    a unique index and the Stripe call by an Idempotency-Key derived from the user id.
//  - The webhook (POST /api/billing/webhook) is the source of truth. Its signature is checked
//    over the raw bytes (route option rawBody), with a tolerance window against replays, and
//    each event id is processed once (unique _id in calm_billing_events), however many times
//    Stripe delivers it.
//  - Events arrive in any order. A subscription is only updated by an event newer than the
//    last one applied, and a canceled subscription never comes back to life.
//  - Changes are announced as app events (billing.subscription_updated, billing.payment_failed...)
//    for your code, the notifications block or webhooks to react to.

export { verifyStripeSignature, signStripePayload, StripeSignatureError } from './signature.js';

const MODES = ['subscription', 'payment'];
// Stripe statuses a subscription never leaves: an older event must not reactivate it.
const TERMINAL = new Set(['canceled', 'incomplete_expired']);
// A subscription in one of these still exists for Stripe: a second checkout would bill twice.
const LIVE = new Set(['active', 'trialing', 'past_due', 'unpaid', 'paused']);
const OBJECT_ID = /^[a-f\d]{24}$/i;
const HANDLED = new Set([
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.paid',
  'invoice.payment_failed',
]);

const toDate = (seconds) => (typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : null);
const idOf = (value) => (typeof value === 'string' ? value : (value?.id ?? null));

// The instance of the running app, for requirePlan() (named policies are process wide too).
let current = null;

/**
 * A policy function for routes and resources: policy: requirePlan('pro'), or combined,
 * policy: ['admin', requirePlan('pro', 'team')]. Signed-out callers get 401, others 403.
 * For a 402 with a readable message use the route option meta: { plan: 'pro' } instead.
 */
export function requirePlan(...plans) {
  const wanted = plans.flat();
  const fn = async (ctx) => Boolean(current && ctx.user && (await current.hasPlan(ctx.user.id, wanted)));
  Object.defineProperty(fn, 'name', { value: `plan(${wanted.join(' | ')})` });
  return fn;
}

export default definePlugin({
  name: 'payments-stripe',
  env: {
    STRIPE_SECRET_KEY: { required: 'production', secret: true, description: 'Secret API key from the Stripe dashboard (Developers > API keys), sk_live_... in production' },
    STRIPE_WEBHOOK_SECRET: { required: 'production', secret: true, description: 'Signing secret of the webhook endpoint (whsec_...), from the dashboard or `stripe listen`' },
  },
  // Override in calm.config.js: blocks: { 'payments-stripe': { prices: { price_123: 'pro' } } }
  options: {
    /** The prices clients may buy: { price_123: 'pro' } or { price_123: { plan: 'pro', mode: 'subscription' | 'payment' } }. */
    prices: {},
    /** Where Stripe sends the buyer back. Default: APP_URL + '/billing/success?session_id={CHECKOUT_SESSION_ID}' and APP_URL + '/billing'. */
    successUrl: null,
    cancelUrl: null,
    /** Where the customer portal returns. Default: APP_URL + '/billing'. */
    portalReturnUrl: null,
    /** Origins a client may pass as successUrl, cancelUrl or returnUrl. Default: the origin of APP_URL. */
    allowedRedirects: null,
    /** Subscription statuses that count as having the plan. Add 'past_due' for a grace period. */
    activeStatuses: ['active', 'trialing'],
    /** Who may start a checkout and open the portal. */
    policy: 'authenticated',
    /** Refuse a subscription checkout while the user has a live subscription (409): plans change in the portal. */
    oneSubscription: true,
    allowPromotionCodes: false,
    trialDays: 0,
    /** Max age of a webhook signature, in seconds. */
    toleranceSeconds: 300,
    /** How long processed event ids are remembered (Stripe retries for up to 3 days). */
    keepEventsDays: 30,
    /** With the notifications block: tell the user when a payment fails. */
    notifyPaymentFailed: true,
    apiBase: 'https://api.stripe.com/v1',
    /** Pin a Stripe API version (Stripe-Version header). Default: your account's version. */
    apiVersion: null,
    timeoutMs: 15_000,
  },
  setup(calm, options) {
    const { mode } = calm.config;
    const appUrl = calm.config.app.url.replace(/\/$/, '');

    // ---- prices and plans ---------------------------------------------------------------
    const prices = new Map();
    for (const [id, spec] of Object.entries(options.prices ?? {})) {
      const s = typeof spec === 'string' ? { plan: spec } : (spec ?? {});
      if (!/^price_\w+$/.test(id)) throw new Error(`payments-stripe: "${id}" is not a Stripe price id (price_...)`);
      if (typeof s.plan !== 'string' || !s.plan) throw new Error(`payments-stripe: prices.${id} needs a plan name, e.g. { plan: 'pro' }`);
      const priceMode = s.mode ?? 'subscription';
      if (!MODES.includes(priceMode)) throw new Error(`payments-stripe: prices.${id}.mode must be 'subscription' or 'payment'`);
      prices.set(id, { id, plan: s.plan, mode: priceMode });
    }
    const plans = [...new Set([...prices.values()].map((p) => p.plan))];
    const activeStatuses = new Set(options.activeStatuses);

    const origins = new Set(
      (options.allowedRedirects?.length ? options.allowedRedirects : [appUrl]).map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`payments-stripe: allowedRedirects entry "${o}" is not a URL (use origins like https://app.example.com)`);
        }
      }),
    );
    const defaults = {
      successUrl: options.successUrl ?? `${appUrl}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
      cancelUrl: options.cancelUrl ?? `${appUrl}/billing`,
      returnUrl: options.portalReturnUrl ?? `${appUrl}/billing`,
    };

    const stripe = createStripe({ apiBase: options.apiBase, key: () => calm.env('STRIPE_SECRET_KEY'), apiVersion: options.apiVersion, timeoutMs: options.timeoutMs });
    // Live keys answer live events only: a test event (livemode false) never changes live data.
    const liveKey = () => /^(sk|rk)_live_/.test(calm.env('STRIPE_SECRET_KEY', ''));

    // ---- storage ------------------------------------------------------------------------
    const { Schema } = calm.mongoose;
    const customerSchema = new Schema(
      {
        user: { type: Schema.Types.ObjectId, ref: 'user', required: true, unique: true }, // one customer per user, even under races
        customerId: { type: String, required: true, unique: true },
        livemode: Boolean,
      },
      { collection: 'calm_billing_customers', timestamps: true, versionKey: false },
    );
    const Customer = calm.mongoose.model('calmBillingCustomer', customerSchema);

    const subscriptionSchema = new Schema(
      {
        _id: String, // sub_...
        user: { type: Schema.Types.ObjectId, ref: 'user', required: true },
        customerId: String,
        status: { type: String, required: true },
        priceId: String,
        plan: String,
        currentPeriodEnd: Date,
        cancelAtPeriodEnd: { type: Boolean, default: false },
        cancelAt: Date,
        canceledAt: Date,
        endedAt: Date,
        trialEnd: Date,
        latestInvoiceId: String,
        latestInvoiceStatus: String, // 'paid' | 'payment_failed'
        lastEventAt: Date, // created time of the newest Stripe event applied (ordering)
      },
      { collection: 'calm_billing_subscriptions', timestamps: true, versionKey: false },
    );
    subscriptionSchema.index({ user: 1, status: 1 });
    const Subscription = calm.mongoose.model('calmBillingSubscription', subscriptionSchema);

    const purchaseSchema = new Schema(
      {
        _id: String, // the Checkout Session id (cs_...): one purchase per session
        user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
        customerId: String,
        priceId: String,
        plan: String,
        amountTotal: Number,
        currency: String,
        paymentIntentId: String,
        paidAt: Date,
      },
      { collection: 'calm_billing_purchases', timestamps: true, versionKey: false },
    );
    const Purchase = calm.mongoose.model('calmBillingPurchase', purchaseSchema);

    const eventSchema = new Schema(
      {
        _id: String, // evt_...: the unique index is what makes processing exactly once
        type: String,
        status: { type: String, enum: ['processing', 'done'], required: true },
        lockId: String,
        lockedUntil: Date,
        processedAt: Date,
        expiresAt: { type: Date, required: true },
      },
      { collection: 'calm_billing_events', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
    );
    eventSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const StripeEvent = calm.mongoose.model('calmBillingEvent', eventSchema);

    // ---- views --------------------------------------------------------------------------
    const subscriptionView = (s) => ({
      id: s._id,
      status: s.status,
      plan: s.plan ?? null,
      priceId: s.priceId ?? null,
      active: activeStatuses.has(s.status),
      currentPeriodEnd: s.currentPeriodEnd ?? null,
      cancelAtPeriodEnd: Boolean(s.cancelAtPeriodEnd),
      cancelAt: s.cancelAt ?? null,
      canceledAt: s.canceledAt ?? null,
      trialEnd: s.trialEnd ?? null,
      latestInvoiceStatus: s.latestInvoiceStatus ?? null,
    });
    const purchaseView = (p) => ({ id: p._id, plan: p.plan ?? null, priceId: p.priceId ?? null, amountTotal: p.amountTotal ?? null, currency: p.currency ?? null, paidAt: p.paidAt ?? null });

    // ---- plans --------------------------------------------------------------------------
    /** The plans a user has now: live subscriptions in activeStatuses, plus one-time purchases. */
    async function plansOf(userId) {
      if (!OBJECT_ID.test(String(userId))) return [];
      const [subs, bought] = await Promise.all([
        Subscription.find({ user: userId, status: { $in: [...activeStatuses] } }).select('plan').lean(),
        Purchase.find({ user: userId }).select('plan').lean(),
      ]);
      return [...new Set([...subs, ...bought].map((d) => d.plan).filter(Boolean))];
    }
    const hasPlan = async (userId, wanted) => {
      const mine = await plansOf(userId);
      return [].concat(wanted).some((p) => mine.includes(p));
    };

    // ---- helpers --------------------------------------------------------------------------
    const notConfigured = () => new CalmError(503, 'BILLING_NOT_CONFIGURED', 'Payments are not configured on this server');
    /** Stripe's message can describe your account (a missing price...): it goes to the log, not the client. */
    function providerError(err, action) {
      if (err instanceof StripeError && err.type === 'configuration_error') return notConfigured();
      calm.log.error(`payments-stripe: ${action} failed`, { err: err.message, status: err.status, type: err.type, code: err.code, stripeRequestId: err.requestId });
      return new CalmError(502, 'PAYMENT_PROVIDER_ERROR', 'The payment provider could not be reached. Try again in a moment.');
    }

    /** A client-supplied redirect, only on an allowed origin (no open redirect through Stripe). */
    function redirectProblem(value) {
      let url;
      try {
        url = new URL(value);
      } catch {
        return 'Must be an absolute URL';
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'Must be an http(s) URL';
      if (!origins.has(url.origin)) return `Must be on ${[...origins].join(' or ')}`;
      return null;
    }

    function pickPrice(body) {
      if (body.price) {
        // Only allowlisted price ids: a client cannot buy a price you did not list (an old
        // cheaper one, another product's) and never sends an amount.
        const p = prices.get(body.price);
        if (!p) throw validationError({ price: 'Unknown price' });
        return p;
      }
      if (body.plan) {
        const matching = [...prices.values()].filter((p) => p.plan === body.plan);
        if (matching.length !== 1) throw validationError({ plan: matching.length ? 'Several prices sell this plan: pass price instead' : 'Unknown plan' });
        return matching[0];
      }
      throw validationError({ price: 'Pass price (a price id) or plan' });
    }

    /** The user's Stripe customer id, created once. */
    async function ensureCustomer(user) {
      const existing = await Customer.findOne({ user: user.id }).lean();
      if (existing) return existing.customerId;
      // Two requests racing here send the same Idempotency-Key, so Stripe creates one
      // customer and answers both with it; the unique index keeps one mapping.
      const customer = await stripe.request('POST', '/customers', {
        params: { email: user.email, name: user.name, metadata: { userId: user.id } },
        idempotencyKey: `calm-customer-${user.id}`,
      });
      try {
        await Customer.create({ user: user.id, customerId: customer.id, livemode: Boolean(customer.livemode) });
        return customer.id;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return (await Customer.findOne({ user: user.id }).lean()).customerId;
      }
    }

    /**
     * The user a Stripe object belongs to: by customer id first. The metadata hint is only
     * trusted because it comes from a verified webhook, and only this server (or someone
     * with dashboard access) writes metadata.userId.
     */
    async function userFor(customerId, hint) {
      if (customerId) {
        const c = await Customer.findOne({ customerId }).lean();
        if (c) return String(c.user);
      }
      if (!hint || !OBJECT_ID.test(String(hint))) return null;
      if (calm.app.services.has('user') && !(await calm.app.model('user').exists({ _id: hint }))) return null;
      if (customerId) await Customer.updateOne({ user: hint }, { $setOnInsert: { customerId } }, { upsert: true }).catch(() => {});
      return String(hint);
    }

    // ---- syncing from Stripe ------------------------------------------------------------
    /** The subscription item that sells one of our prices (else the first item). */
    const itemOf = (sub) => {
      const items = sub.items?.data ?? [];
      return items.find((i) => prices.has(i.price?.id)) ?? items[0] ?? null;
    };

    /**
     * Apply a subscription object. `eventAt` is the created time of the event it came with:
     * an older event than the last applied one is ignored (Stripe does not guarantee order).
     */
    async function syncSubscription(sub, eventAt, type) {
      const customerId = idOf(sub.customer);
      const user = await userFor(customerId, sub.metadata?.userId);
      if (!user) {
        calm.log.warn(`payments-stripe: ${type} for a customer this app does not know, ignored`, { subscription: sub.id, customer: customerId });
        return null;
      }
      const item = itemOf(sub);
      const priceId = item?.price?.id ?? null;
      const fields = {
        user,
        customerId,
        status: sub.status,
        priceId,
        plan: prices.get(priceId)?.plan ?? item?.price?.lookup_key ?? null,
        // current_period_end moved to the items in Stripe API 2025-03-31: read both.
        currentPeriodEnd: toDate(sub.current_period_end ?? item?.current_period_end),
        cancelAtPeriodEnd: Boolean(sub.cancel_at_period_end),
        cancelAt: toDate(sub.cancel_at),
        canceledAt: toDate(sub.canceled_at),
        endedAt: toDate(sub.ended_at),
        trialEnd: toDate(sub.trial_end),
        lastEventAt: eventAt,
      };
      const filter = { _id: sub.id, $or: [{ lastEventAt: null }, { lastEventAt: { $lte: eventAt } }] };
      if (!TERMINAL.has(sub.status)) filter.status = { $nin: [...TERMINAL] };
      let previous;
      try {
        previous = await Subscription.findOneAndUpdate(filter, { $set: fields }, { upsert: true, returnDocument: 'before' }).lean();
      } catch (err) {
        // The record exists but the filter refused it: a newer event already applied, or it is canceled.
        if (err?.code === 11000) return null;
        throw err;
      }
      const after = { ...(previous ?? {}), ...fields, _id: sub.id };
      const changed = !previous || ['status', 'priceId', 'cancelAtPeriodEnd', 'currentPeriodEnd'].some((k) => String(previous[k] ?? '') !== String(after[k] ?? ''));
      if (changed) {
        const payload = { user, subscription: subscriptionView(after), previousStatus: previous?.status ?? null, type };
        calm.events.emit('billing.subscription_updated', payload);
        if (TERMINAL.has(after.status) && !TERMINAL.has(previous?.status)) calm.events.emit('billing.subscription_canceled', payload);
      }
      return after;
    }

    async function checkoutCompleted(session, event) {
      const user = await userFor(idOf(session.customer), session.client_reference_id ?? session.metadata?.userId);
      if (!user) {
        calm.log.warn('payments-stripe: checkout session for an unknown user, ignored', { session: session.id });
        return;
      }
      if (session.mode === 'subscription' && session.subscription) {
        // The session does not carry the subscription: fetch it, so the plan is active as soon
        // as the buyer lands on the success page. Fetched now, it is newer than any queued event.
        const sub = typeof session.subscription === 'object' ? session.subscription : await stripe.request('GET', `/subscriptions/${encodeURIComponent(session.subscription)}`);
        await syncSubscription(sub, new Date(), event.type);
      }
      if (session.mode === 'payment') {
        // 'unpaid' means a delayed method (bank debit): async_payment_succeeded follows.
        if (session.payment_status !== 'paid' && session.payment_status !== 'no_payment_required') return;
        const priceId = session.metadata?.priceId ?? null;
        await Purchase.updateOne(
          { _id: session.id },
          {
            $setOnInsert: {
              user,
              customerId: idOf(session.customer),
              priceId,
              plan: prices.get(priceId)?.plan ?? session.metadata?.plan ?? null,
              amountTotal: session.amount_total ?? null,
              currency: session.currency ?? null,
              paymentIntentId: idOf(session.payment_intent),
              paidAt: new Date(),
            },
          },
          { upsert: true },
        );
      }
      calm.events.emit('billing.checkout_completed', { user, sessionId: session.id, mode: session.mode, plan: session.metadata?.plan ?? null, priceId: session.metadata?.priceId ?? null, type: event.type });
    }

    async function invoiceEvent(invoice, event) {
      const user = await userFor(idOf(invoice.customer), invoice.metadata?.userId);
      if (!user) return;
      // The subscription moved under invoice.parent in Stripe API 2025-03-31: read both.
      const subscriptionId = idOf(invoice.subscription) ?? idOf(invoice.parent?.subscription_details?.subscription) ?? null;
      const paid = event.type === 'invoice.paid';
      if (subscriptionId) {
        await Subscription.updateOne({ _id: subscriptionId }, { $set: { latestInvoiceId: invoice.id, latestInvoiceStatus: paid ? 'paid' : 'payment_failed' } });
      }
      const payload = {
        user,
        invoiceId: invoice.id,
        subscriptionId,
        amount: paid ? (invoice.amount_paid ?? null) : (invoice.amount_due ?? null),
        currency: invoice.currency ?? null,
        attemptCount: invoice.attempt_count ?? null,
        nextPaymentAttempt: toDate(invoice.next_payment_attempt),
        hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
      };
      calm.events.emit(paid ? 'billing.payment_succeeded' : 'billing.payment_failed', payload);
      if (!paid && options.notifyPaymentFailed && typeof calm.app.ext.notify === 'function') {
        await calm.app.ext
          .notify(user, { title: 'Your payment failed', body: 'We could not charge your card. Update your payment method to keep your plan.', url: defaults.returnUrl })
          .catch((err) => calm.log.warn('payments-stripe: could not notify the user about a failed payment', { err: err.message }));
      }
    }

    async function handle(event) {
      const object = event.data?.object ?? {};
      const at = toDate(event.created) ?? new Date();
      switch (event.type) {
        case 'checkout.session.completed':
        case 'checkout.session.async_payment_succeeded':
          return checkoutCompleted(object, event);
        case 'customer.subscription.created':
        case 'customer.subscription.updated':
        case 'customer.subscription.deleted':
          return syncSubscription(object, at, event.type);
        case 'invoice.paid':
        case 'invoice.payment_failed':
          return invoiceEvent(object, event);
      }
    }

    /** Claim an event id. False when it was processed already (or is being processed now). */
    async function claimEvent(event, lockId) {
      const now = Date.now();
      const record = { type: event.type, status: 'processing', lockId, lockedUntil: new Date(now + 5 * 60_000), expiresAt: new Date(now + Math.max(1, options.keepEventsDays) * 86_400_000) };
      try {
        await StripeEvent.create({ _id: event.id, ...record });
        return true;
      } catch (err) {
        if (err?.code !== 11000) throw err;
      }
      // A lock left by a crashed process: take it over, or the event would be lost.
      const taken = await StripeEvent.findOneAndUpdate({ _id: event.id, status: 'processing', lockedUntil: { $lte: new Date(now) } }, { $set: record }).lean();
      return Boolean(taken);
    }

    // ---- API ----------------------------------------------------------------------------
    const tags = ['billing'];
    const policy = options.policy;
    const me = (ctx) => {
      if (!ctx.user) throw unauthorized();
      return ctx.user;
    };
    const redirectField = f.string().max(2048);

    calm.routes(
      (r) => {
        r.get('/prices', { policy: 'public', summary: 'The prices on sale (ids and plans) for a pricing page', tags }, () =>
          [...prices.values()].map((p) => ({ price: p.id, plan: p.plan, mode: p.mode })),
        );

        r.get('/', { policy, summary: 'My billing status: plan, subscription status, period end', tags }, async (ctx) => {
          const user = me(ctx);
          const [customer, subs, bought] = await Promise.all([
            Customer.exists({ user: user.id }),
            Subscription.find({ user: user.id }).sort({ updatedAt: -1 }).lean(),
            Purchase.find({ user: user.id }).sort({ paidAt: -1 }).lean(),
          ]);
          // The subscription to show: the newest one still alive, else the newest one.
          const main = subs.find((s) => !TERMINAL.has(s.status)) ?? subs[0] ?? null;
          const activePlans = [...new Set([...subs.filter((s) => activeStatuses.has(s.status)), ...bought].map((d) => d.plan).filter(Boolean))];
          return {
            customer: Boolean(customer),
            plan: main && activeStatuses.has(main.status) ? main.plan : (activePlans[0] ?? null),
            plans: activePlans,
            status: main?.status ?? null,
            priceId: main?.priceId ?? null,
            currentPeriodEnd: main?.currentPeriodEnd ?? null,
            cancelAtPeriodEnd: Boolean(main?.cancelAtPeriodEnd),
            trialEnd: main?.trialEnd ?? null,
            subscriptions: subs.map(subscriptionView),
            purchases: bought.map(purchaseView),
          };
        });

        r.post(
          '/checkout',
          {
            policy,
            status: 201,
            summary: 'Start a Stripe Checkout for one of the listed prices; redirect the browser to the returned url',
            input: { price: f.string().max(255), plan: f.string().max(100), successUrl: redirectField, cancelUrl: redirectField },
            rateLimit: { windowMs: 60_000, max: 20 }, // each call creates objects at Stripe
            tags,
          },
          async (ctx) => {
            const user = me(ctx);
            const price = pickPrice(ctx.body);
            const problems = {};
            for (const key of ['successUrl', 'cancelUrl']) {
              const issue = ctx.body[key] ? redirectProblem(ctx.body[key]) : null;
              if (issue) problems[key] = issue;
            }
            if (Object.keys(problems).length) throw validationError(problems);
            if (!calm.env('STRIPE_SECRET_KEY')) throw notConfigured();

            if (price.mode === 'subscription' && options.oneSubscription && (await Subscription.exists({ user: user.id, status: { $in: [...LIVE] } }))) {
              throw new CalmError(409, 'ALREADY_SUBSCRIBED', 'You already have a subscription. Change or cancel it in the billing portal (POST /api/billing/portal).');
            }

            const metadata = { userId: user.id, plan: price.plan, priceId: price.id };
            const params = {
              mode: price.mode,
              customer: null,
              client_reference_id: user.id,
              line_items: [{ price: price.id, quantity: 1 }],
              success_url: ctx.body.successUrl ?? defaults.successUrl,
              cancel_url: ctx.body.cancelUrl ?? defaults.cancelUrl,
              metadata,
            };
            if (options.allowPromotionCodes) params.allow_promotion_codes = true;
            if (price.mode === 'subscription') {
              params.subscription_data = { metadata, ...(options.trialDays > 0 ? { trial_period_days: options.trialDays } : {}) };
            } else {
              params.payment_intent_data = { metadata };
            }
            try {
              params.customer = await ensureCustomer(user);
              // A fresh key per click: it makes a retried network call safe, without
              // replaying an old session to a later, separate click.
              const session = await stripe.request('POST', '/checkout/sessions', { params, idempotencyKey: `calm-checkout-${randomUUID()}` });
              return { id: session.id, url: session.url };
            } catch (err) {
              throw err instanceof CalmError ? err : providerError(err, 'creating a checkout session');
            }
          },
        );

        r.post(
          '/portal',
          {
            policy,
            summary: 'Open the Stripe customer portal (change plan, card, cancel); redirect the browser to the returned url',
            input: { returnUrl: redirectField },
            rateLimit: { windowMs: 60_000, max: 20 },
            tags,
          },
          async (ctx) => {
            const user = me(ctx);
            if (ctx.body.returnUrl) {
              const issue = redirectProblem(ctx.body.returnUrl);
              if (issue) throw validationError({ returnUrl: issue });
            }
            if (!calm.env('STRIPE_SECRET_KEY')) throw notConfigured();
            const customer = await Customer.findOne({ user: user.id }).lean();
            if (!customer) throw notFound('No billing account yet: start a checkout first');
            try {
              const session = await stripe.request('POST', '/billing_portal/sessions', {
                params: { customer: customer.customerId, return_url: ctx.body.returnUrl ?? defaults.returnUrl },
                idempotencyKey: `calm-portal-${randomUUID()}`,
              });
              return { url: session.url };
            } catch (err) {
              throw providerError(err, 'creating a portal session');
            }
          },
        );

        r.post(
          '/webhook',
          { policy: 'public', rawBody: true, summary: 'Stripe webhook endpoint (signed with STRIPE_WEBHOOK_SECRET)', tags },
          async (ctx) => {
            const secret = calm.env('STRIPE_WEBHOOK_SECRET');
            if (!secret) {
              calm.log.error('payments-stripe: a webhook arrived but STRIPE_WEBHOOK_SECRET is not set');
              throw notConfigured();
            }
            let event;
            try {
              // The raw bytes, never ctx.body: the signature covers the exact payload.
              event = verifyStripeSignature(ctx.rawBody, ctx.req.get('stripe-signature'), secret, { toleranceSeconds: options.toleranceSeconds });
            } catch (err) {
              if (!(err instanceof StripeSignatureError)) throw err;
              calm.events.emit('security.webhook_rejected', { block: 'payments-stripe', ip: ctx.req.ip, reason: err.message });
              throw new CalmError(400, 'INVALID_SIGNATURE', err.message);
            }
            if (typeof event?.id !== 'string' || !/^evt_\w+$/.test(event.id) || typeof event.type !== 'string') {
              throw new CalmError(400, 'INVALID_EVENT', 'Not a Stripe event');
            }
            if (!HANDLED.has(event.type)) return { received: true, ignored: true }; // 200, or Stripe retries it for days
            if (liveKey() && event.livemode === false) {
              calm.log.warn('payments-stripe: test mode event sent to a live mode app, ignored', { event: event.id, type: event.type });
              return { received: true, ignored: true };
            }

            const lockId = randomUUID();
            if (!(await claimEvent(event, lockId))) return { received: true, duplicate: true };
            try {
              await handle(event);
            } catch (err) {
              // Drop the claim and answer 500: Stripe delivers the event again later.
              await StripeEvent.deleteOne({ _id: event.id, lockId }).catch(() => {});
              throw err instanceof StripeError ? providerError(err, `processing ${event.type}`) : err;
            }
            await StripeEvent.updateOne({ _id: event.id, lockId }, { $set: { status: 'done', processedAt: new Date() }, $unset: { lockedUntil: '', lockId: '' } });
            return { received: true };
          },
        );
      },
      { prefix: '/billing' },
    );

    // ---- plan checks ----------------------------------------------------------------------
    // Routes: meta: { plan: 'pro' } (or ['pro', 'team']) answers 402 PLAN_REQUIRED without it.
    calm.guard(async (ctx, route) => {
      const wanted = route.meta?.plan;
      if (!wanted) return;
      if (!ctx.user) throw unauthorized();
      if (!(await hasPlan(ctx.user.id, wanted))) {
        throw new CalmError(402, 'PLAN_REQUIRED', `This needs the ${[].concat(wanted).join(' or ')} plan`, { plan: [].concat(wanted).join(', ') });
      }
    }, { order: 10 });

    // Named policies 'plan-pro', 'plan-team'... usable as strings in resources and routes.
    for (const plan of plans) {
      if (/^[a-z][\w-]*$/i.test(`plan-${plan}`)) calm.policy(`plan-${plan}`, (ctx) => Boolean(ctx.user) && hasPlan(ctx.user.id, plan));
    }

    const api = { Customer, Subscription, Purchase, StripeEvent, stripe, prices, plansOf, hasPlan, ensureCustomer, requirePlan };
    current = api;
    calm.provide('billing', api);

    // ---- doctor ---------------------------------------------------------------------------
    calm.doctor(() => {
      const findings = [];
      const key = calm.env('STRIPE_SECRET_KEY', '');
      const production = mode === 'production';
      if (!calm.app.auth) findings.push({ level: 'error', id: 'billing-auth', title: 'The payments-stripe block needs auth', detail: 'Customers and subscriptions belong to users: keep config.auth enabled and the user resource in place.' });
      if (!prices.size) findings.push({ level: 'warn', id: 'billing-prices', title: 'payments-stripe: no prices are on sale', detail: "List them in calm.config.js: blocks: { 'payments-stripe': { prices: { price_123: 'pro' } } }" });
      if (key && /^pk_/.test(key)) findings.push({ level: 'error', id: 'billing-publishable-key', title: 'STRIPE_SECRET_KEY holds a publishable key (pk_...)', detail: 'Use the secret key (sk_...) or a restricted key (rk_...). Publishable keys belong in the frontend only.' });
      else if (key && !/^(sk|rk)_(live|test)_/.test(key)) findings.push({ level: 'warn', id: 'billing-key-format', title: 'STRIPE_SECRET_KEY does not look like a Stripe secret key', detail: 'Expected sk_live_..., sk_test_... or a restricted rk_... key.' });
      if (production && /^(sk|rk)_test_/.test(key)) findings.push({ level: 'error', id: 'billing-test-key', title: 'Stripe test key in production', detail: 'STRIPE_SECRET_KEY is a test mode key: nobody is charged. Use the live key (sk_live_...) in production.' });
      if (!production && /^(sk|rk)_live_/.test(key)) findings.push({ level: 'warn', id: 'billing-live-key', title: `Stripe live key in ${mode}`, detail: 'Real cards are charged from this environment. Use a test key (sk_test_...) outside production.' });
      if (key && !calm.env('STRIPE_WEBHOOK_SECRET')) findings.push({ level: production ? 'error' : 'warn', id: 'billing-webhook-secret', title: 'STRIPE_WEBHOOK_SECRET is not set', detail: 'Webhooks are refused, so subscriptions never sync. Locally: `stripe listen --forward-to localhost:5001/api/billing/webhook` prints one.' });
      if (production) {
        for (const o of origins) if (o.startsWith('http:')) findings.push({ level: 'warn', id: 'billing-http-redirect', title: `payments-stripe redirects to ${o} over plain http`, detail: 'Use https origins in allowedRedirects and APP_URL in production.' });
      }
      return findings;
    });

    calm.onStart(() => Promise.all([Customer.init(), Subscription.init(), Purchase.init(), StripeEvent.init()]));
    calm.onShutdown(() => {
      if (current === api) current = null;
    });
  },
});
