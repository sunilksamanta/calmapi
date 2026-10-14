# Slack notifications (slack)

Posts to Slack when things happen in your app: a signup, an order, a failed payment, and security alerts (failed sign-ins, locked accounts, rate limits). Works with an [incoming webhook](https://api.slack.com/messaging/webhooks) or a bot token and [chat.postMessage](https://api.slack.com/methods/chat.postMessage). Messages are sent in the background, retried with backoff (a 429 waits for `Retry-After`), user data is escaped so nobody can ping `@channel` through their display name, and bursts of security events become one digest. No dependencies.

```bash
npx calm add slack
```

| Adds | |
| --- | --- |
| Files | `app/blocks/slack/index.js` |
| Environment | `SLACK_WEBHOOK_URL`, or `SLACK_BOT_TOKEN` and `SLACK_CHANNEL` |

## Setup in Slack

Incoming webhook (simplest, one channel):

1. https://api.slack.com/apps, Create New App, From scratch, pick your workspace.
2. Incoming Webhooks: turn on, Add New Webhook to Workspace, choose the channel.
3. `.env`: `SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...`

Bot token (several channels, `channel` per message):

1. Same app, OAuth & Permissions, Bot Token Scopes: add `chat:write`. Install to workspace.
2. Invite the bot to the channel (`/invite @your-app`), copy the channel ID (channel details, bottom).
3. `.env`: `SLACK_BOT_TOKEN=...` and `SLACK_CHANNEL=C0123456789`.

Without either, messages are only logged (`Slack (not configured): ...`); `calm doctor` reports it in production.

## Events to messages

```js
// calm.config.js
export default defineConfig({
  blocks: {
    slack: {
      events: {
        'auth.registered': 'New signup: {user.name}', // the default
        'order.created': 'New order {doc.number}: {doc.total} EUR',
        'payment.failed': (payload, name, { escape }) => ({
          text: `Payment failed for order ${escape(payload.orderId)}`,
          blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `:x: *Payment failed* for order ${escape(payload.orderId)}` } }],
        }),
      },
    },
  },
});
```

Placeholders read the event payload with dot paths (`{doc.title}`, `{user.email}`); a missing value renders empty. Resource events carry `{ doc, user }`, `auth.registered` carries `{ user }`. A function returns text, `{ text, blocks }` or `null` to skip. Set an event to `false` to remove a default (`'auth.registered': false`).

## Escaping

Slack treats `<!channel>`, `<!here>`, `<@U123>` and `<https://link|label>` as mentions and links. Every value a template inserts is escaped (`&` `<` `>` become `&amp;` `&lt;` `&gt;`), so a user named `<!channel>` shows as text and pings nobody. The template itself is yours and is used as written: `'<!here> new enterprise signup: {user.name}'` pings on purpose. Functions must escape what they insert; `escape` and `render` are passed as the third argument and exported from the block. Messages are also sent with `link_names: false` and `parse: 'none'`.

## Security alerts

`security.*` events (from the core and blocks: `login_failed`, `account_locked`, `rate_limited`, `invalid_reset_token`, `phone_code_failed`...) are posted as alerts. `security.forbidden` and `security.invalid_token` are ignored by default (every day noise). During an attack, the first `maxPerWindow` alerts of a window are posted one by one, and the rest becomes a single digest at the end of the window:

> :rotating_light: Security digest: 482 more events in 60s from 37 IPs: security.login_failed x470, security.account_locked x12

```js
blocks: { slack: { security: { enabled: true, events: ['security.*'], ignore: ['security.forbidden', 'security.invalid_token'], window: '1m', maxPerWindow: 3, prefix: ':rotating_light:' } } }
```

## Sending from code

```js
await ctx.app.ext.slack.send('Deploy finished'); // waits for Slack, throws a SlackError
await ctx.app.ext.slack.send({ text: 'Fallback text', blocks: [...], channel: 'C0OTHER' }); // channel: bot token mode
ctx.app.ext.slack.post('Nightly export done'); // background, never throws
```

## Options

| Option | Default | |
| --- | --- | --- |
| `events` | `{ 'auth.registered': 'New signup: {user.name}' }` | event to template or function |
| `security` | see above | alerts and digest |
| `retries` | `3` | after the first attempt |
| `backoff` | `['1s', '5s', '30s']` | waits between attempts (429 uses `Retry-After`) |
| `maxRetryAfter` | `'2m'` | a longer `Retry-After` gives up |
| `channel` | `SLACK_CHANNEL` | bot token mode |
| `timeoutMs` | `10000` | per request |
| `apiBase` | `https://slack.com/api` | tests and proxies |

Permanent errors (HTTP 400/401/403/404/410, `invalid_auth`, `channel_not_found`, `not_in_channel`...) are not retried.

## Security notes

- A webhook URL and a bot token are credentials: `.env` only, never in git, logs or calm.config.js.
- A Slack channel is not access controlled like your API. Think twice before putting emails, IPs or amounts in messages; core security events already mask emails.
- `calm doctor` warns in production when `SLACK_WEBHOOK_URL` is not a `hooks.slack.com` URL.
