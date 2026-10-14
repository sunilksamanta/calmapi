import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { blockGuide, parseBlockGuide, cleanLinks } from '../../src/cli/lib/blocks.js';
import { makeProject, ROOT } from '../helpers.js';

// Every block keeps what a person or an AI agent needs next to its code: app/blocks/<name>/AGENTS.md
// with instructions for agents and links to the official documentation of what it integrates.

const meta = {
  name: 'pay',
  title: 'Payments',
  description: 'Takes money.',
  agents: '- Verify webhook signatures on the raw body.\n- Never trust a price from the client.',
  links: [
    { title: 'Stripe webhooks', url: 'https://docs.stripe.com/webhooks' },
    { title: 'bad', url: 'javascript:alert(1)' },
    { title: '', url: 'https://x.example' },
    'nope',
  ],
  docs: 'POST /api/pay',
  envVars: { PAY_KEY: 'secret key' },
};

test('blockGuide writes the guide and parseBlockGuide reads back notes and http(s) links only', () => {
  const md = blockGuide(meta, { official: true });
  assert.match(md, /^# Payments \(block: pay\)/);
  assert.match(md, /## For AI agents\n\n- Verify webhook signatures on the raw body\./);
  assert.match(md, /## Official documentation\n\n- \[Stripe webhooks\]\(https:\/\/docs\.stripe\.com\/webhooks\)\n\n/);
  assert.match(md, /## Environment variables\n\n- `PAY_KEY`: secret key/);
  assert.match(md, /More: https:\/\/docs\.calmapi\.dev\/blocks\/pay/);
  assert.doesNotMatch(blockGuide(meta), /docs\.calmapi\.dev\/blocks\/pay/, 'community blocks do not link to the official docs site');
  assert.doesNotMatch(md, /javascript:/);
  assert.deepEqual(parseBlockGuide(md), { agents: meta.agents, links: [{ title: 'Stripe webhooks', url: 'https://docs.stripe.com/webhooks' }] });
  assert.deepEqual(parseBlockGuide('# nothing here'), { agents: '', links: [] });
  assert.deepEqual(cleanLinks(null), []);
  assert.doesNotMatch(blockGuide({ name: 'bare' }), /## /, 'no empty sections');
});

test('the registry ships app/blocks/<name>/AGENTS.md for every official block', () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')], { stdio: 'ignore' });
  for (const file of readdirSync(join(ROOT, 'registry', 'r')).filter((f) => f !== 'index.json')) {
    const item = JSON.parse(readFileSync(join(ROOT, 'registry', 'r', file), 'utf8'));
    const guide = item.files.find((f) => f.target === `app/blocks/${item.name}/AGENTS.md`);
    assert.ok(guide, `${item.name} has an AGENTS.md`);
    assert.match(guide.content, new RegExp(`block: ${item.name}`));
    assert.deepEqual(parseBlockGuide(guide.content).links, item.meta.calmapi.links, `${item.name}: the guide carries the block.json links`);
  }
  const index = JSON.parse(readFileSync(join(ROOT, 'registry', 'r', 'index.json'), 'utf8'));
  assert.ok(index.items.every((i) => Array.isArray(i.links)));
});

test('calm add copies the guide; calm make block writes one and pack shares it', async () => {
  const project = await makeProject();
  try {
    const calm = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: project.dir, env: { ...process.env, CI: '1', NO_COLOR: '1' } }).toString();
    calm('add', 'idempotency', '--yes', '--no-install');
    assert.ok(existsSync(join(project.dir, 'app/blocks/idempotency/AGENTS.md')));
    calm('make', 'block', 'loyalty');
    const guide = readFileSync(join(project.dir, 'app/blocks/loyalty/AGENTS.md'), 'utf8');
    assert.match(guide, /## For AI agents/);
    assert.match(guide, /\[Building blocks \(CalmAPI docs\)\]\(https:\/\/docs\.calmapi\.dev\/building-blocks\)/);
    calm('block', 'pack', 'loyalty');
    const packed = JSON.parse(readFileSync(join(project.dir, 'r', 'loyalty.json'), 'utf8'));
    assert.ok(packed.files.some((f) => f.target === 'app/blocks/loyalty/AGENTS.md'));
    assert.equal(packed.meta.calmapi.links[0].url, 'https://docs.calmapi.dev/building-blocks');
    assert.match(readFileSync(join(project.dir, 'AGENTS.md'), 'utf8'), /app\/blocks\/<name>\/AGENTS\.md/);
  } finally {
    project.cleanup();
  }
});
