# Waitlist (waitlist)

A launch waitlist. People join with their email (and optionally a name and a friend's referral code), get their place in line and a referral link; every friend who joins with that link moves them up. Admins see the line, the numbers, and invite people in batches: each invite is an email with a single use sign-up token. Turn on the gate and only invited addresses can register.

```bash
npx calm add waitlist
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/waitlist/index.js` |
| Environment | Nothing new. Links are built from `APP_URL`. A mail transport is needed in production for invites. |
| Routes | `POST /api/waitlist`, `GET /api/waitlist/:code`, `GET /api/admin/waitlist`, `GET /api/admin/waitlist/stats`, `POST /api/admin/waitlist/invite`, `POST /api/admin/waitlist/:id/invite`, `DELETE /api/admin/waitlist/:id` |
| Collections | `calm_waitlist`, `calm_waitlist_counters` |

## Joining

```http
POST /api/waitlist
{ "email": "ada@example.com", "name": "Ada", "referralCode": "K7Q2M9XH4T" }
```

```json
201 {
  "data": {
    "status": "waiting",
    "position": 42,
    "waiting": 1280,
    "referrals": 0,
    "referralCode": "P3W8N2RJ6C",
    "referralUrl": "https://app.example.com/waitlist?ref=P3W8N2RJ6C"
  }
}
```

Joining again with the same address answers `200` with the same entry and changes nothing (not the name, not the referrer). An unknown referral code is ignored. `position` is `null` once the person is invited or registered (`status` says which).

Later, the person checks their place with the code they got:

```http
GET /api/waitlist/P3W8N2RJ6C
```

A minimal form:

```js
const ref = new URLSearchParams(location.search).get('ref') ?? undefined;
const res = await fetch('/api/waitlist', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: form.email.value, name: form.name.value || undefined, referralCode: ref }),
});
const { data, error } = await res.json();
if (data) show(`You are number ${data.position}. Share ${data.referralUrl} to move up.`);
else show(error.details?.email ?? 'Something went wrong');
```

## How the line works

Each entry gets a join number. Its place is decided by `join number - referralBoost x referrals` (ties by join number), so each friend who joins with your code moves you `referralBoost` places up (default 5), for at most `maxReferrals` friends (default 50). The place is computed when asked, never stored, so it is always exact.

## Admin routes

All need the `admin` role.

| Route | What it does |
| --- | --- |
| `GET /api/admin/waitlist?status=waiting&q=ada&page=1&limit=50` | Entries in line order with `position`. `status`: `waiting` (default), `invited`, `registered`, `all`. `q` searches email and name. |
| `GET /api/admin/waitlist/stats` | `{ total, waiting, invited, registered, referred, referrals, joined: { last24h, last7d }, conversion }` (`conversion` = registered / ever invited). |
| `POST /api/admin/waitlist/invite` `{ "count": 100 }` or `{ "ids": [...] }` | Invites the next `count` people in line, or the listed entries. Answers `{ invited: [{ id, email }], count }`. |
| `POST /api/admin/waitlist/:id/invite` | Invites one entry. Inviting again sends a new token; the previous one stops working. |
| `DELETE /api/admin/waitlist/:id` | Removes an entry. `204`. |

An admin entry looks like `{ id, email, name, status, position, referrals, referralCode, referredBy, invitedAt, inviteExpiresAt, registeredAt, user, createdAt }`.

## Invites and the gate

An invite emails `APP_URL/signup?invite=invite_...&email=ada%40example.com` (option `signupUrl`), valid for `inviteTtlDays` (14). Your sign-up page registers with the token:

```js
const params = new URLSearchParams(location.search);
await fetch('/api/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ name, email: params.get('email'), password, inviteToken: params.get('invite') }),
});
```

When someone registers, their entry becomes `registered` and the token is spent. This also happens without the gate, so `stats.conversion` is meaningful either way; `inviteToken` is simply ignored then.

With `gate: true`:

- `POST /api/auth/register` answers `403 INVITE_REQUIRED` unless the body has the `inviteToken` of a valid invite for that exact address.
- Other ways to create an account (a magic-link sign-up, OAuth) work only for invited addresses: they already prove the inbox, so they need no token.
- Admins creating users with `POST /api/users`, and your code passing `{ system: true }`, are not gated. Create the first admin with `npx calm admin` or a script.

## Options

```js
export default defineConfig({
  blocks: { waitlist: { gate: true, referralBoost: 10, inviteTtlDays: 7 } },
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `gate` | `false` | Registration only for invited addresses (see above). |
| `referralBoost` | `5` | Places moved up per referral. |
| `maxReferrals` | `50` | Referrals that count at most, per entry. |
| `referralUrl` | `APP_URL + '/waitlist?ref='` | The referral code is appended. |
| `signupUrl` | `APP_URL + '/signup'` | The page invites link to; `?invite=&email=` are appended. |
| `inviteTtlDays` | `14` | How long an invite works. |
| `confirmationEmail` | `false` | Email new entries their place and referral link. |
| `joinLimit` | `{ windowMs: 900000, max: 20 }` | Joins per IP (when `config.rateLimit` is on). `false` keeps only the global limit. |
| `maxInviteBatch` | `500` | Most entries one bulk invite may touch. |

## In code

```js
const { join, invite, validInvite, positionOf, Entry } = app.ext.waitlist;
await invite(entryId);                                      // from a job: invite on a schedule
calm.on('waitlist.joined', ({ entry, referred }) => analytics.track('waitlist_joined', { referred }));
```

## Security

- Invite tokens are 256 bit random values, stored as SHA-256 hashes, bound to one address, expiring, and spent on registration (the unique email on users stops a second account too).
- A second join with the same address cannot change anything about the entry.
- The join route is public and rate limited per IP. It answers whether an address is already on the list (that is what makes it idempotent) and its referral code; nothing else about the entry is public. Leave `confirmationEmail` off if you do not want the public route to send email to addresses nobody verified.
- Referral farming (many fake addresses joining with one code) is capped by `maxReferrals` and the join rate limit. Check `GET /api/admin/waitlist?q=` before big invite batches if referrals matter for you.
- Refused registrations emit `security.invite_refused` with a `reason` (`no_token`, `invalid_token`, `not_invited`).

## Events

| Event | Payload |
| --- | --- |
| `waitlist.joined` | `{ entry, referred }` |
| `waitlist.referred` | `{ referrerId, entryId }` |
| `waitlist.invited` | `{ entry, by }` |
| `waitlist.registered` | `{ entry, userId }` |
| `waitlist.removed` | `{ entryId, by }` |
| `security.invite_refused` | `{ ip, reason }` |
