// Devtools: a local dashboard at /_calm (development only).
//
// The collector below is yours like the rest of calm/. The UI is a separate dev
// dependency (@calmapi/devtools) because it is a tool, not part of your app.
//
// Safety: never enabled in production (config.js forces it off), and every /_calm
// request must come from this machine (loopback socket, localhost Host header, no
// proxy headers). Writes also need the X-Calm-Devtools header, which a cross-site
// page cannot send.

import express from 'express';
import { randomBytes, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, readFileSync, statSync, watchFile, unwatchFile, openSync, readSync, closeSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { currentRequest } from '../context.js';
import { serialize } from '../resource/resource.js';
import { kebab } from '../utils/strings.js';
import { maskToken, BEHAVIORS, PLATFORMS } from '../push.js';

const SKIP_COMMANDS = new Set(['hello', 'ismaster', 'isMaster', 'ping', 'endSessions', 'saslStart', 'saslContinue', 'buildInfo', 'getParameter', 'listIndexes', 'createIndexes']);
const EXPLAINABLE = new Set(['find', 'aggregate', 'count', 'distinct', 'update', 'delete', 'findAndModify']);
const SECRET_KEYS = /pass(word)?|secret|token|otp|api[-_]?key/i;
const MAX_BODY = 64 * 1024;

function ring(size) {
  const items = [];
  return {
    push(item) {
      items.push(item);
      if (items.length > size) items.shift();
      return item;
    },
    list: () => items,
    find: (fn) => items.find(fn),
    clear: () => void (items.length = 0),
  };
}

export function setupDevtools(app, ex) {
  const requests = ring(300);
  const orphanQueries = ring(200);
  const logs = ring(1000);
  const mails = ring(100);
  const pushes = ring(100);
  const activity = ring(500);
  const securityEvents = ring(300);
  const clients = new Set();
  const inflight = new Map(); // driver requestId -> { record, query }
  let seq = 0;

  const broadcast = (event, data) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of clients) res.write(frame);
  };

  // ---- capture -------------------------------------------------------------------
  app.log.addSink((entry) => {
    logs.push(entry);
    broadcast('log', entry);
  });

  // Security events (failed logins, lockouts, rejected writes...)
  app.events.on('security.*', (payload, name) => {
    const event = { id: ++seq, time: new Date().toISOString(), type: name.slice('security.'.length), ...payload };
    securityEvents.push(event);
    broadcast('security', event);
  });

  // Project activity written by `calm dev` (file changes, restarts, crashes) and
  // `calm mcp` (agent tool calls): .calm/activity.jsonl, tailed live.
  const activityPath = join(app.root, '.calm', 'activity.jsonl');
  let activityOffset = 0;
  const readNewActivity = (initial) => {
    if (!existsSync(activityPath)) return;
    const size = statSync(activityPath).size;
    if (size < activityOffset) activityOffset = 0; // file was compacted
    if (initial) {
      const lines = readFileSync(activityPath, 'utf8').trimEnd().split('\n').slice(-500);
      for (const line of lines) pushActivity(line, false);
      activityOffset = size;
      return;
    }
    if (size === activityOffset) return;
    const fd = openSync(activityPath, 'r');
    const buf = Buffer.alloc(size - activityOffset);
    readSync(fd, buf, 0, buf.length, activityOffset);
    closeSync(fd);
    activityOffset = size;
    for (const line of buf.toString('utf8').split('\n')) pushActivity(line, true);
  };
  const pushActivity = (line, live) => {
    if (!line.trim()) return;
    try {
      const event = { id: ++seq, ...JSON.parse(line) };
      activity.push(event);
      if (live) broadcast('activity', event);
    } catch {
      // partial line, picked up next time
    }
  };
  readNewActivity(true);
  watchFile(activityPath, { interval: 400 }, () => readNewActivity(false));
  app.hooks.shutdown.push(() => unwatchFile(activityPath));

  app.push.observe((record, event) => {
    if (event === 'created') pushes.push(record);
    broadcast('push', { id: record.id, event, status: record.status, title: record.message.title ?? record.message.body ?? null, createdAt: record.createdAt });
  });

  app.mailer.observe((msg) => {
    const mail = { id: ++seq, to: msg.to, from: msg.from, subject: msg.subject, text: msg.text, html: msg.html, sentAt: msg.sentAt, meta: msg.meta };
    mails.push(mail);
    broadcast('mail', { id: mail.id, to: mail.to, subject: mail.subject, sentAt: mail.sentAt });
  });

  app.hooks.devtools.onConnect = (db) => {
    const client = db.connection.getClient();
    client.on('commandStarted', (ev) => {
      if (SKIP_COMMANDS.has(ev.commandName)) return;
      const store = currentRequest();
      if (store?.devtoolsInternal) return; // queries made by devtools itself
      const record = store?.devtools;
      const query = {
        id: ++seq,
        command: ev.commandName,
        collection: collectionOf(ev),
        summary: summarize(ev.commandName, ev.command),
        raw: cleanCommand(ev.command),
        database: ev.databaseName,
        startedAt: performance.timeOrigin + performance.now(), // sub-millisecond epoch time
        durationMs: null,
        ok: null,
      };
      (record ? record.queries : null)?.push(query);
      if (!record) orphanQueries.push(query);
      inflight.set(ev.requestId, query);
    });
    const done = (ok) => (ev) => {
      const query = inflight.get(ev.requestId);
      if (!query) return;
      inflight.delete(ev.requestId);
      query.durationMs = Number(ev.duration?.toFixed?.(2) ?? ev.duration);
      query.ok = ok;
      if (ok) query.docs = countDocs(ev.reply);
      else query.error = ev.failure?.message;
    };
    client.on('commandSucceeded', done(true));
    client.on('commandFailed', done(false));
  };

  ex.use((req, res, next) => {
    const store = currentRequest();
    if (req.path.startsWith('/_calm')) {
      if (store) store.devtoolsInternal = true;
      return next();
    }
    const record = {
      id: req.id,
      method: req.method,
      path: req.originalUrl,
      startedAt: new Date().toISOString(),
      startedAtMs: performance.timeOrigin + performance.now(),
      status: null,
      durationMs: null,
      ip: req.ip,
      user: null,
      requestHeaders: redactHeaders(req.headers),
      requestBody: null,
      responseBody: null,
      queries: [],
      error: null,
      agent: req.get('x-calm-agent')?.slice(0, 60) ?? null,
    };
    if (store) store.devtools = record;
    const started = performance.now();

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      record.responseBody = truncate(redact(body, 0, true)); // tokens and keys in responses too
      return originalJson(body);
    };
    res.on('finish', () => {
      record.status = res.statusCode;
      record.durationMs = Math.round((performance.now() - started) * 10) / 10;
      record.requestBody = req.body === undefined ? null : truncate(redact(req.body));
      if (req.user) record.user = { id: req.user.id, name: req.user.name, email: req.user.email, roles: req.user.roles };
      if (req.calmRoute) record.route = `${app.config.apiPrefix}${req.calmRoute.path}`;
      if (req.calmError) {
        const { original, http } = req.calmError;
        record.error = { status: http.status, code: http.code, message: http.message, internal: original?.message, stack: original?.stack, details: http.details };
      }
      // Wait a tick so the access log line (written on the same 'finish' event) is included.
      setImmediate(() => {
        record.logs = logs.list().filter((l) => l.requestId === record.id).slice(-50);
        requests.push(record);
        broadcast('request', summary(record));
      });
    });
    next();
  });

  // ---- API -----------------------------------------------------------------------
  const api = express.Router();
  api.use(express.json({ limit: '1mb' }));
  api.use((req, res, next) => {
    if (req.method !== 'GET' && req.get('x-calm-devtools') !== '1') return res.status(403).json({ error: 'Missing X-Calm-Devtools header' });
    next();
  });

  api.get('/overview', (_req, res) => res.json(overview(app)));
  api.get('/doctor', async (_req, res) => res.json(await app.doctor()));
  api.get('/requests', (_req, res) => res.json(requests.list().map(summary).reverse()));
  api.delete('/requests', (_req, res) => {
    requests.clear();
    res.status(204).end();
  });
  api.get('/requests/:id', (req, res) => {
    const record = requests.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: 'Request not found (it may have rotated out)' });
    res.json(record);
  });
  api.post('/queries/:qid/explain', async (req, res) => {
    const query = findQuery(requests, orphanQueries, Number(req.params.qid));
    if (!query) return res.status(404).json({ error: 'Query not found' });
    if (!EXPLAINABLE.has(query.command)) return res.status(400).json({ error: `Cannot explain a ${query.command} command` });
    try {
      const db = app.mongoose.connection.getClient().db(query.database);
      const out = await db.command({ explain: query.raw, verbosity: 'queryPlanner' });
      res.json(planSummary(out));
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });
  api.get('/queries', (_req, res) => res.json(orphanQueries.list().slice().reverse()));
  api.get('/logs', (_req, res) => res.json(logs.list().slice(-500)));
  api.get('/activity', (_req, res) => res.json(activity.list().slice().reverse()));
  api.get('/security', async (_req, res) => {
    const { config } = app;
    const encrypted = [];
    for (const { def } of app.registry.values()) {
      for (const [k, f] of Object.entries(def.fields)) if (f.opts.encrypted) encrypted.push(`${def.name}.${k}`);
    }
    res.json({
      matrix: await app.exposure(),
      events: securityEvents.list().slice().reverse(),
      posture: {
        auth: Boolean(app.auth),
        sessions: app.auth ? `opaque tokens, SHA-256 at rest, ${config.auth.sessionTtlDays} days` : null,
        passwords: 'scrypt (node:crypto), common and personal passwords refused',
        lockout: config.auth.lockout,
        rateLimit: config.rateLimit.enabled ? { global: config.rateLimit.global, auth: config.rateLimit.auth } : 'off',
        cors: config.cors.origins,
        encryption: { keys: app.cipher?.keyIds ?? [], fields: encrypted },
        jsonLimits: config.jsonLimits,
        headers: ['X-Content-Type-Options', 'X-Frame-Options', 'Referrer-Policy', 'Cross-Origin-Opener-Policy', 'Content-Security-Policy', config.mode === 'production' ? 'Strict-Transport-Security' : null].filter(Boolean),
      },
    });
  });
  let auditRunning = null;
  api.post('/audit', async (_req, res) => {
    // Runs the same audit as `calm audit`, on a throwaway database.
    auditRunning ??= import('../security/audit.js')
      // Same MongoDB server as the dev database, but a throwaway database on it.
      .then(({ runAudit }) => runAudit({ root: app.root, baseUri: app.config.db.uri }))
      .finally(() => (auditRunning = null));
    try {
      const report = await auditRunning;
      broadcast('audit', report.summary);
      res.json(report);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  api.get('/mails', (_req, res) => res.json(mails.list().slice().reverse()));

  // ---- push notifications --------------------------------------------------------
  api.get('/pushes', async (_req, res) => {
    const list = pushes.list().slice().reverse();
    // Recipients by name, so the inbox reads "Grace Hopper" instead of an ObjectId.
    const ids = [...new Set(list.flatMap((p) => [...p.to.users, ...p.devices.map((d) => d.user)]).filter((id) => id && /^[a-f\d]{24}$/i.test(id)))];
    let users = new Map();
    if (ids.length && app.registry.has('user')) {
      const docs = await app.model('user').find({ _id: { $in: ids } }).select('name email').lean().catch(() => []);
      users = new Map(docs.map((u) => [String(u._id), { id: String(u._id), name: u.name, email: u.email }]));
    }
    const people = (p) => [...new Set([...p.to.users, ...p.devices.map((d) => d.user)].filter(Boolean))].map((id) => users.get(id) ?? { id });
    res.json(list.map((p) => ({ ...p, people: people(p) })));
  });

  const Device = () => app.push.devices;
  const deviceRow = (d, users) => ({
    id: String(d._id),
    user: users.get(String(d.user)) ?? { id: String(d.user) },
    platform: d.platform,
    name: d.name ?? null,
    token: maskToken(d.token),
    simulated: Boolean(d.simulated),
    behavior: d.simulated ? d.behavior ?? 'deliver' : null,
    signedIn: Boolean(d.session),
    via: app.push.routeFor(d), // the transport that would deliver to it
    inbox: d.simulated ? inboxCounts(String(d._id)) : null,
    appVersion: d.appVersion ?? null,
    lastSeenAt: d.lastSeenAt ?? null,
    createdAt: d.createdAt,
  });
  const inboxCounts = (id) => {
    const items = app.push.simulator.inbox(id);
    return { shown: items.filter((x) => x.state === 'shown').length, waiting: items.filter((x) => x.state === 'waiting').length, hidden: items.filter((x) => x.state === 'hidden').length, unopened: items.filter((x) => x.state === 'shown' && !x.openedAt).length };
  };
  async function listDevices(filter = {}) {
    if (!Device()) return [];
    const docs = await Device().find(filter).sort({ updatedAt: -1 }).limit(200).lean();
    const ids = [...new Set(docs.map((d) => String(d.user)))];
    const users = new Map(
      (await app.model('user').find({ _id: { $in: ids } }).select('name email').lean()).map((u) => [String(u._id), { id: String(u._id), name: u.name, email: u.email }]),
    );
    return docs.map((d) => deviceRow(d, users));
  }

  api.get('/devices', async (req, res) => {
    const filter = typeof req.query.user === 'string' && /^[a-f\d]{24}$/i.test(req.query.user) ? { user: req.query.user } : {};
    res.json(await listDevices(filter));
  });

  // Add a device to a user: simulated (a fake token that behaves like a phone you choose) or
  // a real token you paste, for example your own phone's Expo token.
  const LABEL = { ios: 'iPhone', android: 'Android phone', web: 'Browser' };
  async function addDevice(req, res) {
    if (!Device()) return res.status(400).json({ error: 'Push devices need auth and a user resource' });
    const { userId, platform = 'ios', name, behavior = 'deliver', token } = req.body ?? {};
    if (!PLATFORMS.includes(platform)) return res.status(400).json({ error: 'platform must be ios, android or web' });
    if (!BEHAVIORS[behavior]) return res.status(400).json({ error: `behavior must be one of ${Object.keys(BEHAVIORS).join(', ')}` });
    const user = await app.model('user').findById(userId).lean().catch(() => null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const real = typeof token === 'string' && token.trim() !== '';
    if (real && (token.length > 4096 || token.startsWith('sim_'))) return res.status(400).json({ error: 'That token cannot be registered' });
    const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 100) : real ? `${LABEL[platform]} (added in devtools)` : `Simulated ${LABEL[platform]}`;
    const doc = real
      ? await Device().findOneAndUpdate({ token: token.trim() }, { $set: { user: user._id, platform, name: label, simulated: false, behavior: 'deliver', session: null, lastSeenAt: new Date() } }, { upsert: true, returnDocument: 'after' })
      : await Device().create({ user: user._id, platform, token: `sim_${platform}_${randomBytes(12).toString('hex')}`, name: label, simulated: true, behavior, lastSeenAt: new Date() });
    app.log.info(`Devtools: added ${real ? 'a device token' : 'a simulated device'} for ${user.email ?? user._id}`);
    const [row] = await listDevices({ _id: doc._id });
    res.status(201).json(row);
  }
  api.post('/devices', addDevice);
  api.post('/devices/simulate', addDevice); // older name

  api.get('/devices/behaviors', (_req, res) => res.json(Object.entries(BEHAVIORS).map(([id, label]) => ({ id, label }))));

  const findDevice = async (id) => (Device() ? Device().findById(id).lean().catch(() => null) : null);

  api.patch('/devices/:id', async (req, res) => {
    const d = await findDevice(req.params.id);
    if (!d) return res.status(404).json({ error: 'Unknown device' });
    const set = {};
    if (req.body?.behavior !== undefined) {
      if (!d.simulated) return res.status(400).json({ error: 'Only simulated devices have a behavior' });
      if (!BEHAVIORS[req.body.behavior]) return res.status(400).json({ error: `behavior must be one of ${Object.keys(BEHAVIORS).join(', ')}` });
      set.behavior = req.body.behavior;
    }
    if (typeof req.body?.name === 'string' && req.body.name.trim()) set.name = req.body.name.trim().slice(0, 100);
    await Device().updateOne({ _id: d._id }, { $set: set });
    const [row] = await listDevices({ _id: d._id });
    res.json(row);
  });

  // The provider rolls the token: the app gets a new one and registers it, the old one stops
  // working. Your server only learns about it when a send to the old token fails.
  api.post('/devices/:id/rotate', async (req, res) => {
    const d = await findDevice(req.params.id);
    if (!d?.simulated) return res.status(400).json({ error: 'Only simulated devices can rotate their token' });
    await Device().updateOne({ _id: d._id }, { $set: { behavior: 'invalid', name: `${d.name ?? 'Simulated device'} (old token)` } });
    const fresh = await Device().create({ user: d.user, platform: d.platform, token: `sim_${d.platform}_${randomBytes(12).toString('hex')}`, name: (d.name ?? 'Simulated device').replace(/ \(old token\)$/, ''), simulated: true, behavior: 'deliver', lastSeenAt: new Date() });
    const [row] = await listDevices({ _id: fresh._id });
    res.status(201).json(row);
  });

  api.get('/devices/:id/inbox', async (req, res) => {
    const d = await findDevice(req.params.id);
    if (!d) return res.status(404).json({ error: 'Unknown device' });
    res.json({ device: (await listDevices({ _id: d._id }))[0], items: app.push.simulator.inbox(String(d._id)) });
  });
  api.post('/devices/:id/online', async (req, res) => {
    const d = await findDevice(req.params.id);
    if (!d?.simulated) return res.status(404).json({ error: 'Unknown simulated device' });
    if (d.behavior === 'offline') await Device().updateOne({ _id: d._id }, { $set: { behavior: 'deliver' } });
    res.json({ shown: app.push.simulator.online(String(d._id), d.name ?? undefined) });
  });
  api.post('/devices/:id/inbox/:pushId/open', async (req, res) => {
    const d = await findDevice(req.params.id);
    if (!d) return res.status(404).json({ error: 'Unknown device' });
    const item = app.push.simulator.open(String(d._id), req.params.pushId, d.name ?? undefined);
    if (!item) return res.status(404).json({ error: 'Not on this lock screen' });
    res.json(item);
  });
  api.delete('/devices/:id/inbox', (req, res) => {
    app.push.simulator.clear(req.params.id);
    res.status(204).end();
  });

  api.delete('/devices/:id', async (req, res) => {
    if (!Device()) return res.status(404).json({ error: 'Unknown device' });
    const result = await Device().deleteOne({ _id: req.params.id }).catch(() => ({ deletedCount: 0 }));
    if (!result.deletedCount) return res.status(404).json({ error: 'Unknown device' });
    app.push.simulator.clear(req.params.id);
    res.status(204).end();
  });

  // Send a test notification through the app's real push path (dev capture, or the
  // configured transport for real devices).
  api.post('/push/test', async (req, res) => {
    const { userId, deviceIds, ...message } = req.body ?? {};
    try {
      let target;
      if (Array.isArray(deviceIds) && deviceIds.length) target = { deviceIds };
      else if (userId) target = { to: userId };
      else return res.status(400).json({ error: 'Choose a user or devices to send to' });
      res.status(201).json(await app.push.send({ ...message, ...target }));
    } catch (err) {
      res.status(err.status ?? 500).json({ error: err.message, details: err.details });
    }
  });

  // Sample data from the field definitions (calm/seed.js), created through the services.
  api.post('/seed', async (req, res) => {
    const { resource, count = 10 } = req.body ?? {};
    try {
      const { seed } = await import('../seed.js');
      res.status(201).json(await seed(app, { resource, count: Math.min(Math.max(Number(count) || 10, 1), 200) }));
    } catch (err) {
      res.status(err.status ?? 400).json({ error: err.message, details: err.details });
    }
  });

  api.get('/resources/:name/docs', async (req, res) => {
    const entry = app.registry.get(kebab(req.params.name));
    if (!entry) return res.status(404).json({ error: 'Unknown resource' });
    const limit = Math.min(Number(req.query.limit) || 20, 100);
    const skip = Math.max(Number(req.query.skip) || 0, 0);
    const hiddenSelect = Object.entries(entry.def.fields).filter(([, f]) => !f.isOutput).map(([k]) => `+${k}`).join(' ');
    const [docs, total] = await Promise.all([
      entry.model.find().sort({ _id: -1 }).skip(skip).limit(limit).select(hiddenSelect).lean(),
      entry.model.countDocuments(),
    ]);
    let viewer = null;
    if (req.query.as && app.registry.has('user')) {
      const u = await app.model('user').findById(req.query.as).lean().catch(() => null);
      if (u) viewer = { ...u, id: String(u._id) };
    }
    const items = await Promise.all(
      docs.map(async (doc) => {
        const returned = await serialize(entry.def, doc, { user: viewer, registry: app.registry });
        const stored = maskSecrets(JSON.parse(JSON.stringify(doc)), entry.def);
        const notReturned = Object.keys(stored).filter((k) => k !== '_id' && !(k in returned));
        return { id: String(doc._id), stored, returned, notReturned };
      }),
    );
    res.json({ total, skip, limit, viewer: viewer ? { id: viewer.id, name: viewer.name } : null, items });
  });

  api.get('/users', async (req, res) => {
    if (!app.registry.has('user')) return res.json([]);
    const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 50) : '';
    const filter = q ? { $or: [{ name: new RegExp(escape(q), 'i') }, { email: new RegExp(escape(q), 'i') }] } : {};
    const users = await app.model('user').find(filter).sort({ _id: -1 }).limit(20).lean();
    res.json(users.map((u) => ({ id: String(u._id), name: u.name, email: u.email, roles: u.roles ?? [], status: u.status })));
  });

  api.post('/act-as', async (req, res) => {
    if (!app.auth) return res.status(400).json({ error: 'Auth is not enabled in this app' });
    const user = await app.model('user').findById(req.body?.userId).lean().catch(() => null);
    if (!user) return res.status(404).json({ error: 'User not found' });
    const session = await app.auth.service.createSession(user, req);
    app.log.info(`Devtools: acting as ${user.email ?? user._id}`);
    res.json({ ...session, user: { id: String(user._id), name: user.name, email: user.email, roles: user.roles ?? [] } });
  });

  api.get('/panels/:name', async (req, res) => {
    const fn = app.hooks.devtools[req.params.name];
    if (typeof fn !== 'function' || req.params.name === 'onConnect') return res.status(404).json({ error: 'Unknown panel' });
    res.json(await fn(app));
  });

  api.get('/stream', (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('retry: 2000\n\n');
    clients.add(res);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(res);
    });
  });

  api.use((_req, res) => res.status(404).json({ error: 'Unknown devtools endpoint' }));

  // End live streams on shutdown so they do not hold the server open.
  app.hooks.shutdown.push(() => {
    for (const res of clients) res.end();
    clients.clear();
  });

  const router = express.Router();
  router.use((req, res, next) => (isLocal(req) ? next() : res.status(404).end()));
  router.use((_req, res, next) => {
    // https images: push notification previews show the image a real phone would load.
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'");
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });
  router.use('/api', api);
  const ui = resolveUi(app.root);
  if (ui) router.use(express.static(ui, { index: 'index.html' }));
  else router.get('/', (_req, res) => res.type('html').send(MISSING_UI));
  ex.use('/_calm', router);
}

// ---- helpers ---------------------------------------------------------------------

function isLocal(req) {
  const addr = req.socket.remoteAddress ?? '';
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  const localHost = ['localhost', '127.0.0.1', '::1'].includes(host);
  return loopback && localHost && !req.headers['x-forwarded-for'] && !req.headers.forwarded;
}

function resolveUi(root) {
  try {
    const require = createRequire(join(root, 'package.json'));
    const dir = join(dirname(require.resolve('@calmapi/devtools/package.json')), 'ui');
    return existsSync(join(dir, 'index.html')) ? dir : null;
  } catch {
    return null;
  }
}

function overview(app) {
  const { config } = app;
  return {
    app: { name: config.app.name, version: config.app.version, mode: config.mode, url: config.app.url, apiPrefix: config.apiPrefix, root: app.root },
    runtime: { node: process.versions.node, pid: process.pid, uptimeSeconds: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576) },
    database: {
      connected: app.mongoose.connection.readyState === 1,
      name: app.mongoose.connection.name,
      host: app.mongoose.connection.host,
    },
    auth: Boolean(app.auth),
    mail: app.mailer.transport,
    push: app.push.transport,
    openapi: config.openapi.enabled ? `${config.apiPrefix}${config.openapi.path}` : null,
    resources: [...app.registry.values()].map(({ def, files }) => ({
      name: def.name,
      path: `${config.apiPrefix}${def.path}`,
      collection: def.collection,
      ownerField: def.ownerField,
      files,
      policy: Object.fromEntries(Object.entries(def.policy).map(([k, v]) => [k, (v ?? []).map((t) => (typeof t === 'function' ? t.name || 'custom' : t)).join(' | ')])),
      defaultedPolicies: def.defaultedPolicies,
      fields: Object.entries(def.fields).map(([name, field]) => describeField(name, field)),
    })),
    routes: app.routes.map((r) => ({
      method: r.method,
      path: `${config.apiPrefix}${r.path}`,
      policy: r.policyLabel,
      policyExplicit: r.policyExplicit,
      source: r.source,
      resource: r.resource,
      action: r.action,
      summary: r.summary ?? null,
      file: r.file ?? null,
      hidden: r.hidden,
    })),
    blocks: describeBlocks(app),
    panels: Object.keys(app.hooks.devtools).filter((k) => k !== 'onConnect'),
  };
}

/**
 * Installed blocks: where they came from (calm.lock), which files you changed since, the
 * extension points they use, their env vars (set or missing, secret values never sent),
 * options (secret-looking keys redacted) and routes.
 */
function describeBlocks(app) {
  let lock = {};
  try {
    lock = JSON.parse(readFileSync(join(app.root, 'calm.lock'), 'utf8'));
  } catch {
    // not created with the CLI: every block counts as your own
  }
  const hash = (file) => {
    try {
      return `sha256:${createHash('sha256').update(readFileSync(join(app.root, file))).digest('hex')}`;
    } catch {
      return null;
    }
  };
  return app.plugins.map((p) => {
    const [key, entry] = Object.entries(lock.blocks ?? {}).find(([k]) => k === p.name || k.split('/').pop() === p.name) ?? [null, null];
    const files = entry ? Object.entries(entry.files ?? {}) : [];
    const routes = app.routes.filter((r) => r.source === `block:${p.name}`);
    return {
      name: p.name,
      file: p.file,
      installed: entry ? { key, version: entry.version ?? null, source: entry.source ?? null } : null,
      files: files.map(([file]) => file),
      changed: files.filter(([file, sum]) => hash(file) !== sum).map(([file]) => file),
      uses: p.uses ?? [],
      env: (p.env ?? []).map((v) => (v.secret ? { ...v, value: null } : v)),
      options: redact(p.options ?? {}),
      routes: routes.map((r) => ({ method: r.method, path: `${app.config.apiPrefix}${r.path}`, policy: r.policyLabel })),
      panels: (p.uses ?? []).filter((u) => u.kind === 'devtools panel').map((u) => u.name),
    };
  });
}

function describeField(name, field) {
  const o = field.opts;
  const flags = [];
  for (const flag of ['required', 'unique', 'hidden', 'writeOnly', 'readOnly', 'immutable', 'searchable', 'sortable', 'owner', 'populate']) {
    if (o[flag]) flags.push(flag);
  }
  if (field.filterOps.length) flags.push('filterable');
  return {
    name,
    type: field.type === 'array' ? `${field.opts.of.type}[]` : field.type,
    ref: o.ref ?? o.of?.opts?.ref ?? null,
    values: o.values ?? o.of?.opts?.values ?? null,
    default: typeof o.default === 'function' ? 'fn()' : (o.default ?? null),
    flags,
    filterOps: field.filterOps,
    visibleTo: typeof o.visibleTo === 'string' ? o.visibleTo : o.visibleTo ? 'custom' : null,
    writableBy: typeof o.writableBy === 'string' ? o.writableBy : o.writableBy ? 'custom' : null,
    output: field.isOutput,
    input: field.isInput,
  };
}

const summary = (r) => ({
  id: r.id,
  method: r.method,
  path: r.path,
  route: r.route ?? null,
  status: r.status,
  durationMs: r.durationMs,
  startedAt: r.startedAt,
  user: r.user ? { id: r.user.id, name: r.user.name } : null,
  queries: r.queries.length,
  queryMs: Math.round(r.queries.reduce((s, q) => s + (q.durationMs ?? 0), 0) * 10) / 10,
  error: r.error ? r.error.code : null,
  agent: r.agent ?? null,
});

function redactHeaders(headers) {
  const out = { ...headers };
  if (out.authorization) out.authorization = out.authorization.replace(/(\S{6})\S+(\S{4})$/, '$1…$2');
  if (out.cookie) out.cookie = '[redacted]';
  return out;
}

/** Secret-looking keys become [redacted]; in responses the first characters stay, to tell them apart. */
function redact(value, depth = 0, partial = false) {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1, partial));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (SECRET_KEYS.test(k) && typeof v === 'string') out[k] = partial && v.length > 16 && !v.includes('…') ? `${v.slice(0, 8)}… [redacted]` : partial && v.includes('…') ? v : '[redacted]';
    else out[k] = redact(v, depth + 1, partial);
  }
  return out;
}

function truncate(body) {
  try {
    const text = JSON.stringify(body);
    if (text === undefined) return null;
    return text.length > MAX_BODY ? { truncated: true, preview: text.slice(0, MAX_BODY) } : JSON.parse(text);
  } catch {
    return null;
  }
}

function maskSecrets(doc, def) {
  for (const [k, field] of Object.entries(def.fields)) {
    if (field.type === 'password' && typeof doc[k] === 'string') doc[k] = '•••••• (scrypt hash)';
  }
  return doc;
}

const collectionOf = (ev) => {
  const v = ev.command?.[ev.commandName];
  return typeof v === 'string' ? v : null;
};

function cleanCommand(command) {
  const out = {};
  for (const [k, v] of Object.entries(command ?? {})) {
    if (k.startsWith('$') || k === 'lsid' || k === 'txnNumber' || k === 'apiVersion') continue;
    out[k] = v;
  }
  return JSON.parse(JSON.stringify(out));
}

function summarize(name, cmd) {
  switch (name) {
    case 'find': return { filter: cmd.filter, sort: cmd.sort, limit: cmd.limit, skip: cmd.skip, projection: cmd.projection };
    case 'aggregate': return { pipeline: cmd.pipeline };
    case 'count': return { query: cmd.query };
    case 'insert': return { documents: cmd.documents?.length };
    case 'update': return { updates: cmd.updates?.map((u) => ({ q: u.q, u: u.u })) };
    case 'delete': return { deletes: cmd.deletes?.map((d) => ({ q: d.q })) };
    case 'findAndModify': return { query: cmd.query, update: cmd.update };
    default: return {};
  }
}

function countDocs(reply) {
  if (!reply) return null;
  if (reply.cursor?.firstBatch) return reply.cursor.firstBatch.length;
  if (typeof reply.n === 'number') return reply.n;
  return null;
}

function planSummary(explain) {
  const stages = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.stage) stages.push({ stage: node.stage, index: node.indexName ?? null });
    for (const key of ['inputStage', 'queryPlan']) if (node[key]) walk(node[key]);
    for (const child of node.inputStages ?? []) walk(child);
  };
  const planner = explain.queryPlanner ?? explain.stages?.[0]?.$cursor?.queryPlanner;
  walk(planner?.winningPlan);
  return {
    stages,
    collscan: stages.some((s) => s.stage === 'COLLSCAN'),
    indexes: stages.filter((s) => s.index).map((s) => s.index),
    namespace: planner?.namespace ?? null,
  };
}

function findQuery(requests, orphans, id) {
  for (const r of requests.list()) {
    const q = r.queries.find((x) => x.id === id);
    if (q) return q;
  }
  return orphans.find((q) => q.id === id);
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const MISSING_UI = `<!doctype html><meta charset="utf-8"><title>CalmAPI devtools</title>
<body style="font:16px system-ui;max-width:40rem;margin:4rem auto;padding:0 1rem;line-height:1.5">
<h1>CalmAPI devtools</h1><p>The collector is running, but the UI package is not installed.</p>
<pre style="background:#f4f4f5;padding:1rem;border-radius:8px">npm install -D @calmapi/devtools</pre>
<p>The JSON API is available at <a href="/_calm/api/overview">/_calm/api/overview</a>.</p></body>`;
