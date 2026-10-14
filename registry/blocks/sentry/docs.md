# Error reporting with Sentry (sentry)

Reports what breaks to [Sentry](https://sentry.io) without the SDK: every unhandled error that becomes a 5xx, and failed background work (event listeners, `app.background()` tasks). Events carry the stack trace, the route, the URL without query secrets, the user id, the request's earlier log lines as breadcrumbs, the release and the environment. Credentials, cookies, passwords and tokens are scrubbed before anything leaves the server. 4xx are ignored, identical errors are sent once per window, and a sample rate and a per minute cap protect your quota. No dependencies, no change to the core: the block listens to the logger.

```bash
npx calm add sentry
```

| Adds | |
| --- | --- |
| Files | `app/blocks/sentry/index.js` (what is captured, the log sink), `event.js` (DSN, stack frames, scrubbing, envelopes) |
| Environment | `SENTRY_DSN` (required in production), `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE` |

## Setup in Sentry

1. Create a project (Projects, Create project, platform Node.js).
2. Copy its DSN: Project settings, Client Keys (DSN). It looks like `https://<key>@o123.ingest.sentry.io/456`.
3. In `.env`:

```bash
SENTRY_DSN=https://<key>@o123.ingest.sentry.io/456
SENTRY_RELEASE=api@1.4.0      # optional, default: <package name>@<version>
SENTRY_ENVIRONMENT=staging    # optional, default: NODE_ENV
```

An invalid DSN is reported by `calm doctor`; a missing one is an error in production.

## What is reported

| Source | Reported | Details |
| --- | --- | --- |
| An error thrown in a route, service or hook that answers 5xx | yes | stack, `transaction` (`POST /api/orders/:id`), request, user id, breadcrumbs, `status_code` tag |
| 4xx (validation, 401, 403, 404, 429) | never | the client's mistake, not a bug |
| `log.error(msg, { err })` elsewhere (failed `app.background()` tasks, event listeners) | yes (`captureLogErrors`) | tag `source: log`, `extra.log` is the log message |
| Your own calls | yes | `captureException`, `captureMessage` |

```js
// Report a handled problem
ctx.app.ext.sentry.captureException(err, { tags: { feature: 'checkout' }, extra: { orderId } });
ctx.app.ext.sentry.captureMessage('Payment provider slow', { level: 'warning' });
```

Both return the event id, or `null` when the event was ignored, deduplicated, sampled out or capped. `err.cause` chains are sent as chained exceptions.

## Scrubbing

- Request headers: only an allowlist is sent (`user-agent`, `content-type`, `accept`, `referer`, `origin`, `host`...). `Authorization` and `Cookie` never are.
- The URL is sent without its query string; the query string is sent separately with sensitive values replaced by `[Filtered]` (`?token=...`, `?code=...`, `?signature=...`).
- Bodies (only with `sendBody: true`) and `extra` are scrubbed recursively: any key containing `password`, `secret`, `token`, `authorization`, `cookie`, `session`, `apiKey`, `privateKey`, `credential`, `signature`, `totp`, `recoveryCode`... or ending with `code`, `otp`, `card`, `cvv`, `ssn`. Add your own with `sensitiveKeys`.
- Messages and breadcrumbs: `Bearer ...` / `Basic ...` values, CalmAPI tokens and secret query parameters are replaced.
- The user is `{ id }` only. Email (`sendUserEmail`) and IP (`sendIp`) are opt-in.

## Options

```js
// calm.config.js
export default defineConfig({
  blocks: {
    sentry: {
      sampleRate: 1, // 0 to 1
      dedupeSeconds: 60, // the same error (type, message, place in your code) once per window
      maxEventsPerMinute: 30, // per instance
      maxBreadcrumbs: 20, // log lines of the request (0: none)
      sendUserEmail: false,
      sendIp: false,
      sendBody: false,
      captureLogErrors: true,
      sensitiveKeys: ['iban', 'taxId'],
      ignoreErrors: ['ECONNRESET', /^Client closed/],
      beforeSend: (event) => (event.tags.route === 'GET /api/health' ? null : event),
    },
  },
});
```

After a 429 from Sentry, sending pauses for the `Retry-After` it asks for. `app.ext.sentry.stats` counts sent, deduplicated, sampled out, capped, ignored and failed events (also in devtools, Sentry panel).

## Protocol

Events go to `https://<host>/api/<project>/envelope/` as an [envelope](https://develop.sentry.dev/sdk/data-model/envelopes/) (`application/x-sentry-envelope`: envelope header, item header, event), with `X-Sentry-Auth: Sentry sentry_version=7, sentry_key=<public key>, sentry_client=calmapi-sentry/1.0.0`. Only the public key of the DSN is used.

## Security notes

- Error reports leave your infrastructure: review what you add to `extra` and `tags`, they are scrubbed by key name only.
- Self-hosted Sentry works the same (the DSN points to it). Keep it on https.
- The block reports its own sending problems with `log.warn`, never as errors, so a Sentry outage cannot loop.
