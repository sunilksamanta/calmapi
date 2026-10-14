// Test helpers for node:test (or any runner). Each test app gets its own throwaway
// database and an HTTP server on a random port.
//
//   const t = await createTestApp({ root });
//   const alice = await t.signup();
//   const res = await t.post('/posts', { title: 'Hi', body: '...' }, alice);
//   assert.equal(res.status, 201);
//   await t.close();

import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createApp } from './app.js';
import { deepMerge } from './config.js';
import { generateKey } from './security/encryption.js';

export async function createTestApp({ root = process.cwd(), config = {}, baseUri } = {}) {
  // MONGODB_TEST_URI may live in .env (an Atlas user, say): read it before choosing the server.
  const envFile = join(root, '.env');
  if (!baseUri && !process.env.MONGODB_TEST_URI && existsSync(envFile) && process.env.CALM_SKIP_ENV_FILE !== '1') process.loadEnvFile(envFile);
  const base = baseUri ?? process.env.MONGODB_TEST_URI ?? 'mongodb://127.0.0.1:27017';
  const url = new URL(base);
  url.pathname = `/calm_test_${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;

  const app = await createApp({
    root,
    config: deepMerge(
      {
        mode: 'test',
        db: { uri: url.toString(), connectRetries: 1 },
        auth: { password: { logN: 10, r: 8, p: 1 } },
        encryption: { keys: process.env.CALM_ENCRYPTION_KEYS ?? generateKey('test') },
        log: { level: process.env.CALM_TEST_LOG ?? 'silent' },
      },
      config,
    ),
  });
  await app.start();
  // Everything the app sends, for assertions: t.mails[0].subject, t.pushes[0].message.title
  const mails = [];
  const pushes = [];
  app.mailer.observe((msg) => mails.push(msg));
  app.push.observe((record, event) => event === 'created' && pushes.push(record));
  const server = app.express.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  let counter = 0;

  async function request(method, path, body, auth) {
    const token = typeof auth === 'string' ? auth : auth?.token;
    const res = await fetch(`${origin}${path.startsWith('/api') || path.startsWith('/health') || path.startsWith('/_calm') ? '' : app.config.apiPrefix}${path}`, {
      method,
      headers: {
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }

  return {
    app,
    origin,
    request,
    get: (path, auth) => request('GET', path, undefined, auth),
    post: (path, body, auth) => request('POST', path, body ?? {}, auth),
    patch: (path, body, auth) => request('PATCH', path, body ?? {}, auth),
    put: (path, body, auth) => request('PUT', path, body ?? {}, auth),
    delete: (path, auth) => request('DELETE', path, undefined, auth),

    /** Register a user through the API and return { token, user, id, email, password }. Pass roles to grant them directly. */
    async signup({ name, email, password = 'correct-horse-battery', roles } = {}) {
      counter += 1;
      const mail = email ?? `user${counter}_${randomBytes(2).toString('hex')}@example.test`;
      const res = await request('POST', '/auth/register', { name: name ?? `User ${counter}`, email: mail, password });
      if (res.status !== 201) throw new Error(`signup failed: ${res.status} ${JSON.stringify(res.body)}`);
      const { token, user } = res.body.data;
      if (roles) await app.model('user').updateOne({ _id: user.id }, { $set: { roles } });
      return { token, user, id: user.id, email: mail, password };
    },

    /** Emails the app sent (captured, never delivered). */
    mails,
    /** Push notifications the app sent: { message, devices, payloads, warnings, status, log }. */
    pushes,

    /** Wait for background work (emails, event listeners) to finish. */
    idle: () => app.idle(),

    async close() {
      await new Promise((resolve) => server.close(resolve));
      await app.mongoose.connection.dropDatabase().catch(() => {});
      await app.stop();
    },
  };
}
