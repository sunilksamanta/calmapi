# Email verification (email-verification)

Proves that people own the email address on their account. After registration (and after every address change) the user gets a link; opening it marks the account verified. Links work once, expire after 24 hours and are stored only as hashes. The user record gets `emailVerified` and `emailVerifiedAt`, visible in `GET /api/auth/me`. You decide how strict to be: protect single routes with the `verified` policy token, close every route until the address is verified, or refuse sign-in altogether.

```bash
npx calm add email-verification
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/email-verification/index.js` |
| Environment | Nothing new. Links are built from `APP_URL`. A mail transport (`mail-resend`, `mail-smtp`) is needed in production. |
| Routes | `POST /api/auth/verify-email`, `POST /api/auth/verify-email/resend`, `POST /api/admin/users/:userId/verify-email` |
| User fields | `emailVerified` (boolean, default `false`), `emailVerifiedAt` (date). Read-only, visible to the owner and admins. |
| Policy token | `verified` |
| Collections | `calm_email_verifications`, `calm_email_verification_cooldowns` (both cleaned up by TTL indexes) |

## The flow

1. `POST /api/auth/register` works as before. In the background the block emails a link to `APP_URL/verify-email?token=verify_...` (change it with `linkUrl`). The register answer already carries `user.emailVerified: false`.

2. Your `/verify-email` page reads the token and calls:

```http
POST /api/auth/verify-email
{ "token": "verify_..." }
```

```json
200 { "data": { "verified": true, "email": "ada@example.com" } }
```

Invalid, used or expired links answer `400 { "error": { "code": "INVALID_TOKEN" } }`. Verifying does not sign anyone in: the link in an email is not a session.

3. Lost the email? Ask for a new one:

```http
POST /api/auth/verify-email/resend            (signed in: your own address, body {})
POST /api/auth/verify-email/resend            (signed out)
{ "email": "ada@example.com" }
```

```json
202 { "data": { "message": "If that address needs verifying, a link is on its way.", "expiresIn": 86400 } }
200 { "data": { "verified": true, "message": "Your email address is already verified." } }   (signed in, already verified)
429 Retry-After: 42                                                                           (cooldown running)
```

Signed out, the answer is the same for every address, registered or not, verified or not, and the lookup happens after the response.

A minimal verify page:

```js
const token = new URLSearchParams(location.search).get('token');
const res = await fetch('/api/auth/verify-email', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
const { data, error } = await res.json();
if (data?.verified) show(`Thanks, ${data.email} is verified.`);
else show('This link is invalid or has expired.', { action: 'Send a new link' });
```

And reacting to the error anywhere in your app:

```js
if (error?.code === 'EMAIL_NOT_VERIFIED') showBanner('Check your inbox to verify your email address.', { resend: () => api.post('/auth/verify-email/resend', {}) });
```

## How strict: `required` and the `verified` token

| `required` | Signing in | Routes |
| --- | --- | --- |
| `false` (default) | as usual | only routes using the `verified` policy need a verified address |
| `'routes'` | as usual | every route except public ones and the allowlist answers `403 EMAIL_NOT_VERIFIED` |
| `'login'` | refused with `403 EMAIL_NOT_VERIFIED` (a fresh link is sent, within the cooldown) | same as `'routes'`, which also covers the session `register` returns and API keys |

The `verified` token works in resources and custom routes, alone or with alternatives:

```js
policy: { create: 'verified', update: 'owner', delete: 'owner | admin' }
r.get('/reports', { policy: 'verified | admin' }, handler);
```

An unverified user gets `403 EMAIL_NOT_VERIFIED` when no other alternative lets them in (so an unverified admin passes `'verified | admin'`). Signed out callers get `401` as usual.

While `required` is on, unverified users can still call: `POST /auth/verify-email`, `POST /auth/verify-email/resend`, `GET|PATCH|DELETE /auth/me` (read and fix the profile, delete the account), `POST /auth/logout`, `POST /auth/logout-all`, every `public` route, and whatever you add to `allow`.

With `required: 'login'`, a wrong password still answers `401 Invalid email or password`; only the right password reveals that the address is unverified.

## Changing the address

When the email changes (through `PATCH /api/auth/me` if your user resource allows it, or the user CRUD), the same update sets `emailVerified: false` and removes `emailVerifiedAt`. Pending links for the old address stop working, a link goes to the new address and a notice goes to the old one (with the new address masked), so the owner learns about a takeover. The template makes `email` immutable; remove `.immutable()` from it to allow changes.

## Options

```js
export default defineConfig({
  blocks: {
    'email-verification': { required: 'login', ttlHours: 48, allow: ['GET /billing/plans'] },
  },
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `required` | `false` | `false`, `'routes'` or `'login'` (see above). |
| `linkUrl` | `APP_URL + '/verify-email'` | The frontend page the email links to. `?token=` (or `&token=`) is appended. |
| `ttlHours` | `24` | How long a link works. |
| `cooldownSeconds` | `60` | Minimum time between two links for the same address. `0` turns it off. |
| `sendOnRegister` | `true` | Email a link on `auth.registered`. |
| `sendOnEmailChange` | `true` | Email a link to a new address. |
| `notifyOldEmail` | `true` | Tell the old address that it was replaced. |
| `allow` | `[]` | More routes unverified users may call while `required` is on, as `'METHOD /path'` written like the route (without `/api`). |

## In code

```js
ctx.user.emailVerified                                   // on every request
await app.ext.emailVerification.markVerified(userId)     // e.g. a sign-in block that proved the inbox
await app.ext.emailVerification.sendLink(userDoc)        // send a link yourself
```

With the `magic-link` block, opening a magic link proves the inbox too: accounts created by a sign-up link (`auth.registered` with `via: 'magic-link'`) are verified at once, and an unverified user who signs in with a link becomes verified (even with `required: 'login'`).

## Security

- Tokens are 256 bit random values, stored as SHA-256 hashes, single use (claimed with one atomic update) and expire. Verifying one spends the other pending links of the user.
- A link carries the address it was sent to: if the account's address changed since, the link is refused.
- Resend and verify use the auth rate limit (`config.rateLimit.auth`); each address also has a cooldown stored in MongoDB, so it holds across instances.
- `emailVerified` and `emailVerifiedAt` are read-only for every client, admins included; admins use the support route.
- Refused links emit `security.invalid_verification_link` with a `reason`; refused sign-ins emit `security.unverified_login` (masked email).
- Accounts that existed before the block have no `emailVerified` field and count as unverified. `calm doctor` says how many; mark them with the admin route or in MongoDB if you trust those addresses.

## Events

| Event | Payload |
| --- | --- |
| `auth.email_verification_sent` | `{ user, email }` |
| `auth.email_verified` | `{ user, email }` |
| `security.invalid_verification_link` | `{ reason, ip }` |
| `security.unverified_login` | `{ userId, email }` (masked) |
