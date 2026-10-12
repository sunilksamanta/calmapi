import { createHash, randomUUID } from 'node:crypto';
import { definePlugin, CalmError } from '#calm';

// Idempotency-Key header (draft-ietf-httpapi-idempotency-key-header): a client sends a unique
// key with a POST, PATCH, PUT or DELETE; when it retries (timeout, dropped connection, app
// restart), it gets the first response back instead of running the operation twice.
//
//  1. A guard claims the key with an insert-first lock document { status: 'running' } in
//     calm_idempotency. Guards run after authentication and body parsing, so the key is
//     scoped to the user (or anonymous + IP), the method and the path: a key sent by someone
//     else never matches yours.
//  2. The response is captured as it is written. Before it is released to the client, the
//     lock becomes { status: 'done', response }, so a retry arriving right after the response
//     always finds it.
//  3. Same key, same request (SHA-256 of the JSON body, plus the query string): the stored
//     response, with Idempotent-Replayed: true. Same key, different request: 422. Still
//     running: 409. 5xx responses are not stored (the lock is dropped) so the retry runs again;
//     4xx responses are stored like successes (fix the request and use a new key).

const KEY = /^[\x21-\x7e]{1,255}$/;
// Replayed headers. Never cookies, rate limit counters or the old request id.
const SAFE_HEADERS = new Set(['content-type', 'content-language', 'content-location', 'content-disposition', 'location', 'etag', 'last-modified', 'link', 'cache-control']);
const TEXT = /^(text\/|application\/([\w.-]+\+)?(json|xml|javascript|x-www-form-urlencoded)\b)/i;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * The key from the header: an RFC 8941 string ("8e03978e-..."), as the draft specifies, or the
 * bare form most clients send. 1 to 255 visible ASCII characters; null when invalid.
 */
export function parseKey(value) {
  if (typeof value !== 'string') return null;
  let key = value.trim();
  if (key.startsWith('"')) {
    const m = /^"((?:[\x20-\x21\x23-\x5b\x5d-\x7e]|\\["\\])*)"$/.exec(key);
    if (!m) return null;
    key = m[1].replace(/\\(["\\])/g, '$1');
  }
  return KEY.test(key) ? key : null;
}

/** JSON with sorted keys, so { a, b } and { b, a } are the same request. */
export function canonicalJSON(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const splitPath = (path) => path.split('/').filter(Boolean);
const isParam = (segment) => segment === '*' || segment.startsWith(':');

/**
 * 'POST /api/orders/:id/pay' -> { test(method, path) }. ':name' and '*' match one segment,
 * a final '**' matches the rest. The method can be '*'.
 */
export function compilePattern(pattern) {
  const m = /^([a-z]+|\*)\s+(\/\S*)$/i.exec(String(pattern).trim());
  if (!m) throw new Error(`idempotency: "${pattern}" is not a route pattern like "POST /api/orders"`);
  const method = m[1].toUpperCase();
  const segments = splitPath(m[2]);
  const matches = (other, loose) => {
    for (let i = 0; i < segments.length; i++) {
      if (segments[i] === '**') return true;
      if (i >= other.length) return false;
      if (!isParam(segments[i]) && segments[i] !== other[i] && !(loose && isParam(other[i]))) return false;
    }
    return segments.length === other.length;
  };
  return {
    pattern,
    method,
    test: (reqMethod, path) => (method === '*' || method === reqMethod) && matches(splitPath(path), false),
    /** For doctor: does it match a declared route ('/api/orders/:id' counts as any id)? */
    coversRoute: (route, prefix) => (method === '*' || method === route.method) && matches(splitPath(`${prefix}${route.path}`), true),
  };
}

const pathOf = (req) => req.originalUrl.split('?')[0].replace(/\/+$/, '') || '/';
const searchOf = (req) => (req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '');

export default definePlugin({
  name: 'idempotency',
  options: {
    methods: ['POST', 'PATCH', 'PUT', 'DELETE'],
    required: [], // ['POST /api/orders']: 400 IDEMPOTENCY_KEY_MISSING without the header
    ttlHours: 24, // how long a key and its response are kept (publish this to your API clients)
    lockTimeoutSeconds: 300, // a 'running' lock older than this was abandoned (crash): a retry may take over
    maxResponseKb: 1024, // larger bodies are not stored: a replay gets the status and headers only
    docsUrl: null, // when set, errors carry Link: <docsUrl>; rel="describedby"
  },
  setup(calm, options) {
    const methods = new Set(options.methods.map((m) => m.toUpperCase()));
    const required = options.required.map(compilePattern);
    const ttlMs = options.ttlHours * 3_600_000;
    const lockMs = options.lockTimeoutSeconds * 1000;
    const maxBytes = options.maxResponseKb * 1024;

    const { Schema } = calm.mongoose;
    const schema = new Schema(
      {
        _id: String, // sha256(scope, method, path, key)
        key: { type: String, required: true },
        user: { type: Schema.Types.ObjectId, ref: 'user', default: null, index: true },
        method: String,
        path: String,
        fingerprint: { type: String, required: true },
        status: { type: String, enum: ['running', 'done'], required: true },
        lockId: String,
        lockedUntil: Date,
        response: { type: Schema.Types.Mixed, default: null }, // { status, headers, body, encoding, omitted? }
        completedAt: Date,
        expiresAt: { type: Date, required: true },
      },
      { collection: 'calm_idempotency', versionKey: false, timestamps: { createdAt: true, updatedAt: false } },
    );
    schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Store = calm.mongoose.model('calmIdempotency', schema);
    calm.provide('idempotency', { model: Store, parseKey });
    calm.onStart(() => Store.init()); // the TTL index exists before the first request

    const problem = (res, status, code, message) => {
      if (options.docsUrl) res.setHeader('Link', `<${options.docsUrl}>; rel="describedby"; type="text/html"`);
      return new CalmError(status, code, message);
    };

    /** Insert the lock. Returns null when this request owns the key, else the existing record. */
    async function claim(record) {
      const { _id, ...fields } = record;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await Store.create(record);
          return null;
        } catch (err) {
          if (err?.code !== 11000) throw err;
        }
        const now = new Date();
        // An expired record the TTL monitor has not removed yet, or a lock left by a crashed
        // process (same request only): take it over.
        const taken = await Store.findOneAndUpdate(
          { _id, $or: [{ expiresAt: { $lte: now } }, { status: 'running', lockedUntil: { $lte: now }, fingerprint: record.fingerprint }] },
          { $set: { ...fields, response: null, completedAt: null } },
        ).lean();
        if (taken) return null;
        const existing = await Store.findById(_id).lean();
        if (existing) return existing;
        // Gone in between (dropped after a 5xx): try the insert again.
      }
      return { status: 'running', fingerprint: record.fingerprint };
    }

    /** Store the outcome (or drop the lock after a 5xx) before the response leaves. */
    async function settle(record, outcome) {
      if (outcome.status >= 500) return void (await Store.deleteOne({ _id: record._id, lockId: record.lockId }));
      const headers = {};
      for (const [name, value] of Object.entries(outcome.headers)) if (SAFE_HEADERS.has(name)) headers[name] = value;
      const response = { status: outcome.status, headers, body: null, encoding: null };
      if (outcome.body === null) response.omitted = true;
      else if (outcome.body.length) {
        response.encoding = TEXT.test(String(headers['content-type'] ?? '')) ? 'utf8' : 'base64';
        response.body = outcome.body.toString(response.encoding);
      }
      await Store.updateOne(
        { _id: record._id, lockId: record.lockId },
        { $set: { status: 'done', response, completedAt: new Date(), expiresAt: new Date(Date.now() + ttlMs) }, $unset: { lockedUntil: '' } },
      );
    }

    /**
     * Capture what the handler (or the error handler) writes. On end(), status and headers are
     * frozen with writeHead (so nothing that runs while we save can change them), the outcome
     * is saved, then the response is released.
     */
    function capture(res, record) {
      const { write, end } = res;
      const chunks = [];
      let size = 0;
      let wrote = false;
      let ended = false;
      const keep = (chunk, encoding) => {
        if (chunk === undefined || chunk === null || typeof chunk === 'function') return;
        const buf = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8') : Buffer.from(chunk);
        size += buf.length;
        if (size <= maxBytes) chunks.push(buf);
      };
      res.write = function (chunk, encoding, cb) {
        keep(chunk, encoding);
        wrote = true;
        return write.call(this, chunk, encoding, cb);
      };
      res.end = function (chunk, encoding, cb) {
        if (ended) return this; // a second end() while the outcome is being saved
        ended = true;
        if (typeof chunk === 'function') [cb, chunk, encoding] = [chunk, undefined, undefined];
        else if (typeof encoding === 'function') [cb, encoding] = [encoding, undefined];
        keep(chunk, encoding);
        if (!this.headersSent) {
          if (!wrote && size && !this.hasHeader('content-length') && !this.hasHeader('transfer-encoding')) this.setHeader('Content-Length', size);
          this.writeHead(this.statusCode);
        }
        const outcome = { status: this.statusCode, headers: this.getHeaders(), body: size <= maxBytes ? Buffer.concat(chunks) : null };
        settle(record, outcome)
          .catch((err) => calm.log.error('idempotency: could not store the response', { err, key: record.key }))
          .finally(() => {
            res.write = write;
            res.end = end;
            end.call(this, chunk, encoding, cb);
          });
        return this;
      };
    }

    function replay(res, stored) {
      res.status(stored.status);
      for (const [name, value] of Object.entries(stored.headers ?? {})) {
        if (!(stored.omitted && name === 'content-type')) res.setHeader(name, value);
      }
      res.setHeader('Idempotent-Replayed', 'true'); // calm/http exposes it to browsers through CORS
      const body = stored.body === null || stored.body === undefined ? null : Buffer.from(stored.body, stored.encoding ?? 'utf8');
      if (body) res.setHeader('Content-Length', body.length);
      res.end(body ?? undefined);
    }

    calm.guard(async (ctx) => {
      const { req, res } = ctx;
      if (!methods.has(req.method) || req.idempotency) return;
      const path = pathOf(req);
      const header = req.get('idempotency-key');
      if (header === undefined) {
        if (required.some((p) => p.test(req.method, path))) {
          throw problem(res, 400, 'IDEMPOTENCY_KEY_MISSING', `${req.method} ${path} needs an Idempotency-Key header: a unique value per operation, such as a UUID`);
        }
        return;
      }
      const key = parseKey(header);
      if (!key) throw problem(res, 400, 'IDEMPOTENCY_KEY_INVALID', 'Idempotency-Key must be 1 to 255 visible ASCII characters (a UUID is a good choice)');

      const scope = ctx.user ? `user:${ctx.user.id}` : `anonymous:${req.ip}`;
      const now = Date.now();
      const record = {
        _id: sha256([scope, req.method, path, key].join('\n')),
        key,
        user: ctx.user?.id ?? null,
        method: req.method,
        path,
        fingerprint: sha256(`${searchOf(req)}\n${canonicalJSON(req.body ?? null)}`),
        status: 'running',
        lockId: randomUUID(),
        lockedUntil: new Date(now + lockMs),
        expiresAt: new Date(now + ttlMs),
      };
      const existing = await claim(record);
      req.idempotency = { key, replayed: Boolean(existing) };
      if (!existing) return capture(res, record);

      if (existing.fingerprint !== record.fingerprint) {
        throw problem(res, 422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
      }
      if (existing.status !== 'done') {
        res.setHeader('Retry-After', '1');
        throw problem(res, 409, 'IDEMPOTENCY_IN_PROGRESS', 'A request with this Idempotency-Key is still being processed. Retry shortly.');
      }
      replay(res, existing.response);
      calm.log.debug('idempotency: replayed', { key, method: req.method, path });
      // The response is sent, so calm stops the route here: the handler does not run again.
    }, { order: 100 }); // after other guards (API key scopes, maintenance...), so a refused request is never stored

    calm.doctor((app) => {
      const findings = [];
      for (const p of required) {
        if (!methods.has(p.method) && p.method !== '*') {
          findings.push({ level: 'warn', id: 'idempotency-method', title: `idempotency: "${p.pattern}" uses a method the block ignores`, detail: `Add ${p.method} to blocks.idempotency.methods, or remove the pattern.` });
        } else if (!app.routes.some((route) => p.coversRoute(route, app.config.apiPrefix))) {
          findings.push({ level: 'warn', id: 'idempotency-required-unmatched', title: `idempotency: "${p.pattern}" matches no route`, detail: 'Check the method and the path (with the /api prefix) in blocks.idempotency.required.' });
        }
      }
      return findings;
    });
  },
});
