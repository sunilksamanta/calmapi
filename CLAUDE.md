# CalmAPI 2: notes for coding agents working on the framework

- Contributing guide, layout and house rules: `CONTRIBUTING.md`. Release steps: `RELEASING.md`.
- Strategy and research behind the roadmap: `claude/calmapi-next-moves.md`.
- The release-by-release plan with task ids: `claude/release-plan.md` (ClickUp list "CalmAPI v2" is the source of truth for status).
- Tests need a real MongoDB 7.0 at `MONGODB_TEST_URI` (8.x refuses Linux 6.19+ kernels, SERVER-121912).
- `master` is protected: changes go through a pull request.
- Never use em dashes in code comments, docs or commit messages.
