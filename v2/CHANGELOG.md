# Changelog

## 2.0.0-alpha.0

A rewrite. The framework is still copied into your project, and now it can be upgraded.

### Framework (`calm/`)
- Resources declared once with `f.*()` fields drive the Mongoose schema, validation, output visibility,
  query allowlists and OpenAPI. Unknown, read-only and hidden fields are rejected (no mass assignment).
- Policies on every route (`public`, `authenticated`, `owner`, roles, functions), field-level
  `visibleTo`/`writableBy`, owner scoping of lists, 401/403/404 semantics that do not leak record ids.
- Populated references are serialized with the target resource's rules, so private fields never leak.
- Express 5, ESM, return-value handlers, no try/catch boilerplate, custom routes mounted before CRUD.
- Auth: opaque hashed sessions, scrypt passwords (node:crypto), no account enumeration, single-use
  reset tokens that revoke all sessions, session management endpoints, rate limits.
- Secure defaults: production unless `NODE_ENV` says otherwise, security headers, configurable CORS,
  request ids, structured logs, health checks, graceful shutdown, config validation at boot.
- OpenAPI 3.1 generated from code, Standard Schema support, in-process events, plugin API, test helpers.
- Devtools collector at `/_calm` (development only, loopback only).
- Runtime dependencies of a new project: `express` and `mongoose`.

### CLI
- `create`, `dev`, `make resource`, `add`, `routes`, `openapi`, `doctor`, `upgrade`, `mcp`. Zero dependencies.
- `calm.lock` and `calm upgrade` (three-way merge of framework updates into your edited copy).
- `calm doctor` with security advisories for owned code, including 1.x projects.
- `calm mcp`: MCP server for coding agents.

### Blocks
`jobs`, `storage-local`, `storage-s3`, `realtime-sse`, `mcp-server`, `audit-log`, `soft-delete`,
`api-docs`, `mail-resend`, `mail-smtp`, `rate-limit-mongo` (shadcn registry-item format).

### Packages
`calmapi` (CLI), `create-calmapi`, `@calmapi/devtools`.

See MIGRATION.md for moving from 1.x.
