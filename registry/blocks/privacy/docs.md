# Privacy: export and delete (privacy)

Two rights most privacy laws give your users (GDPR articles 17 and 20, CCPA, LGPD and others):
getting a copy of their data and having it erased. This block adds both to the signed-in user and
to admins handling support requests. You decide per resource what an account deletion does to the
records the user owns: delete them, keep them without the owner (anonymize), or keep them as they
are. `calm doctor` shows the plan and warns about data that stays.

```bash
npx calm add privacy
```

## Adds

| | |
|---|---|
| Files | `app/blocks/privacy/index.js` (routes, guard, sweep, doctor), `app/blocks/privacy/export.js` (streamed export), `app/blocks/privacy/erase.js` (account deletion) |
| Environment | None. Settings live in `calm.config.js` under `blocks.privacy`. |

Routes:

| Route | Who | What |
|---|---|---|
| `GET /api/auth/me/export` | signed in | JSON download of everything you own |
| `DELETE /api/auth/me` | signed in | delete your account, confirmed with your password |
| `POST /api/admin/users/:id/export` | admin | export a user's data |
| `DELETE /api/admin/users/:id` | admin | delete a user's account and data |
| `POST /api/admin/users/:id/cancel-deletion` | admin | cancel a deletion during the grace period |

It also adds a hidden `deletion` field to the user resource (set while an account is being deleted).

## Export your data

```bash
curl -OJ http://localhost:5001/api/auth/me/export \
  -H "Authorization: Bearer $TOKEN"
# saves fixture-app-export-2026-10-12.json
```

The file holds your profile, every record of every resource with an owner field (`f.ref('user').owner()`)
that you own, your sessions and your push devices, then a manifest:

```json
{
  "format": "calmapi-export/1",
  "app": "my-api",
  "userId": "6acd1c970d5d7607a3466c9c",
  "generatedAt": "2026-10-12T17:44:56.205Z",
  "profile": { "id": "6acd1c970d5d7607a3466c9c", "name": "Alice", "email": "alice@example.com", "roles": ["user"] },
  "resources": {
    "note": [{ "id": "6acd1c980d5d7607a3466c9e", "text": "Buy milk", "author": "6acd1c970d5d7607a3466c9c" }],
    "post": []
  },
  "sessions": [{ "id": "6acd1c980d5d7607a3466c9d", "createdAt": "...", "ip": "127.0.0.1", "userAgent": "..." }],
  "devices": [{ "id": "6acd1c98a9b5969f7217541e", "platform": "android", "token": "fcm-Al…abcdef" }],
  "manifest": { "generatedAt": "...", "resources": ["note", "post"], "counts": { "profile": 1, "note": 1, "post": 0, "sessions": 1, "devices": 1 } }
}
```

What the export guarantees:

- Records are serialized exactly as the API shows them to their owner: `.hidden()` and `.writeOnly()`
  fields and password hashes are never written, `visibleTo()` rules apply (an `admin`-only field
  stays out of a regular user's export), `.encrypted()` fields are decrypted only where the owner may
  see them.
- Sessions without their token hashes, push devices with masked tokens.
- Soft-deleted records (soft-delete block) are included: they are still stored data.
- One cursor per resource and the response is streamed, so a large account never sits in memory.
  If something fails halfway, the connection is cut so a partial file never looks complete.
- Limited to 5 exports per user per hour (`exportLimit`, applies when `config.rateLimit.enabled`).
- Emits `privacy.exported` with `{ userId, by, counts }` (`by` is `'self'` or `'admin'`, plus `adminId`).

The export follows ownership through owner fields only. Records that mention a user in another field
(an assignee, a mention) are not that user's records; `calm doctor` lists those fields.

## Delete your account

```bash
curl -X DELETE http://localhost:5001/api/auth/me \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "password": "correct-horse-battery" }'
# 204 No Content: deleted
# 202 { "data": { "status": "scheduled", "scheduledFor": "..." } } with a grace period
```

The current password is the confirmation (a stolen session token alone cannot delete an account).
A wrong password answers `422` with `details.password` and emits `security.account_delete_failed`.
The route is rate limited like login (`config.rateLimit.auth`).

What happens, in this order, so an interrupted deletion can always be finished:

1. The user is marked `status: 'deleting'`. From then on they cannot sign in (`403`) and no
   credential works (`401`), including API keys from other blocks.
2. Sessions, password reset links, push devices, 2FA challenges and lockout counters are removed.
3. Each owned resource is deleted, anonymized or kept (below).
4. Collections in `alsoDelete` are cleaned (by default the idempotency block's stored responses).
5. The user record is deleted last, then `privacy.account_deleted` is emitted with
   `{ userId, by, resources: { note: { deleted: 3 }, comment: { anonymized: 1 } } }`.
   No other personal data is in the payload.

If the process stops midway, the sweep (every `sweepEveryMinutes`) finishes the job; every step is
safe to run twice. Deleting a user with the user CRUD route (`DELETE /api/users/:id`) goes through
the same erasure (turn off with `cascadeCrudDelete: false`).

Records are deleted through your service hooks: a `beforeDelete`/`afterDelete` in
`<name>.service.js` runs for each record (that is how the storage blocks remove the stored files).
Services without delete hooks are cleaned with one `deleteMany`. Per-record `<name>.deleted` events
are not emitted: audit-log would copy the erased data into the audit trail. Listen to
`privacy.account_deleted` instead.

## Delete, anonymize or keep, per resource

Default: records are deleted with their owner. Choose per resource:

```js
// app/resources/comment/comment.resource.js
export default resource('comment', {
  onOwnerDelete: 'anonymize', // 'delete' (default) | 'anonymize' | 'keep'
  personalFields: ['authorName'], // also blanked when anonymizing
  fields: {
    body: f.text().required(),
    authorName: f.string(),
    author: f.ref('user').owner(),
  },
});
```

- `delete`: the records are removed.
- `anonymize`: the records stay, the owner field and the personal fields are removed (`$unset`).
  Fields flagged `pii` on the field (`field.opts.pii`) count as personal too.
- `keep`: the records stay untouched and still hold the deleted account's id. Use it for what the law
  makes you keep (invoices, tax records) and say so in your privacy policy. `calm doctor` warns
  about every resource set to `keep`.

Or decide centrally, which wins over the resource option:

```js
// calm.config.js
export default defineConfig({
  blocks: {
    privacy: {
      resources: { invoice: 'keep', comment: 'anonymize' },
      personalFields: { comment: ['authorName', 'authorEmail'] },
    },
  },
});
```

Unknown behaviors and personal fields that do not exist fail at boot.

## Grace period

```js
blocks: { privacy: { graceDays: 14 } }
```

With a grace period the account is locked at once (steps 1 and 2) and erased when the period ends.
`DELETE /api/auth/me` answers `202` with `scheduledFor`, and `privacy.deletion_requested` is emitted
(send the "your account will be deleted on..." email from there). Support can undo it:

```bash
curl -X POST http://localhost:5001/api/admin/users/6acd1c970d5d7607a3466c9c/cancel-deletion \
  -H "Authorization: Bearer $ADMIN_TOKEN"
# 204: the account is back with its previous status; the user signs in again
```

The sweep runs every `sweepEveryMinutes` (default 60, timer does not keep the process alive). Several
instances can sweep at the same time: each account is claimed with a lease. Run it yourself from a
job or a script with `app.ext.privacy.sweep()`.

## Admin routes (support requests)

```bash
# Export a user's data (as that user would see it, not as the admin sees it)
curl -X POST -OJ http://localhost:5001/api/admin/users/6acd1c970d5d7607a3466c9c/export \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Delete an account (follows graceDays)
curl -X DELETE http://localhost:5001/api/admin/users/6acd1c970d5d7607a3466c9c \
  -H "Authorization: Bearer $ADMIN_TOKEN"

# Delete right away, skipping the grace period
curl -X DELETE http://localhost:5001/api/admin/users/6acd1c970d5d7607a3466c9c \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{ "immediate": true }'
```

## Doctor

`calm doctor` (and devtools) shows what deleting an account does:

```
info  What deleting an account does
      Owned records: comment kept without owner (author, authorName removed); invoice kept as is;
      note deleted; post deleted. Always deleted: the profile, sessions, push devices, password
      reset links, calm_idempotency (by user). Grace period: none, data is erased right away.
warn  invoice: records stay when their owner deletes their account
info  User references that are not owner fields
      comment.mentions keep pointing at deleted accounts
```

## Options

| Option | Default | |
|---|---|---|
| `graceDays` | `0` | days between the request and the erasure; the account is locked meanwhile |
| `sweepEveryMinutes` | `60` | how often due and interrupted deletions are finished; `0` turns the timer off |
| `resources` | `{}` | `{ resource: 'delete' \| 'anonymize' \| 'keep' }`, wins over `onOwnerDelete` |
| `personalFields` | `{}` | `{ resource: ['field'] }`, blanked when anonymizing |
| `alsoDelete` | `{ calm_idempotency: 'user' }` | other collections to clean: `{ collection: 'fieldHoldingTheUserId' }`, e.g. `calm_audit_log: 'user'` if your retention policy allows |
| `exportLimit` | `{ windowMs: 3600000, max: 5 }` | exports per user; `false` for no limit |
| `batchSize` | `200` | cursor batch size for exports and per-record deletes |
| `cascadeCrudDelete` | `true` | `DELETE /api/users/:id` erases the same way |

## Events

| Event | Payload |
|---|---|
| `privacy.exported` | `{ userId, by, adminId?, counts }` |
| `privacy.deletion_requested` | `{ userId, by, adminId, scheduledFor }` |
| `privacy.deletion_cancelled` | `{ userId }` |
| `privacy.account_deleted` | `{ userId, by, resources }` |
| `security.account_delete_failed` | `{ userId, ip }` (wrong password) |

From code: `app.ext.privacy.request(userId, { by, immediate })`, `.purge(userId)`, `.cancel(userId)`,
`.sweep()` and `.plan()`.
