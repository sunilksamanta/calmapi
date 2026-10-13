# AGENTS.md

Instructions for AI coding agents (Claude Code, Codex, Cursor, Copilot...) working in this
CalmAPI project. Humans are welcome too.

## What this project is

A REST API built with CalmAPI 2 (Node.js 22.12+, Express 5, MongoDB via Mongoose, ESM).
The framework itself lives in `calm/` as plain source code. It is owned by this project.

## Layout

```
calm/                     framework code (owned). Upgrade with `npx calm upgrade`, do not rewrite casually
app/resources/<name>/     one folder per resource
  <name>.resource.js      fields + access policy (required)
  <name>.service.js       business logic, extends ResourceService (optional)
  <name>.routes.js        custom endpoints (optional)
app/blocks/<name>/        blocks installed with `npx calm add`, each with its own AGENTS.md
app/routes.js             app-wide custom routes (optional)
calm.config.js            config overrides; secrets go in .env
test/                     node:test tests, use createTestApp from '#calm/testing.js'
```

Imports: use `#calm` for the framework and `#app/...` for app code. Never deep-import mongoose models
across resources; use `this.service('name')` inside services or `ctx.services.name` in routes.

## Golden rules

1. **Add a resource with the CLI**, then edit it:
   `npx calm make resource product title:string+required price:number category:ref:category`
2. **Declare fields once** in `<name>.resource.js` with `f.*()`. Visibility and validation come from there:
   `.hidden()` never returned, `.writeOnly()` input only, `.readOnly()` output only, `.immutable()`,
   `.writableBy('admin')`, `.visibleTo('owner | admin')`, `.filterable()`, `.sortable()`, `.searchable()`.
3. **Every route needs a policy**: `'public' | 'authenticated' | 'owner' | 'admin' | '<role>' | (ctx) => bool`,
   combined with `|`. Owner comes from a `f.ref('user').owner()` field.
4. **Handlers return values**; do not call `res.json`. Throw `notFound()`, `forbidden()`, `badRequest()`,
   `validationError({ field: 'msg' })` from `#calm`. No try/catch needed.
5. **Business logic goes in the service**, using hooks (`beforeCreate`, `afterUpdate`, `scope`...) before
   overriding whole methods. Keep queries scoped with `this.filterFor(ctx, filter)`.
6. **Never return raw documents from non-resource routes**; use `ctx.serialize(doc, 'resource')`.
7. Sensitive data: `.visibleTo('owner | admin')` for personal fields, `.encrypted()` for secrets at rest
   (needs `CALM_ENCRYPTION_KEYS`, see `npx calm keygen --write`). Never log secrets.
8. Email and push go through `ctx.app.mailer.send()` and `ctx.push.send({ to: userId, title, body, data })`.
   Put ids in push `data`, never secrets or personal details. In tests assert on `t.mails` and `t.pushes`.
9. **Blocks carry their own instructions**: before changing anything in `app/blocks/<name>/`, read
   `app/blocks/<name>/AGENTS.md` (the rules that block must keep, its options, and links to the official
   documentation of the service it integrates, e.g. Stripe or Twilio). Follow the official docs, not memory.
10. Before finishing: `npm test`, `npx calm doctor` (fix every `error`) and, after changing policies or
   fields, `npx calm audit` (it calls every route as every role and must pass).

Docs: https://docs.calmapi.dev (each page also as markdown at its URL plus `.md`, and
https://docs.calmapi.dev/llms.txt).

## Useful commands

```
npm run dev                 start with watch mode and devtools (http://localhost:5001/_calm)
npx calm routes             every route with its policy
npx calm doctor             security and config checks
npx calm audit              authorization test of every route as every role (throwaway database)
npx calm add <block>        add a block from the registry (e.g. @calmapi/jobs)
npx calm openapi            write openapi.json
npm test                    run tests (needs MongoDB; MONGODB_TEST_URI to override)
```

An MCP server is available for agents that support it: `npx calm mcp`. Useful loop:
`calm_make_resource` or edit files, then `calm_activity` (did the dev server restart or crash?),
`calm_http` (call the API as anonymous, admin or a user email), `calm_test`, `calm_doctor`,
`calm_audit`. `calm_mails` and `calm_pushes` show the emails and push notifications the dev server sent. Your tool calls, diffs and requests appear live in devtools (/_calm) for the human
you are working with.

The MCP server runs in a scope (`calm mcp --scope read|scaffold|full`): `read` inspects only, `scaffold`
also scaffolds resources and blocks, `full` does everything. A refused call means the developer chose a
narrower scope; it is not an error to work around. Some paths are protected (`calm/security/**`, `calm/auth/**`,
`calm.config.js` by default, see `agents.protected` in `calm.config.js`), and so are policy and field visibility
lines in resource files: edits there are flagged for review. For anything refused or protected, describe the change
with `calm_propose` (title, reason, the full content of each file); the developer applies it from devtools.

Your edits are shown to the developer as yours, not theirs: through MCP calls, through the hook in
`.claude/settings.json` (Claude Code runs `npx calm agent-hook` before each edit), or by piping
`{ "tool": "edit", "path": "<file>" }` into `npx calm agent-hook --client <your name>` before you change a
file. Before finishing, run `npx calm diff` (or `calm_diff`) and show the developer what changed in behavior.
