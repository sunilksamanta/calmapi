import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, statSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tsType, clientOperations, generateClient, writeClientFile } from '../../core/client.js';
import { makeProject, ROOT } from '../helpers.js';

// calm client: a typed, dependency-free client generated from the app's own OpenAPI document.

let project;
let t;
let doc;
const calm = (...args) => execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: project.dir, env: { ...process.env, CI: '1', NO_COLOR: '1' } }).toString();

before(async () => {
  project = await makeProject();
  t = await project.testApp();
  doc = t.app.openapi();
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

test('JSON Schema to TypeScript', () => {
  assert.equal(tsType({ type: 'string' }), 'string');
  assert.equal(tsType({ type: 'integer', nullable: true }), 'number | null');
  assert.equal(tsType({ enum: ['draft', 'live'] }), '"draft" | "live"');
  assert.equal(tsType({ type: 'array', items: { $ref: '#/components/schemas/Product' } }), 'Product[]');
  assert.equal(tsType({ type: 'array', items: { enum: ['a', 'b'] } }), '("a" | "b")[]');
  assert.equal(tsType({ oneOf: [{ type: 'string' }, { type: 'number' }] }), 'string | number');
  assert.equal(tsType({}), 'unknown');
  assert.equal(tsType({ type: 'object', additionalProperties: { type: 'string' } }), 'Record<string, string>');
  const obj = tsType({ type: 'object', required: ['a'], properties: { a: { type: 'string' }, 'b-c': { type: 'boolean', readOnly: true } } });
  assert.match(obj, /^\{\n {2}a: string;\n {2}\/\*\* Set by the server\. \*\/\n {2}"b-c"\?: boolean;\n\}$/);
  assert.equal(tsType({ type: 'object', properties: { x: { description: 'ends */ here', type: 'string' } } }).includes('*/ here'), false, 'comments cannot be closed from a description');
});

test('routes become grouped, readable functions', () => {
  const ops = clientOperations(doc);
  const names = (group) => ops.filter((o) => o.group === group).map((o) => o.name).sort();
  assert.deepEqual(names('posts'), ['create', 'delete', 'featured', 'get', 'list', 'publish', 'update']);
  assert.ok(['register', 'login', 'logout', 'logoutAll', 'me', 'updateMe', 'passwordForgot', 'passwordReset', 'sessions', 'deleteSessions', 'devices', 'createDevices'].every((n) => names('auth').includes(n)), names('auth').join(','));
  const list = ops.find((o) => o.group === 'posts' && o.name === 'list');
  assert.equal(list.result, 'Page<Post>');
  assert.equal(list.unwrap, false, 'a page keeps data and meta');
  assert.equal(ops.find((o) => o.group === 'posts' && o.name === 'get').result, 'Post');
  assert.equal(ops.find((o) => o.group === 'posts' && o.name === 'delete').result, 'void');
  assert.match(ops.find((o) => o.group === 'auth' && o.name === 'login').result, /token: string;[\s\S]*mfaRequired: true;/, 'auth routes are typed (session or second factor)');
  const keys = ops.map((o) => `${o.group}.${o.name}`);
  assert.equal(new Set(keys).size, keys.length, 'no two functions share a name');
});

test('the TypeScript output compiles in strict mode', (ctx) => {
  let tsc;
  try {
    tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');
  } catch {
    try {
      tsc = createRequire('/opt/node22/lib/node_modules/').resolve('typescript/bin/tsc');
    } catch {
      return ctx.skip('typescript is not installed');
    }
  }
  const dir = mkdtempSync(join(tmpdir(), 'calm-client-'));
  try {
    writeFileSync(join(dir, 'calm-client.ts'), generateClient(doc));
    writeFileSync(join(dir, 'use.ts'), `import { createClient, CalmApiError, type Post, type Page } from './calm-client';
const api = createClient({ baseUrl: 'http://localhost:5001', token: () => 'x' });
async function main(): Promise<void> {
  const page: Page<Post> = await api.posts.list({ sort: '-createdAt', limit: 5 });
  const first: Post | undefined = page.data[0];
  const created: Post = await api.posts.create({ title: 'Hi' } as any);
  const session = await api.auth.login({ email: 'a@b.c', password: 'x' });
  if ('token' in session) api.setToken(session.token);
  try { await api.posts.delete(created.id ?? ''); } catch (err) { if (err instanceof CalmApiError) console.log(err.code, err.details, first); }
}
main();
`);
    const { js, dts } = generateClient(doc, { lang: 'js' });
    writeFileSync(join(dir, 'client.js'), js);
    writeFileSync(join(dir, 'client.d.ts'), dts);
    const flags = ['--strict', '--noEmit', '--target', 'es2022', '--lib', 'es2022,dom', '--module', 'esnext', '--moduleResolution', 'bundler', '--skipLibCheck', 'false'];
    execFileSync(process.execPath, [tsc, ...flags, join(dir, 'use.ts')], { stdio: 'pipe' });
    execFileSync(process.execPath, [tsc, ...flags, join(dir, 'client.d.ts')], { stdio: 'pipe' });
  } catch (err) {
    assert.fail(String(err.stdout ?? err));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the generated client talks to the real API: sign up, CRUD, pages, typed errors, 401 hook', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'calm-client-'));
  try {
    const { js } = generateClient(doc, { lang: 'js' });
    const file = join(dir, 'client.mjs');
    writeFileSync(file, js);
    const { createClient, CalmApiError } = await import(pathToFileURL(file).href);
    let token = null;
    const unauthorized = [];
    const api = createClient({ baseUrl: t.origin, token: () => token, onUnauthorized: (err) => unauthorized.push(err.status) });

    const reg = await api.auth.register({ name: 'Client', email: 'client@example.com', password: 'stormy-harbor-92' });
    assert.match(reg.token, /\S{20,}/, 'unwrapped { user, token }');
    assert.equal(reg.user.email, 'client@example.com');
    token = reg.token;
    assert.equal((await api.auth.me()).email, 'client@example.com');

    const post = await api.posts.create({ title: 'From the client', body: 'Hello' });
    assert.equal(post.title, 'From the client');
    const page = await api.posts.list({ q: 'client', limit: 5 });
    assert.ok(page.data.some((p) => p.id === post.id));
    assert.equal(page.meta.limit, 5);
    assert.equal((await api.posts.update(post.id, { title: 'Edited' })).title, 'Edited');
    assert.equal(await api.posts.delete(post.id), undefined);

    await assert.rejects(api.posts.get(post.id), (err) => err instanceof CalmApiError && err.status === 404 && err.code === 'NOT_FOUND' && Boolean(err.requestId));
    await assert.rejects(api.posts.create({ nope: true }), (err) => err.status === 422 && err.code === 'VALIDATION_ERROR' && typeof err.details === 'object');
    token = null;
    await assert.rejects(api.auth.me(), (err) => err.status === 401);
    assert.deepEqual(unauthorized, [401]);
    api.setToken(reg.token);
    assert.equal((await api.auth.me()).email, 'client@example.com', 'setToken replaces the token');
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(api.auth.me({ signal: ctrl.signal }), { name: 'AbortError' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('calm client writes TypeScript, or JavaScript with a .d.ts, and leaves unchanged files alone', () => {
  const ts = calm('client', '--out', 'web/api/calm-client.ts');
  assert.match(ts, /Wrote web\/api\/calm-client\.ts \(\d+ routes in \d+ groups\)/);
  const file = join(project.dir, 'web/api/calm-client.ts');
  assert.match(readFileSync(file, 'utf8'), /export function createClient\(options: ClientOptions = \{\}\): CalmClient/);
  const before = statSync(file).mtimeMs;
  calm('client', '--out', 'web/api/calm-client.ts');
  assert.equal(statSync(file).mtimeMs, before, 'same content: not rewritten');
  calm('client', '--out', 'app-js/client.js', '--js');
  assert.ok(existsSync(join(project.dir, 'app-js/client.js')) && existsSync(join(project.dir, 'app-js/client.d.ts')));
  assert.doesNotMatch(readFileSync(join(project.dir, 'app-js/client.js'), 'utf8'), /: string|‹|›/, 'no TypeScript left in the JS output');
  assert.match(calm('client', '--stdout'), /export interface CalmClient/);
});

test('client.out in calm.config.js: the dev server keeps the file current', () => {
  const out = join(project.dir, 'web/live/calm-client.ts');
  const app = { root: project.dir, config: { ...t.app.config, client: { out: 'web/live/calm-client.ts' } }, openapi: () => doc };
  assert.deepEqual(writeClientFile(app), { file: out, changed: true });
  assert.deepEqual(writeClientFile(app), { file: out, changed: false });
  assert.equal(writeClientFile({ ...app, config: { ...app.config, client: { out: null } } }), null);
});

test('agents: calm_client reads in the read scope and writes in scaffold', async () => {
  const { neededScope } = await import('../../src/cli/lib/agent-scope.js');
  assert.equal(neededScope('calm_client', {}), 'read');
  assert.equal(neededScope('calm_client', { out: 'web/calm-client.ts' }), 'scaffold');
});
