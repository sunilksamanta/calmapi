import { definePlugin, f, serialize, CalmError, badRequest, unauthorized, forbidden, notFound, conflict, validationError } from '#calm';
import { evaluatePolicy, parsePolicy } from '#calm/resource/policy.js';
import { isEncrypted } from '#calm/security/encryption.js';
import { newSecret, newMessageId, verifyWebhook } from './signing.js';
import { urlProblem } from './ssrf.js';
import { canRead, inScope } from './visibility.js';
import { createDeliveries } from './delivery.js';

// Outgoing webhooks. Users subscribe a URL to resource events ('order.created', 'order.*')
// and receive every change they are allowed to read, serialized exactly like the API would
// return it to them. Admins can subscribe with scope 'global' to receive every record.
//
//  - Signed with Standard Webhooks headers; receivers check them with verifyWebhook().
//  - Queued in MongoDB, retried with backoff, logged per endpoint (calm_webhook_deliveries).
//  - SSRF protection: only public addresses, checked when saved and on every delivery.
//  - Signing secrets and queued payloads are encrypted at rest when CALM_ENCRYPTION_KEYS is set.

export { verifyWebhook, WebhookVerificationError } from './signing.js';

const ACTIONS = ['created', 'updated', 'deleted', 'restored'];
const RESOURCE_EVENT = /^([\w-]+)\.(created|updated|deleted|restored)$/;
const EVENT_PATTERN = /^([a-z][\w-]*)\.(\*|[a-z]+)$/;
const OBJECT_ID = /^[a-f\d]{24}$/i;
const DELIVERY_STATUSES = ['pending', 'sending', 'succeeded', 'failed'];
const PAYLOAD_PREVIEW_CHARS = 2048;
const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** 5000, '5s', '2m', '6h' -> milliseconds. */
function toMs(value, name) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(String(value).trim());
  if (!m) throw new Error(`webhooks: ${name} must be milliseconds or a duration like '30s', '5m', '2h' (got ${JSON.stringify(value)})`);
  return Number(m[1]) * UNITS[m[2]];
}

const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return String(url);
  }
};

export default definePlugin({
  name: 'webhooks',
  env: {
    WEBHOOKS_WORKER: 'Set to "off" on instances that should not send webhooks (default on)',
  },
  // Override in calm.config.js: blocks: { webhooks: { maxEndpointsPerUser: 5 } }
  options: {
    policy: 'authenticated', // who may create and manage their own endpoints
    globalPolicy: 'admin', // who may create scope: 'global' endpoints (every record, admin view)
    allowPrivate: null, // call localhost and private networks? null: only in development and test
    requireHttps: null, // refuse http:// URLs? null: only in production
    maxEndpointsPerUser: 10,
    maxEventsPerEndpoint: 20,
    maxUrlLength: 2048,
    retrySchedule: ['5s', '30s', '2m', '10m', '30m', '2h', '6h'], // waits between attempts, then failed
    timeoutMs: 10_000,
    pollMs: 1000,
    concurrency: 10, // deliveries in flight per instance
    disableAfterFailures: 5, // deliveries in a row that failed every retry (0: never disable)
    keepDeliveriesDays: 14, // delivery log retention (TTL index)
    secretGraceHours: 24, // after a rotation the old secret also signs for this long
    notifyOwner: true, // email the owner when an endpoint is turned off automatically
  },
  setup(calm, options) {
    const { mode } = calm.config;
    if (!Array.isArray(options.retrySchedule)) throw new Error('webhooks: retrySchedule must be an array, e.g. [\'5s\', \'1m\']');
    const settings = {
      schedule: options.retrySchedule.map((v, i) => toMs(v, `retrySchedule[${i}]`)),
      timeoutMs: toMs(options.timeoutMs, 'timeoutMs'),
      pollMs: Math.max(10, toMs(options.pollMs, 'pollMs')), // 0 would be a busy loop
      concurrency: Math.max(1, Math.floor(Number(options.concurrency) || 1)),
      disableAfterFailures: Math.max(0, Number(options.disableAfterFailures) || 0),
      keepMs: Math.max(1, Number(options.keepDeliveriesDays) || 14) * UNITS.d,
      graceMs: Math.max(0, Number(options.secretGraceHours) || 0) * UNITS.h,
      url: {
        allowPrivate: options.allowPrivate ?? mode !== 'production',
        requireHttps: options.requireHttps ?? mode === 'production',
        maxLength: options.maxUrlLength,
      },
      userAgent: 'CalmAPI-Webhooks/1.0 (+https://www.standardwebhooks.com)',
    };
    const globalPolicy = parsePolicy(options.globalPolicy);
    const workerOn = calm.env('WEBHOOKS_WORKER', 'on') !== 'off';

    // Secrets must be readable again to sign, so they are encrypted (not hashed) at rest.
    // Payloads too: they can contain fields the resource stores .encrypted().
    const cipher = calm.app.cipher;
    const seal = (text) => (cipher ? cipher.encrypt(text) : text);
    const open = (stored) => {
      if (cipher) return cipher.decrypt(stored);
      if (isEncrypted(stored)) throw new Error('webhooks: data is encrypted but CALM_ENCRYPTION_KEYS is not set');
      return stored;
    };

    // ---- storage ---------------------------------------------------------------------
    const { Schema } = calm.mongoose;
    const webhookSchema = new Schema(
      {
        owner: { type: Schema.Types.ObjectId, ref: 'user', required: true },
        scope: { type: String, enum: ['own', 'global'], default: 'own' },
        url: { type: String, required: true },
        events: { type: [String], default: [] },
        description: String,
        secret: { type: String, select: false },
        previousSecret: { type: String, select: false },
        previousSecretExpiresAt: Date,
        enabled: { type: Boolean, default: true },
        disabledReason: { type: String, enum: ['gone', 'failing', 'manual'] },
        disabledAt: Date,
        failingSince: Date, // first failed attempt since the last success
        failedAttempts: { type: Number, default: 0 }, // attempts in a row
        failedDeliveries: { type: Number, default: 0 }, // deliveries in a row that used every retry
        lastSuccessAt: Date,
        lastFailureAt: Date,
        lastStatusCode: Number,
        lastError: String,
      },
      { collection: 'calm_webhooks', timestamps: true, versionKey: false },
    );
    webhookSchema.index({ owner: 1, _id: -1 });
    webhookSchema.index({ enabled: 1, events: 1 });
    const Webhook = calm.mongoose.model('calmWebhook', webhookSchema);

    const deliverySchema = new Schema(
      {
        webhook: { type: Schema.Types.ObjectId, required: true },
        type: { type: String, required: true },
        messageId: { type: String, required: true }, // webhook-id header, the same on every attempt
        body: { type: String, required: true }, // the exact JSON that is signed and sent
        status: { type: String, enum: DELIVERY_STATUSES, default: 'pending' },
        attempts: { type: Number, default: 0 },
        nextAttemptAt: Date,
        lockedAt: Date,
        lockedBy: String,
        lastAttemptAt: Date,
        lastStatusCode: Number,
        lastDurationMs: Number,
        lastError: String,
        lastResponse: String, // first 1 KB of the receiver's answer
        log: [{ _id: false, at: Date, statusCode: Number, durationMs: Number, error: String }],
        deliveredAt: Date,
        expiresAt: Date,
      },
      { collection: 'calm_webhook_deliveries', timestamps: true, versionKey: false },
    );
    deliverySchema.index({ status: 1, nextAttemptAt: 1 });
    deliverySchema.index({ webhook: 1, _id: -1 });
    // A date per document (not createdAt + N days) so changing keepDeliveriesDays never
    // conflicts with an existing index.
    deliverySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Delivery = calm.mongoose.model('calmWebhookDelivery', deliverySchema);

    const deliveries = createDeliveries({ app: calm.app, Webhook, Delivery, settings, open, onDisable: disable });

    // ---- views (never include secrets) ------------------------------------------------
    const view = (w) => ({
      id: String(w._id),
      url: w.url,
      events: w.events,
      description: w.description ?? null,
      scope: w.scope,
      enabled: w.enabled,
      status: !w.enabled ? 'disabled' : w.failingSince ? 'failing' : 'active',
      disabledReason: w.disabledReason ?? null,
      disabledAt: w.disabledAt ?? null,
      failingSince: w.failingSince ?? null,
      failedAttempts: w.failedAttempts ?? 0,
      lastSuccessAt: w.lastSuccessAt ?? null,
      lastFailureAt: w.lastFailureAt ?? null,
      lastStatusCode: w.lastStatusCode ?? null,
      lastError: w.lastError ?? null,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
    });

    function preview(stored) {
      let text;
      try {
        text = open(stored);
      } catch {
        return { payload: null, payloadTruncated: false };
      }
      return text.length > PAYLOAD_PREVIEW_CHARS
        ? { payload: `${text.slice(0, PAYLOAD_PREVIEW_CHARS)}...`, payloadTruncated: true }
        : { payload: text, payloadTruncated: false };
    }

    const deliveryView = (d) => ({
      id: String(d._id),
      type: d.type,
      messageId: d.messageId,
      status: d.status,
      attempts: d.attempts,
      statusCode: d.lastStatusCode ?? null,
      durationMs: d.lastDurationMs ?? null,
      error: d.lastError ?? null,
      nextAttemptAt: d.status === 'pending' ? (d.nextAttemptAt ?? null) : null,
      lastAttemptAt: d.lastAttemptAt ?? null,
      deliveredAt: d.deliveredAt ?? null,
      response: d.lastResponse ?? null,
      ...preview(d.body),
      attemptLog: (d.log ?? []).map((a) => ({ at: a.at, statusCode: a.statusCode ?? null, durationMs: a.durationMs ?? null, error: a.error ?? null })),
      createdAt: d.createdAt,
    });

    // ---- rules --------------------------------------------------------------------------
    const mayGoGlobal = async (user) => {
      const decision = await evaluatePolicy(globalPolicy, { user, action: 'read' });
      return decision.allow && !decision.scope;
    };

    /** Why this list of event names cannot be used, or null. */
    async function eventsProblem(events, user, scope) {
      const followable = [...calm.app.registry.values()].filter((e) => e.def.options.webhooks !== false).map((e) => e.def.name);
      for (const event of events) {
        if (event === '*') continue;
        const m = EVENT_PATTERN.exec(event);
        if (!m) return `"${event}" is not an event name. Use "post.created", "post.*" or "*"`;
        const entry = calm.app.registry.get(m[1]);
        if (!entry || !followable.includes(m[1])) return `Unknown resource "${m[1]}". Webhooks can follow: ${followable.join(', ') || 'no resources'}`;
        if (m[2] !== '*' && !ACTIONS.includes(m[2])) return `Unknown event "${event}". Use ${ACTIONS.map((a) => `${m[1]}.${a}`).join(', ')} or ${m[1]}.*`;
        if (scope === 'own') {
          // Early feedback only: every delivery is checked again against the record itself.
          const read = await evaluatePolicy(entry.def.policy.read, { user, action: 'read' }).catch(() => ({ allow: true }));
          if (!read.allow) return `You cannot read ${m[1]} records, so "${event}" would never be delivered`;
        }
      }
      return null;
    }

    const me = (ctx) => {
      if (!ctx.user) throw unauthorized();
      return ctx.user;
    };

    async function findOwn(ctx, select) {
      const user = me(ctx);
      const id = String(ctx.params.id);
      if (!OBJECT_ID.test(id)) throw notFound('Webhook not found');
      const query = Webhook.findOne({ _id: id, owner: user.id });
      if (select) query.select(select);
      const w = await query.lean();
      if (!w) throw notFound('Webhook not found');
      return w;
    }

    const disabledError = () => badRequest('This endpoint is disabled. Turn it back on first: PATCH { "enabled": true }');

    // ---- turning endpoints off ----------------------------------------------------------
    const REASONS = {
      gone: 'it answered 410 Gone',
      failing: `${settings.disableAfterFailures} deliveries in a row failed after every retry`,
      manual: 'it was turned off',
    };

    async function disable(id, reason) {
      const endpoint = await Webhook.findOneAndUpdate(
        { _id: id, enabled: true },
        { $set: { enabled: false, disabledReason: reason, disabledAt: new Date() } },
        { returnDocument: 'after' },
      ).lean();
      if (!endpoint) return; // already off: report it once
      await Delivery.updateMany({ webhook: endpoint._id, status: 'pending' }, { $set: { status: 'failed', lastError: 'Endpoint was disabled', nextAttemptAt: null } });
      calm.events.emit('webhook.disabled', { webhook: view(endpoint), owner: String(endpoint.owner), reason });
      if (reason === 'manual') return;
      calm.log.warn(`webhooks: endpoint ${endpoint._id} turned off because ${REASONS[reason]}`, { host: hostOf(endpoint.url) });
      if (options.notifyOwner) await notifyOwner(endpoint, reason);
      refreshStats().catch(() => {});
    }

    // Standard Webhooks advises telling the owner through another channel.
    async function notifyOwner(endpoint, reason) {
      try {
        if (!calm.app.services.has('user')) return;
        const owner = await calm.app.model('user').findById(endpoint.owner).lean();
        if (!owner?.email) return;
        const api = `${calm.config.app.url.replace(/\/$/, '')}${calm.config.apiPrefix}/webhooks/${endpoint._id}`;
        await calm.mailer.send({
          to: owner.email,
          subject: `Webhook turned off: ${hostOf(endpoint.url)}`,
          text: [
            `Hello${owner.name ? ` ${owner.name}` : ''},`,
            '',
            `We stopped sending webhooks to ${endpoint.url} because ${REASONS[reason]}.`,
            '',
            `See what went wrong: GET ${api}/deliveries`,
            `When the receiver works again, turn it back on: PATCH ${api} with { "enabled": true }`,
          ].join('\n'),
          meta: { block: 'webhooks', webhook: String(endpoint._id), reason },
        });
      } catch (err) {
        calm.log.warn('webhooks: could not email the endpoint owner', { err: err.message });
      }
    }

    // ---- events -> deliveries -------------------------------------------------------------
    /** Endpoint owners as req.user would look; disabled and deleted users are left out. */
    async function loadOwners(ids) {
      if (!calm.app.services.has('user')) return new Map();
      const users = await calm.app.model('user').find({ _id: { $in: ids } }).lean();
      return new Map(users.filter((u) => u.status !== 'disabled').map((u) => [String(u._id), { ...u, id: String(u._id) }]));
    }

    /** The JSON body for one subscriber, or null when they may not see this record. */
    async function bodyFor(entry, doc, user, scope, event) {
      if (!user) return null;
      try {
        // Global: every record, whatever its read policy, but still inside the owner's scope().
        const allowed = scope === 'global'
          ? (await mayGoGlobal(user)) && (await inScope(entry, doc, user, { deleted: event.deleted }))
          : await canRead(entry, doc, user, { deleted: event.deleted });
        if (!allowed) return null;
        // Serialized for this user: hidden fields never, visibleTo() fields only if they may.
        const data = await serialize(entry.def, doc, { user, registry: calm.app.registry });
        return JSON.stringify({ type: event.type, timestamp: event.timestamp, data });
      } catch (err) {
        calm.log.warn(`webhooks: ${event.type} not sent to one subscriber, the visibility check failed`, { err: err.message });
        return null;
      }
    }

    async function dispatch(entry, type, doc) {
      const endpoints = await Webhook.find({ enabled: true, events: { $in: ['*', `${entry.def.name}.*`, type] } }).lean();
      if (!endpoints.length) return;
      const owners = await loadOwners(endpoints.map((w) => w.owner));
      // One message id per event: receivers subscribed twice can still recognise it.
      const event = { type, timestamp: new Date().toISOString(), messageId: newMessageId(), deleted: type.endsWith('.deleted') };
      const bodies = new Map();
      const rows = [];
      for (const w of endpoints) {
        const key = `${w.owner}:${w.scope}`;
        if (!bodies.has(key)) bodies.set(key, await bodyFor(entry, doc, owners.get(String(w.owner)), w.scope, event));
        const body = bodies.get(key);
        if (body) rows.push({ webhook: w._id, type, messageId: event.messageId, body: seal(body) });
      }
      if (rows.length) await deliveries.enqueue(rows);
    }

    calm.on('*', async (payload, name) => {
      const m = RESOURCE_EVENT.exec(name);
      if (!m || !payload?.doc) return;
      const entry = calm.app.registry.get(m[1]);
      if (!entry || entry.def.options.webhooks === false) return;
      await dispatch(entry, name, payload.doc);
    });

    // A deleted user's endpoints and logs go with them.
    calm.on('user.deleted', async ({ doc }) => {
      const ids = (await Webhook.find({ owner: doc._id }).select('_id').lean()).map((w) => w._id);
      if (!ids.length) return;
      await Delivery.deleteMany({ webhook: { $in: ids } });
      await Webhook.deleteMany({ _id: { $in: ids } });
    });

    // ---- API --------------------------------------------------------------------------------
    const tags = ['webhooks'];
    const policy = options.policy;
    const urlField = f.url().max(settings.url.maxLength);
    const eventsField = f
      .array(f.string().max(100))
      .min(1, 'Pick at least one event')
      .max(options.maxEventsPerEndpoint, `At most ${options.maxEventsPerEndpoint} events per endpoint`);
    const descriptionField = f.string().max(200);
    const manualRateLimit = { windowMs: 60_000, max: 10 }; // these routes make the server send requests

    calm.routes(
      (r) => {
        r.post(
          '/',
          {
            policy,
            status: 201,
            summary: 'Create a webhook endpoint (the response shows its signing secret, once)',
            input: { url: urlField.required(), events: eventsField.required(), description: descriptionField, scope: f.enum(['own', 'global']) },
            tags,
          },
          async (ctx) => {
            const user = me(ctx);
            const { url, description, scope = 'own' } = ctx.body;
            const events = [...new Set(ctx.body.events)];
            if (scope === 'global' && !(await mayGoGlobal(user))) throw forbidden('Only admins can create global webhooks');
            const count = await Webhook.countDocuments({ owner: user.id });
            if (count >= options.maxEndpointsPerUser) {
              throw new CalmError(409, 'LIMIT_REACHED', `You already have ${count} webhook endpoints, the most allowed. Delete one first.`);
            }
            const problems = {};
            const urlIssue = await urlProblem(url, settings.url);
            if (urlIssue) problems.url = urlIssue;
            const eventIssue = await eventsProblem(events, user, scope);
            if (eventIssue) problems.events = eventIssue;
            if (Object.keys(problems).length) throw validationError(problems);

            const secret = newSecret();
            const w = await Webhook.create({ owner: user.id, scope, url, events, description: description ?? undefined, secret: seal(secret) });
            return { ...view(w.toObject()), secret };
          },
        );

        r.get('/', { policy, summary: 'Your webhook endpoints', tags }, async (ctx) =>
          (await Webhook.find({ owner: me(ctx).id }).sort({ _id: -1 }).lean()).map(view),
        );

        r.get('/:id', { policy, summary: 'One of your webhook endpoints', tags }, async (ctx) => view(await findOwn(ctx)));

        r.patch(
          '/:id',
          {
            policy,
            summary: 'Change the URL, events or description, or turn an endpoint on or off',
            input: { url: urlField, events: eventsField, description: descriptionField, enabled: f.boolean() },
            tags,
          },
          async (ctx) => {
            const w = await findOwn(ctx);
            const body = ctx.body;
            const problems = {};
            if (body.url === null) problems.url = 'Is required';
            else if (body.url !== undefined) problems.url = await urlProblem(body.url, settings.url);
            if (body.events === null) problems.events = 'Is required';
            else if (body.events !== undefined) problems.events = await eventsProblem(body.events, ctx.user, w.scope);
            for (const key of Object.keys(problems)) if (!problems[key]) delete problems[key];
            if (Object.keys(problems).length) throw validationError(problems);

            const $set = {};
            const $unset = {};
            if (body.url !== undefined) $set.url = body.url;
            if (body.events !== undefined) $set.events = [...new Set(body.events)];
            if (body.description === null) $unset.description = 1;
            else if (body.description !== undefined) $set.description = body.description;
            if (body.enabled === true && !w.enabled) {
              Object.assign($set, { enabled: true, failedAttempts: 0, failedDeliveries: 0, failingSince: null });
              Object.assign($unset, { disabledReason: 1, disabledAt: 1 });
            }
            const update = {};
            if (Object.keys($set).length) update.$set = $set;
            if (Object.keys($unset).length) update.$unset = $unset;
            if (Object.keys(update).length) await Webhook.updateOne({ _id: w._id }, update);
            if (body.enabled === false && w.enabled) await disable(w._id, 'manual');
            return view(await Webhook.findById(w._id).lean());
          },
        );

        r.delete('/:id', { policy, summary: 'Delete a webhook endpoint and its delivery log', tags }, async (ctx) => {
          const w = await findOwn(ctx);
          await Webhook.deleteOne({ _id: w._id });
          await Delivery.deleteMany({ webhook: w._id });
        });

        r.post(
          '/:id/rotate-secret',
          { policy, summary: 'New signing secret (shown once); the old one keeps signing during the grace period', tags },
          async (ctx) => {
            const w = await findOwn(ctx, '+secret');
            const secret = newSecret();
            const update = { $set: { secret: seal(secret) } };
            if (settings.graceMs > 0) Object.assign(update.$set, { previousSecret: w.secret, previousSecretExpiresAt: new Date(Date.now() + settings.graceMs) });
            else update.$unset = { previousSecret: 1, previousSecretExpiresAt: 1 };
            const updated = await Webhook.findOneAndUpdate({ _id: w._id }, update, { returnDocument: 'after' }).lean();
            return { ...view(updated), secret, previousSecretExpiresAt: updated.previousSecretExpiresAt ?? null };
          },
        );

        r.post(
          '/:id/test',
          { policy, summary: 'Send a webhook.test event now and return the delivery', rateLimit: manualRateLimit, tags },
          async (ctx) => {
            const w = await findOwn(ctx);
            if (!w.enabled) throw disabledError();
            const body = JSON.stringify({
              type: 'webhook.test',
              timestamp: new Date().toISOString(),
              data: { webhook: String(w._id), message: `Test event from ${calm.config.app.name}` },
            });
            return deliveryView(await deliveries.deliverNow({ webhook: w._id, type: 'webhook.test', messageId: newMessageId(), body: seal(body) }));
          },
        );

        r.get('/:id/deliveries', { policy, summary: 'Recent deliveries: status code, duration, attempts, error, next retry', tags }, async (ctx) => {
          const w = await findOwn(ctx);
          const filter = { webhook: w._id };
          if (DELIVERY_STATUSES.includes(ctx.query.status)) filter.status = ctx.query.status;
          const limit = Math.min(Math.max(Math.floor(Number(ctx.query.limit)) || 50, 1), 100);
          return (await Delivery.find(filter).sort({ _id: -1 }).limit(limit).lean()).map(deliveryView);
        });

        r.post(
          '/:id/deliveries/:deliveryId/retry',
          { policy, summary: 'Send a delivery again now (same webhook-id, fresh retry schedule)', rateLimit: manualRateLimit, tags },
          async (ctx) => {
            const w = await findOwn(ctx);
            if (!w.enabled) throw disabledError();
            const deliveryId = String(ctx.params.deliveryId);
            if (!OBJECT_ID.test(deliveryId)) throw notFound('Delivery not found');
            const delivery = await deliveries.retryNow(w._id, deliveryId);
            if (delivery) return deliveryView(delivery);
            throw (await Delivery.exists({ _id: deliveryId, webhook: w._id })) ? conflict('This delivery is being sent right now') : notFound('Delivery not found');
          },
        );
      },
      { prefix: '/webhooks' },
    );

    // ---- health: doctor, devtools ---------------------------------------------------------------
    // Doctor checks are synchronous, so they read numbers refreshed in the background.
    let stats = null;
    async function refreshStats() {
      const failingFilter = { enabled: true, failingSince: { $ne: null } };
      const [total, enabled, failingCount, failing, autoDisabled] = await Promise.all([
        Webhook.countDocuments(),
        Webhook.countDocuments({ enabled: true }),
        Webhook.countDocuments(failingFilter),
        Webhook.find(failingFilter).sort({ failingSince: 1 }).limit(3).lean(),
        Webhook.countDocuments({ enabled: false, disabledReason: { $in: ['gone', 'failing'] } }),
      ]);
      stats = { total, enabled, failingCount, failing, autoDisabled };
      return stats;
    }

    calm.doctor(() => {
      const findings = [];
      const production = mode === 'production';
      if (!calm.app.auth) {
        findings.push({ level: 'error', id: 'webhooks-auth', title: 'The webhooks block needs auth', detail: 'Endpoints belong to users: keep config.auth enabled and the user resource in place.' });
      }
      if (production && settings.url.allowPrivate) {
        findings.push({ level: 'warn', id: 'webhooks-allow-private', title: 'Webhooks may call private addresses', detail: 'blocks.webhooks.allowPrivate is on in production: users can make this server call localhost, internal services and cloud metadata (SSRF). Remove it.' });
      }
      if (production && !cipher) {
        findings.push({ level: 'warn', id: 'webhooks-plaintext', title: 'Webhook secrets are stored unencrypted', detail: 'Set CALM_ENCRYPTION_KEYS (npx calm keygen --write) so signing secrets and queued payloads are encrypted at rest.' });
      }
      if (!workerOn) {
        findings.push({ level: 'info', id: 'webhooks-worker-off', title: 'Webhooks worker is off on this instance', detail: 'WEBHOOKS_WORKER=off: make sure another instance runs with it on, or nothing is delivered.' });
      }
      if (stats) {
        findings.push({
          level: 'info',
          id: 'webhooks-endpoints',
          title: `${stats.total} webhook endpoint${stats.total === 1 ? '' : 's'}, ${stats.enabled} enabled`,
          detail: stats.autoDisabled ? `${stats.autoDisabled} turned off automatically (410 Gone or failing). Owners turn them back on with PATCH /api/webhooks/:id.` : 'Users manage them at /api/webhooks.',
        });
        if (stats.failingCount) {
          const list = stats.failing.map((w) => `${hostOf(w.url)} since ${new Date(w.failingSince).toISOString()} (${w.lastError ?? 'error'})`).join('; ');
          findings.push({
            level: 'warn',
            id: 'webhooks-failing',
            title: `${stats.failingCount} webhook endpoint${stats.failingCount === 1 ? ' is' : 's are'} failing`,
            detail: `${list}. Deliveries are retried; see GET /api/webhooks/:id/deliveries.`,
          });
        }
      }
      return findings;
    });

    calm.devtools.panel('webhooks', async () => {
      const [endpoints, recent, pending] = await Promise.all([
        Webhook.find().sort({ _id: -1 }).limit(50).lean(),
        Delivery.find().sort({ _id: -1 }).limit(25).lean(),
        Delivery.countDocuments({ status: 'pending' }),
      ]);
      return {
        worker: deliveries.running ? deliveries.workerId : 'off',
        pending,
        endpoints: endpoints.map((w) => ({
          id: String(w._id),
          owner: String(w.owner),
          scope: w.scope,
          url: w.url,
          events: w.events.join(', '),
          status: view(w).status,
          failedAttempts: w.failedAttempts ?? 0,
          lastSuccessAt: w.lastSuccessAt ?? null,
          lastError: w.lastError ?? null,
        })),
        deliveries: recent.map((d) => ({
          id: String(d._id),
          webhook: String(d.webhook),
          type: d.type,
          status: d.status,
          attempts: d.attempts,
          statusCode: d.lastStatusCode ?? null,
          durationMs: d.lastDurationMs ?? null,
          error: d.lastError ?? null,
          nextAttemptAt: d.status === 'pending' ? d.nextAttemptAt : null,
          createdAt: d.createdAt,
        })),
      };
    });

    calm.provide('webhooks', { Webhook, Delivery, drain: deliveries.drain, refreshStats, verifyWebhook });

    // ---- lifecycle ------------------------------------------------------------------------------
    let statsTimer = null;
    calm.onStart(async () => {
      await Promise.all([Webhook.init(), Delivery.init()]);
      if (workerOn) deliveries.start();
      await refreshStats().catch((err) => calm.log.warn('webhooks: could not read endpoint stats', { err: err.message }));
      statsTimer = setInterval(() => refreshStats().catch(() => {}), 60_000);
      statsTimer.unref();
    });
    calm.onShutdown(async () => {
      clearInterval(statsTimer);
      await deliveries.stop();
    });
  },
});
