import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082', 'hex');

let project;
let t;
let alice;
let bob;
let admin;
const mails = [];
const uploadDir = mkdtempSync(join(tmpdir(), 'calm-uploads-'));

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({
    files: {
      'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  softDelete: true,
  fields: { text: f.string().required(), secret: f.string().hidden(), author: f.ref('user').owner() },
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
      'app/resources/note/note.service.js': `
import { ResourceService } from '#calm';
export default class NoteService extends ResourceService {
  async beforeCreate(data) { return { ...data, secret: 'classified' }; }
  async beforeUpdate(data) { return { ...data, secret: 'rotated' }; }
}`,
    },
  });
  calm(project.dir, 'add', 'jobs', 'audit-log', 'soft-delete', 'realtime-sse', 'mcp-server', 'storage-local', 'api-docs', 'rate-limit-mongo', '--yes', '--no-install');
  process.env.UPLOAD_DIR = uploadDir;
  t = await project.testApp({ rateLimit: { enabled: true, global: { windowMs: 60_000, max: 10_000 }, auth: { windowMs: 60_000, max: 1000 } } });
  t.app.mailer.observe((m) => mails.push(m));
  [alice, bob, admin] = [await t.signup({ name: 'Alice' }), await t.signup({ name: 'Bob' }), await t.signup({ name: 'Admin', roles: ['user', 'admin'] })];
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

describe('calm add', () => {
  test('writes files, dependencies, env vars and the lock', () => {
    for (const f of ['app/blocks/jobs/index.js', 'app/jobs/welcome-email.js', 'app/resources/file/file.routes.js', 'app/blocks/mcp-server/index.js']) {
      assert.ok(existsSync(join(project.dir, f)), f);
    }
    const pkg = JSON.parse(readFileSync(join(project.dir, 'package.json'), 'utf8'));
    assert.equal(pkg.dependencies.multer, '^2.4.0');
    assert.match(readFileSync(join(project.dir, '.env.example'), 'utf8'), /UPLOAD_MAX_MB=10/);
    const lock = JSON.parse(readFileSync(join(project.dir, 'calm.lock'), 'utf8'));
    assert.ok(lock.blocks['@calmapi/jobs'].files['app/blocks/jobs/index.js'].startsWith('sha256:'));
  });

  test('refuses conflicting blocks and re-adding is a no-op', () => {
    assert.throws(() => calm(project.dir, 'add', 'storage-s3', '--yes', '--no-install'), /cannot be installed together with storage-local/);
    const again = calm(project.dir, 'add', 'jobs', '--yes', '--no-install');
    assert.match(again, /unchanged\s+app\/blocks\/jobs\/index\.js/);
  });

  test('the app boots with every block and doctor stays clean', async () => {
    assert.deepEqual(t.app.plugins.map((p) => p.name).sort(), ['api-docs', 'audit-log', 'jobs', 'mcp-server', 'rate-limit-mongo', 'realtime-sse', 'soft-delete', 'storage-local']);
    assert.deepEqual((await t.app.doctor()).filter((f) => f.level === 'error'), []);
  });
});

describe('api-docs', () => {
  test('serves the reference with its own CSP', async () => {
    const res = await fetch(`${t.origin}/docs`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy'), /cdn\.jsdelivr\.net/);
    assert.match(await res.text(), /@scalar\/api-reference@1\.72\.1/);
  });
});

describe('storage-local', () => {
  const upload = (who, buffer, type, name = 'pixel.png') => {
    const form = new FormData();
    form.append('file', new Blob([buffer], { type }), name);
    return fetch(`${t.origin}/api/files/upload`, { method: 'POST', body: form, headers: who ? { authorization: `Bearer ${who.token}` } : {} });
  };

  test('uploads, downloads privately and deletes from disk', async () => {
    const res = await upload(alice, PNG, 'image/png');
    assert.equal(res.status, 201);
    const file = (await res.json()).data;
    assert.equal(file.mimeType, 'image/png');
    assert.equal(file.size, PNG.length);
    assert.equal(file.key, undefined, 'storage key is hidden');
    assert.equal(readdirSync(uploadDir).length, 1);

    const dl = await fetch(`${t.origin}/api/files/${file.id}/download`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /^inline/);
    assert.deepEqual(Buffer.from(await dl.arrayBuffer()), PNG);
    assert.equal((await t.get(`/files/${file.id}/download`, bob)).status, 404);

    assert.equal((await t.delete(`/files/${file.id}`, alice)).status, 204);
    assert.equal(readdirSync(uploadDir).length, 0);
  });

  test('rejects anonymous uploads, wrong types and spoofed content', async () => {
    assert.equal((await upload(null, PNG, 'image/png')).status, 401);
    assert.equal((await upload(alice, Buffer.from('<script>alert(1)</script>'), 'text/html', 'x.html')).status, 400);
    const spoofed = await upload(alice, Buffer.from('<svg onload=alert(1)>'), 'image/png');
    assert.equal(spoofed.status, 400);
    assert.match((await spoofed.json()).error.message, /does not match/);
    assert.equal(readdirSync(uploadDir).length, 0, 'rejected files are removed');
  });
});

describe('jobs', () => {
  test('event-triggered job runs and sends mail', async () => {
    const carol = await t.signup({ name: 'Carol' });
    await t.idle();
    const queued = await t.app.ext.jobs.Job.find({ name: 'welcome-email' }).lean();
    assert.ok(queued.some((j) => j.data.user.email === carol.email));
    await t.app.ext.jobs.drain();
    assert.ok(mails.some((m) => m.to === carol.email && /Welcome/.test(m.subject)));
  });

  test('failing jobs retry then fail; admins see them', async () => {
    let calls = 0;
    t.app.ext.jobs.define({ name: 'flaky', retries: 1, backoff: 1, run: () => { calls++; throw new Error('nope'); } });
    const job = await t.app.ext.jobs.enqueue('flaky', {});
    await t.app.ext.jobs.drain();
    await new Promise((r) => setTimeout(r, 20));
    await t.app.ext.jobs.drain();
    const stored = await t.app.ext.jobs.Job.findById(job._id).lean();
    assert.equal(calls, 2);
    assert.equal(stored.status, 'failed');
    const list = await t.get('/jobs?status=failed', admin);
    assert.equal(list.status, 200);
    assert.ok(list.body.data.some((j) => j.name === 'flaky'));
    assert.equal((await t.get('/jobs', alice)).status, 403);
    const retried = await t.post(`/jobs/${job._id}/retry`, {}, admin);
    assert.equal(retried.body.data.status, 'queued');
  });

  test('cron and interval schedules', async () => {
    const { parseSchedule, nextRun } = await project.load('app/blocks/jobs/cron.js');
    const at = (iso, expr) => nextRun(parseSchedule(expr), new Date(iso)).toISOString();
    assert.equal(at('2026-10-10T10:07:30Z', '*/15 * * * *'), '2026-10-10T10:15:00.000Z');
    assert.equal(at('2026-10-10T10:07:00Z', '0 9 * * 1-5'), '2026-10-12T09:00:00.000Z', 'Saturday -> Monday 9:00');
    assert.equal(at('2026-10-10T10:00:00Z', '@daily'), '2026-10-11T00:00:00.000Z');
    assert.equal(at('2026-10-10T10:00:00Z', 'every 5m'), '2026-10-10T10:05:00.000Z');
    assert.throws(() => parseSchedule('61 * * * *'), /Invalid cron/);
  });
});

describe('audit-log and soft-delete', () => {
  test('records diffs without private values, and deletes are reversible', async () => {
    const note = (await t.post('/notes', { text: 'v1' }, alice)).body.data;
    await t.patch(`/notes/${note.id}`, { text: 'v2' }, alice);
    assert.equal((await t.delete(`/notes/${note.id}`, alice)).status, 204);
    await t.idle();

    assert.equal((await t.get(`/notes/${note.id}`, alice)).status, 404, 'soft deleted records disappear');
    const raw = await t.app.model('note').collection.findOne({});
    assert.ok(raw.deletedAt, 'but stay in the database');

    const trail = await t.get(`/audit-log?resource=note&recordId=${note.id}`, admin);
    assert.deepEqual(trail.body.data.map((e) => e.action), ['deleted', 'updated', 'created']);
    const update = trail.body.data.find((e) => e.action === 'updated');
    assert.deepEqual(update.changes.text, { from: 'v1', to: 'v2' });
    assert.deepEqual(update.changes.secret, { changed: true }, 'hidden values are never logged');
    assert.equal(update.user.name, 'Alice');
    assert.equal((await t.get('/audit-log', alice)).status, 403);

    const trash = await t.get('/notes/trash', admin);
    assert.equal(trash.body.data.length, 1);
    assert.equal((await t.post(`/notes/${note.id}/restore`, {}, admin)).status, 200);
    assert.equal((await t.get(`/notes/${note.id}`, alice)).status, 200);
  });
});

describe('realtime-sse', () => {
  async function listen(url, ms = 400) {
    const ctrl = new AbortController();
    const res = await fetch(url, { signal: ctrl.signal });
    const events = [];
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const done = (async () => {
      try {
        for (;;) {
          const { value, done: end } = await reader.read();
          if (end) break;
          buffer += decoder.decode(value, { stream: true });
          let i;
          while ((i = buffer.indexOf('\n\n')) !== -1) {
            const frame = buffer.slice(0, i);
            buffer = buffer.slice(i + 2);
            const event = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (event) events.push({ event, data: data ? JSON.parse(data) : null });
          }
        }
      } catch {
        // aborted
      }
    })();
    return { status: res.status, events, stop: async () => { await new Promise((r) => setTimeout(r, ms)); ctrl.abort(); await done; } };
  }

  test('streams only what each subscriber may read', async () => {
    const anon = await listen(`${t.origin}/api/realtime/stream?resources=post`);
    const ticket = (await t.post('/realtime/ticket', {}, alice)).body.data.ticket;
    const mine = await listen(`${t.origin}/api/realtime/stream?resources=post&ticket=${ticket}`);
    assert.equal(mine.status, 200);

    await t.post('/posts', { title: 'Secret draft', body: 'x' }, alice);
    await t.post('/posts', { title: 'Hello world', body: 'x', status: 'published' }, alice);
    await t.idle();
    await Promise.all([anon.stop(), mine.stop()]);

    const titles = (s) => s.events.filter((e) => e.event === 'post.created').map((e) => e.data.title);
    assert.deepEqual(titles(anon), ['Hello world'], 'anonymous: published only');
    assert.deepEqual(titles(mine), ['Secret draft', 'Hello world'], 'author also sees own draft');
    assert.ok(anon.events.every((e) => e.data?.author?.email === undefined));

    const reused = await fetch(`${t.origin}/api/realtime/stream?resources=post&ticket=${ticket}`);
    assert.equal(reused.status, 401, 'tickets are single use');
  });
});

describe('mcp-server', () => {
  const rpc = (body, token, headers = {}) =>
    fetch(`${t.origin}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: JSON.stringify(body),
    });

  test('lists resource tools and enforces API policies on calls', async () => {
    const init = await (await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })).json();
    assert.equal(init.result.protocolVersion, '2025-06-18');
    assert.equal((await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);

    const { result } = await (await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json();
    const names = result.tools.map((x) => x.name);
    assert.ok(names.includes('post_list') && names.includes('post_create') && names.includes('note_delete'));
    assert.ok(!names.some((n) => n.startsWith('user_')), 'users are not exposed by default');

    const call = (name, args, token) => rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name, arguments: args } }, token).then((r) => r.json());
    const anon = await call('post_create', { data: { title: 'From an agent', body: 'x' } });
    assert.equal(anon.result.isError, true);
    const created = await call('post_create', { data: { title: 'From an agent', body: 'x', status: 'published' } }, alice.token);
    assert.equal(created.result.isError, false);
    const post = JSON.parse(created.result.content[0].text).data;
    assert.equal(post.author, alice.id);
    const edit = await call('post_update', { id: post.id, data: { title: 'Hijacked' } }, bob.token);
    assert.equal(edit.result.isError, true, 'bob cannot edit alice post through MCP either');
    const listed = await call('post_list', { filter: { status: 'published' }, q: 'agent' });
    assert.equal(JSON.parse(listed.result.content[0].text).meta.total, 1);
  });

  test('rejects foreign origins and non-POST', async () => {
    assert.equal((await rpc({ jsonrpc: '2.0', id: 1, method: 'ping' }, null, { origin: 'https://evil.example.com' })).status, 403);
    assert.equal((await fetch(`${t.origin}/mcp`)).status, 405);
  });
});

describe('rate-limit-mongo', () => {
  test('counters live in MongoDB', async () => {
    await t.get('/posts');
    const count = await t.app.mongoose.connection.collection('calm_rate_limits').countDocuments();
    assert.ok(count >= 1);
  });
});

describe('storage-s3 and mail blocks', () => {
  test('presigned uploads without any network', async () => {
    const p = await makeProject();
    try {
      calm(p.dir, 'add', 'storage-s3', 'mail-resend', '--yes', '--no-install');
      Object.assign(process.env, { S3_BUCKET: 'test-bucket', S3_REGION: 'us-east-1', S3_ACCESS_KEY_ID: 'AKIAEXAMPLE', S3_SECRET_ACCESS_KEY: 'secret', S3_ENDPOINT: 'http://127.0.0.1:9', RESEND_API_KEY: 're_test' });
      const s = await p.testApp();
      try {
        assert.equal(s.app.mailer.transport, 'resend');
        const u = await s.signup();
        const res = await s.post('/files/presign', { fileName: 'cat.png', contentType: 'image/png', size: 1234 }, u);
        assert.equal(res.status, 201);
        assert.match(res.body.data.upload.url, /X-Amz-Signature=/);
        assert.equal(res.body.data.file.status, 'pending');
        assert.equal(res.body.data.file.key, undefined);
        assert.equal((await s.post('/files/presign', { fileName: 'x.exe', contentType: 'application/x-msdownload', size: 10 }, u)).status, 400);
        assert.equal((await s.post('/files/presign', { fileName: 'big.png', contentType: 'image/png', size: 50 * 1024 * 1024 }, u)).status, 400);
      } finally {
        await s.close();
      }
    } finally {
      for (const k of ['S3_BUCKET', 'S3_REGION', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY', 'S3_ENDPOINT', 'RESEND_API_KEY']) delete process.env[k];
      p.cleanup();
    }
  });
});
