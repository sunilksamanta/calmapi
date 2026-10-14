import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ROOT } from '../helpers.js';
import { diffContracts, nextVersion } from '../../src/cli/lib/contract.js';

const doc = (paths, schemas = {}) => ({ openapi: '3.1.0', paths, components: { schemas } });
const op = ({ security = [{ session: [] }], body, response, status = '200', params = [] } = {}) => ({
  security,
  parameters: params,
  ...(body ? { requestBody: { required: true, content: { 'application/json': { schema: body } } } } : {}),
  responses: { [status]: { description: 'ok', content: response ? { 'application/json': { schema: response } } : undefined } },
});
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const find = (r, where, what) => r.changes.find((c) => c.where === where && what.test(c.what));

test('routes added and removed, security and status changes', () => {
  const a = doc({ '/api/a': { get: op({ security: [] }) }, '/api/b': { delete: op({ status: '204' }) } });
  const b = doc({ '/api/a': { get: op() }, '/api/b': { delete: op({ status: '200' }) }, '/api/c': { post: op() } });
  const r = diffContracts(a, b);
  assert.equal(find(r, 'GET /api/a', /now needs a signed-in user/).level, 'breaking');
  assert.equal(find(r, 'DELETE /api/b', /success status 204 -> 200/).level, 'breaking');
  assert.equal(find(r, 'POST /api/c', /route added/).level, 'minor');
  assert.equal(diffContracts(b, a).changes.find((c) => c.where === 'POST /api/c').what, 'route removed');
  assert.equal(r.bump, 'major');
});

test('request bodies: required, removed, types, enums and limits; refs are followed', () => {
  const schemasA = { OrderCreate: obj({ item: { type: 'string', maxLength: 100 }, note: { type: 'string' }, size: { type: 'string', enum: ['s', 'm', 'l'] }, qty: { type: 'integer' } }, ['item']) };
  const schemasB = { OrderCreate: obj({ item: { type: 'string', maxLength: 50 }, size: { type: 'string', enum: ['s', 'm', 'xl'] }, qty: { type: 'string' }, coupon: { type: 'string' }, email: { type: 'string' } }, ['item', 'email']) };
  const ref = { $ref: '#/components/schemas/OrderCreate' };
  const r = diffContracts(doc({ '/api/orders': { post: op({ body: ref, status: '201' }) } }, schemasA), doc({ '/api/orders': { post: op({ body: ref, status: '201' }) } }, schemasB));
  const at = (re) => find(r, 'POST /api/orders', re);
  assert.equal(at(/body\.item: maxLength 100 -> 50/).level, 'breaking');
  assert.equal(at(/body\.note: no longer accepted/).level, 'breaking');
  assert.equal(at(/body\.size: no longer accepts "l"/).level, 'breaking');
  assert.equal(at(/body\.size: also accepts "xl"/).level, 'minor');
  assert.equal(at(/body\.qty: type integer -> string/).level, 'breaking');
  assert.equal(at(/body\.coupon: new optional input/).level, 'minor');
  assert.equal(at(/body\.email: new required input/).level, 'breaking');
});

test('responses and query parameters', () => {
  const resp = (props) => obj({ data: obj(props) });
  const a = doc({ '/api/posts': { get: op({ security: [], response: resp({ title: { type: 'string' }, views: { type: 'integer' }, state: { type: 'string', enum: ['draft', 'live'] } }), params: [{ name: 'sort', in: 'query', schema: { type: 'string' } }] }) } });
  const b = doc({ '/api/posts': { get: op({ security: [], response: resp({ title: { type: 'string' }, state: { type: 'string', enum: ['draft', 'live', 'archived'] }, slug: { type: 'string' } }), params: [{ name: 'tag', in: 'query', schema: { type: 'string' } }, { name: 'org', in: 'query', required: true, schema: { type: 'string' } }] }) } });
  const r = diffContracts(a, b);
  const at = (re) => find(r, 'GET /api/posts', re);
  assert.equal(at(/response\.data\.views: removed from the response/).level, 'breaking');
  assert.equal(at(/response\.data\.slug: added to the response/).level, 'minor');
  assert.equal(at(/response\.data\.state: may now be "archived"/).level, 'minor');
  assert.equal(at(/query parameter sort removed/).level, 'breaking');
  assert.equal(at(/query parameter tag added$/).level, 'minor');
  assert.equal(at(/query parameter org added \(required\)/).level, 'breaking');
});

test('identical documents: nothing; version bumps follow semver and 0.x rules', () => {
  const d = doc({ '/api/a': { get: op() } });
  assert.deepEqual(diffContracts(d, structuredClone(d)), { changes: [], summary: { breaking: 0, minor: 0, patch: 0 }, bump: null });
  assert.equal(nextVersion('1.4.2', 'major'), '2.0.0');
  assert.equal(nextVersion('1.4.2', 'minor'), '1.5.0');
  assert.equal(nextVersion('1.4.2', 'patch'), '1.4.3');
  assert.equal(nextVersion('0.3.1', 'major'), '0.4.0');
  assert.equal(nextVersion('0.3.1', 'minor'), '0.3.2');
  assert.equal(nextVersion('nope', 'major'), null);
});

test('calm diff --api against a git ref, with --ci', { timeout: 120_000 }, () => {
  const { CLAUDECODE: _cc, NODE_TEST_CONTEXT: _ntc, ...base } = process.env;
  const env = { ...base, NO_COLOR: '1', CI: '1', MONGODB_URI: 'mongodb://127.0.0.1:27017/calm_contract_test', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.test', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.test' };
  const work = mkdtempSync(join(tmpdir(), 'calm-contract-'));
  try {
    execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), 'create', 'shop', '--yes', '--no-install', '--no-git'], { cwd: work, env });
    const app = join(work, 'shop');
    symlinkSync(join(ROOT, 'node_modules'), join(app, 'node_modules'), 'dir');
    for (const args of [['init', '-q'], ['add', '-A'], ['commit', '-qm', 'init']]) execFileSync('git', args, { cwd: app, env });
    const calm = (...args) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [join(ROOT, 'bin', 'calm.js'), ...args], { cwd: app, env, encoding: 'utf8' }) };
      } catch (err) {
        return { code: err.status, out: `${err.stdout}${err.stderr}` };
      }
    };
    assert.match(calm('diff', '--api').out, /No API contract changes/);
    const file = join(app, 'app/resources/post/post.resource.js');
    writeFileSync(file, readFileSync(file, 'utf8').replace('body: f.text().required().max(50_000),', 'body: f.text().required().max(10_000),\n    summary: f.string().required(),'));
    const r = calm('diff', '--api', '--ci');
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /breaking\s+POST \/api\/posts\s+body\.summary: new required input/);
    assert.match(r.out, /breaking\s+POST \/api\/posts\s+body\.body: maxLength 50000 -> 10000/);
    assert.match(r.out, /Suggested version 0\.1\.0 -> 0\.2\.0/);
    const json = JSON.parse(calm('diff', '--api', '--json').out);
    assert.equal(json.bump, 'major');
    assert.equal(json.next, '0.2.0');
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
