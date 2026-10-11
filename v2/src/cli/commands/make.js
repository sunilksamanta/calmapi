import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { requireProject } from '../lib/project.js';
import { writeFile } from '../lib/files.js';
import { parseFieldSpec, fieldCode } from '../lib/field-spec.js';
import { kebab, pascal, pluralize } from '../lib/strings.js';
import { c, ok, out, info } from '../lib/ui.js';

export const help = `
${c.bold('calm make resource <name> [fields...]')}

  Create app/resources/<name>/ with a resource definition (and optionally a
  service, custom routes and a test).

  Field syntax  name:type[!][=default][+modifier...]
    title:string!                   required string
    price:number=0                  number with a default
    status:enum:draft,live=draft    enum
    category:ref:category           reference to another resource
    tags:string[]                   array
    name:string!+searchable         extra modifiers: searchable sortable filterable unique hidden ...

  Types  string text email url password number integer boolean date enum ref id json

  Options
    --service     also create <name>.service.js
    --routes      also create <name>.routes.js
    --no-owner    do not add an owner field (default: owner = the signed-in user)
    --no-test     do not create test/<names>.test.js
    --force       overwrite existing files

  Example
    calm make resource product name:string!+searchable price:number! category:ref --service
`;

export async function run(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      service: { type: 'boolean', default: false },
      routes: { type: 'boolean', default: false },
      'no-owner': { type: 'boolean', default: false },
      'no-test': { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [kind, rawName, ...specs] = positionals;
  if (values.help || !kind) return out(help);
  if (kind !== 'resource') throw new Error(`Unknown generator "${kind}". Available: resource`);
  if (!rawName) throw new Error('Give the resource a name: calm make resource product');

  const root = requireProject();
  const name = kebab(rawName);
  if (!name) throw new Error(`Invalid resource name "${rawName}"`);
  const hasUsers = existsSync(join(root, 'app', 'resources', 'user', 'user.resource.js'));
  const fields = specs.map(parseFieldSpec);
  if (new Set(fields.map((f) => f.name)).size !== fields.length) throw new Error('Duplicate field names');

  // `owner:ref:user` is the owner field the user meant to write: mark it instead of adding a second one.
  for (const f of fields) if (f.name === 'owner' && f.type === 'ref' && f.arg === 'user' && !f.array && !f.modifiers.includes('owner')) f.modifiers.push('owner');
  const addOwner = hasUsers && !values['no-owner'] && !fields.some((f) => f.modifiers.includes('owner') || f.name === 'owner');
  const owner = addOwner || (hasUsers && fields.some((f) => f.modifiers.includes('owner')));
  const written = [];
  const put = (rel, content) => {
    const file = join(root, rel);
    if (existsSync(file) && !values.force) throw new Error(`${rel} already exists (use --force to overwrite)`);
    writeFile(file, content);
    written.push(rel);
  };

  put(`app/resources/${name}/${name}.resource.js`, resourceFile(name, fields, { owner, addOwner, hasUsers }));
  if (values.service) put(`app/resources/${name}/${name}.service.js`, serviceFile(name));
  if (values.routes) put(`app/resources/${name}/${name}.routes.js`, routesFile(name));
  if (hasUsers && !values['no-test']) {
    const testFile = `test/${pluralize(name)}.test.js`;
    const content = testFileContent(name, fields); // null when required refs need fixtures we cannot guess
    if (content && (!existsSync(join(root, testFile)) || values.force)) put(testFile, content);
  }

  ok(`Created resource ${c.bold(name)} at ${c.cyan(`/api/${pluralize(name)}`)}`);
  for (const f of written) out(`  ${c.dim('+')} ${f}`);
  out('');
  info(`Restart is automatic with ${c.bold('npm run dev')}. Try ${c.bold(`npx calm routes`)} to see the new endpoints.`);
  const missing = fields.filter((f) => f.type === 'ref' && !existsSync(join(root, 'app', 'resources', f.arg))).map((f) => f.arg);
  if (missing.length) out(c.yellow(`  Heads up: referenced resources do not exist yet: ${missing.join(', ')}`));
}

function resourceFile(name, fields, { owner, addOwner, hasUsers }) {
  const lines = fields.map((f) => `    ${f.name}: ${fieldCode(f)},`);
  if (addOwner) lines.push("    owner: f.ref('user').owner(), // set from the session, powers 'owner' policies");
  if (!lines.length) lines.push("    name: f.string().required().max(200).searchable(),");
  const policy = hasUsers
    ? `  policy: {
    list: 'authenticated',
    read: 'authenticated',
    create: 'authenticated',
    update: ${owner ? "'owner | admin'" : "'admin'"},
    delete: ${owner ? "'owner | admin'" : "'admin'"},
  },`
    : `  // No user resource in this project, so there is no sign-in: everything is public.
  // Add auth (see the 'api' template) before deploying anything writable.
  policy: {
    list: 'public',
    read: 'public',
    create: 'public',
    update: 'public',
    delete: 'public',
  },`;
  return `import { resource, f } from '#calm';

export default resource('${name}', {
  fields: {
${lines.join('\n')}
  },
${policy}
});
`;
}

function serviceFile(name) {
  return `import { ResourceService } from '#calm';

// Business logic for ${name}. Override hooks first, whole methods only when needed:
// scope(ctx), beforeCreate(data, ctx), afterCreate(doc, ctx), beforeUpdate(data, existing, ctx),
// afterUpdate(doc, previous, ctx), beforeDelete(doc, ctx), afterDelete(doc, ctx).
export default class ${pascal(name)}Service extends ResourceService {
  async beforeCreate(data, _ctx) {
    return data;
  }
}
`;
}

function routesFile(name) {
  return `// Custom endpoints under /api/${pluralize(name)}. Mounted before the CRUD routes.
// Return a value to respond with { data }. Throw notFound(), forbidden()... from '#calm' to fail.

export default (r) => {
  r.get('/stats', { policy: 'authenticated', summary: 'Count ${pluralize(name)}' }, async (ctx) => {
    const { total } = await ctx.service.list({ limit: 1 }, ctx);
    return { total };
  });
};
`;
}

function testFileContent(name, fields) {
  const plural = pluralize(name);
  const sample = {};
  for (const f of fields) {
    if (!f.required) continue;
    if (f.array) sample[f.name] = [];
    else if (f.type === 'enum') sample[f.name] = f.default ?? f.arg.split(',')[0].trim();
    else if (['number', 'integer'].includes(f.type)) sample[f.name] = 1;
    else if (f.type === 'boolean') sample[f.name] = true;
    else if (f.type === 'date') sample[f.name] = '2030-01-01T00:00:00.000Z';
    else if (f.type === 'email') sample[f.name] = 'someone@example.com';
    else if (f.type === 'url') sample[f.name] = 'https://example.com';
    else if (f.type === 'ref' || f.type === 'id') return null;
    else sample[f.name] = `Sample ${f.name}`;
  }
  if (!fields.length) sample.name = `Sample ${name}`;
  return `import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { createTestApp } from '#calm/testing.js';

let t;
before(async () => {
  t = await createTestApp({ root: join(import.meta.dirname, '..') });
});
after(() => t.close());

test('${plural}: create, read, list', async () => {
  const user = await t.signup();
  const created = await t.post('/${plural}', ${JSON.stringify(sample)}, user);
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const read = await t.get(\`/${plural}/\${created.body.data.id}\`, user);
  assert.equal(read.status, 200);

  const list = await t.get('/${plural}', user);
  assert.equal(list.body.meta.total, 1);
});

test('${plural}: signed-out requests are refused', async () => {
  assert.equal((await t.get('/${plural}')).status, 401);
});
`;
}
