import { createHmac, timingSafeEqual } from 'node:crypto';

// Stripe webhook signatures (https://docs.stripe.com/webhooks#verify-manually):
//
//   Stripe-Signature: t=1767225600,v1=5257a869e7ecebeda32affa62cdca3fa51cad7e77a0e56ff536d0ce8e108d8bd
//
// v1 is the hex HMAC-SHA256 of "<t>.<raw body>" keyed with the endpoint's signing secret
// (STRIPE_WEBHOOK_SECRET, the whsec_... value, used as is). While a secret is being rolled,
// Stripe sends one v1 per valid secret: any of them may match. v0 (and anything else) is ignored.
//
// No imports besides node:crypto, so the file can be copied anywhere.

export const DEFAULT_TOLERANCE_SECONDS = 300; // what Stripe's own libraries accept

export class StripeSignatureError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StripeSignatureError';
  }
}

/** The hex v1 signature of `payload` (string or Buffer) at `timestamp` (unix seconds). */
export function computeSignature(payload, timestamp, secret) {
  return createHmac('sha256', secret).update(`${timestamp}.`).update(payload).digest('hex');
}

/** A full Stripe-Signature header value, for tests and local tools. */
export function signStripePayload(payload, secret, { timestamp = Math.floor(Date.now() / 1000) } = {}) {
  return `t=${timestamp},v1=${computeSignature(payload, timestamp, secret)}`;
}

/** 't=1,v1=a,v1=b' -> { timestamp: '1', signatures: ['a', 'b'] } */
function parseHeader(header) {
  let timestamp = null;
  const signatures = [];
  for (const part of String(header).split(',')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const key = part.slice(0, i).trim();
    const value = part.slice(i + 1).trim();
    if (key === 't') timestamp = value;
    else if (key === 'v1') signatures.push(value);
  }
  return { timestamp, signatures };
}

/**
 * Check a webhook: the signature must match the exact bytes received and be recent.
 * Returns the parsed event or throws StripeSignatureError.
 *
 * `rawBody` must be the body as received (Buffer or string). Parsing the JSON and
 * serializing it again changes the bytes, and the signature no longer matches.
 */
export function verifyStripeSignature(rawBody, header, secret, { toleranceSeconds = DEFAULT_TOLERANCE_SECONDS, now = Date.now() } = {}) {
  if (typeof secret !== 'string' || !secret) throw new StripeSignatureError('The webhook signing secret is not configured');
  if (!header) throw new StripeSignatureError('Missing Stripe-Signature header');
  if (typeof rawBody !== 'string' && !(rawBody instanceof Uint8Array)) {
    throw new StripeSignatureError('Missing raw body (the request must be JSON, checked before parsing)');
  }
  const { timestamp, signatures } = parseHeader(header);
  if (!timestamp || !/^\d{1,12}$/.test(timestamp)) throw new StripeSignatureError('Stripe-Signature has no valid timestamp');
  if (!signatures.length) throw new StripeSignatureError('Stripe-Signature has no v1 signature');
  // Replay protection: a captured request stops working after the tolerance window. The
  // timestamp is inside the signed content, so it cannot be changed without the secret.
  if (Math.abs(now / 1000 - Number(timestamp)) > toleranceSeconds) {
    throw new StripeSignatureError('Timestamp is outside the tolerance window (a replayed event, or a clock that is off)');
  }
  const raw = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);
  const expected = Buffer.from(computeSignature(raw, timestamp, secret), 'hex');
  // Constant time comparison, so the response time does not reveal how many bytes matched.
  const valid = signatures.some((sig) => {
    if (!/^[a-f0-9]+$/i.test(sig)) return false;
    const given = Buffer.from(sig, 'hex');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
  if (!valid) throw new StripeSignatureError('No signature matches the payload');
  try {
    return JSON.parse(raw.toString('utf8'));
  } catch {
    throw new StripeSignatureError('Body is not valid JSON');
  }
}
