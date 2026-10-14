import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// A fake Postmark /email endpoint answering in the documented format.
const seen = [];
let server;
let origin;
let project;
let t;
const token = ['pm', 'server', 'token', Date.now()].join('-'); // built at runtime: no secret-shaped literal

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      const send = (status, json) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(json));
      if (req.url !== '/email') return send(404, {});
      if (req.headers['x-postmark-server-token'] !== token) return send(401, { ErrorCode: 10, Message: 'The Server Token you provided in the X-Postmark-Server-Token request header was invalid.' });
      if (body.To.includes('bounced@')) return send(422, { ErrorCode: 406, Message: 'You tried to send to recipient(s) that have been marked as inactive.' });
      send(200, { To: body.To, SubmittedAt: '2026-10-13T10:00:00Z', MessageID: `msg-${seen.length}`, ErrorCode: 0, Message: 'OK' });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  calm(project.dir, 'add', 'mail-postmark', '--yes', '--no-install');
  process.env.POSTMARK_SERVER_TOKEN = token;
  process.env.MAIL_FROM = 'Acme <hello@acme.test>';
  t = await project.testApp({ blocks: { 'mail-postmark': { apiBase: origin, trackLinks: 'HtmlOnly' } } });
});

after(async () => {
  await t?.close();
  project?.cleanup();
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.MAIL_FROM;
  await new Promise((resolve) => server.close(resolve));
});

test('mail-postmark: the request has the documented shape', async () => {
  assert.equal(t.app.mailer.transport, 'postmark');
  const out = await t.app.mailer.send({
    to: ['a@example.test', 'b@example.test'],
    cc: 'c@example.test',
    replyTo: 'support@acme.test',
    subject: 'Your invoice',
    text: 'See attached',
    html: '<p>See attached</p>',
    headers: { 'X-Invoice': 42 },
    metadata: { invoiceId: 42 },
    attachments: [{ filename: 'invoice.txt', content: Buffer.from('total: 42'), contentType: 'text/plain' }, { filename: 'logo.png', content: 'iVBORw0KGgo=', contentType: 'image/png', cid: 'logo' }],
    meta: { kind: 'invoice', token: 'never-sent' },
  });
  assert.equal(out.id, `msg-${seen.length}`);
  const call = seen.at(-1);
  assert.equal(call.method, 'POST');
  assert.equal(call.headers['x-postmark-server-token'], token);
  assert.equal(call.headers.accept, 'application/json');
  const b = call.body;
  assert.equal(b.From, 'Acme <hello@acme.test>');
  assert.equal(b.To, 'a@example.test, b@example.test');
  assert.equal(b.Cc, 'c@example.test');
  assert.equal(b.ReplyTo, 'support@acme.test');
  assert.equal(b.Subject, 'Your invoice');
  assert.equal(b.TextBody, 'See attached');
  assert.equal(b.HtmlBody, '<p>See attached</p>');
  assert.equal(b.MessageStream, 'outbound');
  assert.equal(b.Tag, 'invoice', 'the tag comes from meta.kind');
  assert.deepEqual(b.Metadata, { invoiceId: '42' });
  assert.deepEqual(b.Headers, [{ Name: 'X-Invoice', Value: '42' }]);
  assert.equal(b.TrackLinks, 'HtmlOnly');
  assert.deepEqual(b.Attachments[0], { Name: 'invoice.txt', Content: Buffer.from('total: 42').toString('base64'), ContentType: 'text/plain' });
  assert.equal(b.Attachments[1].ContentID, 'cid:logo');
  assert.ok(!JSON.stringify(b).includes('never-sent'), 'meta is never forwarded');
});

test('mail-postmark: core emails are tagged, and Postmark errors are clear', async () => {
  const u = await t.signup();
  await t.post('/auth/password/forgot', { email: u.email });
  await t.idle();
  const reset = seen.at(-1).body;
  assert.equal(reset.To, u.email);
  assert.equal(reset.Tag, 'password-reset');
  assert.equal(reset.Metadata, undefined);

  await assert.rejects(() => t.app.mailer.send({ to: 'bounced@example.test', subject: 'Hi', text: 'x' }), (err) => {
    assert.equal(err.name, 'PostmarkError');
    assert.equal(err.errorCode, 406);
    assert.equal(err.inactiveRecipient, true);
    assert.match(err.message, /HTTP 422, ErrorCode 406.*inactive/);
    return true;
  });
  await assert.rejects(() => t.app.mailer.send({ to: 'x@example.test', subject: 'No body' }), /needs text or html/);
});

test('mail-postmark: a message stream per message, and doctor wants the token in production', async () => {
  await t.app.mailer.send({ to: 'news@example.test', subject: 'News', text: 'x', messageStream: 'broadcast', tag: 'weekly' });
  assert.equal(seen.at(-1).body.MessageStream, 'broadcast');
  assert.equal(seen.at(-1).body.Tag, 'weekly');

  delete process.env.POSTMARK_SERVER_TOKEN;
  process.env.APP_URL = 'https://acme.test'; // production refuses to boot without it
  const prod = await project.testApp({ mode: 'production' });
  try {
    assert.ok((await prod.app.doctor()).some((f) => f.id === 'postmark-token' && f.level === 'error'));
    assert.equal(prod.app.mailer.transport, null);
  } finally {
    await prod.close();
    delete process.env.APP_URL;
  }
  process.env.POSTMARK_SERVER_TOKEN = token;
});
