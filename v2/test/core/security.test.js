import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { makeProject } from '../helpers.js';

const key = (id) => `${id}:${randomBytes(32).toString('base64')}`;
const OLD_KEY = key('k1');

const files = {
  'app/resources/patient/patient.resource.js': `
import { resource, f } from '#calm';
export default resource('patient', {
  fields: {
    name: f.string().required().searchable(),
    ssn: f.string().required().encrypted().visibleTo('owner | admin'),
    history: f.json().encrypted().hidden(),
    owner: f.ref('user').owner(),
  },
  policy: { list: 'owner | admin', read: 'authenticated', create: 'authenticated', update: 'owner | admin', delete: 'admin' },
});`,
  'app/resources/patient/patient.service.js': `
import { ResourceService } from '#calm';
export default class PatientService extends ResourceService {
  async beforeCreate(data) { return { ...data, history: { visits: 1 } }; }
}`,
  'app/resources/visit/visit.resource.js': `
import { resource, f } from '#calm';
export default resource('visit', {
  fields: { patient: f.ref('patient').required(), note: f.string() },
  policy: { list: 'authenticated', read: 'authenticated', create: 'authenticated', update: 'admin', delete: 'admin' },
});`,
};

let project;
let t;
const events = [];

before(async () => {
  project = await makeProject({ files });
  t = await project.testApp({ encryption: { keys: OLD_KEY }, rateLimit: { enabled: true, auth: { windowMs: 60_000, max: 1000 }, global: { windowMs: 60_000, max: 100_000 } } });
  t.app.events.on('security.*', (payload, name) => events.push({ name, ...payload }));
});
after(async () => {
  await t.close();
  project.cleanup();
});

describe('encryption at rest', () => {
  test('stored as ciphertext, returned as plaintext, everywhere', async () => {
    const alice = await t.signup();
    const created = await t.post('/patients', { name: 'Jane', ssn: '123-45-6789' }, alice);
    assert.equal(created.status, 201);
    assert.equal(created.body.data.ssn, '123-45-6789');

    const raw = await t.app.model('patient').collection.findOne({});
    assert.match(raw.ssn, /^enc:v1:k1:/);
    assert.match(raw.history, /^enc:v1:k1:/);
    assert.ok(!JSON.stringify(raw).includes('123-45-6789'));

    const id = created.body.data.id;
    assert.equal((await t.get(`/patients/${id}`, alice)).body.data.ssn, '123-45-6789');
    assert.equal((await t.get('/patients', alice)).body.data[0].ssn, '123-45-6789');
    await t.patch(`/patients/${id}`, { ssn: '999-99-9999' }, alice);
    const raw2 = await t.app.model('patient').collection.findOne({});
    assert.notEqual(raw2.ssn, raw.ssn);
    assert.equal((await t.app.service('patient').get(id, {}, { system: true })).history.visits, 1, 'json values round-trip');

    const visit = (await t.post('/visits', { patient: id, note: 'checkup' }, alice)).body.data;
    const withPatient = await t.get(`/visits/${visit.id}?include=patient`, alice);
    assert.equal(withPatient.body.data.patient.ssn, '999-99-9999', 'populated records are decrypted (owner view)');
    const bob = await t.signup();
    const asBob = await t.get(`/visits/${visit.id}?include=patient`, bob);
    assert.equal(asBob.body.data.patient.ssn, undefined, 'visibility rules still apply');
  });

  test('keys rotate: old data stays readable, new writes use the new key', async () => {
    const { createApp } = await project.load('calm/app.js');
    const rotated = await createApp({
      root: project.dir,
      config: { mode: 'test', db: { uri: t.app.config.db.uri }, log: { level: 'silent' }, encryption: { keys: `${key('k2')},${OLD_KEY}` } },
    });
    await rotated.start();
    try {
      const svc = rotated.service('patient');
      const [doc] = await svc.find({}, { system: true });
      assert.equal(doc.ssn, '999-99-9999');
      await svc.update(doc._id, { ssn: '111-11-1111' }, { system: true });
      const raw = await rotated.model('patient').collection.findOne({ _id: doc._id });
      assert.match(raw.ssn, /^enc:v1:k2:/);
      assert.equal(rotated.cipher.isStale(raw.history), true, 'untouched fields keep the old key until re-saved');
    } finally {
      await rotated.mongoose.disconnect();
    }
  });

  test('definitions refuse queryable encrypted fields and missing keys', async () => {
    const { resource, f } = await project.load('calm/index.js');
    assert.throws(() => resource('x', { fields: { a: f.string().encrypted().filterable() } }), /cannot also be filterable/);
    const { createApp } = await project.load('calm/app.js');
    const saved = { ...process.env };
    delete process.env.CALM_ENCRYPTION_KEYS;
    delete process.env.CALM_ENCRYPTION_KEY;
    try {
      await assert.rejects(createApp({ root: project.dir, config: { mode: 'test', db: { uri: 'mongodb://127.0.0.1/none' } } }), /calm keygen/);
    } finally {
      process.env = saved;
    }
  });
});

describe('account protection', () => {
  test('locks an account after repeated failures, same answer for unknown emails', async () => {
    const victim = await t.signup({ password: 'correct-horse-battery' });
    const codes = [];
    for (let i = 0; i < 6; i++) codes.push((await t.post('/auth/login', { email: victim.email, password: 'wrong-password-1' })).status);
    assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
    const right = await t.post('/auth/login', { email: victim.email, password: 'correct-horse-battery' });
    assert.equal(right.status, 429, 'even the right password waits out the lock');
    assert.match(right.body.error.message, /Try again in \d+ minute/);

    const ghost = [];
    for (let i = 0; i < 6; i++) ghost.push((await t.post('/auth/login', { email: 'ghost@example.com', password: 'wrong-password-1' })).status);
    assert.deepEqual(ghost, codes, 'unknown emails behave identically');

    await t.post('/auth/password/forgot', { email: victim.email });
    await t.idle();
    const reset = await t.app.auth.service.PasswordReset.findOne({ user: victim.id }).lean();
    assert.ok(reset);
    assert.ok(events.some((e) => e.name === 'security.account_locked' && e.email.startsWith(victim.email[0]) && e.email.includes('***')));
  });

  test('refuses common passwords and passwords containing the email or name', async () => {
    const common = await t.post('/auth/register', { name: 'Al', email: 'al@example.com', password: 'password123' });
    assert.equal(common.status, 422);
    assert.match(common.body.error.details.password, /too common/);
    const mine = await t.post('/auth/register', { name: 'Grace Hopper', email: 'grace@example.com', password: 'grace-rocks-1' });
    assert.match(mine.body.error.details.password, /email/);
    const name = await t.post('/auth/register', { name: 'Grace Hopper', email: 'gh@example.com', password: 'hopper-1906!' });
    assert.match(name.body.error.details.password, /name/);
  });

  test('deeply nested JSON is refused before any work is done', async () => {
    let body = { leaf: true };
    for (let i = 0; i < 50; i++) body = { nested: body };
    const res = await t.post('/auth/login', body);
    assert.equal(res.status, 400);
    assert.match(res.body.error.message, /nested deeper/);
  });
});

describe('security events', () => {
  test('are emitted for rejected writes, forbidden access and bad tokens', async () => {
    const alice = await t.signup();
    const bob = await t.signup();
    await t.post('/auth/register', { name: 'Eve', email: 'eve@example.com', password: 'eve-is-sneaky-9', roles: ['admin'] });
    const p = (await t.post('/patients', { name: 'X', ssn: '1' }, alice)).body.data;
    await t.patch(`/patients/${p.id}`, { name: 'Y' }, bob);
    await t.get('/auth/me', 'calm_forged');
    await t.idle();
    const names = events.map((e) => e.name);
    assert.ok(names.includes('security.write_rejected'), names.join());
    assert.ok(names.includes('security.forbidden'));
    assert.ok(names.includes('security.invalid_token'));
    assert.ok(names.includes('security.login_failed'));
    const rejected = events.find((e) => e.name === 'security.write_rejected');
    assert.deepEqual(rejected.fields, ['roles']);
  });
});
