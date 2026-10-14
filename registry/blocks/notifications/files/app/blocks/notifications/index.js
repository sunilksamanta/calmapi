import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePlugin, validationError } from '#calm';

// One call, every channel:
//   await ctx.notify(userId, 'order-shipped', { order })     a type from app/notifications/
//   await ctx.notify(userId, { title, body, url })            or an ad hoc message
// writes the in-app inbox (the notification resource), sends a push (app.push) and an email
// (app.mailer), following each user's preferences and quiet hours.
const CHANNELS = ['inbox', 'push', 'email'];
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** Types from app/notifications/<type>.js, by file name. */
async function loadTypes(root) {
  const dir = join(root, 'app', 'notifications');
  const types = {};
  if (!existsSync(dir)) return types;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    types[file.slice(0, -3)] = mod.default ?? {};
  }
  return types;
}

const render = (value, vars) => (typeof value === 'function' ? value(vars) : value);

/** Minutes since midnight in a time zone (people set quiet hours in their own time). */
function localMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  return get('hour') * 60 + get('minute');
}
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
function inQuietHours(quiet, now = new Date()) {
  if (!quiet?.start || !quiet?.end) return false;
  const m = localMinutes(now, quiet.timeZone || 'UTC');
  const [s, e] = [toMinutes(quiet.start), toMinutes(quiet.end)];
  return s <= e ? m >= s && m < e : m >= s || m < e; // 22:00 to 07:00 wraps midnight
}

export default definePlugin({
  name: 'notifications',
  options: {
    // Channels for ad hoc messages and types that do not list theirs.
    defaultChannels: ['inbox', 'push'],
    // The iPhone badge shows the number of unread notifications.
    badge: true,
  },
  async setup(calm, options) {
    const types = await loadTypes(calm.app.root);
    const { Schema } = calm.mongoose;
    const Prefs = calm.mongoose.model(
      'calmNotificationPrefs',
      new Schema(
        {
          user: { type: Schema.Types.ObjectId, required: true, unique: true },
          channels: { type: Schema.Types.Mixed, default: {} }, // { '<type or category>': { push: false } }
          quietHours: { start: String, end: String, timeZone: String },
        },
        { collection: 'calm_notification_prefs', versionKey: false, timestamps: true, minimize: false },
      ),
    );
    const inbox = () => calm.app.registry.get('notification');
    const userModel = () => calm.app.model('user');

    function channelsFor(type, template, prefs) {
      const wanted = (template.channels ?? options.defaultChannels).filter((c) => CHANNELS.includes(c));
      if (template.required) return wanted;
      const byType = prefs?.channels?.[type] ?? {};
      const byCategory = template.category ? (prefs?.channels?.[template.category] ?? {}) : {};
      return wanted.filter((c) => (byType[c] ?? byCategory[c]) !== false);
    }

    async function notifyOne(userId, type, template, vars) {
      const user = await userModel().findById(userId).select('email name status').lean();
      if (!user || user.status === 'disabled') return { user: String(userId), skipped: 'no such user' };
      const prefs = await Prefs.findOne({ user: user._id }).lean();
      let channels = channelsFor(type, template, prefs);
      const quiet = !template.required && inQuietHours(prefs?.quietHours);
      if (quiet) channels = channels.filter((c) => c !== 'push');

      const message = {
        title: render(template.title, vars),
        body: render(template.body, vars),
        url: render(template.url, vars),
        data: render(template.data, vars) ?? undefined,
      };
      if (!message.title && !message.body) throw new Error(`Notification "${type}" needs a title or a body`);
      const result = { user: String(user._id), type, channels: {}, quietHours: quiet };

      let doc = null;
      if (channels.includes('inbox')) {
        const entry = inbox();
        if (!entry) throw new Error('The notification resource is missing (app/resources/notification). Add the block again with calm add notifications.');
        doc = await entry.service.create(
          { user: user._id, type, category: template.category, ...message, channels },
          { system: true },
        );
        result.id = String(doc._id);
        result.channels.inbox = true;
      }
      if (channels.includes('push')) {
        const badge = options.badge && doc ? await inbox().model.countDocuments({ user: user._id, readAt: null }) : undefined;
        try {
          const sent = await calm.push.send({
            to: String(user._id),
            title: message.title,
            body: message.body,
            url: message.url,
            badge,
            collapseId: render(template.collapseId, vars),
            channel: render(template.androidChannel, vars),
            data: { ...(message.data ?? {}), type, ...(doc ? { notificationId: String(doc._id) } : {}) },
          });
          result.channels.push = sent.status;
        } catch (err) {
          result.channels.push = 'failed';
          calm.log.warn(`notifications: push for "${type}" failed: ${err.message}`);
        }
      }
      if (channels.includes('email') && user.email) {
        const link = message.url ? new URL(message.url, calm.config.app.url).href : null;
        try {
          await calm.mailer.send({
            to: user.email,
            subject: render(template.email?.subject, vars) ?? message.title ?? calm.config.app.name,
            text: render(template.email?.text, vars) ?? [message.body, link].filter(Boolean).join('\n\n'),
            html: render(template.email?.html, vars),
            meta: { kind: 'notification', type, notificationId: result.id },
          });
          result.channels.email = 'sent';
        } catch (err) {
          result.channels.email = 'failed';
          calm.log.warn(`notifications: email for "${type}" failed: ${err.message}`);
        }
      }
      calm.events.emit('notification.sent', result);
      return result;
    }

    /**
     * notify(to, type, vars) or notify(to, { title, body, url, data, channels }).
     * `to` is a user id, a user, or an array of them. Resolves to one result per user.
     */
    async function notify(to, typeOrMessage, vars = {}) {
      let type;
      let template;
      if (typeof typeOrMessage === 'string') {
        type = typeOrMessage;
        template = types[type];
        if (!template) throw new Error(`Unknown notification type "${type}". Create app/notifications/${type}.js (known: ${Object.keys(types).join(', ') || 'none'})`);
      } else {
        type = typeOrMessage?.type ?? 'message';
        template = typeOrMessage ?? {};
      }
      const ids = [to].flat().map((u) => String(u?._id ?? u?.id ?? u));
      const results = [];
      for (const id of ids) results.push(await notifyOne(id, type, template, vars));
      return Array.isArray(to) ? results : results[0];
    }

    calm.provide('notify', notify);
    calm.guard((ctx) => {
      ctx.notify = notify;
    });

    // Opening a push (reported by the app with POST /api/auth/devices/opened, or a tap on a
    // simulated phone in devtools) marks the inbox entry as read, so the unread count stays
    // honest across devices. The data comes from the client: only the user's own entries.
    calm.on('push.opened', async ({ data, user }) => {
      if (!data?.notificationId || !user || !inbox()) return;
      await inbox().model.updateOne({ _id: data.notificationId, user, readAt: null }, { $set: { readAt: new Date() } }).catch(() => {});
    });

    // ---- preferences --------------------------------------------------------------------
    const catalog = () =>
      Object.entries(types).map(([type, t]) => ({
        type,
        category: t.category ?? null,
        description: t.description ?? null,
        channels: (t.channels ?? options.defaultChannels).filter((c) => CHANNELS.includes(c)),
        required: Boolean(t.required),
      }));

    calm.routes((r) => {
      r.get('/notifications/preferences', { policy: 'authenticated', summary: 'Your notification settings, with every type you can receive', tags: ['notifications'] }, async (ctx) => {
        const prefs = await Prefs.findOne({ user: ctx.user._id }).lean();
        return { channels: prefs?.channels ?? {}, quietHours: prefs?.quietHours?.start ? prefs.quietHours : null, types: catalog() };
      });
      r.patch('/notifications/preferences', { policy: 'authenticated', summary: 'Turn channels on or off per type or category, set quiet hours', tags: ['notifications'] }, async (ctx) => {
        const body = ctx.req.body ?? {};
        const errors = {};
        const known = new Set([...Object.keys(types), ...Object.values(types).map((t) => t.category).filter(Boolean), 'message']);
        const $set = {};
        if (body.channels !== undefined) {
          if (!body.channels || typeof body.channels !== 'object' || Array.isArray(body.channels)) errors.channels = 'Must be an object: { "<type or category>": { "push": false } }';
          else {
            for (const [key, value] of Object.entries(body.channels)) {
              if (!known.has(key)) errors[`channels.${key}`] = `Unknown type or category (known: ${[...known].join(', ')})`;
              else if (!value || typeof value !== 'object') errors[`channels.${key}`] = 'Must be an object of channel: true|false';
              else
                for (const [ch, on] of Object.entries(value)) {
                  if (!CHANNELS.includes(ch)) errors[`channels.${key}.${ch}`] = `Channels are ${CHANNELS.join(', ')}`;
                  else if (typeof on !== 'boolean') errors[`channels.${key}.${ch}`] = 'Must be true or false';
                  else $set[`channels.${key}.${ch}`] = on;
                }
            }
          }
        }
        if (body.quietHours !== undefined) {
          const q = body.quietHours;
          if (q === null) $set.quietHours = {};
          else if (!TIME.test(q?.start ?? '') || !TIME.test(q?.end ?? '')) errors.quietHours = 'Use { "start": "22:00", "end": "07:00", "timeZone": "Europe/Berlin" }';
          else {
            try {
              new Intl.DateTimeFormat('en', { timeZone: q.timeZone || 'UTC' });
              $set.quietHours = { start: q.start, end: q.end, timeZone: q.timeZone || 'UTC' };
            } catch {
              errors['quietHours.timeZone'] = 'Unknown time zone (use an IANA name such as Europe/Berlin)';
            }
          }
        }
        if (Object.keys(errors).length) throw validationError(errors);
        const prefs = Object.keys($set).length
          ? await Prefs.findOneAndUpdate({ user: ctx.user._id }, { $set }, { upsert: true, returnDocument: 'after' }).lean()
          : await Prefs.findOne({ user: ctx.user._id }).lean();
        return { channels: prefs?.channels ?? {}, quietHours: prefs?.quietHours?.start ? prefs.quietHours : null, types: catalog() };
      });
    });

    calm.doctor(() => {
      const out = [];
      if (!inbox()) out.push({ level: 'error', id: 'notifications-resource', title: 'The notification resource is missing', detail: 'ctx.notify() writes the inbox to app/resources/notification. Run calm add notifications again.' });
      for (const [type, t] of Object.entries(types)) {
        if (!t.title && !t.body) out.push({ level: 'warn', id: `notification-type-${type}`, title: `app/notifications/${type}.js has no title or body` });
        for (const c of t.channels ?? []) if (!CHANNELS.includes(c)) out.push({ level: 'warn', id: `notification-channel-${type}-${c}`, title: `app/notifications/${type}.js: unknown channel "${c}" (${CHANNELS.join(', ')})` });
      }
      return out;
    });

    calm.devtools.panel('notifications', async () => ({
      types: catalog().map((t) => ({ ...t, channels: t.channels.join(', ') })),
      recent: inbox()
        ? (await inbox().model.find().sort({ createdAt: -1 }).limit(20).lean()).map((n) => ({ type: n.type, title: n.title, user: String(n.user), channels: (n.channels ?? []).join(', '), read: Boolean(n.readAt), at: n.createdAt }))
        : [],
    }));
  },
});
