// Authentication: register, login, sessions, password change and reset.
//
// Design choices (all yours to change, this is your code):
//  - Opaque session tokens, stored as SHA-256 hashes, revocable at any time.
//  - Passwords hashed with scrypt (node:crypto), no native addons.
//  - Login and reset never reveal whether an email is registered.
//  - Reset tokens are single use, expire, and revoke every session when used.
//  - Rate limited per IP (config.rateLimit.auth) and locked per account after repeated
//    failures (config.auth.lockout), keyed by the email string so locks never reveal
//    whether an account exists.
//  - Common passwords and passwords containing the user's email or name are refused.
//  - Every suspicious event is emitted as security.* (devtools, audit-log, your alerts).

import { compileAuthModels } from './models.js';
import { trace } from '../context.js';
import { createToken, hashToken } from './tokens.js';
import { hashPassword, verifyPassword, needsRehash } from './password.js';
import { RouteBuilder } from '../http/router.js';
import { validateInput, serialize } from '../resource/resource.js';
import { f } from '../resource/fields.js';
import { CalmError, unauthorized, validationError, forbidden, notFound, tooManyRequests } from '../errors.js';
import { passwordContextProblem } from './password-policy.js';
import { compileDeviceModel, maskToken, PLATFORMS } from '../push.js';

const SESSION_TOUCH_MS = 5 * 60_000;

export function setupAuth(app) {
  const userEntry = app.registry.get('user');
  if (!userEntry) throw new Error('auth is enabled but there is no "user" resource (app/resources/user/user.resource.js)');
  const passwordField = Object.entries(userEntry.def.fields).find(([, field]) => field.type === 'password')?.[0];
  if (!passwordField || !userEntry.def.fields.email) {
    throw new Error('The user resource needs an "email" field and an f.password() field for auth');
  }

  const { Session, PasswordReset, LoginAttempt } = compileAuthModels(app.mongoose);
  const Device = compileDeviceModel(app.mongoose);
  // Without Session, push keeps devices whose session ended (auth.devicesFollowSessions: false).
  app.push.useDevices(Device, app.config.auth.devicesFollowSessions !== false ? Session : null);
  const deviceView = (d) => ({
    id: String(d._id),
    platform: d.platform,
    name: d.name,
    appVersion: d.appVersion,
    locale: d.locale,
    token: maskToken(d.token), // never echoed back in full
    simulated: d.simulated,
    signedIn: Boolean(d.session), // stops when that session ends
    lastSeenAt: d.lastSeenAt,
    createdAt: d.createdAt,
  });
  const lockout = { maxAttempts: 5, windowMinutes: 15, lockMinutes: 15, ...(app.config.auth.lockout ?? {}) };
  // Accounts that cannot sign in or use a session (the privacy block marks 'deleting').
  const inactive = (user) => user?.status === 'disabled' || user?.status === 'deleting';
  const security = (name, data) => app.events.emit(`security.${name}`, data);
  const mask = (email) => String(email).replace(/^(.)[^@]*(@.*)$/, '$1***$2');
  const attemptKey = (email) => hashToken(`login:${String(email).toLowerCase()}`);

  async function lockedUntil(email) {
    if (!lockout.maxAttempts) return null;
    const doc = await LoginAttempt.findById(attemptKey(email)).lean();
    return doc?.lockedUntil && doc.lockedUntil > new Date() ? doc.lockedUntil : null;
  }

  async function recordFailure(email, req, reason) {
    security('login_failed', { email: mask(email), ip: req?.ip, reason });
    if (!lockout.maxAttempts) return;
    const now = Date.now();
    const key = attemptKey(email);
    const expiresAt = new Date(now + (lockout.windowMinutes + lockout.lockMinutes) * 60_000);
    let doc = await LoginAttempt.findOneAndUpdate(
      { _id: key, firstAt: { $gt: new Date(now - lockout.windowMinutes * 60_000) } },
      { $inc: { count: 1 }, $set: { expiresAt } },
      { returnDocument: 'after' },
    ).lean();
    doc ??= await LoginAttempt.findOneAndUpdate(
      { _id: key },
      { $set: { count: 1, firstAt: new Date(now), lockedUntil: null, expiresAt } },
      { upsert: true, returnDocument: 'after' },
    ).lean();
    if (doc.count >= lockout.maxAttempts) {
      const until = new Date(now + lockout.lockMinutes * 60_000);
      await LoginAttempt.updateOne({ _id: key }, { $set: { lockedUntil: until } });
      security('account_locked', { email: mask(email), ip: req?.ip, until });
    }
  }

  const clearFailures = (email) => LoginAttempt.deleteOne({ _id: attemptKey(email) });

  /** End sessions, and stop push notifications to the devices those sessions registered. */
  async function endSessions(filter) {
    const ids = (await Session.find(filter).select('_id').lean()).map((x) => x._id);
    if (!ids.length) return 0;
    const res = await Session.deleteMany({ _id: { $in: ids } });
    if (app.config.auth.devicesFollowSessions !== false) await Device.deleteMany({ session: { $in: ids } });
    return res.deletedCount ?? 0;
  }

  function checkPasswordContext(password, user) {
    const problem = passwordContextProblem(password, user);
    if (problem) throw validationError({ [passwordField]: problem });
  }
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
  const who = (u) => `${u.name ?? u.email ?? u.id} (${(u.roles ?? []).join(', ') || 'no roles'})`;

  async function authenticate(req, _res, next) {
    const header = req.headers.authorization;
    if (!header) {
      trace({ kind: 'auth', name: 'anonymous', file: 'calm/auth/index.js', detail: 'no credentials', outcome: 'passed' });
      return next();
    }
    const match = /^Bearer\s+(\S+)$/i.exec(header);
    if (!match) return next(unauthorized('Authorization header must be "Bearer <token>"'));

    // Blocks can accept other credentials (API keys...). The first one that recognizes the token wins.
    for (const fn of app.hooks.authenticators) {
      let found;
      try {
        found = await fn(match[1], req);
      } catch (err) {
        return next(err);
      }
      if (!found) continue;
      const step = { kind: 'auth', name: fn.calmName ?? found.via ?? 'token', file: fn.calmFile ?? null };
      if (!found.user || inactive(found.user)) {
        trace({ ...step, detail: 'credentials are invalid, expired or the account is disabled', outcome: 'denied' });
        return next(unauthorized('Credentials are invalid or have expired'));
      }
      req.user = toAuthUser(found.user);
      req.auth = { via: found.via ?? 'token', scopes: found.scopes ?? ['*'], id: found.id ?? null };
      trace({ ...step, detail: `${who(req.user)} via ${req.auth.via}`, outcome: 'passed' });
      return next();
    }

    const session = await Session.findOne({ tokenHash: hashToken(match[1]), expiresAt: { $gt: new Date() } }).lean();
    if (!session) {
      trace({ kind: 'auth', name: 'session', file: 'calm/auth/index.js', detail: 'no session for this token (expired, signed out or wrong)', outcome: 'denied' });
      security('invalid_token', { ip: req.ip, path: req.originalUrl });
      return next(unauthorized('Session is invalid or has expired'));
    }
    const user = await User.findById(session.user).lean();
    if (!user || inactive(user)) return next(unauthorized('Session is invalid or has expired'));

    req.user = toAuthUser(user);
    req.session = { id: String(session._id), expiresAt: session.expiresAt };
    req.auth = { via: 'session', scopes: ['*'], id: String(session._id) };
    trace({ kind: 'auth', name: 'session', file: 'calm/auth/index.js', detail: who(req.user), outcome: 'passed' });
    if (!session.lastUsedAt || Date.now() - session.lastUsedAt.getTime() > SESSION_TOUCH_MS) {
      Session.updateOne({ _id: session._id }, { $set: { lastUsedAt: new Date() } }).catch(() => {});
    }
    next();
  }

  const service = {
    Session,
    PasswordReset,
    LoginAttempt,
    createSession,
    authenticate,
    endSessions,
    /** Account lockout, shared with sign-in blocks so every way in counts the same failures. */
    lockedUntil,
    recordFailure,
    clearFailures,
    inactive,

    async register(body, ctx) {
      if (!cfg.register) throw forbidden('Registration is disabled');
      const data = await validateInput(userEntry.def, body, { mode: 'create', user: null, unknownFields: app.config.unknownFields });
      checkPasswordContext(data[passwordField], data);
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
      const locked = await lockedUntil(input.email);
      if (locked) {
        security('locked_login_attempt', { email: mask(input.email), ip: ctx.req?.ip });
        const minutes = Math.max(1, Math.ceil((locked - Date.now()) / 60_000));
        throw tooManyRequests(`Too many failed sign-in attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.`);
      }
      const user = await User.findOne({ email: input.email }).select(`+${passwordField}`).lean();
      if (!user) {
        // Spend the same time as a real check so response timing does not reveal accounts.
        dummyHash ??= await hashPassword('calm-dummy-password', cfg.password);
        await verifyPassword(input.password, dummyHash);
        await recordFailure(input.email, ctx.req, 'unknown_email');
        throw unauthorized('Invalid email or password');
      }
      if (!(await verifyPassword(input.password, user[passwordField]))) {
        await recordFailure(input.email, ctx.req, 'wrong_password');
        throw unauthorized('Invalid email or password');
      }
      await clearFailures(input.email);
      if (inactive(user)) throw forbidden('This account is disabled');

      if (needsRehash(user[passwordField], cfg.password)) {
        await User.updateOne({ _id: user._id }, { $set: { [passwordField]: await hashPassword(input.password, cfg.password) } });
      }
      const { [passwordField]: _hash, ...safeUser } = user;
      return service.completeLogin(safeUser, ctx);
    },

    /**
     * After the user proved who they are (password, magic link, passkey...): run the login
     * challenges (second factor) and create the session. Sign-in blocks call this.
     */
    async completeLogin(user, ctx) {
      for (const challenge of app.hooks.login) {
        const answer = await challenge(user, ctx);
        if (answer) return answer; // e.g. second factor required
      }
      return service.finishLogin(user, ctx.req);
    },

    /** Create the session and the login response (also used by second-factor blocks). */
    async finishLogin(user, req) {
      const session = await createSession(user, req);
      app.events.emit('auth.login', { user: toAuthUser(user) });
      return { user: await publicUser(user), ...session };
    },

    async logout(ctx) {
      if (ctx.session) await endSessions({ _id: ctx.session.id });
    },

    async logoutAll(ctx) {
      await endSessions({ user: ctx.user._id });
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
        security('password_change_failed', { userId: String(user._id), ip: ctx.req?.ip });
        throw validationError({ currentPassword: 'Current password is incorrect' });
      }
      checkPasswordContext(input.newPassword, user);
      await userEntry.service.update(user._id, { [passwordField]: input.newPassword }, { ...ctx, scope: null });
      await endSessions({ user: user._id, _id: { $ne: ctx.session?.id } });
      app.events.emit('auth.password_changed', { user: toAuthUser(user) });
    },

    async forgotPassword(body) {
      const input = await validateInput({ name: 'forgot', fields: { email: f.email().required() } }, body, { mode: 'create' });
      // Respond immediately and do the work in the background: same response and timing
      // whether or not the account exists.
      app.background(async () => {
        const user = await User.findOne({ email: input.email }).lean();
        if (!user || inactive(user)) return;
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
      if (!reset) {
        security('invalid_reset_token', {});
        throw new CalmError(400, 'INVALID_TOKEN', 'This reset link is invalid or has expired');
      }
      const owner = await User.findById(reset.user).lean();
      checkPasswordContext(input.password, owner ?? {});

      await userEntry.service.update(reset.user, { [passwordField]: input.password }, { system: true });
      if (owner?.email) await clearFailures(owner.email);
      await Promise.all([endSessions({ user: reset.user }), PasswordReset.deleteMany({ user: reset.user, usedAt: null })]);
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
      const ended = await endSessions({ _id: id, user: ctx.user._id }).catch(() => 0);
      if (!ended) throw notFound('Session not found');
    },

    /**
     * Register (or refresh) this device's push token. A token belongs to one user at a time:
     * registering it again, for example after another sign-in on the same phone, moves it.
     */
    async registerDevice(input, ctx) {
      if (input.token.startsWith('sim_')) throw validationError({ token: 'Tokens starting with sim_ are reserved for simulated devices' });
      // Bound to the session that registered it (not to API keys), so signing out stops
      // notifications to this phone.
      const session = ctx.auth?.via === 'session' && ctx.session ? ctx.session.id : null;
      const doc = await Device.findOneAndUpdate(
        { token: input.token },
        { $set: { ...input, user: ctx.user._id, simulated: false, behavior: 'deliver', session, lastSeenAt: new Date() } },
        { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true },
      ).lean();
      return deviceView(doc);
    },

    /** Turn off notifications for the device that holds this token (apps know their token, not our id). */
    async unregisterDevice(token, ctx) {
      await Device.deleteOne({ token, user: ctx.user._id });
    },

    /**
     * The app reports that its user opened a notification. Emits push.opened with the signed-in
     * user; `data` comes from the client, so listeners only act on that user's own records.
     */
    reportOpened({ pushId = null, data = null }, ctx) {
      app.events.emit('push.opened', { id: pushId, user: String(ctx.user._id), device: null, url: null, data, simulated: false });
    },

    async listDevices(ctx) {
      const devices = await Device.find({ user: ctx.user._id }).sort({ lastSeenAt: -1 }).lean();
      return devices.map(deviceView);
    },

    async removeDevice(id, ctx) {
      const res = await Device.deleteOne({ _id: id, user: ctx.user._id }).catch(() => ({ deletedCount: 0 }));
      if (!res.deletedCount) throw notFound('Device not found');
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
  const deviceInput = {
    token: f.string().required().max(4096),
    platform: f.enum(PLATFORMS).required(),
    name: f.string().max(100),
    appVersion: f.string().max(50),
    locale: f.string().max(20),
  };
  r.post('/devices', { policy: 'authenticated', status: 201, summary: 'Register this device for push notifications', input: deviceInput, tags: ['auth'] }, (ctx) => service.registerDevice(ctx.body, ctx));
  r.get('/devices', { policy: 'authenticated', summary: 'Your devices registered for push notifications', tags: ['auth'] }, (ctx) => service.listDevices(ctx));
  r.delete('/devices/:deviceId', { policy: 'authenticated', summary: 'Stop push notifications to a device', tags: ['auth'] }, (ctx) => service.removeDevice(ctx.params.deviceId, ctx));
  r.post('/devices/opened', { policy: 'authenticated', status: 204, summary: 'Report that the user opened a push notification (emits push.opened)', input: { pushId: f.string().max(200), data: f.json() }, tags: ['auth'] }, (ctx) => service.reportOpened(ctx.body, ctx));
  r.post('/devices/unregister', { policy: 'authenticated', status: 204, summary: 'Stop push notifications to the device holding this token', input: { token: f.string().required().max(4096) }, tags: ['auth'] }, (ctx) => service.unregisterDevice(ctx.body.token, ctx));

  return { service, routes: r.routes };
}
