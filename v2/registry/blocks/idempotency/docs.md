# Idempotency keys (idempotency)

A client creates an order, the network drops before the answer arrives, and the client cannot tell
whether the order exists. Retrying blindly can charge twice. With this block the client sends an
`Idempotency-Key` header with each POST, PATCH, PUT or DELETE; if it sends the same request again
with the same key, the API answers with the response it stored the first time instead of running
the operation again. It follows the IETF draft
[The Idempotency-Key HTTP Header Field](https://datatracker.ietf.org/doc/draft-ietf-httpapi-idempotency-key-header/),
the scheme Stripe and others use.

```bash
npx calm add idempotency
```

## Adds

| | |
|---|---|
| Files | `app/blocks/idempotency/index.js` |
| Environment | None. Settings live in `calm.config.js` under `blocks.idempotency`. |

Stored keys and responses live in the `calm_idempotency` collection, removed by a TTL index.

## Send a key

Generate one key per operation (a UUID is a good choice) and reuse it only for retries of that
operation:

```bash
KEY=$(uuidgen)
curl -i -X POST http://localhost:5001/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: \"$KEY\"" \
  -d '{ "item": "book", "qty": 2 }'
# HTTP/1.1 201 Created
# { "data": { "id": "6acd...", "item": "book", "qty": 2 } }
```

The draft writes the key as a quoted string (`"8e03978e-..."`); the bare form (`8e03978e-...`) works
too and is the same key. A key is 1 to 255 visible ASCII characters; anything else answers
`400 IDEMPOTENCY_KEY_INVALID`.

## Retry safely

Send exactly the same request again (same method, path, body and key):

```bash
curl -i -X POST http://localhost:5001/api/orders \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: \"$KEY\"" \
  -d '{ "item": "book", "qty": 2 }'
# HTTP/1.1 201 Created
# Idempotent-Replayed: true
# { "data": { "id": "6acd...", "item": "book", "qty": 2 } }   (the same order, not a new one)
```

The replay has the stored status, body and a safe subset of headers (`Content-Type`, `Location`,
`ETag`, `Last-Modified`, `Link`, `Cache-Control`, `Content-Disposition`, `Content-Language`,
`Content-Location`), plus `Idempotent-Replayed: true` (also exposed to browsers through CORS).
Cookies, rate limit headers and the request id are never stored; each request keeps its own
`X-Request-Id`.

What a retry gets:

| Situation | Answer |
|---|---|
| First time | the route runs normally; its response is stored |
| Same key, same request, first one finished | the stored response, `Idempotent-Replayed: true` |
| Same key, same request, first one still running | `409 IDEMPOTENCY_IN_PROGRESS`, `Retry-After: 1` |
| Same key, different body or query string | `422 IDEMPOTENCY_KEY_REUSED` |
| First one answered 5xx | nothing was stored: the retry runs the route again |
| First one answered 4xx | stored and replayed: fix the request and use a new key |
| No key | the route runs normally (unless the route is in `required`) |

```bash
# Same key, different body:
curl -i -X POST http://localhost:5001/api/orders \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -H "Idempotency-Key: \"$KEY\"" -d '{ "item": "pen" }'
# HTTP/1.1 422 Unprocessable Content
# { "error": { "code": "IDEMPOTENCY_KEY_REUSED", "message": "This Idempotency-Key was already used for a different request. Use a new key for a new request." } }
```

"Same request" means the same SHA-256 fingerprint of the JSON body (object keys sorted, so key
order does not matter) and the query string. Multipart uploads are not parsed yet when the key is
checked (guards run before upload middleware), so their form fields and files are not part of the
fingerprint: give each upload its own key.

## Who can see a stored response

Keys are scoped to the caller: the signed-in user (any credential that resolves to that user, such
as an API key), or the client IP for anonymous requests, plus the method and the path. Another user
sending the same key gets their own fresh execution, never your response. Only a SHA-256 of
the scope, method, path and key is used as the record id.

GET, HEAD and OPTIONS ignore the header (they are safe to retry already).

## Require a key on some routes

```js
// calm.config.js
export default defineConfig({
  blocks: {
    idempotency: {
      required: ['POST /api/orders', 'POST /api/payments/:id/capture'],
      docsUrl: 'https://example.com/docs/idempotency',
    },
  },
});
```

Patterns are a method (or `*`) and a path with the `/api` prefix; `:name` and `*` match one path
segment and a final `**` matches the rest. Without the header those routes answer:

```bash
curl -i -X POST http://localhost:5001/api/orders -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{ "item": "book" }'
# HTTP/1.1 400 Bad Request
# Link: <https://example.com/docs/idempotency>; rel="describedby"; type="text/html"
# { "error": { "code": "IDEMPOTENCY_KEY_MISSING", "message": "POST /api/orders needs an Idempotency-Key header: a unique value per operation, such as a UUID" } }
```

With `docsUrl` set, every idempotency error carries the `Link` header the draft recommends.
`calm doctor` warns about patterns that match no route.

## Expiry

Keys and responses are kept for `ttlHours` (default 24) after the response, then MongoDB removes
them (TTL index on `expiresAt`). A retry after that runs the operation again, so tell your API
clients: retries are safe for 24 hours. The draft asks servers to publish this policy.

A request that is still running holds its key for at most `lockTimeoutSeconds` (default 300). If the
process crashed mid-request, a retry after that takes the key over and runs the operation.

## How it works

A guard runs after authentication and body parsing, before the route's policy check. It claims the
key by inserting a `{ status: 'running' }` document (the unique `_id` makes the insert the lock, so two
instances cannot both run the same key). The response is captured as it is written; before it is
released to the client the document becomes `{ status: 'done', response }`, so a retry arriving
right after the response always finds it. A 5xx deletes the document instead.

Responses over `maxResponseKb` (default 1024) are not stored: a replay gets the stored status and
headers with an empty body, and the operation still does not run twice.

## Options

| Option | Default | |
|---|---|---|
| `methods` | `['POST', 'PATCH', 'PUT', 'DELETE']` | methods that honor the header |
| `required` | `[]` | route patterns that must carry a key (`400` otherwise) |
| `ttlHours` | `24` | how long keys and responses are kept |
| `lockTimeoutSeconds` | `300` | after this, a running request's key is considered abandoned |
| `maxResponseKb` | `1024` | larger response bodies are not stored |
| `docsUrl` | `null` | documentation link sent with idempotency errors |

From code: `app.ext.idempotency.model` (the Mongoose model of `calm_idempotency`) and
`app.ext.idempotency.parseKey(header)`.
