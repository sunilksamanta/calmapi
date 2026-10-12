import { randomBytes } from 'node:crypto';
import { definePlugin, f, validateInput, createToken, hashToken, CalmError, forbidden, tooManyRequests, validationError } from '#calm';

// Passwordless sign-in: post an email address, get a link, open it, you are signed in.
//
//  - The request always answers 202 with the same body, and the account lookup and the
//    email happen in the background (like password reset), so neither the answer nor its
//    timing reveals who has an account.
//  - Tokens are random, stored as SHA-256 hashes, expire after 15 minutes and work once:
//    they are claimed with one atomic update, so two clicks cannot both sign in.
//  - The first call returns a requestId for the browser that asked. Sent back on verify, it
//    binds the link to that browser: a link opened elsewhere with another requestId is
//    refused, and with requireSameDevice a link without it is refused too. That stops
//    login CSRF (someone mailing you a link to their own account) and makes leaked links
//    useless.
//  - Account lockout, disabled accounts and login challenges (the totp block) apply
//    exactly as they do for password sign-in.
//  - Per IP rate limit (config.rateLimit.auth) plus a per email cooldown in MongoDB, so
//    nobody can flood an inbox from many addresses or instances.

const sha = hashToken;
const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');
const invalidLink = () => new CalmError(400, 'INVALID_TOKEN', 'This sign-in link is invalid or has expired');
const otherDevice = () => new CalmError(400, 'OTHER_DEVICE', 'Open this link in the browser where you asked for it');

export default definePlugin({
  name: 'magic-link',
  options: {
    /** Page of your frontend that reads ?token= and calls /verify. Default: APP_URL + '/auth/magic'. */
    linkUrl: null,
    ttlMinutes: 15,
    /** Minimum time between two links for the same address. 0 turns the cooldown off. */
    cooldownSeconds: 60,
    /** Unknown addresses get a sign-up link (only while config.auth.register is on). */
    createAccount: false,
    /** Origins `redirect` may point to. Default: the origin of APP_URL. */
    allowedRedirects: null,
    /** Refuse links verified without the requestId of the browser that asked for them. */
    requireSameDevice: false,
  },
  setup(calm, options) {
    const { Schema } = calm.mongoose;
    const linkSchema = new Schema(
      {
        tokenHash: { type: String, required: true, unique: true },
        email: { type: String, required: true },
        user: { type: Schema.Types.ObjectId, ref: 'user', default: null }, // null: sign-up link
        name: String, // for sign-up links
        redirect: { type: String, default: null },
        requestHash: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
        ip: String,
        userAgent: String,
      },
      { collection: 'calm_magic_links', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
    );
    linkSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const MagicLink = calm.mongoose.model('calmMagicLink', linkSchema);

    // One document per address while its cooldown runs; MongoDB removes it afterwards.
    const cooldownSchema = new Schema({ _id: String, until: Date }, { collection: 'calm_magic_link_cooldowns', versionKey: false });
    cooldownSchema.index({ until: 1 }, { expireAfterSeconds: 0 });
    const Cooldown = calm.mongoose.model('calmMagicLinkCooldown', cooldownSchema);
    calm.provide('magicLink', { MagicLink, Cooldown });

    const appUrl = new URL(calm.config.app.url);
    const linkBase = options.linkUrl ?? `${calm.config.app.url.replace(/\/$/, '')}/auth/magic`;
    const allowed = new Set(
      (options.allowedRedirects?.length ? options.allowedRedirects : [appUrl.origin]).map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`magic-link: allowedRedirects entry "${o}" is not a URL (use origins like https://app.example.com)`);
        }
      }),
    );

    const users = () => calm.app.model('user');
    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    const canSignUp = () => Boolean(options.createAccount && calm.config.auth.register);

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

    /** Start the cooldown for an address. Returns 0, or the seconds left on a running one. */
    async function claimCooldown(email) {
      if (!options.cooldownSeconds) return 0;
      const now = new Date();
      const key = sha(`magic:${email}`);
      try {
        // Matches only a missing or finished cooldown; a running one makes the upsert
        // collide on _id, which is the atomic "someone was faster" signal across instances.
        await Cooldown.updateOne({ _id: key, until: { $lte: now } }, { $set: { until: new Date(now.getTime() + options.cooldownSeconds * 1000) } }, { upsert: true });
        return 0;
      } catch (err) {
        if (err?.code !== 11000) throw err;
        const doc = await Cooldown.findById(key).lean();
        return Math.max(1, Math.ceil(((doc?.until ?? now) - now) / 1000));
      }
    }

    // The lockout of calm/auth, so an account locked by password guessing cannot be opened
    // with a magic link either.
    const lockedUntil = (email) => calm.app.auth.service.lockedUntil(email);

    async function sendLink({ email, name, redirect, requestId, ip, userAgent }) {
      const user = await users().findOne({ email }).lean();
      if (calm.app.auth.service.inactive(user)) return;
      const signup = !user;
      if (signup && !canSignUp()) return;

      const token = createToken('magic');
      await MagicLink.create({
        tokenHash: sha(token),
        email,
        user: user?._id ?? null,
        name: signup ? name : undefined,
        redirect,
        requestHash: sha(requestId),
        expiresAt: new Date(Date.now() + options.ttlMinutes * 60_000),
        ip,
        userAgent,
      });
      const link = `${linkBase}${linkBase.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      const app = calm.config.app.name;
      const minutes = `valid for ${options.ttlMinutes} minutes, works once`;
      await calm.mailer.send(
        signup
          ? {
              to: email,
              subject: `Finish signing up for ${app}`,
              text: `Open this link to create your ${app} account and sign in (${minutes}):\n${link}\n\nIf you did not ask for this, ignore this email: no account is created without the link.`,
              meta: { kind: 'magic-link', purpose: 'signup', token },
            }
          : {
              to: email,
              subject: `Sign in to ${app}`,
              text: `Open this link to sign in to ${app} (${minutes}):\n${link}\n\nIf you did not ask for this, ignore this email: nobody can sign in without the link.`,
              meta: { kind: 'magic-link', purpose: 'login', token },
            },
      );
      calm.events.emit('auth.magic_link_requested', { user: user ? { ...user, id: String(user._id) } : null, email, signup });
    }

    /** Create the account behind a sign-up link (or find it, if it was created meanwhile). */
    async function newAccount(link, ctx) {
      if (!canSignUp()) throw forbidden('Registration is disabled');
      const existing = await users().findOne({ email: link.email }).lean();
      if (existing) return { user: existing, created: false };

      const entry = calm.app.registry.get('user');
      const passwordField = Object.entries(entry.def.fields).find(([, field]) => field.type === 'password')?.[0];
      // The account gets a random password nobody knows: the owner signs in with links,
      // or sets a password through the reset flow. Add your own required fields here.
      const input = { email: link.email, [passwordField]: randomBytes(24).toString('base64url') };
      if (entry.def.fields.name) input.name = link.name || link.email.split('@')[0].slice(0, 100);
      const data = await validateInput(entry.def, input, { mode: 'create', user: null, unknownFields: calm.config.unknownFields });
      try {
        const user = await entry.service.create(data, { ...ctx, user: null });
        calm.events.emit('auth.registered', { user: { ...user, id: String(user._id) }, via: 'magic-link' });
        return { user, created: true };
      } catch (err) {
        if (err?.code !== 11000) throw err;
        return { user: await users().findOne({ email: link.email }).lean(), created: false };
      }
    }

    calm.routes(
      (r) => {
        if (!calm.app.auth) {
          calm.log.warn('magic-link: auth is off (or there is no user resource), so its routes are not registered');
          return;
        }

        r.post(
          '/',
          {
            policy: 'public',
            status: 202,
            rateLimit: 'auth',
            summary: 'Email a sign-in link',
            input: { email: f.email().required(), redirect: f.string().max(2000), name: f.string().max(100) },
            tags: ['auth'],
          },
          async (ctx) => {
            const { email, name } = ctx.body;
            const redirect = checkRedirect(ctx.body.redirect);
            // The cooldown applies to every address, registered or not, so it reveals nothing.
            const wait = await claimCooldown(email);
            if (wait) {
              ctx.res.setHeader('Retry-After', String(wait));
              throw tooManyRequests(`A link was sent to this address moments ago. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
            }
            const requestId = randomBytes(12).toString('base64url');
            const meta = { ip: ctx.req.ip, userAgent: ctx.req.get('user-agent')?.slice(0, 300) };
            calm.app.background(() => sendLink({ email, name, redirect, requestId, ...meta }));
            return ctx.reply(
              { message: 'If that address can sign in, a link is on its way.', requestId, expiresIn: options.ttlMinutes * 60 },
              { status: 202 },
            );
          },
        );

        r.post(
          '/verify',
          {
            policy: 'public',
            rateLimit: 'auth',
            summary: 'Sign in with the token from a magic link',
            input: { token: f.string().required().max(200), requestId: f.string().max(100) },
            tags: ['auth'],
          },
          async (ctx) => {
            const { token, requestId } = ctx.body;
            const now = new Date();
            const link = await MagicLink.findOne({ tokenHash: sha(token) }).lean();
            const refuse = (reason, err = invalidLink()) => {
              security('invalid_magic_link', { reason, ip: ctx.req.ip, ...(link ? { email: mask(link.email) } : {}) });
              return err;
            };
            if (!link) throw refuse('unknown');
            if (link.usedAt) throw refuse('used');
            if (link.expiresAt <= now) throw refuse('expired');
            // Checked before the claim, so a wrong browser does not burn the link.
            if (requestId ? sha(requestId) !== link.requestHash : options.requireSameDevice) throw refuse('other_device', otherDevice());

            const locked = await lockedUntil(link.email);
            if (locked) {
              security('locked_login_attempt', { email: mask(link.email), ip: ctx.req.ip, via: 'magic-link' });
              const minutes = Math.max(1, Math.ceil((locked - Date.now()) / 60_000));
              throw tooManyRequests(`Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
            }

            // The claim itself: one atomic update, so a link works exactly once.
            const claimed = await MagicLink.findOneAndUpdate({ _id: link._id, usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }).lean();
            if (!claimed) throw refuse('used');

            const { user, created } = link.user ? { user: await users().findById(link.user).lean(), created: false } : await newAccount(link, ctx);
            if (!user) throw refuse('unknown_user');
            if (calm.app.auth.service.inactive(user)) throw forbidden('This account is disabled');

            const extra = { ...(link.redirect ? { redirect: link.redirect } : {}), ...(created ? { created: true } : {}) };
            // Login challenges (a second factor from the totp block) apply here too.
            return { ...(await calm.app.auth.service.completeLogin(user, ctx)), ...extra };
          },
        );
      },
      { prefix: '/auth/magic-link' },
    );

    calm.doctor((app) =>
      app.auth
        ? []
        : [{ level: 'error', id: 'magic-link-no-auth', title: 'magic-link needs auth', detail: 'Turn auth on and keep the user resource (email and password fields): magic links sign users in.' }],
    );
  },
});
