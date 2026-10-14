import { definePlugin, f, hasRole, CalmError, notFound, validationError } from '#calm';

// Maintenance and read-only mode, switched at runtime by admins.
//
//   GET    /api/maintenance                          public: the current mode and upcoming windows (for banners)
//   GET    /api/admin/maintenance                    the stored state
//   PATCH  /api/admin/maintenance                    { mode, message, retryAfterSeconds, until, allowIps }
//   POST   /api/admin/maintenance/windows            { start, end, mode, message }  a scheduled window
//   DELETE /api/admin/maintenance/windows/:windowId
//
//  - 'maintenance' answers 503 MAINTENANCE on every API route; 'read-only' answers 503
//    READ_ONLY to writes (POST, PUT, PATCH, DELETE) while reads keep working. Both send
//    Retry-After (the end of the window, or retryAfterSeconds).
//  - Let through: admins (bypassRoles), allowlisted IPs (stored and in options), sign in and
//    out (so admins can get in), the status route and options.allow. /health/* and the
//    devtools are mounted before the API, so they never see this.
//  - The state lives in MongoDB and each instance re-reads it at most every cacheMs, so all
//    instances agree within that delay. Windows are evaluated against the clock on every
//    request: they start and end on time, whatever the cache.
//  - MAINTENANCE_MODE=maintenance|read-only forces a mode without the database (deploys,
//    migrations, a database that is down).

const MODES = ['off', 'maintenance', 'read-only'];
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const MAX_WINDOWS = 50;
const ALWAYS_ALLOWED = ['GET /maintenance', 'POST /auth/login', 'POST /auth/logout'];

/** IPv4 dotted quad to a 32 bit number, or null. */
function ipv4(ip) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.some((p) => p > 255) ? null : parts.reduce((n, p) => n * 256 + p, 0);
}
const plainIp = (ip) => String(ip ?? '').replace(/^::ffff:/, '');

/** Exact IPs (v4 or v6) and IPv4 CIDR ranges such as 10.0.0.0/8. */
export function ipMatches(ip, rule) {
  const value = plainIp(ip);
  const [base, bits] = String(rule).split('/');
  if (bits === undefined) return value === plainIp(base);
  const n = Number(bits);
  const a = ipv4(value);
  const b = ipv4(base);
  if (a === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) return false;
  const size = 2 ** (32 - n);
  return Math.floor(a / size) === Math.floor(b / size);
}
const validRule = (rule) => {
  const [base, bits] = String(rule).split('/');
  if (bits !== undefined) return ipv4(base) !== null && /^\d{1,2}$/.test(bits) && Number(bits) <= 32;
  return ipv4(base) !== null || /^[0-9a-f:]+$/i.test(base);
};

export default definePlugin({
  name: 'maintenance',
  env: {
    MAINTENANCE_MODE: 'Force "maintenance" or "read-only" at boot, without the database (overrides the stored state)',
  },
  options: {
    /** How long an instance trusts its copy of the state. All instances agree within this delay. */
    cacheMs: 5000,
    retryAfterSeconds: 300,
    message: 'We are doing some maintenance and will be back shortly.',
    readOnlyMessage: 'Changes are paused for a moment while we do some maintenance. Reading still works.',
    /** IPs or IPv4 CIDR ranges always let through, on top of the ones stored by admins. */
    allowIps: [],
    /** Roles that pass in both modes. [] makes admins wait like everyone else (they can still use the admin routes). */
    bypassRoles: ['admin'],
    /** More routes that stay open: ['GET /status', 'POST /webhooks/stripe'] (without /api). */
    allow: [],
  },
  setup(calm, options) {
    const { Schema } = calm.mongoose;
    const windowSchema = new Schema({ start: Date, end: Date, mode: { type: String, enum: ['maintenance', 'read-only'] }, message: String }, { _id: true });
    const stateSchema = new Schema(
      {
        _id: String,
        mode: { type: String, enum: MODES, default: 'off' },
        message: String,
        retryAfterSeconds: Number,
        until: Date,
        allowIps: { type: [String], default: [] },
        windows: { type: [windowSchema], default: [] },
        updatedBy: String,
      },
      { collection: 'calm_maintenance', timestamps: { createdAt: false, updatedAt: true }, versionKey: false },
    );
    const State = calm.mongoose.model('calmMaintenance', stateSchema);
    const ID = 'state';
    const EMPTY = { mode: 'off', allowIps: [], windows: [] };
    const allowed = new Set([...ALWAYS_ALLOWED, ...(options.allow ?? [])].map((key) => key.trim().replace(/\s+/, ' ')));

    let cache = { state: null, at: 0 };
    let loading = null;
    let warned = false;

    /** The stored state, at most cacheMs old. A database error keeps the last known state. */
    async function load({ fresh = false } = {}) {
      if (!fresh && cache.state && Date.now() - cache.at < options.cacheMs) return cache.state;
      loading ??= State.findById(ID)
        .lean()
        .then((doc) => {
          cache = { state: doc ?? EMPTY, at: Date.now() };
          warned = false;
          return cache.state;
        })
        .catch((err) => {
          if (!warned) calm.log.warn('maintenance: could not read the state, keeping the last known one', { err });
          warned = true;
          return cache.state ?? EMPTY;
        })
        .finally(() => {
          loading = null;
        });
      return loading;
    }

    /** What applies at `now`: { mode, message, until, source }. */
    function effective(state, now = new Date()) {
      const forced = calm.env('MAINTENANCE_MODE');
      if (forced === 'maintenance' || forced === 'read-only') return { mode: forced, message: state.message ?? null, until: null, source: 'env' };
      if (state.mode && state.mode !== 'off' && (!state.until || state.until > now)) return { mode: state.mode, message: state.message ?? null, until: state.until ?? null, source: 'manual' };
      const active = (state.windows ?? []).find((w) => w.start <= now && w.end > now);
      if (active) return { mode: active.mode, message: active.message ?? null, until: active.end, source: 'window' };
      return { mode: 'off', message: null, until: null, source: null };
    }

    const messageFor = (current) => current.message || (current.mode === 'read-only' ? options.readOnlyMessage : options.message);
    const retryAfter = (current, state, now = Date.now()) =>
      current.until ? Math.max(1, Math.ceil((new Date(current.until).getTime() - now) / 1000)) : (state.retryAfterSeconds ?? options.retryAfterSeconds);
    const upcoming = (state, now = new Date()) =>
      (state.windows ?? []).filter((w) => w.end > now).sort((a, b) => a.start - b.start).map((w) => ({ id: String(w._id), start: w.start, end: w.end, mode: w.mode, message: w.message ?? null }));

    // First guard to run (lowest order): a request refused here never reaches other guards.
    calm.guard(
      async (ctx, route) => {
        const state = await load();
        const current = effective(state);
        if (current.mode === 'off') return;
        if (route && allowed.has(`${route.method} ${route.path}`)) return;
        if (current.mode === 'read-only' && SAFE_METHODS.has(ctx.req.method)) return;
        if ((options.bypassRoles ?? []).some((role) => hasRole(ctx.user, role))) return;
        // req.ip follows config.trustProxy: set TRUST_PROXY behind a load balancer, or every
        // request comes from the proxy's address.
        if ([...(options.allowIps ?? []), ...(state.allowIps ?? [])].some((rule) => ipMatches(ctx.req.ip, rule))) return;
        ctx.res.setHeader('Retry-After', String(retryAfter(current, state)));
        ctx.res.setHeader('Cache-Control', 'no-store');
        throw new CalmError(503, current.mode === 'maintenance' ? 'MAINTENANCE' : 'READ_ONLY', messageFor(current));
      },
      { order: -100 },
    );

    async function save(update, by) {
      const now = new Date();
      // Ended windows are dropped whenever the state is written.
      await State.updateOne({ _id: ID }, { $pull: { windows: { end: { $lte: now } } } });
      const doc = await State.findOneAndUpdate({ _id: ID }, { ...update, $set: { ...(update.$set ?? {}), updatedBy: by } }, { upsert: true, returnDocument: 'after', runValidators: true }).lean();
      cache = { state: doc, at: Date.now() }; // this instance applies it at once
      calm.events.emit('maintenance.changed', { state: view(doc), by });
      return doc;
    }

    const view = (state) => {
      const current = effective(state);
      return {
        mode: current.mode,
        source: current.source,
        message: current.mode === 'off' ? null : messageFor(current),
        until: current.until,
        retryAfterSeconds: current.mode === 'off' ? null : retryAfter(current, state),
        stored: {
          mode: state.mode ?? 'off',
          message: state.message ?? null,
          retryAfterSeconds: state.retryAfterSeconds ?? null,
          until: state.until ?? null,
          allowIps: state.allowIps ?? [],
          updatedAt: state.updatedAt ?? null,
          updatedBy: state.updatedBy ?? null,
        },
        windows: upcoming(state),
        cacheMs: options.cacheMs,
      };
    };

    calm.provide('maintenance', {
      State,
      status: async () => effective(await load({ fresh: true })),
      set: (fields, by = 'system') => save({ $set: fields }, by),
    });

    calm.routes((r) => {
      const tags = ['maintenance'];

      r.get('/maintenance', { policy: 'public', summary: 'Current maintenance mode and upcoming windows (for banners)', tags }, async (ctx) => {
        const state = await load();
        const current = effective(state);
        return ctx.reply(
          {
            mode: current.mode,
            message: current.mode === 'off' ? null : messageFor(current),
            until: current.until,
            retryAfterSeconds: current.mode === 'off' ? null : retryAfter(current, state),
            upcoming: upcoming(state).map(({ id: _id, ...w }) => w),
          },
          { headers: { 'Cache-Control': 'no-store' } },
        );
      });

      r.get('/admin/maintenance', { policy: 'admin', summary: 'Maintenance state', tags }, async () => view(await load({ fresh: true })));

      r.patch(
        '/admin/maintenance',
        {
          policy: 'admin',
          summary: 'Switch maintenance or read-only mode (null resets a field)',
          input: {
            mode: f.enum(MODES),
            message: f.string().max(500),
            retryAfterSeconds: f.integer().min(1).max(86_400),
            until: f.date(),
            allowIps: f.array(f.string().max(64).check(validRule, 'Must be an IP address or an IPv4 CIDR range')).max(100),
          },
          tags,
        },
        async (ctx) => {
          const $set = {};
          const $unset = {};
          for (const [key, value] of Object.entries(ctx.body)) {
            if (value === null) $unset[key] = 1;
            else $set[key] = value;
          }
          if ($set.until && $set.until <= new Date()) throw validationError({ until: 'Must be in the future' });
          // Turning the mode off also clears its end time, so the next switch starts clean.
          if ($set.mode === 'off') $unset.until = 1;
          const update = { $set };
          if (Object.keys($unset).length) update.$unset = $unset;
          return view(await save(update, ctx.user.id));
        },
      );

      r.post(
        '/admin/maintenance/windows',
        {
          policy: 'admin',
          status: 201,
          summary: 'Schedule a maintenance or read-only window',
          input: { start: f.date().required(), end: f.date().required(), mode: f.enum(['maintenance', 'read-only']).default('maintenance'), message: f.string().max(500) },
          tags,
        },
        async (ctx) => {
          const { start, end, mode = 'maintenance', message } = ctx.body;
          if (end <= start) throw validationError({ end: 'Must be after start' });
          if (end <= new Date()) throw validationError({ end: 'Must be in the future' });
          const state = await load({ fresh: true });
          if ((state.windows ?? []).filter((w) => w.end > new Date()).length >= MAX_WINDOWS) throw validationError({ start: `At most ${MAX_WINDOWS} windows` });
          return view(await save({ $push: { windows: { start, end, mode, ...(message ? { message } : {}) } } }, ctx.user.id));
        },
      );

      r.delete('/admin/maintenance/windows/:windowId', { policy: 'admin', summary: 'Cancel a scheduled window', tags }, async (ctx) => {
        const id = ctx.params.windowId;
        const state = await load({ fresh: true });
        if (!/^[a-f\d]{24}$/i.test(id) || !(state.windows ?? []).some((w) => String(w._id) === id)) throw notFound('Window not found');
        await save({ $pull: { windows: { _id: new calm.mongoose.Types.ObjectId(id) } } }, ctx.user.id);
      });
    });

    calm.doctor(async () => {
      const forced = calm.env('MAINTENANCE_MODE');
      const findings = [];
      if (forced && !['maintenance', 'read-only', 'off'].includes(forced)) {
        findings.push({ level: 'warn', id: 'maintenance-env', title: `MAINTENANCE_MODE="${forced}" is ignored`, detail: 'Use maintenance, read-only or off.' });
      } else if (forced === 'maintenance' || forced === 'read-only') {
        findings.push({ level: 'info', id: 'maintenance-forced', title: `MAINTENANCE_MODE forces ${forced}`, detail: 'Admins cannot switch it off from the API until the variable is removed.' });
      }
      return findings;
    });
  },
});
