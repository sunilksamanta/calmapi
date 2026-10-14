import { createHmac, timingSafeEqual } from 'node:crypto';

// Phone numbers, the Twilio Messages API and Twilio request signatures. node:crypto and fetch.

const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * "+1 (415) 555-0100" or "0044 20 7946 0000" -> "+14155550100" / "+442079460000", or null.
 * Only international numbers are accepted: guessing a country for local numbers sends
 * codes to the wrong person.
 */
export function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  let phone = input.trim().replace(/[\s().-]/g, '');
  if (phone.startsWith('00')) phone = `+${phone.slice(2)}`;
  return E164.test(phone) ? phone : null;
}

/** "+14155550100" -> "+14******0100": enough to recognise a number in logs, not to dial it. */
export const maskPhone = (phone) => {
  const p = String(phone ?? '');
  return p.length < 8 ? '***' : `${p.slice(0, 3)}${'*'.repeat(p.length - 7)}${p.slice(-4)}`;
};

/**
 * X-Twilio-Signature: base64(HMAC-SHA1(auth token, URL + each POST parameter as key + value,
 * sorted by key)). https://www.twilio.com/docs/usage/webhooks/webhooks-security
 */
export function twilioSignature(authToken, url, params) {
  const entries = params instanceof URLSearchParams ? [...params] : Object.entries(params ?? {}).flatMap(([k, v]) => [v].flat().map((x) => [k, String(x)]));
  // Case-sensitive sort by key (then value, for repeated keys), like Twilio's own libraries.
  entries.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0));
  const data = entries.reduce((acc, [k, v]) => acc + k + v, url);
  return createHmac('sha1', authToken).update(Buffer.from(data, 'utf8')).digest('base64');
}

/** Constant-time comparison of the header with the expected signature. */
export function validSignature(authToken, url, params, header) {
  if (!authToken || typeof header !== 'string' || !header) return false;
  const expected = Buffer.from(twilioSignature(authToken, url, params));
  const given = Buffer.from(header);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export class SmsError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'SmsError';
    this.status = status;
    this.code = code; // Twilio error code, e.g. 21211 (invalid To number)
    this.retryable = retryable;
  }
}

// Twilio error codes meaning "this number cannot get an SMS": the caller's input, not an outage.
// https://www.twilio.com/docs/api/errors
export const RECIPIENT_ERRORS = new Set([21211, 21214, 21408, 21610, 21612, 21614, 21635]);

/** POST /2010-04-01/Accounts/{sid}/Messages.json. Returns Twilio's message resource. */
export async function createMessage({ apiBase, accountSid, authToken, timeoutMs }, form) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined && v !== null && v !== '') body.append(k, String(v));
  let res;
  try {
    res = await fetch(`${apiBase}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: 'POST',
      headers: {
        authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new SmsError(`Twilio could not be reached: ${err.message}`, { retryable: true });
  }
  const json = await res.json().catch(() => null);
  if (res.ok) return json ?? {};
  const retryAfter = Number(res.headers.get('retry-after'));
  const err = new SmsError(`Twilio refused the message (HTTP ${res.status}${json?.code ? `, error ${json.code}` : ''}): ${json?.message ?? 'no message'}`, {
    status: res.status,
    code: json?.code ?? null,
    retryable: res.status === 429 || res.status >= 500,
  });
  if (Number.isFinite(retryAfter)) err.retryAfterMs = retryAfter * 1000;
  throw err;
}
