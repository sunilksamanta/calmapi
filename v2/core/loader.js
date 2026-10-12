// File conventions. A resource is a folder in app/resources:
//
//   app/resources/post/
//     post.resource.js   required: export default resource('post', { fields, policy })
//     post.service.js    optional: export default class extends ResourceService { ... }
//     post.routes.js     optional: export default (r) => { r.post('/:id/publish', ...) }
//
// Blocks (added with `calm add`) live in app/blocks/<name>/index.js and export a plugin.
// App-wide custom routes live in app/routes.js.

import { existsSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isResource } from './resource/resource.js';
import { ResourceService } from './resource/service.js';

const importFile = async (file) => (await import(pathToFileURL(file).href)).default;

export async function loadResources(root) {
  const dir = join(root, 'app', 'resources');
  if (!existsSync(dir)) return [];
  const out = [];
  const folders = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();

  for (const folder of folders) {
    const file = (suffix) => join(dir, folder, `${folder}.${suffix}.js`);
    const rel = (p) => relative(root, p);
    if (!existsSync(file('resource'))) continue;

    const def = await importFile(file('resource'));
    if (!isResource(def)) {
      throw new Error(`${rel(file('resource'))} must "export default resource('${folder}', { ... })"`);
    }

    let ServiceClass = ResourceService;
    if (existsSync(file('service'))) {
      ServiceClass = await importFile(file('service'));
      if (typeof ServiceClass !== 'function' || !(ServiceClass.prototype instanceof ResourceService || ServiceClass === ResourceService)) {
        throw new Error(`${rel(file('service'))} must "export default class extends ResourceService"`);
      }
    }

    let routes = null;
    if (existsSync(file('routes'))) {
      routes = await importFile(file('routes'));
      if (typeof routes !== 'function') throw new Error(`${rel(file('routes'))} must "export default (r) => { ... }"`);
    }

    out.push({
      def,
      ServiceClass,
      routes,
      files: {
        resource: rel(file('resource')),
        service: existsSync(file('service')) ? rel(file('service')) : null,
        routes: routes ? rel(file('routes')) : null,
      },
    });
  }
  return out;
}

export async function loadBlocks(root) {
  const dir = join(root, 'app', 'blocks');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const name of readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
    const file = join(dir, name, 'index.js');
    if (!existsSync(file)) continue;
    const plugin = await importFile(file);
    if (plugin?.kind !== 'calm.plugin') throw new Error(`${relative(root, file)} must "export default definePlugin({ ... })"`);
    out.push({ ...plugin, file: relative(root, file) });
  }
  return out;
}

export async function loadAppRoutes(root) {
  const file = join(root, 'app', 'routes.js');
  if (!existsSync(file)) return null;
  const fn = await importFile(file);
  if (typeof fn !== 'function') throw new Error('app/routes.js must "export default (r) => { ... }"');
  return { fn, file: relative(root, file) };
}

/**
 * Declare a plugin (what blocks export). Only name and setup are required.
 *
 *   export default definePlugin({
 *     name: 'jobs',
 *     // Optional: environment variables the block reads. calm doctor reports missing ones,
 *     // devtools shows whether they are set (never their value when secret).
 *     env: {
 *       JOBS_CONCURRENCY: 'How many jobs run at once (default 4)',
 *       STRIPE_SECRET_KEY: { required: 'production', secret: true, description: 'From the Stripe dashboard' },
 *     },
 *     // Optional: settings with defaults. Users override them in calm.config.js:
 *     //   blocks: { jobs: { pollMs: 500 } }
 *     options: { pollMs: 1000 },
 *     setup(calm, options) {
 *       calm.routes((r) => r.get('/jobs', { policy: 'admin' }, listJobs), { prefix: '/' });
 *       calm.on('post.created', ...);
 *       calm.onStart(async () => worker.start());
 *       calm.onShutdown(async () => worker.stop());
 *     },
 *   });
 */
export const definePlugin = (plugin) => {
  if (!plugin?.name || typeof plugin.setup !== 'function') throw new Error('definePlugin({ name, setup(calm) }) needs a name and a setup function');
  if (!/^[a-z][\w-]*$/i.test(plugin.name)) throw new Error(`definePlugin: "${plugin.name}" is not a valid block name (letters, digits, - and _)`);
  const env = {};
  for (const [key, spec] of Object.entries(plugin.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`definePlugin(${plugin.name}): env var "${key}" must be UPPER_SNAKE_CASE`);
    env[key] = typeof spec === 'string' ? { description: spec, required: false, secret: false } : { required: false, secret: false, ...spec };
  }
  return { kind: 'calm.plugin', ...plugin, env, options: plugin.options ?? {} };
};
