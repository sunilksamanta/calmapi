import { createHash, randomBytes } from 'node:crypto';
import { definePlugin, f, badRequest, unauthorized, validationError, verifyPassword } from '#calm';
import { newSecret, verifyCode, otpauthUrl } from './totp.js';

// Two-factor authentication with authenticator apps.
//
//  - Secrets live on the user record, hidden from the API, and encrypted at rest when
//    CALM_ENCRYPTION_KEYS is set.
//  - Login with 2FA on returns a challenge instead of a session; the challenge token is
//    single use, expires in 5 minutes and allows 5 attempts.
//  - A code (time step) can only be used once: no replay within its 90 s window.
//  - 10 recovery codes, stored as SHA-256 hashes, each usable once.

const CHALLENGE_TTL_MS = 5 * 60_000;
const MAX_ATTEMPTS = 5;
const sha = (s) => createHash('sha256').update(String(s)).digest('hex');

export default definePlugin({
  name: 'totp',
  env: {
    TOTP_ISSUER: 'Name shown in authenticator apps (default: the app name)',
  },
  setup(calm) {
    const encrypt = (field) => (calm.app.cipher ? field.encrypted() : field);

    calm.onResource((def) => {
      if (def.name !== 'user') return def;
      def.fields.totpSecret = encrypt(f.string().hidden());
      def.fields.totpPendingSecret = encrypt(f.string().hidden());
      def.fields.totpLastStep = f.integer().hidden();
      def.fields.totpRecovery = f.array(f.string()).hidden();
      def.fields.twoFactorEnabledAt = f.date().readOnly().visibleTo('owner | admin');
      return def;
    });

    const { Schema } = calm.mongoose;
    const challengeSchema = new Schema(
      { _id: String, user: { type: Schema.Types.ObjectId, required: true }, attempts: { type: Number, default: 0 }, expiresAt: Date },
      { collection: 'calm_mfa_challenges', versionKey: false },
    );
    challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Challenge = calm.mongoose.model('calmMfaChallenge', challengeSchema);
    const issuer = () => process.env.TOTP_ISSUER || calm.config.app.name;
    const users = () => calm.app.model('user');
    const security = (name, data) => calm.events.emit(`security.${name}`, data);

    calm.loginChallenge(async (user) => {
      if (!user.twoFactorEnabledAt) return null;
      const token = `mfa_${randomBytes(24).toString('base64url')}`;
      const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);
      await Challenge.create({ _id: sha(token), user: user._id, expiresAt });
      return { mfaRequired: true, mfaToken: token, methods: ['totp', 'recovery'], expiresAt };
    });

    /** Accept a code once: atomically move totpLastStep forward. */
    async function consumeCode(userId, secret, code) {
      const step = verifyCode(secret, code);
      if (step === null) return false;
      const res = await users().updateOne(
        { _id: userId, $or: [{ totpLastStep: { $exists: false } }, { totpLastStep: null }, { totpLastStep: { $lt: step } }] },
        { $set: { totpLastStep: step } },
      );
      return res.modifiedCount === 1;
    }

    const load = (id) => users().findById(id).select('+totpSecret +totpPendingSecret +totpLastStep +totpRecovery +password').lean();

    calm.routes(
      (r) => {
        r.post('/setup', { policy: 'authenticated', summary: 'Start 2FA setup', tags: ['auth'] }, async (ctx) => {
          const user = await load(ctx.user._id);
          if (user.twoFactorEnabledAt) throw badRequest('Two-factor authentication is already on');
          const secret = newSecret();
          await users().updateOne({ _id: user._id }, { $set: { totpPendingSecret: secret } });
          return { secret, otpauthUrl: otpauthUrl(secret, user.email, issuer()) };
        });

        r.post('/enable', { policy: 'authenticated', summary: 'Confirm setup with a code', rateLimit: 'auth', input: { code: f.string().required().max(10) }, tags: ['auth'] }, async (ctx) => {
          const user = await load(ctx.user._id);
          if (!user.totpPendingSecret) throw badRequest('Call /auth/2fa/setup first');
          if (!(await consumeCode(user._id, user.totpPendingSecret, ctx.body.code))) throw validationError({ code: 'Invalid code' });
          const recoveryCodes = Array.from({ length: 10 }, () => randomBytes(5).toString('hex').replace(/(.{5})/, '$1-'));
          await users().updateOne(
            { _id: user._id },
            { $set: { totpSecret: user.totpPendingSecret, twoFactorEnabledAt: new Date(), totpRecovery: recoveryCodes.map(sha) }, $unset: { totpPendingSecret: 1 } },
          );
          // Other sessions were created without a second factor: end them.
          await calm.app.auth.service.Session.deleteMany({ user: user._id, _id: { $ne: ctx.session.id } });
          security('2fa_enabled', { userId: String(user._id) });
          return { enabled: true, recoveryCodes, note: 'Store these codes safely. Each works once. They will not be shown again.' };
        });

        r.post('/disable', { policy: 'authenticated', summary: 'Turn 2FA off (needs your password)', rateLimit: 'auth', input: { password: f.string().required().max(128) }, tags: ['auth'] }, async (ctx) => {
          const user = await load(ctx.user._id);
          if (!(await verifyPassword(ctx.body.password, user.password))) throw validationError({ password: 'Password is incorrect' });
          await users().updateOne({ _id: user._id }, { $unset: { totpSecret: 1, totpPendingSecret: 1, totpRecovery: 1, twoFactorEnabledAt: 1, totpLastStep: 1 } });
          security('2fa_disabled', { userId: String(user._id) });
        });

        r.post(
          '/verify',
          {
            policy: 'public',
            summary: 'Finish a login with a code or a recovery code',
            rateLimit: 'auth',
            input: { mfaToken: f.string().required().max(200), code: f.string().max(10), recoveryCode: f.string().max(20) },
            tags: ['auth'],
          },
          async (ctx) => {
            const { mfaToken, code, recoveryCode } = ctx.body;
            if (!code && !recoveryCode) throw validationError({ code: 'Send a code or a recoveryCode' });
            const challenge = await Challenge.findOneAndUpdate(
              { _id: sha(mfaToken), expiresAt: { $gt: new Date() }, attempts: { $lt: MAX_ATTEMPTS } },
              { $inc: { attempts: 1 } },
              { returnDocument: 'after' },
            ).lean();
            if (!challenge) throw unauthorized('This sign-in has expired, sign in again');
            const user = await load(challenge.user);

            let ok;
            if (code) ok = await consumeCode(user._id, user.totpSecret, code);
            else {
              const hash = sha(String(recoveryCode).trim().toLowerCase());
              const res = await users().updateOne({ _id: user._id, totpRecovery: hash }, { $pull: { totpRecovery: hash } });
              ok = res.modifiedCount === 1;
              if (ok) security('2fa_recovery_used', { userId: String(user._id), remaining: (user.totpRecovery?.length ?? 1) - 1 });
            }
            if (!ok) {
              security('2fa_failed', { userId: String(user._id), ip: ctx.req.ip, attempt: challenge.attempts });
              throw unauthorized('Invalid code');
            }
            await Challenge.deleteOne({ _id: challenge._id });
            const { password: _p, totpSecret: _s, totpPendingSecret: _ps, totpRecovery: _r, ...safe } = user;
            return calm.app.auth.service.finishLogin(safe, ctx.req);
          },
        );
      },
      { prefix: '/auth/2fa' },
    );

    calm.doctor(() =>
      calm.app.cipher
        ? []
        : [{ level: 'warn', id: 'totp-unencrypted', title: 'TOTP secrets are stored unencrypted', detail: 'Run `npx calm keygen --write` so 2FA secrets are encrypted at rest.' }],
    );
  },
});
