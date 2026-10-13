import { randomUUID } from 'node:crypto';
import { runWithRequest, trace } from '../context.js';
import { tooManyRequests, badRequest } from '../errors.js';

/**
 * Assigns req.id (honours a sane incoming X-Request-Id) and runs the request in its context.
 * With `trace` (devtools on) the store collects the request's path steps, see context.js.
 */
export function requestContext({ trace: tracing = false } = {}) {
  return (req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w.-]{1,128}$/.test(incoming) ? incoming : randomUUID();
    res.setHeader('X-Request-Id', req.id);
    runWithRequest({ id: req.id, req, startedAt: performance.now(), queries: [], steps: tracing ? [] : null }, next);
  };
}

/**
 * Security headers for a JSON API (the parts of helmet an API needs, in 20 lines).
 * Routes serving HTML (docs, devtools) set their own Content-Security-Policy.
 */
export function securityHeaders({ production }) {
  return (_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('X-DNS-Prefetch-Control', 'off');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  };
}

/** CORS. config.cors.origins: '*' or a list of allowed origins (CORS_ORIGINS env). */
const EXPOSED = ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After', 'Idempotent-Replayed'];

export function cors({ origins = [], credentials = false, maxAge = 600, exposeHeaders = [] } = {}) {
  const exposed = [...new Set([...EXPOSED, ...exposeHeaders])].join(', ');
  const allowAll = origins === '*';
  const allowed = new Set(Array.isArray(origins) ? origins : []);
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin && (allowAll || allowed.has(origin))) {
      res.setHeader('Access-Control-Allow-Origin', allowAll && !credentials ? '*' : origin);
      res.vary('Origin');
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Expose-Headers', exposed);
      if (req.method === 'OPTIONS' && req.get('access-control-request-method')) {
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', req.get('access-control-request-headers') || 'Content-Type, Authorization');
        res.setHeader('Access-Control-Max-Age', String(maxAge));
        return void res.status(204).end();
      }
    }
    next();
  };
}

/**
 * Fixed-window rate limiter. The default store is in memory (one process).
 * For several instances, `calm add @calmapi/rate-limit-mongo` swaps in a shared store.
 */
export function createMemoryStore() {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [key, v] of hits) if (v.resetAt <= now) hits.delete(key);
  }, 60_000);
  timer.unref();
  return {
    async hit(key, windowMs) {
      const now = Date.now();
      let v = hits.get(key);
      if (!v || v.resetAt <= now) {
        v = { count: 0, resetAt: now + windowMs };
        hits.set(key, v);
      }
      v.count += 1;
      return { count: v.count, resetAt: v.resetAt };
    },
    reset: () => hits.clear(),
  };
}

// "this minute", "in 15 minutes": how a limiter's window reads in the request path.
const windowText = (ms) =>
  ms === 60_000 ? 'this minute' : ms === 3_600_000 ? 'this hour' : ms % 60_000 === 0 ? `in ${ms / 60_000} minutes` : `in ${Math.round(ms / 1000)} seconds`;

export function rateLimit({ store, windowMs, max, key = (req) => req.ip, name = 'global', onLimit }) {
  return async (req, res, next) => {
    const { count, resetAt } = await store.hit(`${name}:${key(req)}`, windowMs);
    const resetSeconds = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000));
    res.setHeader('RateLimit-Limit', String(max));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, max - count)));
    res.setHeader('RateLimit-Reset', String(resetSeconds));
    trace({ kind: 'rateLimit', name, file: 'calm/http/middleware.js', detail: `${count} of ${max} ${windowText(windowMs)}`, outcome: count > max ? 'denied' : 'passed' });
    if (count > max) {
      res.setHeader('Retry-After', String(resetSeconds));
      if (count === max + 1) onLimit?.(req, name); // once per window, not on every rejected hit
      return next(tooManyRequests());
    }
    next();
  };
}

/**
 * Refuse JSON bodies that are absurdly nested or wide. express.json limits bytes;
 * this limits the work recursive code (validation, sanitizers) could be made to do.
 */
export function jsonGuard({ maxDepth = 20, maxKeys = 10_000 } = {}) {
  return (req, _res, next) => {
    if (req.body === null || typeof req.body !== 'object') return next();
    let keys = 0;
    const stack = [[req.body, 1]];
    while (stack.length) {
      const [value, depth] = stack.pop();
      if (depth > maxDepth) return next(badRequest(`JSON body is nested deeper than ${maxDepth} levels`));
      for (const child of Array.isArray(value) ? value : Object.values(value)) {
        if (++keys > maxKeys) return next(badRequest(`JSON body has more than ${maxKeys} values`));
        if (child !== null && typeof child === 'object') stack.push([child, depth + 1]);
      }
    }
    next();
  };
}

/** One log line per request: GET /api/posts 200 12ms */
export function accessLog(log) {
  return (req, res, next) => {
    const start = performance.now();
    res.on('finish', () => {
      const ms = Math.round(performance.now() - start);
      const level = res.statusCode >= 500 ? 'error' : res.statusCode >= 400 ? 'warn' : 'info';
      log[level](`${req.method} ${req.originalUrl} ${res.statusCode} ${ms}ms`, { requestId: req.id, userId: req.user?.id });
    });
    next();
  };
}
