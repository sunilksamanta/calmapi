import { randomBytes, randomInt, createHash, timingSafeEqual } from 'node:crypto';
import { definePlugin, f, CalmError, badRequest, conflict, forbidden, tooManyRequests, validationError } from '#calm';
import { normalizePhone, maskPhone, validSignature, createMessage, SmsError, RECIPIENT_ERRORS } from './twilio.js';

// SMS through Twilio, and phone number verification.
//
//  - app.ext.sms.send({ to, body }) sends through the Twilio Messages API (basic auth with
//    TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN, from a Messaging Service or a number). Without
//    credentials, in development and tests, messages go to a console transport instead
//    (like the mail dev transport) and show in devtools.
//  - POST /api/auth/phone/start sends a 6-digit code, POST /api/auth/phone/verify checks it
//    and marks the signed-in user's phone verified. Codes are stored hashed, expire after 10
//    minutes, allow 5 tries, have a resend cooldown and per number, per IP and per user limits
//    in MongoDB, so they hold across instances and cannot be used to pump SMS.
//  - POST /api/sms/twilio/status receives delivery reports, signed by Twilio
//    (X-Twilio-Signature); unsigned or wrongly signed requests are refused.

export { normalizePhone, maskPhone, twilioSignature, validSignature, SmsError } from './twilio.js';

const DEFAULT_API = 'https://api.twilio.com';
const STATUS_RANK = { accepted: 0, scheduled: 0, queued: 1, sending: 2, sent: 3, delivered: 4, undelivered: 4, failed: 4, canceled: 4, read: 5 };
const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/** Reads an application/x-www-form-urlencoded body (Twilio's format) into req.formParams. */
function formBody(limit = 64 * 1024) {
  return function twilioFormBody(req, _res, next) {
    if (!/^application\/x-www-form-urlencoded/i.test(req.get('content-type') ?? '')) return next(badRequest('Expected an application/x-www-form-urlencoded body'));
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit && !failed) {
        failed = true;
        next(new CalmError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large'));
      } else if (!failed) chunks.push(chunk);
    });
    req.on('end', () => {
      if (failed) return;
      req.formParams = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
      next();
    });
    req.on('error', (err) => !failed && next(err));
  };
}

export default definePlugin({
  name: 'sms-twilio',
  env: {
    TWILIO_ACCOUNT_SID: { required: 'production', description: 'Account SID (starts with AC) from the Twilio Console' },
    TWILIO_AUTH_TOKEN: { required: 'production', secret: true, description: 'Auth token from the Twilio Console: authenticates API calls and signs status callbacks' },
    TWILIO_MESSAGING_SERVICE_SID: 'Messaging Service SID (starts with MG): preferred sender',
    TWILIO_FROM_NUMBER: 'Sender number in E.164 (+14155550100), used when no Messaging Service is set',
  },
  // Override in calm.config.js: blocks: { 'sms-twilio': { allowedPrefixes: ['+1'] } }
  options: {
    apiBase: DEFAULT_API, // for tests and proxies
    statusCallbackUrl: null, // public URL of POST /api/sms/twilio/status: delivery reports are asked for when set
    allowedPrefixes: null, // ['+1', '+44']: refuse other countries (SMS pumping fraud protection)
    timeoutMs: 10_000,
    keepMessagesDays: 30, // the delivery log (calm_sms_messages)
    verification: {
      enabled: true,
      ttlMinutes: 10,
      maxAttempts: 5, // wrong codes before the code is thrown away
      resendCooldownSeconds: 60, // per user
      uniquePhone: true, // a number can be verified on one account only
      limits: {
        perPhone: { max: 5, windowMinutes: 60 }, // codes sent to one number, whoever asks
        perIp: { max: 20, windowMinutes: 60 },
        perUser: { max: 10, windowMinutes: 60 },
      },
      message: null, // (code, { appName, minutes }) => text
    },
  },
  setup(calm, options) {
    const accountSid = calm.env('TWILIO_ACCOUNT_SID');
    const authToken = calm.env('TWILIO_AUTH_TOKEN');
    const messagingServiceSid = calm.env('TWILIO_MESSAGING_SERVICE_SID');
    const fromNumber = calm.env('TWILIO_FROM_NUMBER');
    const apiBase = String(options.apiBase).replace(/\/$/, '');
    const { mode } = calm.config;
    const configured = Boolean(accountSid && authToken && (messagingServiceSid || fromNumber));
    // Tests never reach the real Twilio: only a fake set with apiBase.
    const live = configured && !(mode === 'test' && apiBase === DEFAULT_API);
    const allowed = options.allowedPrefixes?.length ? options.allowedPrefixes.map(String) : null;

    calm.doctor(() => {
      const findings = [];
      if (mode === 'production' && accountSid && authToken && !messagingServiceSid && !fromNumber) {
        findings.push({ level: 'error', id: 'twilio-sender', title: 'No SMS sender configured', detail: 'Set TWILIO_MESSAGING_SERVICE_SID (recommended) or TWILIO_FROM_NUMBER.' });
      }
      if (accountSid && !/^AC[0-9a-f]{32}$/i.test(accountSid)) findings.push({ level: 'warn', id: 'twilio-sid', title: 'TWILIO_ACCOUNT_SID does not look like an Account SID', detail: 'It starts with AC followed by 32 hex characters (an API key SID starts with SK).' });
      if (fromNumber && !normalizePhone(fromNumber)) findings.push({ level: 'error', id: 'twilio-from', title: 'TWILIO_FROM_NUMBER is not in E.164 format', detail: 'Use +14155550100.' });
      if (configured && !options.statusCallbackUrl) findings.push({ level: 'info', id: 'twilio-status-callback', title: 'SMS delivery reports are off', detail: `Set blocks['sms-twilio'].statusCallbackUrl to the public URL of POST ${calm.config.apiPrefix}/sms/twilio/status to record them.` });
      return findings;
    });

    // ---- storage ---------------------------------------------------------------------------
    const { Schema } = calm.mongoose;
    const messageSchema = new Schema(
      {
        sid: { type: String, index: true },
        to: String, // masked: the log does not need the full number
        kind: String, // meta.kind: 'phone-verification'...
        status: String,
        errorCode: Number,
        expiresAt: Date,
      },
      { collection: 'calm_sms_messages', timestamps: true, versionKey: false },
    );
    messageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Message = calm.mongoose.model('calmSmsMessage', messageSchema);

    // One pending verification per user. The code is never stored, only a salted hash.
    const verificationSchema = new Schema(
      { _id: String, phone: String, codeHash: String, salt: String, attempts: { type: Number, default: 0 }, sentAt: Date, expiresAt: Date },
      { collection: 'calm_phone_verifications', versionKey: false },
    );
    verificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
    const Verification = calm.mongoose.model('calmPhoneVerification', verificationSchema);

    // Fixed window counters (per number, IP, user), removed by MongoDB when their window ends.
    const limitSchema = new Schema({ _id: String, count: Number, resetAt: Date }, { collection: 'calm_sms_limits', versionKey: false });
    limitSchema.index({ resetAt: 1 }, { expireAfterSeconds: 0 });
    const Limit = calm.mongoose.model('calmSmsLimit', limitSchema);

    // ---- sending -----------------------------------------------------------------------------
    const observers = [];
    const recent = []; // dev transport messages, for devtools
    const transport = live ? 'twilio' : mode === 'production' ? null : 'dev-console';

    async function send({ to, body, meta = {} } = {}) {
      const phone = normalizePhone(to);
      if (!phone) throw new SmsError('The recipient is not a phone number in E.164 format (+14155550100)', { code: 'INVALID_NUMBER' });
      if (allowed && !allowed.some((p) => phone.startsWith(p))) throw new SmsError(`Numbers starting with ${phone.slice(0, 3)} are not allowed (allowedPrefixes)`, { code: 'PREFIX_NOT_ALLOWED' });
      if (typeof body !== 'string' || !body.trim()) throw new SmsError('The message body is empty');
      const msg = { to: phone, body, meta, sentAt: new Date() };
      for (const fn of observers) fn(msg);

      if (!live) {
        if (mode === 'production') {
          calm.log.error('SMS not sent: Twilio is not configured (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and a sender).', { to: maskPhone(phone) });
          throw new SmsError('SMS is not configured');
        }
        recent.unshift({ to: phone, body, kind: meta.kind ?? null, sentAt: msg.sentAt });
        recent.length = Math.min(recent.length, 50);
        calm.log.info(`SMS to ${maskPhone(phone)} (dev transport, open /_calm to read it)`);
        if (mode === 'development' && process.env.CALM_SMS_PRINT === '1') calm.log.info(body);
        return { sid: null, status: 'dev', to: phone, transport: 'dev-console' };
      }

      const form = {
        To: phone,
        Body: body,
        ...(messagingServiceSid ? { MessagingServiceSid: messagingServiceSid } : { From: fromNumber }),
        StatusCallback: options.statusCallbackUrl || undefined,
      };
      const settings = { apiBase, accountSid, authToken, timeoutMs: options.timeoutMs };
      let result;
      for (let attempt = 0; ; attempt++) {
        try {
          result = await createMessage(settings, form);
          break;
        } catch (err) {
          // Only 429 is retried: it means "not sent". After a timeout or a 5xx the message may
          // have been accepted, and a retry would reach the person twice.
          if (err.status !== 429 || attempt >= 2) throw err;
          await new Promise((r) => setTimeout(r, Math.min(err.retryAfterMs ?? 1000 * 2 ** attempt, 10_000)));
        }
      }
      await Message.create({
        sid: result.sid,
        to: maskPhone(phone),
        kind: meta.kind ?? null,
        status: result.status ?? 'queued',
        expiresAt: new Date(Date.now() + options.keepMessagesDays * 86_400_000),
      }).catch((err) => calm.log.warn('sms-twilio: could not log the message', { reason: err.message }));
      return { sid: result.sid ?? null, status: result.status ?? 'queued', to: phone, transport: 'twilio' };
    }

    calm.provide('sms', {
      send,
      observe: (fn) => observers.push(fn),
      normalize: normalizePhone,
      mask: maskPhone,
      get transport() {
        return transport;
      },
      models: { Message, Verification, Limit },
    });

    // ---- delivery reports --------------------------------------------------------------------
    calm.routes(
      (r) => {
        r.post(
          '/twilio/status',
          { policy: 'public', status: 204, middleware: [formBody()], summary: 'Twilio delivery status callback (signed with X-Twilio-Signature)', tags: ['sms'] },
          async (ctx) => {
            const { req } = ctx;
            // The URL Twilio called: the configured one when behind a proxy, else this request's.
            const url = options.statusCallbackUrl || `${req.protocol}://${req.get('host')}${req.originalUrl}`;
            if (!validSignature(authToken, url, req.formParams, req.get('x-twilio-signature'))) {
              calm.events.emit('security.twilio_signature_invalid', { ip: req.ip, path: req.originalUrl });
              throw forbidden('Invalid Twilio signature');
            }
            const p = req.formParams;
            const sid = p.get('MessageSid') ?? p.get('SmsSid');
            const status = p.get('MessageStatus') ?? p.get('SmsStatus');
            if (!sid || !status) return;
            const errorCode = p.get('ErrorCode') ? Number(p.get('ErrorCode')) : null;
            const doc = await Message.findOne({ sid }).lean();
            // Reports can arrive out of order: never go back from delivered to sent.
            if (doc && (STATUS_RANK[status] ?? 0) >= (STATUS_RANK[doc.status] ?? 0)) {
              await Message.updateOne({ _id: doc._id }, { $set: { status, errorCode } });
            }
            calm.events.emit('sms.status', { sid, status, errorCode, to: maskPhone(p.get('To')), kind: doc?.kind ?? null });
          },
        );
      },
      { prefix: '/sms' },
    );

    // ---- phone verification ------------------------------------------------------------------
    const v = options.verification ?? {};
    if (v.enabled === false) return;

    calm.onResource((def) => {
      if (def.name !== 'user') return def;
      // Only this block writes them (readOnly), after the code was checked.
      def.fields.phone = f.string().readOnly().index().visibleTo('owner | admin').pii();
      def.fields.phoneVerifiedAt = f.date().readOnly().visibleTo('owner | admin');
      return def;
    });

    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    const minutes = v.ttlMinutes;
    const text = (code) =>
      typeof v.message === 'function'
        ? v.message(code, { appName: calm.config.app.name, minutes })
        : `${code} is your ${calm.config.app.name} verification code. It expires in ${minutes} minutes. Do not share it.`;

    /** Count one hit in a fixed window. Returns 0, or the seconds until the window ends. */
    async function hit(key, { max, windowMinutes }) {
      if (!max) return 0;
      const now = new Date();
      let doc = await Limit.findOneAndUpdate({ _id: key, resetAt: { $gt: now } }, { $inc: { count: 1 } }, { returnDocument: 'after' }).lean();
      if (!doc) {
        try {
          doc = await Limit.findOneAndUpdate({ _id: key, $or: [{ resetAt: { $lte: now } }, { resetAt: null }] }, { $set: { count: 1, resetAt: new Date(now.getTime() + windowMinutes * 60_000) } }, { upsert: true, returnDocument: 'after' }).lean();
        } catch (err) {
          if (err?.code !== 11000) throw err;
          // Another instance opened the window first: count in it.
          doc = await Limit.findOneAndUpdate({ _id: key }, { $inc: { count: 1 } }, { returnDocument: 'after' }).lean();
        }
      }
      return doc.count > max ? Math.max(1, Math.ceil((doc.resetAt - now) / 1000)) : 0;
    }

    const limited = (ctx, seconds, message) => {
      ctx.res.setHeader('Retry-After', String(seconds));
      return tooManyRequests(message);
    };

    function phoneInput(raw) {
      const phone = normalizePhone(raw);
      if (!phone) throw validationError({ phone: 'Use the international format, for example +14155550100' });
      if (allowed && !allowed.some((p) => phone.startsWith(p))) throw validationError({ phone: 'Numbers from this country are not supported' });
      return phone;
    }

    const users = () => calm.app.model('user');
    const hashCode = (salt, code) => sha256(`${salt}:${code}`);

    calm.routes(
      (r) => {
        r.post(
          '/start',
          { policy: 'authenticated', status: 202, summary: 'Send a verification code to a phone number', input: { phone: f.string().required().max(32) }, tags: ['auth'] },
          async (ctx) => {
            const phone = phoneInput(ctx.body.phone);
            const userId = String(ctx.user.id);
            const me = await users().findById(userId).select('phone phoneVerifiedAt').lean();
            if (me?.phone === phone && me.phoneVerifiedAt) return ctx.reply({ verified: true, phone, message: 'This number is already verified' }, { status: 200 });

            // Cooldown per user, whatever the number, so numbers cannot be cycled quickly.
            const pending = await Verification.findById(userId).lean();
            const cooldownMs = v.resendCooldownSeconds * 1000;
            if (pending?.sentAt && Date.now() - pending.sentAt.getTime() < cooldownMs) {
              const wait = Math.ceil((cooldownMs - (Date.now() - pending.sentAt.getTime())) / 1000);
              throw limited(ctx, wait, `Wait ${wait} seconds before asking for another code`);
            }
            const limits = v.limits ?? {};
            for (const [key, rule, what] of [
              [`phone:${sha256(phone)}`, limits.perPhone, 'this number'],
              [`ip:${ctx.req.ip}`, limits.perIp, 'this network'],
              [`user:${userId}`, limits.perUser, 'your account'],
            ]) {
              const wait = rule ? await hit(key, rule) : 0;
              if (wait) {
                security('sms_limit_reached', { userId, ip: ctx.req.ip, phone: maskPhone(phone), limit: key.split(':')[0] });
                throw limited(ctx, wait, `Too many codes were sent to ${what}. Try again later.`);
              }
            }

            const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
            const salt = randomBytes(16).toString('hex');
            const now = new Date();
            await Verification.findOneAndUpdate(
              { _id: userId },
              { $set: { phone, salt, codeHash: hashCode(salt, code), attempts: 0, sentAt: now, expiresAt: new Date(now.getTime() + minutes * 60_000) } },
              { upsert: true },
            );
            try {
              await send({ to: phone, body: text(code), meta: { kind: 'phone-verification', userId } });
            } catch (err) {
              await Verification.deleteOne({ _id: userId, salt });
              if (err instanceof SmsError && (RECIPIENT_ERRORS.has(err.code) || ['INVALID_NUMBER', 'PREFIX_NOT_ALLOWED'].includes(err.code))) {
                throw validationError({ phone: 'This number cannot receive text messages' });
              }
              calm.log.warn(`sms-twilio: verification code not sent: ${err.message}`);
              throw new CalmError(502, 'SMS_FAILED', 'The text message could not be sent. Try again in a moment.');
            }
            return ctx.reply({ message: 'Code sent', phone: maskPhone(phone), expiresIn: minutes * 60, resendIn: v.resendCooldownSeconds }, { status: 202 });
          },
        );

        r.post(
          '/verify',
          { policy: 'authenticated', summary: 'Check the code and mark the phone number verified', input: { phone: f.string().required().max(32), code: f.string().required().max(12) }, tags: ['auth'] },
          async (ctx) => {
            const phone = phoneInput(ctx.body.phone);
            const code = String(ctx.body.code).replace(/\s/g, '');
            const userId = String(ctx.user.id);
            const where = { ip: ctx.req.ip, userId, phone: maskPhone(phone) };
            const invalid = () => new CalmError(400, 'INVALID_CODE', 'No code is pending for this number, or it expired. Ask for a new one.');

            // Count the attempt before comparing, atomically: parallel guesses cannot exceed maxAttempts.
            const doc = await Verification.findOneAndUpdate(
              { _id: userId, phone, expiresAt: { $gt: new Date() }, attempts: { $lt: v.maxAttempts } },
              { $inc: { attempts: 1 } },
              { returnDocument: 'after' },
            ).lean();
            if (!doc) throw invalid();

            const given = Buffer.from(hashCode(doc.salt, code));
            const expected = Buffer.from(doc.codeHash);
            if (!/^\d{6}$/.test(code) || !timingSafeEqual(given, expected)) {
              const left = v.maxAttempts - doc.attempts;
              security('phone_code_failed', { ...where, attempts: doc.attempts });
              if (left <= 0) {
                await Verification.deleteOne({ _id: userId, salt: doc.salt });
                security('phone_verification_locked', where);
                throw new CalmError(429, 'TOO_MANY_ATTEMPTS', 'Too many wrong codes. Ask for a new code.');
              }
              throw new CalmError(400, 'INVALID_CODE', `Wrong code, ${left} attempt${left === 1 ? '' : 's'} left`, { code: 'Wrong code' });
            }
            // Single use: only the request that deletes it wins.
            const claimed = await Verification.findOneAndDelete({ _id: userId, salt: doc.salt }).lean();
            if (!claimed) throw invalid();

            if (v.uniquePhone && (await users().exists({ phone, phoneVerifiedAt: { $ne: null }, _id: { $ne: userId } }))) {
              security('phone_already_used', where);
              throw conflict('This phone number is already verified on another account', { phone: 'Already in use' });
            }
            const user = await calm.app.service('user').update(userId, { phone, phoneVerifiedAt: new Date() }, { system: true });
            calm.events.emit('auth.phone_verified', { user: { ...user, id: String(user._id) }, phone: maskPhone(phone) });
            return { phone, phoneVerifiedAt: user.phoneVerifiedAt };
          },
        );

        r.delete('/', { policy: 'authenticated', summary: 'Remove your phone number', tags: ['auth'] }, async (ctx) => {
          await calm.app.service('user').update(String(ctx.user.id), { phone: null, phoneVerifiedAt: null }, { system: true });
          await Verification.deleteOne({ _id: String(ctx.user.id) });
          calm.events.emit('auth.phone_removed', { userId: String(ctx.user.id) });
        });
      },
      { prefix: '/auth/phone' },
    );

    calm.devtools.panel('sms', async () => ({
      transport: transport ?? 'none (production without Twilio)',
      sender: messagingServiceSid ? 'messaging service' : fromNumber ? maskPhone(fromNumber) : null,
      recent: recent.slice(0, 20),
      log: live ? await Message.find().sort({ _id: -1 }).limit(20).lean() : [],
    }));
  },
});
