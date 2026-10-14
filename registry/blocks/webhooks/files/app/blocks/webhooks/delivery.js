import http from 'node:http';
import https from 'node:https';
import { hostname } from 'node:os';
import { randomInt, randomUUID } from 'node:crypto';
import { sign } from './signing.js';
import { urlProblem, guardedLookup } from './ssrf.js';

// The delivery queue lives in MongoDB (calm_webhook_deliveries). Workers claim one
// delivery at a time with findOneAndUpdate, so any number of instances can send without
// sending twice. A delivery is 'pending' (due now or waiting for a retry), 'sending',
// 'succeeded' or 'failed' (every retry used, 410 Gone, or endpoint disabled).

const RESPONSE_LOG_CHARS = 1024; // what the delivery log keeps of the receiver's answer
const RESPONSE_READ_LIMIT = 64 * 1024; // stop downloading huge answers nobody will read
const ATTEMPT_LOG_SIZE = 20;

/** Parse Retry-After (seconds or an HTTP date) into milliseconds. */
function retryAfterMs(value) {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now());
}

/** A short, user-facing reason for a network error. */
function describe(err, timeoutMs) {
  if (err?.name === 'AbortError' || err?.name === 'TimeoutError' || err?.code === 'ABORT_ERR') return `No answer within ${timeoutMs / 1000}s`;
  if (err?.code === 'ESSRF') return err.message;
  if (err?.code === 'ECONNREFUSED') return 'Connection refused';
  if (err?.code === 'ENOTFOUND' || err?.code === 'EAI_AGAIN') return 'Host not found';
  if (err?.code === 'ECONNRESET') return 'Connection reset by the receiver';
  return [err?.code, err?.message].filter(Boolean).join(': ') || 'Request failed';
}

/**
 * POST a body and resolve with { statusCode, response, retryAfter, durationMs } or
 * { error, durationMs }. Never rejects. Uses node:http(s) rather than fetch so that the
 * connection goes to the address guardedLookup checked; redirects are never followed.
 */
function post(url, { headers, body, timeoutMs, lookup, agents }) {
  const started = performance.now();
  return new Promise((resolve) => {
    let settled = false;
    let response = null;
    const chunks = [];
    let size = 0;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, durationMs: Math.round(performance.now() - started) });
    };
    const answered = () =>
      done({ statusCode: response.statusCode, retryAfter: response.headers['retry-after'], response: Buffer.concat(chunks).toString('utf8').slice(0, RESPONSE_LOG_CHARS) });

    let req;
    try {
      const target = new URL(url);
      req = (target.protocol === 'https:' ? https : http).request(
        target,
        {
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
          lookup,
          agent: agents[target.protocol],
          signal: AbortSignal.timeout(timeoutMs),
        },
        (res) => {
          response = res;
          res.on('data', (chunk) => {
            if (size < RESPONSE_LOG_CHARS) chunks.push(chunk);
            size += chunk.length;
            if (size > RESPONSE_READ_LIMIT) res.destroy();
          });
          res.on('end', answered);
          res.on('close', answered);
          res.on('error', () => {}); // 'close' follows and reports the status we already have
        },
      );
    } catch (err) {
      return done({ error: describe(err, timeoutMs) });
    }
    // An error after the status line arrived (timeout while reading the body) still has an answer.
    req.on('error', (err) => (response ? answered() : done({ error: describe(err, timeoutMs) })));
    req.end(body);
  });
}

export function createDeliveries({ app, Webhook, Delivery, settings, open, onDisable }) {
  const { schedule, timeoutMs, pollMs, concurrency } = settings;
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const lookup = guardedLookup({ allowPrivate: settings.url.allowPrivate });
  // Own agents: sockets are only ever opened through guardedLookup, and keep-alive
  // connections are reused between deliveries to the same receiver.
  const agents = { 'http:': new http.Agent({ keepAlive: true, maxSockets: 50 }), 'https:': new https.Agent({ keepAlive: true, maxSockets: 50 }) };

  let timer = null;
  let stopping = false;
  let ticking = false;
  let again = false;
  let running = 0;
  let ticks = 0;
  const inflight = new Set();

  const keepUntil = () => new Date(Date.now() + settings.keepMs);
  const unlock = { lockedAt: 1, lockedBy: 1 };

  /** How long to wait before the next attempt, or null when every retry is used. */
  function retryDelay(attempts, retryAfter) {
    if (attempts > schedule.length) return null;
    // Jitter (+-20%) so a receiver that was down is not hit by every retry at the same moment.
    const delay = Math.round(schedule[attempts - 1] * (0.8 + randomInt(401) / 1000));
    const asked = retryAfterMs(retryAfter);
    return asked ? Math.max(delay, Math.min(asked, schedule.at(-1))) : delay;
  }

  async function send(endpoint, delivery) {
    // Checked again on every attempt: the URL may predate a stricter configuration.
    const problem = await urlProblem(endpoint.url, { ...settings.url, resolve: false });
    if (problem) return { error: `Refused: ${problem}`, durationMs: 0 };
    const body = open(delivery.body);
    const timestamp = Math.floor(Date.now() / 1000);
    // During a rotation the old secret signs too, so receivers can switch without downtime.
    const secrets = [open(endpoint.secret)];
    if (endpoint.previousSecret && endpoint.previousSecretExpiresAt > new Date()) secrets.push(open(endpoint.previousSecret));
    const headers = {
      'content-type': 'application/json',
      'user-agent': settings.userAgent,
      'webhook-id': delivery.messageId,
      'webhook-timestamp': String(timestamp),
      'webhook-signature': secrets.map((s) => sign(s, delivery.messageId, timestamp, body)).join(' '),
    };
    return post(endpoint.url, { headers, body, timeoutMs, lookup, agents });
  }

  async function record(delivery, endpoint, result) {
    const now = new Date();
    const ok = result.statusCode >= 200 && result.statusCode < 300;
    const error = ok ? null : (result.error ?? `HTTP ${result.statusCode}`);
    const statusCode = result.statusCode ?? null;
    const attempt = { at: now, statusCode, durationMs: result.durationMs, error };
    const last = { lastAttemptAt: now, lastStatusCode: statusCode, lastDurationMs: result.durationMs, lastError: error, lastResponse: result.response ?? null };
    const log = { log: { $each: [attempt], $slice: -ATTEMPT_LOG_SIZE } };

    if (ok) {
      await Delivery.updateOne({ _id: delivery._id }, { $set: { ...last, status: 'succeeded', deliveredAt: now, nextAttemptAt: null, expiresAt: keepUntil() }, $unset: unlock, $push: log });
      await Webhook.updateOne({ _id: endpoint._id }, { $set: { lastSuccessAt: now, lastStatusCode: statusCode, lastError: null, failedAttempts: 0, failedDeliveries: 0, failingSince: null } });
      return;
    }

    // 410 Gone: the receiver asks us to stop (Standard Webhooks). Anything else is retried.
    const gone = statusCode === 410;
    const wait = gone ? null : retryDelay(delivery.attempts, result.retryAfter);
    const next = wait === null ? { status: 'failed', nextAttemptAt: null, expiresAt: keepUntil() } : { status: 'pending', nextAttemptAt: new Date(now.getTime() + wait) };
    await Delivery.updateOne({ _id: delivery._id }, { $set: { ...last, ...next }, $unset: unlock, $push: log });
    await Webhook.updateOne({ _id: endpoint._id }, { $set: { lastFailureAt: now, lastStatusCode: statusCode, lastError: error }, $inc: { failedAttempts: 1 } });
    await Webhook.updateOne({ _id: endpoint._id, failingSince: null }, { $set: { failingSince: now } });

    if (gone) return onDisable(endpoint._id, 'gone');
    if (wait !== null) return;
    const updated = await Webhook.findOneAndUpdate({ _id: endpoint._id }, { $inc: { failedDeliveries: 1 } }, { returnDocument: 'after' }).lean();
    if (settings.disableAfterFailures > 0 && updated?.failedDeliveries >= settings.disableAfterFailures) await onDisable(endpoint._id, 'failing');
  }

  async function execute(delivery) {
    const endpoint = await Webhook.findById(delivery.webhook).select('+secret +previousSecret').lean();
    if (!endpoint) return Delivery.deleteOne({ _id: delivery._id });
    if (!endpoint.enabled) {
      return Delivery.updateOne(
        { _id: delivery._id },
        { $set: { status: 'failed', lastError: 'Endpoint is disabled', nextAttemptAt: null, expiresAt: keepUntil() }, $unset: unlock },
      );
    }
    await record(delivery, endpoint, await send(endpoint, delivery));
  }

  /** Execute one claimed delivery; a bug or a database error must not leave it stuck in 'sending'. */
  async function run(delivery) {
    try {
      await execute(delivery);
    } catch (err) {
      app.log.error('webhooks: delivery attempt crashed', { err, delivery: String(delivery._id) });
      const wait = retryDelay(delivery.attempts);
      await Delivery.updateOne(
        { _id: delivery._id },
        {
          $set: wait === null
            ? { status: 'failed', lastError: 'Internal error', nextAttemptAt: null, expiresAt: keepUntil() }
            : { status: 'pending', lastError: 'Internal error', nextAttemptAt: new Date(Date.now() + wait) },
          $unset: unlock,
        },
      ).catch(() => {});
    }
  }

  const claim = () =>
    Delivery.findOneAndUpdate(
      { status: 'pending', nextAttemptAt: { $lte: new Date() } },
      { $set: { status: 'sending', lockedAt: new Date(), lockedBy: workerId }, $inc: { attempts: 1 } },
      { sort: { nextAttemptAt: 1 }, returnDocument: 'after' },
    ).lean();

  async function fill() {
    if (++ticks % 60 === 0) {
      // Put back deliveries whose worker died mid-send (crash, kill -9, deploy).
      await Delivery.updateMany(
        { status: 'sending', lockedAt: { $lt: new Date(Date.now() - timeoutMs - 60_000) } },
        { $set: { status: 'pending', nextAttemptAt: new Date() }, $unset: unlock },
      );
    }
    while (!stopping && running < concurrency) {
      const delivery = await claim();
      if (!delivery) break;
      running++;
      const p = run(delivery).finally(() => {
        running--;
        inflight.delete(p);
        kick(); // a slot is free: take the next due delivery without waiting for the poll
      });
      inflight.add(p);
    }
  }

  async function tick() {
    if (ticking) {
      again = true;
      return;
    }
    ticking = true;
    try {
      do {
        again = false;
        await fill();
      } while (again && !stopping);
    } finally {
      ticking = false;
    }
  }

  const safeTick = () => tick().catch((err) => app.log.error('webhooks: worker tick failed', { err }));

  /** Look for due deliveries now instead of at the next poll. */
  function kick() {
    if (timer && !stopping) setImmediate(safeTick);
  }

  /** Mark a delivery as being sent by this process, send it now and return it updated. */
  async function sendNow(delivery) {
    await run(delivery);
    return Delivery.findById(delivery._id).lean();
  }

  return {
    workerId,
    get running() {
      return Boolean(timer);
    },

    /** Queue deliveries ({ webhook, type, messageId, body }) for the worker. */
    async enqueue(rows) {
      await Delivery.insertMany(rows.map((row) => ({ ...row, status: 'pending', nextAttemptAt: new Date(), expiresAt: keepUntil() })));
      kick();
    },

    /** Create a delivery and send it right away, in this request (test events). */
    async deliverNow(row) {
      const delivery = await Delivery.create({ ...row, status: 'sending', attempts: 1, lockedAt: new Date(), lockedBy: workerId, nextAttemptAt: null, expiresAt: keepUntil() });
      return sendNow(delivery.toObject());
    },

    /**
     * Send an existing delivery again now, with a fresh retry schedule. Same webhook-id, so
     * receivers that already processed it can skip it. Null when it is being sent right now.
     */
    async retryNow(webhookId, deliveryId) {
      const delivery = await Delivery.findOneAndUpdate(
        { _id: deliveryId, webhook: webhookId, status: { $ne: 'sending' } },
        { $set: { status: 'sending', attempts: 1, lockedAt: new Date(), lockedBy: workerId, nextAttemptAt: null, expiresAt: keepUntil() } },
        { returnDocument: 'after' },
      ).lean();
      return delivery ? sendNow(delivery) : null;
    },

    /** Deliver everything that is due now, one by one (tests and scripts). */
    async drain() {
      for (let i = 0; i < 1000; i++) {
        const delivery = await claim();
        if (!delivery) break;
        await run(delivery);
      }
      await Promise.all([...inflight]);
    },

    start() {
      stopping = false;
      timer = setInterval(safeTick, pollMs);
      timer.unref();
      app.log.info(`Webhooks worker started (every ${pollMs}ms, ${concurrency} at a time)`);
      kick();
    },

    async stop() {
      stopping = true;
      clearInterval(timer);
      timer = null;
      // In-flight requests end within timeoutMs; never hold shutdown longer than that.
      await Promise.race([Promise.all([...inflight]), new Promise((resolve) => setTimeout(resolve, timeoutMs + 1000).unref())]);
      agents['http:'].destroy();
      agents['https:'].destroy();
    },
  };
}
