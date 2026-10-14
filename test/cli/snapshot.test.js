import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { scanSource, accessFromLabel, buildSnapshot, diffSnapshots, direction, audience, diffRows } from '../../src/cli/lib/snapshot.js';

const PEOPLE = ['anonymous', 'user', 'owner', 'admin'];
const all = (v) => Object.fromEntries(PEOPLE.map((p) => [p, v]));
const field = (name, read, write = read, extra = {}) => ({ name, type: 'string', pii: false, encrypted: false, read, write, ...extra });
const route = (method, path, policy, access, extra = {}) => ({ method, path, policy, explicit: true, source: 'app', file: 'app/routes.js', resource: null, action: 'custom', rateLimit: null, scope: null, access, ...extra });
const snap = (over = {}) => ({ version: 1, app: { name: 'x', apiPrefix: '/api' }, personas: PEOPLE, routes: [], resources: [], env: [], hosts: [], events: [], blocks: [], invariants: [], ...over });

test('scanSource finds hosts and events in app and calm code, env vars in app code, nothing in comments', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calm-scan-'));
  try {
    mkdirSync(join(dir, 'app', 'blocks', 'billing'), { recursive: true });
    mkdirSync(join(dir, 'calm'), { recursive: true });
    writeFileSync(
      join(dir, 'app', 'blocks', 'billing', 'index.js'),
      `// docs: https://docs.calmapi.dev/blocks and https://stripe.com/docs
const key = process.env.STRIPE_SECRET_KEY;
/* https://ignored.example.org */
export const charge = () => fetch('https://api.stripe.com/v1/charges', { headers: { key } });
export const notify = (events) => events.emit('invoice.paid', {});
`,
    );
    writeFileSync(join(dir, 'calm', 'config.js'), `const uri = process.env.MONGODB_URI; const x = process.env.CALM_INTERNAL; fetch('https://core.example.net');\n`);
    writeFileSync(join(dir, 'calm.config.js'), `export default ({ env }) => ({ mail: { from: env.MAIL_FROM } });\n`);
    const scan = scanSource(dir);
    assert.deepEqual(scan.hosts, [{ host: 'api.stripe.com', files: ['app/blocks/billing/index.js'] }, { host: 'core.example.net', files: ['calm/config.js'] }]);
    assert.deepEqual(scan.events, [{ name: 'invoice.paid', files: ['app/blocks/billing/index.js'] }]);
    assert.deepEqual(scan.env, [
      { key: 'MAIL_FROM', files: ['calm.config.js'] },
      { key: 'STRIPE_SECRET_KEY', files: ['app/blocks/billing/index.js'] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('accessFromLabel mirrors the policy tokens', () => {
  assert.deepEqual(accessFromLabel('public'), all('allow'));
  assert.deepEqual(accessFromLabel('authenticated'), { anonymous: 'deny', user: 'allow', owner: 'allow', admin: 'allow' });
  assert.deepEqual(accessFromLabel('owner | admin'), { anonymous: 'deny', user: 'deny', owner: 'own', admin: 'allow' });
  assert.deepEqual(accessFromLabel('admin'), { anonymous: 'deny', user: 'deny', owner: 'deny', admin: 'allow' });
  assert.deepEqual(accessFromLabel('editor | admin', [...PEOPLE, 'role:editor']), { anonymous: 'deny', user: 'deny', owner: 'deny', admin: 'allow', 'role:editor': 'allow' });
  // A function or named policy reads as a role in the fallback (its code is not visible from the label).
  assert.deepEqual(accessFromLabel('isWeekend | admin'), { anonymous: 'deny', user: 'deny', owner: 'deny', admin: 'allow' });
  assert.deepEqual(accessFromLabel('custom'), all('custom'));
});

test('buildSnapshot falls back to routes, exposure and blocks when calm/ has no snapshot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'calm-snap-'));
  try {
    const info = {
      app: { name: 'old', apiPrefix: '/api', mode: 'development' },
      routes: [
        { method: 'GET', path: '/api/posts', policy: 'public', policyExplicit: true, source: 'crud', resource: 'post', file: null, hidden: false },
        { method: 'GET', path: '/api/hidden', policy: 'admin', policyExplicit: true, source: 'app', resource: null, file: 'app/routes.js', hidden: true },
      ],
      resources: [{ name: 'post', files: { resource: 'app/resources/post/post.resource.js' } }],
      exposure: {
        personas: PEOPLE.map((key) => ({ key })),
        resources: [
          {
            name: 'post',
            path: '/posts',
            ownerField: 'author',
            actions: { list: all('allow'), read: all('allow'), create: { ...all('allow'), anonymous: 'deny' }, update: { anonymous: 'deny', user: 'deny', owner: 'allow', admin: 'allow' }, delete: all('deny') },
            fields: [{ name: 'title', type: 'string', pii: false, encrypted: false, read: all('yes'), write: all('yes') }],
          },
        ],
      },
      blocks: [{ name: 'jobs', file: 'app/blocks/jobs/index.js', env: [{ key: 'JOBS_CONCURRENCY', requiredIn: null, secret: false }] }],
      snapshot: null,
    };
    const s = buildSnapshot(info, dir);
    assert.equal(s.version, 0);
    assert.deepEqual(s.routes.map((r) => r.path), ['/api/posts']);
    assert.deepEqual(s.routes[0].access, all('allow'));
    const title = s.resources[0].fields[0];
    assert.deepEqual(title.read, all('yes'));
    assert.deepEqual(title.write, { anonymous: 'no', user: 'yes', owner: 'yes', admin: 'yes' }, 'write follows the create and update policies');
    assert.deepEqual(s.env, [{ key: 'JOBS_CONCURRENCY', required: false, secret: false, from: 'block:jobs', files: ['app/blocks/jobs/index.js'] }]);
    assert.deepEqual(s.blocks, [{ name: 'jobs', file: 'app/blocks/jobs/index.js' }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('direction and audience', () => {
  assert.equal(direction({ anonymous: 'deny', user: 'own' }, { anonymous: 'deny', user: 'allow' }), 'looser');
  assert.equal(direction({ anonymous: 'allow' }, { anonymous: 'deny' }), 'tighter');
  assert.equal(direction({ anonymous: 'allow', user: 'deny' }, { anonymous: 'deny', user: 'allow' }), 'mixed');
  assert.equal(direction({ user: 'allow' }, { user: 'allow' }), 'same');
  assert.equal(direction({ user: 'own' }, { user: 'custom' }), 'looser', 'custom code is unknown, so it counts as wider');
  assert.equal(audience(all('yes')), 'everyone');
  assert.equal(audience({ anonymous: 'no', user: 'yes', owner: 'yes', admin: 'yes' }), 'signed-in users');
  assert.equal(audience({ anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }), 'the owner and admins');
  assert.equal(audience({ anonymous: 'no', user: 'no', owner: 'no', admin: 'yes' }), 'admins');
  assert.equal(audience({ anonymous: 'no', user: 'no', owner: 'no', admin: 'no', 'role:editor': 'yes' }), 'editor');
  assert.equal(audience(all('no')), 'nobody');
});

test('diffSnapshots classifies routes, fields, env, hosts, events, blocks and invariants', () => {
  const before = snap({
    routes: [
      route('GET', '/api/orders/:id', 'owner | admin', { anonymous: 'deny', user: 'deny', owner: 'own', admin: 'allow' }),
      route('DELETE', '/api/orders/:id', 'admin', { anonymous: 'deny', user: 'deny', owner: 'deny', admin: 'allow' }),
      route('POST', '/api/auth/login', 'public', all('allow'), { source: 'auth', rateLimit: 'auth', file: 'calm/auth/index.js' }),
    ],
    resources: [
      {
        name: 'user',
        path: '/api/users',
        owner: '_id',
        file: 'app/resources/user/user.resource.js',
        fields: [
          field('name', all('yes')),
          field('phone', { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { pii: true }),
          field('ssn', { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { pii: true, encrypted: true }),
          field('legacy', all('yes')),
        ],
      },
    ],
    env: [{ key: 'OLD_KEY', required: false, secret: false, from: 'block:old', files: [] }],
    hosts: [{ host: 'api.old.example', files: ['app/blocks/old/index.js'] }],
    events: [{ name: 'order.paid', files: ['app/routes.js'] }],
    blocks: [{ name: 'old', file: 'app/blocks/old/index.js' }],
    invariants: [{ rule: 'no public write routes', except: [] }, { rule: 'auth routes are rate limited', except: [] }],
  });
  const after = snap({
    routes: [
      route('GET', '/api/orders/:id', 'authenticated', { anonymous: 'deny', user: 'allow', owner: 'allow', admin: 'allow' }),
      route('POST', '/api/refunds', 'admin', { anonymous: 'deny', user: 'deny', owner: 'deny', admin: 'allow' }),
      route('GET', '/api/pulse', 'public', all('allow')),
      route('POST', '/api/auth/login', 'public', all('allow'), { source: 'auth', rateLimit: null, file: 'calm/auth/index.js' }),
    ],
    resources: [
      {
        name: 'user',
        path: '/api/users',
        owner: '_id',
        file: 'app/resources/user/user.resource.js',
        fields: [
          field('name', all('yes')),
          field('phone', all('yes'), { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { pii: true }),
          field('ssn', { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { anonymous: 'no', user: 'no', owner: 'yes', admin: 'yes' }, { pii: true, encrypted: false }),
          field('bio', { anonymous: 'no', user: 'yes', owner: 'yes', admin: 'yes' }),
        ],
      },
      { name: 'refund', path: '/api/refunds', owner: null, file: 'app/resources/refund/refund.resource.js', fields: [field('amount', { anonymous: 'no', user: 'no', owner: 'no', admin: 'yes' })] },
    ],
    env: [{ key: 'STRIPE_SECRET_KEY', required: 'production', secret: true, from: 'block:stripe', files: ['app/blocks/stripe/index.js'] }],
    hosts: [{ host: 'api.stripe.com', files: ['app/blocks/stripe/index.js'] }],
    events: [{ name: 'order.paid', files: ['app/routes.js'] }, { name: 'refund.created', files: ['app/routes.js'] }],
    blocks: [{ name: 'stripe', file: 'app/blocks/stripe/index.js' }],
    invariants: [{ rule: 'auth routes are rate limited', except: [] }],
  });

  const { changes, summary } = diffSnapshots(before, after);
  const find = (kind, key) => changes.find((c) => c.kind === kind && c.key === key);
  assert.equal(find('route', 'GET /api/orders/:id').direction, 'looser');
  assert.equal(find('route', 'GET /api/orders/:id').detail, 'policy: owner | admin -> authenticated');
  assert.equal(find('route', 'POST /api/refunds').direction, null, 'an admin-only route is new surface but not wider access');
  assert.equal(find('route', 'GET /api/pulse').direction, 'looser');
  assert.equal(find('route', 'DELETE /api/orders/:id').change, 'removed');
  assert.equal(find('route', 'POST /api/auth/login').detail, 'rate limit: auth -> none');
  assert.equal(find('route', 'POST /api/auth/login').direction, 'looser');
  assert.equal(find('field', 'user.phone').detail, 'visible to: the owner and admins -> everyone');
  assert.equal(find('field', 'user.phone').direction, 'looser');
  assert.equal(find('field', 'user.phone').personal, true);
  assert.equal(find('field', 'user.ssn').detail, 'no longer encrypted at rest');
  assert.equal(find('field', 'user.ssn').direction, 'looser');
  assert.equal(find('field', 'user.bio').change, 'added');
  assert.equal(find('field', 'user.bio').direction, null);
  assert.equal(find('field', 'user.legacy').change, 'removed');
  assert.equal(find('field', 'user.name'), undefined, 'unchanged fields are not listed');
  assert.equal(find('resource', 'refund').change, 'added');
  assert.equal(find('field', 'refund.amount').detail, 'visible to: admins');
  assert.equal(find('env', 'STRIPE_SECRET_KEY').detail, 'required in production, secret');
  assert.equal(find('env', 'OLD_KEY').change, 'removed');
  assert.equal(find('host', 'api.stripe.com').change, 'added');
  assert.equal(find('host', 'api.stripe.com').file, 'app/blocks/stripe/index.js');
  assert.equal(find('event', 'refund.created').change, 'added');
  assert.equal(find('event', 'order.paid'), undefined);
  assert.equal(find('block', 'stripe').change, 'added');
  assert.equal(find('block', 'old').change, 'removed');
  assert.equal(find('invariant', 'no public write routes').change, 'removed');
  assert.equal(find('invariant', 'no public write routes').direction, 'looser', 'dropping a promise widens access');
  assert.deepEqual(summary, { total: changes.length, widen: 6, tighten: 1 });

  const rows = diffRows({ changes, summary });
  const phone = rows.find((r) => r.what === 'user.phone');
  assert.equal(phone.mark, '~');
  assert.equal(phone.note, 'looser, personal data');
  assert.equal(rows.find((r) => r.what.startsWith('invariant no public')).mark, '-');
  assert.ok(rows.find((r) => r.what === 'GET    /api/pulse'), 'methods are padded so paths line up');
});

test('identical snapshots produce no changes', () => {
  const s = snap({ routes: [route('GET', '/api/x', 'public', all('allow'))], invariants: [{ rule: 'no public routes', except: ['GET /api/x'] }] });
  assert.deepEqual(diffSnapshots(s, structuredClone(s)), { changes: [], summary: { total: 0, widen: 0, tighten: 0 } });
});
