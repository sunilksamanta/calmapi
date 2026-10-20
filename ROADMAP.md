# Roadmap

Where CalmAPI is going, roughly in order. Plans change with feedback: open a
[discussion](https://github.com/sunilksamanta/calmapi/discussions) to argue for something, or pick an
issue labelled [`good first issue`](https://github.com/sunilksamanta/calmapi/labels/good%20first%20issue).

## Now: 2.0 beta

The framework, the CLI, devtools and 35 official blocks are in place. The beta is about hearing from
people who build real APIs with it.

- Fix what beta users run into, first. Bug reports with a reproduction get priority.
- Smooth the first hour: clearer errors when MongoDB is unreachable, better hints from `calm doctor`.
- More examples: a SaaS starter (auth, teams, billing) and a mobile backend (push, devices, magic link).

## Next: 2.0.0 (stable)

- **Freeze the public API**: `resource()` and `f.*()`, policies, the block (`definePlugin`) API, the
  test helpers and the CLI flags. After 2.0.0 these follow semver: breaking changes only in 3.0.
- **Upgrades you can trust**: `calm upgrade` tested against every beta, with release notes that say
  which files in `calm/` changed and why.
- **TypeScript**: type definitions for `calm/` and generated resource types, so editors check
  `resource()` definitions and service hooks. The typed frontend client (`calm client`) exists already.
- **1.x support window**: security advisories for 1.x continue until 2.0 has been stable for 12 months
  (see the [migration guide](https://docs.calmapi.dev/migrate-v1#support-for-1x)).

## Later: being explored

Not promised, but being looked at. Tell us which ones matter to you.

- A community block directory on docs.calmapi.dev, listing blocks published with `calm block pack`.
- More provider blocks (payments, email and storage providers beyond the current ones).
- Background job dashboards and alerting in devtools for the `jobs` block.
- Multi-tenant patterns beyond `teams`: per-tenant databases.

## Not planned for 2.x

- **SQL databases.** CalmAPI is built around MongoDB (queries, scoping, the audit, checkpoints). Supporting
  SQL well would mean a different framework.
- **A hosted service.** CalmAPI stays a framework you run anywhere: your servers, containers or any Node.js host.
