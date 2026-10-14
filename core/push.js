// Push notifications, one API for iOS, Android and the web:
//
//   await app.push.send({ to: user.id, title: 'Order shipped', body: 'Arrives Thursday', url: '/orders/42' })
//   await app.push.send({ to: [id1, id2], title: 'New comment', data: { postId } })
//   await app.push.send({ deviceIds: [deviceId], title: 'Hi' })
//   await app.push.send({ tokens: ['<device token>'], platform: 'android', title: 'Hi' })
//
// `to` is resolved to the devices your apps registered (POST /api/auth/devices). In
// development and tests nothing is delivered: the built-in transport records every
// notification for devtools (open /_calm, Push) with iOS, Android and web previews, the
// payload each provider would receive, size checks and a delivery log.
//
// For real delivery add a transport block (`calm add push-fcm`, `calm add push-expo`) or
// register your own:
//   app.push.use({ name: 'x', async send(message, devices) { return devices.map(() => ({ ok: true })) } })
// A transport returns one result per device: { ok, id?, error?, unregistered? }. Devices
// reported as unregistered are removed. Simulated devices (created in devtools) are never
// handed to a real transport.

import { randomBytes } from 'node:crypto';
import { currentRequest } from './context.js';
import { validationError } from './errors.js';

export const PLATFORMS = ['ios', 'android', 'web'];

// How a simulated device answers, so you can see what your app does when a phone is offline,
// has notifications turned off or was uninstalled, without owning that phone.
export const BEHAVIORS = {
  deliver: 'Delivers: accepted, then shown on the lock screen',
  offline: 'Offline: accepted, shown when the device comes back online',
  muted: 'Notifications off: accepted, never shown (the provider cannot tell)',
  uninstalled: 'App uninstalled: the provider says the token is gone, the device is removed',
  invalid: 'Invalid token: rejected as malformed or replaced, the device is removed',
  'rate-limited': 'Rate limited: too many notifications to this device, try again later',
};
export const PAYLOAD_LIMIT = 4096; // APNs, FCM and Expo all reject larger payloads

// Approximate visible lengths, for preview warnings only (real limits depend on device width).
const VISIBLE = {
  ios: { title: 36, body: 150, label: 'an iPhone notification' },
  android: { title: 40, body: 46, label: 'a collapsed Android notification' },
  web: { title: 45, body: 90, label: 'a desktop browser notification' },
};
const SECRET_KEY = /pass(word)?|secret|token|api[-_]?key|^otp$|^ssn$|card[-_]?number/i;

const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
const compact = (obj) => Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined && v !== null));

/** Validate and normalize what the app passed to send(). Throws a 422 for unusable input. */
export function normalizeMessage(input = {}) {
  const errors = {};
  const str = (key, max) => {
    const v = input[key];
    if (v === undefined || v === null || v === '') return undefined;
    if (typeof v !== 'string') errors[key] = 'Must be a string';
    else if (v.length > max) errors[key] = `At most ${max} characters`;
    return typeof v === 'string' ? v : undefined;
  };
  const message = {
    title: str('title', 250),
    subtitle: str('subtitle', 250),
    body: str('body', 2000),
    image: str('image', 2048),
    icon: str('icon', 2048),
    url: str('url', 2048),
    sound: input.sound === false ? null : str('sound', 100) ?? (input.silent ? undefined : 'default'),
    channel: str('channel', 100),
    category: str('category', 100),
    group: str('group', 100),
    collapseId: str('collapseId', 64),
    badge: input.badge,
    data: input.data,
    priority: input.priority ?? 'high',
    ttl: input.ttl,
    silent: Boolean(input.silent),
  };
  if (message.badge !== undefined && !(Number.isInteger(message.badge) && message.badge >= 0)) errors.badge = 'Must be a whole number, 0 or more';
  if (message.data !== undefined && (typeof message.data !== 'object' || message.data === null || Array.isArray(message.data))) errors.data = 'Must be an object';
  if (!['high', 'normal'].includes(message.priority)) errors.priority = 'Must be "high" or "normal"';
  if (message.ttl !== undefined && !(Number.isInteger(message.ttl) && message.ttl >= 0)) errors.ttl = 'Must be a number of seconds';
  if (!message.silent && !message.title && !message.body) errors.title = 'A notification needs a title or a body (or silent: true with data)';
  if (message.silent && !message.data) errors.data = 'A silent notification needs data';
  if (Object.keys(errors).length) throw validationError(errors);
  return compact(message);
}

/** The payload each provider would receive for one device. Used for previews, sizes and by transports. */
export function providerPayloads(message, token = '<device token>') {
  const data = message.data ?? {};
  const stringData = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)]));
  if (message.url) stringData.url ??= message.url;

  const aps = compact({
    alert: message.silent ? undefined : compact({ title: message.title, subtitle: message.subtitle, body: message.body }),
    badge: message.badge,
    sound: message.silent ? undefined : message.sound,
    'thread-id': message.group,
    category: message.category,
    'mutable-content': message.image ? 1 : undefined,
    'content-available': message.silent ? 1 : undefined,
  });
  const apns = { aps, ...data, ...(message.url ? { url: message.url } : {}) };

  const fcm = {
    message: compact({
      token,
      notification: message.silent ? undefined : compact({ title: message.title, body: message.body, image: message.image }),
      data: Object.keys(stringData).length ? stringData : undefined,
      android: compact({
        priority: message.priority === 'high' ? 'HIGH' : 'NORMAL',
        ttl: message.ttl !== undefined ? `${message.ttl}s` : undefined,
        collapse_key: message.collapseId,
        notification: message.silent ? undefined : compact({ channel_id: message.channel, sound: message.sound ?? undefined, tag: message.collapseId, icon: message.icon }),
      }),
      apns: { headers: compact({ 'apns-push-type': message.silent ? 'background' : 'alert', 'apns-priority': message.silent ? '5' : message.priority === 'high' ? '10' : '5', 'apns-collapse-id': message.collapseId }), payload: { aps } },
      webpush: message.url ? { fcm_options: { link: message.url } } : undefined,
    }),
  };

  const expo = compact({
    to: token,
    title: message.title,
    subtitle: message.subtitle,
    body: message.body,
    data: Object.keys(data).length || message.url ? { ...data, ...(message.url ? { url: message.url } : {}) } : undefined,
    sound: message.sound ?? undefined,
    badge: message.badge,
    channelId: message.channel,
    categoryId: message.category,
    priority: message.priority === 'high' ? 'high' : 'normal',
    ttl: message.ttl,
    threadId: message.group,
    collapseId: message.collapseId,
    tag: message.collapseId, // Android: also replace a notification already on screen
    richContent: message.image ? { image: message.image } : undefined,
    mutableContent: message.image ? true : undefined, // iOS shows images through a notification service extension
    contentAvailable: message.silent || undefined,
  });

  const web = compact({
    title: message.title ?? '',
    body: message.body,
    icon: message.icon,
    image: message.image,
    tag: message.collapseId,
    data: { ...data, ...(message.url ? { url: message.url } : {}) },
    silent: message.silent || undefined,
  });

  const sized = (payload) => ({ payload, bytes: bytes(payload), limit: PAYLOAD_LIMIT });
  return { apns: sized(apns), fcm: sized(fcm), expo: sized(expo), web: sized(web) };
}

/** Problems a developer should know about before shipping this notification. */
export function messageWarnings(message, payloads, devices) {
  const warnings = [];
  const add = (level, id, text) => warnings.push({ level, id, text });
  for (const [provider, p] of Object.entries(payloads)) {
    if (p.bytes > p.limit) add('error', `size-${provider}`, `The ${provider.toUpperCase()} payload is ${p.bytes} bytes; the limit is ${p.limit}. The provider will reject it.`);
  }
  const platforms = new Set(devices.map((d) => d.platform));
  if (!platforms.size) for (const p of PLATFORMS) platforms.add(p);
  if (!message.silent) {
    for (const platform of platforms) {
      const v = VISIBLE[platform];
      if (message.title && message.title.length > v.title) add('info', `title-${platform}`, `The title is cut after about ${v.title} characters in ${v.label}.`);
      if (message.body && message.body.length > v.body) add('info', `body-${platform}`, `The body is cut after about ${v.body} characters in ${v.label}.`);
    }
    if (!message.title) add('info', 'no-title', 'No title: iOS shows the app name instead, Android and browsers show only the body.');
  }
  for (const [key, value] of Object.entries(message.data ?? {})) {
    if (SECRET_KEY.test(key)) add('warn', `data-${key}`, `data.${key} looks sensitive. Push payloads pass through Apple, Google and browser vendor servers; send an id and fetch the details from your API instead.`);
    if (typeof value !== 'string' && devices.some((d) => d.platform === 'android')) add('info', `data-type-${key}`, `data.${key} is not a string. FCM only carries strings in data, so it is sent as JSON text.`);
  }
  if (message.image && !/^https:\/\//.test(message.image)) add('warn', 'image-https', 'Images must be https URLs that phones can download.');
  return warnings;
}

export const maskToken = (token) => (token.length > 12 ? `${token.slice(0, 6)}…${token.slice(-6)}` : '••••');

/** calm_devices: the push tokens your apps register for each signed-in user. */
export function compileDeviceModel(mongoose) {
  const { Schema } = mongoose;
  const schema = new Schema(
    {
      user: { type: Schema.Types.ObjectId, ref: 'user', required: true, index: true },
      token: { type: String, required: true, unique: true, maxlength: 4096 },
      platform: { type: String, enum: PLATFORMS, required: true },
      name: { type: String, maxlength: 100 },
      appVersion: { type: String, maxlength: 50 },
      locale: { type: String, maxlength: 20 },
      simulated: { type: Boolean, default: false },
      behavior: { type: String, enum: Object.keys(BEHAVIORS), default: 'deliver' }, // simulated devices only
      // The session that registered the device. When it ends (sign out, password reset,
      // revoked session), the device stops getting notifications.
      session: { type: Schema.Types.ObjectId, index: true },
      lastSeenAt: Date,
    },
    { collection: 'calm_devices', timestamps: true, versionKey: false },
  );
  return mongoose.model('calmDevice', schema);
}

export function createPush({ log, mode, events }) {
  // Several transports can be active (push-expo next to push-fcm). Each device goes to the
  // first transport whose accepts(device) says yes, otherwise to one without accepts().
  let transports = [];
  let Device = null;
  let Session = null;
  const observers = [];
  const notify = (record, event) => {
    for (const fn of observers) {
      try {
        fn(record, event);
      } catch (err) {
        log.warn('A push observer failed', { err });
      }
    }
  };
  // Recent records, so a receipt that arrives later (push-expo) lands in the right delivery log.
  const recent = new Map();
  const remember = (record) => {
    if (!observers.length) return;
    recent.set(record.id, record);
    if (recent.size > 200) recent.delete(recent.keys().next().value);
  };
  const route = (device) => transports.find((t) => typeof t.accepts === 'function' && t.accepts(device)) ?? transports.find((t) => typeof t.accepts !== 'function') ?? null;

  const toDevice = (d) => ({ id: String(d._id), user: String(d.user), token: d.token, platform: d.platform, name: d.name, simulated: Boolean(d.simulated), behavior: d.behavior ?? 'deliver', session: d.session ? String(d.session) : null });

  /** Devices whose registering session has ended are removed and left out. */
  async function dropEndedSessions(devices) {
    const ids = [...new Set(devices.map((d) => d.session).filter(Boolean))];
    if (!ids.length || !Session) return { devices, dropped: [] };
    const alive = new Set((await Session.find({ _id: { $in: ids }, expiresAt: { $gt: new Date() } }).select('_id').lean()).map((x) => String(x._id)));
    const dropped = devices.filter((d) => d.session && !alive.has(d.session));
    if (dropped.length && Device) await Device.deleteMany({ _id: { $in: dropped.map((d) => d.id) } });
    return { devices: devices.filter((d) => !dropped.includes(d)), dropped };
  }

  async function resolveDevices(input) {
    const devices = [];
    if (input.to !== undefined && input.to !== null) {
      const ids = [input.to].flat().map(String);
      if (!Device) throw new Error('push.send({ to }) needs a user resource and auth; send to { tokens } instead');
      const found = await Device.find({ user: { $in: ids.filter((id) => /^[a-f\d]{24}$/i.test(id)) } }).lean();
      devices.push(...found.map(toDevice));
    }
    if (input.deviceIds !== undefined) {
      if (!Device) throw new Error('push.send({ deviceIds }) needs a user resource and auth');
      const ids = [input.deviceIds].flat().map(String).filter((id) => /^[a-f\d]{24}$/i.test(id));
      const found = await Device.find({ _id: { $in: ids } }).lean();
      devices.push(...found.map(toDevice));
    }
    for (const token of [input.tokens ?? []].flat()) {
      if (typeof token !== 'string' || !token) continue;
      devices.push({ id: null, user: null, token, platform: PLATFORMS.includes(input.platform) ? input.platform : 'android', simulated: token.startsWith('sim_') });
    }
    return devices;
  }

  // ---- simulator: what a phone would do, for simulated devices (never in production) ----
  const later = (fn) => (mode === 'test' ? fn() : setTimeout(fn, 1200).unref?.());
  const inboxes = new Map(); // deviceId -> [{ pushId, message, state, receivedAt, shownAt, openedAt }]
  const note = (record, deviceId, level, text, extra = {}) => {
    record.log.push({ time: new Date(), device: deviceId, level, text, ...extra });
    notify(record, 'updated');
  };
  const simulator = {
    handle(record, d, i, entry, unregistered) {
      const behavior = BEHAVIORS[d.behavior] ? d.behavior : 'deliver';
      if (behavior === 'uninstalled') {
        entry(i, 'error', 'simulator: DeviceNotRegistered, the app was uninstalled (token no longer valid, device removed)', { transport: 'simulator' });
        if (d.id) unregistered.push(d.id);
        return;
      }
      if (behavior === 'invalid') {
        entry(i, 'error', 'simulator: InvalidRegistration, the token is malformed or was replaced by a new one (device removed)', { transport: 'simulator' });
        if (d.id) unregistered.push(d.id);
        return;
      }
      if (behavior === 'rate-limited') {
        entry(i, 'error', 'simulator: MessageRateExceeded, too many notifications to this device. Retry later with backoff.', { transport: 'simulator' });
        return;
      }
      const ticket = `sim_${randomBytes(5).toString('hex')}`;
      entry(i, 'info', `Accepted by simulator (${ticket}).`, { ok: true, providerId: ticket, transport: 'simulator' });
      if (!d.id) return;
      const item = { pushId: record.id, message: record.message, state: behavior === 'offline' ? 'waiting' : behavior === 'muted' ? 'hidden' : 'shown', receivedAt: new Date(), shownAt: null, openedAt: null };
      const list = inboxes.get(d.id) ?? [];
      list.unshift(item);
      if (list.length > 50) list.length = 50;
      inboxes.set(d.id, list);
      const name = d.name ?? 'the simulated device';
      later(() => {
        push.receipt(record.id, d.id, { ok: true, transport: 'simulator' });
        if (item.state === 'shown') {
          item.shownAt = new Date();
          note(record, d.id, 'info', `Shown on ${name}.`, { phone: true });
        } else if (item.state === 'hidden') {
          note(record, d.id, 'warn', `Not shown on ${name}: notifications are turned off for the app. Providers still report it as accepted.`, { phone: true });
        } else {
          note(record, d.id, 'info', `Waiting: ${name} is offline. It is shown when the device comes back online.`, { phone: true });
        }
        events?.emit('push.simulated', { id: record.id, device: d.id, state: item.state });
      });
    },
    /** The simulated lock screen of a device, newest first. */
    inbox: (deviceId) => inboxes.get(String(deviceId)) ?? [],
    clear: (deviceId) => inboxes.delete(String(deviceId)),
    /** Bring an offline device back: every waiting notification is shown. */
    online(deviceId, name = 'the simulated device') {
      const shown = [];
      for (const item of inboxes.get(String(deviceId)) ?? []) {
        if (item.state !== 'waiting') continue;
        item.state = 'shown';
        item.shownAt = new Date();
        shown.push(item);
        const record = recent.get(item.pushId);
        if (record) note(record, String(deviceId), 'info', `Shown on ${name} after it came back online (${Math.round((item.shownAt - item.receivedAt) / 1000)} s later).`, { phone: true });
      }
      return shown.length;
    },
    /**
     * Simulate a tap on a notification: emits push.opened, the event a real app reports with
     * POST /api/auth/devices/opened. `user` is the device owner.
     */
    open(deviceId, pushId, name = 'the simulated device', user = null) {
      const item = (inboxes.get(String(deviceId)) ?? []).find((x) => x.pushId === pushId);
      if (!item || item.state !== 'shown') return null;
      item.openedAt = new Date();
      const record = recent.get(pushId);
      if (record) note(record, String(deviceId), 'info', `Opened on ${name}${item.message.url ? `: the app opens ${item.message.url}` : ''}.`, { phone: true, opened: true });
      events?.emit('push.opened', { id: pushId, user: user ? String(user) : null, device: String(deviceId), url: item.message.url ?? null, data: item.message.data ?? null, simulated: true });
      return item;
    },
  };

  const push = {
    simulator,
    /**
     * Add a transport: { name, send(message, devices), accepts?(device) }. A transport with the
     * same name replaces the old one; use(null) removes them all.
     */
    use(t) {
      if (t === null || t === undefined) {
        transports = [];
        return;
      }
      transports = [...transports.filter((x) => x.name !== t.name), t];
    },
    /** Names of the active transports ('expo + fcm'), 'dev-capture' without one, null in production. */
    get transport() {
      if (transports.length) return transports.map((t) => t.name).join(' + ');
      return mode === 'production' ? null : 'dev-capture';
    },
    /** Which transport a device would go through: a transport name, 'simulated', 'dev-capture' or null. */
    routeFor(device) {
      if (device.simulated || String(device.token ?? '').startsWith('sim_')) return mode === 'production' ? null : 'simulator';
      if (!transports.length) return mode === 'production' ? null : 'dev-capture';
      return route(device)?.name ?? null;
    },
    /** Called by auth with the device and session models, so send({ to: userId }) can find devices. */
    useDevices(model, sessions = null) {
      Device = model;
      Session = sessions;
    },
    get devices() {
      return Device;
    },
    /** fn(record, 'created' | 'updated') for every notification. Devtools and tests use it. */
    observe(fn) {
      observers.push(fn);
    },

    /**
     * Send a notification. Resolves to { id, status, devices, results }.
     * Throws a 422 for invalid input; delivery problems are reported in the result and logs.
     */
    async send(input = {}) {
      const message = normalizeMessage(input);
      const { devices, dropped } = await dropEndedSessions(await resolveDevices(input));
      const payloads = providerPayloads(message, devices[0]?.token);
      const record = {
        id: `psh_${randomBytes(6).toString('hex')}`,
        createdAt: new Date(),
        requestId: currentRequest()?.id ?? null,
        to: {
          users: input.to !== undefined && input.to !== null ? [input.to].flat().map(String) : [],
          devices: [input.deviceIds ?? []].flat().length,
          tokens: [input.tokens ?? []].flat().length,
        },
        message,
        devices: devices.map(({ token, ...d }) => ({ ...d, token: maskToken(token), via: push.routeFor({ ...d, token }) })),
        payloads,
        warnings: messageWarnings(message, payloads, devices),
        status: 'pending',
        transport: push.transport,
        log: [],
      };
      const entry = (deviceIndex, level, text, extra = {}) =>
        record.log.push({ time: new Date(), device: deviceIndex === null ? null : record.devices[deviceIndex]?.id ?? deviceIndex, level, text, ...extra });

      for (const d of dropped) {
        record.log.push({ time: new Date(), device: d.id, level: 'warn', text: `${d.name ?? 'A device'} was skipped and removed: the session that registered it has ended (signed out).` });
      }
      if (!devices.length) {
        record.status = 'no-devices';
        entry(null, 'warn', record.to.users.length
          ? 'No registered devices for this user. Apps register them with POST /api/auth/devices; in devtools you can add a simulated device.'
          : record.to.devices ? 'None of the given devices exist.' : 'No device tokens given.');
      }
      remember(record);
      notify(record, 'created');

      // Group real devices by the transport that takes them; simulated ones go to the simulator.
      const groups = new Map(); // transport -> [[device, index]]
      const simulated = [];
      const unsendable = !transports.length && mode === 'production';
      for (const [i, d] of devices.entries()) {
        if (d.simulated) {
          if (mode === 'production') entry(i, 'info', 'Simulated device: skipped in production.');
          else simulated.push([d, i]);
          continue;
        }
        if (!transports.length) {
          if (unsendable) entry(i, 'error', 'Not sent: no push transport is configured.');
          else entry(i, 'info', 'Development: captured, not delivered.');
          continue;
        }
        const t = route(d);
        if (!t) {
          entry(i, 'error', `Not sent: none of the installed transports (${push.transport}) takes this token.${/^Expo(nent)?PushToken\[/.test(d.token) ? ' It is an Expo push token: add the push-expo block.' : ''}`);
          continue;
        }
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push([d, i]);
      }

      const results = new Array(devices.length).fill(null);
      const unregistered = [];
      await Promise.all(
        [...groups].map(async ([t, list]) => {
          let out;
          try {
            out = (await t.send(message, list.map(([d]) => d), { id: record.id })) ?? [];
          } catch (err) {
            out = list.map(() => ({ ok: false, error: err.message }));
          }
          list.forEach(([d, i], n) => {
            const r = out[n] ?? { ok: false, error: 'The transport returned no result' };
            results[i] = { transport: t.name, ...r };
            // "Accepted": the provider took it. Whether it reached the phone is the provider's job.
            if (r.ok) entry(i, 'info', `Accepted by ${t.name}${r.id ? ` (${r.id})` : ''}.`, { ok: true, providerId: r.id, transport: t.name });
            else entry(i, 'error', `${t.name}: ${r.error ?? 'failed'}${r.unregistered ? ' (token no longer valid, device removed)' : ''}`, { transport: t.name });
            if (r.unregistered && d.id) unregistered.push(d.id);
          });
        }),
      );
      for (const [d, i] of simulated) simulator.handle(record, d, i, entry, unregistered);
      if (unregistered.length && Device) await Device.deleteMany({ _id: { $in: unregistered } });
      if (unsendable && devices.some((d) => !d.simulated)) {
        log.error('Push not sent: no push transport configured. Add one with `calm add push-fcm` or `calm add push-expo`.', { title: message.title });
      }

      const failed = record.log.filter((l) => l.level === 'error').length;
      if (record.status !== 'no-devices') record.status = statusOf(record);
      if (record.status === 'captured' && mode !== 'production') {
        log.info(`Push "${message.title ?? message.body ?? '(silent)'}" to ${devices.length} device(s) (dev capture, open /_calm to see it)`);
      }
      if (failed) log.warn(`Push ${record.id}: ${failed} of ${devices.length} deliveries failed`, { id: record.id });
      notify(record, 'updated');
      events?.emit(`push.${record.status === 'failed' ? 'failed' : 'sent'}`, { id: record.id, status: record.status, devices: devices.length });
      return { id: record.id, status: record.status, devices: devices.length, results: results.filter(Boolean) };
    },

    /**
     * A later delivery report for one device (push-expo checks Expo receipts with it).
     * { ok, error?, unregistered?, transport? }. Unregistered devices are removed.
     */
    async receipt(pushId, deviceId, { ok, error, unregistered = false, transport = 'provider' } = {}) {
      if (unregistered && deviceId && Device) await Device.deleteOne({ _id: deviceId }).catch(() => {});
      const record = recent.get(pushId);
      if (record) {
        record.log.push({
          time: new Date(),
          device: deviceId,
          level: ok ? 'info' : 'error',
          text: ok ? `Receipt from ${transport}: handed to Apple or Google.` : `Receipt from ${transport}: ${error ?? 'failed'}${unregistered ? ' (token no longer valid, device removed)' : ''}`,
          receipt: true,
          transport,
        });
        if (record.status !== 'no-devices') record.status = statusOf(record);
        notify(record, 'updated');
      }
      events?.emit('push.receipt', { id: pushId, device: deviceId, ok: Boolean(ok), error: error ?? null, unregistered });
    },
  };
  return push;
}

/** A device failed if any entry about it is an error; it was sent if a provider accepted it. */
function statusOf(record) {
  const keys = record.devices.map((d, i) => d.id ?? i);
  let sent = 0;
  let failed = 0;
  for (const key of keys) {
    const entries = record.log.filter((l) => l.device === key);
    if (entries.some((l) => l.level === 'error')) failed += 1;
    else if (entries.some((l) => l.ok)) sent += 1;
  }
  if (failed && !sent) return 'failed';
  if (failed) return 'partial';
  return sent ? 'sent' : 'captured';
}
