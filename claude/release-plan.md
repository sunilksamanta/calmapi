# CalmAPI 2 release plan (from the "Next Moves" brief, 20 Oct 2026)

Source of truth for tasks: ClickUp, Engineering > Broadifi > **CalmAPI v2**
(https://app.clickup.com/9002095657/v/l/li/1300220000008284). This file mirrors the plan so a coding
session without ClickUp access can still pick a task. The strategy brief is `claude/calmapi-next-moves.md`
and https://claude.ai/artifact/GAuzSz6zwzbnjgXiP6xzpJ.

Cadence: one release every two weeks, on a Friday. Every release follows the same checklist (in each
release task): bump the three package.json files and create-calmapi's dependency, CHANGELOG section,
`node scripts/check-release.js vX`, lint, full suite on MongoDB 7.0, docs PR, PR to master, GitHub
release with a new tag (pre-release), `npm dist-tag add calmapi@X latest`, verify, announce.

| Release | Window | Theme | ClickUp |
|---|---|---|---|
| 2.0.0-beta.3 | 26 Oct to 6 Nov 2026 | Agent-ready launch: bundled docs, SKILL.md, plugin, Cursor rules, MCP registry; `calm mcp --compact`; slopsquatting guard; trust page; marketing weeks 1 and 2 | 14yhc7kx628 |
| 2.0.0-beta.4 | 9 to 20 Nov | `calm probe`: audit any API; report and CI modes; docs and Show HN; marketing weeks 3 to 5 | 14yhc7kx629 |
| 2.0.0-beta.5 | 23 Nov to 4 Dec | Zero-setup: `calm dev --db embedded`, `npx calm try`; Railway template, Render and Fly recipes; getting started reorganised | 14yhc7kx62a |
| 2.0.0-beta.6 | 7 to 18 Dec | Safety net: trash and delayed deletes; change manifest in the PR; `--agent-db --anonymize`; week 8 post | 14yhc7kx62b |
| 2.0.0-beta.7 | 21 Dec to 8 Jan 2027 | Migrations (`calm make migration`, `calm migrate`), drift detection in doctor; Migrations docs; marketing weeks 9 and 10 | 14yhc7kx62c |
| 2.0.0-beta.8 | 11 to 22 Jan | `calm types` (server-side types); client `--react-query` and `--forms`; TypeScript docs; marketing weeks 11 and 12 | 14yhc7kx62d |
| 2.0.0-beta.9 | 25 Jan to 5 Feb | Admin panel block; audit pass, accessibility, mobile; docs and website | 14yhc7kx62e |
| 2.0.0-beta.10 | 8 to 19 Feb | Cookie sessions with CSRF; `webhooks-inbox` block; "Use with Next.js" guide | 14yhc7kx62f |
| 2.0.0-beta.11 | 22 Feb to 5 Mar | Team quotas and tenant isolation audit; `.retain()`; date-based API versioning; docs | 14yhc7kx62h |
| 2.0.0-rc.1 | 8 to 19 Mar | CalmAPI Bench; `calm add ai` and `.embedded()`; API freeze and 2.0.0 announcement; bench post | 14yhc7kx62j |

Subtasks for beta.3 through beta.11 are in ClickUp with what, how, tests, docs and done-when.

## Not yet in ClickUp (the daily API limit was reached on 20 Oct; add these first)

### Under 2.0.0-beta.5 (14yhc7kx62a): Marketing, weeks 6 and 7: the creator play, Showoff Saturday (due 2026-12-04)

- Watch Theo, Primeagen and Web Dev Simplified for a real complaint about Express boilerplate, Nest ceremony, Mongoose types or an agent wrecking a backend. Reply with a thread that maps each complaint to a CalmAPI command, with output. Never a pitch. (Drizzle's founder replied to Theo's two-hour Prisma complaint; three videos and 11k stars followed.)
- Showoff Saturday on r/webdev: "how we built the audit", with the GIF, written as a project, not a product.
- Post the `calm try` recording on X and Bluesky.
- Done when: one creator reply is posted with a technical answer, the Showoff Saturday post is up.

### Under 2.0.0-rc.1 (14yhc7kx62j): CalmAPI Bench: public eval repo and first results (due 2027-03-15, high)

What: evidence for the claim. Agents build the same backend tasks on CalmAPI and on plain Express; the outcome is scored in the database and by the probe, not by reading the transcript. Public, rivals can send PRs.

How:
1. Repo `calmapi-bench` (MIT). Twenty tasks as Markdown specs, each with a seed and an acceptance script (a SaaS with teams and billing, a marketplace, a mobile backend with push, a blog with roles, file sharing, a waitlist, and smaller ones: add a field, add a role, add a webhook, fix a leak). Each task: functional checks (HTTP calls, expected statuses and bodies), security checks (`calm probe --json` against the result with anonymous, user, other-user and admin credentials; same probe for both frameworks), counters (tokens, wall time, human interventions, tests run).
2. Runners drive Claude Code (headless `-p`), Codex CLI and Cursor's CLI with one prompt from a clean project (CalmAPI: `npm create calmapi@latest`; Express: minimal Express 5 plus Mongoose starter, same MongoDB). Container with MongoDB 7.0, network only to the model API and npm. Three runs per task per framework per agent; medians and spread.
3. Scoring: functional pass rate, probe findings by severity, token cost, time. No composite score. State what the bench cannot show.
4. Results page in the repo and docs.calmapi.dev/bench with date, model versions, commits; a CHANGELOG for the bench.
5. Open issues "Add Hono", "Add NestJS", "Improve the Express starter"; accept PRs that make it fairer. Judge the outcome in the database, not the transcript.

Tests: acceptance scripts have tests on a hand-built reference solution per task. Docs: `src/docs/bench.md`; README's "Why not NestJS or plain Express?" links to it.
Done when: twenty tasks, three agents, two frameworks, results published with the method; at least one external PR merged or answered.

### Under 2.0.0-rc.1: `calm add ai` and `f.text().embedded()`: LLM features that obey the policies (due 2027-03-17)

What: an assistant endpoint answers over the caller's own records through the same resource services, so a user can never ask the model about data they could not list. Embeddings kept in sync for semantic search. "The policy applies to the model too."

How:
1. Block `registry/blocks/ai/`: `POST /api/ai/ask { question, resources? }` (authenticated, auth rate limiter). Tools built from the resources (list, get, search) call `ctx.service` with the caller's ctx so scoping and visibility apply; the model (Claude via fetch, `AI_API_KEY`, provider pluggable in `app/blocks/ai/providers.js`) runs a tool loop (max 6 calls). Prompts and tool calls recorded on the request; `calm explain` shows which policy allowed each call.
2. `f.text().embedded({ model, dims })`: service hook stores a vector in `<field>_embedding` on create and update; `?semantic=` on list uses Atlas Vector Search (`calm ai index`), Meilisearch hybrid when that block is present, else `$text` fallback with a doctor warning. Results still pass `scope()` and visibility.
3. Safety: tool outputs are serialized, filtered records; the model never gets a database handle; prompt injection cannot widen access. `calm audit` adds: as user A ask about B's records; the answer must not contain B's seeded unique values.
4. Stub provider in development without a key, so tests and devtools work offline.
5. Per-user daily token budget; `429 AI_BUDGET_EXCEEDED`.

Tests: `test/blocks/ai.test.js` with the stub provider (scope holds, visibility holds, audit check, budget, embeddings on create and update, all-blocks test). Docs: block page stating the guarantee and its limits.
Done when: the "ask as A about B" audit check passes and devtools shows the tool loop under the request.

### Under 2.0.0-rc.1: API freeze: compatibility document, deprecations, 2.0.0 announcement draft (due 2027-03-18, high)

1. `COMPATIBILITY.md`: public surface (`resource()`, `f.*()`, policies, `ResourceService` hooks, `definePlugin` and `calm.*` extension points, test helpers, CLI commands and flags, block.json, `calm.lock`, the devtools HTTP API), internal surface, deprecation policy (one minor of warnings, removal in the next major), 1.x window.
2. Walk the public surface; add `deprecate()` warnings for names renamed during the betas; remove in 3.0.
3. `calm diff --api` on the template app against the beta.11 tag becomes a CI check in `scripts/check-release.js`: undated breaking changes block releases.
4. Draft the 2.0.0 announcement in `claude/announce-2.0.0.md` (hook, what changed since 1.x, what the betas added, bench results, trust page, contributors by name, 1.x window). Human-edited.
5. ROADMAP.md: 2.0.0 items done; write 2.1 from the remaining brief ideas.

Tests: the contract check in CI; `deprecate()` warns once per process.
Done when: COMPATIBILITY.md merged, CI runs the contract check, the announcement draft exists.

### Under 2.0.0-rc.1: Marketing: bench results post and the 2.0.0 launch plan (due 2027-03-19)

- Bench results post: method first, table, caveats, invitation. No composite score. HN (normal link), X, Bluesky, r/node, r/ClaudeAI; Node Weekly, JavaScript Weekly, Bytes, TLDR.
- 2.0.0 launch plan, two weeks after rc.1 if no blocker: Launch post, the announcement, the "Who is using" wall, a 2.0 page on the website, second creator play with the bench, newsletter round, Discord event.
- Ask the Vercel OSS Program and Railway for a co-post or template feature on launch day.
- Update the strategy doc with the 90-day results and the 2.1 list.
- Done when: results post published; the 2.0.0 plan is a dated checklist in a new parent task "Release 2.0.0".

### Also pending: attach the brief as a ClickUp Doc in the CalmAPI v2 list

`clickup_create_document` under the list returned not_found_or_authorized on 20 Oct. Retry with the folder (Broadifi, 90168951738) or the space as parent, then put `claude/calmapi-next-moves.md` on its first page.

## Deliberately not planned

SQL support, a hosted service, benchmarks against named rivals, decorators or a DI container. See the brief.
