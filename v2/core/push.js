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
        collapse_key: message.group,
        notification: message.silent ? undefined : compact({ channel_id: message.channel, sound: message.sound ?? undefined, tag: message.group, icon: message.icon }),
      }),
      apns: { headers: compact({ 'apns-push-type': message.silent ? 'background' : 'alert', 'apns-priority': message.silent ? '5' : message.priority === 'high' ? '10' : '5' }), payload: { aps } },
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
    mutableContent: message.image ? true : undefined,
    _contentAvailable: message.silent || undefined,
  });

  const web = compact({
    title: message.title ?? '',
    body: message.body,
    icon: message.icon,
    image: message.image,
    tag: message.group,
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
      lastSeenAt: Date,
    },
    { collection: 'calm_devices', timestamps: true, versionKey: false },
  );
  return mongoose.model('calmDevice', schema);
}

export function createPush({ log, mode, events }) {
  let transport = null;
  let Device = null;
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

  async function resolveDevices(input) {
    const devices = [];
    if (input.to !== undefined && input.to !== null) {
      const ids = [input.to].flat().map(String);
      if (!Device) throw new Error('push.send({ to }) needs a user resource and auth; send to { tokens } instead');
      const found = await Device.find({ user: { $in: ids.filter((id) => /^[a-f\d]{24}$/i.test(id)) } }).lean();
      devices.push(...found.map((d) => ({ id: String(d._id), user: String(d.user), token: d.token, platform: d.platform, name: d.name, simulated: d.simulated })));
    }
    if (input.deviceIds !== undefined) {
      if (!Device) throw new Error('push.send({ deviceIds }) needs a user resource and auth');
      const ids = [input.deviceIds].flat().map(String).filter((id) => /^[a-f\d]{24}$/i.test(id));
      const found = await Device.find({ _id: { $in: ids } }).lean();
      devices.push(...found.map((d) => ({ id: String(d._id), user: String(d.user), token: d.token, platform: d.platform, name: d.name, simulated: d.simulated })));
    }
    for (const token of [input.tokens ?? []].flat()) {
      if (typeof token !== 'string' || !token) continue;
      devices.push({ id: null, user: null, token, platform: PLATFORMS.includes(input.platform) ? input.platform : 'android', simulated: token.startsWith('sim_') });
    }
    return devices;
  }

  const push = {
    use(t) {
      transport = t;
    },
    get transport() {
      return transport?.name ?? (mode === 'production' ? null : 'dev-capture');
    },
    /** Called by auth with the device model, so send({ to: userId }) can find devices. */
    useDevices(model) {
      Device = model;
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
      const devices = await resolveDevices(input);
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
        devices: devices.map(({ token, ...d }) => ({ ...d, token: maskToken(token) })),
        payloads,
        warnings: messageWarnings(message, payloads, devices),
        status: 'pending',
        transport: push.transport,
        log: [],
      };
      const entry = (deviceIndex, level, text, extra = {}) =>
        record.log.push({ time: new Date(), device: deviceIndex === null ? null : record.devices[deviceIndex]?.id ?? deviceIndex, level, text, ...extra });

      if (!devices.length) {
        record.status = 'no-devices';
        entry(null, 'warn', record.to.users.length
          ? 'No registered devices for this user. Apps register them with POST /api/auth/devices; in devtools you can add a simulated device.'
          : record.to.devices ? 'None of the given devices exist.' : 'No device tokens given.');
      }
      notify(record, 'created');

      const real = transport ? devices.map((d, i) => [d, i]).filter(([d]) => !d.simulated) : [];
      const unsendable = !transport && mode === 'production';
      for (const [i, d] of devices.entries()) {
        if (d.simulated) entry(i, 'info', 'Simulated device: captured, not delivered.');
        else if (unsendable) entry(i, 'error', 'Not sent: no push transport is configured.');
        else if (!transport) entry(i, 'info', 'Development: captured, not delivered.');
      }

      let results = [];
      if (real.length) {
        try {
          results = (await transport.send(message, real.map(([d]) => d))) ?? [];
        } catch (err) {
          results = real.map(() => ({ ok: false, error: err.message }));
        }
        const unregistered = [];
        real.forEach(([d, i], n) => {
          const r = results[n] ?? { ok: false, error: 'The transport returned no result' };
          if (r.ok) entry(i, 'info', `Delivered to ${transport.name}${r.id ? ` (${r.id})` : ''}.`, { providerId: r.id });
          else entry(i, 'error', `${transport.name}: ${r.error ?? 'failed'}${r.unregistered ? ' (token no longer valid, device removed)' : ''}`);
          if (r.unregistered && d.id) unregistered.push(d.id);
        });
        if (unregistered.length && Device) await Device.deleteMany({ _id: { $in: unregistered } });
      } else if (unsendable && devices.some((d) => !d.simulated)) {
        log.error('Push not sent: no push transport configured. Add one with `calm add push-fcm` or `calm add push-expo`.', { title: message.title });
      }

      const failed = record.log.filter((l) => l.level === 'error').length;
      const delivered = record.log.filter((l) => l.providerId !== undefined || /^Delivered/.test(l.text)).length;
      if (record.status !== 'no-devices') {
        record.status = failed && !delivered ? 'failed' : !real.length ? 'captured' : failed === 0 ? 'sent' : 'partial';
      }
      if (record.status === 'captured' && mode !== 'production') {
        log.info(`Push "${message.title ?? message.body ?? '(silent)'}" to ${devices.length} device(s) (dev capture, open /_calm to see it)`);
      }
      if (failed) log.warn(`Push ${record.id}: ${failed} of ${real.length} deliveries failed`, { id: record.id });
      notify(record, 'updated');
      events?.emit(`push.${record.status === 'failed' ? 'failed' : 'sent'}`, { id: record.id, status: record.status, devices: devices.length });
      return { id: record.id, status: record.status, devices: devices.length, results };
    },
  };
  return push;
}
