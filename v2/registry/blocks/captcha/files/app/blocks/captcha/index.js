import { definePlugin, CalmError } from '#calm';

// CAPTCHA on the routes bots love: sign up, sign in, password reset, magic links.
//
//  - A guard (calm.guard) runs before the listed routes, so a request without a valid token
//    never reaches the handler: no account lookup, no email, no password hashing.
//  - The token comes from a header (x-captcha-token) or a body field (captchaToken). The
//    body field is removed before the route validates its input.
//  - It is checked server side with the provider's siteverify endpoint (Cloudflare
//    Turnstile, hCaptcha or Google reCAPTCHA v3), with the client IP. Tokens are single use
//    at the provider, so a solved token cannot be replayed.
//  - reCAPTCHA v3: a minimum score, and the action the frontend declared must match, so a
//    token earned on a harmless page cannot be spent on login.
//  - The provider not answering fails closed (503) by default: an attacker who can slow the
//    provider down should not switch the protection off. failOpen trades that for uptime.
//  - Without a secret key, development and test skip the check (with a warning) so local
//    work needs no keys; production never skips, and doctor reports the missing key.

const PROVIDERS = {
  turnstile: { name: 'Cloudflare Turnstile', verifyUrl: 'https://challenges.cloudflare.com/turnstile/v0/siteverify', secret: 'TURNSTILE_SECRET_KEY', site: 'TURNSTILE_SITE_KEY' },
  hcaptcha: { name: 'hCaptcha', verifyUrl: 'https://api.hcaptcha.com/siteverify', secret: 'HCAPTCHA_SECRET_KEY', site: 'HCAPTCHA_SITE_KEY' },
  recaptcha: { name: 'Google reCAPTCHA v3', verifyUrl: 'https://www.google.com/recaptcha/api/siteverify', secret: 'RECAPTCHA_SECRET_KEY', site: 'RECAPTCHA_SITE_KEY' },
};
const DEFAULT_ROUTES = ['POST /auth/register', 'POST /auth/login', 'POST /auth/password/forgot', 'POST /auth/magic-link'];
const MAX_TOKEN = 2048; // Turnstile documents 2048 characters as the maximum

const required = () => new CalmError(400, 'CAPTCHA_REQUIRED', 'Complete the CAPTCHA and try again');
const invalid = () => new CalmError(400, 'CAPTCHA_INVALID', 'The CAPTCHA could not be verified. Try again.');
const unavailable = () => new CalmError(503, 'CAPTCHA_UNAVAILABLE', 'The CAPTCHA check is unavailable right now. Try again in a moment.');

export default definePlugin({
  name: 'captcha',
  env: {
    TURNSTILE_SITE_KEY: 'Cloudflare Turnstile site key (public, used by your frontend widget)',
    TURNSTILE_SECRET_KEY: { secret: true, description: 'Cloudflare Turnstile secret key' },
    HCAPTCHA_SITE_KEY: 'hCaptcha site key (when provider is hcaptcha)',
    HCAPTCHA_SECRET_KEY: { secret: true, description: 'hCaptcha secret key (when provider is hcaptcha)' },
    RECAPTCHA_SITE_KEY: 'reCAPTCHA v3 site key (when provider is recaptcha)',
    RECAPTCHA_SECRET_KEY: { secret: true, description: 'reCAPTCHA v3 secret key (when provider is recaptcha)' },
  },
  options: {
    /** 'turnstile', 'hcaptcha' or 'recaptcha' (v3). */
    provider: 'turnstile',
    /** Routes that need a token, as 'METHOD /path' without the API prefix. Default: sign up, sign in, password reset, magic link. */
    routes: null,
    /** Where the token is read: this header first, then this body field. */
    header: 'x-captcha-token',
    field: 'captchaToken',
    /** reCAPTCHA v3: lowest score accepted (0.0 bot to 1.0 human). */
    minScore: 0.5,
    /** Expected action: a string for every route, or { 'POST /auth/login': 'login', ... }. Checked when the provider returns one. */
    action: null,
    /** Hostnames the token must have been solved on (from the provider's answer). Default: any. */
    hostnames: null,
    /** Let requests through when the provider does not answer (default: refuse with 503). */
    failOpen: false,
    timeoutMs: 5000,
    /** Skip the check when no secret key is set. Default: on in development and test, never in production. */
    bypass: null,
    /** Override the siteverify endpoint (tests, proxies). */
    verifyUrl: null,
  },
  setup(calm, options) {
    const preset = () => {
      const p = PROVIDERS[options.provider];
      if (!p) throw new Error(`captcha: provider must be one of ${Object.keys(PROVIDERS).join(', ')} (got "${options.provider}")`);
      return p;
    };
    preset(); // fail at boot on a typo
    const production = calm.config.mode === 'production';
    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    // Read on each request (cheap), so rotating keys or options in tests needs no restart.
    const secret = () => calm.env(preset().secret);
    const siteKey = () => calm.env(preset().site) ?? null;
    const bypassing = () => !secret() && !production && options.bypass !== false;
    const prefix = calm.config.apiPrefix;
    const normalize = (entry) => {
      const [method, ...rest] = String(entry).trim().split(/\s+/);
      let path = rest.join('');
      if (path.startsWith(`${prefix}/`)) path = path.slice(prefix.length); // 'POST /api/auth/login' works too
      return `${method.toUpperCase()} ${path.replace(/\/$/, '') || '/'}`;
    };
    const protectedRoutes = () => new Set((options.routes ?? DEFAULT_ROUTES).map(normalize));
    let warned = false;

    /** Expected action for a route, or null when none is configured. */
    function expectedAction(key) {
      if (!options.action) return null;
      if (typeof options.action === 'string') return options.action;
      const map = Object.fromEntries(Object.entries(options.action).map(([k, v]) => [normalize(k), v]));
      return map[key] ?? null;
    }

    /** Ask the provider. Resolves to its JSON answer, or null when it did not answer. */
    async function siteverify(token, ip) {
      const form = new URLSearchParams({ secret: secret(), response: token });
      if (ip) form.set('remoteip', ip);
      if (options.provider === 'hcaptcha' && siteKey()) form.set('sitekey', siteKey()); // binds the token to our site key
      try {
        const res = await fetch(options.verifyUrl ?? preset().verifyUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
          body: form.toString(),
          redirect: 'error',
          signal: AbortSignal.timeout(options.timeoutMs),
        });
        if (!res.ok) return null;
        const body = await res.json();
        return body && typeof body === 'object' ? body : null;
      } catch {
        return null; // network error, timeout or not JSON: the provider did not answer
      }
    }

    /** Why the answer is refused, or null when it is accepted. */
    function refusal(answer, key) {
      if (answer.success !== true) return `rejected:${[].concat(answer['error-codes'] ?? []).join(',') || 'unknown'}`;
      if (options.provider === 'recaptcha' && !(typeof answer.score === 'number' && answer.score >= options.minScore)) return 'low_score';
      const action = expectedAction(key);
      // reCAPTCHA v3 always returns the action; Turnstile only when the widget set one.
      if (action && (options.provider === 'recaptcha' || answer.action !== undefined) && answer.action !== action) return 'wrong_action';
      if (options.hostnames?.length && !options.hostnames.includes(answer.hostname)) return 'wrong_hostname';
      return null;
    }

    calm.guard(
      async (ctx, route) => {
        const key = `${route.method} ${route.path}`;
        if (!protectedRoutes().has(key)) return;
        const body = ctx.req.body && typeof ctx.req.body === 'object' ? ctx.req.body : null;
        const fromBody = body?.[options.field];
        if (body && options.field in body) delete body[options.field]; // never reaches the route's input validation
        const header = ctx.req.get(options.header);
        const token = header || (typeof fromBody === 'string' ? fromBody : '');
        const who = { path: key, ip: ctx.req.ip };

        if (bypassing()) {
          if (!warned) calm.log.warn(`captcha: no ${preset().secret} set, so CAPTCHA checks are skipped (${calm.config.mode} only)`);
          warned = true;
          return;
        }
        if (!token) {
          security('captcha_failed', { ...who, reason: 'missing' });
          throw required();
        }
        if (token.length > MAX_TOKEN) {
          security('captcha_failed', { ...who, reason: 'too_long' });
          throw invalid();
        }
        // Production without a secret: nothing to verify against, so nobody passes.
        if (!secret()) throw unavailable();

        const answer = await siteverify(token, ctx.req.ip);
        if (!answer) {
          security('captcha_unavailable', { ...who, failOpen: Boolean(options.failOpen) });
          if (options.failOpen) {
            calm.log.warn(`captcha: ${preset().name} did not answer, letting ${key} through (failOpen)`);
            return;
          }
          throw unavailable();
        }
        const reason = refusal(answer, key);
        if (reason) {
          security('captcha_failed', { ...who, reason, ...(typeof answer.score === 'number' ? { score: answer.score } : {}) });
          throw invalid();
        }
      },
      // Before other guards: a bot is turned away before anything else looks at the request.
      { order: -50 },
    );

    calm.routes(
      (r) => {
        r.get('/', { policy: 'public', summary: 'CAPTCHA settings for your frontend widget (site key, where to send the token)', tags: ['captcha'] }, () => ({
          provider: options.provider,
          siteKey: siteKey(),
          header: options.header,
          field: options.field,
          routes: [...protectedRoutes()],
          ...(options.provider === 'recaptcha' && typeof options.action === 'string' ? { action: options.action } : {}),
          ...(options.provider === 'recaptcha' && options.action && typeof options.action === 'object' ? { actions: options.action } : {}),
        }));
      },
      { prefix: '/captcha' },
    );

    calm.doctor((app) => {
      const findings = [];
      const p = preset();
      if (!secret()) {
        findings.push(
          production
            ? { level: 'error', id: 'captcha-no-secret', title: `${p.secret} is not set`, detail: `Every protected route answers 503 until it is set (${p.name} dashboard).` }
            : { level: 'warn', id: 'captcha-no-secret', title: `CAPTCHA checks are skipped: ${p.secret} is not set`, detail: 'Fine for local work. Production refuses protected requests without it.' },
        );
      }
      if (!siteKey()) findings.push({ level: production ? 'warn' : 'info', id: 'captcha-no-site-key', title: `${p.site} is not set`, detail: 'Your frontend needs the site key to render the widget (GET /api/captcha returns it).' });
      if (options.failOpen) findings.push({ level: 'info', id: 'captcha-fail-open', title: 'CAPTCHA fails open', detail: 'When the provider does not answer, protected routes are not protected.' });
      if (options.routes) {
        const known = new Set(app.routes.map((r) => `${r.method} ${r.path}`));
        for (const key of protectedRoutes()) {
          if (!known.has(key)) findings.push({ level: 'warn', id: `captcha-unknown-route-${key}`, title: `captcha: ${key} is not a route`, detail: 'Check blocks.captcha.routes: entries are "METHOD /path" without the API prefix.' });
        }
      }
      return findings;
    });
  },
});
