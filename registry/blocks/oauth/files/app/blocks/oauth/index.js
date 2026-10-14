import { createHash, randomBytes } from 'node:crypto';
import { definePlugin, f, validateInput, hashToken, CalmError, forbidden, notFound, tooManyRequests, validationError } from '#calm';
import { resolveProviders, createClient, ProviderError } from './providers.js';

// Sign in with Google, GitHub or any OpenID Connect provider (authorization code flow).
//
//  - Every flow has a random state, a PKCE verifier (S256) and, for OpenID Connect, a nonce.
//    The state and nonce are stored as SHA-256 hashes; the verifier is stored as is (the
//    token endpoint needs it) and is useless without the code only the browser receives.
//    Flows expire after 10 minutes and are claimed with one atomic update: they work once.
//  - Starting a flow returns a requestId (or sets an HttpOnly cookie for the redirect
//    start). The callback must send it back: a code and state produced in someone else's
//    browser are refused. That stops login CSRF (being signed in to an attacker's account).
//  - ID tokens are verified with the provider's JWKS (signature, iss, aud, exp, nonce).
//  - Identities (provider + subject) are linked to users in calm_oauth_identities. An
//    existing account is linked by email only when the provider says the email is verified,
//    and new accounts need a verified email too: otherwise anyone could create an account
//    at a provider that does not check emails and take over (or pre-claim) yours.
//  - Account lockout, disabled accounts and login challenges (the totp block) apply exactly
//    as they do for password sign-in: the block signs in through completeLogin().

const sha = hashToken;
const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');
const b64sha = (s) => createHash('sha256').update(s).digest('base64url');
const COOKIE = 'calm_oauth_rid';
const invalidState = () => new CalmError(400, 'INVALID_STATE', 'This sign-in has expired or was already used. Start again.');
const otherDevice = () => new CalmError(400, 'OTHER_DEVICE', 'Finish signing in in the browser where you started');

export default definePlugin({
  name: 'oauth',
  env: {
    GOOGLE_CLIENT_ID: 'OAuth client id from the Google Cloud console (turns on "Sign in with Google")',
    GOOGLE_CLIENT_SECRET: { secret: true, description: 'OAuth client secret from the Google Cloud console' },
    GITHUB_CLIENT_ID: 'Client id of your GitHub OAuth app (turns on "Sign in with GitHub")',
    GITHUB_CLIENT_SECRET: { secret: true, description: 'Client secret of your GitHub OAuth app' },
  },
  options: {
    /**
     * Providers by id. google and github are presets turned on by their env vars. Add any
     * OpenID Connect provider: okta: { type: 'oidc', issuer, clientId, clientSecret, name }.
     * Endpoints (authorizationUrl, tokenUrl, userinfoUrl, jwksUrl, emailsUrl) can be overridden.
     */
    providers: { google: {}, github: {} },
    /** Frontend page providers send the browser back to. Default: APP_URL + '/auth/oauth/callback'. */
    callbackUrl: null,
    ttlMinutes: 10,
    /** Unknown people get an account (only while config.auth.register is on). */
    createAccount: true,
    /** Sign in to an existing account with the same email, when the provider verified that email. */
    linkVerifiedEmail: true,
    /** Origins `redirect` may point to. Default: the origin of APP_URL. */
    allowedRedirects: null,
    /** Timeout for each request to a provider. */
    timeoutMs: 10_000,
  },
  setup(calm, options) {
    const declared = new Set(['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']);
    const env = (key) => (declared.has(key) ? calm.env(key) : process.env[key] || undefined);
    const providers = resolveProviders(options.providers, env);
    const enabled = () => providers.filter((p) => p.enabled);
    const production = calm.config.mode === 'production';
    const client = createClient({ timeoutMs: options.timeoutMs, production, userAgent: `${calm.config.app.name} (CalmAPI oauth)` });

    // Accounts this block created get a random password nobody knows. The flag lets unlink
    // refuse to remove their last way in; setting a password (reset flow) clears it.
    calm.onResource((def) => {
      if (def.name !== 'user') return def;
      def.fields.oauthNoPassword = f.boolean().hidden();
      return def;
    });

    const { Schema } = calm.mongoose;
    const flowSchema = new Schema(
      {
        stateHash: { type: String, required: true, unique: true },
        provider: { type: String, required: true },
        purpose: { type: String, enum: ['login', 'link'], required: true },
        user: { type: Schema.Types.ObjectId, ref: 'user', default: null }, // the signed-in user, for link flows
        verifier: { type: String, required: true },
        nonceHash: { type: String, required: true },
        requestHash: { type: String, required: true },
        redirect: { type: String, default: null },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
        ip: String,
        userAgent: String,
      },
      { collection: 'calm_oauth_flows', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
    );
    flowSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Flow = calm.mongoose.model('calmOAuthFlow', flowSchema);

    const identitySchema = new Schema(
      {
        provider: { type: String, required: true },
        subject: { type: String, required: true },
        user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
        email: { type: String, default: null },
        name: { type: String, default: null },
        lastUsedAt: { type: Date, default: null },
      },
      { collection: 'calm_oauth_identities', timestamps: true, versionKey: false },
    );
    identitySchema.index({ provider: 1, subject: 1 }, { unique: true });
    const Identity = calm.mongoose.model('calmOAuthIdentity', identitySchema);
    calm.provide('oauth', { Flow, Identity, providers: enabled });

    const appUrl = new URL(calm.config.app.url);
    const callbackUrl = options.callbackUrl ?? `${calm.config.app.url.replace(/\/$/, '')}/auth/oauth/callback`;
    const allowed = new Set(
      (options.allowedRedirects?.length ? options.allowedRedirects : [appUrl.origin]).map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`oauth: allowedRedirects entry "${o}" is not a URL (use origins like https://app.example.com)`);
        }
      }),
    );

    const users = () => calm.app.model('user');
    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    const canSignUp = () => Boolean(options.createAccount && calm.config.auth.register);
    const cookiePath = `${calm.config.apiPrefix}/auth/oauth`;
    const secureCookie = production || appUrl.protocol === 'https:';

    calm.on('auth.password_reset', ({ userId }) => users().updateOne({ _id: userId }, { $unset: { oauthNoPassword: 1 } }));
    calm.on('auth.password_changed', ({ user }) => users().updateOne({ _id: user._id }, { $unset: { oauthNoPassword: 1 } }));

    /** Redirect targets must be on an allowed origin: paths resolve against APP_URL. */
    function checkRedirect(value) {
      if (value === undefined || value === null || value === '') return null;
      let url = null;
      try {
        url = value.startsWith('/') ? new URL(value, appUrl) : new URL(value);
      } catch {
        // falls through to the refusal below
      }
      // Comparing parsed origins also catches "//evil.com", "/\evil.com" and "https://app.com@evil.com".
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || !allowed.has(url.origin)) {
        throw validationError({ redirect: 'This redirect is not allowed' });
      }
      return url.href;
    }

    function providerOf(id) {
      const p = providers.find((x) => x.id === id && x.enabled);
      if (!p) throw notFound('Unknown sign-in provider');
      return p;
    }

    /** Store a new flow and build the provider URL. */
    async function startFlow(ctx, p, { purpose, redirect, user = null }) {
      const state = randomBytes(32).toString('base64url');
      const nonce = randomBytes(24).toString('base64url');
      const verifier = randomBytes(32).toString('base64url');
      const requestId = randomBytes(12).toString('base64url');
      const url = await client.authorizeUrl(p, { state, nonce, challenge: b64sha(verifier), redirectUri: callbackUrl });
      await Flow.create({
        stateHash: sha(state),
        provider: p.id,
        purpose,
        user,
        verifier,
        nonceHash: createHash('sha256').update(nonce).digest('hex'),
        requestHash: sha(requestId),
        redirect,
        expiresAt: new Date(Date.now() + options.ttlMinutes * 60_000),
        ip: ctx.req.ip,
        userAgent: ctx.req.get('user-agent')?.slice(0, 300),
      });
      return { url, requestId, expiresIn: options.ttlMinutes * 60 };
    }

    const readCookie = (req) => {
      for (const part of String(req.headers.cookie ?? '').split(';')) {
        const [k, ...v] = part.trim().split('=');
        if (k === COOKIE) return decodeURIComponent(v.join('='));
      }
      return null;
    };
    const cookie = (value, maxAge) =>
      `${COOKIE}=${value}; Path=${cookiePath}; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secureCookie ? '; Secure' : ''}`;

    /** Create an account for a verified email (or find it, if it was created meanwhile). */
    async function newAccount(profile, ctx) {
      const entry = calm.app.registry.get('user');
      const passwordField = Object.entries(entry.def.fields).find(([, field]) => field.type === 'password')?.[0];
      // A random password nobody knows: the owner signs in with the provider, or sets a
      // password through the reset flow. Add your own required fields here.
      const input = { email: profile.email, [passwordField]: randomBytes(24).toString('base64url') };
      if (entry.def.fields.name) input.name = profile.name || profile.email.split('@')[0].slice(0, 100);
      const data = await validateInput(entry.def, input, { mode: 'create', user: null, unknownFields: calm.config.unknownFields });
      try {
        const user = await entry.service.create(data, { ...ctx, user: null });
        await users().updateOne({ _id: user._id }, { $set: { oauthNoPassword: true } });
        return { user, created: true };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return { user: await users().findOne({ email: profile.email }).lean(), created: false };
      }
    }

    /** Save provider + subject -> user. Resolves to the identity linked to that subject (maybe another user's). */
    async function saveIdentity(p, profile, userId) {
      try {
        return (await Identity.create({ provider: p.id, subject: profile.subject, user: userId, email: profile.email, name: profile.name, lastUsedAt: new Date() })).toObject();
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return Identity.findOne({ provider: p.id, subject: profile.subject }).lean();
      }
    }

    /** Locked (password guessing) and disabled accounts stay closed, whatever the way in. */
    async function checkCanSignIn(user, ctx) {
      // The lockout of calm/auth: an account locked by password guessing stays locked here.
      const locked = await calm.app.auth.service.lockedUntil(user.email);
      if (locked) {
        security('locked_login_attempt', { email: mask(user.email), ip: ctx.req.ip, via: 'oauth' });
        const minutes = Math.max(1, Math.ceil((locked - Date.now()) / 60_000));
        throw tooManyRequests(`Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
      if (calm.app.auth.service.inactive(user)) throw forbidden('This account is disabled');
    }

    /** The user a login with this identity signs in as, linking or creating as the rules allow. */
    async function resolveUser(p, profile, ctx) {
      const identity = await Identity.findOne({ provider: p.id, subject: profile.subject }).lean();
      if (identity) {
        const user = await users().findById(identity.user).lean();
        if (user) {
          await checkCanSignIn(user, ctx);
          await Identity.updateOne({ _id: identity._id }, { $set: { lastUsedAt: new Date(), email: profile.email } });
          return { user, created: false };
        }
        await Identity.deleteOne({ _id: identity._id }); // the account was deleted: start over
      }

      const existing = profile.email ? await users().findOne({ email: profile.email }).lean() : null;
      if (existing) {
        // Same email is not proof of the same person: only a verified email links.
        if (!profile.emailVerified || !options.linkVerifiedEmail) {
          security('oauth_link_refused', { provider: p.id, email: mask(profile.email), reason: profile.emailVerified ? 'auto_link_off' : 'email_not_verified', ip: ctx.req.ip });
          throw new CalmError(409, 'ACCOUNT_EXISTS', `An account with this email already exists. Sign in to it, then connect ${p.name} from your account settings.`);
        }
        await checkCanSignIn(existing, ctx); // before linking: a closed account gets no new way in
        const linked = await saveIdentity(p, profile, existing._id);
        if (String(linked.user) !== String(existing._id)) throw new CalmError(409, 'IDENTITY_IN_USE', `This ${p.name} account is connected to another user`);
        security('oauth_linked', { userId: String(existing._id), provider: p.id, via: 'verified_email' });
        return { user: existing, created: false };
      }

      if (!canSignUp()) throw forbidden('Registration is disabled');
      if (!profile.email || !profile.emailVerified) {
        throw new CalmError(400, 'EMAIL_NOT_VERIFIED', `${p.name} did not share a verified email address, so no account can be created with it`);
      }
      const { user, created } = await newAccount(profile, ctx);
      if (!created) await checkCanSignIn(user, ctx); // created meanwhile by someone else
      const linked = await saveIdentity(p, profile, user._id);
      if (String(linked.user) !== String(user._id)) throw new CalmError(409, 'IDENTITY_IN_USE', `This ${p.name} account is connected to another user`);
      if (created) calm.events.emit('auth.registered', { user: { ...user, id: String(user._id) }, via: 'oauth', provider: p.id });
      return { user, created };
    }

    const identityView = (i) => ({ id: String(i._id), provider: i.provider, name: providers.find((p) => p.id === i.provider)?.name ?? i.provider, email: i.email, createdAt: i.createdAt, lastUsedAt: i.lastUsedAt });

    calm.routes(
      (r) => {
        if (!calm.app.auth) {
          calm.log.warn('oauth: auth is off (or there is no user resource), so its routes are not registered');
          return;
        }

        r.get('/providers', { policy: 'public', summary: 'Sign-in providers that are turned on (for login buttons)', tags: ['auth'] }, () =>
          enabled().map((p) => ({ id: p.id, name: p.name, type: p.type })),
        );

        const startInput = { redirect: f.string().max(2000) };

        r.post(
          '/:provider/start',
          { policy: 'public', rateLimit: 'auth', summary: 'Start signing in with a provider: returns its URL and a requestId', input: startInput, tags: ['auth'] },
          async (ctx) => {
            const p = providerOf(ctx.params.provider);
            return startFlow(ctx, p, { purpose: 'login', redirect: checkRedirect(ctx.body.redirect) });
          },
        );

        // Plain links (<a href="/api/auth/oauth/google/start">): the requestId travels in an
        // HttpOnly cookie instead, which only works when the callback page is on the API's site.
        r.get('/:provider/start', { policy: 'public', rateLimit: 'auth', summary: 'Start signing in with a provider: redirects to it', tags: ['auth'] }, async (ctx) => {
          const p = providerOf(ctx.params.provider);
          const redirect = checkRedirect(typeof ctx.query.redirect === 'string' ? ctx.query.redirect.slice(0, 2000) : null);
          const flow = await startFlow(ctx, p, { purpose: 'login', redirect });
          ctx.res.setHeader('Set-Cookie', cookie(flow.requestId, flow.expiresIn));
          ctx.res.redirect(302, flow.url);
        });

        r.post(
          '/:provider/link',
          { policy: 'authenticated', rateLimit: 'auth', summary: 'Connect a provider to your account: returns its URL and a requestId', input: startInput, tags: ['auth'] },
          async (ctx) => {
            const p = providerOf(ctx.params.provider);
            return startFlow(ctx, p, { purpose: 'link', user: ctx.user._id, redirect: checkRedirect(ctx.body.redirect) });
          },
        );

        r.post(
          '/callback',
          {
            policy: 'public',
            rateLimit: 'auth',
            summary: 'Finish signing in (or connecting) with the code and state the provider sent back',
            input: { code: f.string().max(2000), state: f.string().required().max(200), requestId: f.string().max(100), error: f.string().max(200) },
            tags: ['auth'],
          },
          async (ctx) => {
            const { code, state, error } = ctx.body;
            const requestId = ctx.body.requestId ?? readCookie(ctx.req);
            const now = new Date();
            const flow = await Flow.findOne({ stateHash: sha(state) }).lean();
            const refuse = (reason, err = invalidState()) => {
              security('invalid_oauth_state', { reason, ip: ctx.req.ip, ...(flow ? { provider: flow.provider } : {}) });
              return err;
            };
            if (!flow) throw refuse('unknown');
            if (flow.usedAt) throw refuse('used');
            if (flow.expiresAt <= now) throw refuse('expired');
            // Checked before the claim, so a wrong browser does not burn the flow.
            if (!requestId || sha(requestId) !== flow.requestHash) throw refuse('other_device', otherDevice());
            // Connecting a provider: the browser must still be signed in as the user who started it.
            if (flow.purpose === 'link' && String(ctx.user?._id) !== String(flow.user)) throw refuse('other_user', forbidden('Sign in as the account that started connecting this provider'));

            // The claim itself: one atomic update, so a flow works exactly once.
            const claimed = await Flow.findOneAndUpdate({ _id: flow._id, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }).lean();
            if (!claimed) throw refuse('used');
            if (requestId === readCookie(ctx.req)) ctx.res.setHeader('Set-Cookie', cookie('', 0));

            const p = providerOf(flow.provider);
            if (error) {
              security('oauth_failed', { provider: p.id, reason: `denied_${error.slice(0, 50)}`, ip: ctx.req.ip });
              throw new CalmError(400, 'OAUTH_DENIED', `Sign-in with ${p.name} was cancelled or refused`);
            }
            if (!code) throw validationError({ code: 'Required' });

            let profile;
            try {
              const tokens = await client.exchange(p, { code, verifier: flow.verifier, redirectUri: callbackUrl });
              profile = await client.profile(p, tokens, { nonceHash: flow.nonceHash });
            } catch (err) {
              if (err instanceof ProviderError) security('oauth_failed', { provider: p.id, reason: err.reason, ip: ctx.req.ip });
              throw err;
            }
            const extra = flow.redirect ? { redirect: flow.redirect } : {};

            if (flow.purpose === 'link') {
              const linked = await saveIdentity(p, profile, flow.user);
              if (String(linked.user) !== String(flow.user)) {
                security('oauth_link_refused', { provider: p.id, userId: String(flow.user), reason: 'identity_in_use', ip: ctx.req.ip });
                throw new CalmError(409, 'IDENTITY_IN_USE', `This ${p.name} account is connected to another user`);
              }
              security('oauth_linked', { userId: String(flow.user), provider: p.id, via: 'link' });
              return { linked: true, identity: identityView(linked), ...extra };
            }

            const { user, created } = await resolveUser(p, profile, ctx);
            if (!user) throw refuse('unknown_user');

            const { password: _p, oauthNoPassword: _n, ...safe } = user;
            // Login challenges (a second factor from the totp block) apply here too.
            return { ...(await calm.app.auth.service.completeLogin(safe, ctx)), provider: p.id, ...extra, ...(created ? { created: true } : {}) };
          },
        );

        r.get('/identities', { policy: 'authenticated', summary: 'Providers connected to your account', tags: ['auth'] }, async (ctx) =>
          (await Identity.find({ user: ctx.user._id }).sort({ createdAt: 1 }).lean()).map(identityView),
        );

        r.delete('/identities/:identityId', { policy: 'authenticated', rateLimit: 'auth', summary: 'Disconnect a provider from your account', tags: ['auth'] }, async (ctx) => {
          const identity = await Identity.findOne({ _id: ctx.params.identityId, user: ctx.user._id }).lean().catch(() => null);
          if (!identity) throw notFound('Connected account not found');
          const others = await Identity.countDocuments({ user: ctx.user._id, _id: { $ne: identity._id } });
          const user = await users().findById(ctx.user._id).select('+oauthNoPassword').lean();
          // Without a password, another provider or magic links, this identity is the only way
          // in: removing it would lock the owner out (they could still reset a password by
          // email, but nothing tells them so). Ask them to set a password first.
          if (user?.oauthNoPassword && others === 0 && !calm.app.ext.magicLink) {
            throw new CalmError(409, 'LAST_SIGN_IN_METHOD', 'This is the only way you can sign in. Set a password (Forgot password) or connect another provider first.');
          }
          const res = await Identity.deleteOne({ _id: identity._id, user: ctx.user._id });
          if (res.deletedCount) security('oauth_unlinked', { userId: String(ctx.user._id), provider: identity.provider });
        });
      },
      { prefix: '/auth/oauth' },
    );

    calm.doctor((app) => {
      const findings = [];
      if (!app.auth) findings.push({ level: 'error', id: 'oauth-no-auth', title: 'oauth needs auth', detail: 'Turn auth on and keep the user resource (email and password fields): providers sign users in.' });
      for (const p of providers) {
        if (p.enabled) continue;
        const explicit = options.providers?.[p.id] && Object.keys(options.providers[p.id]).length > 0;
        const missing = [p.clientId ? null : (p.clientIdEnv ?? 'clientId'), p.clientSecret ? null : (p.clientSecretEnv ?? 'clientSecret')].filter(Boolean);
        // A half-configured provider is a mistake; presets without any credentials are just unused.
        if (explicit || p.clientId || p.clientSecret) {
          findings.push({ level: 'error', id: `oauth-${p.id}-credentials`, title: `${p.name} sign-in is not configured`, detail: `Set ${missing.join(' and ')} (calm.config.js blocks.oauth.providers.${p.id} or .env).` });
        }
      }
      if (!enabled().length) {
        findings.push({ level: 'warn', id: 'oauth-no-providers', title: 'No sign-in provider is turned on', detail: 'Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or add an OpenID Connect provider in calm.config.js blocks.oauth.providers.' });
      }
      if (production) {
        if (!callbackUrl.startsWith('https://')) {
          findings.push({ level: 'error', id: 'oauth-http-callback', title: 'The OAuth callback URL is not https', detail: `Authorization codes would travel in clear text to ${callbackUrl}. Use https (APP_URL or blocks.oauth.callbackUrl).` });
        }
        for (const p of enabled()) {
          for (const key of ['issuer', 'authorizationUrl', 'tokenUrl', 'userinfoUrl', 'jwksUrl', 'emailsUrl']) {
            if (p[key] && !String(p[key]).startsWith('https://')) {
              findings.push({ level: 'error', id: `oauth-${p.id}-http`, title: `${p.name}: ${key} is not https`, detail: `${p[key]}: codes, secrets and tokens must not travel in clear text. These requests are refused in production.` });
            }
          }
        }
      }
      return findings;
    });
  },
});
