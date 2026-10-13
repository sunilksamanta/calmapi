import { randomUUID } from 'node:crypto';

// Building Sentry events by hand: DSN parsing, stack frames, secret scrubbing and the
// envelope format (https://develop.sentry.dev/sdk/data-model/envelopes/). No SDK.

/**
 * https://<public key>@<host>[/<path>]/<project id>  ->  where to send and how to sign.
 * Throws a readable error for anything else, so a typo fails at boot, not on the first error.
 */
export function parseDsn(dsn) {
  let url;
  try {
    url = new URL(String(dsn).trim());
  } catch {
    throw new Error('SENTRY_DSN is not a URL (copy it from Sentry: Project settings, Client Keys (DSN))');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SENTRY_DSN must start with https://');
  const publicKey = decodeURIComponent(url.username);
  const segments = url.pathname.split('/').filter(Boolean);
  const projectId = segments.pop();
  if (!publicKey || !projectId || !/^\d+$/.test(projectId)) throw new Error('SENTRY_DSN must look like https://<key>@<host>/<project id>');
  const path = segments.length ? `/${segments.join('/')}` : '';
  return {
    publicKey,
    projectId,
    host: url.host,
    envelopeUrl: `${url.protocol}//${url.host}${path}/api/${projectId}/envelope/`,
    // The DSN as Sentry wants it in envelope headers: never the (legacy) secret key.
    dsn: `${url.protocol}//${publicKey}@${url.host}${path}/${projectId}`,
  };
}

export const CLIENT = 'calmapi-sentry/1.0.0';

/** The X-Sentry-Auth header: public key only, so it is fine for it to travel with every event. */
export const authHeader = ({ publicKey }) => `Sentry sentry_version=7, sentry_key=${publicKey}, sentry_client=${CLIENT}`;

export const newEventId = () => randomUUID().replace(/-/g, '');

// ---- stack frames ---------------------------------------------------------------------

const FRAME = /^\s*at (?:(.+?) \()?(.*?):(\d+):(\d+)\)?\s*$/;

/** V8 stack -> Sentry frames, oldest call first (that is the order Sentry expects). */
export function parseStack(stack, { root } = {}) {
  const frames = [];
  for (const line of String(stack ?? '').split('\n').slice(1, 51)) {
    const m = FRAME.exec(line);
    if (!m) continue;
    const [, fn, file, lineno, colno] = m;
    const abs = file.replace(/^file:\/\//, '');
    const inApp = !abs.includes('/node_modules/') && !abs.startsWith('node:') && !abs.startsWith('internal/');
    frames.push({
      function: fn || '?',
      filename: root && abs.startsWith(root) ? abs.slice(root.length).replace(/^\//, '') : abs,
      abs_path: abs,
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: inApp,
    });
  }
  return frames.reverse();
}

/** An error and its causes as Sentry exception values (the outermost error last). */
export function exceptionValues(err, opts) {
  const values = [];
  let current = err;
  for (let i = 0; current && i < 4; i++) {
    const isError = current instanceof Error || (typeof current === 'object' && 'message' in current);
    values.unshift({
      type: (isError && (current.name || current.constructor?.name)) || 'Error',
      value: scrubString(isError ? String(current.message ?? '') : String(current)).slice(0, 2000),
      ...(isError && current.stack ? { stacktrace: { frames: parseStack(current.stack, opts) } } : {}),
      mechanism: { type: i === 0 ? 'calmapi' : 'chained', handled: false },
    });
    current = isError ? current.cause : null;
  }
  return values;
}

// ---- scrubbing --------------------------------------------------------------------------

export const FILTERED = '[Filtered]';

// Keys whose values never leave the server: compared without case, '-' and '_'.
export const DEFAULT_SENSITIVE = [
  'password', 'passwd', 'pwd', 'secret', 'token', 'authorization', 'auth', 'cookie', 'session', 'apikey',
  'privatekey', 'credential', 'signature', 'otp', 'totp', 'recoverycode', 'mfa', 'code', 'ssn', 'card', 'cardnumber', 'cvv', 'iban', 'csrf', 'xsrf',
];

// Short words would match inside unrelated keys ('footprint'), so they must end the key.
const SHORT = new Set(['code', 'auth', 'pwd', 'otp', 'mfa', 'ssn', 'cvv', 'card']);
const norm = (key) => String(key).toLowerCase().replace(/[-_\s]/g, '');

export function sensitiveMatcher(list = DEFAULT_SENSITIVE) {
  const words = list.map(norm);
  return (key) => {
    const k = norm(key);
    return words.some((w) => (SHORT.has(w) ? k === w || k.endsWith(w) : k.includes(w)));
  };
}

// Bearer tokens, calm tokens and secrets in query strings can hide inside messages and URLs.
const INLINE = [
  [/\b(Bearer|Basic)\s+[\w.~+/=-]+/gi, `$1 ${FILTERED}`],
  [/\b(calm|reset|calm_ak)_[\w-]{16,}/g, FILTERED],
  [/([?&;](?:token|access_token|refresh_token|code|key|api_key|apikey|secret|password|signature|sig|ticket)=)[^&\s#"']*/gi, `$1${FILTERED}`],
];
export function scrubString(text) {
  let out = String(text);
  for (const [re, by] of INLINE) out = out.replace(re, by);
  return out;
}

/** Copy of `value` with sensitive keys replaced, recursively (depth and size bounded). */
export function scrub(value, isSensitive = sensitiveMatcher(), depth = 0) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return scrubString(value).slice(0, 4000);
  if (typeof value !== 'object') return value;
  if (depth > 8) return '[Too deep]';
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => scrub(v, isSensitive, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value).slice(0, 200)) out[k] = isSensitive(k) ? FILTERED : scrub(v, isSensitive, depth + 1);
  return out;
}

/** "a=1&token=x" -> "a=1&token=[Filtered]" */
export function scrubQuery(search, isSensitive) {
  const params = new URLSearchParams(search);
  const out = new URLSearchParams();
  for (const [k, v] of params) out.append(k, isSensitive(k) ? FILTERED : scrubString(v));
  return out.toString();
}

// ---- envelope -----------------------------------------------------------------------------

/** One event as an envelope: header line, item header line, payload line. */
export function envelope(event, { dsn }) {
  const payload = JSON.stringify(event);
  const header = JSON.stringify({ event_id: event.event_id, sent_at: new Date().toISOString(), dsn, sdk: { name: 'calmapi.sentry', version: '1.0.0' } });
  const item = JSON.stringify({ type: 'event', content_type: 'application/json', length: Buffer.byteLength(payload) });
  return `${header}\n${item}\n${payload}\n`;
}
