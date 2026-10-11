# CalmAPI 2

**The backend framework you own.** Resources, policies, auth, devtools and an upgrade path for
Node.js + MongoDB, with every line of framework code living in your repo.

```bash
npm create calmapi@latest my-api
cd my-api
npm run dev
```

```
  CalmAPI my-api v0.1.0 (development)

  ➜  API       http://localhost:5001/api
  ➜  OpenAPI   http://localhost:5001/api/openapi.json
  ➜  Devtools  http://localhost:5001/_calm
```

> **Status: 2.0.0-alpha.** APIs may still change before 2.0. CalmAPI 1.x users: run
> `npx calmapi@next doctor` inside your project (see [Security](#security)).

## Why CalmAPI

- **Nothing hidden in node_modules.** The framework is copied into `calm/` when you create a project.
  Read it, debug it, change it. A new project has two runtime dependencies: `express` and `mongoose`.
- **Owned, but upgradeable.** `calm.lock` remembers the exact framework files you started from;
  `calm upgrade` three-way merges upstream fixes into your edited copy instead of overwriting it.
- **Declare a field once.** One `f.*()` line drives the Mongoose schema, input validation, what the API
  returns, which filters and sorts are allowed, and the OpenAPI schema.
- **Secure by default.** Hidden fields cannot leak (even through populated references), every route has
  an access policy, list queries are allowlisted, sessions and reset tokens are hashed, auth is rate
  limited, and `NODE_ENV` defaults to production.
- **Devtools.** A local dashboard at `/_calm`: every request with its MongoDB queries and timings,
  explain plans, a privacy lens on your data, a mail catcher, "act as" any user, and doctor findings.
- **Agent native.** Projects ship with `AGENTS.md`, and `calm mcp` gives coding agents tools to inspect
  routes, scaffold resources, run doctor and read live requests from the dev server.
- **Blocks, shadcn style.** `calm add jobs` copies production code (a MongoDB job queue, file storage,
  realtime, audit log, an MCP server for your API...) into your project. You own that code too.

## A resource

```js
// app/resources/post/post.resource.js
import { resource, f } from '#calm';

export default resource('post', {
  fields: {
    title: f.string().required().max(200).searchable().sortable(),
    body: f.text().required(),
    status: f.enum(['draft', 'published']).default('draft').filterable(),
    tags: f.array(f.string()).filterable(),
    author: f.ref('user').owner(),        // set from the session, powers 'owner'
    internalNote: f.string().hidden(),    // stored, never returned or accepted
  },
  policy: {
    list: 'public',
    read: 'public',
    create: 'authenticated',
    update: 'owner | admin',
    delete: 'owner | admin',
  },
});
```

That file alone gives you:

| Route | Notes |
|---|---|
| `GET /api/posts` | `?status=published&tags[in]=a,b&q=hello&sort=-createdAt&page=2&limit=20&include=author&fields=title` |
| `GET /api/posts/:id` | `?include=author` populates with the author's *public* fields only |
| `POST /api/posts` | validated, unknown/read-only fields rejected with 422, owner set automatically, 201 |
| `PATCH /api/posts/:id` | partial update; 403 for others who can read it, 404 for those who cannot |
| `DELETE /api/posts/:id` | 204 |

Add business logic in a service, custom endpoints in a routes file:

```js
// post.service.js
import { ResourceService, hasRole } from '#calm';

export default class PostService extends ResourceService {
  scope({ user } = {}) {                       // applied to every query
    if (hasRole(user, 'admin')) return {};
    return user ? { $or: [{ status: 'published' }, { author: user.id }] } : { status: 'published' };
  }
  async beforeCreate(data) {
    return { ...data, slug: slugify(data.title) };
  }
}

// post.routes.js  (mounted before CRUD, so /featured never hits /:id)
export default (r) => {
  r.post('/:id/publish', { policy: 'owner | admin' }, (ctx) =>
    ctx.service.update(ctx.params.id, { status: 'published' }, ctx));
};
```

Handlers **return** values (`{ data }` responses, `undefined` is 204) and throw `notFound()`,
`forbidden()`, `validationError({...})`. Express 5 forwards async errors, so there is no try/catch.

### Fields

`f.string() text() email() url() password() number() integer() boolean() date() enum([...]) id() ref('name') array(f) object({...}) json()`

Modifiers: `.required() .default(v) .min(n) .max(n) .pattern(re) .unique() .index() .check(fn) .schema(zodOrAnyStandardSchema)`
Visibility: `.hidden() .writeOnly() .readOnly() .immutable() .writableBy('admin') .visibleTo('owner | admin')`
Queries: `.filterable([ops]) .sortable() .searchable()` · Relations: `.owner() .populate()`

### Policies

`'public'`, `'authenticated'`, `'owner'`, `'admin'` or any role, `'none'`, combined with `|`, or a
function `({ user, doc, action, req }) => boolean`. Policies apply to CRUD, custom routes, field
visibility, realtime events and MCP tool calls alike.

## CLI

```
calm create [dir]                       new project (npm create calmapi@latest)
calm dev                                watch mode + devtools
calm make resource <name> [fields...]   e.g. product name:string! price:number status:enum:draft,live=draft category:ref:category
calm add <block...>                     copy blocks into your project (calm add --list)
calm routes                             every route with its policy and source file
calm openapi                            write openapi.json
calm doctor [--prod] [--ci]             security and correctness checks
calm upgrade                            merge framework updates into calm/
calm mcp                                MCP server for coding agents (claude mcp add calm -- npx calm mcp)
```

## Blocks

| Block | What you get |
|---|---|
| `jobs` | MongoDB job queue and cron (no Redis): retries, schedules, event triggers, admin API |
| `storage-local` / `storage-s3` | uploads with type/size allowlists and safe downloads; S3/R2/MinIO via presigned URLs |
| `realtime-sse` | live resource events, filtered per subscriber by the same policies |
| `mcp-server` | your resources as MCP tools for AI agents, enforced by your API's own rules |
| `audit-log` | who changed what, with field diffs (private values never logged) |
| `soft-delete` | `softDelete: true` per resource, trash and restore |
| `api-docs` | interactive reference at `/docs` |
| `mail-resend` / `mail-smtp` | email delivery |
| `rate-limit-mongo` | shared rate limits across instances |

Blocks use the [shadcn registry item format](https://ui.shadcn.com/docs/registry), so anyone can
publish them: add `"calm": { "registries": { "@acme": "https://acme.dev/r/{name}.json" } }` to
`package.json` and run `calm add @acme/thing`.

## Auth

`POST /api/auth/register · login · logout · logout-all · password · password/forgot · password/reset`,
`GET|PATCH /api/auth/me`, `GET|DELETE /api/auth/sessions`. Opaque session tokens (SHA-256 at rest),
scrypt password hashing from `node:crypto`, no account enumeration, single-use reset tokens that
revoke every session, rate limited.

## Testing

```js
import { createTestApp } from '#calm/testing.js';
const t = await createTestApp({ root });   // throwaway database, random port
const alice = await t.signup();
assert.equal((await t.post('/posts', { title: 'Hi', body: '...' }, alice)).status, 201);
```

Runs on `node --test`. Generated resources come with a test file.

## Security

Report vulnerabilities privately (see SECURITY.md). `calm doctor` checks your project against
published CalmAPI advisories, including **inside CalmAPI 1.x projects**, and explains each fix.

## Develop CalmAPI itself

```bash
cd v2 && npm install
npm run lint
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

Layout: `core/` (the framework copied into projects as `calm/`), `templates/`, `registry/blocks/`,
`src/cli/`, `packages/devtools` (`@calmapi/devtools`), `packages/create-calmapi`.

MIT License.
