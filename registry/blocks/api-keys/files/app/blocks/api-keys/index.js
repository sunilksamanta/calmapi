import { definePlugin, f, hashToken, CalmError, unauthorized, forbidden, notFound, validationError, validateInput } from '#calm';
import { generateKey, isKeyShaped, hasValidChecksum, displayPrefix } from './keys.js';
import { CUSTOM_SCOPE, routeKey, requiredScope, grants, catalog } from './scopes.js';

// Personal and service API keys for scripts, CI and integrations.
//
//  - Users create keys from a signed-in session; the full key is shown once.
//  - Only a SHA-256 hash is stored, plus the first characters so people can tell keys apart.
//  - Keys work in Authorization: Bearer <key>, exactly like a session token.
//  - Scopes (see scopes.js) narrow what a key can do. Policies still apply on top, so a key
//    never does more than its user, and a disabled user's keys stop working at once.
//  - Keys cannot touch /auth/* (keys, passwords, sessions, 2FA) except GET /auth/me: a
//    leaked key must not be able to lock its owner out or mint more keys.
//  - Keys expire (90 days by default, 365 at most) unless you allow otherwise.
//  - Refused keys (typo, unknown, expired, revoked, disabled user) emit security.invalid_api_key
//    with a reason, never the key itself.

const TOUCH_MS = 60_000; // write lastUsedAt at most once a minute per key
const KEEP_DAYS = 30; // revoked and expired keys stay visible this long, then MongoDB deletes them
const DAY_MS = 86_400_000;

export default definePlugin({
  name: 'api-keys',
  options: {
    /** Who may create keys (any policy, e.g. 'admin' or 'member | admin'). */
    policy: 'authenticated',
    /** Active keys one user can have at the same time. */
    maxKeysPerUser: 20,
    /** Lifetime when the request does not say. */
    defaultExpiryDays: 90,
    /** Longest lifetime a request may ask for. */
    maxLifetimeDays: 365,
    /** Allow { expiresInDays: null } (a key that never expires). */
    allowNoExpiry: false,
    /** Scopes of a key created without scopes. Read only, so writes are always a choice. */
    defaultScopes: ['read'],
    /** Custom scopes for routes: { 'POST /reports/export': 'reports:export' }. */
    routeScopes: {},
    /** A password reset (account recovery) revokes every key of that user. */
    revokeOnPasswordReset: true,
  },
  setup(calm, options) {
    const { Schema } = calm.mongoose;
    const apiPrefix = calm.config.apiPrefix;
    const security = (name, data) => calm.events.emit(`security.${name}`, data);
    const users = () => calm.app.model('user');

    const custom = new Map();
    for (const [route, scope] of Object.entries(options.routeScopes ?? {})) {
      const [method, path] = route.trim().split(/\s+/);
      if (!method || !path?.startsWith('/')) throw new Error(`api-keys: routeScopes key "${route}" must look like 'POST /reports/export'`);
      if (!CUSTOM_SCOPE.test(scope)) throw new Error(`api-keys: routeScopes["${route}"] = "${scope}" must look like area:action, e.g. reports:export`);
      custom.set(routeKey(method, path, apiPrefix), scope);
    }

    const schema = new Schema(
      {
        name: { type: String, required: true },
        user: { type: Schema.Types.ObjectId, required: true, index: true },
        tokenHash: { type: String, required: true, unique: true },
        prefix: { type: String, required: true },
        scopes: { type: [String], required: true },
        expiresAt: { type: Date, default: null },
        lastUsedAt: { type: Date, default: null },
        lastUsedIp: { type: String, default: null },
        createdIp: { type: String, default: null },
        revokedAt: { type: Date, default: null },
        revokedBy: { type: Schema.Types.ObjectId, default: null },
        revokedReason: { type: String, default: null },
        purgeAt: { type: Date, default: null },
      },
      { collection: 'calm_api_keys', timestamps: true, versionKey: false },
    );
    schema.index({ purgeAt: 1 }, { expireAfterSeconds: 0 });
    const ApiKey = calm.mongoose.model('calmApiKey', schema);

    const activeFilter = (extra = {}) => ({ ...extra, revokedAt: null, $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }] });
    const statusOf = (k, now = new Date()) => (k.revokedAt ? 'revoked' : k.expiresAt && k.expiresAt <= now ? 'expired' : 'active');
    const view = (k) => ({
      id: String(k._id),
      name: k.name,
      prefix: k.prefix,
      scopes: k.scopes,
      status: statusOf(k),
      createdAt: k.createdAt,
      lastUsedAt: k.lastUsedAt ?? null,
      lastUsedIp: k.lastUsedIp ?? null,
      expiresAt: k.expiresAt ?? null,
    });

    // ---- which routes keys may call ------------------------------------------------

    const isWhoAmI = (route) => route.method === 'GET' && route.path === '/auth/me';
    const isAccountRoute = (route) => route.path === '/auth' || route.path.startsWith('/auth/');
    /** Routes no key may call, whatever its scopes: key management and account security. */
    const keysCannotUse = (route) => route.source === `block:${calm.name}` || (isAccountRoute(route) && !isWhoAmI(route));

    const scopeCtx = () => ({ registry: calm.app.registry, custom, apiPrefix, skip: (r) => keysCannotUse(r) || isWhoAmI(r) });
    let known = null; // routes are final once the app is built, so compute the catalog once
    const knownScopes = () => (known ??= catalog(calm.app.routes, scopeCtx()));

    calm.guard((ctx, route) => {
      if (ctx.auth?.via !== 'api-key') return; // sessions are not affected
      if (isWhoAmI(route)) return; // any key may ask who it acts as
      if (keysCannotUse(route)) throw forbidden('API keys cannot manage API keys, passwords, sessions or sign-in settings. Sign in with your password to do this.');
      const need = requiredScope(route, scopeCtx());
      if (!grants(ctx.auth.scopes, route, need)) throw forbidden(`This API key does not have the "${need.scope}" scope`);
    });

    // ---- authentication ------------------------------------------------------------

    calm.authenticate(async (token, req) => {
      // Not shaped like our keys: a session token or another block's credential. (Session
      // tokens are calm_<random> and can start with calm_ak_ by chance, but never have this shape.)
      if (!isKeyShaped(token)) return null;
      const where = { ip: req.ip, path: req.originalUrl };
      const refuse = (reason, key) => {
        security('invalid_api_key', { ...where, reason, ...(key ? { keyId: String(key._id), prefix: key.prefix, userId: String(key.user) } : {}) });
        return unauthorized(reason === 'checksum' ? 'This API key is not valid. Check that it was copied completely.' : 'API key is invalid, expired or revoked');
      };

      // A typo: rejected without touching the database.
      if (!hasValidChecksum(token)) throw refuse('checksum');

      // Looking a key up by the hash of ~190 random bits leaks nothing useful through timing.
      const key = await ApiKey.findOne({ tokenHash: hashToken(token) }).lean();
      if (!key) throw refuse('unknown');
      if (key.revokedAt) throw refuse('revoked', key);
      if (key.expiresAt && key.expiresAt <= new Date()) throw refuse('expired', key);

      const user = await users().findById(key.user).lean();
      if (!user || user.status === 'disabled') throw refuse(user ? 'user_disabled' : 'user_deleted', key);

      const now = Date.now();
      if (!key.lastUsedAt || now - key.lastUsedAt.getTime() >= TOUCH_MS) {
        // After the response, and conditional so concurrent requests write once.
        calm.app.background(() =>
          ApiKey.updateOne(
            { _id: key._id, $or: [{ lastUsedAt: null }, { lastUsedAt: { $lte: new Date(now - TOUCH_MS) } }] },
            { $set: { lastUsedAt: new Date(now), lastUsedIp: req.ip ?? null } },
          ),
        );
      }
      return { user, via: 'api-key', scopes: key.scopes, id: String(key._id) };
    });

    // ---- creating and revoking ---------------------------------------------------

    const input = {
      name: f.string().required().max(100).describe('What the key is for, e.g. "GitHub Actions deploy"'),
      scopes: f.array(f.string().max(100)).max(50).describe(`Defaults to ${JSON.stringify(options.defaultScopes)}. GET ${apiPrefix}/auth/api-keys/scopes lists them all.`),
      expiresInDays: (options.maxLifetimeDays ? f.integer().min(1).max(options.maxLifetimeDays) : f.integer().min(1)).describe(
        `Defaults to ${options.defaultExpiryDays ?? 'never'}${options.allowNoExpiry ? '. null: never expires' : ''}`,
      ),
    };

    function checkScopes(list) {
      const scopes = [...new Set((list ?? options.defaultScopes).map((s) => String(s).trim()).filter(Boolean))];
      if (!scopes.length) throw validationError({ scopes: 'Pick at least one scope' });
      const valid = new Set(knownScopes().map((s) => s.scope));
      const unknown = scopes.filter((s) => !valid.has(s));
      if (unknown.length) {
        throw validationError({
          scopes: `Unknown scope${unknown.length > 1 ? 's' : ''} ${unknown.map((s) => `"${s}"`).join(', ')}. Valid scopes: ${[...valid].join(', ')} (GET ${apiPrefix}/auth/api-keys/scopes describes them)`,
        });
      }
      return scopes.includes('*') ? ['*'] : scopes;
    }

    function expiryFrom(days) {
      if (days === null || (days === undefined && options.defaultExpiryDays == null)) {
        if (!options.allowNoExpiry) throw validationError({ expiresInDays: `API keys must expire${options.maxLifetimeDays ? `: pick 1 to ${options.maxLifetimeDays} days` : ''}` });
        return null;
      }
      const n = days ?? Math.min(options.defaultExpiryDays, options.maxLifetimeDays ?? Infinity);
      return new Date(Date.now() + n * DAY_MS);
    }

    let stats = null; // for calm doctor, which is synchronous
    async function refreshStats() {
      const [active, everythingForever] = await Promise.all([
        ApiKey.countDocuments(activeFilter()),
        ApiKey.countDocuments({ revokedAt: null, expiresAt: null, scopes: '*' }),
      ]);
      stats = { active, everythingForever };
    }
    const refreshLater = () => calm.app.started && calm.app.background(refreshStats);

    async function createKey(user, body, req) {
      const scopes = checkScopes(body.scopes);
      const expiresAt = expiryFrom(body.expiresInDays);
      const count = await ApiKey.countDocuments(activeFilter({ user: user._id }));
      if (count >= options.maxKeysPerUser) {
        throw new CalmError(409, 'API_KEY_LIMIT', `You already have ${count} active API keys (the limit is ${options.maxKeysPerUser}). Revoke one first.`);
      }
      const key = generateKey();
      const doc = await ApiKey.create({
        name: body.name,
        user: user._id,
        tokenHash: hashToken(key),
        prefix: displayPrefix(key),
        scopes,
        expiresAt,
        createdIp: req?.ip ?? null,
        purgeAt: expiresAt ? new Date(expiresAt.getTime() + KEEP_DAYS * DAY_MS) : null,
      });
      security('api_key_created', { userId: String(user._id), keyId: String(doc._id), prefix: doc.prefix, scopes, expiresAt, ip: req?.ip });
      refreshLater();
      return { ...view(doc.toObject()), key, note: 'Copy this key now. It is not stored and will not be shown again.' };
    }

    async function revoke(filter, { by = null, reason }) {
      const now = new Date();
      const key = await ApiKey.findOneAndUpdate(
        { ...filter, revokedAt: null },
        { $set: { revokedAt: now, revokedBy: by, revokedReason: reason, purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) } },
        { returnDocument: 'after' },
      ).lean();
      if (!key) throw notFound('API key not found');
      security('api_key_revoked', { userId: String(key.user), keyId: String(key._id), prefix: key.prefix, by: by ? String(by) : null, reason });
      refreshLater();
    }

    const byId = (id) => {
      if (!calm.mongoose.isObjectIdOrHexString(id)) throw notFound('API key not found');
      return { _id: id };
    };

    if (options.revokeOnPasswordReset) {
      calm.on('auth.password_reset', async ({ userId }) => {
        const now = new Date();
        const res = await ApiKey.updateMany(
          { user: userId, revokedAt: null },
          { $set: { revokedAt: now, revokedReason: 'password_reset', purgeAt: new Date(now.getTime() + KEEP_DAYS * DAY_MS) } },
        );
        if (res.modifiedCount) security('api_keys_revoked', { userId, count: res.modifiedCount, reason: 'password_reset' });
        refreshLater();
      });
    }

    // For seeds and scripts, e.g. a key for a service account:
    //   await app.ext.apiKeys.create(user, { name: 'Billing sync', scopes: ['invoices:write'] })
    calm.provide('apiKeys', {
      model: ApiKey,
      scopes: () => knownScopes(),
      create: async (user, body) => createKey({ _id: user?._id ?? user }, await validateInput({ name: 'apiKey', fields: input }, body, { mode: 'create' }), null),
      revoke: (id, reason = 'script') => revoke(byId(id), { reason }),
    });

    // ---- routes ----------------------------------------------------------------------

    calm.routes(
      (r) => {
        r.post('/', { policy: options.policy, status: 201, summary: 'Create an API key (the key is shown once)', input, tags: ['auth'] }, async (ctx) => {
          // no-store: the only response that ever contains the key must not sit in a cache.
          return ctx.reply(await createKey(ctx.user, ctx.body, ctx.req), { status: 201, headers: { 'cache-control': 'no-store' } });
        });
        r.get('/', { policy: 'authenticated', summary: 'Your API keys (never the keys themselves)', tags: ['auth'] }, async (ctx) => {
          const keys = await ApiKey.find({ user: ctx.user._id, revokedAt: null }).sort({ createdAt: -1 }).lean();
          return keys.map(view);
        });
        r.get('/scopes', { policy: 'authenticated', summary: 'Scopes an API key can have', tags: ['auth'] }, () => knownScopes());
        r.delete('/:keyId', { policy: 'authenticated', summary: 'Revoke one of your API keys', tags: ['auth'] }, (ctx) =>
          revoke({ ...byId(ctx.params.keyId), user: ctx.user._id }, { by: ctx.user._id, reason: 'user' }),
        );
      },
      { prefix: '/auth/api-keys' },
    );

    calm.routes(
      (r) => {
        r.get('/', { policy: 'admin', summary: 'Every API key, with its owner', tags: ['admin'] }, async (ctx) => {
          const filter = {};
          if (typeof ctx.query.user === 'string') {
            if (!calm.mongoose.isObjectIdOrHexString(ctx.query.user)) throw validationError({ user: 'Must be a valid id' });
            filter.user = ctx.query.user;
          }
          if (ctx.query.status === 'active') Object.assign(filter, activeFilter());
          else if (ctx.query.status === 'revoked') filter.revokedAt = { $ne: null };
          else if (ctx.query.status === 'expired') Object.assign(filter, { revokedAt: null, expiresAt: { $lte: new Date() } });
          const limit = Math.min(Math.max(Number(ctx.query.limit) || 50, 1), 200);
          return adminList(filter, limit);
        });
        r.delete('/:keyId', { policy: 'admin', summary: "Revoke anyone's API key", tags: ['admin'] }, (ctx) =>
          revoke(byId(ctx.params.keyId), { by: ctx.user._id, reason: 'admin' }),
        );
      },
      { prefix: '/admin/api-keys' },
    );

    async function adminList(filter, limit) {
      const keys = await ApiKey.find(filter).sort({ createdAt: -1 }).limit(limit).lean();
      const owners = await users()
        .find({ _id: { $in: [...new Set(keys.map((k) => String(k.user)))] } })
        .select('name email')
        .lean();
      const byOwner = new Map(owners.map((u) => [String(u._id), u]));
      return keys.map((k) => {
        const owner = byOwner.get(String(k.user));
        return {
          ...view(k),
          owner: { id: String(k.user), name: owner?.name ?? null, email: owner?.email ?? null },
          revokedAt: k.revokedAt ?? null,
          revokedReason: k.revokedReason ?? null,
        };
      });
    }

    // ---- devtools and doctor -----------------------------------------------------------

    calm.devtools.panel('api-keys', async () => {
      await refreshStats();
      const keys = await adminList({}, 100);
      return {
        active: stats.active,
        everythingForever: stats.everythingForever,
        keys: keys.map((k) => ({
          owner: k.owner.email ?? k.owner.id,
          name: k.name,
          prefix: `${k.prefix}...`,
          scopes: k.scopes.join(' '),
          status: k.status,
          lastUsedAt: k.lastUsedAt,
          lastUsedIp: k.lastUsedIp,
          expiresAt: k.expiresAt,
          createdAt: k.createdAt,
        })),
      };
    });

    calm.onStart(refreshStats);

    calm.doctor(() => {
      const findings = [];
      const file = 'app/blocks/api-keys/index.js';
      if (!calm.app.auth) {
        findings.push({ level: 'warn', id: 'api-keys-no-auth', title: 'The api-keys block needs auth', detail: 'Auth is disabled or there is no user resource, so API keys cannot be created or used.', file });
        return findings;
      }
      const routeKeys = new Set(calm.app.routes.map((r) => `${r.method} ${r.path}`));
      for (const key of custom.keys()) {
        if (!routeKeys.has(key)) findings.push({ level: 'warn', id: 'api-keys-route-scope', title: `api-keys routeScopes: no route ${key}`, detail: 'Check the method and path in calm.config.js blocks["api-keys"].routeScopes (as registered, :params included).', file });
      }
      const valid = new Set(knownScopes().map((s) => s.scope));
      const badDefaults = (options.defaultScopes ?? []).filter((s) => !valid.has(s));
      if (badDefaults.length) findings.push({ level: 'warn', id: 'api-keys-default-scopes', title: `api-keys defaultScopes has unknown scopes: ${badDefaults.join(', ')}`, detail: 'Keys created without scopes would be refused. Fix blocks["api-keys"].defaultScopes.', file });

      // Counts come from the database: refreshed at start, on changes and after each check.
      if (stats) {
        findings.push({ level: 'info', id: 'api-keys-count', title: `${stats.active} active API key${stats.active === 1 ? '' : 's'}`, detail: `Devtools (API keys panel) and GET ${apiPrefix}/admin/api-keys list them.` });
        if (stats.everythingForever) {
          findings.push({
            level: 'warn',
            id: 'api-keys-everything-forever',
            title: `${stats.everythingForever} API key${stats.everythingForever === 1 ? '' : 's'} with the * scope and no expiry`,
            detail: `A leaked key like this works until someone notices. Revoke it (DELETE ${apiPrefix}/admin/api-keys/:id) and create keys with narrower scopes and an expiry.`,
            file,
          });
        }
      }
      refreshLater();
      return findings;
    });
  },
});
