# CAPTCHA (captcha)

Stop bots on the routes they love: sign up, sign in, password reset and magic links (or any routes you list). The frontend renders a Cloudflare Turnstile, hCaptcha or Google reCAPTCHA v3 widget and sends its token with the request; the API checks it with the provider before the route runs, so a refused request never looks up an account, sends an email or hashes a password. reCAPTCHA v3 gets a minimum score and an action check. When the provider does not answer, requests are refused by default. Without a secret key, development and test skip the check so local work needs no keys. No dependencies.

```bash
npx calm add captcha
```

## Adds

| | |
| --- | --- |
| Files | `app/blocks/captcha/index.js` |
| Environment | `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` (or `HCAPTCHA_SITE_KEY` / `HCAPTCHA_SECRET_KEY`, `RECAPTCHA_SITE_KEY` / `RECAPTCHA_SECRET_KEY`) |
| Routes | `GET /api/captcha` |
| Protects | `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/password/forgot`, `POST /api/auth/magic-link` (when the magic-link block is installed) |

## Setup

1. Create a site at your provider and copy its two keys:
   - Cloudflare Turnstile (default): Cloudflare dashboard, Turnstile, "Add widget".
   - hCaptcha: hCaptcha dashboard, add a site; set `provider: 'hcaptcha'`.
   - reCAPTCHA v3: reCAPTCHA admin console, type "Score based (v3)"; set `provider: 'recaptcha'`.
2. Put them in `.env`:

```bash
TURNSTILE_SITE_KEY=0x4AAAA...
TURNSTILE_SECRET_KEY=0x4AAAA...
```

3. Run `npx calm doctor`. In production a missing secret key is an error: every protected route answers `503` until it is set.

For staging, Cloudflare documents dummy Turnstile keys that always pass or always fail ("Testing" in the Turnstile docs); they work with this block unchanged.

## The frontend

Ask the API what to render:

```http
GET /api/captcha
```

```json
200 { "data": { "provider": "turnstile", "siteKey": "0x4AAAA...", "header": "x-captcha-token", "field": "captchaToken", "routes": ["POST /auth/register", "POST /auth/login", "POST /auth/password/forgot", "POST /auth/magic-link"] } }
```

With reCAPTCHA and an `action` option, the answer also has `action` (one for every route) or `actions` (per route).

Send the widget's token with the protected request, in the `x-captcha-token` header (preferred) or a `captchaToken` body field:

```html
<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>
<form id="login">
  <input name="email" type="email" /> <input name="password" type="password" />
  <div class="cf-turnstile" data-sitekey="0x4AAAA..." data-action="login"></div>
  <button>Sign in</button>
</form>
<script>
  document.querySelector('#login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-captcha-token': form.get('cf-turnstile-response') },
      body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
    });
    if (!res.ok) turnstile.reset(); // tokens work once: get a fresh one for the next try
  });
</script>
```

reCAPTCHA v3 has no widget; ask for a token with the action of the page:

```js
const token = await grecaptcha.execute(siteKey, { action: 'login' });
await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-captcha-token': token }, body: JSON.stringify({ email, password }) });
```

## Errors

| Status | Code | When |
| --- | --- | --- |
| 400 | `CAPTCHA_REQUIRED` | No token in the header or the body. |
| 400 | `CAPTCHA_INVALID` | The provider refused the token (wrong, expired, already used), the score is below `minScore`, the action or the hostname does not match. |
| 503 | `CAPTCHA_UNAVAILABLE` | The provider did not answer (and `failOpen` is off), or there is no secret key outside development and test. |

## Options

```js
export default defineConfig({
  blocks: {
    captcha: {
      provider: 'recaptcha',
      routes: ['POST /auth/register', 'POST /auth/login', 'POST /posts/:id/comments'],
      minScore: 0.5,
      action: { 'POST /auth/login': 'login', 'POST /auth/register': 'signup', 'POST /posts/:id/comments': 'comment' },
    },
  },
});
```

| Option | Default | What it does |
| --- | --- | --- |
| `provider` | `'turnstile'` | `'turnstile'`, `'hcaptcha'` or `'recaptcha'` (v3). |
| `routes` | the four auth routes above | Routes that need a token: `'METHOD /path'` as declared, without the API prefix (`'POST /api/posts'` is accepted too). The list replaces the defaults. Doctor warns about entries that match no route. |
| `header` | `'x-captcha-token'` | Header the token is read from. |
| `field` | `'captchaToken'` | Body field read when the header is missing. It is removed before the route validates its input. |
| `minScore` | `0.5` | reCAPTCHA v3: lowest score accepted (0.0 is a bot, 1.0 a human). |
| `action` | `null` | Expected action: one string, or a map from route to action. reCAPTCHA v3 always checks it when set; Turnstile when the widget declared one (`data-action`). |
| `hostnames` | `null` | Hostnames the token must have been solved on, e.g. `['app.example.com']`. |
| `failOpen` | `false` | Let requests through when the provider does not answer. A refused token is still refused. |
| `timeoutMs` | `5000` | Timeout of the siteverify request. |
| `bypass` | `null` | Without a secret key, development and test skip the check (one warning in the log). `false` refuses instead. Production never skips. |
| `verifyUrl` | the provider's | Siteverify endpoint override (tests, an egress proxy). |

## Security

- The token is checked server side with the secret key, the client IP (`remoteip`) and, for hCaptcha, the site key. Only the site key is ever returned to clients.
- Tokens are single use at the provider, so a solved token cannot be replayed.
- The check is a guard (`calm.guard`, order `-50`), so it runs before other guards, the policy, input validation and the handler, after the auth rate limit.
- Fails closed: an attacker who can slow the provider down does not switch the protection off. `failOpen: true` trades that for availability.
- reCAPTCHA v3: the action check stops a token earned on a harmless page from being spent on login.
- Behind a proxy, set `TRUST_PROXY` so the client IP sent to the provider is the real one.
- A CAPTCHA slows down bots, it does not stop a determined attacker. Keep the auth rate limit and account lockout on.

## Events

| Event | Payload |
| --- | --- |
| `security.captcha_failed` | `{ path, ip, reason, score? }`; `reason` is `missing`, `too_long`, `low_score`, `wrong_action`, `wrong_hostname` or `rejected:<provider error codes>` |
| `security.captcha_unavailable` | `{ path, ip, failOpen }` |
