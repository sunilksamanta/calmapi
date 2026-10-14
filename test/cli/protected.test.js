import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isProtected, touchesAccessRules, protectionReason } from '../../src/cli/lib/protected.js';
import { SCOPES, DEFAULT_PROTECTED, allowedIn, neededScope, refusalText, annotateTools, parseScopeArgs } from '../../src/cli/lib/agent-scope.js';
import { agentChecks, globToRegex } from '../../src/cli/lib/static-checks.js';
import { lineDiff } from '../../src/cli/lib/activity.js';
import { capture } from '../../src/cli/lib/project.js';

const RESOURCE = `import { resource, f } from '#calm';

export default resource('post', {
  fields: {
    title: f.string().required().max(200),
    author: f.ref('user').owner(),
    email: f.email().visibleTo('owner | admin'),
  },
  policy: {
    list: 'public',
    update: 'owner | admin',
  },
});
`;
const diffTo = (after) => lineDiff(RESOURCE, after);
const POST = 'app/resources/post/post.resource.js';

describe('protected paths', () => {
  test('globs with a trailing ** cover everything below', () => {
    assert.ok(globToRegex('calm/auth/**').test('calm/auth/index.js'));
    assert.ok(globToRegex('calm/auth/**').test('calm/auth/deep/er/file.js'));
    assert.ok(!globToRegex('calm/auth/**').test('calm/authx/index.js'));
    assert.ok(globToRegex('src/**/*.service.js').test('src/modules/post/post.service.js'), 'the advisory form still works');
  });

  test('isProtected: config globs minus allow globs', () => {
    const session = { protected: DEFAULT_PROTECTED };
    assert.ok(isProtected('calm/auth/index.js', session));
    assert.ok(isProtected('calm/security/audit.js', session));
    assert.ok(isProtected('calm.config.js', session));
    assert.ok(!isProtected('calm/app.js', session));
    assert.ok(!isProtected(POST, session));
    assert.ok(!isProtected('calm/auth/index.js', { ...session, allow: ['calm/auth/**'] }));
    assert.ok(isProtected('calm/security/audit.js', { ...session, allow: ['calm/auth/**'] }));
    assert.ok(!isProtected('calm/auth/index.js', {}), 'nothing protected without globs');
  });

  test('touchesAccessRules: policy and visibility lines in resource files only', () => {
    assert.ok(touchesAccessRules(POST, diffTo(RESOURCE.replace("update: 'owner | admin'", "update: 'public'"))));
    assert.ok(touchesAccessRules(POST, diffTo(RESOURCE.replace(".visibleTo('owner | admin')", ''))));
    assert.ok(touchesAccessRules(POST, diffTo(RESOURCE.replace("f.ref('user').owner()", "f.ref('user')"))));
    assert.ok(touchesAccessRules(POST, diffTo(RESOURCE.replace('max(200),', 'max(200),\n    secret: f.string().hidden(),'))));
    assert.ok(touchesAccessRules(POST, diffTo(RESOURCE.replace('max(200),', 'max(200),\n    ssn: f.string().encrypted(),'))));
    assert.ok(!touchesAccessRules(POST, diffTo(RESOURCE.replace('max(200)', 'max(180)'))), 'a validation change is not an access rule');
    assert.ok(!touchesAccessRules(POST, diffTo(RESOURCE)), 'no change');
    assert.ok(!touchesAccessRules('app/resources/post/post.service.js', diffTo("policy: 'public'")), 'only resource files');
    assert.ok(!touchesAccessRules(POST, null));
  });

  test('protectionReason names the reason, allow globs lift both', () => {
    const session = { protected: DEFAULT_PROTECTED, allow: [] };
    assert.equal(protectionReason('calm/auth/index.js', null, session), 'protected path');
    assert.equal(protectionReason(POST, diffTo(RESOURCE.replace("list: 'public'", "list: 'authenticated'")), session), 'access rules');
    assert.equal(protectionReason(POST, diffTo(RESOURCE.replace('max(200)', 'max(10)')), session), null);
    assert.equal(protectionReason(POST, diffTo(RESOURCE.replace("list: 'public'", "list: 'authenticated'")), { ...session, allow: ['app/resources/**'] }), null);
  });
});

describe('agent scopes', () => {
  test('tool sets', () => {
    assert.deepEqual(SCOPES, ['read', 'scaffold', 'full']);
    for (const t of ['calm_project', 'calm_routes', 'calm_doctor', 'calm_activity', 'calm_propose', 'calm_diff', 'calm_explain', 'calm_about']) assert.equal(neededScope(t), 'read', t);
    for (const t of ['calm_make_resource', 'calm_add_block', 'calm_checkpoint']) assert.equal(neededScope(t), 'scaffold', t);
    assert.equal(neededScope('calm_restore'), 'full');
    assert.equal(neededScope('calm_something_new'), 'full', 'unknown tools are full only');
    assert.equal(neededScope('calm_http', { method: 'GET' }), 'read');
    assert.equal(neededScope('calm_http', { method: 'get' }), 'read');
    assert.equal(neededScope('calm_http'), 'read');
    assert.equal(neededScope('calm_http', { method: 'DELETE' }), 'scaffold');
    assert.ok(allowedIn('read', 'calm_project'));
    assert.ok(!allowedIn('read', 'calm_make_resource'));
    assert.ok(allowedIn('scaffold', 'calm_make_resource'));
    assert.ok(!allowedIn('scaffold', 'calm_restore'));
    assert.ok(allowedIn('full', 'calm_restore'));
    assert.ok(allowedIn('full', 'calm_whatever'));
    assert.ok(!allowedIn('read', 'calm_http', { method: 'POST' }));
    assert.ok(allowedIn('scaffold', 'calm_http', { method: 'POST' }));
  });

  test('refusal text and annotated descriptions', () => {
    assert.equal(refusalText('scaffold', 'calm_restore'), 'Refused: scope "scaffold" cannot run calm_restore. Ask the developer to start the server with `calm mcp --scope full`, or describe the change with calm_propose so they can apply it.');
    assert.match(refusalText('read', 'calm_http', { method: 'patch' }), /cannot run calm_http with PATCH\. .*--scope scaffold/);
    const tools = [{ name: 'calm_project', description: 'A.' }, { name: 'calm_restore', description: 'B.' }, { name: 'calm_http', description: 'C.' }];
    const read = annotateTools(tools, 'read').map((t) => t.description);
    assert.equal(read[0], 'A.');
    assert.equal(read[1], 'B. Not available in the current scope (read): ask the developer to run calm mcp --scope full.');
    assert.match(read[2], /^C\. Only GET is available/);
    assert.deepEqual(annotateTools(tools, 'full'), tools);
  });

  test('parseScopeArgs', () => {
    assert.deepEqual(parseScopeArgs([]), { scope: null, allow: [] });
    assert.deepEqual(parseScopeArgs(['--scope', 'read']), { scope: 'read', allow: [] });
    assert.deepEqual(parseScopeArgs(['--scope=scaffold', '--allow', 'calm/auth/**', '--allow=calm.config.js']), { scope: 'scaffold', allow: ['calm/auth/**', 'calm.config.js'] });
    assert.throws(() => parseScopeArgs(['--scope', 'admin']), /Unknown scope "admin"/);
    assert.throws(() => parseScopeArgs(['--scope']), /needs a value/);
  });
});

describe('doctor: agent-protected-edit', () => {
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  const event = (time, path, extra = {}) => `${JSON.stringify({ time, type: 'file', path, change: 'modified', actor: { kind: 'agent', name: 'claude-code' }, diff: null, ...extra })}\n`;

  test('lists protected agent edits newer than the last commit that are still uncommitted', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calm-agentcheck-'));
    try {
      mkdirSync(join(dir, '.calm'), { recursive: true });
      mkdirSync(join(dir, 'calm', 'auth'), { recursive: true });
      mkdirSync(join(dir, 'app', 'resources', 'post'), { recursive: true });
      writeFileSync(join(dir, 'calm', 'auth', 'index.js'), 'export const a = 1;\n');
      writeFileSync(join(dir, 'app', 'resources', 'post', 'post.resource.js'), RESOURCE);
      writeFileSync(join(dir, 'calm.config.js'), 'export default {};\n');
      git(dir, 'init', '-q');
      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'base');
      const before = new Date(Date.now() - 3_600_000).toISOString();
      const after = new Date(Date.now() + 5_000).toISOString();
      writeFileSync(join(dir, 'calm', 'auth', 'index.js'), 'export const a = 2;\n');
      writeFileSync(join(dir, 'app', 'resources', 'post', 'post.resource.js'), RESOURCE.replace("list: 'public'", "list: 'authenticated'"));
      writeFileSync(
        join(dir, '.calm', 'activity.jsonl'),
        event(before, 'calm.config.js', { protected: true, reason: 'protected path' }) + // older than the commit
          event(after, 'calm/auth/index.js', { protected: true, reason: 'protected path', scope: 'full' }) +
          event(after, 'app/resources/post/post.resource.js', { protected: true, reason: 'access rules' }) +
          event(after, 'calm/security/audit.js', { protected: true, reason: 'protected path' }) + // reverted: git sees no change
          event(after, 'app/routes.js'), // not protected
      );
      const findings = await agentChecks(dir, capture);
      assert.deepEqual(findings.map((f) => f.file).sort(), ['app/resources/post/post.resource.js', 'calm/auth/index.js']);
      const auth = findings.find((f) => f.file === 'calm/auth/index.js');
      assert.equal(auth.level, 'warn');
      assert.equal(auth.id, 'agent-protected-edit');
      assert.equal(auth.title, 'calm/auth/index.js was changed by an agent (claude-code) and is not committed');
      assert.match(auth.detail, /devtools Activity/);
      assert.match(findings.find((f) => f.file.endsWith('.resource.js')).detail, /access rules/);

      git(dir, 'add', '-A');
      git(dir, 'commit', '-q', '-m', 'reviewed');
      await new Promise((r) => setTimeout(r, 1100)); // git commit times are whole seconds
      assert.deepEqual(await agentChecks(dir, capture), [], 'committed edits are not findings');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('skipped without git or without an activity file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'calm-agentcheck-'));
    try {
      assert.deepEqual(await agentChecks(dir, capture), []);
      mkdirSync(join(dir, '.calm'));
      writeFileSync(join(dir, '.calm', 'activity.jsonl'), event(new Date().toISOString(), 'calm/auth/index.js', { protected: true }));
      assert.deepEqual(await agentChecks(dir, capture), [], 'no .git');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
