# CalmAPI Next Moves

Strategy brief, 20 October 2026. The designed version is at https://claude.ai/artifact/GAuzSz6zwzbnjgXiP6xzpJ. The release plan built from it lives in ClickUp under Engineering > Broadifi > CalmAPI v2.

## Where CalmAPI stands (20 Oct 2026)

| | |
|---|---|
| GitHub stars | 24 |
| npm downloads, last 30 days | 438 |
| Express downloads per week | 87.4M |
| Hono downloads per week | 45.2M |
| Official blocks | 35 |
| Framework tests on real MongoDB | 470 |
| MCP tools for coding agents | 29 |

The product is further along than its reach.

## Thesis

Two things are true at once, and CalmAPI sits on both:

1. **Agent-built backends leak and get deleted.** 10.3% of 1,645 scanned Lovable apps exposed user data (CVE-2025-48757). Veracode: 45% of AI-generated code introduces an OWASP Top 10 flaw. BaxBench could exploit about half of the backends models got functionally right. Replit's agent deleted a production database and faked passing tests; a Cursor agent wiped PocketOS's database and backups in nine seconds. GitGuardian: Claude Code-assisted commits leak secrets at 3.2%, twice the human rate.
2. **Node developers want Nest's structure without Nest.** Most-reacted Mongoose issue ever: type inference from the schema (#9715), still open. People leave Nest over decorators, DI and boilerplate. MongoDB users: "I would never go full mongo" because there are no migrations.

Position: **the safest place for an agent to build a backend.** Nobody owns it yet.

Hook (README, site, every post): *Declare a resource once. Get a secure API you own, and proof that an agent cannot make it leak.*

## Pain map (honest grade of beta.2)

- Express users: typed boundary (have), structure (have), Express 5 broke sanitizers (have: query allowlists), zero-setup first run (gap).
- NestJS leavers: no decorators/DI (have), OpenAPI from definition (have), generated TypeScript types for calm/ and resources (gap).
- Mongoose users: typed populate/server types (partial: client only), migrations and drift (gap), populate planning (partial), soft delete (have).
- Agent builders: change manifest in the PR (partial: review, declare), tests agents cannot edit (partial: protected paths, audit), delayed deletes (partial: agent-db, checkpoints), MCP token bloat (partial: scopes; 29 tools), slopsquatting guard (gap).
- Trust: cadence promise (partial), bus factor messaging (partial), supply chain (have: two deps, provenance), benchmarks (have none; keep it that way).

## The philosophy as five tests

1. Owned: code lands in the project, readable, upgradeable with `calm upgrade`.
2. Declared once: one definition drives schema, validation, output, queries, docs.
3. Provable: a command proves the security claim and CI fails when it stops being true.
4. Agent native, human visible: agents get a real tool; a person sees everything and signs what ships.
5. Blocks, not platform: features arrive as source code. No hosted service, no SQL pivot.

## Feature proposals (19)

Tier one (make the thesis undeniable):
- `calm probe <url> --openapi <file>`: run CalmAPI's probes against any REST API. Top of funnel.
- `npx calm try` / `calm dev --db embedded`: zero-setup first run with an embedded MongoDB 7.0.
- `calm make migration`, `calm migrate`, drift detection in `calm doctor`.
- Change manifest posted into the PR (GitHub Action in the template).
- Delayed deletes and a trash for collections; production refuses destructive agent operations.
- Slopsquatting and young-package guard in `calm doctor` and the agent hook.
- MCP diet: `calm mcp --compact` with five tools and a SKILL.md.

Tier two (win the Node developer):
- `calm types`: server-side `.d.ts` from resources (typed hooks, populate, ctx).
- `calm add admin`: generated, policy-aware admin panel block.
- `auth: { sessions: 'cookie' }` with CSRF.
- `calm add webhooks-inbox`: receiving webhooks with signature verification, dedupe, replay.
- Team quotas and per-team limits; tenant isolation pass in `calm audit`.
- `.retain('90d')`: retention and purge declared on the field.
- Date-based API versioning (`since`), building on `calm diff --api`.
- `calm client --react-query`, `--forms` adapters.

Tier three (agent-era bets):
- CalmAPI Bench: public evals of agents building on CalmAPI vs plain Express.
- `calm add ai` and `f.text().embedded()`: LLM features that obey the policies.
- Docs bundled in node_modules, SKILL.md, Claude plugin, Cursor rules, MCP registry entry.
- `calm dev --agent-db --anonymize`: agents never see real personal data.

Deliberately not: SQL, a hosted service, benchmarks against named rivals, decorators or DI.

## Marketing

Nobody on the list of winners (Hono, Drizzle, tRPC, shadcn, Better Auth, PocketBase, Astro, Bun) won on a Show HN alone. The order is: one-sentence hook, then a creator video or a bigger project adopting you as a default, then newsletters and HN amplify a milestone. Median Show HN today: 2 points.

Audiences: (A) Node developers leaving Express or Nest; (B) builders hitting the production wall with an agent; (C) creators and upstream projects (Theo, Fireship, Web Dev Simplified, Primeagen; Railway, Render, Vercel template galleries; MongoDB DevRel).

Ninety days from the launch post on 23 Oct 2026:
- Week 1: hook everywhere; SKILL.md, Claude plugin, Cursor rules, MCP registry; skills.sh and cursor.directory; "Who is using CalmAPI in production?" discussion; Discord; send the post to Node Weekly, JavaScript Weekly, Bytes.
- Week 2: trust page (pre-1.0 compat promise, biweekly cadence, security policy, OpenSSF Scorecard, dependency count, provenance, roadmap, 1.x window).
- Week 3: Railway template with deploy button, Render and Fly recipes, Vercel OSS Program application, 15 good first issues (half docs).
- Weeks 4 to 5: `calm probe` ships; Show HN "test any REST API as every role"; weekday US morning; answer every comment for two hours.
- Weeks 6 to 8: creator play (reply technically to a real complaint); Showoff Saturday on r/webdev; one r/node post.
- Weeks 9 to 10: two user-written "X to CalmAPI" posts; pitch PodRocket a topic.
- Weeks 11 to 12: CalmAPI Bench first results; awesome-nodejs PR (needs 100 stars, 30 days); JSNation 2027 CFP.

Targets for day 90 (guesses): 300 stars, 5,000 downloads a month, 5 named production users, 4 agent listings, 48 hour response on every issue.

What sinks launches: benchmark bravado, copy that sounds generated, drip-posting one link to several subreddits, overclaiming safety, going quiet.

## Caveats

Reddit was unreadable from the research environment; its sentiment is inferred from HN, GitHub, StackOverflow, dev.to and press. Rival star counts are approximate. Targets rest on two data points (dotenvx's #1 HN post, Drizzle's creator jump). Nineteen features is a menu; the release plan in ClickUp is the sequence. MongoDB 8.x refuses Linux 6.19+ kernels (SERVER-121912); pin 7.0 anywhere a database is started for the user.

## Sources (selection)

CVE-2025-48757 (cvemon.intruder.io) · Dark Reading on Veracode and Sonar · BaxBench (arXiv 2502.11844) · Fortune on Replit · The Register on PocketOS · SC World on GitGuardian · CSA on slopsquatting · Unblocked on MCP tool overload · METR o3 report · mongoose#9715, #16010, #3812 · State of JS 2025 · HN 46209572, 43102001, 46878110, 46873554, 42656439, 44031724, 46027878 · Oronts on leaving Nest · mongoose-drift (dev.to) · Cloudflare "the story of Hono" · Underdog Founders on Drizzle · dotenvx "what #1 on HN gets you" · Elysia vs Encore · Next.js 16.2 blog · Cooper Press publications · Railway template kickbacks · Vercel OSS Program.
