import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

const files = {
  'app/resources/category/category.resource.js': `import { resource, f } from '#calm';
export default resource('category', {
  fields: { name: f.string().required().max(60).unique() },
  policy: { list: 'public', read: 'public', create: 'admin', update: 'admin', delete: 'admin' },
});`,
  'app/resources/product/product.resource.js': `import { resource, f } from '#calm';
export default resource('product', {
  fields: {
    name: f.string().required().max(80),
    sku: f.string().required().unique(),
    price: f.number().required().min(0),
    stock: f.integer().min(0),
    status: f.enum(['draft', 'live', 'archived']).default('draft'),
    tags: f.array(f.string().max(20)).max(5),
    category: f.ref('category').required(),
    contactEmail: f.email(),
    launchAt: f.date(),
    featured: f.boolean().writableBy('admin'),
    owner: f.ref('user').owner(),
  },
  policy: { list: 'public', read: 'public', create: 'authenticated', update: 'owner', delete: 'owner' },
});`,
};

let project;
let t;
before(async () => {
  project = await makeProject({ files });
  t = await project.testApp({ devtools: { enabled: true } });
});
after(async () => {
  await t.close();
  project.cleanup();
});

test('seed: realistic records through the services, references and owners included', async () => {
  const { seed } = await project.load('calm/seed.js');
  const out = await seed(t.app, { resource: 'product', count: 15, seed: 7 });
  assert.equal(out.created.product, 15);
  assert.equal(out.created.category, 5, 'a referenced resource that was empty gets a few records first');
  assert.equal(out.created.user, 3, 'demo users own the records when there are none');
  assert.equal(out.users.length, 3);

  const login = await t.post('/auth/login', out.users[0]);
  assert.equal(login.status, 200, 'demo credentials work');

  const products = await t.app.model('product').find().lean();
  const categories = new Set((await t.app.model('category').find().lean()).map((c) => String(c._id)));
  for (const p of products) {
    assert.ok(p.name && p.sku && typeof p.price === 'number' && p.price >= 5 && p.price <= 500, JSON.stringify(p));
    assert.ok(categories.has(String(p.category)));
    assert.ok(p.owner, 'owner set by the service, from the demo user');
    assert.ok(['draft', 'live', 'archived'].includes(p.status));
    if (p.contactEmail) assert.match(p.contactEmail, /^[a-z-]+\.[a-z-]+\w*@example\.(com|org|net)$/);
    assert.equal(p.featured, undefined, 'fields only admins may set are left alone');
  }
  assert.equal(new Set(products.map((p) => p.sku)).size, 15, 'unique fields stay unique');
});

test('devtools: POST /_calm/api/seed', async () => {
  const res = await fetch(`${t.origin}/_calm/api/seed`, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', 'x-calm-devtools': '1' }, body: JSON.stringify({ resource: 'post', count: 4 }) });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.created.post, 4);
  const bad = await fetch(`${t.origin}/_calm/api/seed`, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json', 'x-calm-devtools': '1' }, body: JSON.stringify({ resource: 'nope' }) });
  assert.equal(bad.status, 400);
});
