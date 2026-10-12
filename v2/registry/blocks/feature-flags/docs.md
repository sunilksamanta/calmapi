# Feature flags (feature-flags)

Ship code dark and turn it on when you are ready: kill switches, gradual rollouts, per user and per role targeting, and weighted variants for experiments. Flags live in MongoDB, are evaluated in memory (`ctx.flags.enabled('new-checkout')` is synchronous) and give every user the same answer on every instance. Admins change them through an API, frontends read theirs from `GET /api/flags`, routes can be gated with `requireFlag()`, and devtools lists them.

```bash
npx calm add feature-flags
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/feature-flags/index.js`, `app/blocks/feature-flags/evaluate.js` (the rules), `app/blocks/feature-flags/gate.js` (`requireFlag`) |
| Environment | Nothing. |
| Routes | `GET /api/flags`, `GET` and `POST /api/admin/flags`, `GET`, `PATCH` and `DELETE /api/admin/flags/:key` |
| Collections | `calm_flags` |
| Devtools | A **Feature flags** panel |

## A flag

```json
{
  "key": "new-checkout",
  "description": "One page checkout",
  "enabled": true,
  "rollout": 20,
  "users": ["665f1c..."],
  "roles": ["beta"],
  "variants": { "control": 50, "one-page": 50 },
  "clientVisible": true
}
```

A flag is on for a caller when:

1. `enabled` is `true` (it is the kill switch: `false` turns the flag off for everyone, targeting included), and
2. their user id is in `users`, or they have one of the `roles`, or they fall inside `rollout`.

`rollout` is a percentage. Each user gets a bucket from 0 to 99, a hash of the flag key and their id, and the flag is on when the bucket is below `rollout`. No randomness and no stored assignments: the same user gets the same answer on every request and every instance, and raising the rollout from 20 to 50 keeps the first 20% and adds 30% more, so nobody flips back and forth. Each flag hashes differently, so the same 20% of users are not always first.

Visitors who are not signed in are off unless `rollout` is 100 (or `users` lists their anonymous id). If your frontend sends a stable random id in `X-Anonymous-Id` (letters, digits, `.`, `_`, `:` and `-`, up to 128), visitors are bucketed by it like users. Signed-in users are always bucketed by their user id.

## In your code

`ctx.flags` is on every request context (handlers, resource hooks and services that receive `ctx`):

```js
r.post('/orders', { policy: 'authenticated' }, async (ctx) => {
  if (ctx.flags.enabled('new-checkout')) return ctx.services.order.checkoutV2(ctx.body, ctx);
  return ctx.services.order.checkout(ctx.body, ctx);
});

const layout = ctx.flags.variant('pricing-page'); // 'control' | 'one-page' | null
```

`variant()` is `null` when the flag is off for the caller, when it has no variants, or when the caller has no id (a visitor without `X-Anonymous-Id`). Variants are weighted (`{ control: 50, 'one-page': 50 }`, whole numbers) and hashed separately from the rollout, so a user keeps their variant when the rollout changes. Changing the weights moves some users to another variant.

Unknown flags are off. In development the first check of a flag that does not exist logs a warning, which catches typos.

Outside requests (jobs, event listeners, scripts), use the same evaluation through `app.ext.flags`:

```js
const flags = ctx.app.ext.flags;
await flags.isEnabled('new-checkout', { user });          // a user document, or { userId, roles }
await flags.variant('pricing-page', { anonymousId });
const forUser = await flags.evaluate({ user });           // then forUser.enabled(...) synchronously
```

## Gating routes with requireFlag

```js
import { requireFlag } from '#app/blocks/feature-flags/index.js';

export default (r) => {
  r.post('/checkout/v2', { policy: [requireFlag('new-checkout'), 'authenticated'] }, checkoutV2);
  r.get('/labs', { policy: requireFlag('labs') }, labs);
};
```

While the flag is off for the caller the route answers `404 Route not found`, as if it did not exist. When it is on, the rest of the policy decides as usual: `[requireFlag('new-checkout'), 'authenticated']` still needs a signed-in user, and `[requireFlag('notes'), 'owner']` still limits users to their own records. A policy made only of gates (`requireFlag('labs')`) lets in whoever the flag is on for, visitors included when it is on for them.

Gates work in resource policies too:

```js
const notes = requireFlag('notes');
export default resource('note', {
  fields: { text: f.string().required(), author: f.ref('user').owner() },
  policy: { list: [notes, 'owner'], read: [notes, 'owner'], create: [notes, 'authenticated'], update: [notes, 'owner'], delete: [notes, 'owner'] },
});
```

Why a helper and not a route option: a gate has to work in resource action policies too, where routes have no options (route `meta` exists, but only custom routes have it), and named policies cannot contain a colon (`flag:beta`). A policy list also means "any of", so an ordinary policy function could only widen access. `requireFlag()` returns a policy function marked as a gate: the block's guard finds gates in the route's policy and enforces them before the policy runs, and inside the policy a gate never grants access on its own. Routes show it as `flag:new-checkout` in `calm routes` and devtools. Gates are for route and resource action policies; in field rules (`visibleTo`, `writableBy`) they are always false.

## Declaring flags in code

Flags your code relies on can be declared in `calm.config.js`. They are created on start when they do not exist, and never touched again: once a flag exists, the admin API owns it, so a deploy never undoes an admin's change.

```js
export default defineConfig({
  blocks: {
    'feature-flags': {
      flags: {
        'new-checkout': { description: 'One page checkout', rollout: 0 },
        'pricing-page': { description: 'Pricing experiment', rollout: 100, variants: { control: 50, 'one-page': 50 }, clientVisible: true },
      },
    },
  },
});
```

Declared flags start with `enabled: true` and whatever you set; a flag declared with `rollout: 0` is live only for the users and roles you target. Invalid declarations stop the boot with a readable error. A declared flag deleted through the API comes back, with its declared values, on the next start.

## Admin API

All routes need the `admin` role.

```http
GET    /api/admin/flags                 every flag
GET    /api/admin/flags/new-checkout
POST   /api/admin/flags                 { "key": "new-checkout", "rollout": 10 }        -> 201
PATCH  /api/admin/flags/new-checkout    { "rollout": 50, "roles": ["beta"] }
DELETE /api/admin/flags/new-checkout                                                   -> 204
```

`PATCH` changes only the fields you send; `null` resets a field (`"variants": null` removes the variants). Keys cannot change. Every change records `updatedBy` and emits `flag.changed`.

## For frontends

`GET /api/flags` returns the flags marked `clientVisible`, already evaluated for the caller, and nothing about the others:

```json
200 { "data": { "new-checkout": { "enabled": true, "variant": null }, "pricing-page": { "enabled": true, "variant": "one-page" } } }
```

Send the session token for signed-in users and `X-Anonymous-Id` for visitors. The response is marked `Cache-Control: private, no-store`. Flags without `clientVisible` stay on the server, so internal flag names and targeting never reach the browser.

## Caching

Each process reads all flags at most once per `cacheTtlMs` (default `5000`) and evaluates from memory. Changes made through the admin API (or `app.ext.flags`) apply at once in the process that made them and within `cacheTtlMs` in the others. After writing to `calm_flags` directly, call `app.ext.flags.invalidate()` or wait for the TTL. If MongoDB cannot be read, the last known flags keep being served, or every flag is off if they were never read.

```js
export default defineConfig({ blocks: { 'feature-flags': { cacheTtlMs: 2000 } } });
```

## Events and devtools

`flag.changed` is emitted for every create, update and delete, through the API or from declared flags:

```js
calm.on('flag.changed', ({ key, action, flag, previous, user }) => {
  slack.post(`${user?.name ?? 'Deploy'} ${action} ${key}: rollout ${previous?.rollout ?? 0}% -> ${flag?.rollout ?? 0}%`);
});
```

In development, open `/_calm` and pick **Feature flags** to see every flag with its rollout, targeting, variants and last change.
