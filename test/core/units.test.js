import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pluralize, kebab, camel, pascal, escapeRegex } from '../../core/utils/strings.js';
import { f, validateValue } from '../../core/resource/fields.js';
import { resource, validateInput, standardSchema, resourceJSONSchema } from '../../core/resource/resource.js';
import { parsePolicy, evaluatePolicy } from '../../core/resource/policy.js';
import { parseListQuery } from '../../core/resource/query.js';
import { toHttpError, CalmError } from '../../core/errors.js';
import { hashPassword, verifyPassword, needsRehash } from '../../core/auth/password.js';

const FAST = { logN: 10, r: 8, p: 1 };

describe('strings', () => {
  test('pluralize handles common English and never mangles versions', () => {
    const cases = { post: 'posts', category: 'categories', box: 'boxes', person: 'people', media: 'media', series: 'series',
      'product-category': 'product-categories', v1: 'v1', 'test-series': 'test-series', knife: 'knives', day: 'days', photo: 'photos' };
    for (const [input, expected] of Object.entries(cases)) assert.equal(pluralize(input), expected, input);
  });
  test('case helpers', () => {
    assert.equal(kebab('ProductMeta'), 'product-meta');
    assert.equal(kebab('product_meta'), 'product-meta');
    assert.equal(camel('product-meta'), 'productMeta');
    assert.equal(pascal('product meta'), 'ProductMeta');
    assert.equal(new RegExp(escapeRegex('a.b*(c)')).test('a.b*(c)'), true);
    assert.equal(new RegExp(escapeRegex('a.b')).test('axb'), false);
  });
});

describe('fields', () => {
  test('string rules', async () => {
    const title = f.string().required().min(3).max(5);
    assert.deepEqual(await validateValue(title, '  abcd '), { value: 'abcd' });
    assert.match((await validateValue(title, 'ab')).error, /at least 3/);
    assert.match((await validateValue(title, 'abcdef')).error, /at most 5/);
    assert.match((await validateValue(title, 42)).error, /string/);
    assert.equal((await validateValue(f.email(), ' A@B.io ')).value, 'a@b.io');
    assert.match((await validateValue(f.email(), 'nope')).error, /email/);
    assert.match((await validateValue(f.url(), 'javascript:alert(1)')).error, /URL/);
  });
  test('numbers, dates, enums, ids, arrays, objects', async () => {
    assert.match((await validateValue(f.number(), '5')).error, /number/, 'no silent coercion of strings');
    assert.match((await validateValue(f.integer(), 1.5)).error, /integer/);
    assert.ok((await validateValue(f.date(), '2026-01-01')).value instanceof Date);
    assert.match((await validateValue(f.enum(['a', 'b']), 'c')).error, /one of/);
    assert.match((await validateValue(f.ref('user'), { $ne: 1 })).error, /valid id/, 'operator objects rejected');
    assert.deepEqual((await validateValue(f.array(f.string()).max(2), ['x', ' y '])).value, ['x', 'y']);
    assert.match((await validateValue(f.array(f.string()).max(2), ['a', 'b', 'c'])).error, /at most 2/);
    const ro = f.object({ city: f.string(), verified: f.boolean().readOnly() });
    assert.match((await validateValue(ro, { verified: true })).error, /verified: Is read-only/);
    const obj = f.object({ city: f.string().required(), zip: f.string() });
    assert.deepEqual((await validateValue(obj, { city: 'Pune' })).value, { city: 'Pune' });
    assert.match((await validateValue(obj, { city: 'Pune', evil: 1 })).error, /Unknown field "evil"/);
  });
  test('custom checks and Standard Schema validators', async () => {
    const even = f.number().check((n) => n % 2 === 0 || 'Must be even');
    assert.equal((await validateValue(even, 3)).error, 'Must be even');
    const std = { '~standard': { version: 1, vendor: 'x', validate: (v) => (v === 'ok' ? { value: 'OK' } : { issues: [{ message: 'not ok' }] }) } };
    assert.equal((await validateValue(f.string().schema(std), 'ok')).value, 'OK');
    assert.equal((await validateValue(f.string().schema(std), 'no')).error, 'not ok');
  });
});

describe('resource input validation', () => {
  const post = resource('post', {
    fields: {
      title: f.string().required(),
      secret: f.string().hidden(),
      slug: f.string().readOnly(),
      kind: f.string().immutable(),
      featured: f.boolean().writableBy('admin'),
      author: f.ref('user').owner(),
      password: f.password(),
    },
    policy: { list: 'public', read: 'public', create: 'authenticated', update: 'owner', delete: 'owner' },
  });
  const user = { id: 'a'.repeat(24), roles: ['user'] };
  const admin = { id: 'b'.repeat(24), roles: ['admin'] };

  test('rejects unknown, hidden, read-only and owner fields (no mass assignment)', async () => {
    await assert.rejects(validateInput(post, { title: 'x', role: 'admin', secret: 's', slug: 'x', author: user.id }, { mode: 'create', user }), (err) => {
      assert.equal(err.status, 422);
      assert.deepEqual(Object.keys(err.details).sort(), ['author', 'role', 'secret', 'slug']);
      return true;
    });
  });
  test('required on create only; immutable and passwords locked on update', async () => {
    await assert.rejects(validateInput(post, {}, { mode: 'create', user }), /Validation failed/);
    assert.deepEqual(await validateInput(post, {}, { mode: 'update', user }), {});
    await assert.rejects(validateInput(post, { kind: 'x' }, { mode: 'update', user }), (e) => e.details.kind.includes('Cannot be changed'));
    await assert.rejects(validateInput(post, { password: 'longenough1' }, { mode: 'update', user }), (e) => e.details.password.includes('/api/auth/password'));
  });
  test('writableBy is enforced per user', async () => {
    await assert.rejects(validateInput(post, { title: 'x', featured: true }, { mode: 'create', user }), (e) => e.details.featured.includes('not allowed'));
    assert.deepEqual(await validateInput(post, { title: 'x', featured: true }, { mode: 'create', user: admin }), { title: 'x', featured: true });
  });
  test('body must be an object', async () => {
    await assert.rejects(validateInput(post, ['x'], { mode: 'create', user }), /JSON object/);
  });
  test('exposes a Standard Schema and JSON Schemas', async () => {
    const res = await standardSchema(post)['~standard'].validate({ title: 'x', nope: 1 });
    assert.deepEqual(res.issues, [{ message: 'Unknown field', path: ['nope'] }]);
    const out = resourceJSONSchema(post, 'output');
    assert.ok(out.properties.title && out.properties.id);
    assert.equal(out.properties.secret, undefined);
    assert.equal(out.properties.password, undefined);
    assert.deepEqual(resourceJSONSchema(post, 'create').required, ['title']);
  });
  test('resource() validates its definition', () => {
    assert.throws(() => resource('x', { fields: { id: f.string() } }), /managed by CalmAPI/);
    assert.throws(() => resource('x', { fields: { a: { type: String } } }), /must be built with f/);
    assert.throws(() => resource('x', { fields: { a: f.ref('user').owner(), b: f.ref('user').owner() } }), /only one field/);
    assert.equal(resource('test-series', { fields: {} }).path, '/test-series');
    assert.equal(resource('ProductCategory', { fields: {} }).path, '/product-categories');
  });
});

describe('policies', () => {
  const user = { id: '1', roles: ['user'] };
  const editor = { id: '2', roles: ['editor'] };
  test('parse and evaluate', async () => {
    assert.deepEqual(parsePolicy('owner | admin'), ['owner', 'admin']);
    assert.deepEqual(parsePolicy('auth|self'), ['authenticated', 'owner']);
    assert.deepEqual(await evaluatePolicy(parsePolicy('public'), {}), { allow: true });
    assert.deepEqual(await evaluatePolicy(parsePolicy('authenticated'), {}), { allow: false, reason: 'unauthenticated' });
    assert.deepEqual(await evaluatePolicy(parsePolicy('admin'), { user }), { allow: false, reason: 'forbidden' });
    assert.deepEqual(await evaluatePolicy(parsePolicy('editor'), { user: editor }), { allow: true });
    assert.deepEqual(await evaluatePolicy(parsePolicy('owner | admin'), { user }), { allow: true, scope: 'owner' });
    assert.deepEqual(await evaluatePolicy(parsePolicy('owner'), { user, action: 'create' }), { allow: true });
    assert.deepEqual(await evaluatePolicy(parsePolicy('none'), { user }), { allow: false, reason: 'forbidden' });
    assert.deepEqual(await evaluatePolicy([({ user: u }) => u?.id === '1'], { user }), { allow: true });
  });
});

describe('list queries', () => {
  const product = resource('product', {
    fields: {
      name: f.string().searchable().sortable().filterable(),
      price: f.number().filterable().sortable(),
      status: f.enum(['a', 'b']).filterable(['eq', 'in']),
      cost: f.number().hidden(),
      tags: f.array(f.string()).filterable(),
      internal: f.string(),
    },
  });
  const opts = { pagination: { defaultLimit: 20, maxLimit: 100 } };

  test('builds filters with coercion and allowlisted operators', () => {
    const q = parseListQuery(product, { 'price[gte]': '10', 'price[lt]': '99.5', status: 'a', 'tags[in]': 'x,y', sort: '-price,name', page: '2', limit: '5' }, opts);
    assert.deepEqual(q.filter, { price: { $gte: 10, $lt: 99.5 }, status: 'a', tags: { $in: ['x', 'y'] } });
    assert.deepEqual(q.sort, { price: -1, name: 1, _id: -1 });
    assert.equal(q.skip, 5);
    assert.equal(q.limit, 5);
  });
  test('rejects anything not declared', () => {
    const bad = (query, key) => assert.throws(() => parseListQuery(product, query, opts), (e) => e.status === 400 && key in e.details);
    bad({ cost: '1' }, 'cost');
    bad({ internal: 'x' }, 'internal');
    bad({ 'status[ne]': 'a' }, 'status[ne]');
    bad({ 'price[$where]': '1' }, 'price[$where]');
    bad({ $where: '1' }, '$where');
    bad({ price: 'abc' }, 'price');
    bad({ status: 'zzz' }, 'status');
    bad({ sort: 'cost' }, 'sort');
    bad({ limit: '1000' }, 'limit');
    bad({ limit: 'abc' }, 'limit');
    bad({ page: '0' }, 'page');
    bad({ fields: 'cost' }, 'fields');
  });
  test('search is escaped (no regex injection)', () => {
    const q = parseListQuery(product, { q: '(a+)+$' }, opts);
    assert.equal(q.filter.$or[0].name.source, '\\(a\\+\\)\\+\\$');
  });
  test('is exported from #calm, so blocks filter exactly like the list route', async () => {
    const calm = await import('../../core/index.js');
    assert.equal(calm.parseListQuery, parseListQuery);
  });
});

describe('errors', () => {
  test('maps known errors and hides unknown ones', () => {
    assert.equal(toHttpError({ name: 'CastError', path: '_id' }).status, 404);
    assert.equal(toHttpError({ code: 11000, keyValue: { email: 'x' } }).status, 409);
    assert.equal(toHttpError({ type: 'entity.parse.failed' }).code, 'INVALID_JSON');
    const hidden = toHttpError(new Error('Cannot read properties of undefined (reading secretThing)'));
    assert.equal(hidden.status, 500);
    assert.equal(hidden.message, 'Something went wrong');
    assert.ok(toHttpError(new CalmError(418, 'TEAPOT', 'short and stout')) instanceof CalmError);
  });
});

describe('config', () => {
  test('anything that is not development or test runs as production', async () => {
    const { loadConfig } = await import('../../core/config.js');
    const root = new URL('../fixtures-none', import.meta.url).pathname;
    const base = { db: { uri: 'mongodb://127.0.0.1/x' } };
    process.env.APP_URL = 'https://api.example.com';
    try {
      for (const nodeEnv of ['staging', 'preview', 'prod', '']) {
        const cfg = await loadConfig(root, { ...base, mode: nodeEnv });
        assert.equal(cfg.mode, 'production', nodeEnv);
        assert.equal(cfg.nodeEnv, nodeEnv);
        assert.deepEqual(cfg.cors.origins, []);
        assert.equal(cfg.devtools.enabled, false);
      }
      assert.equal((await loadConfig(root, { ...base, mode: 'development' })).mode, 'development');
    } finally {
      delete process.env.APP_URL;
    }
  });
});

describe('passwords', () => {
  test('scrypt hash, verify and rehash detection', async () => {
    const hash = await hashPassword('hunter2-hunter2', FAST);
    assert.match(hash, /^scrypt\$10\$8\$1\$/);
    assert.equal(await verifyPassword('hunter2-hunter2', hash), true);
    assert.equal(await verifyPassword('wrong', hash), false);
    assert.equal(await verifyPassword('x', 'bcrypt$garbage'), false);
    assert.equal(needsRehash(hash, { logN: 15, r: 8, p: 3 }), true);
    assert.equal(needsRehash(hash, FAST), false);
  });
});
