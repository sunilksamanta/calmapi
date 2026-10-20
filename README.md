<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://docs.calmapi.dev/brand/calmapi-banner-dark.png">
    <img src="https://docs.calmapi.dev/brand/calmapi-banner.png" alt="Calm API: Keep Calm &amp; REST. The backend framework you own, for Node.js and MongoDB" width="100%">
  </picture>
</p>

# CalmAPI 2

**Declare a resource in one file. Get a secure REST API you own, down to the last line of framework code.**

For Node.js and MongoDB: resources, access policies, auth, devtools and a security audit, with the
framework copied into your repo instead of hidden in `node_modules`.

[![npm](https://img.shields.io/npm/v/calmapi?label=npm&color=2f7d5b)](https://www.npmjs.com/package/calmapi)
[![CI](https://github.com/sunilksamanta/calmapi/actions/workflows/ci.yml/badge.svg)](https://github.com/sunilksamanta/calmapi/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2f7d5b)](LICENSE)

## Start in 30 seconds

> **Beta.** CalmAPI 2 is in beta (`2.0.0-beta`): ready to build on, but APIs may still change before 2.0.

You need Node.js 22.12+ and MongoDB ([Docker, Atlas or a local install](https://docs.calmapi.dev/getting-started#requirements)).

```bash
npm create calmapi@latest my-api     # CalmAPI 2 beta
cd my-api
npm run dev                          # API on :5001, devtools at /_calm
npx calm make resource product name:string+required price:number+sortable
```

<p align="center">
  <img src="https://raw.githubusercontent.com/sunilksamanta/calmapi/master/.github/assets/calm-make-resource.gif" alt="Terminal: calm make resource creates app/resources/product/product.resource.js, and calm routes lists the five product routes with their policies" width="800">
</p>

That one command wrote the resource and its test. The API now has five product routes with access
rules, validation, filtering and OpenAPI. Documentation: **https://docs.calmapi.dev**

> Coming from CalmAPI 1.x? Run `npx calmapi@next doctor` inside your 1.x project, then read the
> [migration guide](https://docs.calmapi.dev/migrate-v1). The 1.x source lives on the
> [`v1` branch](https://github.com/sunilksamanta/calmapi/tree/v1).

## Why not NestJS or plain Express?

Both are good tools. Here is what you would be choosing between:

| | Plain Express | NestJS | CalmAPI |
|---|---|---|---|
| A CRUD resource | Routes, validation, query parsing and output filtering, written by hand for each model | A module, controller, service, DTOs and entity, wired with decorators | One `*.resource.js` file; CRUD, validation, filters and OpenAPI follow from it |
| Who may do what | Middleware you write and remember to apply | Guards you write and attach | A policy on every route and field visibility per role, checked by `calm doctor` and tested by `calm audit` |
| Where the framework lives | `node_modules` (Express is small) | `node_modules` (large) | `calm/` in your repo: readable, editable, and still upgradeable with `calm upgrade` |
| Proving access rules hold | Your own tests | Your own tests | `calm audit` calls every route as every role on a throwaway database |
| Coding agents | Generic | Generic | `AGENTS.md`, an MCP server with 29 project tools, and every agent action visible in devtools |
| Stack | Anything | TypeScript, SQL or MongoDB, microservices | JavaScript (ESM), Express 5 underneath, MongoDB only |

Pick **plain Express** for a tiny service with a handful of routes. Pick **NestJS** for a large TypeScript
codebase that wants dependency injection, SQL databases or message transports. Pick **CalmAPI** when you
want a MongoDB REST API whose access rules are declared once, enforced everywhere and checked on every
build, with framework code you can read.

## Why CalmAPI

- **Nothing hidden in node_modules.** The framework is copied into `calm/` when you create a project.
  Read it, debug it, change it. A new project has two runtime dependencies: `express` and `mongoose`.
- **Owned, but upgradeable.** `calm.lock` remembers the exact framework files you started from;
  `calm upgrade` three-way merges upstream fixes into your edited copy instead of overwriting it.
- **Declare a field once.** One `f.*()` line drives the Mongoose schema, input validation, what the API
  returns, which filters and sorts are allowed, and the OpenAPI schema.
- **Secure by default, and provably so.** Hidden fields cannot leak (even through populated references),
  every route has an access policy, list queries are allowlisted, sessions and reset tokens are hashed,
  logins lock per account, common passwords are refused, and anything but `development`/`test` runs as
  production. `.encrypted()` fields are AES-256-GCM at rest. `calm audit` attacks your own API as every
  role on a throwaway database and proves the policies hold.
- **Devtools.** A local dashboard at `/_calm`: every request with its MongoDB queries and timings,
  explain plans, a privacy lens on your data, sample data, a mail catcher, push notifications on
  simulated phones, "act as" any user, what each block adds, and doctor findings.
- **Agent native, human visible.** Projects ship with `AGENTS.md`; `calm mcp` gives coding agents tools to
  scaffold, call the API as any user, run tests, doctor and the security audit. Everything an agent does
  (tool calls, file diffs, restarts, crashes, requests) streams live into devtools, so you watch it work.
- **Blocks, shadcn style.** `calm add notifications` copies production code (in-app inbox plus push plus
  email, webhooks, API keys, feature flags, a job queue, file storage, realtime...) into your project. You
  own that code too, and building and sharing your own block takes one command.

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
calm dev [--agent-db]                   watch mode + devtools (--agent-db: run on a disposable copy of the database)
calm make resource <name> [fields...]   e.g. product name:string+required price:number status:enum:draft,live=draft category:ref:category
calm add <block...>                     copy blocks into your project (calm add --list, gh:user/repo/name)
calm make block <name>                  start your own block
calm block list|check|pack              your blocks: what changed, a safety review, a file to share
calm seed [resource...]                 sample records that look real (--count, --seed)
calm routes                             every route with its policy and source file
calm openapi                            write openapi.json
calm client [--out file] [--js]         typed, dependency-free client for your web or mobile app
calm doctor [--prod] [--ci] [--audit]   security and correctness checks
calm audit [--ci]                       test every route as every role on a throwaway database
calm audit --accept --reason "..."      accept the exposure matrix as the budget (security.snapshot.json)
calm review [--sign] [--ci]             what changed since the last signed review; sign it
calm diff [--api] [--ci]                behavior and API contract changes (breaking, minor, patch)
calm replay [--writes] [--ci]           replay recorded traffic against the current code
calm budgets [--ci]                     queries, p95 and response size per route against calm.config.js budgets
calm checkpoint [name] / calm restore   save and restore the code and the data
calm about                              everything the framework does that you did not write
calm admin <email> [--revoke]           grant the admin role
calm keygen [--write]                   encryption key for .encrypted() fields (rotates)
calm upgrade                            merge framework updates into calm/
calm mcp                                MCP server for coding agents (claude mcp add calm -- npx calm mcp)
```

## Blocks

| Block | What you get |
|---|---|
| `notifications` | `ctx.notify(user, 'order-shipped', { order })`: in-app inbox, push and email in one call, with preferences and quiet hours |
| `webhooks` | outgoing webhooks for resource events: signed (Standard Webhooks), retried, logged, SSRF safe |
| `api-keys` | personal and service API keys with scopes, hashed at rest, expiry and revoke |
| `magic-link` | passwordless sign-in by email, bound to the browser that asked |
| `feature-flags` | kill switches, gradual rollouts, targeting, variants, route gates |
| `privacy` | users export their data and delete their account (delete, anonymize or keep per resource) |
| `idempotency` | the `Idempotency-Key` header: safe retries for payments and other writes |
| `jobs` | MongoDB job queue and cron (no Redis): retries, schedules, event triggers, admin API |
| `storage-local` / `storage-s3` | uploads with type/size allowlists and safe downloads; S3/R2/MinIO via presigned URLs |
| `realtime-sse` | live resource events, filtered per subscriber by the same policies |
| `mcp-server` | your resources as MCP tools for AI agents, enforced by your API's own rules |
| `audit-log` | who changed what, with field diffs (private values never logged) |
| `soft-delete` | `softDelete: true` per resource, trash and restore |
| `totp` | two-factor authentication with authenticator apps |
| `api-docs` | interactive reference at `/docs` |
| `mail-resend` / `mail-smtp` / `mail-postmark` | email delivery |
| `push-expo` / `push-fcm` | push notification delivery through Expo or Firebase Cloud Messaging |
| `rate-limit-mongo` | shared rate limits across instances |
| `oauth` | sign in with Google, GitHub or any OpenID Connect provider (PKCE, verified ID tokens, safe account linking) |
| `payments-stripe` | Stripe Checkout, subscriptions and the customer portal, verified webhooks, plan-gated routes |
| `teams` | organizations, roles, invitations and team-scoped resources (`team: true`) with strict isolation |
| `email-verification` | verify emails after sign-up and changes; a `verified` policy |
| `captcha` | Turnstile, hCaptcha or reCAPTCHA v3 on sign-up, sign-in and reset |
| `cache` | per-identity response caching with invalidation, ETag and 304 |
| `sms-twilio` | SMS and phone verification codes |
| `slack` / `sentry` | events and security alerts to Slack; errors to Sentry |
| `search-meilisearch` | full-text search that respects your policies |
| `waitlist` / `export` / `maintenance` | launch waitlists with invites; CSV and JSON export and import; maintenance and read-only modes |

### Your own blocks

```js
// app/blocks/maintenance/index.js   (npx calm make block maintenance)
import { definePlugin, CalmError } from '#calm';

export default definePlugin({
  name: 'maintenance',
  env: { MAINTENANCE: 'Set to "on" to answer 503 on every route' },
  setup(calm) {
    calm.guard(() => {
      if (calm.env('MAINTENANCE') === 'on') throw new CalmError(503, 'MAINTENANCE', 'Back soon');
    });
  },
});
```

Blocks can add routes, resources, guards (`calm.guard`, which can stop or answer a request), other
credentials (`calm.authenticate`), named policies (`calm.policy`), login challenges, push and mail
transports, doctor checks and devtools panels. `calm block pack` turns a block into a registry file; others
install it with `calm add gh:you/repo/maintenance`, after a plain-language review of what its code does.
Blocks use the [shadcn registry item format](https://ui.shadcn.com/docs/registry), and private registries
work too: add `"calm": { "registries": { "@acme": "https://acme.dev/r/{name}.json" } }` to `package.json`
and run `calm add @acme/thing`. [Building blocks](https://docs.calmapi.dev/building-blocks)

## Security toolkit

| | |
|---|---|
| Exposure matrix | per resource and role (anonymous, user, owner, admin, custom roles): allowed actions and visible/writable fields, computed from your code |
| `calm audit` | calls every route as every role on a throwaway database; checks statuses, owner-only lists, field leaks, mass assignment, query injection, token handling |
| `.encrypted()` | AES-256-GCM at rest, transparent on read/write/populate, key rotation with `calm keygen --write` |
| Auth hardening | hashed opaque sessions, scrypt, per-account lockout without account enumeration, common/personal password rules, single-use reset tokens |
| `calm add totp` | authenticator-app 2FA with hashed recovery codes and replay protection |
| `calm doctor` | config, policies, personal data exposure, hardcoded secrets, `.env` in git, `npm audit`, advisories |
| `security.*` events | failed logins, lockouts, rejected writes, forbidden access, rate limits, bad tokens: live in devtools, hook them for alerts |

## Auth

`POST /api/auth/register · login · logout · logout-all · password · password/forgot · password/reset`,
`GET|PATCH /api/auth/me`, `GET|DELETE /api/auth/sessions`. Opaque session tokens (SHA-256 at rest),
scrypt password hashing from `node:crypto`, no account enumeration, single-use reset tokens that
revoke every session, rate limited. Apps register push tokens with `POST|GET /api/auth/devices`.

## Push notifications

```js
await ctx.push.send({ to: order.customer, title: 'Your order shipped', body: 'Arrives Thursday', url: `/orders/${order.id}` });
```

In development nothing is delivered: devtools shows each notification on an iPhone lock screen, an
Android notification shade and a desktop browser, with the APNs, FCM, Expo and Web Push payloads, size
and content warnings and a delivery log. Give any user simulated devices that behave like real ones
(offline, muted, uninstalled, invalid token, rate limited), rotate or revoke their tokens, and open each
one as a phone with its own inbox. `calm add push-expo` and `calm add push-fcm` deliver for real, together
if you like. Tests get `t.pushes`.
[Push notifications](https://docs.calmapi.dev/push-notifications)

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
npm install
npm run lint
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and the [roadmap](ROADMAP.md). New here? Start with an issue labelled
[`good first issue`](https://github.com/sunilksamanta/calmapi/labels/good%20first%20issue).

Layout: `core/` (the framework copied into projects as `calm/`), `templates/`, `registry/blocks/`,
`src/cli/`, `packages/devtools` (`@calmapi/devtools`), `packages/create-calmapi`.

MIT License.

---

Built and maintained by the [Broadifi](https://www.broadifitech.com) team. Need help shipping with CalmAPI?
[Talk to the maintainers](https://www.broadifitech.com/contact).
