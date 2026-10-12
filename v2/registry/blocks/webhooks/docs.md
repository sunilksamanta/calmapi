# Webhooks (webhooks)

Outgoing webhooks for your API. Your users (and admins) register a URL, pick events like `order.created` or `order.*`, and receive an HTTP POST every time a matching record changes. Each user only receives records they are allowed to read, serialized exactly like the REST API would return them to that user. Requests are signed with the [Standard Webhooks](https://www.standardwebhooks.com) scheme, queued in MongoDB, retried with backoff and logged per endpoint. URLs pointing at localhost, private networks or cloud metadata services are refused in production. No dependencies.

```bash
npx calm add webhooks
```

| Adds | |
| --- | --- |
| Files | `app/blocks/webhooks/index.js` (plugin, API, events), `delivery.js` (queue and sender), `signing.js` (signatures, `verifyWebhook`), `ssrf.js` (URL safety), `visibility.js` (who may see a record) |
| Environment | `WEBHOOKS_WORKER=on` (set `off` on instances that should not send webhooks) |

Collections: `calm_webhooks` (endpoints) and `calm_webhook_deliveries` (queue and delivery log, cleaned up by a TTL index).

## Quick start

Create an endpoint as a signed-in user. The response is the only time the signing secret is shown:

```bash
curl -X POST http://localhost:5001/api/webhooks \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/calm", "events": ["post.created", "post.updated"] }'
```

```json
{
  "data": {
    "id": "6650c0ffee0000000000abcd",
    "url": "https://example.com/hooks/calm",
    "events": ["post.created", "post.updated"],
    "scope": "own",
    "enabled": true,
    "status": "active",
    "secret": "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw..."
  }
}
```

Then send yourself a test event, and look at the delivery log:

```bash
curl -X POST http://localhost:5001/api/webhooks/6650c0ffee0000000000abcd/test -H "Authorization: Bearer $TOKEN"
curl http://localhost:5001/api/webhooks/6650c0ffee0000000000abcd/deliveries -H "Authorization: Bearer $TOKEN"
```

Event names are `<resource>.created`, `<resource>.updated`, `<resource>.deleted` (and `<resource>.restored` with the soft-delete block). Use `<resource>.*` for all of them, or `*` for every resource.

## What receivers get

A `POST` with a JSON body and three headers:

```http
POST /hooks/calm HTTP/1.1
content-type: application/json
webhook-id: msg_9xGkV2bS1tHq0wZ3cYp4Lw
webhook-timestamp: 1767225600
webhook-signature: v1,K5oZfzN95Z9UVu1EsfQmfVNQhnkZ2pj9o9NDN/H/pI4=

{"type":"post.created","timestamp":"2026-01-01T00:00:00.000Z","data":{"id":"6650...","title":"Hello","status":"published","author":"6650...","createdAt":"...","updatedAt":"..."}}
```

- `webhook-id` is the same on every retry of a message: store it and skip duplicates.
- `webhook-timestamp` is the time of this attempt, so old messages cannot be replayed.
- `webhook-signature` is `v1,` followed by the base64 HMAC-SHA256 of `id.timestamp.body`, keyed with the base64-decoded part of the secret after `whsec_`. During a secret rotation it holds two signatures separated by a space.
- `data` is the record as the endpoint owner would see it from `GET /api/<resource>/:id`. Deleted records are sent as they were just before deletion.

Answer with any `2xx` status quickly (do slow work in the background). Anything else, a redirect or no answer within 10 seconds counts as a failure.

## Verifying signatures

The block exports `verifyWebhook(secret, headers, rawBody)`. It checks the signature in constant time and refuses timestamps more than 5 minutes away from now, then returns the parsed payload or throws a `WebhookVerificationError`. It needs the raw body: parsing the JSON and serializing it again changes the bytes.

`app/blocks/webhooks/signing.js` only imports `node:crypto`, so copy it into the app that receives the webhooks. Any Standard Webhooks library (for example the `standardwebhooks` npm package) works too.

```js
import express from 'express';
import { verifyWebhook } from './signing.js';

const app = express();

app.post('/hooks/calm', express.raw({ type: 'application/json' }), (req, res) => {
  let event;
  try {
    event = verifyWebhook(process.env.CALM_WEBHOOK_SECRET, req.headers, req.body);
  } catch {
    return res.sendStatus(401);
  }
  if (event.type === 'post.created') queuePostSync(event.data);
  res.sendStatus(204);
});
```

With plain `node:http` or a fetch-style handler, pass the body as a string or Buffer and the headers as they are (`req.headers` or a `Headers` object).

## Who receives what

- **Own endpoints** (the default) receive a record only if their owner may read it through the API: the resource's `read` policy, owner scoping (`'owner'`), and the service `scope()` (drafts, tenants...). The payload is serialized for that owner, so `hidden()` fields never appear and `visibleTo()` fields only appear for users allowed to see them. With the starter template, Bob's endpoint does not receive Alice's draft posts, and receives the post once she publishes it.
- **Global endpoints** receive every record of the events they follow, whatever its read policy, serialized with the admin's view (hidden fields still never appear). The service `scope()` still applies, so in a multi-tenant app a tenant admin only receives their tenant's records. Only users matching `globalPolicy` (default `'admin'`) can create them, and they stop receiving events if their owner loses that role:

```json
{ "url": "https://ops.example.com/hooks", "events": ["*"], "scope": "global" }
```

Endpoints belong to their owner: other users get `404` for every route of an endpoint that is not theirs. Disabled users receive nothing, and a deleted user's endpoints and delivery log are removed.

Keep a resource out of webhooks entirely with `webhooks: false` in its `resource()` options.

## Retries and failures

Deliveries are queued in MongoDB and sent by a worker in every instance (a delivery is claimed atomically, so it is never sent twice). A failed attempt is retried after 5s, 30s, 2m, 10m, 30m, 2h and 6h (each with random jitter of 20%, and longer when the receiver sends `Retry-After`), then the delivery is marked `failed`.

- `410 Gone` turns the endpoint off at once: the receiver is telling you to stop.
- After `disableAfterFailures` deliveries in a row (default 5) fail every retry, the endpoint is turned off.
- When an endpoint is turned off, the block emits `webhook.disabled` with `{ webhook, owner, reason }` (`'gone'`, `'failing'` or `'manual'`) and emails the owner (turn that off with `notifyOwner: false`).

```js
// In any block: also alert your team
calm.on('webhook.disabled', ({ webhook, reason }) => {
  if (reason !== 'manual') calm.log.warn(`Webhook ${webhook.id} turned off: ${reason}`);
});
```

The owner turns it back on with `PATCH /api/webhooks/:id { "enabled": true }`, which also resets its failure counters.

### The delivery log

`GET /api/webhooks/:id/deliveries?status=failed&limit=20` returns the latest deliveries (newest first):

```json
{
  "id": "6650...",
  "type": "post.updated",
  "messageId": "msg_9xGkV2bS1tHq0wZ3cYp4Lw",
  "status": "succeeded",
  "attempts": 3,
  "statusCode": 200,
  "durationMs": 84,
  "error": null,
  "nextAttemptAt": null,
  "response": "ok",
  "payload": "{\"type\":\"post.updated\",...}",
  "payloadTruncated": false,
  "attemptLog": [
    { "at": "...", "statusCode": 500, "durationMs": 12, "error": "HTTP 500" },
    { "at": "...", "statusCode": 500, "durationMs": 9, "error": "HTTP 500" },
    { "at": "...", "statusCode": 200, "durationMs": 84, "error": null }
  ]
}
```

The receiver's answer is kept up to 1 KB and the payload preview up to 2 KB. Entries are deleted `keepDeliveriesDays` (default 14) after they finish. `POST /api/webhooks/:id/deliveries/:deliveryId/retry` sends one again right away, with the same `webhook-id` and a fresh retry schedule.

## Rotating the secret

```bash
curl -X POST http://localhost:5001/api/webhooks/6650c0ffee0000000000abcd/rotate-secret -H "Authorization: Bearer $TOKEN"
```

The response shows the new secret (once). For `secretGraceHours` (default 24) every message is signed with both the new and the old secret, so receivers can switch without missing anything.

Secrets have to be readable to sign messages, so they cannot be hashed. Set `CALM_ENCRYPTION_KEYS` (`npx calm keygen --write`) and they are encrypted at rest with AES-256-GCM, together with queued payloads (which can contain fields your resources store `.encrypted()`).

## SSRF protection

Webhook URLs are typed by users and called by your server, so they are checked twice: when an endpoint is saved, and on every delivery.

- Only `http://` and `https://`, no user name or password in the URL. In production, `https://` only (`requireHttps`).
- In production, hosts must be public. Refused: `localhost`, loopback (`127.0.0.0/8`, `::1`), private networks (`10/8`, `172.16/12`, `192.168/16`, `fc00::/7`), link-local and cloud metadata (`169.254.169.254`, `fd00:ec2::254`, `100.100.100.200`, `192.0.0.192`), carrier-grade NAT (`100.64/10`), multicast, reserved and documentation ranges, and IPv6 forms that carry such an IPv4 address (`::ffff:127.0.0.1`, NAT64, 6to4).
- Host names are resolved and every address must be public. When sending, the connection goes to the address that was checked, so a DNS answer that changes in between (DNS rebinding) cannot reach your network.
- Redirects are never followed: a `3xx` answer is a failed attempt.

In development and tests (`allowPrivate`, default on outside production) local receivers such as `http://localhost:4000/hooks` work. `calm doctor` warns if `allowPrivate` is on in production.

## Options

Set them in `calm.config.js`:

```js
export default defineConfig({
  blocks: {
    webhooks: {
      maxEndpointsPerUser: 5,
      retrySchedule: ['10s', '1m', '10m', '1h', '6h', '24h'],
      policy: 'admin', // only admins manage webhooks
    },
  },
});
```

| Option | Default | |
| --- | --- | --- |
| `policy` | `'authenticated'` | Who may create and manage their own endpoints |
| `globalPolicy` | `'admin'` | Who may create `scope: 'global'` endpoints |
| `allowPrivate` | on in development and test | Allow localhost and private addresses |
| `requireHttps` | on in production | Refuse `http://` URLs |
| `maxEndpointsPerUser` | `10` | Endpoints per user |
| `maxEventsPerEndpoint` | `20` | Event names per endpoint |
| `maxUrlLength` | `2048` | Characters |
| `retrySchedule` | `['5s', '30s', '2m', '10m', '30m', '2h', '6h']` | Waits between attempts (milliseconds or `'30s'`, `'5m'`, `'2h'`, `'1d'`) |
| `timeoutMs` | `10000` | Time a receiver has to answer |
| `pollMs` | `1000` | How often the worker looks for due deliveries |
| `concurrency` | `10` | Deliveries in flight per instance |
| `disableAfterFailures` | `5` | Failed deliveries in a row before the endpoint is turned off (`0`: never) |
| `keepDeliveriesDays` | `14` | Delivery log retention |
| `secretGraceHours` | `24` | How long the old secret keeps signing after a rotation |
| `notifyOwner` | `true` | Email the owner when an endpoint is turned off automatically |

## API

| Route | |
| --- | --- |
| `POST /api/webhooks` | Create `{ url, events, description?, scope? }`, returns the secret once |
| `GET /api/webhooks` | Your endpoints |
| `GET /api/webhooks/:id` | One endpoint (status, last success, last error) |
| `PATCH /api/webhooks/:id` | Change `url`, `events`, `description`, `enabled` |
| `DELETE /api/webhooks/:id` | Delete the endpoint and its delivery log |
| `POST /api/webhooks/:id/rotate-secret` | New secret, shown once |
| `POST /api/webhooks/:id/test` | Send a `webhook.test` event now and return the delivery |
| `GET /api/webhooks/:id/deliveries` | Recent deliveries (`?status=`, `?limit=` up to 100) |
| `POST /api/webhooks/:id/deliveries/:deliveryId/retry` | Send a delivery again now |

`test` and `retry` are rate limited (10 a minute per client) since they make your server send requests.

From server code, `ctx.app.ext.webhooks` gives the `Webhook` and `Delivery` models, `drain()` (send everything that is due now, handy in tests) and `verifyWebhook`.

## Devtools, doctor and production

- The **Webhooks** devtools panel lists endpoints with their status and the latest deliveries with status codes, errors and next retries.
- `calm doctor` reports how many endpoints exist, warns about endpoints that are currently failing, about `allowPrivate` in production, and about secrets stored without `CALM_ENCRYPTION_KEYS`.
- With several instances, every instance sends deliveries from the shared queue. Set `WEBHOOKS_WORKER=off` on instances that should not (for example web servers when a separate worker process runs).
- Deliveries are not ordered: use `timestamp` (or fetch the record) when order matters.

## Testing your webhooks

Test apps run the worker too, and local receivers are allowed in tests. Point an endpoint at a local server, then call `drain()` instead of waiting for the next poll:

```js
const t = await createTestApp({
  root: join(import.meta.dirname, '..'),
  config: { blocks: { webhooks: { retrySchedule: [20, 20] } } }, // retries in milliseconds
});

const alice = await t.signup();
await t.post('/webhooks', { url: `${receiverUrl}/hooks`, events: ['post.created'] }, alice);
await t.post('/posts', { title: 'Hi', body: '...' }, alice);
await t.idle(); // event listeners have queued the deliveries
await t.app.ext.webhooks.drain(); // and they are sent
```
