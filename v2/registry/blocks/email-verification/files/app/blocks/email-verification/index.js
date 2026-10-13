import { definePlugin, f, createToken, hashToken, evaluatePolicy, CalmError, forbidden, notFound, tooManyRequests, validationError } from '#calm';

// Email verification: prove that the person who signed up owns the address.
//
//   POST /api/auth/verify-email          { token }    mark the address verified (from the email link)
//   POST /api/auth/verify-email/resend   { email? }   a new link (signed in: your own address)
//   POST /api/admin/users/:userId/verify-email        admins, for support requests
//
//  - Tokens are random, stored as SHA-256 hashes, expire (24 h by default) and work once:
//    they are claimed with one atomic update. A link also carries the address it was sent
//    to, so changing the address makes every older link useless.
//  - Resending answers the same thing for every address and does the lookup and the email
//    in the background, so it never reveals who has an account. A per address cooldown in
//    MongoDB (shared by every instance) plus the auth rate limit stop inbox flooding.
//  - The user record gets emailVerified and emailVerifiedAt (read-only, visible to the owner
//    and admins), so GET /api/auth/me shows them and ctx.user carries them.
//  - required: 'login' refuses password sign-in until the address is verified (a fresh link
//    is sent); required: 'routes' lets people sign in but answers 403 EMAIL_NOT_VERIFIED on
//    every non public route except the few needed to finish verifying. Either way, the
//    'verified' policy token protects single routes: policy: 'verified', 'verified | admin'.

const sha = hashToken;
const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');
const isId = (s) => typeof s === 'string' && /^[a-f\d]{24}$/i.test(s);
const invalidLink = () => new CalmError(400, 'INVALID_TOKEN', 'This verification link is invalid or has expired');
const notVerified = () => new CalmError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address first. Check your inbox for the link, or ask for a new one.');
const isVerified = (user) => user?.emailVerified === true;
const isVerifiedToken = (t) => typeof t === 'function' && t.name === 'verified';

// What an unverified user may still call while `required` is on: finish verifying, read and
// fix their profile (a typo in the address), sign out, delete the account (privacy block).
const ALWAYS_ALLOWED = [
  'POST /auth/verify-email',
  'POST /auth/verify-email/resend',
  'GET /auth/me',
  'PATCH /auth/me',
  'DELETE /auth/me',
  'POST /auth/logout',
  'POST /auth/logout-all',
];

export default definePlugin({
  name: 'email-verification',
  options: {
    /** false: only routes using the 'verified' policy need it. 'routes': every non public route. 'login': no sign-in before it. */
    required: false,
    /** Page of your frontend that reads ?token= and calls POST /api/auth/verify-email. Default: APP_URL + '/verify-email'. */
    linkUrl: null,
    ttlHours: 24,
    /** Minimum time between two links for the same address. 0 turns the cooldown off. */
    cooldownSeconds: 60,
    /** Send a link when someone registers (auth.registered). */
    sendOnRegister: true,
    /** When the address changes: send a link to the new one and a notice to the old one. */
    sendOnEmailChange: true,
    notifyOldEmail: true,
    /** More routes unverified users may call while `required` is on: ['GET /billing/plans']. */
    allow: [],
  },
  setup(calm, options) {
    if (![false, 'routes', 'login'].includes(options.required)) {
      throw new Error(`email-verification: required must be false, 'routes' or 'login' (got ${JSON.stringify(options.required)})`);
    }

    calm.onResource((def) => {
      if (def.name !== 'user') return def;
      // Read-only: only this block (and admins through its route) can change them.
      def.fields.emailVerified = f.boolean().default(false).readOnly().visibleTo('owner | admin');
      def.fields.emailVerifiedAt = f.date().readOnly().visibleTo('owner | admin');
      return def;
    });

    const { Schema } = calm.mongoose;
    const verificationSchema = new Schema(
      {
        tokenHash: { type: String, required: true, unique: true },
        user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
        email: { type: String, required: true }, // the address the link proves
        expiresAt: { type: Date, required: true },
        usedAt: { type: Date, default: null },
      },
      { collection: 'calm_email_verifications', timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
    );
    verificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Verification = calm.mongoose.model('calmEmailVerification', verificationSchema);

    // One document per address while its cooldown runs; MongoDB removes it afterwards.
    const cooldownSchema = new Schema({ _id: String, until: Date }, { collection: 'calm_email_verification_cooldowns', versionKey: false });
    cooldownSchema.index({ until: 1 }, { expireAfterSeconds: 0 });
    const Cooldown = calm.mongoose.model('calmEmailVerificationCooldown', cooldownSchema);

    const linkBase = options.linkUrl ?? `${calm.config.app.url.replace(/\/$/, '')}/verify-email`;
    const users = () => calm.app.model('user');
    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    const inactive = (user) => calm.app.auth?.service.inactive(user) ?? false;
    const allowed = new Set([...ALWAYS_ALLOWED, ...(options.allow ?? [])].map((key) => key.trim().replace(/\s+/, ' ')));

    /** Start the cooldown for an address. Returns 0, or the seconds left on a running one. */
    async function claimCooldown(email) {
      if (!options.cooldownSeconds) return 0;
      const now = new Date();
      const key = sha(`verify:${String(email).toLowerCase()}`);
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

    /** Create a link for the user's current address and email it. */
    async function sendLink(user) {
      if (!user?.email || isVerified(user) || inactive(user)) return;
      const token = createToken('verify');
      await Verification.create({ tokenHash: sha(token), user: user._id, email: user.email, expiresAt: new Date(Date.now() + options.ttlHours * 3_600_000) });
      const link = `${linkBase}${linkBase.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
      const app = calm.config.app.name;
      await calm.mailer.send({
        to: user.email,
        subject: `Verify your email for ${app}`,
        text: `Confirm that this address belongs to your ${app} account (valid for ${options.ttlHours} hours, works once):\n${link}\n\nIf you did not create an account, ignore this email.`,
        meta: { kind: 'email-verification', token },
      });
      calm.events.emit('auth.email_verification_sent', { user: { ...user, id: String(user._id) }, email: user.email });
    }

    /** Mark a user verified (other sign-in blocks call this when they proved the inbox). */
    async function markVerified(userId, { email } = {}) {
      const now = new Date();
      const filter = { _id: userId, ...(email ? { email } : {}) };
      const res = await users().updateOne({ ...filter, emailVerified: { $ne: true } }, { $set: { emailVerified: true, emailVerifiedAt: now } });
      await Verification.deleteMany({ user: userId, usedAt: null }); // the other pending links are spent
      if (!res.modifiedCount) return (await users().countDocuments(filter)) > 0; // already verified, or no such user
      const user = await users().findById(userId).lean();
      if (user) calm.events.emit('auth.email_verified', { user: { ...user, id: String(user._id) }, email: user.email });
      return true;
    }

    calm.provide('emailVerification', { Verification, Cooldown, sendLink, markVerified, isVerified });

    calm.policy('verified', (ctx) => isVerified(ctx.user));

    // After registration: a link to the new address. An account created by opening a
    // magic-link sign-up email already proved the inbox, so it is verified at once.
    calm.on('auth.registered', async ({ user, via }) => {
      if (!user?._id) return;
      if (via === 'magic-link') return void (await markVerified(user._id, { email: user.email }));
      if (!options.sendOnRegister || isVerified(user)) return;
      await claimCooldown(user.email);
      await sendLink(user);
    });

    // A new address is not verified yet: reset in the same update that changes it.
    calm.onService(({ def, service }) => {
      if (def.name !== 'user') return;
      const before = service.beforeUpdate.bind(service);
      service.beforeUpdate = async (data, existing, ctx) => {
        const out = await before(data, existing, ctx);
        if (typeof out?.email === 'string' && out.email !== existing.email) return { ...out, emailVerified: false, emailVerifiedAt: null };
        return out;
      };
    });

    calm.on('user.updated', async ({ doc, previous }) => {
      if (!doc || !previous || !previous.email || doc.email === previous.email) return;
      await Verification.deleteMany({ user: doc._id, usedAt: null });
      if (options.notifyOldEmail) {
        // Tells the owner if someone else changed it (a stolen session), without the new address.
        await calm.mailer.send({
          to: previous.email,
          subject: `Your ${calm.config.app.name} email address was changed`,
          text: `The email address of your ${calm.config.app.name} account was changed to ${mask(doc.email)}.\n\nIf this was not you, reset your password and contact support.`,
          meta: { kind: 'email-changed' },
        });
      }
      if (options.sendOnEmailChange) {
        await claimCooldown(doc.email);
        await sendLink(doc);
      }
    });

    // Runs after the password (or a magic link) was accepted, before a session exists.
    calm.loginChallenge(async (user, ctx) => {
      if (isVerified(user)) return null;
      // Opening a magic-link email proves the inbox as well as a verification link does.
      if (ctx?.route?.path === '/auth/magic-link/verify' && user.email) {
        await markVerified(user._id, { email: user.email });
        Object.assign(user, { emailVerified: true, emailVerifiedAt: new Date() }); // the login answer shows it
        return null;
      }
      if (options.required === 'login') {
        // A fresh link, unless one went out moments ago, so the person can finish right away.
        if (!(await claimCooldown(user.email))) calm.app.background(() => sendLink(user));
        security('unverified_login', { userId: String(user._id), email: mask(user.email) });
        throw new CalmError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address to sign in. Check your inbox for the link.');
      }
      return null;
    });

    // The 'verified' token answers EMAIL_NOT_VERIFIED instead of a bare 403, and `required`
    // closes every other non public route. Covers sessions from register and API keys too.
    calm.guard(async (ctx, route) => {
      const user = ctx.user;
      if (!user || isVerified(user) || !route) return;
      const policy = route.policy ?? [];
      if (policy.some(isVerifiedToken)) {
        // Only when no other alternative ('admin', 'owner'...) would let the user in.
        const rest = policy.filter((t) => !isVerifiedToken(t));
        const other = await evaluatePolicy(rest, { user, action: route.action, req: ctx.req, explain: false });
        if (!other.allow) throw notVerified();
      }
      if (!options.required || policy.includes('public') || allowed.has(`${route.method} ${route.path}`)) return;
      throw notVerified();
    });

    calm.routes(
      (r) => {
        if (!calm.app.auth) {
          calm.log.warn('email-verification: auth is off (or there is no user resource), so its routes are not registered');
          return;
        }
        const tags = ['auth'];

        r.post(
          '/auth/verify-email',
          { policy: 'public', rateLimit: 'auth', summary: 'Verify your email address with the token from the email', input: { token: f.string().required().max(200) }, tags },
          async (ctx) => {
            const now = new Date();
            // The claim itself: one atomic update, so a link works exactly once.
            const claimed = await Verification.findOneAndUpdate({ tokenHash: sha(ctx.body.token), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }).lean();
            const refuse = (reason) => {
              security('invalid_verification_link', { reason, ip: ctx.req.ip });
              return invalidLink();
            };
            if (!claimed) throw refuse('unknown_used_or_expired');
            const user = await users().findById(claimed.user).lean();
            if (!user) throw refuse('unknown_user');
            // A link proves the address it was sent to, not whatever the account holds now.
            if (user.email !== claimed.email) throw refuse('email_changed');
            if (inactive(user)) throw forbidden('This account is disabled');
            await markVerified(user._id, { email: claimed.email });
            return { verified: true, email: user.email };
          },
        );

        r.post(
          '/auth/verify-email/resend',
          {
            policy: 'public',
            status: 202,
            rateLimit: 'auth',
            summary: 'Send a new verification link (signed in: to your address; otherwise to { email })',
            input: { email: f.email() },
            tags,
          },
          async (ctx) => {
            if (ctx.user && isVerified(ctx.user)) return ctx.reply({ verified: true, message: 'Your email address is already verified.' }, { status: 200 });
            const email = ctx.user?.email ?? ctx.body.email;
            if (!email) throw validationError({ email: 'Is required' });
            // The cooldown applies to every address, registered or not, so it reveals nothing.
            const wait = await claimCooldown(email);
            if (wait) {
              ctx.res.setHeader('Retry-After', String(wait));
              throw tooManyRequests(`A link was sent to this address moments ago. Try again in ${wait} second${wait === 1 ? '' : 's'}.`);
            }
            const userId = ctx.user?._id ?? null;
            calm.app.background(async () => sendLink(userId ? await users().findById(userId).lean() : await users().findOne({ email }).lean()));
            return ctx.reply({ message: 'If that address needs verifying, a link is on its way.', expiresIn: options.ttlHours * 3600 }, { status: 202 });
          },
        );

        r.post('/admin/users/:userId/verify-email', { policy: 'admin', summary: "Mark a user's email address verified (support request)", tags }, async (ctx) => {
          if (!isId(ctx.params.userId) || !(await markVerified(ctx.params.userId))) throw notFound('User not found');
          return { verified: true };
        });
      },
      { prefix: '/' },
    );

    calm.doctor(async (app) => {
      if (!app.auth) return [{ level: 'error', id: 'email-verification-no-auth', title: 'email-verification needs auth', detail: 'Turn auth on and keep the user resource (email and password fields).' }];
      const findings = [];
      if (!app.mailer.transport) {
        findings.push({ level: 'error', id: 'email-verification-no-mail', title: 'email-verification cannot send links', detail: 'No mail transport is configured. Add one: `npx calm add mail-resend` (or mail-smtp).' });
      }
      if (options.required && app.started) {
        const older = await users().countDocuments({ emailVerified: { $exists: false } });
        if (older) {
          findings.push({
            level: 'info',
            id: 'email-verification-older-accounts',
            title: `${older} account${older === 1 ? '' : 's'} predate email verification`,
            detail: `They count as unverified while required is '${options.required}'. Mark them with POST /api/admin/users/:id/verify-email, or in MongoDB if you trust those addresses.`,
          });
        }
      }
      return findings;
    });
  },
});
