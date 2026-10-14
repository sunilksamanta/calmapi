#!/usr/bin/env node
// Checks that a release is consistent before anything is published.
//
//   node scripts/check-release.js [tag]
//
// - calmapi, @calmapi/devtools and create-calmapi share one version
// - create-calmapi depends on exactly that calmapi version
// - the git tag (when given) is v<version>
// - CHANGELOG.md has a section for the version
//
// Prints key=value lines (for $GITHUB_OUTPUT): version, prerelease, and the npm dist-tag for
// calmapi. 1.x users keep "latest" until 2.0.0 is stable, so a 2.x prerelease goes to "next".

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));

const cli = read('package.json');
const devtools = read('packages/devtools/package.json');
const create = read('packages/create-calmapi/package.json');
const tag = process.argv[2];

const problems = [];
const version = cli.version;
if (devtools.version !== version) problems.push(`@calmapi/devtools is ${devtools.version}, calmapi is ${version}`);
if (create.version !== version) problems.push(`create-calmapi is ${create.version}, calmapi is ${version}`);
if (create.dependencies?.calmapi !== version) problems.push(`create-calmapi depends on calmapi ${create.dependencies?.calmapi}, expected exactly ${version}`);
if (tag && tag !== `v${version}`) problems.push(`tag ${tag} does not match version ${version} (expected v${version})`);
if (!readFileSync(join(root, 'CHANGELOG.md'), 'utf8').includes(`\n## ${version}\n`)) problems.push(`CHANGELOG.md has no "## ${version}" section`);
if (devtools.publishConfig?.access !== 'public') problems.push('@calmapi/devtools needs publishConfig.access "public"');

if (problems.length) {
  console.error(`Release check failed:\n  - ${problems.join('\n  - ')}`);
  process.exit(1);
}

const prerelease = version.includes('-');
console.log(`version=${version}`);
console.log(`prerelease=${prerelease}`);
console.log(`calmapi_tag=${prerelease ? 'next' : 'latest'}`);
