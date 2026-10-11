import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTestApp } from '#calm/testing.js';

let t;
before(async () => {
  t = await createTestApp({ root: join(import.meta.dirname, '..') });
});
after(() => t.close());

test('signed-in users write posts, visitors only see published ones', async () => {
  const alice = await t.signup();

  const draft = await t.post('/posts', { title: 'Hello world', body: 'First!' }, alice);
  assert.equal(draft.status, 201);
  assert.equal(draft.body.data.slug, 'hello-world');
  assert.equal(draft.body.data.author, alice.id);

  const anonymous = await t.get('/posts');
  assert.equal(anonymous.body.meta.total, 0, 'drafts are not public');

  const published = await t.post(`/posts/${draft.body.data.id}/publish`, {}, alice);
  assert.equal(published.body.data.status, 'published');

  const list = await t.get('/posts?include=author');
  assert.equal(list.body.meta.total, 1);
  assert.equal(list.body.data[0].author.name, alice.user.name);
  assert.equal(list.body.data[0].author.email, undefined, 'author email is private');
});

test('only the author (or an admin) can edit a post', async () => {
  const alice = await t.signup();
  const bob = await t.signup();
  const post = await t.post('/posts', { title: 'Mine', body: '...', status: 'published' }, alice);

  const edit = await t.patch(`/posts/${post.body.data.id}`, { title: 'Hacked' }, bob);
  assert.equal(edit.status, 403);
});
