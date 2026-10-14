import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

const CALM = join(ROOT, 'bin', 'calm.js');
const calm = (cwd, ...args) => execFileSync(process.execPath, [CALM, ...args], { cwd, env: { ...process.env, NO_COLOR: '1', CI: '1' }, encoding: 'utf8' });

// A fake Slack: an incoming webhook at /services/... and the Web API at /api/chat.postMessage.
// fake.rateLimited answers that many requests with 429 and Retry-After: 1 first.
const seen = [];
const fake = { rateLimited: 0 };
let server;
let origin;
let project;
let t;
const botToken = ['xoxb', 'fake', String(Date.now())].join('-'); // built at runtime: no secret-shaped literal

// Event listeners start background sends: wait for both until nothing is left.
const settle = async (app = t) => {
  for (let i = 0; i < 3; i++) await app.idle();
};

const waitFor = async (fn, what, ms = 5000) => {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
};

before(async () => {
  server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      const record = { at: Date.now(), url: req.url, headers: req.headers, body, status: 200 };
      seen.push(record);
      if (fake.rateLimited > 0) {
        fake.rateLimited -= 1;
        record.status = 429;
        return res.writeHead(429, { 'retry-after': '1', 'content-type': 'text/plain' }).end('rate_limited');
      }
      if (req.url.startsWith('/services/')) return res.writeHead(200, { 'content-type': 'text/plain' }).end('ok');
      if (req.url === '/api/chat.postMessage') {
        const json = (o) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(o));
        if (req.headers.authorization !== `Bearer ${botToken}`) return json({ ok: false, error: 'invalid_auth' });
        if (body.channel === 'CMISSING') return json({ ok: false, error: 'channel_not_found' });
        return json({ ok: true, channel: body.channel, ts: `1700000000.${String(seen.length).padStart(6, '0')}` });
      }
      res.writeHead(404).end('no_service');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;

  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject();
  calm(project.dir, 'add', 'slack', '--yes', '--no-install');
  process.env.SLACK_WEBHOOK_URL = `${origin}/services/T000/B000/hook`;
  t = await project.testApp({
    blocks: {
      slack: {
        events: { 'auth.registered': 'New signup: {user.name} <{user.email}>', 'post.created': (p) => ({ text: `Post ${p.doc.title}`, blocks: [{ type: 'section', text: { type: 'plain_text', text: p.doc.title } }] }) },
        security: { window: 300, maxPerWindow: 2 },
        backoff: [20, 20, 20],
      },
    },
  });
});

after(async () => {
  await t?.close();
  project?.cleanup();
  delete process.env.SLACK_WEBHOOK_URL;
  await new Promise((resolve) => server.close(resolve));
});

const hook = () => seen.filter((s) => s.url.startsWith('/services/') && s.status === 200);
const hookAttempts = () => seen.filter((s) => s.url.startsWith('/services/'));

test('slack: app events become messages, user data is escaped', async () => {
  const before = hook().length;
  const eve = await t.signup({ name: '<!channel> Eve <@U123> & <https://evil.test|click here>' });
  await settle();
  const msg = hook().slice(before).find((s) => s.body.text.startsWith('New signup'));
  assert.equal(msg.body.text, `New signup: &lt;!channel&gt; Eve &lt;@U123&gt; &amp; &lt;https://evil.test|click here&gt; <${eve.email}>`);
  assert.ok(!/<!channel>|<@U123>|<https:\/\/evil/.test(msg.body.text), 'no mention or link can come from user data');
  assert.equal(msg.body.link_names, false);
  assert.equal(msg.body.unfurl_links, false);
  assert.equal(msg.headers['content-type'], 'application/json; charset=utf-8');

  await t.post('/posts', { title: 'Launch <!here>', body: 'x' }, eve);
  await settle();
  const post = hook().at(-1).body;
  assert.equal(post.text, 'Post Launch <!here>', 'functions are responsible for their own output');
  assert.equal(post.blocks[0].type, 'section');

  const { render, escape } = await project.load('app/blocks/slack/index.js');
  assert.equal(render('{a.b} {missing} {n}', { a: { b: '<!everyone>' }, n: 3 }), '&lt;!everyone&gt;  3');
  assert.equal(escape('a & b'), 'a &amp; b');
});

test('slack: a 429 is retried after Retry-After, without blocking the request', async () => {
  const before = hookAttempts().length;
  fake.rateLimited = 1;
  const started = Date.now();
  await t.signup({ name: 'Rita' });
  assert.ok(Date.now() - started < 900, 'the response does not wait for Slack');
  const delivered = await waitFor(() => hookAttempts().slice(before).find((s) => s.status === 200 && s.body.text?.startsWith('New signup: Rita')), 'the retried message');
  const attempts = hookAttempts().slice(before).filter((s) => s.body.text?.startsWith('New signup: Rita'));
  assert.equal(attempts.length, 2, 'one 429, one success');
  assert.ok(delivered.at - attempts[0].at >= 950, `waited ${delivered.at - attempts[0].at}ms for Retry-After: 1`);
  assert.equal(t.app.ext.slack.stats.retried >= 1, true);
});

test('slack: a burst of security events becomes a few alerts and one digest', async () => {
  await settle();
  const before = hook().length;
  for (let i = 0; i < 10; i++) t.app.events.emit('security.login_failed', { email: 'a***@example.test', ip: `10.0.0.${i % 3}`, reason: 'wrong_password' });
  t.app.events.emit('security.account_locked', { email: 'a***@example.test', ip: '10.0.0.1' });
  t.app.events.emit('security.forbidden', { ip: '10.0.0.9', path: '/api/x' }); // ignored by default
  await settle();
  const alerts = hook().slice(before);
  assert.equal(alerts.length, 2, 'maxPerWindow alerts are sent at once');
  assert.match(alerts[0].body.text, /^:rotating_light: \*security\.login_failed\*\nemail: a\*\*\*@example\.test \| ip: 10\.0\.0\.0 \| reason: wrong_password$/);

  const digest = await waitFor(() => hook().slice(before).find((s) => /Security digest/.test(s.body.text)), 'the digest');
  assert.match(digest.body.text, /Security digest: 9 more events in \d+s from 3 IPs: security\.login_failed x8, security\.account_locked x1/);
  await new Promise((r) => setTimeout(r, 350));
  await settle();
  assert.equal(hook().length - before, 3, 'nothing else: forbidden is ignored');
});

test('slack: bot token mode with chat.postMessage, permanent errors are not retried', async () => {
  delete process.env.SLACK_WEBHOOK_URL;
  process.env.SLACK_BOT_TOKEN = botToken;
  process.env.SLACK_CHANNEL = 'C0123456789';
  const bot = await project.testApp({ blocks: { slack: { apiBase: `${origin}/api`, backoff: [10], security: { enabled: false } } } });
  try {
    const slack = bot.app.ext.slack;
    assert.equal(slack.transport, 'bot');
    const out = await slack.send([{ type: 'section', text: { type: 'mrkdwn', text: '*Deploy* finished' } }]);
    assert.equal(out.channel, 'C0123456789');
    const call = seen.at(-1);
    assert.equal(call.url, '/api/chat.postMessage');
    assert.equal(call.headers.authorization, `Bearer ${botToken}`);
    assert.equal(call.body.channel, 'C0123456789');
    assert.equal(call.body.blocks[0].text.text, '*Deploy* finished');
    assert.equal(call.body.text, 'New message', 'a text fallback for notifications');

    const before = seen.length;
    await assert.rejects(() => slack.send({ text: 'hello', channel: 'CMISSING' }), (err) => err.name === 'SlackError' && err.code === 'channel_not_found');
    assert.equal(seen.length - before, 1, 'not retried');
  } finally {
    await bot.close();
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.SLACK_CHANNEL;
    process.env.SLACK_WEBHOOK_URL = `${origin}/services/T000/B000/hook`;
  }
});

test('slack: without configuration messages are only logged, and doctor says so in production', async () => {
  delete process.env.SLACK_WEBHOOK_URL;
  process.env.APP_URL = 'https://acme.test';
  const prod = await project.testApp({ mode: 'production' });
  try {
    assert.equal(prod.app.ext.slack.transport, 'log');
    assert.deepEqual(await prod.app.ext.slack.send('hi'), { skipped: true });
    assert.ok((await prod.app.doctor()).some((f) => f.id === 'slack-config' && f.level === 'error'));
  } finally {
    await prod.close();
    delete process.env.APP_URL;
    process.env.SLACK_WEBHOOK_URL = `${origin}/services/T000/B000/hook`;
  }
});
