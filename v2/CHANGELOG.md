# Changelog

## 2.0.0-alpha.1

### Push notifications
- `app.push.send({ to, title, body, data, ... })` (also `ctx.push` and `calm.push`): one message format for
  iOS, Android and the web, validated, with the APNs, FCM, Expo and Web Push payloads built for you.
  `collapseId` replaces an older notification with a newer one.
- Device registry: `POST|GET /api/auth/devices`, `DELETE /api/auth/devices/:deviceId`,
  `POST /api/auth/devices/unregister` (by token, for sign out on a phone). Tokens are never returned in
  full, and tokens a provider reports as gone are removed.
- Devices belong to the session that registered them: signing out, signing out everywhere, changing or
  resetting the password removes them (`auth.devicesFollowSessions`, on by default).
- Several transports at once: `push.use({ name, accepts, send })` routes each device to the right one.
- Devtools **Push** panel: every notification on an iPhone lock screen, an Android notification shade and
  a desktop browser, the provider payloads with their size, warnings, the delivery log per device and a
  composer with a live preview.
- Device simulator: add fake devices to any user (several per user), each with a behavior (delivers,
  offline, muted, uninstalled, invalid token, rate limited), or paste a real token. Rotate and revoke
  tokens, open a phone view with the device's own inbox, tap a notification to send `push.opened`.
- Blocks: `push-expo` (Expo push service per the official docs: batches of 100, gzip, retries, receipts)
  and `push-fcm` (FCM HTTP v1, service account signed with `node:crypto`, no SDK). Both can run together.
- Tests: `t.pushes` and `t.mails`. MCP: `calm_pushes` (18 tools).

### Blocks for the features most apps need
- `notifications`: `ctx.notify(user, 'order-shipped', { order })` writes the in-app inbox, sends a push and
  an email, following each user's preferences and quiet hours. Types are small files in `app/notifications/`.
- `webhooks`: outgoing webhooks for resource events with Standard Webhooks signatures, a MongoDB delivery
  queue with retries and a delivery log, per-user visibility, SSRF protection and secret rotation.
- `api-keys`: personal and service API keys with scopes, shown once, hashed at rest, checksummed so secret
  scanners can find leaked keys, with expiry, last used and admin revoke.
- `magic-link`: passwordless sign-in by email, single use, bound to the browser that asked. Lockout,
  disabled accounts and two-factor authentication still apply.
- `feature-flags`: kill switches, gradual rollouts, per user and per role targeting, variants, `ctx.flags`,
  route gates, an admin API and an endpoint for frontends.
- `privacy`: users download everything they own as JSON and delete their account, with delete, anonymize
  or keep per resource and an optional grace period.
- `idempotency`: the `Idempotency-Key` header replays the stored response instead of running an
  operation twice.
- 21 official blocks in total. Official blocks declare their environment variables.

### Build and share your own blocks
- `calm make block <name>` starts one; `calm block check` reviews it; `calm block pack` turns it into a
  registry file; `calm block list` shows installed blocks and what you changed.
- Install from GitHub: `calm add gh:user/repo/name[@ref]`. Before installing a block that is not official,
  the CLI shows in plain words what its code does (network, files, other programs, every request) and asks;
  `--yes` also needs `--trust` when the code does something risky.
- Extension points: `definePlugin({ env, options })` with `calm.options` (overridable in
  `calm.config.js` under `blocks.<name>`) and `calm.env(key)`; `calm.authenticate(fn)` for other
  credentials with `ctx.auth { via, scopes, id }`; `calm.guard(fn, { order })`, which can stop a request
  or answer it with `ctx.reply()`; `calm.policy(name, fn)` for named policies; route `scope` and `meta`.
- `app.canRead(resource, doc, user)`: the read rules of the API for work outside a request.
- The auth service shares `completeLogin`, `lockedUntil`, `recordFailure` and `clearFailures`, so every
  way to sign in applies the same lockout and second factor.
- Blocks import everything from `#calm`, which now also exports `evaluatePolicy`, `parsePolicy`,
  `matchesFilter`, `createToken`, `hashToken`, `isEncrypted`, `maskToken`, `providerPayloads` and
  `resourceJSONSchema`.
- Devtools **Blocks** panel: each block's origin, the files you changed since installing it, the hooks it
  uses, its environment variables (set or missing, secret values never shown), options and routes.

### Sample data
- `calm seed [resource...]` and the devtools **Sample data** button create records that look real (names,
  emails, prices, dates guessed from field names), repeatable with `--seed`.

### Security and correctness
- `f.string().pii()` marks personal data for `calm audit` and the doctor.
- Guards run before upload middleware, so a refused request never has its upload parsed.
- Devtools redacts tokens, keys, secrets and passwords in recorded responses too.
- Accounts marked for deletion cannot sign in or use a session.
- CORS exposes `Idempotent-Replayed`; `cors.exposeHeaders` adds your own.

### Docs
- The documentation moved to https://docs.calmapi.dev. The CLI, the registry (`calm add --remote`) and
  new projects link there.

## 2.0.0-alpha.0

A rewrite. The framework is still copied into your project, and now it can be upgraded.

### Security
- `.encrypted()` fields (AES-256-GCM, key rotation), per-account login lockout, common and personal
  password rules, JSON depth/size guard, `security.*` events.
- Exposure matrix and `calm audit` (dynamic authorization testing on a throwaway database).
- `calm doctor`: personal data exposure, hardcoded secrets, `.env` in git, `--audit` (npm audit).
- `totp` block (two-factor authentication), `calm keygen`, `calm admin`.

### AI and humans, side by side
- `calm dev` records file changes (with diffs, attributed to agents), restarts and crashes; devtools
  streams them live with agent tool calls and agent-tagged requests.
- `calm mcp` tools: calm_http (call the API as any user), calm_test, calm_audit, calm_security,
  calm_activity, plus project/routes/resources/scaffolding/doctor/blocks/requests/logs/mails.

### Framework (`calm/`)
- Resources declared once with `f.*()` fields drive the Mongoose schema, validation, output visibility,
  query allowlists and OpenAPI. Unknown, read-only and hidden fields are rejected (no mass assignment).
- Policies on every route (`public`, `authenticated`, `owner`, roles, functions), field-level
  `visibleTo`/`writableBy`, owner scoping of lists, 401/403/404 semantics that do not leak record ids.
- Populated references are serialized with the target resource's rules, so private fields never leak.
- Express 5, ESM, return-value handlers, no try/catch boilerplate, custom routes mounted before CRUD.
- Auth: opaque hashed sessions, scrypt passwords (node:crypto), no account enumeration, single-use
  reset tokens that revoke all sessions, session management endpoints, rate limits.
- Secure defaults: production unless `NODE_ENV` says otherwise, security headers, configurable CORS,
  request ids, structured logs, health checks, graceful shutdown, config validation at boot.
- OpenAPI 3.1 generated from code, Standard Schema support, in-process events, plugin API, test helpers.
- Devtools collector at `/_calm` (development only, loopback only).
- Runtime dependencies of a new project: `express` and `mongoose`.

### CLI
- `create`, `dev`, `make resource`, `add`, `routes`, `openapi`, `doctor`, `upgrade`, `mcp`. Zero dependencies.
- `calm.lock` and `calm upgrade` (three-way merge of framework updates into your edited copy).
- `calm doctor` with security advisories for owned code, including 1.x projects.
- `calm mcp`: MCP server for coding agents.

### Blocks
`jobs`, `storage-local`, `storage-s3`, `realtime-sse`, `mcp-server`, `audit-log`, `soft-delete`,
`api-docs`, `mail-resend`, `mail-smtp`, `rate-limit-mongo` (shadcn registry-item format).

### Packages
`calmapi` (CLI), `create-calmapi`, `@calmapi/devtools`.

See MIGRATION.md for moving from 1.x.
