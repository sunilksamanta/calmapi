import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, cpSync, symlinkSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const env = { ...process.env, NO_COLOR: '1', CI: '1' };
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env, encoding: 'utf8' });
const calmStatus = (cwd, ...args) => {
  try {
    return { code: 0, out: calm(cwd, ...args) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout}${err.stderr}` };
  }
};
const sha = (s) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

let work;
let app;
before(() => {
  work = mkdtempSync(join(tmpdir(), 'calm-cli-'));
  calm(work, 'create', 'demo-api', '--yes', '--no-install', '--no-git');
  app = join(work, 'demo-api');
  symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
});
after(() => rmSync(work, { recursive: true, force: true }));

describe('create', () => {
  test('scaffolds a complete project', () => {
    for (const f of ['package.json', 'server.js', 'calm.config.js', '.env', '.env.example', '.gitignore', 'AGENTS.md', 'CLAUDE.md', 'Dockerfile', '.dockerignore', 'calm.lock', 'calm/index.js', 'app/resources/user/user.resource.js', 'test/posts.test.js']) {
      assert.ok(existsSync(join(app, f)), f);
    }
    const pkg = JSON.parse(readFileSync(join(app, 'package.json'), 'utf8'));
    assert.equal(pkg.name, 'demo-api');
    assert.equal(pkg.type, 'module');
    assert.deepEqual(Object.keys(pkg.dependencies).sort(), ['express', 'mongoose'], 'two runtime dependencies');
    assert.match(readFileSync(join(app, '.env'), 'utf8'), /MONGODB_URI=mongodb:\/\/127\.0\.0\.1:27017\/demo_api/);
    const lock = JSON.parse(readFileSync(join(app, 'calm.lock'), 'utf8'));
    assert.equal(lock.core['calm/app.js'], sha(readFileSync(join(app, 'calm/app.js'), 'utf8')));
  });

  test('refuses non-empty folders and unknown templates', () => {
    assert.match(calmStatus(work, 'create', 'demo-api', '--yes', '--no-install', '--no-git').out, /not empty/);
    assert.match(calmStatus(work, 'create', 'x', '--template', 'nope', '--yes', '--no-install', '--no-git').out, /Unknown template/);
  });

  test('warns when nothing listens on the MongoDB port, without the password', () => {
    // A port that was free a moment ago: nothing is listening there.
    const port = Number(execFileSync(process.execPath, ['-e', "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"], { encoding: 'utf8' }));
    const out = calm(work, 'create', 'no-mongo', '--db', `mongodb://admin:hunter2@127.0.0.1:${port}/x`, '--yes', '--no-install', '--no-git');
    assert.match(out, new RegExp(`Nothing is listening on 127\\.0\\.0\\.1:${port} yet`));
    assert.match(out, /docker run -d --name mongo/);
    assert.doesNotMatch(out, /hunter2/);
  });

  test('skips the MongoDB check for +srv URIs', () => {
    const out = calm(work, 'create', 'atlas', '--db', 'mongodb+srv://admin:hunter2@cluster0.example.net/x', '--yes', '--no-install', '--no-git');
    assert.match(out, /Skipped the MongoDB check/);
    assert.doesNotMatch(out, /Nothing is listening|hunter2/);
  });

  test('minimal template has no auth', () => {
    calm(work, 'create', 'tiny', '--template', 'minimal', '--yes', '--no-install', '--no-git');
    assert.ok(!existsSync(join(work, 'tiny', 'app/resources/user')));
    assert.ok(existsSync(join(work, 'tiny', 'calm/auth/index.js')), 'auth code is there, unused until a user resource exists');
    symlinkSync(join(ROOT, 'node_modules'), join(work, 'tiny', 'node_modules'), 'dir');
    const { NODE_TEST_CONTEXT: _ctx, ...childEnv } = env; // a nested runner would report over IPC otherwise
    const out = execFileSync(process.execPath, ['--test', '--test-reporter=tap'], { cwd: join(work, 'tiny'), env: childEnv, encoding: 'utf8' });
    assert.match(out, /# pass 1/);
    const routes = JSON.parse(calm(join(work, 'tiny'), 'routes', '--json'));
    assert.deepEqual(routes.map((r) => `${r.method} ${r.path}`), ['GET /api/hello']);
  });
});

describe('make, routes, openapi, doctor', () => {
  test('make resource writes a working resource and test', () => {
    const out = calm(app, 'make', 'resource', 'Invoice', 'number:string!+unique', 'amount:number!', 'status:enum:draft,sent,paid=draft', 'customer:ref:user', 'notes:text', '--service', '--routes');
    assert.match(out, /\/api\/invoices/);
    const src = readFileSync(join(app, 'app/resources/invoice/invoice.resource.js'), 'utf8');
    assert.match(src, /number: f\.string\(\)\.required\(\)\.unique\(\)/);
    assert.match(src, /status: f\.enum\(\['draft', 'sent', 'paid'\]\)\.default\('draft'\),/, 'no modifier added unasked');
    assert.match(src, /customer: f\.ref\('user'\),/);
    assert.match(out, /Clients can only filter and sort on fields you mark/);
    assert.match(out, /amount, status, customer/);
    assert.match(src, /owner: f\.ref\('user'\)\.owner\(\)/);
    assert.ok(existsSync(join(app, 'app/resources/invoice/invoice.service.js')));
    assert.match(calmStatus(app, 'make', 'resource', 'invoice').out, /already exists/);
    assert.match(calmStatus(app, 'make', 'resource', 'x', 'bad:wat').out, /Unknown type "wat"/);
  });

  test('make resource uses a given owner:ref:user as the owner field', () => {
    calm(app, 'make', 'resource', 'memo', 'title:string!', 'owner:ref:user');
    const src = readFileSync(join(app, 'app/resources/memo/memo.resource.js'), 'utf8');
    assert.equal(src.match(/^\s+owner:/gm).length, 1);
    assert.match(src, /owner: f\.ref\('user'\)\.owner\(\)/);
    assert.match(src, /update: 'owner \| admin'/);
  });

  test('routes --json lists policies and sources', () => {
    const routes = JSON.parse(calm(app, 'routes', '--json'));
    const find = (m, p) => routes.find((r) => r.method === m && r.path === p);
    assert.equal(find('GET', '/api/invoices/stats').policy, 'authenticated');
    assert.equal(find('PATCH', '/api/invoices/:id').policy, 'owner | admin');
    assert.equal(find('POST', '/api/auth/login').policy, 'public');
    assert.ok(routes.findIndex((r) => r.path === '/api/invoices/stats') < routes.findIndex((r) => r.path === '/api/invoices/:id'), 'custom before CRUD');
  });

  test('routes filters by path and by resource', () => {
    const all = JSON.parse(calm(app, 'routes', '--json'));

    const byPath = calm(app, 'routes', 'INVOICES');
    assert.match(byPath, /\/api\/invoices\/stats/);
    assert.doesNotMatch(byPath, /\/api\/auth\/login/);
    assert.match(byPath, new RegExp(`of ${all.length} routes match path "INVOICES"`));

    const byResource = JSON.parse(calm(app, 'routes', '--resource', 'Invoice', '--json'));
    assert.ok(byResource.length > 0);
    assert.ok(byResource.every((r) => r.resource === 'invoice'));
    assert.deepEqual(byResource, all.filter((r) => r.resource === 'invoice'));

    const both = JSON.parse(calm(app, 'routes', 'stats', '--resource', 'invoice', '--json'));
    assert.deepEqual(both.map((r) => `${r.method} ${r.path}`), ['GET /api/invoices/stats']);
  });

  test('routes says so when nothing matches, and exits 0', () => {
    const none = calmStatus(app, 'routes', 'no-such-path', '--resource', 'invoice');
    assert.equal(none.code, 0);
    assert.match(none.out, /No routes match path "no-such-path" and resource "invoice"\./);
    assert.doesNotMatch(none.out, /METHOD/);
    assert.deepEqual(JSON.parse(calm(app, 'routes', '--resource', 'nope', '--json')), []);
    assert.match(calm(app, 'routes', '--help'), /--resource <name>/);
  });

  test('openapi writes a document', () => {
    calm(app, 'openapi', '--out', 'docs/openapi.json');
    const doc = JSON.parse(readFileSync(join(app, 'docs/openapi.json'), 'utf8'));
    assert.ok(doc.paths['/api/invoices']);
    assert.ok(doc.components.schemas.InvoiceCreate);
  });

  test('doctor passes a fresh project and catches mistakes', () => {
    assert.equal(calmStatus(app, 'doctor', '--ci').code, 0);
    const file = join(app, 'app/resources/invoice/invoice.service.js');
    const original = readFileSync(file, 'utf8');
    writeFileSync(file, `${original}\nexport const makeToken = () => Math.random().toString(36);\n`);
    writeFileSync(join(app, '.gitignore'), 'node_modules/\n');
    const res = calmStatus(app, 'doctor', '--ci', '--json');
    assert.equal(res.code, 1);
    const ids = JSON.parse(res.out).findings.map((f) => f.id);
    assert.ok(ids.includes('weak-random') && ids.includes('env-not-ignored'), ids.join(','));
    writeFileSync(file, original);
    writeFileSync(join(app, '.gitignore'), 'node_modules/\n.env\n');
  });

  test('doctor --prod applies production rules', () => {
    const res = JSON.parse(calmStatus(app, 'doctor', '--prod', '--json').out);
    assert.ok(res.findings.some((f) => f.id === 'no-mail' || f.id === 'config'), JSON.stringify(res.findings.map((f) => f.id)));
  });
});

describe('add checks', () => {
  test('refuses blocks that need a newer calm/', () => {
    const item = join(work, 'future-block.json');
    writeFileSync(item, JSON.stringify({ name: 'future', type: 'registry:item', files: [{ path: 'x', target: 'app/blocks/future/index.js', content: '' }], meta: { calmapi: { minVersion: '99.0.0' } } }));
    assert.match(calmStatus(app, 'add', item, '--yes', '--no-install').out, /needs CalmAPI 99\.0\.0 or newer/);
  });
});

describe('admin', () => {
  test('grants and revokes the admin role', () => {
    const dbName = `calm_admin_${Date.now()}`;
    const envFile = join(app, '.env');
    const original = readFileSync(envFile, 'utf8');
    const base = process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
    writeFileSync(envFile, original.replace(/^MONGODB_URI=.*$/m, `MONGODB_URI=${base.replace(/\/$/, '')}/${dbName}`));
    try {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { createApp } = await import('./calm/index.js');
        const app = await createApp({ root: process.cwd(), config: { mode: 'development', log: { level: 'silent' }, devtools: { enabled: false }, auth: { password: { logN: 10, r: 8, p: 1 } } } });
        await app.start();
        await app.service('user').create({ name: 'Root', email: 'root@example.com', password: 'long-password-1' }, { system: true });
        await app.stop();`], { cwd: app, env });
      assert.match(calm(app, 'admin', 'ROOT@example.com'), /roles: user, admin/);
      assert.match(calm(app, 'admin', 'root@example.com', '--revoke'), /roles: user$/m);
      assert.match(calmStatus(app, 'admin', 'nobody@example.com').out, /No user with email/);
    } finally {
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        const { default: mongoose } = await import('mongoose');
        await mongoose.connect(process.env.URI); await mongoose.connection.dropDatabase(); await mongoose.disconnect();`], { cwd: app, env: { ...env, URI: `${base.replace(/\/$/, '')}/${dbName}` } });
      writeFileSync(envFile, original);
    }
  });
});

describe('upgrade', () => {
  test('three-way merges edited files, updates untouched ones, reports conflicts', () => {
    // Fake an older release: same core with a few differences.
    const oldPkg = join(work, 'calmapi-old');
    cpSync(join(ROOT, 'core'), join(oldPkg, 'core'), { recursive: true });
    const edit = (rel, fn) => writeFileSync(join(oldPkg, 'core', rel), fn(readFileSync(join(oldPkg, 'core', rel), 'utf8')));
    edit('errors.js', (s) => s.replace("'Something went wrong'", "'Something broke'"));
    edit('logger.js', (s) => s.replace('Tiny structured logger.', 'Small structured logger.'));
    edit('mail.js', (s) => s.replace('// Outgoing email.', '// Outgoing email (old).'));
    writeFileSync(join(oldPkg, 'core', 'legacy.js'), 'export const legacy = true;\n');
    unlinkSync(join(oldPkg, 'core', 'testing.js'));

    // Project generated from the old release...
    const proj = join(work, 'upgrade-me');
    calm(work, 'create', 'upgrade-me', '--yes', '--no-install', '--no-git');
    rmSync(join(proj, 'calm'), { recursive: true });
    cpSync(join(oldPkg, 'core'), join(proj, 'calm'), { recursive: true });
    const lock = JSON.parse(readFileSync(join(proj, 'calm.lock'), 'utf8'));
    lock.calmapi = '2.0.0-old';
    lock.core = {};
    for (const rel of ['errors.js', 'logger.js', 'mail.js', 'legacy.js', 'app.js', 'config.js']) lock.core[`calm/${rel}`] = sha(readFileSync(join(proj, 'calm', rel), 'utf8'));
    writeFileSync(join(proj, 'calm.lock'), JSON.stringify(lock));

    // ...then edited by its owner.
    const errorsPath = join(proj, 'calm', 'errors.js');
    writeFileSync(errorsPath, `// my team's note\n${readFileSync(errorsPath, 'utf8')}`);
    const mailPath = join(proj, 'calm', 'mail.js');
    writeFileSync(mailPath, readFileSync(mailPath, 'utf8').replace('// Outgoing email (old).', '// Outgoing email (ours).'));

    const out = calm(proj, 'upgrade', '--base', oldPkg, '--yes');
    assert.match(out, /merge\s+calm\/errors\.js/);
    assert.match(out, /update\s+calm\/logger\.js/);
    assert.match(out, /conflict\s+calm\/mail\.js/);
    assert.match(out, /delete\s+calm\/legacy\.js/);
    assert.match(out, /add\s+calm\/testing\.js/);

    const merged = readFileSync(errorsPath, 'utf8');
    assert.ok(merged.startsWith("// my team's note"), 'kept the edit');
    assert.match(merged, /'Something went wrong'/, 'took the upstream fix');
    assert.match(readFileSync(join(proj, 'calm', 'logger.js'), 'utf8'), /Tiny structured logger/);
    assert.match(readFileSync(mailPath, 'utf8'), /<<<<<<< yours[\s\S]*=======[\s\S]*>>>>>>> calmapi@/);
    assert.ok(!existsSync(join(proj, 'calm', 'legacy.js')));
    assert.ok(existsSync(join(proj, 'calm', 'testing.js')));
    const after = JSON.parse(readFileSync(join(proj, 'calm.lock'), 'utf8'));
    assert.notEqual(after.calmapi, '2.0.0-old');
    // A second run only re-reports the unresolved conflict; merged files are left alone.
    const again = calm(proj, 'upgrade', '--yes');
    assert.doesNotMatch(again, /calm\/errors\.js/);
  });
});

describe('doctor on a CalmAPI 1.x project', () => {
  test('reports the published advisories', () => {
    const v1 = join(work, 'old-v1');
    mkdirSync(join(v1, 'src/modules/user'), { recursive: true });
    mkdirSync(join(v1, 'src/modules/post'), { recursive: true });
    mkdirSync(join(v1, 'src/modules/auth'), { recursive: true });
    mkdirSync(join(v1, 'src/configs'), { recursive: true });
    writeFileSync(join(v1, 'calmapi.json'), '{"name":"calmapi","version":"0.2.5"}');
    writeFileSync(join(v1, 'src/modules/post/post.service.js'), 'export const legacyPattern = 1;');
    writeFileSync(join(v1, 'src/configs/config.js'), 'export const config = {};');
    // A fixture feed: real advisories are published separately.
    const feed = join(work, 'advisories.fixture.json');
    writeFileSync(feed, JSON.stringify({ advisories: [
      { id: 'TEST-1', severity: 'high', project: 'v1', title: 'fixture', detail: 'd', fix: 'f', url: 'u', match: [{ files: 'src/modules/**/*.service.js', pattern: 'legacyPattern' }] },
      { id: 'TEST-2', severity: 'high', project: 'v1', title: 'absent', detail: 'd', fix: 'f', url: 'u', match: [{ files: 'src/configs/config.js', pattern: 'config' }], absent: [{ files: 'src/configs/config.js', pattern: 'export' }] },
      { id: 'TEST-3', severity: 'low', project: 'v2', title: 'other project', detail: 'd', fix: 'f', url: 'u', match: [{ files: 'calmapi.json', pattern: '.' }] },
    ] }));
    const res = (() => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [CALM, 'doctor', '--json', '--ci'], { cwd: v1, env: { ...env, CALM_ADVISORIES: feed }, encoding: 'utf8' }) };
      } catch (err) {
        return { code: err.status, out: err.stdout };
      }
    })();
    assert.equal(res.code, 1);
    const ids = JSON.parse(res.out).findings.map((f) => f.id);
    assert.deepEqual(ids.filter((id) => id.startsWith('TEST-')), ['TEST-1']);
    assert.ok(ids.includes('v1-eol'));
  });
});

describe('mcp', () => {
  test('speaks MCP over stdio', async () => {
    const child = spawn(process.execPath, [CALM, 'mcp'], { cwd: app, env });
    const replies = new Map();
    let buffer = '';
    child.stdout.on('data', (d) => {
      buffer += d;
      let i;
      while ((i = buffer.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buffer.slice(0, i));
        buffer = buffer.slice(i + 1);
        replies.set(msg.id, msg);
      }
    });
    const send = (msg) => child.stdin.write(`${JSON.stringify(msg)}\n`);
    const wait = async (id) => {
      for (let i = 0; i < 300 && !replies.has(id); i++) await new Promise((r) => setTimeout(r, 50));
      return replies.get(id);
    };
    try {
      send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
      const init = await wait(1);
      assert.equal(init.result.protocolVersion, '2025-06-18');
      assert.equal(init.result.serverInfo.name, 'calmapi');
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const tools = (await wait(2)).result.tools.map((t) => t.name);
      assert.ok(['calm_routes', 'calm_make_resource', 'calm_recent_requests', 'calm_pushes', 'calm_diff', 'calm_checkpoint', 'calm_restore', 'calm_propose', 'calm_explain', 'calm_about', 'calm_review', 'calm_declare', 'calm_replay', 'calm_budgets'].every((t) => tools.includes(t)), tools.join(','));
      assert.equal(tools.length, 29);

      send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'calm_make_resource', arguments: { name: 'ticket', fields: ['title:string!', 'priority:enum:low,high=low'] } } });
      const made = await wait(3);
      assert.equal(made.result.isError, false, made.result.content[0].text);
      send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'calm_routes', arguments: {} } });
      const routes = JSON.parse((await wait(4)).result.content[0].text);
      assert.ok(routes.some((r) => r.path === '/api/tickets'));
      send({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'calm_recent_requests', arguments: {} } });
      const offline = await wait(5);
      assert.equal(offline.result.isError, true);
      assert.match(offline.result.content[0].text, /npm run dev/);
      send({ jsonrpc: '2.0', id: 6, method: 'nope' });
      assert.equal((await wait(6)).error.code, -32601);
    } finally {
      child.kill();
    }
  });
});
