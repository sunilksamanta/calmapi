import { definePlugin } from '#calm';

// Post messages to Slack from app events, with an incoming webhook (SLACK_WEBHOOK_URL) or a
// bot token and a channel (chat.postMessage).
//
//  - Never in the request path: messages are sent in the background, retried with backoff,
//    and a 429 waits for Retry-After as Slack asks.
//  - Templates ('New signup: {user.name}') escape every value, so data from users cannot
//    mention @channel, ping people or hide links (<!channel>, <@U123>, <https://x|y>).
//  - security.* events are posted as alerts, a few per window; the rest of a burst (a
//    brute-force attack) is summed up in one digest message at the end of the window.

const UNITS = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };

/** 5000, '5s', '2m' -> milliseconds. */
function toMs(value, name) {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)$/.exec(String(value).trim());
  if (!m) throw new Error(`slack: ${name} must be milliseconds or a duration like '30s' or '5m' (got ${JSON.stringify(value)})`);
  return Number(m[1]) * UNITS[m[2]];
}

/**
 * Escape text for Slack: &, < and > are the only control characters of mrkdwn links and
 * mentions (https://api.slack.com/reference/surfaces/formatting#escaping).
 */
export const escape = (value) => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const valueAt = (data, path) => path.split('.').reduce((v, key) => (v === null || v === undefined ? undefined : v[key]), data);

function show(value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if (value._bsontype === 'ObjectId') return String(value);
    return JSON.stringify(value).slice(0, 300);
  }
  return String(value).slice(0, 1000);
}

/**
 * 'New signup: {user.email}' -> 'New signup: ann@example.com'. The template is yours and is
 * used as written (it may hold <!here> on purpose); the values come from data and are escaped.
 */
export const render = (template, data) => String(template).replace(/\{([\w.$-]+)\}/g, (_, path) => escape(show(valueAt(data, path))));

export class SlackError extends Error {
  constructor(message, { status = null, code = null, retryAfterMs = null } = {}) {
    super(message);
    this.name = 'SlackError';
    this.status = status;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const SECURITY_FIELDS = ['email', 'userId', 'ip', 'path', 'method', 'reason', 'limiter', 'until', 'keyId', 'prefix'];

export default definePlugin({
  name: 'slack',
  env: {
    SLACK_WEBHOOK_URL: { secret: true, description: 'Incoming webhook URL (Slack app settings, Incoming Webhooks)' },
    SLACK_BOT_TOKEN: { secret: true, description: 'Bot token for chat.postMessage, with the chat:write scope (used when SLACK_WEBHOOK_URL is not set)' },
    SLACK_CHANNEL: 'Channel ID for chat.postMessage, for example C0123456789',
  },
  // Override in calm.config.js: blocks: { slack: { events: { 'order.created': 'New order {doc.number}' } } }
  options: {
    // Event -> template string, or (payload, name) => string | { text, blocks } | null.
    // false removes a default. Placeholders read the event payload: {user.name}, {doc.title}.
    events: { 'auth.registered': 'New signup: {user.name}' },
    security: {
      enabled: true,
      events: ['security.*'],
      ignore: ['security.forbidden', 'security.invalid_token'], // everyday noise
      window: '1m', // alerts are counted per window
      maxPerWindow: 3, // sent one by one; the rest of the window becomes one digest
      prefix: ':rotating_light:',
    },
    retries: 3, // after the first attempt
    backoff: ['1s', '5s', '30s'], // waits between attempts (429 uses Retry-After instead)
    maxRetryAfter: '2m', // a longer Retry-After gives up instead of waiting
    timeoutMs: 10_000,
    apiBase: 'https://slack.com/api',
    channel: null, // default: SLACK_CHANNEL
  },
  setup(calm, options) {
    const webhookUrl = calm.env('SLACK_WEBHOOK_URL');
    const botToken = calm.env('SLACK_BOT_TOKEN');
    const channel = options.channel || calm.env('SLACK_CHANNEL');
    const api = String(options.apiBase).replace(/\/$/, '');
    const backoff = (options.backoff ?? []).map((v, i) => toMs(v, `backoff[${i}]`));
    const maxRetryAfterMs = toMs(options.maxRetryAfter, 'maxRetryAfter');
    const mode = webhookUrl ? 'webhook' : botToken && channel ? 'bot' : null;
    const stats = { sent: 0, failed: 0, retried: 0, digested: 0 };

    calm.doctor(() => {
      const findings = [];
      if (!mode && calm.config.mode === 'production') {
        findings.push({ level: 'error', id: 'slack-config', title: 'Slack is not configured', detail: 'Set SLACK_WEBHOOK_URL, or SLACK_BOT_TOKEN and SLACK_CHANNEL. Messages are only logged until then.' });
      }
      if (botToken && !webhookUrl && !channel) findings.push({ level: 'error', id: 'slack-channel', title: 'SLACK_CHANNEL is not set', detail: 'chat.postMessage needs a channel ID next to SLACK_BOT_TOKEN.' });
      if (webhookUrl && !/^https:\/\/hooks\.slack\.com\//.test(webhookUrl) && calm.config.mode === 'production') {
        findings.push({ level: 'warn', id: 'slack-webhook-host', title: 'SLACK_WEBHOOK_URL is not a hooks.slack.com URL', detail: 'Messages (security alerts included) would go to another host.' });
      }
      return findings;
    });

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

    /** One HTTP attempt. Throws a SlackError (retryAfterMs set on 429). */
    async function attempt(message) {
      // link_names off and parse none: plain "@channel" in text stays plain text.
      const payload = { text: message.text, ...(message.blocks ? { blocks: message.blocks } : {}), unfurl_links: false, unfurl_media: false, link_names: false, parse: 'none' };
      const url = mode === 'webhook' ? webhookUrl : `${api}/chat.postMessage`;
      const headers = { 'content-type': 'application/json; charset=utf-8' };
      if (mode === 'bot') {
        headers.authorization = `Bearer ${botToken}`;
        payload.channel = message.channel || channel;
      }
      let res;
      try {
        res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(payload), signal: AbortSignal.timeout(options.timeoutMs) });
      } catch (err) {
        throw new SlackError(`Slack could not be reached: ${err.message}`);
      }
      const text = await res.text().catch(() => '');
      if (res.status === 429) {
        const seconds = Number(res.headers.get('retry-after'));
        throw new SlackError('Slack rate limited the message (429)', { status: 429, retryAfterMs: Number.isFinite(seconds) ? seconds * 1000 : 30_000 });
      }
      if (!res.ok) throw new SlackError(`Slack answered HTTP ${res.status}: ${text.slice(0, 200)}`, { status: res.status, code: text.slice(0, 100) });
      if (mode === 'bot') {
        // The Web API answers 200 with { ok: false, error } for most problems.
        let body = null;
        try {
          body = JSON.parse(text);
        } catch {
          // not JSON: treated as an error below
        }
        if (!body?.ok) throw new SlackError(`chat.postMessage failed: ${body?.error ?? 'unexpected answer'}`, { status: res.status, code: body?.error ?? null });
        return { ts: body.ts ?? null, channel: body.channel ?? payload.channel };
      }
      return { ok: true };
    }

    // Errors not worth retrying: a wrong token, a removed webhook, an unknown channel.
    const permanent = (err) => [400, 401, 403, 404, 410].includes(err.status) || ['invalid_auth', 'not_authed', 'channel_not_found', 'not_in_channel', 'is_archived', 'account_inactive', 'token_revoked', 'invalid_blocks', 'msg_too_long', 'no_text'].includes(err.code);

    async function deliver(message) {
      for (let i = 0; ; i++) {
        try {
          const out = await attempt(message);
          stats.sent += 1;
          return out;
        } catch (err) {
          if (i >= options.retries || permanent(err)) {
            stats.failed += 1;
            throw err;
          }
          const delay = err.retryAfterMs ?? backoff[Math.min(i, backoff.length - 1)] ?? 1000;
          if (delay > maxRetryAfterMs) {
            stats.failed += 1;
            throw err;
          }
          stats.retried += 1;
          await wait(delay);
        }
      }
    }

    const normalize = (input) => {
      if (typeof input === 'string') return { text: input };
      if (Array.isArray(input)) return { text: 'New message', blocks: input };
      if (input && typeof input === 'object' && (input.text || input.blocks)) return { text: input.text ?? 'New message', blocks: input.blocks, channel: input.channel };
      throw new Error('slack.send(text | blocks | { text, blocks, channel })');
    };

    /** Send now and wait for Slack (scripts, jobs). Throws a SlackError on failure. */
    async function send(input) {
      const message = normalize(input);
      if (!mode) {
        // Like the mail dev transport: visible in the logs, never sent.
        calm.log.info(`Slack (not configured): ${message.text}`);
        return { skipped: true };
      }
      return deliver(message);
    }

    /** Send in the background: never blocks or fails the caller. */
    function post(input) {
      calm.app.background(async () => {
        try {
          await send(input);
        } catch (err) {
          calm.log.warn(`slack: message not delivered: ${err.message}`);
        }
      });
    }

    calm.provide('slack', { send, post, escape, render, stats, get transport() { return mode ?? 'log'; } });

    // ---- app events -> messages ------------------------------------------------------------
    for (const [event, template] of Object.entries(options.events ?? {})) {
      if (template === false || template === null || template === undefined) continue;
      if (typeof template !== 'string' && typeof template !== 'function') throw new Error(`slack: events['${event}'] must be a template string or a function`);
      calm.on(event, async (payload, name) => {
        const out = typeof template === 'function' ? await template(payload, name, { escape, render }) : render(template, payload ?? {});
        if (out) post(out);
      });
    }

    // ---- security alerts, with a digest for bursts -----------------------------------------
    const sec = { ...options.security };
    if (sec.enabled !== false) {
      const windowMs = toMs(sec.window ?? '1m', 'security.window');
      const ignore = new Set(sec.ignore ?? []);
      let current = null; // { started, sent, suppressed: Map<name, count>, ips: Set, timer }

      const describe = (name, payload) => {
        const details = SECURITY_FIELDS.filter((k) => payload?.[k] !== undefined && payload[k] !== null).map((k) => `${k}: ${escape(show(payload[k]))}`);
        return `${sec.prefix ?? ''} *${escape(name)}*${details.length ? `\n${details.join(' | ')}` : ''}`.trim();
      };

      function flush() {
        const w = current;
        current = null;
        if (!w) return;
        clearTimeout(w.timer);
        const total = [...w.suppressed.values()].reduce((a, b) => a + b, 0);
        if (!total) return;
        stats.digested += total;
        const counts = [...w.suppressed.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${escape(n)} x${c}`).join(', ');
        const seconds = Math.round((Date.now() - w.started) / 1000);
        const ips = w.ips.size ? ` from ${w.ips.size} IP${w.ips.size === 1 ? '' : 's'}` : '';
        post(`${sec.prefix ?? ''} Security digest: ${total} more event${total === 1 ? '' : 's'} in ${seconds}s${ips}: ${counts}`.trim());
      }

      const security = (payload, name) => {
        if (ignore.has(name)) return;
        if (!current) current = { started: Date.now(), sent: 0, suppressed: new Map(), ips: new Set(), timer: setTimeout(flush, windowMs) };
        current.timer.unref?.();
        if (current.sent < sec.maxPerWindow) {
          current.sent += 1;
          post(describe(name, payload));
          return;
        }
        current.suppressed.set(name, (current.suppressed.get(name) ?? 0) + 1);
        if (payload?.ip) current.ips.add(String(payload.ip));
      };
      for (const pattern of sec.events ?? ['security.*']) calm.on(pattern, security);
      calm.onShutdown(flush);
    }

    calm.devtools.panel('slack', () => ({ transport: mode ?? 'log only (not configured)', channel: mode === 'bot' ? channel : null, events: Object.keys(options.events ?? {}).filter((k) => options.events[k]), stats: { ...stats } }));
  },
});
