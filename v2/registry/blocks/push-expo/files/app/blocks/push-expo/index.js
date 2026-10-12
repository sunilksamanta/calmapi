import { gzipSync } from 'node:zlib';
import { definePlugin, providerPayloads } from '#calm';

// Sends app.push notifications to Expo push tokens through the Expo push service, following
// https://docs.expo.dev/push-notifications/sending-notifications/ and what Expo's own Node SDK
// (expo-server-sdk-node) does: up to 100 messages per request, at most 6 requests at a time,
// 600 notifications a second, gzip above 1 KB, exponential backoff on 429 and 5xx answers,
// and push receipts checked later.
//
// It only takes Expo push tokens, so it works next to push-fcm: Expo tokens go through Expo,
// native FCM tokens through FCM, from the same ctx.push.send() call.
const SEND_BATCH = 100; // PUSH_TOO_MANY_NOTIFICATIONS above this
const RECEIPT_BATCH = 300; // the SDK's chunk size; PUSH_TOO_MANY_RECEIPTS above 1000
const CONCURRENCY = 6;
const PER_SECOND = 600; // TOO_MANY_REQUESTS above this, per project
const RECEIPT_TTL = 24 * 60 * 60_000; // Expo clears receipts after 24 hours

/** ExponentPushToken[...] or ExpoPushToken[...] (or the bare UUID form), as the Expo SDK checks it. */
export const isExpoPushToken = (token) =>
  typeof token === 'string' &&
  (((token.startsWith('ExponentPushToken[') || token.startsWith('ExpoPushToken[')) && token.endsWith(']')) ||
    /^[a-z\d]{8}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{4}-[a-z\d]{12}$/i.test(token));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Run fn over items with at most `limit` in flight. */
async function pool(items, limit, fn) {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

const HINTS = {
  UNAUTHORIZED: 'Enhanced push security is on for this Expo project: set EXPO_ACCESS_TOKEN to an Expo access token.',
  TOO_MANY_REQUESTS: 'More than 600 notifications a second for this project.',
  InvalidCredentials: 'The push credentials of the app are invalid. Android: upload the FCM V1 service account key in EAS. iOS: run `eas credentials`.',
  MismatchSenderId: 'The FCM credentials in EAS and google-services.json belong to different Firebase projects.',
  MessageTooBig: 'The payload is over 4096 bytes.',
  MessageRateExceeded: 'Too many notifications to this device. Send less often.',
};

export default definePlugin({
  name: 'push-expo',
  setup(calm) {
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    const api = (process.env.EXPO_API_URL || 'https://exp.host/--/api/v2').replace(/\/$/, '');
    const testing = calm.config.mode === 'test';
    calm.doctor(() =>
      !accessToken && calm.config.mode === 'production'
        ? [{ level: 'warn', id: 'expo-access-token', title: 'EXPO_ACCESS_TOKEN is not set', detail: 'Anyone who learns a device token can send it notifications. Turn on enhanced push security for your Expo project (expo.dev, Access tokens) and set EXPO_ACCESS_TOKEN.' }]
        : [],
    );

    // Tests capture notifications in t.pushes instead of calling Expo (unless EXPO_API_URL
    // points at a fake). Development delivers to real Expo tokens, so you can test on a phone.
    if (testing && !process.env.EXPO_API_URL) return;

    // Receipts are ready about 15 minutes after sending (Expo's advice). In development, look
    // sooner so the receipt shows up in devtools while you are still looking.
    const receiptDelay = calm.config.mode === 'production' ? 15 * 60_000 : 60_000;
    const checkEvery = calm.config.mode === 'production' ? 5 * 60_000 : 30_000;
    const retryBase = testing ? 10 : 1000;

    const Ticket = calm.mongoose.model(
      'calmExpoTicket',
      new calm.mongoose.Schema(
        { ticket: { type: String, required: true }, device: { type: String, required: true }, push: String, sentAt: { type: Date, default: Date.now, index: true } },
        { collection: 'calm_expo_tickets', versionKey: false },
      ),
    );

    // 600 notifications a second: wait when the last second is full.
    const sent = []; // [time, count]
    async function throttle(count) {
      for (;;) {
        const now = Date.now();
        while (sent.length && sent[0][0] <= now - 1000) sent.shift();
        const inWindow = sent.reduce((n, [, c]) => n + c, 0);
        if (inWindow + count <= PER_SECOND || !sent.length) break;
        await sleep(sent[0][0] + 1000 - now);
      }
      sent.push([Date.now(), count]);
    }

    /** POST to the Expo API. Retries network errors, 429 and 5xx with exponential backoff. */
    async function request(path, body, attempt = 0) {
      const json = JSON.stringify(body);
      const headers = { accept: 'application/json', 'accept-encoding': 'gzip, deflate', 'content-type': 'application/json', 'user-agent': 'calmapi-push-expo' };
      if (accessToken) headers.authorization = `Bearer ${accessToken}`;
      const compress = json.length > 1024;
      if (compress) headers['content-encoding'] = 'gzip';
      let res;
      try {
        res = await fetch(`${api}${path}`, { method: 'POST', headers, body: compress ? gzipSync(json) : json, signal: AbortSignal.timeout(20_000) });
      } catch (err) {
        if (attempt < 2) return sleep(retryBase * 2 ** attempt).then(() => request(path, body, attempt + 1));
        throw new Error(`Cannot reach Expo: ${err.cause?.code ?? err.message}`, { cause: err });
      }
      if ((res.status === 429 || res.status >= 500) && attempt < 2) {
        await sleep(retryBase * 2 ** attempt);
        return request(path, body, attempt + 1);
      }
      const answer = await res.json().catch(() => null);
      if (answer?.errors?.length || !res.ok) {
        const e = answer?.errors?.[0] ?? {};
        const err = new Error(`Expo: ${[e.code, e.message].filter(Boolean).join(': ') || `HTTP ${res.status}`}${HINTS[e.code] ? ` ${HINTS[e.code]}` : ''}`);
        err.code = e.code;
        err.details = e.details;
        throw err;
      }
      return answer.data;
    }

    /** Send one batch; tokens of several Expo projects in one batch are split and sent per project. */
    async function sendBatch(batch, message) {
      await throttle(batch.length);
      try {
        const tickets = await request('/push/send', batch.map(({ device }) => providerPayloads(message, device.token).expo.payload));
        if (!Array.isArray(tickets) || tickets.length !== batch.length) throw new Error(`Expo answered with ${tickets?.length ?? 0} tickets for ${batch.length} messages`);
        return tickets;
      } catch (err) {
        if (err.code === 'PUSH_TOO_MANY_EXPERIENCE_IDS' && err.details && typeof err.details === 'object') {
          const byProject = Object.values(err.details).map((tokens) => batch.filter(({ device }) => [tokens].flat().includes(device.token)));
          const placed = new Set(byProject.flat());
          const rest = batch.filter((item) => !placed.has(item));
          const answers = new Map();
          for (const group of [...byProject, rest].filter((g) => g.length)) {
            const tickets = await sendBatch(group, message).catch((e) => group.map(() => ({ status: 'error', message: e.message })));
            group.forEach((item, n) => answers.set(item, tickets[n]));
          }
          return batch.map((item) => answers.get(item));
        }
        return batch.map(() => ({ status: 'error', message: err.message }));
      }
    }

    calm.push.use({
      name: 'expo',
      accepts: (device) => isExpoPushToken(device.token),
      async send(message, devices, { id: pushId } = {}) {
        const results = devices.map((d) => (isExpoPushToken(d.token) ? null : { ok: false, error: 'Not an Expo push token (expected ExponentPushToken[...])' }));
        const items = devices.map((device, index) => ({ device, index })).filter(({ index }) => !results[index]);
        const batches = [];
        for (let i = 0; i < items.length; i += SEND_BATCH) batches.push(items.slice(i, i + SEND_BATCH));
        const tickets = [];
        await pool(batches, CONCURRENCY, async (batch) => {
          const answers = await sendBatch(batch, message);
          batch.forEach(({ device, index }, n) => {
            const ticket = answers[n] ?? {};
            if (ticket.status === 'ok') {
              results[index] = { ok: true, id: ticket.id };
              if (ticket.id && device.id) tickets.push({ ticket: ticket.id, device: device.id, push: pushId });
            } else {
              const code = ticket.details?.error;
              results[index] = { ok: false, error: [code, ticket.message].filter(Boolean).join(': ') || 'Expo returned no ticket', unregistered: code === 'DeviceNotRegistered' };
            }
          });
        });
        if (tickets.length) await Ticket.insertMany(tickets).catch((err) => calm.log.warn('push-expo: could not store tickets for the receipt check', { err }));
        return results;
      },
    });

    /**
     * Read the receipts of tickets older than `olderThan` ms. A receipt says whether Expo handed
     * the notification to Apple or Google; DeviceNotRegistered removes the device.
     */
    async function checkReceipts({ olderThan = receiptDelay } = {}) {
      const summary = { checked: 0, ok: 0, failed: 0, removed: 0, expired: 0 };
      const expired = await Ticket.deleteMany({ sentAt: { $lt: new Date(Date.now() - RECEIPT_TTL) } });
      summary.expired = expired.deletedCount ?? 0;
      if (summary.expired) calm.log.warn(`push-expo: ${summary.expired} ticket(s) never got a receipt within 24 hours; Expo may have had a problem delivering them`);
      const due = await Ticket.find({ sentAt: { $lte: new Date(Date.now() - olderThan) } }).sort({ sentAt: 1 }).limit(RECEIPT_BATCH * 10).lean();
      const chunks = [];
      for (let i = 0; i < due.length; i += RECEIPT_BATCH) chunks.push(due.slice(i, i + RECEIPT_BATCH));
      await pool(chunks, CONCURRENCY, async (chunk) => {
        let receipts;
        try {
          receipts = await request('/push/getReceipts', { ids: chunk.map((t) => t.ticket) });
        } catch (err) {
          calm.log.warn(`push-expo: receipt check failed: ${err.message}`);
          return;
        }
        const done = [];
        for (const t of chunk) {
          const r = receipts?.[t.ticket];
          if (!r) continue; // not ready yet: asked again next time
          done.push(t._id);
          summary.checked += 1;
          if (r.status === 'ok') {
            summary.ok += 1;
            await calm.push.receipt(t.push, t.device, { ok: true, transport: 'expo' });
            continue;
          }
          summary.failed += 1;
          const code = r.details?.error;
          const unregistered = code === 'DeviceNotRegistered';
          if (unregistered) summary.removed += 1;
          const error = [code, r.message].filter(Boolean).join(': ') + (HINTS[code] && !unregistered ? ` ${HINTS[code]}` : '');
          await calm.push.receipt(t.push, t.device, { ok: false, error, unregistered, transport: 'expo' });
          if (!unregistered) calm.log[code === 'InvalidCredentials' || code === 'MismatchSenderId' ? 'error' : 'warn'](`push-expo: Apple or Google refused a notification: ${error}`, { ticket: t.ticket, device: t.device });
        }
        if (done.length) await Ticket.deleteMany({ _id: { $in: done } });
      });
      if (summary.removed) calm.log.info(`push-expo: removed ${summary.removed} device(s) whose app was uninstalled (DeviceNotRegistered receipt)`);
      return summary;
    }
    calm.provide('pushExpo', { checkReceipts });

    let timer = null;
    calm.onStart(() => {
      if (testing) return; // tests call checkReceipts() themselves
      timer = setInterval(() => checkReceipts().catch((err) => calm.log.warn('push-expo: receipt check failed', { err })), checkEvery);
      timer.unref?.();
    });
    calm.onShutdown(() => clearInterval(timer));
  },
});
