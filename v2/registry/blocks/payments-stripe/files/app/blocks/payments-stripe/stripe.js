import { setTimeout as sleep } from 'node:timers/promises';

// A small Stripe REST client: fetch, form-encoded bodies, Bearer key. No SDK, so nothing to
// install and nothing hidden: every call this block makes is in index.js.
//
//  - Creates carry an Idempotency-Key. A call that failed on the network, with a 429 or a
//    5xx, is retried once with the same key, so Stripe performs it at most once.
//  - Errors become StripeError with Stripe's type, code and request id (for the logs).

export class StripeError extends Error {
  constructor(message, { status = null, type = null, code = null, requestId = null } = {}) {
    super(message);
    this.name = 'StripeError';
    Object.assign(this, { status, type, code, requestId });
  }
}

/** { a: { b: 1 }, items: [{ price: 'x' }] } -> 'a[b]=1&items[0][price]=x' (Stripe's form encoding). */
export function encodeForm(params, prefix = null, out = new URLSearchParams()) {
  const entries = Array.isArray(params) ? params.map((v, i) => [String(i), v]) : Object.entries(params ?? {});
  for (const [key, value] of entries) {
    if (value === undefined || value === null) continue;
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === 'object' && !(value instanceof Date)) encodeForm(value, name, out);
    else out.append(name, value instanceof Date ? String(Math.floor(value.getTime() / 1000)) : String(value));
  }
  return out;
}

/**
 * @param {{ apiBase: string, key: () => string | undefined, apiVersion?: string | null, timeoutMs?: number }} options
 */
export function createStripe({ apiBase, key, apiVersion = null, timeoutMs = 15_000 }) {
  const base = apiBase.replace(/\/$/, '');

  async function once(method, path, { params, idempotencyKey }) {
    const secret = key();
    if (!secret) throw new StripeError('STRIPE_SECRET_KEY is not set', { type: 'configuration_error' });
    const headers = { authorization: `Bearer ${secret}`, accept: 'application/json' };
    if (apiVersion) headers['stripe-version'] = apiVersion;
    let url = `${base}${path}`;
    let body;
    if (method === 'GET') {
      const query = encodeForm(params).toString();
      if (query) url += `?${query}`;
    } else {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = encodeForm(params).toString();
      if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
    }
    const res = await fetch(url, { method, headers, body, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      // not JSON: a proxy error page, reported below
    }
    if (res.ok && json) return json;
    const e = json?.error ?? {};
    throw new StripeError(e.message ?? `Stripe answered ${res.status}`, { status: res.status, type: e.type ?? null, code: e.code ?? null, requestId: res.headers.get('request-id') });
  }

  const retryable = (err) => !(err instanceof StripeError) || err.status === 429 || err.status >= 500;

  return {
    /** request('POST', '/checkout/sessions', { params, idempotencyKey }) -> Stripe's JSON object. */
    async request(method, path, { params = {}, idempotencyKey = null } = {}) {
      const safeToRepeat = method === 'GET' || Boolean(idempotencyKey);
      try {
        return await once(method, path, { params, idempotencyKey });
      } catch (err) {
        if (!safeToRepeat || !retryable(err) || err.type === 'configuration_error') throw err;
        await sleep(300 + Math.floor(Math.random() * 300));
        return once(method, path, { params, idempotencyKey });
      }
    },
  };
}
