# Releasing CalmAPI 2

Three npm packages are released together, always with the same version:

| Package | Contents | npm dist-tag |
| --- | --- | --- |
| `calmapi` | the CLI, the framework source (`core/`), templates and the bundled block registry | `next` for 2.x prereleases, `latest` from 2.0.0 |
| `@calmapi/devtools` | the devtools UI, a dev dependency of every project | `latest` |
| `create-calmapi` | `npm create calmapi@latest`, a thin wrapper around `calm create` | `latest` |

`calmapi@latest` stays on 1.x until 2.0.0 is stable, so existing 1.x users are not moved to 2.x by
`npm install calmapi`. `calmapi/package.json` sets `publishConfig.tag` to `next` as a safety net; remove
it when 2.0.0 ships.

## Cutting a release

1. Bump the version in all three `package.json` files (`package.json`, `packages/devtools/package.json`,
   `packages/create-calmapi/package.json`) and the exact `calmapi` dependency of `create-calmapi`.
   Run `npm install --package-lock-only`.
2. Add a `## <version>` section to `CHANGELOG.md`.
3. Check it: `node scripts/check-release.js v<version>`.
4. Commit and push, then publish a GitHub release: **Releases**, **Draft a new release**, **Choose a
   tag**, type `v<version>` (for example `v2.0.0-alpha.1`) and pick **Create new tag on publish**,
   target the branch you are releasing from, tick **Set as a pre-release** for alpha, beta and rc
   versions, and **Publish release**. The notes can stay empty: the workflow fills them in from the
   changelog. Pushing the tag from the command line works too:

   ```bash
   git tag v2.0.0-alpha.1
   git push origin v2.0.0-alpha.1
   ```

The [release workflow](../.github/workflows/release.yml) then runs lint and the full test suite against
MongoDB, creates a project from the packed tarballs and runs its tests and `calm audit`, publishes the
three packages with provenance (devtools, then calmapi, then create-calmapi; versions already on npm
are skipped, so a failed run can simply be re-run), and writes the release notes from the changelog.

Any push to `master` (or a `claude/**` branch) runs the same pipeline as a dry run
that ends with `npm publish --dry-run`, so a release never starts from a commit that has not passed it.

## npm authentication

The workflow publishes with **trusted publishing** (OIDC) when it is configured on npmjs.com, and with
the `NPM_TOKEN` repository secret otherwise. Trusted publishing is preferred: no long-lived token
exists, and npm ties every version to the exact workflow run that built it.

### First release (packages that do not exist yet)

npm only lets you configure trusted publishing for a package that already exists, so the very first
release uses a short-lived token:

1. On npmjs.com: avatar, **Access Tokens**, **Generate New Token**, **Granular Access Token**.
   - Expiration: 7 days.
   - Packages and scopes: **Read and write**, **All packages** (needed to create `create-calmapi`
     and `@calmapi/devtools`).
   - Tick **Bypass two-factor authentication** so CI can publish.
2. On GitHub: `sunilksamanta/calmapi`, **Settings**, **Secrets and variables**, **Actions**,
   **New repository secret**, name `NPM_TOKEN`, paste the token.
3. Publish the GitHub release (or push the tag).

### After the first release: switch to trusted publishing

For each of `calmapi`, `@calmapi/devtools` and `create-calmapi` on npmjs.com: **Settings**,
**Trusted publishing**, **GitHub Actions**, with organization or user `sunilksamanta`, repository
`calmapi`, workflow filename `release.yml`, no environment.

npm expects the first publish through a new trusted publisher configuration within 2 days, so do this
right before the next release. Then delete the `NPM_TOKEN` secret on GitHub and the token on npmjs.com.
While you are there, under each package's **Settings**, set publishing access to require two-factor
authentication and disallow tokens.

## Checking a release

```bash
npm view calmapi dist-tags           # next: the 2.x prerelease, latest: 1.x until 2.0.0
npm view create-calmapi dist-tags
npm view @calmapi/devtools dist-tags
npm create calmapi@latest my-api     # end to end, needs MongoDB
```
