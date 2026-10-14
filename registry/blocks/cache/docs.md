# Response cache (cache)

Caches the JSON answers of the GET routes you choose, in MongoDB (shared by every instance, expired by a TTL index) or in memory (an LRU per process). Safe by default: entries are keyed per identity so one user never receives another user's answer, only clean 200 JSON answers are stored, and resource events clear what they change. Answers get strong ETags (`If-None-Match` gives `304`), `Cache-Control` and an `x-cache: hit | miss` header. No dependencies.

```bash
npx calm add cache
```

| Adds | |
| --- | --- |
| Files | `app/blocks/cache/index.js` (the guard, keys, invalidation, headers), `stores.js` (memory and MongoDB stores, the store interface) |
| Collection | `calm_cache` (with the default `store: 'mongo'`; bodies encrypted at rest when `CALM_ENCRYPTION_KEYS` is set) |

## Choosing routes

A custom route opts in with `meta.cache`:

```js
// app/routes.js or app/resources/post/post.routes.js
r.get('/stats', { policy: 'public', meta: { cache: '60s' } }, computeStats);
r.get('/featured', { policy: 'public', meta: { cache: { ttl: '5m', tags: ['user'] } } }, featured);
```

Generated CRUD routes are listed in `calm.config.js`, with their full path:

```js
export default defineConfig({
  blocks: {
    cache: {
      routes: {
        'GET /api/posts': '30s',
        'GET /api/posts/:id': { ttl: '5m', tags: ['user'] }, // also cleared by user events (author names)
      },
    },
  },
});
```

A setting is a duration (`'500ms'`, `'30s'`, `'5m'`, `'1h'`, a number of ms), `true` for the default `ttl`, or `{ ttl, tags, vary }`.

## What a cached answer looks like

```http
GET /api/posts?limit=10 HTTP/1.1

HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
ETag: "kH3s0dbE8Jm8b0g7bTnB0bJk3vF6t1zQ2c9x4Wq5YyA"
x-cache: hit
Cache-Control: public, max-age=0, must-revalidate
Vary: Authorization
```

Send the ETag back to get `304 Not Modified` with no body, whether the answer came from the cache or was just computed:

```http
GET /api/posts?limit=10 HTTP/1.1
If-None-Match: "kH3s0dbE8Jm8b0g7bTnB0bJk3vF6t1zQ2c9x4Wq5YyA"

HTTP/1.1 304 Not Modified
```

## Invalidation

- **Resource events.** `post.created`, `post.updated`, `post.deleted` (and `post.restored`) clear every entry of the post routes and of routes tagged `'post'`.
- **Tags.** `tags: ['user']` on a route makes user events clear it too: use it when an answer embeds another resource.
- **By hand.** In a handler `ctx.cache.invalidate('post')` (a tag) or `ctx.cache.invalidate('/api/reports')` (every path starting with it); elsewhere `app.ext.cache.invalidate(...)` and `app.ext.cache.clear()`. Do it when data changes outside a resource service (a raw `updateMany`, an import script, another system).
- **TTL.** Everything else (answers that depend on time, untagged custom routes) expires after its `ttl`.

## The safety rules

1. **The key holds the identity.** Method, path, query (keys sorted, so `?a=1&b=2` and `?b=2&a=1` share an entry) and who is asking: `anonymous`, or the user id with their roles and credential scopes. A signed-in user only reads entries produced by their own requests, under the roles they have now.
2. **Sharing between users is opt-in and checked.** `vary: 'roles'` shares entries between users with the same roles. It is refused at boot on routes whose answer depends on ownership: an `owner` or function policy, a `visibleTo()` rule with one, or a service with `scope()` (the starter's `PostService` is one).
3. **Only clean answers are stored.** Status 200, JSON, no `Set-Cookie`, no `Cache-Control: no-store` from the handler, at most `maxBodyKb`.
4. **Last guard.** The cache answers from a guard that runs after every other guard (API key scopes, plans, maintenance), with `order: 1000`.
5. **No stale write-back.** A response computed while an invalidation touched its tags is not stored.
6. **No stampede.** Concurrent misses for one key run the handler once per process; the others wait (up to `waitMs`) and get its answer.
7. **Headers that change the answer join the key.** If a route reads a header (a tenant id, `Accept-Language`), list it in `varyHeaders`.

## Options

| Option | Default | |
| --- | --- | --- |
| `store` | `'mongo'` | `'mongo'`, `'memory'`, or your own object with `get`, `set`, `deleteTag`, `deletePrefix`, `clear` (see `stores.js`) |
| `ttl` | `'60s'` | For routes that say `cache: true` or give no ttl |
| `routes` | `{}` | `{ 'GET /api/posts': '30s' }` |
| `maxEntries` | `1000` | Memory store size (least recently used goes first) |
| `maxBodyKb` | `512` | Bigger answers are served, not stored |
| `varyHeaders` | `[]` | Request headers added to the key |
| `browserMaxAge` | `0` | `max-age` for anonymous answers on public routes (0: browsers and CDNs revalidate every time, cheaply, with the ETag) |
| `waitMs` | `5000` | How long concurrent misses wait for the first one |

`Cache-Control` is `public, max-age=<browserMaxAge>, must-revalidate` with `Vary: Authorization` for anonymous answers on routes whose policy includes `public`, and `private, no-cache` for everything else (never stored by shared caches). A `Cache-Control` set by the handler is kept.

## Memory or MongoDB

The memory store is the fastest, but each process has its own copy and only clears it for changes it saw. With more than one instance, keep `store: 'mongo'`: entries and invalidations are shared. Stampede protection works with both, per process.

## Devtools and doctor

Each request's path shows a `cache` step (`hit` or `miss`) and the request record carries `cache`. The `cache` panel shows hits, misses, stored and skipped counts. `calm doctor` reports route patterns that match no GET route and unsafe settings.

## Frontend

Browsers revalidate automatically with the ETag. With `fetch`, keep the ETag yourself for cheap polling:

```js
let etag = null;
let posts = [];
async function refresh() {
  const res = await fetch('/api/posts?limit=20', { headers: etag ? { 'if-none-match': etag } : {} });
  if (res.status === 304) return posts; // unchanged, no body sent
  etag = res.headers.get('etag');
  posts = (await res.json()).data;
  return posts;
}
```
