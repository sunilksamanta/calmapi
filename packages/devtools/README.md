<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://docs.calmapi.dev/brand/calmapi-logo-light.svg">
  <img src="https://docs.calmapi.dev/brand/calmapi-logo.svg" alt="Calm API" height="44">
</picture>

# @calmapi/devtools

The browser UI for CalmAPI devtools: a local dashboard for your CalmAPI 2 app, served at
`http://localhost:<port>/_calm` in development.

```bash
npm install -D @calmapi/devtools   # new projects already have it
npm run dev                        # then open http://localhost:5001/_calm
```

The collector and its JSON API live in your app (`calm/devtools/index.js`), like the rest
of the framework code you own. This package only ships static files (HTML, CSS and ES
modules, no build step and no dependencies). If it is not installed, `/_calm` shows a short
page explaining how to add it.

## Panels

| Panel | What it shows |
| --- | --- |
| **Requests** | Every API call, live: status, method, path, user, duration, query count (amber when a request runs more than 10 queries, a likely N+1), a duration bar with the MongoDB share, and time. Requests sent by an AI agent (`X-Calm-Agent`) carry a small violet marker. Open one in a resizable split pane for a waterfall timeline of its MongoDB queries, each query with **Explain** (COLLSCAN or the index used), request headers and body, the response as a collapsible JSON tree, its logs, and the error with the internal message and stack. **Copy as curl**, **Replay** and **Edit in Playground**. **Background queries** lists queries from jobs and startup. |
| **Activity** | What happened in the project, newest first: tool calls from AI agents (`calm mcp`), file changes with an inline diff, restarts and crashes (`calm dev`). Agent and human edits are told apart by a marker; the latest crash opens with its stderr. The sidebar counts new events since you last looked. |
| **Logs** | Live tail with level toggles and a text filter. Request ids link to the request. |
| **Mail** | An inbox for everything sent through the development transport. Nothing is delivered for real. |
| **Push** | Every push notification the app sent with `ctx.push.send()`, live. See it as it would appear on an iPhone lock screen, in the Android notification shade and as a desktop browser notification, closed or expanded, with the text cut off where a real phone cuts it. The exact payload APNs, FCM, Expo and Web Push receive, with its size against the 4 KB limit, warnings (text cut off, data that looks sensitive, payloads a provider would reject), the delivery log per device and the request that sent it. **New notification** composes one with a live preview; **Devices** lists registered devices and adds simulated iPhones, Android phones and browsers to any user, so you can preview notifications without a phone. Simulated devices never reach a real provider. |
| **Routes** | Every endpoint grouped by resource or source, with its policy (policies that were defaulted instead of written out are flagged), summary and a link that opens the file in VS Code. **Try it** sends it to the Playground. |
| **Resources** | A relationship diagram built from `f.ref()` fields, then each resource with its policies per action and its fields: type, refs, enum values, defaults, flags and who can see or write them. |
| **Data** | Documents, paginated. The **privacy lens** puts the raw stored document next to exactly what the API returns to a given viewer, with every withheld field struck through and labeled (hidden, write only, password, `visibleTo`). Use **View as** to switch viewers. |
| **Playground** | Send requests to your API with route suggestions, a JSON body editor and **Act as**: pick a user and devtools creates a real session for them (kept in memory only, never stored by the page). |
| **Doctor** | Runtime checks against your config, resources and routes, as a list sorted by severity. Run `npx calm doctor` for static checks on top. |
| **Security** | The access matrix (every action and field per persona, computed from your resources), **Run audit** to call every route as every persona on a throwaway database and overlay pass or fail on the matrix, live security events (failed logins, lockouts, rejected writes) and the security posture. |
| **Blocks** | One panel per `calm.devtools.panel(name, fn)` registered by a block. |

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus the filter |
| `j` / `k` | Next / previous item |
| `n` | New notification (Push) |
| `Enter` | Open the selected request |
| `Esc` | Close the detail view |
| `1` to `9` | Switch panel |
| `Ctrl` + `Enter` | Send (Playground) |
| `?` | Show shortcuts |

## Panels from blocks

A block can add its own panel. Return any JSON; the UI renders it generically:
arrays of objects become tables, objects become a list of facts plus a section per nested
array or object, anything else is shown as a JSON tree.

```js
export default definePlugin({
  name: 'jobs',
  setup(calm) {
    calm.devtools.panel('jobs', async () => ({
      worker: 'in-process',
      running: true,
      definitions: [{ name: 'send-digest', schedule: '0 8 * * *' }],
      recent: await recentRuns(),
    }));
  },
});
```

## Safety

- Devtools only exists in development. `calm/config.js` forces it off in production.
- Every `/_calm` request must come from this machine (loopback socket, localhost `Host`,
  no proxy headers), and the page is served with a strict Content-Security-Policy
  (no inline scripts, no third party scripts or connections, no framing; https images are
  allowed so notification previews can show their image).
- Every write (`POST` or `DELETE` to `/_calm/api/*`) needs the `X-Calm-Devtools: 1` header,
  which a cross-site page cannot send.
- Recorded requests redact `Authorization`, cookies and fields that look secret.
  Replay therefore runs anonymously unless you act as a user, and the UI says so.

## API

```js
import { uiDir, version } from '@calmapi/devtools';
// uiDir: absolute path of the ui/ folder (index.html, app.js, styles.css)
// version: this package's version
```

The UI talks to the JSON API under `/_calm/api` (`/overview`, `/requests`, `/queries`,
`/logs`, `/mails`, `/resources/:name/docs`, `/users`, `/act-as`, `/panels/:name`, `/doctor`,
`/activity`, `/security`, `/audit`)
and streams updates from `/_calm/api/stream` (Server-Sent Events).

## Files

```
index.js           exports uiDir and version
ui/index.html      shell, loads theme.js, styles.css and app.js
ui/theme.js        applies the saved theme before first paint
ui/app.js          shell, navigation, header, keyboard shortcuts
ui/store.js        shared state and the live event stream
ui/lib.js          DOM, a few functional icons, formatting, JSON views, toasts, tooltips, popovers
ui/panels/*.js     one module per panel
ui/styles.css      light and dark themes via CSS custom properties
```

MIT licensed.
