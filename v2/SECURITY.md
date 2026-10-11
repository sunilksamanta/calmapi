# Security

## Reporting a vulnerability

Please report privately through GitHub: Security tab → "Report a vulnerability" on
https://github.com/sunilksamanta/calmapi. Do not open public issues for vulnerabilities.
You will get an answer within a few days.

## Advisories for code in your project

CalmAPI copies its code into your project, so `npm audit` cannot see problems in it. CalmAPI
publishes advisories in `advisories.json`, and `calm doctor` matches them against your files:

```bash
npx calm doctor            # inside a 2.x project
npx calmapi@next doctor    # inside a 1.x project
```

Fixes for framework files reach your project through `calm upgrade`, which merges them into your
copy without discarding your edits.

## Supported versions

| Version | Status |
|---|---|
| 2.x | supported |
| 1.x (0.x on npm) | security advisories only; please migrate (MIGRATION.md) |
