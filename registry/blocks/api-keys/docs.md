# API keys (api-keys)

Let your users create API keys for scripts, CI jobs and integrations. A key is shown once,
stored only as a SHA-256 hash, and sent like a session token (`Authorization: Bearer calm_ak_...`).
Scopes narrow what each key can do (`posts:read`, `posts:write`, `read`, `*`), your policies still
apply on top, so a key never does more than its owner. Keys expire (90 days by default), record
when and from where they were last used, can be revoked by their owner or an admin, and can never
manage keys, passwords or sessions. The `calm_ak_` prefix lets secret scanners find leaked keys,
and a built-in checksum rejects typos before any database lookup. Zero dependencies.

```bash
npx calm add api-keys
```

## Adds

| | |
|---|---|
| Files | `app/blocks/api-keys/index.js` (routes, authentication, scope guard, devtools panel, doctor checks), `app/blocks/api-keys/keys.js` (key format and checksum), `app/blocks/api-keys/scopes.js` (scope rules) |
| Environment | none |

Keys live in the `calm_api_keys` collection. Revoked and expired keys stay visible for 30 days,
then MongoDB deletes them.

## Create a key

Keys are created from a signed-in session (an API key cannot create keys).

```bash
curl -X POST http://localhost:5001/api/auth/api-keys \
  -H "Authorization: Bearer $SESSION_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{ "name": "GitHub Actions deploy", "scopes": ["posts:read", "posts:write"], "expiresInDays": 30 }'
```

```json
{
  "data": {
    "id": "6650c0ffee0000000000abcd",
    "name": "GitHub Actions deploy",
    "prefix": "calm_ak_X7pQ2m",
    "scopes": ["posts:read", "posts:write"],
    "status": "active",
    "createdAt": "2026-10-12T09:30:00.000Z",
    "lastUsedAt": null,
    "lastUsedIp": null,
    "expiresAt": "2026-11-11T09:30:00.000Z",
    "key": "calm_ak_X7pQ2m...",
    "note": "Copy this key now. It is not stored and will not be shown again."
  }
}
```

| Field | Default | |
|---|---|---|
| `name` | required | What the key is for, up to 100 characters |
| `scopes` | `["read"]` | See [Scopes](#scopes). Unknown scopes are refused with a 422 that lists the valid ones |
| `expiresInDays` | `90` | 1 to 365. `null` (never expires) only when `allowNoExpiry` is on |

## Use a key

Send it exactly like a session token:

```bash
curl http://localhost:5001/api/posts -H "Authorization: Bearer $CALM_API_KEY"
```

```js
const res = await fetch('https://api.example.com/api/posts', {
  headers: { Authorization: `Bearer ${process.env.CALM_API_KEY}` },
});
```

`GET /api/auth/me` works with any key, so a script can check which account it acts as.

In your own routes, `ctx.auth` says how the request signed in:

```js
r.get('/reports', { policy: 'authenticated' }, (ctx) => {
  ctx.auth; // { via: 'api-key', scopes: ['reports:read'], id: '<key id>' }
            // or { via: 'session', scopes: ['*'], id: '<session id>' }
});
```

## Scopes

| Scope | Allows |
|---|---|
| `*` | Everything the key's user can do |
| `read` | Every GET request (routes with their own scope excepted) |
| `posts:read` | GET requests to `/api/posts...` |
| `posts:write` | POST, PUT, PATCH and DELETE requests to `/api/posts...` (it does not include reading) |
| `posts:*` | Both, plus any custom `posts:<name>` scope |
| `reports:export` | A custom scope a route asks for (see below) |

The name before the colon is the first segment of the URL after `/api`: `/api/posts/123/publish`
needs `posts:write`, `/api/reports/monthly` needs `reports:read`. List every scope your app has,
with a description, for a key creation form:

```bash
curl http://localhost:5001/api/auth/api-keys/scopes -H "Authorization: Bearer $SESSION_TOKEN"
```

Scopes only narrow access. Policies, service `scope()` filters and field rules run as usual after
the scope check, so a key of a normal user still cannot list users, and a disabled user's keys stop
working immediately. A missing scope answers 403 with the scope it needs:

```json
{ "error": { "code": "FORBIDDEN", "message": "This API key does not have the \"posts:write\" scope" } }
```

### Custom route scopes

Give a sensitive route its own scope in `calm.config.js`. Only `*`, that exact scope or
`reports:*` can call it (`read` and `reports:write` cannot):

```js
export default defineConfig({
  blocks: {
    'api-keys': {
      routeScopes: { 'POST /reports/export': 'reports:export' },
    },
  },
});
```

`calm doctor` warns when an entry matches no route.

### What keys can never do

Keys cannot call `/api/auth/*` (except `GET /api/auth/me`): no creating or revoking keys, no
password changes, no sessions, no 2FA changes, no profile edits through `/auth/me`. A leaked key
must not be able to lock its owner out or mint more keys. These need a signed-in session.

## List and revoke

```bash
# Your keys (never the keys themselves): name, prefix, scopes, status, createdAt, lastUsedAt, lastUsedIp, expiresAt
curl http://localhost:5001/api/auth/api-keys -H "Authorization: Bearer $SESSION_TOKEN"

# Revoke one
curl -X DELETE http://localhost:5001/api/auth/api-keys/6650c0ffee0000000000abcd -H "Authorization: Bearer $SESSION_TOKEN"
```

`lastUsedAt` and `lastUsedIp` are updated at most once a minute per key.

Admins see every key with its owner and can revoke any of them:

```bash
curl 'http://localhost:5001/api/admin/api-keys?status=active' -H "Authorization: Bearer $ADMIN_SESSION"
curl -X DELETE http://localhost:5001/api/admin/api-keys/6650c0ffee0000000000abcd -H "Authorization: Bearer $ADMIN_SESSION"
```

Filters: `status` (`active`, `expired`, `revoked`), `user` (a user id), `limit` (up to 200).

A password reset (the account recovery flow) revokes every key of that user, in case an attacker
created one. A normal password change does not.

## Service keys

For a server-to-server integration, create a dedicated user (for example `billing-sync@example.com`
with only the roles it needs), sign in as that user and create a key, or create it from a script:

```js
import { createApp } from '#calm';

const app = await createApp();
await app.start();
const bot = await app.model('user').findOne({ email: 'billing-sync@example.com' });
const { key } = await app.ext.apiKeys.create(bot, { name: 'Billing sync', scopes: ['invoices:write'], expiresInDays: 90 });
console.log(key); // store it in the other service's secret manager
await app.stop();
```

`app.ext.apiKeys` also has `revoke(id)`, `scopes()` and `model` (the Mongoose model).

## AI agents (MCP)

With the `mcp-server` block, an agent can use an API key instead of a session. Tool calls go
through your API with the same header, so with a `posts:read` key the agent can call `post_list`
and `post_get`, and `post_create` is refused.

## Settings

All optional, in `calm.config.js`:

```js
export default defineConfig({
  blocks: {
    'api-keys': {
      policy: 'authenticated', // who may create keys, e.g. 'admin'
      maxKeysPerUser: 20, // active keys per user (409 API_KEY_LIMIT beyond)
      defaultExpiryDays: 90,
      maxLifetimeDays: 365,
      allowNoExpiry: false, // allow { expiresInDays: null }
      defaultScopes: ['read'],
      routeScopes: {},
      revokeOnPasswordReset: true,
    },
  },
});
```

## Security events and checks

| Event | When |
|---|---|
| `security.api_key_created` | A key was created (`userId`, `keyId`, `prefix`, `scopes`, `expiresAt`, `ip`) |
| `security.api_key_revoked` | A key was revoked (`by`, `reason`: `user`, `admin` or `script`) |
| `security.api_keys_revoked` | A password reset revoked a user's keys |
| `security.invalid_api_key` | A key was refused (`reason`: `checksum`, `unknown`, `revoked`, `expired`, `user_disabled`, `user_deleted`) |

Events never contain the key. They show up live in the devtools Security panel, and your own
listeners can alert on them: `calm.on('security.invalid_api_key', ...)`. The devtools **API keys** panel lists keys with owner, prefix,
scopes and last use. The devtools Doctor panel counts active keys and warns about keys with the `*`
scope that never expire (the `calm doctor` command does not connect to the database, so it only
checks your settings).

## Leaked keys

Every key starts with `calm_ak_` followed by 38 letters and digits; the last 6 are a CRC32
checksum. Add this pattern to your secret scanner (GitHub custom patterns, GitGuardian, gitleaks):

```
calm_ak_[0-9A-Za-z]{38}
```

When a key leaks, revoke it (`DELETE /api/auth/api-keys/:id`, or an admin with
`DELETE /api/admin/api-keys/:id`). The `prefix` field (`calm_ak_X7pQ2m`) tells you which key it is.
