import { randomBytes } from 'node:crypto';
import { definePlugin, f, createToken, hashToken, hasRole, CalmError, badRequest, notFound } from '#calm';

// Waitlist: collect sign-ups before launch, let referrals move people up, invite in batches.
//
//   POST   /api/waitlist                   { email, name?, referralCode? }  join (idempotent per email)
//   GET    /api/waitlist/:code                                              your place, by your referral code
//   GET    /api/admin/waitlist             ?status=waiting|invited|registered|all&q=&page=&limit=
//   GET    /api/admin/waitlist/stats
//   POST   /api/admin/waitlist/invite      { ids?: [...], count?: n }      invite these, or the next n in line
//   POST   /api/admin/waitlist/:id/invite                                  invite one (again)
//   DELETE /api/admin/waitlist/:id
//
//  - Your place is your join number minus `referralBoost` places per person who joined with
//    your code (up to `maxReferrals`), so referrals move you up without anyone moving down
//    by more than a few places at a time.
//  - Joining again with the same address changes nothing and answers the same entry: no
//    duplicate, no way to rewrite someone else's name or referrer.
//  - Invites carry a random single use token, stored as a SHA-256 hash, that expires.
//  - gate: true makes registration invitation only. POST /auth/register then needs the
//    invited address and its inviteToken; other ways to create an account (magic-link
//    sign-up, OAuth) need an invited address, since they already prove the inbox.

const isId = (s) => typeof s === 'string' && /^[a-f\d]{24}$/i.test(s);
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I to misread; 32 symbols, so byte % 32 is unbiased
const newCode = () => Array.from(randomBytes(10), (b) => ALPHABET[b % 32]).join('');
const inviteRequired = () => new CalmError(403, 'INVITE_REQUIRED', 'Registration is by invitation only. Join the waitlist to get an invite.');
const STATUSES = ['waiting', 'invited', 'registered'];

export default definePlugin({
  name: 'waitlist',
  options: {
    /** Places moved up per referral, and how many referrals count at most. */
    referralBoost: 5,
    maxReferrals: 50,
    /** Shareable link: the referral code is appended. Default: APP_URL + '/waitlist?ref='. */
    referralUrl: null,
    /** Page of your frontend that reads ?invite=&email= and registers. Default: APP_URL + '/signup'. */
    signupUrl: null,
    inviteTtlDays: 14,
    /** Registration only for invited addresses (with their invite token on POST /auth/register). */
    gate: false,
    /** Email new entries their place and referral link. Off by default: the join route is public. */
    confirmationEmail: false,
    /** Joins per IP (needs config.rateLimit.enabled). false: only the global limit. */
    joinLimit: { windowMs: 15 * 60_000, max: 20 },
    /** Most entries one bulk invite may touch. */
    maxInviteBatch: 500,
  },
  setup(calm, options) {
    const { Schema } = calm.mongoose;
    const entrySchema = new Schema(
      {
        email: { type: String, required: true, unique: true, lowercase: true, trim: true },
        name: String,
        referralCode: { type: String, required: true, unique: true },
        referredBy: { type: Schema.Types.ObjectId, default: null },
        referrals: { type: Number, default: 0 },
        seq: { type: Number, required: true, unique: true }, // join order
        score: { type: Number, required: true }, // seq minus the referral boost: lower is earlier
        status: { type: String, enum: STATUSES, default: 'waiting' },
        inviteTokenHash: { type: String, default: null, index: { unique: true, partialFilterExpression: { inviteTokenHash: { $type: 'string' } } } },
        invitedAt: Date,
        inviteExpiresAt: Date,
        registeredAt: Date,
        user: { type: Schema.Types.ObjectId, default: null },
        ip: String,
      },
      { collection: 'calm_waitlist', timestamps: true, versionKey: false },
    );
    entrySchema.index({ status: 1, score: 1, seq: 1 });
    const Entry = calm.mongoose.model('calmWaitlistEntry', entrySchema);
    const counterSchema = new Schema({ _id: String, value: Number }, { collection: 'calm_waitlist_counters', versionKey: false });
    const Counter = calm.mongoose.model('calmWaitlistCounter', counterSchema);

    const appUrl = calm.config.app.url.replace(/\/$/, '');
    const referralBase = options.referralUrl ?? `${appUrl}/waitlist?ref=`;
    const signupBase = options.signupUrl ?? `${appUrl}/signup`;
    const security = (name, data) => calm.events.emit(`security.${name}`, data);

    const nextSeq = async () => (await Counter.findOneAndUpdate({ _id: 'seq' }, { $inc: { value: 1 } }, { upsert: true, returnDocument: 'after' }).lean()).value;

    /** 1 for the first person in line; null once invited or registered. */
    async function positionOf(entry) {
      if (entry.status !== 'waiting') return null;
      const ahead = await Entry.countDocuments({ status: 'waiting', $or: [{ score: { $lt: entry.score } }, { score: entry.score, seq: { $lt: entry.seq } }] });
      return ahead + 1;
    }

    /** What the person on the list may see about their own entry. */
    async function publicView(entry) {
      return {
        status: entry.status,
        position: await positionOf(entry),
        waiting: await Entry.countDocuments({ status: 'waiting' }),
        referrals: entry.referrals,
        referralCode: entry.referralCode,
        referralUrl: `${referralBase}${encodeURIComponent(entry.referralCode)}`,
      };
    }

    const adminView = (entry, position = null) => ({
      id: String(entry._id),
      email: entry.email,
      name: entry.name ?? null,
      status: entry.status,
      position,
      referrals: entry.referrals,
      referralCode: entry.referralCode,
      referredBy: entry.referredBy ? String(entry.referredBy) : null,
      invitedAt: entry.invitedAt ?? null,
      inviteExpiresAt: entry.inviteExpiresAt ?? null,
      registeredAt: entry.registeredAt ?? null,
      user: entry.user ? String(entry.user) : null,
      createdAt: entry.createdAt,
    });

    async function join({ email, name, referralCode }, meta = {}) {
      const existing = await Entry.findOne({ email }).lean();
      if (existing) return { entry: existing, created: false };
      const code = typeof referralCode === 'string' ? referralCode.trim().toUpperCase() : null;
      const referrer = code ? await Entry.findOne({ referralCode: code }).lean() : null;
      const seq = await nextSeq();
      let entry;
      for (let attempt = 0; !entry; attempt++) {
        try {
          entry = (await Entry.create({ email, name, referralCode: newCode(), referredBy: referrer?._id ?? null, seq, score: seq, ip: meta.ip })).toObject();
        } catch (err) {
          if (err?.code !== 11000) throw err;
          // Someone joined with this address at the same moment: theirs is the entry.
          if (err.keyPattern?.email) return { entry: await Entry.findOne({ email }).lean(), created: false };
          if (attempt >= 3) throw err; // a referral code collision three times in a row is not luck
        }
      }
      if (referrer) {
        // Capped, so a referral farm cannot jump the whole line.
        await Entry.updateOne({ _id: referrer._id, referrals: { $lt: options.maxReferrals } }, { $inc: { referrals: 1, score: -options.referralBoost } });
        calm.events.emit('waitlist.referred', { referrerId: String(referrer._id), entryId: String(entry._id) });
      }
      calm.events.emit('waitlist.joined', { entry: adminView(entry), referred: Boolean(referrer) });
      if (options.confirmationEmail) {
        calm.app.background(async () => {
          const view = await publicView(entry);
          await calm.mailer.send({
            to: email,
            subject: `You are on the ${calm.config.app.name} waitlist`,
            text: `You are number ${view.position} in line.\n\nEvery friend who joins with your link moves you up ${options.referralBoost} places:\n${view.referralUrl}\n\nIf you did not sign up, ignore this email.`,
            meta: { kind: 'waitlist-joined' },
          });
        });
      }
      return { entry, created: true };
    }

    /** Give an entry a fresh invite token and email it. A new invite replaces the previous one. */
    async function invite(id, by = null) {
      const token = createToken('invite');
      const now = new Date();
      const entry = await Entry.findOneAndUpdate(
        { _id: id, status: { $in: ['waiting', 'invited'] } },
        { $set: { status: 'invited', inviteTokenHash: hashToken(token), invitedAt: now, inviteExpiresAt: new Date(now.getTime() + options.inviteTtlDays * 86_400_000) } },
        { returnDocument: 'after' },
      ).lean();
      if (!entry) return null;
      const link = `${signupBase}${signupBase.includes('?') ? '&' : '?'}invite=${encodeURIComponent(token)}&email=${encodeURIComponent(entry.email)}`;
      calm.app.background(() =>
        calm.mailer.send({
          to: entry.email,
          subject: `Your invitation to ${calm.config.app.name}`,
          text: `Your spot on the waitlist came up. Create your account here (valid for ${options.inviteTtlDays} days, works once):\n${link}`,
          meta: { kind: 'waitlist-invite', token },
        }),
      );
      calm.events.emit('waitlist.invited', { entry: adminView(entry), by });
      return entry;
    }

    /** An invite that is still valid for this address (and this token, when given). */
    async function validInvite(email, token) {
      if (!email) return null;
      const filter = { email: String(email).trim().toLowerCase(), status: 'invited', inviteExpiresAt: { $gt: new Date() } };
      if (token !== undefined) filter.inviteTokenHash = hashToken(token);
      return Entry.findOne(filter).lean();
    }

    calm.provide('waitlist', { Entry, join, invite, positionOf, validInvite });

    // The invite token travels with the register body; it is checked here and removed, so
    // the user resource never sees an unknown field.
    calm.guard(async (ctx, route) => {
      if (route?.method !== 'POST' || route.path !== '/auth/register') return;
      const body = ctx.req.body;
      if (!body || typeof body !== 'object' || Array.isArray(body)) return;
      const token = body.inviteToken;
      delete body.inviteToken;
      if (!options.gate) return;
      const entry = typeof token === 'string' && token.length <= 200 ? await validInvite(body.email, token) : null;
      if (!entry) {
        security('invite_refused', { ip: ctx.req.ip, reason: token ? 'invalid_token' : 'no_token' });
        throw inviteRequired();
      }
      ctx.req.calmWaitlistInvite = String(entry._id);
    });

    // Every other way to create an account: the address must be invited. Admins creating users
    // through the user CRUD and trusted code ({ system: true }) are not gated.
    calm.onService(({ def, service }) => {
      if (def.name !== 'user' || !options.gate) return;
      const before = service.beforeCreate.bind(service);
      service.beforeCreate = async (data, ctx = {}) => {
        const out = await before(data, ctx);
        if (ctx.system || hasRole(ctx.user, 'admin') || ctx.req?.calmWaitlistInvite) return out;
        if (!(await validInvite(out.email))) {
          security('invite_refused', { ip: ctx.req?.ip, reason: 'not_invited' });
          throw inviteRequired();
        }
        return out;
      };
    });

    // Registered: the entry is done and its token is spent (the email is unique on users, so
    // the same invite cannot open a second account either).
    calm.on('auth.registered', async ({ user }) => {
      if (!user?.email) return;
      const entry = await Entry.findOneAndUpdate(
        { email: user.email, status: { $in: ['waiting', 'invited'] } },
        { $set: { status: 'registered', registeredAt: new Date(), user: user._id, inviteTokenHash: null } },
        { returnDocument: 'after' },
      ).lean();
      if (entry) calm.events.emit('waitlist.registered', { entry: adminView(entry), userId: String(user._id) });
    });

    calm.routes((r) => {
      const tags = ['waitlist'];
      const joinLimit = options.joinLimit ? { ...options.joinLimit, key: (req) => `waitlist:${req.ip}` } : null;

      r.post(
        '/waitlist',
        {
          policy: 'public',
          summary: 'Join the waitlist (joining again answers the same entry)',
          rateLimit: joinLimit,
          input: { email: f.email().required(), name: f.string().max(100), referralCode: f.string().max(32) },
          tags,
        },
        async (ctx) => {
          const { entry, created } = await join(ctx.body, { ip: ctx.req.ip });
          return ctx.reply(await publicView(entry), { status: created ? 201 : 200 });
        },
      );

      r.get('/waitlist/:code', { policy: 'public', summary: 'Your place on the waitlist, by your referral code', tags }, async (ctx) => {
        const code = String(ctx.params.code).trim().toUpperCase();
        const entry = /^[A-Z0-9]{4,32}$/.test(code) ? await Entry.findOne({ referralCode: code }).lean() : null;
        if (!entry) throw notFound('Unknown referral code');
        return publicView(entry);
      });

      r.get('/admin/waitlist', { policy: 'admin', summary: 'Waitlist entries, in line order', tags }, async (ctx) => {
        const { status = 'waiting', q } = ctx.query;
        const page = ctx.query.page === undefined ? 1 : Number(ctx.query.page);
        const limit = ctx.query.limit === undefined ? 50 : Number(ctx.query.limit);
        const details = {};
        if (status !== 'all' && !STATUSES.includes(status)) details.status = `One of: all, ${STATUSES.join(', ')}`;
        if (!Number.isInteger(page) || page < 1) details.page = 'Must be a positive integer';
        if (!Number.isInteger(limit) || limit < 1 || limit > 100) details.limit = 'Must be an integer between 1 and 100';
        if (q !== undefined && (typeof q !== 'string' || q.length > 100)) details.q = 'At most 100 characters';
        if (Object.keys(details).length) throw badRequest('Invalid query', details);
        const filter = status === 'all' ? {} : { status };
        if (q) filter.$or = [{ email: new RegExp(escapeRegex(q), 'i') }, { name: new RegExp(escapeRegex(q), 'i') }];
        const [items, total] = await Promise.all([
          Entry.find(filter).sort({ score: 1, seq: 1 }).skip((page - 1) * limit).limit(limit).lean(),
          Entry.countDocuments(filter),
        ]);
        // In line order, so the place is the offset in the waiting list (unless a search narrows it).
        const ranked = status === 'waiting' && !q;
        const data = await Promise.all(items.map(async (e, i) => adminView(e, ranked ? (page - 1) * limit + i + 1 : await positionOf(e))));
        return ctx.reply(data, { meta: { total, page, limit, pages: Math.ceil(total / limit) } });
      });

      r.get('/admin/waitlist/stats', { policy: 'admin', summary: 'Waitlist numbers', tags }, async () => {
        const now = Date.now();
        const [byStatus, referred, referrals, last24h, last7d] = await Promise.all([
          Entry.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
          Entry.countDocuments({ referredBy: { $ne: null } }),
          Entry.aggregate([{ $group: { _id: null, n: { $sum: '$referrals' } } }]),
          Entry.countDocuments({ createdAt: { $gte: new Date(now - 86_400_000) } }),
          Entry.countDocuments({ createdAt: { $gte: new Date(now - 7 * 86_400_000) } }),
        ]);
        const count = Object.fromEntries(STATUSES.map((s) => [s, byStatus.find((x) => x._id === s)?.n ?? 0]));
        const total = count.waiting + count.invited + count.registered;
        const invitedEver = count.invited + count.registered;
        return {
          total,
          ...count,
          referred,
          referrals: referrals[0]?.n ?? 0,
          joined: { last24h, last7d },
          conversion: invitedEver ? Math.round((count.registered / invitedEver) * 1000) / 1000 : null,
        };
      });

      r.post(
        '/admin/waitlist/invite',
        { policy: 'admin', summary: 'Invite listed entries, or the next count in line', input: { ids: f.array(f.id()).max(options.maxInviteBatch), count: f.integer().min(1).max(options.maxInviteBatch) }, tags },
        async (ctx) => {
          const { ids, count } = ctx.body;
          if (!ids?.length && !count) throw badRequest('Send ids or count', { ids: 'Send ids or count' });
          const targets = ids?.length
            ? ids
            : (await Entry.find({ status: 'waiting' }).sort({ score: 1, seq: 1 }).limit(count).select('_id').lean()).map((e) => e._id);
          const invited = [];
          for (const id of targets) {
            const entry = await invite(id, ctx.user.id);
            if (entry) invited.push({ id: String(entry._id), email: entry.email });
          }
          return { invited, count: invited.length };
        },
      );

      r.post('/admin/waitlist/:entryId/invite', { policy: 'admin', summary: 'Invite one entry (again: the previous invite stops working)', tags }, async (ctx) => {
        const entry = isId(ctx.params.entryId) ? await invite(ctx.params.entryId, ctx.user.id) : null;
        if (!entry) throw notFound('No waiting or invited entry with this id');
        return adminView(entry);
      });

      r.delete('/admin/waitlist/:entryId', { policy: 'admin', summary: 'Remove an entry', tags }, async (ctx) => {
        const res = isId(ctx.params.entryId) ? await Entry.deleteOne({ _id: ctx.params.entryId }) : { deletedCount: 0 };
        if (!res.deletedCount) throw notFound('Entry not found');
        calm.events.emit('waitlist.removed', { entryId: ctx.params.entryId, by: ctx.user.id });
      });
    });

    calm.doctor((app) => {
      const findings = [];
      if (options.gate && !app.auth) findings.push({ level: 'warn', id: 'waitlist-gate-no-auth', title: 'waitlist: gate is on but auth is off', detail: 'There is no registration to gate.' });
      if (options.gate && app.config.auth.register === false) findings.push({ level: 'warn', id: 'waitlist-gate-register-off', title: 'waitlist: gate is on but registration is disabled', detail: 'Invited people cannot register while config.auth.register is false.' });
      if (!app.mailer.transport) findings.push({ level: 'error', id: 'waitlist-no-mail', title: 'waitlist cannot send invites', detail: 'No mail transport is configured. Add one: `npx calm add mail-resend` (or mail-smtp).' });
      return findings;
    });
  },
});
