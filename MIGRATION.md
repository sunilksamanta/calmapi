# Migrating from CalmAPI 1.x to 2.0

CalmAPI 2 keeps the idea (framework code lives in your project, Controller-Service-Model style)
and replaces almost everything else. There is no in-place upgrade: create a v2 project and move
your modules over. Most modules shrink to one or two files.

## 0. First, secure your 1.x app

Inside your 1.x project:

```bash
npx calmapi@next doctor
```

It reports the published advisories for 1.x templates with the fix for each. Patch those in
production before migrating.

## 1. Concept map

| 1.x | 2.0 |
|---|---|
| `src/modules/x/x.model.js` + `x.dto.js` (Get/Insert/Update DTOs) | `app/resources/x/x.resource.js`: fields with `f.*()`, visibility and validation in one place |
| `x.controller.js` (CalmController, autoBind, try/catch) | gone: CRUD is generated; custom endpoints in `x.routes.js` return values |
| `x.service.js` (CalmService) | `x.service.js` extending `ResourceService` (hooks: `beforeCreate`, `scope`...) |
| `x.route.js` + `AuthController.checkLogin` | `policy: { list, read, create, update, delete }` and `{ policy }` on custom routes |
| `x.settings.js` `moduleRoute` | `resource('x', { path: '/custom-path' })` |
| `populateFields` | `f.ref('user').populate()` or `?include=author` (safe projections) |
| `system/` | `calm/` (upgrade it with `calm upgrade`) |
| `calmapi generate module x` | `calm make resource x field:type ...` |
| `src/configs/config.js` | `calm.config.js` + `.env` |
| JWT stored in the `auth` collection | opaque session tokens hashed in `calm_sessions` |
| `media` module (S3) | `calm add storage-s3` (presigned uploads) or `storage-local` |
| CommonJS | ESM (`"type": "module"`), imports via `#calm` and `#app/*` |

## 2. API changes your clients will see

| | 1.x | 2.0 |
|---|---|---|
| Success | `{ error: false, status: true, statusCode, responseTimestamp, data, totalCount }` | `{ data }`, lists add `meta: { total, page, limit, pages }` |
| Errors | `{ error: true, name, message, statusCode }` | `{ error: { code, message, details?, requestId } }` |
| Status codes | always 200 on success | 201 create, 204 delete, real 4xx codes |
| Ids | `_id` | `id` |
| Pagination | `skip`, `limit` | `page`, `limit` (max 100 by default) |
| Sorting | `sortBy=-createdAt` | `sort=-createdAt,title` (only `.sortable()` fields) |
| Filters | any field, any value | only `.filterable()` fields: `status=x`, `price[gte]=10`, `tags[in]=a,b` |
| Auth header | `Authorization: Bearer <jwt>` or `?token=` | `Authorization: Bearer <session token>` only |
| Login response | `{ token, user }` | `{ data: { token, expiresAt, user } }` |
| Password reset | 6-digit OTP in the user document | emailed single-use link token (`/auth/password/forgot`, `/auth/password/reset`) |

Existing sessions do not carry over: users sign in again after the switch.

## 3. Step by step

1. `npm create calmapi@latest my-api-v2` and point `.env` at a copy of your database.
2. For each 1.x module, run `calm make resource <name> ...fields` and adjust fields: copy types from
   the model, then mark visibility (what was missing from your GetDTO is `.hidden()` or `.writeOnly()`;
   what was missing from InsertDTO/UpdateDTO is `.readOnly()`).
3. Write policies: decide who may list, read, create, update and delete each resource.
   If records have `createdBy`, keep the field and mark it `f.ref('user').owner()`.
4. Move custom controller methods into `<name>.routes.js` (return values, no `res`), and business
   logic into the service.
5. Users: 1.x stored bcrypt hashes in `password`. v2 verifies scrypt hashes, so existing users must use
   "forgot password" once, or add bcrypt verification to `calm/auth/password.js` (it is your code) and
   let `needsRehash` upgrade them at login.
6. Run `calm doctor` until it is clean, then `npm test`.
7. Update your frontend for the response shape (section 2).

Questions: https://github.com/sunilksamanta/calmapi/discussions
