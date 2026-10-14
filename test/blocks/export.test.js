import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { makeProject, ROOT } from '../helpers.js';

let project;
let t;
let csv;
let alice;
let bob;
let admin;

const ITEM = `
import { resource, f } from '#calm';
export default resource('item', {
  fields: {
    title: f.string().required().max(200).filterable().sortable(),
    status: f.enum(['draft', 'live']).default('draft').filterable(),
    price: f.number().filterable().sortable(),
    tags: f.array(f.string()).default([]),
    code: f.string(),
    slug: f.string().readOnly(),
    secret: f.string().hidden(),
    token: f.string().writeOnly(),
    ssn: f.string().encrypted(),
    internal: f.string().visibleTo('none'),
    owner: f.ref('user').owner(),
  },
  indexes: [{ fields: { code: 1 }, options: { unique: true, partialFilterExpression: { code: { $type: 'string' } } } }],
  policy: { list: 'owner | admin', read: 'owner | admin', create: 'authenticated', update: 'owner | admin', delete: 'owner | admin' },
});`;
const SERVICE = `
import { ResourceService } from '#calm';
export default class ItemService extends ResourceService {
  async beforeCreate(data) { return { ...data, slug: String(data.title).toLowerCase().replace(/[^a-z0-9]+/g, '-') }; }
}`;
const LOG = `
import { resource, f } from '#calm';
export default resource('log', { fields: { line: f.string() }, policy: { list: 'admin', read: 'admin', create: 'admin' } });`;

before(async () => {
  execFileSync(process.execPath, [join(ROOT, 'scripts', 'build-registry.js')]);
  project = await makeProject({ files: { 'app/resources/item/item.resource.js': ITEM, 'app/resources/item/item.service.js': SERVICE, 'app/resources/log/log.resource.js': LOG } });
  execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'add', 'export', '--yes', '--no-install'], { cwd: project.dir, env: { ...process.env, CI: '1' } });
  t = await project.testApp({ blocks: { export: { self: ['item', 'log'], batchSize: 100 } } });
  csv = await project.load('app/blocks/export/csv.js');
  [alice, bob, admin] = [await t.signup({ name: 'Alice' }), await t.signup({ name: 'Bob' }), await t.signup({ name: 'Admin', roles: ['user', 'admin'] })];
});
after(async () => {
  await t?.close();
  project?.cleanup();
});

const items = () => t.app.model('item');
const raw = (path, who, init = {}) => fetch(`${t.origin}/api${path}`, { ...init, headers: { ...(who ? { authorization: `Bearer ${who.token}` } : {}), ...(init.headers ?? {}) } });
const importBody = (path, body, type, who = admin) => raw(path, who, { method: 'POST', body, headers: { 'content-type': type } }).then(async (r) => ({ status: r.status, body: await r.json() }));
const create = (data, who) => t.app.service('item').create(data, { user: { id: who.id } });

test('streams a big collection in every format, from a cursor', async () => {
  await items().deleteMany({});
  const owner = new t.app.mongoose.Types.ObjectId(alice.id);
  const docs = Array.from({ length: 5000 }, (_, i) => ({ title: `Item ${i}`, status: i % 2 ? 'live' : 'draft', price: i, tags: ['a'], owner, createdAt: new Date(), updatedAt: new Date() }));
  await items().collection.insertMany(docs);

  const res = await raw('/admin/export/item?format=ndjson', admin);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/x-ndjson/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="item-export-\d{4}-\d{2}-\d{2}\.ndjson"$/);
  assert.equal(res.headers.get('transfer-encoding'), 'chunked', 'streamed, no Content-Length computed from a buffer');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const lines = (await res.text()).trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 5000);
  assert.equal(lines[0].title, 'Item 0', '_id order by default');
  assert.equal(lines[4999].title, 'Item 4999');

  const asCsv = await (await raw('/admin/export/item', admin)).text();
  const rows = csv.parseCsv(asCsv);
  assert.equal(rows.length, 5001);
  assert.deepEqual(rows[0], ['id', 'title', 'status', 'price', 'tags', 'code', 'slug', 'owner', 'createdAt', 'updatedAt']);
  assert.ok(asCsv.endsWith('\r\n'));

  const asJson = await (await raw('/admin/export/item?format=json&status=live&sort=-price&fields=title,price', admin)).json();
  assert.equal(asJson.length, 2500);
  assert.deepEqual(Object.keys(asJson[0]).sort(), ['createdAt', 'id', 'price', 'title', 'updatedAt']);
  assert.equal(asJson[0].price, 4999);
  assert.equal((await raw('/admin/export/item?format=xml', admin)).status, 400);
  await items().deleteMany({});
});

test('hidden, write-only, encrypted and invisible fields are never exported', async () => {
  await create({ title: 'Classified', secret: 'TOPSECRET-1', token: 'WRITEONLY-2', ssn: 'ENCRYPTED-3', internal: 'NOBODY-4' }, alice);
  for (const format of ['csv', 'ndjson', 'json']) {
    const text = await (await raw(`/admin/export/item?format=${format}`, admin)).text();
    assert.match(text, /Classified/);
    for (const value of ['TOPSECRET-1', 'WRITEONLY-2', 'ENCRYPTED-3', 'NOBODY-4']) assert.ok(!text.includes(value), `${format} leaks ${value}`);
    for (const key of ['secret', 'token', 'ssn']) assert.ok(!text.includes(key), `${format} names ${key}`);
  }
  const user = await (await raw('/admin/export/user?format=json', admin)).json();
  assert.ok(user.length >= 3);
  assert.ok(user.every((u) => u.password === undefined && u.email), 'no password hashes; admins see emails');
  const listed = (await t.get('/admin/export', admin)).body.data.find((r) => r.resource === 'item');
  assert.ok(!listed.columns.includes('ssn') && !listed.columns.includes('secret'));
  assert.equal((await t.get('/admin/export/item?secret=x', admin)).status, 400, 'filters only on filterable visible fields');
  assert.equal((await t.get('/admin/export/item?title[$where]=1', admin)).status, 400);
  await items().deleteMany({});
});

test('CSV cells are escaped and protected against formula injection', async () => {
  const nasty = ['say "hi"', 'a,b', 'line1\nline2', '=HYPERLINK("http://evil.example","x")', '+1+1', '-2+3', '@SUM(A1)'];
  for (const [i, title] of nasty.entries()) await create({ title, price: i === 0 ? -5 : i, tags: ['x', 'y,z'] }, alice);
  const text = await (await raw('/admin/export/item?sort=price&fields=title,price,tags', admin)).text();
  const rows = csv.parseCsv(text).slice(1);
  const byTitle = Object.fromEntries(rows.map((r) => [r[1], r]));
  assert.ok(byTitle['say "hi"'], 'quotes round trip');
  assert.ok(byTitle['a,b'] && byTitle['line1\nline2']);
  assert.ok(byTitle[`'=HYPERLINK("http://evil.example","x")`], 'formula prefixed with a quote');
  assert.ok(byTitle["'+1+1"] && byTitle["'-2+3"] && byTitle["'@SUM(A1)"]);
  assert.equal(byTitle['say "hi"'][2], '-5', 'negative numbers stay numbers');
  assert.equal(byTitle['a,b'][3], '["x","y,z"]');
  assert.ok(text.includes('"say ""hi"""'), 'RFC 4180 doubled quotes');
  assert.ok(text.includes('"line1\nline2"'));

  assert.equal(csv.csvCell('=1+1'), "'=1+1");
  assert.equal(csv.csvCell(-1), '-1');
  assert.equal(csv.csvCell('-'), "'-");
  assert.equal(csv.csvCell('\tTAB'), "'\tTAB");
  assert.equal(csv.csvCell('\rCR'), `"'\rCR"`);
  assert.equal(csv.csvCell(' padded '), '" padded "');
  assert.equal(csv.csvCell(null), '');
  assert.equal(csv.csvCell(new Date('2026-01-02T03:04:05Z')), '2026-01-02T03:04:05.000Z');
  assert.equal(csv.csvCell('=a,"b"'), `"'=a,""b"""`);
  assert.equal(csv.unprotect("'=1+1"), '=1+1');
  assert.equal(csv.unprotect("'plain"), "'plain", 'only in front of a formula character');
  assert.throws(() => csv.parseCsv('"open'), /Unterminated/);

  // Round trip: export then import, the values come back exactly (protective quotes removed).
  const report = await importBody('/admin/import/item?dryRun=true', text, 'text/csv');
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.data.valid, nasty.length);
  await items().deleteMany({});
  const done = await importBody('/admin/import/item', text, 'text/csv');
  assert.equal(done.body.data.created, nasty.length);
  const titles = (await items().find().lean()).map((d) => d.title).sort();
  assert.deepEqual(titles, [...nasty].sort(), 'identical values after the round trip');
  await items().deleteMany({});
});

test('import validates every row; dry run reports, invalid files write nothing', async () => {
  const body = 'title,price,status,secret,slug,owner\r\nGood one,10,live,,ignored-slug,' + bob.id + '\r\n,5,draft,,,\r\nBad price,abc,draft,,,\r\nBad status,1,gone,,,\r\nHidden,1,draft,psst,,\r\n';
  const dry = await importBody('/admin/import/item?dryRun=true', body, 'text/csv');
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  const r = dry.body.data;
  assert.deepEqual({ dryRun: r.dryRun, total: r.total, valid: r.valid, invalid: r.invalid, created: r.created }, { dryRun: true, total: 5, valid: 1, invalid: 4, created: 0 });
  assert.deepEqual(r.errors.map((e) => [e.row, Object.keys(e.errors)[0]]), [[2, 'title'], [3, 'price'], [4, 'status'], [5, 'secret']]);
  assert.deepEqual(r.ignoredColumns, ['slug']);
  assert.equal(await items().countDocuments(), 0, 'a dry run writes nothing');

  const strict = await importBody('/admin/import/item', body, 'text/csv');
  assert.equal(strict.status, 422);
  assert.equal(strict.body.error.details['rows.2.title'], 'Is required');
  assert.equal(await items().countDocuments(), 0, 'all or nothing by default');

  const lenient = await importBody('/admin/import/item?skipInvalid=true', body, 'text/csv');
  assert.equal(lenient.status, 200);
  assert.equal(lenient.body.data.created, 1);
  assert.equal(lenient.body.data.failed, 4);
  const good = await items().findOne({ title: 'Good one' }).lean();
  assert.equal(good.price, 10, 'CSV cells are typed by the field');
  assert.equal(good.slug, 'good-one', 'the service hook ran, the slug column was ignored');
  assert.equal(String(good.owner), bob.id, 'admin imports keep the owner (a restore)');
});

test('JSON and NDJSON imports, unique conflicts per row, upsert by id', async () => {
  await items().deleteMany({});
  const json = await t.post('/admin/import/item', [{ title: 'J1', code: 'A' }, { title: 'J2', code: 'B', tags: ['t'] }], admin);
  assert.equal(json.status, 200, JSON.stringify(json.body));
  assert.equal(json.body.data.created, 2);

  const nd = `${JSON.stringify({ title: 'N1', code: 'C' })}\n${JSON.stringify({ title: 'N2', code: 'A' })}\n`;
  const res = await importBody('/admin/import/item', nd, 'application/x-ndjson');
  assert.equal(res.status, 200);
  assert.equal(res.body.data.created, 1);
  assert.deepEqual(res.body.data.errors, [{ row: 2, errors: { code: 'Already taken' } }]);
  assert.equal((await importBody('/admin/import/item', '{"title":', 'application/x-ndjson')).status, 400);

  const j1 = await items().findOne({ title: 'J1' }).lean();
  const up = await t.post('/admin/import/item?mode=upsert', { rows: [{ id: String(j1._id), title: 'J1 renamed' }, { id: '000000000000000000000000', title: 'Fresh' }] }, admin);
  assert.equal(up.body.data.updated, 1);
  assert.equal(up.body.data.created, 1);
  assert.equal((await items().findById(j1._id).lean()).title, 'J1 renamed');
  assert.equal((await t.post('/admin/import/item?mode=replace', [], admin)).status, 400);
  assert.equal((await t.post('/admin/import/item', { nope: true }, admin)).status, 400);
  await items().deleteMany({});
});

test('permissions: admins only, self export limited to your own records', async () => {
  await create({ title: 'Alice 1' }, alice);
  await create({ title: 'Alice 2' }, alice);
  await create({ title: 'Bob 1' }, bob);

  assert.equal((await raw('/admin/export/item', alice)).status, 403);
  assert.equal((await raw('/admin/export/item')).status, 401);
  assert.equal((await importBody('/admin/import/item', 'title\r\nX\r\n', 'text/csv', alice)).status, 403);
  assert.equal((await raw('/admin/export/nothing', admin)).status, 404);
  assert.equal(await items().countDocuments({ title: 'X' }), 0);

  const mine = await (await raw('/export/item?format=json', alice)).json();
  assert.deepEqual(mine.map((d) => d.title).sort(), ['Alice 1', 'Alice 2']);
  const bobs = await (await raw('/export/item?format=json&title=Alice%201', bob)).json();
  assert.deepEqual(bobs, [], 'filters cannot escape the owner scope');
  assert.equal((await raw('/export/item', null)).status, 401);
  assert.equal((await raw('/export/user', alice)).status, 404, 'not in the self list');
  assert.equal((await raw('/export/log', alice)).status, 404, 'no owner field');
  assert.deepEqual((await t.app.doctor()).filter((f) => f.level === 'error'), []);
  assert.ok((await t.app.doctor()).some((f) => f.id === 'export-self-no-owner'));
});
