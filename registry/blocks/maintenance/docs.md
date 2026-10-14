# Maintenance mode (maintenance)

Take the API down for maintenance, or make it read-only, without a deploy. Admins switch modes at runtime; the state lives in MongoDB and every instance follows it within a few seconds. Blocked requests get `503` with `Retry-After` and a message your frontend can show, admins and allowlisted IPs keep working, health checks and devtools are never affected, and maintenance windows can be scheduled ahead with a public status route for banners.

```bash
npx calm add maintenance
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/maintenance/index.js` |
| Environment | `MAINTENANCE_MODE` (optional): `maintenance` or `read-only` forces that mode without the database. |
| Routes | `GET /api/maintenance`, `GET /api/admin/maintenance`, `PATCH /api/admin/maintenance`, `POST /api/admin/maintenance/windows`, `DELETE /api/admin/maintenance/windows/:windowId` |
| Collections | `calm_maintenance` (one document) |

## Modes

| Mode | What happens |
| --- | --- |
| `off` | Nothing. |
| `maintenance` | Every API route answers `503 MAINTENANCE`. |
| `read-only` | `GET`, `HEAD` and `OPTIONS` work; every other method answers `503 READ_ONLY`. |

```json
503 Retry-After: 300
{ "error": { "code": "MAINTENANCE", "message": "We are doing some maintenance and will be back shortly.", "requestId": "..." } }
```

`Retry-After` is the seconds until the window (or `until`) ends, otherwise `retryAfterSeconds` (300).

Always let through:

- users with a role in `bypassRoles` (`admin`), in both modes;
- IPs in `allowIps` (options) or stored by admins, exact addresses or IPv4 ranges such as `10.0.0.0/8`;
- `GET /api/maintenance`, `POST /api/auth/login` and `POST /api/auth/logout` (so admins can sign in), plus the routes in `allow`;
- `/health/live`, `/health/ready` and the devtools: they are mounted before the API and never see this block.

## Switching

```http
PATCH /api/admin/maintenance
{ "mode": "maintenance", "message": "Upgrading the database, back at 14:00 UTC", "until": "2026-10-13T14:00:00Z" }
```

| Field | |
| --- | --- |
| `mode` | `off`, `maintenance` or `read-only` |
| `message` | Shown in the `503`. `null` goes back to the default message of the mode. |
| `retryAfterSeconds` | `Retry-After` when there is no end time (1 to 86400). |
| `until` | The switch ends on its own at this time (must be in the future). Switching `off` clears it. |
| `allowIps` | IPs or IPv4 ranges let through, e.g. your office. |

The answer (and `GET /api/admin/maintenance`) is the full state:

```json
{
  "data": {
    "mode": "maintenance", "source": "manual", "message": "Upgrading the database, back at 14:00 UTC",
    "until": "2026-10-13T14:00:00.000Z", "retryAfterSeconds": 1740,
    "stored": { "mode": "maintenance", "message": "...", "retryAfterSeconds": null, "until": "...", "allowIps": [], "updatedAt": "...", "updatedBy": "66f0..." },
    "windows": [], "cacheMs": 5000
  }
}
```

`source` says why the mode applies: `manual`, `window` or `env`.

## Scheduled windows

```http
POST /api/admin/maintenance/windows
{ "start": "2026-10-20T02:00:00Z", "end": "2026-10-20T03:00:00Z", "mode": "read-only", "message": "Planned database upgrade" }
```

Windows start and end on time (they are checked against the clock on every request). A manual mode takes precedence over windows. Cancel one with `DELETE /api/admin/maintenance/windows/:windowId`; ended windows are cleaned up on the next change.

## Banners

`GET /api/maintenance` is public and never cached:

```json
{ "data": { "mode": "off", "message": null, "until": null, "retryAfterSeconds": null, "upcoming": [{ "start": "...", "end": "...", "mode": "read-only", "message": "Planned database upgrade" }] } }
```

```js
const { data } = await (await fetch('/api/maintenance')).json();
if (data.mode !== 'off') showBanner(data.message);
else if (data.upcoming[0]) showBanner(`Planned maintenance on ${new Date(data.upcoming[0].start).toLocaleString()}`);

// and wherever you call the API
if (res.status === 503 && ['MAINTENANCE', 'READ_ONLY'].includes(body.error?.code)) showBanner(body.error.message, { retryIn: Number(res.headers.get('retry-after')) });
```

## Options

```js
export default defineConfig({
  blocks: { maintenance: { cacheMs: 2000, allowIps: ['203.0.113.7'], allow: ['POST /webhooks/stripe'] } },
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `cacheMs` | `5000` | How long an instance trusts its copy of the state. All instances agree within this delay; the instance that made the change applies it at once. |
| `retryAfterSeconds` | `300` | `Retry-After` when no end time is known. |
| `message` | a short default | The `503 MAINTENANCE` message when admins set none. |
| `readOnlyMessage` | a short default | The `503 READ_ONLY` message when admins set none. |
| `allowIps` | `[]` | IPs and IPv4 ranges always let through. |
| `bypassRoles` | `['admin']` | Roles that pass. `[]` makes admins wait too (they can still use the admin routes). |
| `allow` | `[]` | Routes that stay open, `'METHOD /path'` as declared (without `/api`), e.g. incoming webhooks. |

## Deploys and migrations

Set `MAINTENANCE_MODE=maintenance` (or `read-only`) in the environment to force a mode without reading MongoDB, for example while the database is migrated. It overrides the stored state until removed, and `calm doctor` reports it. If MongoDB cannot be read, each instance keeps the last state it knew.

From code (a job, a migration script):

```js
await app.ext.maintenance.set({ mode: 'read-only', until: new Date(Date.now() + 10 * 60_000) });
const { mode, until, source } = await app.ext.maintenance.status();
```

## Security

- Only admins change the mode; the public route shows the mode, its message and upcoming windows, nothing else (no allowlist, no who changed it).
- IP rules compare `req.ip`, which follows `config.trustProxy`. Behind a load balancer set `TRUST_PROXY`, otherwise every request has the proxy's address (and an allowlisted proxy address would let everyone in). Never trust a forwarded header the proxy does not overwrite.
- The guard runs before every other guard (`order: -100`), so a refused request does no other work.
- Every change emits `maintenance.changed` with the new state and the admin's id: hook `audit-log` or your alerts to it.

## Events

| Event | Payload |
| --- | --- |
| `maintenance.changed` | `{ state, by }` |
