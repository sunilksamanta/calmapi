# Notifications: inbox, push and email (notifications)

One call reaches people wherever they want to be reached. `ctx.notify()` writes an in-app inbox entry, sends a push to every device of the user and an email, following each user's preferences and quiet hours. Notification types are small files you can read in one glance, and the settings screen of your app can be built from what the API returns.

```bash
npx calm add notifications
```

| Adds | |
|---|---|
| Files | `app/blocks/notifications/index.js`, `app/resources/notification/notification.resource.js`, `app/resources/notification/notification.routes.js`, `app/notifications/welcome.js` |
| Environment | none |

Push uses [`app.push`](/push-notifications) and email uses `app.mailer`, so in development everything lands in devtools: the inbox in **Data**, pushes in **Push** (on a simulated phone if you add one), emails in **Mail**.

## Send one

```js
// app/resources/order/order.routes.js
r.post('/:id/ship', { policy: 'admin' }, async (ctx) => {
  const order = await ctx.service.update(ctx.params.id, { status: 'shipped' }, ctx);
  await ctx.notify(order.customer, 'order-shipped', { number: order.number });
  return order;
});
```

`ctx.notify(to, type, data)` takes a user id, a user or an array of them. Outside a request (jobs, event listeners) use `app.ext.notify(...)`. For a one-off message without a type: `ctx.notify(userId, { title, body, url, channels: ['inbox'] })`.

It resolves to what happened, per user:

```json
{ "id": "6650...", "type": "order-shipped", "channels": { "inbox": true, "push": "sent", "email": "sent" }, "quietHours": false }
```

## Types

A type is a file in `app/notifications/`, named after the type:

```js
// app/notifications/order-shipped.js
export default {
  title: ({ number }) => `Order #${number} shipped`,
  body: 'It arrives Thursday.',
  url: ({ number }) => `/orders/${number}`,
  category: 'orders',                  // people can turn a whole category off
  channels: ['inbox', 'push', 'email'], // where it goes by default
  // required: true,                   // security notices: preferences cannot turn it off
  // email: { subject, text, html },   // when the email should say more than the push
  // collapseId: ({ number }) => `order-${number}`, // a newer one replaces the older on the phone
};
```

Every field can be a value or a function of the data you pass. `calm doctor` warns about types without a title or with an unknown channel.

## The inbox

Notifications are a regular resource (`app/resources/notification/`), so they follow the same rules as everything else: each user lists, reads, marks and deletes only their own, nobody creates them through the API, and they expire after 180 days (edit the index to change it).

| Endpoint | |
|---|---|
| `GET /api/notifications` | Newest first. `?readAt[exists]=false` for unread only, `?type=order-shipped` to filter |
| `GET /api/notifications/unread-count` | `{ count }` for the bell icon |
| `POST /api/notifications/:id/read` | Mark one read |
| `POST /api/notifications/read-all` | `{ marked }` |
| `DELETE /api/notifications/:id` | Remove one |

With the [realtime-sse](/blocks/realtime-sse) block, new notifications reach open browser tabs immediately. The iPhone badge shows the unread count, and when someone opens a push, the matching inbox entry is marked read (`push.opened`).

## Preferences

```bash
curl http://localhost:5001/api/notifications/preferences -H "Authorization: Bearer $TOKEN"
```

```json
{
  "channels": {},
  "quietHours": null,
  "types": [
    { "type": "order-shipped", "category": "orders", "channels": ["inbox", "push", "email"], "required": false },
    { "type": "welcome", "category": "account", "channels": ["inbox", "push"], "required": false }
  ]
}
```

`types` lists everything a user can receive, so your settings screen needs no list of its own. Turn channels off per type or per category, and set quiet hours in the user's time zone (no push during them; the inbox and email still get it):

```bash
curl -X PATCH http://localhost:5001/api/notifications/preferences \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{ "channels": { "orders": { "email": false } }, "quietHours": { "start": "22:00", "end": "07:00", "timeZone": "Europe/Berlin" } }'
```

Types marked `required: true` ignore preferences and quiet hours.

## Settings

```js
// calm.config.js
export default defineConfig({
  blocks: { notifications: { defaultChannels: ['inbox'], badge: true } },
});
```

`notification.sent` is emitted for every user notified, with the channels it went to.
