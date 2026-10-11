// Authentication: register, login, sessions, password change and reset.
//
// Design choices (all yours to change, this is your code):
//  - Opaque session tokens, stored as SHA-256 hashes, revocable at any time.
//  - Passwords hashed with scrypt (node:crypto), no native addons.
//  - Login and reset never reveal whether an email is registered.
//  - Reset tokens are single use, expire, and revoke every session when used.
//  - Rate limited (config.rateLimit.auth).

import { compileAuthModels } from './models.js';
import { createToken, hashToken } from './tokens.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { RouteBuilder } from '../http/router.js';
import { validateInput, serialize } from '../resource/resource.js';
import { f } from '../resource/fields.js';
import { CalmError, unauthorized, validationError, forbidden, notFound } from '../errors.js';

const SESSION_TOUCH_MS = 5 * 60_000;

export function setupAuth(app) {
  const userEntry = app.registry.get('user');
  if (!userEntry) throw new Error('auth is enabled but there is no "user" resource (app/resources/user/user.resource.js)');
  const passwordField = Object.entries(userEntry.def.fields).find(([, field]) => field.type === 'password')?.[0];
  if (!passwordField || !userEntry.def.fields.email) {
    throw new Error('The user resource needs an "email" field and an f.password() field for auth');
  }

  const { Session, PasswordReset } = compileAuthModels(app.mongoose);
  const User = userEntry.model;
  const cfg = app.config.auth;
  let dummyHash;

  const toAuthUser = (doc) => ({ ...doc, id: String(doc._id) });
  const publicUser = (user, viewer = user) =>
    serialize(userEntry.def, user, { user: viewer.id ? viewer : toAuthUser(viewer), registry: app.registry });

  async function createSession(user, req) {
    const token = createToken('calm');
    const expiresAt = new Date(Date.now() + cfg.sessionTtlDays * 86_400_000);
    await Session.create({
      tokenHash: hashToken(token),
      user: user._id,
      expiresAt,
      lastUsedAt: new Date(),
      ip: req?.ip,
      userAgent: req?.get?.('user-agent')?.slice(0, 300),
    });
    return { token, expiresAt };
  }

  /** Express middleware: resolves `Authorization: Bearer <token>` into req.user. */
  async function authenticate(req, _res, next) {
    const header = req.headers.authorization;
    if (!header) return next();
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return next(unauthorized('Authorization header must be "Bearer <token>"'));

    const session = await Session.findOne({ tokenHash: hashToken(match[1]), expiresAt: { $gt: new Date() } }).lean();
    if (!session) return next(unauthorized('Session is invalid or has expired'));
    const user = await User.findById(session.user).lean();
    if (!user || user.status === 'disabled') return next(unauthorized('Session is invalid or has expired'));

    req.user = toAuthUser(user);
    req.session = { id: String(session._id), expiresAt: session.expiresAt };
    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > SESSION_TOUCH_MS) {
      Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    next();
  }

  const service = {
    Session,
    PasswordReset,
    createSession,
    authenticate,

    async register(body, ctx) {
      if (!cfg.register) throw forbidden('Registration is disabled');
      const data = await validateInput(userEntry.def, body, { mode: 'create', user: null, unknownFields: app.config.unknownFields });
      const user = await userEntry.service.create(data, { ...ctx, user: null });
      const session = await createSession(user, ctx.req);
      app.events.emit('auth.registered', { user: toAuthUser(user) });
      return { user: await publicUser(user), ...session };
    },

    async login(body, ctx) {
      const input = await validateInput(
        { name: 'login', fields: { email: f.email().required(), password: f.string().required().max(128) } },
        body,
        { mode: 'create' },
      );
      const user = await User.findOne({ email: input.email }).select(`+${passwordField}`).lean();
      if (!user) {
        // Spend the same time as a real check so response timing does not reveal accounts.
        dummyHash ??= await hashPassword('calm-dummy-password', cfg.password);
        await verifyPassword(input.password, dummyHash);
        throw unauthorized('Invalid email or password');
      }
      if (!(await verifyPassword(input.password, user[passwordField]))) throw unauthorized('Invalid email or password');
      if (user.status === 'disabled') throw forbidden('This account is disabled');

      if (needsRehash(user[passwordField], cfg.password)) {
        await User.updateOne({ _id: user._id }, { $set: { [passwordField]: await hashPassword(input.password, cfg.password) } });
      }
      const session = await createSession(user, ctx.req);
      app.events.emit('auth.login', { user: toAuthUser(user) });
      return { user: await publicUser(user), ...session };
    },

    async logout(ctx) {
      if (ctx.session) await Session.deleteOne({ _id: ctx.session.id });
    },

    async logoutAll(ctx) {
      await Session.deleteMany({ user: ctx.user._id });
    },

    async me(ctx) {
      return publicUser(await User.findById(ctx.user._id).lean(), ctx.user);
    },

    async updateMe(body, ctx) {
      const input = { ...body };
      if (passwordField in input) throw validationError({ [passwordField]: 'Use POST /auth/password to change your password' });
      const data = await validateInput(userEntry.def, input, { mode: 'update', user: ctx.user, doc: ctx.user, unknownFields: app.config.unknownFields });
      const doc = await userEntry.service.update(ctx.user._id, data, { ...ctx, scope: null });
      return publicUser(doc, ctx.user);
    },

    async changePassword(body, ctx) {
      const input = await validateInput(
        { name: 'password', fields: { currentPassword: f.string().required().max(128), newPassword: userEntry.def.fields[passwordField].required() } },
        body,
        { mode: 'create' },
      );
      const user = await User.findById(ctx.user._id).select(`+${passwordField}`).lean();
      if (!(await verifyPassword(input.currentPassword, user[passwordField]))) {
        throw validationError({ currentPassword: 'Current password is incorrect' });
      }
      await userEntry.service.update(user._id, { [passwordField]: input.newPassword }, { ...ctx, scope: null });
      await Session.deleteMany({ user: user._id, _id: { $ne: ctx.session.id } });
      app.events.emit('auth.password_changed', { user: toAuthUser(user) });
    },

    async forgotPassword(body) {
      const input = await validateInput({ name: 'forgot', fields: { email: f.email().required() } }, body, { mode: 'create' });
      // Respond immediately and do the work in the background: same response and timing
      // whether or not the account exists.
      app.background(async () => {
        const user = await User.findOne({ email: input.email }).lean();
        if (!user || user.status === 'disabled') return;
        const token = createToken('reset');
        await PasswordReset.create({
          tokenHash: hashToken(token),
          user: user._id,
          expiresAt: new Date(Date.now() + cfg.resetTokenTtlMinutes * 60_000),
        });
        const link = `${cfg.resetUrl}${cfg.resetUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
        await app.mailer.send({
          to: user.email,
          subject: `Reset your ${app.config.app.name} password`,
          text: `Someone asked to reset the password for this account.\n\nReset it here (valid for ${cfg.resetTokenTtlMinutes} minutes):\n${link}\n\nIf this was not you, ignore this email.`,
          meta: { kind: 'password-reset', token },
        });
        app.events.emit('auth.password_reset_requested', { user: toAuthUser(user) });
      });
    },

    async resetPassword(body) {
      const input = await validateInput(
        { name: 'reset', fields: { token: f.string().required().max(200), password: userEntry.def.fields[passwordField].required() } },
        body,
        { mode: 'create' },
      );
      // Claim the token atomically: a token can only ever be used once.
      const reset = await PasswordReset.findOneAndUpdate(
        { tokenHash: hashToken(input.token), usedAt: null, expiresAt: { $gt: new Date() } },
        { $set: { usedAt: new Date() } },
      ).lean();
      if (!reset) throw new CalmError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');

      await userEntry.service.update(reset.user, { [passwordField]: input.password }, {});
      await Promise.all([
        Session.deleteMany({ user: reset.user }),
        PasswordReset.deleteMany({ user: reset.user, usedAt: null }),
      ]);
      app.events.emit('auth.password_reset', { userId: String(reset.user) });
    },

    async listSessions(ctx) {
      const sessions = await Session.find({ user: ctx.user._id, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).lean();
      return sessions.map((s) => ({
        id: String(s._id),
        current: String(s._id) === ctx.session.id,
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt,
        expiresAt: s.expiresAt,
        ip: s.ip,
        userAgent: s.userAgent,
      }));
    },

    async revokeSession(id, ctx) {
      const res = await Session.deleteOne({ _id: id, user: ctx.user._id });
      if (!res.deletedCount) throw notFound('Session not found');
    },
  };

  const r = new RouteBuilder({ app, prefix: '/auth', source: 'auth', file: 'calm/auth/index.js' });
  const limited = { rateLimit: 'auth' };
  r.post('/register', { policy: 'public', status: 201, summary: 'Create an account and sign in', ...limited, tags: ['auth'] }, (ctx) => service.register(ctx.req.body, ctx));
  r.post('/login', { policy: 'public', summary: 'Sign in with email and password', ...limited, tags: ['auth'] }, (ctx) => service.login(ctx.req.body, ctx));
  r.post('/logout', { policy: 'authenticated', summary: 'Sign out this session', tags: ['auth'] }, (ctx) => service.logout(ctx));
  r.post('/logout-all', { policy: 'authenticated', summary: 'Sign out every session', tags: ['auth'] }, (ctx) => service.logoutAll(ctx));
  r.get('/me', { policy: 'authenticated', summary: 'The signed-in user', tags: ['auth'] }, (ctx) => service.me(ctx));
  r.patch('/me', { policy: 'authenticated', summary: 'Update your profile', tags: ['auth'] }, (ctx) => service.updateMe(ctx.req.body, ctx));
  r.post('/password', { policy: 'authenticated', summary: 'Change your password', ...limited, tags: ['auth'] }, (ctx) => service.changePassword(ctx.req.body, ctx));
  r.post('/password/forgot', { policy: 'public', status: 202, summary: 'Email a password reset link', ...limited, tags: ['auth'] }, async (ctx) => {
    await service.forgotPassword(ctx.req.body);
    return ctx.reply({ message: 'If that email is registered, a reset link is on its way.' }, { status: 202 });
  });
  r.post('/password/reset', { policy: 'public', summary: 'Set a new password with a reset token', ...limited, tags: ['auth'] }, (ctx) => service.resetPassword(ctx.req.body));
  r.get('/sessions', { policy: 'authenticated', summary: 'Your active sessions', tags: ['auth'] }, (ctx) => service.listSessions(ctx));
  r.delete('/sessions/:sessionId', { policy: 'authenticated', summary: 'Revoke one session', tags: ['auth'] }, (ctx) => service.revokeSession(ctx.params.sessionId, ctx));

  return { service, routes: r.routes };
}
