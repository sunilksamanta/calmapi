import { hostname } from 'node:os';
import { definePlugin, currentRequest } from '#calm';
import { parseDsn, authHeader, newEventId, exceptionValues, scrub, scrubString, scrubQuery, sensitiveMatcher, envelope, DEFAULT_SENSITIVE } from './event.js';

// Error reporting to Sentry without the SDK.
//
// Where errors come from: the core error handler logs every 5xx with log.error(msg, { err })
// after setting req.calmError, and background tasks and event listeners that fail are
// logged the same way. A log sink sees those lines, so no change to the core is needed:
//  - a 5xx request error is reported with the request (method, route, URL without secrets,
//    headers without credentials) and the user id;
//  - 4xx never are: they are the client's mistake, not a bug (the core does not log them);
//  - other error logs with an err (a failed background task) are reported too.
// The request's earlier log lines become breadcrumbs. Everything is scrubbed before it leaves.

export { parseDsn, scrub, scrubString } from './event.js';

const HEADER_ALLOWLIST = ['user-agent', 'content-type', 'content-length', 'accept', 'accept-language', 'referer', 'origin', 'x-request-id', 'host'];

export default definePlugin({
  name: 'sentry',
  env: {
    SENTRY_DSN: { secret: true, required: 'production', description: 'Client key (DSN) from Sentry: Project settings, Client Keys (DSN)' },
    SENTRY_ENVIRONMENT: 'Environment name shown in Sentry (default: NODE_ENV, then the CalmAPI mode)',
    SENTRY_RELEASE: 'Release name shown in Sentry (default: the version in package.json)',
  },
  // Override in calm.config.js: blocks: { sentry: { sampleRate: 0.5 } }
  options: {
    sampleRate: 1, // share of errors sent, 0 to 1
    dedupeSeconds: 60, // the same error (type, message, place) is sent once per window
    maxEventsPerMinute: 30, // a hard cap per instance, so an outage cannot burn the quota
    maxBreadcrumbs: 20, // log lines of the request kept as breadcrumbs (0: none)
    sendUserEmail: false, // only the user id by default
    sendIp: false, // the client IP is personal data: off by default
    sendBody: false, // request bodies (scrubbed) are left out by default
    captureLogErrors: true, // also report log.error(msg, { err }) outside 5xx (failed background tasks)
    sensitiveKeys: [], // more keys to scrub, added to the built-in list
    ignoreErrors: [], // messages (strings: substring, or RegExp) never reported
    beforeSend: null, // (event) => event | null, the last word on what is sent
    serverName: null, // default: os.hostname()
    timeoutMs: 5000,
  },
  setup(calm, options) {
    const raw = calm.env('SENTRY_DSN');
    let target = null;
    let dsnError = null;
    if (raw) {
      try {
        target = parseDsn(raw);
      } catch (err) {
        dsnError = err.message;
      }
    }
    calm.doctor(() => {
      if (dsnError) return [{ level: 'error', id: 'sentry-dsn', title: 'SENTRY_DSN is invalid', detail: dsnError, file: 'app/blocks/sentry/index.js' }];
      return [];
    });

    const stats = { sent: 0, sampledOut: 0, deduped: 0, capped: 0, failed: 0, ignored: 0 };
    const api = {
      enabled: Boolean(target),
      stats,
      lastEventId: null,
      captureException: () => null,
      captureMessage: () => null,
      flush: () => calm.app.idle(),
    };
    calm.provide('sentry', api);
    if (!target) return;

    const isSensitive = sensitiveMatcher([...DEFAULT_SENSITIVE, ...(options.sensitiveKeys ?? [])]);
    const environment = calm.env('SENTRY_ENVIRONMENT') || calm.config.nodeEnv || calm.config.mode;
    const release = calm.env('SENTRY_RELEASE') || `${calm.config.app.name}@${calm.config.app.version}`;
    const serverName = options.serverName ?? hostname();
    const sampleRate = Math.min(1, Math.max(0, Number(options.sampleRate ?? 1)));
    const root = calm.config.root;

    // ---- noise control ---------------------------------------------------------------------
    const recent = new Map(); // fingerprint -> last sent (ms)
    let minute = { start: 0, count: 0 };
    let pausedUntil = 0; // Sentry answered 429: stop sending until then

    const ignored = (message) =>
      (options.ignoreErrors ?? []).some((p) => (p instanceof RegExp ? p.test(message) : message.includes(String(p))));

    function admit(fingerprint) {
      const now = Date.now();
      if (now < pausedUntil) return 'capped';
      const last = recent.get(fingerprint);
      if (last && now - last < options.dedupeSeconds * 1000) return 'deduped';
      if (now - minute.start >= 60_000) minute = { start: now, count: 0 };
      if (minute.count >= options.maxEventsPerMinute) return 'capped';
      if (sampleRate < 1 && Math.random() >= sampleRate) return 'sampledOut';
      minute.count += 1;
      recent.set(fingerprint, now);
      if (recent.size > 1000) for (const key of [...recent.keys()].slice(0, 500)) recent.delete(key);
      return 'ok';
    }

    // ---- request details ------------------------------------------------------------------
    function requestInfo(req) {
      const [path, search = ''] = String(req.originalUrl ?? req.url ?? '').split('?');
      const headers = {};
      for (const name of HEADER_ALLOWLIST) {
        const value = req.headers?.[name];
        if (value !== undefined) headers[name] = scrubString(String(value)).slice(0, 500);
      }
      return {
        method: req.method,
        url: `${req.protocol ?? 'http'}://${req.get?.('host') ?? 'localhost'}${scrubString(path)}`,
        ...(search ? { query_string: scrubQuery(search, isSensitive) } : {}),
        headers,
        ...(options.sendBody && req.body && typeof req.body === 'object' ? { data: scrub(req.body, isSensitive) } : {}),
      };
    }

    function userInfo(req, explicit) {
      const u = explicit ?? req?.user;
      if (!u) return options.sendIp && req?.ip ? { ip_address: req.ip } : undefined;
      return {
        id: String(u.id ?? u._id ?? ''),
        ...(options.sendUserEmail && u.email ? { email: u.email } : {}),
        ...(options.sendIp && req?.ip ? { ip_address: req.ip } : {}),
      };
    }

    // ---- building and sending ------------------------------------------------------------------
    function buildEvent({ err, message, level = 'error', req, status, tags = {}, extra, user, crumbs }) {
      const event = {
        event_id: newEventId(),
        timestamp: Date.now() / 1000,
        platform: 'node',
        level,
        logger: 'calmapi',
        server_name: serverName,
        release,
        environment,
        contexts: { runtime: { name: 'node', version: process.version } },
        tags: { ...tags },
      };
      if (err) event.exception = { values: exceptionValues(err, { root }) };
      if (message) event.message = { formatted: scrubString(message).slice(0, 2000) };
      if (req) {
        event.request = requestInfo(req);
        if (req.calmRoute) event.transaction = `${req.method} ${calm.config.apiPrefix}${req.calmRoute.path}`;
        if (req.id) event.tags.request_id = req.id;
        if (event.transaction) event.tags.route = event.transaction;
      }
      if (status) event.tags.status_code = String(status);
      const who = userInfo(req, user);
      if (who) event.user = who;
      if (crumbs?.length) event.breadcrumbs = { values: crumbs.map((c) => ({ ...c })) };
      if (extra) event.extra = scrub(extra, isSensitive);
      return event;
    }

    const fingerprintOf = (event) => {
      const ex = event.exception?.values?.at(-1);
      const top = ex?.stacktrace?.frames?.filter((f) => f.in_app).at(-1);
      return [ex?.type, ex?.value ?? event.message?.formatted, top ? `${top.filename}:${top.lineno}` : ''].join('|');
    };

    async function send(event) {
      let res;
      try {
        res = await fetch(target.envelopeUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-sentry-envelope', 'x-sentry-auth': authHeader(target) },
          body: envelope(event, target),
          signal: AbortSignal.timeout(options.timeoutMs),
        });
      } catch (err) {
        stats.failed += 1;
        // warn without an err field: this sink only reports error lines, so no loop.
        calm.log.warn(`sentry: could not send event ${event.event_id}`, { reason: err.message });
        return;
      }
      if (res.status === 429) {
        const seconds = Number(res.headers.get('retry-after')) || 60;
        pausedUntil = Date.now() + Math.min(seconds, 3600) * 1000;
      }
      if (!res.ok) {
        stats.failed += 1;
        calm.log.warn(`sentry: event ${event.event_id} refused with HTTP ${res.status}`, { reason: (await res.text().catch(() => '')).slice(0, 200) });
        return;
      }
      await res.body?.cancel().catch(() => {});
      stats.sent += 1;
    }

    /** Scrub, filter, sample, then send in the background. Returns the event id, or null. */
    function capture(input) {
      let event = buildEvent(input);
      const text = event.exception?.values?.at(-1)?.value ?? event.message?.formatted ?? '';
      if (ignored(text)) {
        stats.ignored += 1;
        return null;
      }
      const verdict = admit(fingerprintOf(event));
      if (verdict !== 'ok') {
        stats[verdict] += 1;
        return null;
      }
      if (typeof options.beforeSend === 'function') {
        try {
          event = options.beforeSend(event);
        } catch (err) {
          calm.log.warn('sentry: beforeSend threw, the event was dropped', { reason: err.message });
          return null;
        }
        if (!event) return null;
      }
      api.lastEventId = event.event_id;
      calm.app.background(() => send(event));
      return event.event_id;
    }

    api.captureException = (err, { req, tags, extra, user, level } = {}) => capture({ err, req: req ?? currentRequest()?.req, tags, extra, user, level, crumbs: currentRequest()?.sentryCrumbs });
    api.captureMessage = (message, { level = 'info', req, tags, extra, user } = {}) => capture({ message, level, req: req ?? currentRequest()?.req, tags, extra, user, crumbs: currentRequest()?.sentryCrumbs });

    // ---- the log sink -----------------------------------------------------------------------
    const sameError = (original, logged) =>
      Boolean(original && logged && (original.stack && logged.stack ? original.stack === logged.stack : original.message === logged.message));

    function onLog(entry) {
      const store = currentRequest();
      if (entry.level === 'error' && entry.err && typeof entry.err === 'object') {
        const req = store?.req;
        const failure = req?.calmError;
        if (failure && sameError(failure.original, entry.err)) {
          // The error handler's line for this request: report it only for 5xx.
          if (failure.http?.status >= 500) capture({ err: failure.original, req, status: failure.http.status, crumbs: store.sentryCrumbs });
        } else if (options.captureLogErrors) {
          capture({ err: entry.err, req, tags: { source: 'log' }, extra: { log: entry.msg }, crumbs: store?.sentryCrumbs });
        }
      }
      // Breadcrumbs: the request's log lines so far, scrubbed, the newest kept.
      if (store && options.maxBreadcrumbs > 0) {
        const crumbs = (store.sentryCrumbs ??= []);
        crumbs.push({ timestamp: Date.parse(entry.time) / 1000 || Date.now() / 1000, category: 'log', level: entry.level === 'warn' ? 'warning' : entry.level, message: scrubString(entry.msg).slice(0, 300) });
        if (crumbs.length > options.maxBreadcrumbs) crumbs.shift();
      }
    }

    calm.log.addSink((entry) => {
      try {
        onLog(entry);
      } catch {
        // Reporting must never break logging.
      }
    });

    calm.devtools.panel('sentry', () => ({ project: target.projectId, host: target.host, environment, release, sampleRate, stats: { ...stats }, lastEventId: api.lastEventId }));
  },
});
