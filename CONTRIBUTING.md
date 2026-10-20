# Contributing to CalmAPI

Thanks for helping. CalmAPI 2 lives at the root of this repository; the 1.x source is on the
[`v1` branch](https://github.com/sunilksamanta/calmapi/tree/v1) and only gets security fixes.

## Where to start

- Issues labelled [`good first issue`](https://github.com/sunilksamanta/calmapi/labels/good%20first%20issue)
  are small, well described and touch one area. Comment on one to claim it.
- The [roadmap](ROADMAP.md) says what is planned; open a discussion before starting something larger.

## Set up

You need Node.js 22.12 or newer and a MongoDB you can write to (a local `mongod` is enough).

```bash
npm install
npm run lint
MONGODB_TEST_URI=mongodb://127.0.0.1:27017 npm test
```

The suite boots real apps on real MongoDB databases (each test makes its own and drops it).
Try a change in a real project with the CLI from your checkout:

```bash
node bin/calm.js create ../scratch-api --yes
cd ../scratch-api && node ../calmapi/bin/calm.js dev
```

## Layout

| Path | What it is |
|---|---|
| `core/` | The framework. Projects get a copy as `calm/`, so keep it dependency-light and readable. |
| `src/cli/` | The `calm` command. |
| `templates/` | What `calm create` writes (`api`, `minimal`, and the shared files). |
| `registry/blocks/<name>/` | Official blocks: `block.json` (with `links` and `agents`), `docs.md`, `files/`. |
| `packages/devtools/` | `@calmapi/devtools`, the browser UI at `/_calm`. |
| `packages/create-calmapi/` | `npm create calmapi`. |
| `test/` | `core/`, `cli/` and `blocks/` tests (node:test). |

## Rules of the house

- Every change comes with a test. Security behavior (policies, field visibility, tokens) needs a test
  that proves the refusal, not only the success.
- No new runtime dependencies in `core/` or in blocks unless there is no reasonable alternative.
- Blocks keep their `links` (official documentation) and `agents` (instructions for AI agents) current.
- Add a line to `CHANGELOG.md` under the next version.
- `npm run lint` and `npm test` pass before a pull request is ready.

Releases are described in [RELEASING.md](RELEASING.md).
