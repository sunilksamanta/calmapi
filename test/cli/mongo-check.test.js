import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mongoTarget, canConnect, mongoHint } from '../../src/cli/lib/mongo-check.js';

const freePort = () =>
  new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });

describe('mongoTarget', () => {
  test('reads host and port, 27017 by default', () => {
    assert.deepEqual(mongoTarget('mongodb://127.0.0.1:27017/app'), { host: '127.0.0.1', port: 27017 });
    assert.deepEqual(mongoTarget('mongodb://localhost/app'), { host: 'localhost', port: 27017 });
    assert.deepEqual(mongoTarget('mongodb://db.example.com:27018'), { host: 'db.example.com', port: 27018 });
    assert.deepEqual(mongoTarget('mongodb://[::1]:27019/app'), { host: '::1', port: 27019 });
  });

  test('drops credentials and takes the first host of a replica set', () => {
    assert.deepEqual(mongoTarget('mongodb://user:p%40ss@a.example.com:27017,b.example.com:27017/app?replicaSet=rs0'), { host: 'a.example.com', port: 27017 });
  });

  test('marks +srv URIs and refuses what it cannot read', () => {
    assert.deepEqual(mongoTarget('mongodb+srv://user:secret@cluster0.example.net/app'), { srv: true });
    assert.equal(mongoTarget('postgres://localhost/app'), null);
    assert.equal(mongoTarget('mongodb://localhost:99999/app'), null);
    assert.equal(mongoTarget(undefined), null);
  });
});

describe('mongoHint', () => {
  test('warns when nothing listens, without the password', async () => {
    const port = await freePort();
    const hint = (await mongoHint(`mongodb://admin:hunter2@127.0.0.1:${port}/app`)).join('\n');
    assert.match(hint, new RegExp(`Nothing is listening on 127\\.0\\.0\\.1:${port} yet`));
    assert.match(hint, new RegExp(`docker run -d --name mongo -p ${port}:27017 mongo:8`));
    assert.match(hint, /MongoDB Atlas/);
    assert.doesNotMatch(hint, /hunter2|admin/);
  });

  test('a remote host gets its own wording, without docker or the password', async () => {
    // Names under .invalid never resolve (RFC 2606).
    const hint = await mongoHint('mongodb://admin:hunter2@db.invalid:27017/app');
    assert.deepEqual(hint, ['  ! Could not reach db.invalid:27017. Check the host, the port and your network.']);
  });

  test('says nothing when the server accepts a connection', async () => {
    const server = createServer((socket) => socket.destroy());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      assert.deepEqual(await mongoHint(`mongodb://127.0.0.1:${server.address().port}/app`), []);
    } finally {
      server.close();
    }
  });

  test('skips +srv URIs with a note and never prints the password', async () => {
    const hint = (await mongoHint('mongodb+srv://admin:hunter2@cluster0.example.net/app')).join('\n');
    assert.match(hint, /Skipped the MongoDB check/);
    assert.doesNotMatch(hint, /hunter2|admin|Nothing is listening/);
  });

  test('gives up after the timeout instead of hanging', async () => {
    // 192.0.2.0/24 is reserved for documentation: nothing answers there.
    const started = Date.now();
    assert.equal(await canConnect('192.0.2.1', 27017, 200), false);
    assert.ok(Date.now() - started < 2000);
  });
});
