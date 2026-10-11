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
| **Requests** | Every API call, live. Method, path, status, duration, query count (tinted when a request runs more than 10 queries, a likely N+1), user and time. Open one for a waterfall timeline of its MongoDB queries, each query with an **Explain** button (COLLSCAN or the index used), request headers and body, the response as a collapsible JSON tree, its logs, and the error with the internal message and stack. **Copy as curl**, **Replay** and **Edit in Playground**. A second tab lists background queries (jobs, startup). |
| **Logs** | Live tail with level chips and a text filter. Request ids link to the request. |
| **Mail** | An inbox for everything sent through the development transport. Nothing is delivered for real. |
| **Routes** | Every endpoint grouped by resource or source, with its policy (policies that were defaulted instead of written out are flagged), summary and a link that opens the file in VS Code. **Try it** sends it to the Playground. |
| **Resources** | A relationship diagram built from `f.ref()` fields, then each resource with its policies per action and its fields: type, refs, enum values, defaults, flags and who can see or write them. |
| **Data** | Documents, paginated. The **privacy lens** puts the raw stored document next to exactly what the API returns to a given viewer, with every withheld field struck through and labeled (hidden, write only, password, `visibleTo`). Use **View as** to switch viewers. |
| **Playground** | Send requests to your API with route suggestions, a JSON body editor and **Act as**: pick a user and devtools creates a real session for them (kept in memory only, never stored by the page). |
| **Doctor** | Runtime checks against your config, resources and routes, grouped by level. Run `npx calm doctor` for static checks on top. |
| **Blocks** | One panel per `calm.devtools.panel(name, fn)` registered by a block. |

## Keyboard

| Key | Action |
| --- | --- |
| `/` | Focus the filter |
| `j` / `k` | Next / previous item |
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
  (no inline scripts, no third party origins, no framing).
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
`/logs`, `/mails`, `/resources/:name/docs`, `/users`, `/act-as`, `/panels/:name`, `/doctor`)
and streams updates from `/_calm/api/stream` (Server-Sent Events).

## Files

```
index.js           exports uiDir and version
ui/index.html      shell, loads theme.js, styles.css and app.js
ui/theme.js        applies the saved theme before first paint
ui/app.js          shell, navigation, header, keyboard shortcuts
ui/store.js        shared state and the live event stream
ui/lib.js          DOM, icons, formatting, JSON views, toasts, popovers
ui/panels/*.js     one module per panel
ui/styles.css      light and dark themes via CSS custom properties
```

MIT licensed.
