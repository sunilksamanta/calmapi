import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTestApp } from '#calm/testing.js';

let t;
before(async () => {
  t = await createTestApp({ root: join(import.meta.dirname, '..') });
});
after(() => t.close());

test('GET /api/hello', async () => {
  const res = await t.get('/hello');
  assert.equal(res.status, 200);
  assert.match(res.body.data.message, /^Hello from /);
});
