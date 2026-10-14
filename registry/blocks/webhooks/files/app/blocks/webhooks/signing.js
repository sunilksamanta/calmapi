import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Signatures as the Standard Webhooks spec defines them (https://www.standardwebhooks.com):
//
//   webhook-id:        msg_...   same value on every retry, receivers use it to skip duplicates
//   webhook-timestamp: 1674087231   unix seconds of this attempt (replay protection)
//   webhook-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">   space separated list
//
// Secrets look like whsec_<base64>; the HMAC key is the decoded bytes. Any Standard Webhooks
// library (npm: standardwebhooks, Svix, ...) can verify what this block sends.
//
// This file has no imports besides node:crypto: copy it into the app that receives the
// webhooks and call verifyWebhook() there.

const PREFIX = 'whsec_';
const DEFAULT_TOLERANCE_SECONDS = 5 * 60; // what the reference libraries accept

/** A new signing secret: 32 random bytes (the spec asks for 24 to 64). */
export const newSecret = () => `${PREFIX}${randomBytes(32).toString('base64')}`;

/** A message id. It goes into the signed content, so it must never contain a '.'. */
export const newMessageId = () => `msg_${randomBytes(16).toString('base64url')}`;

function keyOf(secret) {
  if (typeof secret !== 'string' || !secret) throw new WebhookVerificationError('The webhook secret is missing');
  const key = Buffer.from(secret.startsWith(PREFIX) ? secret.slice(PREFIX.length) : secret, 'base64');
  if (!key.length) throw new WebhookVerificationError('The webhook secret is not valid base64');
  return key;
}

/** The value of one signature: "v1,<base64>". body is the exact string (or Buffer) that is sent. */
export function sign(secret, id, timestamp, body) {
  const hmac = createHmac('sha256', keyOf(secret)).update(`${id}.${timestamp}.`).update(body);
  return `v1,${hmac.digest('base64')}`;
}

export class WebhookVerificationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WebhookVerificationError';
  }
}

/** Read a header from a plain object (any case), Node's req.headers or a fetch Headers. */
function header(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === 'function') return headers.get(name) ?? undefined;
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  const value = key === undefined ? undefined : headers[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Check that a webhook really comes from the sender and is recent. Returns the parsed
 * payload ({ type, timestamp, data }) or throws WebhookVerificationError.
 *
 *   app.post('/hooks', express.raw({ type: 'application/json' }), (req, res) => {
 *     const event = verifyWebhook(process.env.WEBHOOK_SECRET, req.headers, req.body);
 *     res.sendStatus(204);
 *   });
 *
 * `body` must be the raw request body (string or Buffer): parsing the JSON and
 * serializing it again changes the bytes, and the signature no longer matches.
 */
export function verifyWebhook(secret, headers, body, { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = {}) {
  const id = header(headers, 'webhook-id');
  const timestamp = header(headers, 'webhook-timestamp');
  const signatures = header(headers, 'webhook-signature');
  if (!id || !timestamp || !signatures) throw new WebhookVerificationError('Missing webhook-id, webhook-timestamp or webhook-signature header');
  if (typeof body !== 'string' && !(body instanceof Uint8Array)) {
    throw new WebhookVerificationError('Pass the raw request body (string or Buffer), not parsed JSON');
  }
  if (!/^\d{1,12}$/.test(String(timestamp))) throw new WebhookVerificationError('Invalid webhook-timestamp header');
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) {
    throw new WebhookVerificationError('Timestamp is outside the allowed window (a replayed message, or a clock that is off)');
  }

  const raw = typeof body === 'string' ? Buffer.from(body, 'utf8') : Buffer.from(body);
  const expected = Buffer.from(sign(secret, id, timestamp, raw).slice(3), 'base64');
  // Several signatures are sent while a rotated secret is still valid: any one may match.
  const valid = String(signatures)
    .split(' ')
    .some((part) => {
      const [version, value] = part.split(',');
      if (version !== 'v1' || !value) return false;
      const given = Buffer.from(value, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
  if (!valid) throw new WebhookVerificationError('No matching signature');

  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new WebhookVerificationError('Body is not valid JSON');
  }
}
