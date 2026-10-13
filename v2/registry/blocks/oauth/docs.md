# Sign in with Google, GitHub and OpenID Connect (oauth)

Let people sign in with Google, GitHub or any OpenID Connect provider (Okta, Auth0, Microsoft Entra ID, Keycloak, GitLab...). It uses the authorization code flow with PKCE, a random `state` and, for OpenID Connect, a `nonce`. Every flow works once, expires after 10 minutes and is bound to the browser that started it. ID tokens are verified against the provider's published keys. An account is linked by email only when the provider says the email is verified. Signed-in users can connect and disconnect providers. Account lockout, disabled accounts and two-factor authentication (the `totp` block) apply exactly as they do for passwords. No SDKs: `fetch` and `node:crypto` only.

```bash
npx calm add oauth
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/oauth/index.js` (flows, linking, routes), `app/blocks/oauth/providers.js` (presets, discovery, code exchange, profiles), `app/blocks/oauth/jwt.js` (ID token verification) |
| Environment | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` (a provider turns on when both of its values are set) |
| Routes | `GET /api/auth/oauth/providers`, `POST` and `GET /api/auth/oauth/:provider/start`, `POST /api/auth/oauth/callback`, `POST /api/auth/oauth/:provider/link`, `GET /api/auth/oauth/identities`, `DELETE /api/auth/oauth/identities/:id` |
| Collections | `calm_oauth_flows` (cleaned up by a TTL index), `calm_oauth_identities` |
| User fields | `oauthNoPassword` (hidden): set on accounts this block created, cleared when the owner sets a password |

## Setup

1. Create an OAuth client at the provider and register the **callback URL** as its redirect URI. By default that is `APP_URL/auth/oauth/callback`: a page of your frontend (change it with `callbackUrl`).
   - Google: Google Cloud console, APIs and Services, Credentials, "OAuth client ID", type "Web application".
   - GitHub: Settings, Developer settings, OAuth Apps, "New OAuth App". The "Authorization callback URL" is the callback URL.
2. Put the credentials in `.env`:

```bash
GOOGLE_CLIENT_ID=1234-abc.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
```

3. Any other OpenID Connect provider goes in `calm.config.js`. Its endpoints and keys are found with discovery (`issuer + /.well-known/openid-configuration`):

```js
export default defineConfig({
  blocks: {
    oauth: {
      providers: {
        okta: {
          type: 'oidc',
          name: 'Okta',
          issuer: 'https://dev-123456.okta.com/oauth2/default',
          clientId: process.env.OKTA_CLIENT_ID,
          clientSecret: process.env.OKTA_CLIENT_SECRET,
        },
      },
    },
  },
});
```

4. Run `npx calm doctor`: it reports half-configured providers, a missing auth setup, and http URLs in production.

## The flow

1. Show a button per provider:

```http
GET /api/auth/oauth/providers
```

```json
200 { "data": [{ "id": "google", "name": "Google", "type": "oidc" }, { "id": "github", "name": "GitHub", "type": "github" }] }
```

2. Start the flow when a button is clicked:

```http
POST /api/auth/oauth/google/start
{ "redirect": "/billing" }
```

```json
200 { "data": { "url": "https://accounts.google.com/o/oauth2/v2/auth?...", "requestId": "Jx3k...", "expiresIn": 600 } }
```

Keep `requestId` in `sessionStorage` and send the browser to `url`.

3. The provider sends the browser back to your callback page with `?code=...&state=...` (or `?error=access_denied&state=...` when the user said no). The page calls:

```http
POST /api/auth/oauth/callback
{ "code": "4/0Ab...", "state": "q8Z...", "requestId": "Jx3k..." }
```

```json
200 { "data": { "token": "calm_...", "expiresAt": "...", "user": { ... }, "provider": "google", "redirect": "https://app.example.com/billing", "created": true } }
```

Use `token` as a Bearer token like the one from `/api/auth/login`. `created: true` appears when the account was just created; `redirect` when the start asked for one.

4. When the user has two-factor authentication on, the callback answers with the challenge instead, exactly like password sign-in, and `redirect` is kept on it:

```json
200 { "data": { "mfaRequired": true, "mfaToken": "mfa_...", "methods": ["totp", "recovery"], "redirect": "..." } }
```

Finish with `POST /api/auth/2fa/verify { mfaToken, code }`.

A minimal callback page:

```js
const params = new URLSearchParams(location.search);
const requestId = sessionStorage.getItem('oauthRequestId') ?? undefined;
sessionStorage.removeItem('oauthRequestId');
const res = await fetch('/api/auth/oauth/callback', {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(currentToken() ? { authorization: `Bearer ${currentToken()}` } : {}) },
  body: JSON.stringify({ code: params.get('code') ?? undefined, state: params.get('state'), error: params.get('error') ?? undefined, requestId }),
});
const { data, error } = await res.json();
if (data?.mfaRequired) showTwoFactorForm(data.mfaToken);
else if (data?.token) signIn(data.token, data.redirect ?? '/');
else if (data?.linked) showSettings('Connected');
else if (error.code === 'ACCOUNT_EXISTS') showError('Sign in with your password, then connect this provider in your settings.');
else showError(error.message);
```

And the button:

```js
async function signInWith(provider) {
  const res = await fetch(`/api/auth/oauth/${provider}/start`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  const { data } = await res.json();
  sessionStorage.setItem('oauthRequestId', data.requestId);
  location.href = data.url;
}
```

### Plain links instead of a POST

`GET /api/auth/oauth/:provider/start?redirect=/billing` answers `302` to the provider and keeps the `requestId` in an HttpOnly cookie (`SameSite=Lax`, path `/api/auth/oauth`). The callback page then calls `/callback` with `credentials: 'include'` and without `requestId`. This only works when the callback page and the API are on the same site (for example the frontend proxies `/api`); otherwise use the POST start.

## Accounts and linking

What happens on the callback, in order:

1. The identity (provider + the provider's user id) is already connected: that account signs in.
2. An account with the same email exists:
   - the provider says the email is **verified** and `linkVerifiedEmail` is on (the default): the identity is connected to it and it signs in;
   - otherwise: `409 ACCOUNT_EXISTS`. The user signs in another way and connects the provider from their settings.
3. No account: with `createAccount` on (the default) and `auth.register` on, an account is created, but only for a verified email (`400 EMAIL_NOT_VERIFIED` otherwise; `403` when registration is off). New accounts get the email, the name from the provider and a random password nobody knows. `auth.registered` is emitted with `via: 'oauth'`.

GitHub: the email on the public profile is whatever the user typed. Only the **primary, verified** address from `/user/emails` is used (the default scopes include `user:email`).

### Connect and disconnect (signed in)

```http
POST /api/auth/oauth/github/link          (Authorization: Bearer <session>)
{ "redirect": "/settings" }
```

answers `{ url, requestId, expiresIn }` like start. The callback page must call `/callback` with the same Bearer token; it answers:

```json
200 { "data": { "linked": true, "identity": { "id": "...", "provider": "github", "name": "GitHub", "email": "...", "createdAt": "...", "lastUsedAt": "..." }, "redirect": "..." } }
```

A provider account already connected to another user answers `409 IDENTITY_IN_USE`. Linking does not need a matching email: the user proved both sides.

```http
GET /api/auth/oauth/identities            -> [{ id, provider, name, email, createdAt, lastUsedAt }]
DELETE /api/auth/oauth/identities/:id     -> 204
```

Disconnecting the **last** identity of an account this block created, while the owner has not set a password, answers `409 LAST_SIGN_IN_METHOD`: it would leave the account with no way in. Setting a password (the "forgot password" flow) or connecting another provider lifts it. With the `magic-link` block installed, email links count as a way in.

## Options

| Option | Default | What it does |
| --- | --- | --- |
| `providers` | `{ google: {}, github: {} }` | Providers by id. `google` and `github` are presets turned on by their env vars; `false` removes one. See below. |
| `callbackUrl` | `APP_URL + '/auth/oauth/callback'` | The redirect URI registered at every provider: a page of your frontend. |
| `createAccount` | `true` | Create accounts for new people (verified email, `auth.register` on). |
| `linkVerifiedEmail` | `true` | Sign in to an existing account with the same verified email. Off: people must connect providers from their settings. |
| `allowedRedirects` | the origin of `APP_URL` | Origins `redirect` may point to. |
| `ttlMinutes` | `10` | How long a started flow can be finished. |
| `timeoutMs` | `10000` | Timeout of each request to a provider. |

A provider entry:

| Key | |
| --- | --- |
| `type` | `'oidc'` (OpenID Connect), `'oauth2'` (plain OAuth 2.0 with a userinfo endpoint) or `'github'` |
| `name` | Shown on buttons (`GET /providers`) |
| `clientId`, `clientSecret` | Credentials. Presets read their env vars |
| `issuer` | OpenID Connect issuer; endpoints and keys come from its discovery document |
| `discoveryUrl` | When the discovery document is not at `issuer + /.well-known/openid-configuration` |
| `authorizationUrl`, `tokenUrl`, `userinfoUrl`, `jwksUrl`, `emailsUrl` | Endpoints, overriding discovery or the preset (GitHub Enterprise, tests) |
| `scopes` | Default `['openid', 'email', 'profile']` for OIDC; GitHub `['read:user', 'user:email']` |
| `authParams` | Extra authorize parameters, e.g. `{ prompt: 'select_account' }`, `{ hd: 'example.com' }` |
| `tokenAuth` | `'post'` (default, client secret in the form) or `'basic'` (HTTP Basic) |
| `pkce` | Default `true` |
| `profile` | For `oauth2`: `(raw, tokens) => ({ subject, email, emailVerified, name, picture })` from the userinfo answer |
| `preset` | Start from a preset under another id: `ghe: { preset: 'github', authorizationUrl: ..., ... }` |

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `INVALID_STATE` | Unknown, used or expired flow. Start again. |
| 400 | `OTHER_DEVICE` | The `requestId` (or cookie) does not match the browser that started. The flow is not used up. |
| 400 | `OAUTH_DENIED` | The provider sent back an `error` (the user cancelled). |
| 400 | `OAUTH_FAILED` | Code exchange failed, or the ID token was refused. |
| 400 | `EMAIL_NOT_VERIFIED` | A new account needs a verified email. |
| 403 | `FORBIDDEN` | Registration off, disabled account, or a link callback by another user. |
| 409 | `ACCOUNT_EXISTS`, `IDENTITY_IN_USE`, `LAST_SIGN_IN_METHOD` | See above. |
| 429 | `RATE_LIMITED` | The account is locked by failed password attempts. |
| 502 | `OAUTH_PROVIDER_ERROR` | The provider did not answer. |

## Security

- **PKCE (S256)** on every flow: an intercepted authorization code is useless without the verifier, which never leaves the server.
- **state** is 256 random bits, stored as a SHA-256 hash, single use (claimed with one atomic update) and short lived.
- **Browser binding**: the callback must present the `requestId` (or cookie) of the browser that started the flow. Without it, an attacker could send you a callback link for their own provider account and you would end up signed in as them (login CSRF).
- **ID tokens** are verified with the provider's JWKS: RS, PS, ES and EdDSA algorithms only (`none` and `HS*` are refused), the key must match the token's `kid`, and `iss`, `aud` (and `azp`), `exp`, `iat` and the flow's `nonce` are checked. Keys are cached for an hour and fetched again when a new `kid` appears.
- **Endpoints** come only from `calm.config.js` or the configured issuer's discovery document (whose `issuer` must match). Redirects are not followed, and production refuses non-https endpoints.
- **Linking by email** requires the provider's `email_verified` (GitHub: primary verified address). Without that rule, anyone could register at a provider that does not check emails with your address and sign in to your account. New accounts need a verified email for the same reason: otherwise an attacker could pre-create your account and keep their identity connected after you reset its password.
- Sign-in goes through `completeLogin`, so lockout, disabled accounts and 2FA apply. Every route uses the auth rate limit.
- Client secrets live in env vars and are never returned by any route.

## Events

| Event | Payload |
| --- | --- |
| `auth.login` | `{ user }` when a provider signs someone in |
| `auth.registered` | `{ user, via: 'oauth', provider }` |
| `security.invalid_oauth_state` | `{ reason: 'unknown' \| 'used' \| 'expired' \| 'other_device' \| 'other_user' \| 'unknown_user', ip, provider? }` |
| `security.oauth_failed` | `{ provider, reason, ip }` (e.g. `token_invalid_grant`, `id_token_wrong_nonce`, `id_token_bad_signature`, `denied_access_denied`) |
| `security.oauth_link_refused` | `{ provider, email?, userId?, reason: 'email_not_verified' \| 'auto_link_off' \| 'identity_in_use', ip }` |
| `security.oauth_linked` | `{ userId, provider, via: 'verified_email' \| 'link' }` |
| `security.oauth_unlinked` | `{ userId, provider }` |
| `security.locked_login_attempt` | `{ email, ip, via: 'oauth' }` |
