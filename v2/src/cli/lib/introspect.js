import { capture } from './project.js';

// Boot the project's own calm/ code in a child process (never connecting to MongoDB)
// and return what it knows: resources, routes, OpenAPI, doctor findings.
// A child process means edits are always picked up and the CLI never mixes its own
// modules with the project's.

const SCRIPT = `
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
const root = process.cwd();
const mode = process.env.CALM_INTROSPECT_MODE || 'development';
const result = {};
try {
  const { createApp } = await import(pathToFileURL(join(root, 'calm', 'index.js')).href);
  const app = await createApp({
    root,
    config: {
      mode,
      db: { uri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/calm_introspect' },
      log: { level: 'silent' },
      devtools: { enabled: false },
    },
  });
  const describe = (def) => ({
    name: def.name, path: def.path, collection: def.collection, ownerField: def.ownerField,
    policy: Object.fromEntries(Object.entries(def.policy).map(([k, v]) => [k, (v || []).map((t) => typeof t === 'function' ? (t.name || 'custom') : t).join(' | ')])),
    defaultedPolicies: def.defaultedPolicies,
    fields: Object.fromEntries(Object.entries(def.fields).map(([k, f]) => [k, { type: f.type, ...JSON.parse(JSON.stringify(f.opts, (key, v) => key === 'of' || key === 'shape' ? undefined : typeof v === 'function' ? 'fn' : v instanceof RegExp ? v.source : v)), ...(f.type === 'array' ? { of: f.opts.of.type, ref: f.opts.of.opts.ref } : {}) }])),
  });
  result.app = { name: app.config.app.name, version: app.config.app.version, apiPrefix: app.config.apiPrefix, port: app.config.port, mode: app.config.mode };
  result.resources = [...app.registry.values()].map((e) => ({ ...describe(e.def), files: e.files }));
  result.routes = app.routes.map((r) => ({ method: r.method, path: app.config.apiPrefix + r.path, policy: r.policyLabel, policyExplicit: r.policyExplicit, source: r.source, resource: r.resource, summary: r.summary || null, file: r.file || null, hidden: r.hidden }));
  result.blocks = app.plugins;
  result.openapi = app.openapi();
  result.doctor = await app.doctor();
  result.exposure = await app.exposure();
  await app.mongoose.disconnect();
} catch (err) {
  result.error = { message: err.message, code: err.code || null, stack: err.stack };
}
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result));
process.exit(0);
`;

export async function introspect(root, { mode } = {}) {
  const { stdout, stderr, code } = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], {
    cwd: root,
    env: { CALM_INTROSPECT_MODE: mode ?? process.env.NODE_ENV ?? 'development', CALM_SKIP_ENV_FILE: '' },
  });
  const marker = stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) {
    const err = new Error(`Could not load the project (exit ${code}).\n${stderr || stdout}`.trim());
    err.code = 'CALM_INTROSPECT';
    throw err;
  }
  return JSON.parse(stdout.slice(marker + 8));
}
