import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeProject } from '../helpers.js';

const files = {
  'app/resources/category/category.resource.js': `
import { resource, f } from '#calm';
export default resource('category', {
  fields: { name: f.string().required().filterable() },
  policy: { list: 'public', read: 'public', create: 'admin', update: 'admin', delete: 'admin' },
});`,
  'app/resources/product/product.resource.js': `
import { resource, f } from '#calm';
export default resource('product', {
  fields: {
    name: f.string().required().searchable().sortable().filterable(),
    price: f.number().required().min(0).filterable().sortable(),
    cost: f.number().hidden(),
    status: f.enum(['draft', 'live']).default('draft').filterable(['eq', 'in']),
    category: f.ref('category'),
    owner: f.ref('user').owner().filterable(),
    secretNote: f.string().visibleTo('owner | admin'),
  },
  policy: { list: 'authenticated', read: 'authenticated', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`,
  'app/resources/product/product.service.js': `
import { ResourceService } from '#calm';
export default class ProductService extends ResourceService {
  async beforeCreate(data) { return { ...data, cost: data.price / 2 }; }
}`,
  'app/resources/product/product.routes.js': `
import { f, badRequest } from '#calm';
export default (r) => {
  r.get('/cheap', { policy: 'authenticated' }, (ctx) => ctx.service.find({ price: { $lt: 10 } }, ctx));
  r.get('/boom', { policy: 'public' }, () => { throw new Error('db password is hunter2'); });
  r.get('/nopolicy', () => ({ ok: true }));
  r.post('/quote', { policy: 'public', input: { qty: f.integer().required().min(1) } }, (ctx) => ({ total: ctx.body.qty * 3 }));
  r.post('/:id/discount', { policy: 'owner' }, async (ctx) => {
    if (ctx.doc.price < 1) throw badRequest('Too cheap to discount');
    return ctx.service.update(ctx.doc._id, { price: ctx.doc.price - 1 }, ctx);
  });
};`,
  'app/resources/note/note.resource.js': `
import { resource, f } from '#calm';
export default resource('note', {
  fields: { text: f.string().required(), author: f.ref('user').owner() },
  policy: { list: 'owner', read: 'owner', create: 'authenticated', update: 'owner', delete: 'owner' },
});`,
  'app/routes.js': `
export default (r) => {
  r.get('/ping', { policy: 'public' }, () => ({ pong: true }));
};`,
};

let project;
let t;
let alice;
let bob;
let admin;
let category;

before(async () => {
  project = await makeProject({ files });
  t = await project.testApp();
  [alice, bob, admin] = [await t.signup({ name: 'Alice' }), await t.signup({ name: 'Bob' }), await t.signup({ name: 'Root', roles: ['user', 'admin'] })];
  category = (await t.post('/categories', { name: 'Tools' }, admin)).body.data;
});
after(async () => {
  await t.close();
  project.cleanup();
});

const newProduct = (body = {}, who = alice) => t.post('/products', { name: 'Hammer', price: 20, category: category.id, ...body }, who);

describe('CRUD', () => {
  test('status codes and shapes', async () => {
    const created = await newProduct({ secretNote: 'supplier is ACME' });
    assert.equal(created.status, 201);
    const p = created.body.data;
    assert.equal(p.owner, alice.id);
    assert.equal(p.status, 'draft');
    assert.ok(p.createdAt && p.updatedAt && p.id);

    assert.equal((await t.get(`/products/${p.id}`, alice)).status, 200);
    const patched = await t.patch(`/products/${p.id}`, { price: 25 }, alice);
    assert.equal(patched.body.data.price, 25);
    assert.equal(patched.body.data.name, 'Hammer', 'partial update keeps other fields');
    assert.equal((await t.put(`/products/${p.id}`, { price: 26 }, alice)).body.data.price, 26);
    assert.equal((await t.delete(`/products/${p.id}`, alice)).status, 204);
    assert.equal((await t.get(`/products/${p.id}`, alice)).status, 404);
  });

  test('null clears optional fields', async () => {
    const p = (await newProduct({ secretNote: 'x' })).body.data;
    const res = await t.patch(`/products/${p.id}`, { secretNote: null }, alice);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.secretNote, undefined);
  });

  test('malformed and unknown ids are 404, bad JSON is 400, unknown routes are JSON 404', async () => {
    assert.equal((await t.get('/products/not-an-id', alice)).status, 404);
    assert.equal((await t.get('/products/aaaaaaaaaaaaaaaaaaaaaaaa', alice)).status, 404);
    const bad = await fetch(`${t.origin}/api/products`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${alice.token}` }, body: '{"name":' });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error.code, 'INVALID_JSON');
    const missing = await t.get('/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.ok(missing.body.error.requestId);
  });
});

describe('visibility', () => {
  test('hidden fields can be set by the service but never read, filtered, sorted or selected', async () => {
    const p = (await newProduct()).body.data;
    assert.equal(p.cost, undefined);
    const stored = await t.app.model('product').findById(p.id).select('+cost').lean();
    assert.equal(stored.cost, 10, 'service set it');
    assert.equal((await newProduct({ cost: 1 })).status, 422, 'clients cannot set it');
    for (const q of ['cost=10', 'sort=cost', 'fields=cost', 'cost[gt]=1']) {
      assert.equal((await t.get(`/products?${q}`, alice)).status, 400, q);
    }
    const list = await t.get('/products', alice);
    assert.ok(list.body.data.every((x) => x.cost === undefined));
  });

  test('visibleTo hides fields from other users, per record', async () => {
    const p = (await newProduct({ secretNote: 'margin 40%' })).body.data;
    assert.equal((await t.get(`/products/${p.id}`, alice)).body.data.secretNote, 'margin 40%');
    assert.equal((await t.get(`/products/${p.id}`, admin)).body.data.secretNote, 'margin 40%');
    assert.equal((await t.get(`/products/${p.id}`, bob)).body.data.secretNote, undefined);
  });

  test('populated users never leak private data', async () => {
    const p = (await newProduct()).body.data;
    await t.post('/auth/password/forgot', { email: alice.email });
    await t.idle();
    const asBob = await t.get(`/products/${p.id}?include=owner,category`, bob);
    assert.equal(asBob.status, 200);
    const owner = asBob.body.data.owner;
    assert.deepEqual(Object.keys(owner).sort(), ['createdAt', 'id', 'name', 'status', 'updatedAt']);
    assert.equal(asBob.body.data.category.name, 'Tools');
    const asAlice = await t.get(`/products/${p.id}?include=owner`, alice);
    assert.equal(asAlice.body.data.owner.email, alice.email, 'you can see your own email');

    const listAsBob = await t.get('/products?include=owner', bob);
    assert.ok(listAsBob.body.data.every((x) => x.owner.email === undefined && x.owner.password === undefined));
    assert.equal((await t.get('/products?include=cost', bob)).status, 400);
  });
});

describe('ownership', () => {
  test('others get 403 on records they can read, 401 when signed out, admins pass', async () => {
    const p = (await newProduct()).body.data;
    assert.equal((await t.patch(`/products/${p.id}`, { price: 1 }, bob)).status, 403);
    assert.equal((await t.delete(`/products/${p.id}`, bob)).status, 403);
    assert.equal((await t.patch(`/products/${p.id}`, { price: 1 })).status, 401);
    assert.equal((await t.patch(`/products/${p.id}`, { price: 2 }, admin)).status, 200);
    assert.equal((await t.patch(`/products/${p.id}`, { owner: bob.id }, alice)).status, 422, 'owner cannot be reassigned');
  });

  test('owner-only resources are invisible to others (404, scoped lists)', async () => {
    const note = (await t.post('/notes', { text: 'alice private' }, alice)).body.data;
    await t.post('/notes', { text: 'bob private' }, bob);
    assert.equal((await t.get(`/notes/${note.id}`, bob)).status, 404);
    assert.equal((await t.patch(`/notes/${note.id}`, { text: 'x' }, bob)).status, 404);
    const bobs = await t.get('/notes', bob);
    assert.deepEqual(bobs.body.data.map((n) => n.text), ['bob private']);
    assert.equal((await t.get('/notes')).status, 401);
  });

  test('custom routes on :id use the same ownership rules', async () => {
    const p = (await newProduct({ price: 5 })).body.data;
    assert.equal((await t.post(`/products/${p.id}/discount`, {}, bob)).status, 403);
    const res = await t.post(`/products/${p.id}/discount`, {}, alice);
    assert.equal(res.status, 200);
    assert.equal(res.body.data.price, 4);
    assert.equal(res.body.data.cost, undefined, 'raw docs from custom routes are serialized');
  });
});

describe('queries', () => {
  test('filters, search, sorting and pagination', async () => {
    const owner = await t.signup();
    for (const [name, price, status] of [['Saw (large)', 30, 'live'], ['Saw (small)', 12, 'live'], ['Drill', 99, 'draft']]) {
      await newProduct({ name, price, status }, owner);
    }
    const mine = `owner=${owner.id}`;
    const live = await t.get(`/products?${mine}&status=live&sort=-price`, owner);
    assert.deepEqual(live.body.data.map((p) => p.price), [30, 12]);
    const range = await t.get(`/products?${mine}&price[gte]=12&price[lt]=50&sort=price`, owner);
    assert.deepEqual(range.body.data.map((p) => p.price), [12, 30]);
    const search = await t.get(`/products?${mine}&q=${encodeURIComponent('saw (')}`, owner);
    assert.equal(search.body.meta.total, 2);
    const page = await t.get(`/products?${mine}&sort=price&limit=1&page=2`, owner);
    assert.deepEqual(page.body.meta, { total: 3, page: 2, limit: 1, pages: 3 });
    assert.equal(page.body.data[0].price, 30);
    const fields = await t.get(`/products?${mine}&fields=name&limit=1`, owner);
    assert.deepEqual(Object.keys(fields.body.data[0]).sort(), ['createdAt', 'id', 'name', 'updatedAt']);
    const bad = await t.get('/products?status[ne]=live', owner);
    assert.equal(bad.status, 400);
    assert.match(bad.body.error.details['status[ne]'], /Allowed: eq, in/);
  });
});

describe('custom routes', () => {
  test('specific paths win over :id, inputs are validated, app routes work', async () => {
    await newProduct({ name: 'Nail', price: 1 });
    const cheap = await t.get('/products/cheap', alice);
    assert.equal(cheap.status, 200);
    assert.ok(cheap.body.data.length >= 1);
    assert.ok(cheap.body.data.every((p) => p.cost === undefined && p.id));
    assert.deepEqual((await t.post('/products/quote', { qty: 2 })).body.data, { total: 6 });
    assert.equal((await t.post('/products/quote', { qty: 0 })).status, 422);
    assert.equal((await t.post('/products/quote', { qty: 1, extra: true })).status, 422);
    assert.deepEqual((await t.get('/ping')).body.data, { pong: true });
    assert.equal((await t.get('/products/nopolicy')).status, 401, 'routes default to authenticated');
  });

  test('unexpected errors never leak internals', async () => {
    const res = await t.get('/products/boom');
    assert.equal(res.status, 500);
    assert.equal(res.body.error.message, 'Something went wrong');
    assert.ok(!JSON.stringify(res.body).includes('hunter2'));
  });
});

describe('services', () => {
  test('return whole records and skip scope() for system calls', async () => {
    await newProduct({ name: 'Svc' });
    const { items } = await t.app.service('product').list({ filter: { name: 'Svc' } }, { system: true });
    assert.equal(items[0].cost, 10, 'hidden fields are available server-side');
    const draft = (await t.post('/posts', { title: 'Hidden draft', body: 'x' }, alice)).body.data;
    const anon = await t.app.service('post').find({ _id: draft.id }, {});
    const system = await t.app.service('post').find({ _id: draft.id }, { system: true });
    assert.equal(anon.length, 0, 'scope() applies to anonymous calls');
    assert.equal(system.length, 1, 'system calls bypass scope()');
  });
});

describe('platform', () => {
  test('events fire after writes', async () => {
    const seen = [];
    const off = t.app.events.on('product.*', (payload, name) => seen.push([name, payload.doc.name, payload.user?.id]));
    const p = (await newProduct({ name: 'Evented' })).body.data;
    await t.delete(`/products/${p.id}`, alice);
    await t.idle();
    off();
    assert.deepEqual(seen, [['product.created', 'Evented', alice.id], ['product.deleted', 'Evented', alice.id]]);
  });

  test('OpenAPI document reflects resources without private fields', async () => {
    const res = await t.get('/openapi.json');
    assert.equal(res.status, 200);
    const doc = res.body;
    assert.equal(doc.openapi, '3.1.0');
    assert.ok(doc.paths['/api/products'].get && doc.paths['/api/products'].post);
    assert.ok(doc.paths['/api/products/{id}'].patch);
    assert.ok(doc.paths['/api/auth/login'].post);
    assert.equal(doc.components.schemas.Product.properties.cost, undefined);
    assert.equal(doc.components.schemas.User.properties.password, undefined);
    assert.deepEqual(doc.components.schemas.ProductCreate.required.sort(), ['name', 'price']);
    assert.ok(doc.paths['/api/products'].get.parameters.some((p) => p.name === 'price[gte]'));
  });

  test('health, security headers and doctor', async () => {
    assert.equal((await t.get('/health/live')).status, 200);
    const ready = await t.get('/health/ready');
    assert.deepEqual(ready.body, { status: 'ok', database: 'up' });
    const res = await fetch(`${t.origin}/api`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('x-powered-by'), null);
    assert.ok(res.headers.get('x-request-id'));

    const findings = await t.app.doctor();
    assert.ok(findings.some((f) => f.id === 'route-policy' && f.title.includes('/products/nopolicy')));
    assert.deepEqual(findings.filter((f) => f.level === 'error'), []);
  });
});
