// Block registry client. Items use the shadcn registry-item JSON shape
// (https://ui.shadcn.com/schema/registry-item.json), so any shadcn-compatible
// registry or tool can host and read CalmAPI blocks.
//
// Addresses:
//   jobs | @calmapi/jobs        official registry (bundled with this CLI, or https://calmapi.dev/r)
//   @acme/billing                namespace from package.json "calm.registries"
//   https://example.com/x.json   any URL
//   ./blocks/x.json              a local file

import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PKG_ROOT, readJson } from './files.js';

export const OFFICIAL = '@calmapi';
export const OFFICIAL_URL = 'https://calmapi.dev/r/{name}.json';

export function parseAddress(address) {
  if (/^https?:\/\//.test(address)) return { kind: 'url', url: address, key: address };
  if (address.startsWith('.') || address.startsWith('/') || address.endsWith('.json')) return { kind: 'file', path: address, key: address };
  const m = /^(@[\w-]+)\/([\w-]+)$/.exec(address);
  if (m) return { kind: 'ns', namespace: m[1], name: m[2], key: address };
  if (/^[\w-]+$/.test(address)) return { kind: 'ns', namespace: OFFICIAL, name: address, key: `${OFFICIAL}/${address}` };
  throw new Error(`Cannot understand block address "${address}"`);
}

export async function fetchItem(address, { root, remote = false } = {}) {
  const a = parseAddress(address);
  let item;
  let source;
  if (a.kind === 'file') {
    const file = resolve(root ?? process.cwd(), a.path);
    item = readJson(file);
    if (!item) throw new Error(`Cannot read ${file}`);
    source = file;
  } else if (a.kind === 'url') {
    item = await getJson(a.url);
    source = a.url;
  } else {
    const bundled = join(PKG_ROOT, 'registry', 'r', `${a.name}.json`);
    if (a.namespace === OFFICIAL && !remote && existsSync(bundled)) {
      item = readJson(bundled);
      source = `${OFFICIAL} (bundled)`;
    } else {
      const registries = { [OFFICIAL]: OFFICIAL_URL, ...(root ? readJson(join(root, 'package.json'), {})?.calm?.registries : {}) };
      const template = registries[a.namespace];
      if (!template) throw new Error(`Unknown registry ${a.namespace}. Add it to package.json: "calm": { "registries": { "${a.namespace}": "https://.../{name}.json" } }`);
      const url = template.replace('{name}', a.name);
      item = await getJson(url);
      source = url;
    }
  }
  validateItem(item, address);
  return { key: a.key, item, source };
}

async function getJson(url) {
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url} answered ${res.status}`);
  return res.json();
}

function validateItem(item, address) {
  if (!item || typeof item !== 'object' || !item.name || !Array.isArray(item.files)) {
    throw new Error(`${address} is not a registry item (needs name and files)`);
  }
  for (const f of item.files) {
    const target = f.target ?? f.path;
    if (typeof f.content !== 'string' || !target) throw new Error(`${address}: every file needs content and a target`);
    if (target.startsWith('/') || target.split('/').includes('..')) throw new Error(`${address}: refusing to write outside the project (${target})`);
    if (target === 'calm.lock' || target.startsWith('calm/')) throw new Error(`${address}: blocks cannot overwrite framework files (${target})`);
  }
}

/** Resolve an item and its registryDependencies, dependencies first. */
export async function resolveAll(addresses, opts) {
  const ordered = [];
  const seen = new Set();
  const visit = async (address, depth) => {
    if (depth > 10) throw new Error('registryDependencies are nested too deeply');
    const resolved = await fetchItem(address, opts);
    if (seen.has(resolved.key)) return;
    seen.add(resolved.key);
    for (const dep of resolved.item.registryDependencies ?? []) await visit(dep, depth + 1);
    ordered.push(resolved);
  };
  for (const address of addresses) await visit(address, 0);
  return ordered;
}

/** "multer@^2.0.0" -> ['multer', '^2.0.0'], "@aws-sdk/client-s3" -> ['@aws-sdk/client-s3', 'latest'] */
export function splitDep(spec) {
  const at = spec.lastIndexOf('@');
  return at > 0 ? [spec.slice(0, at), spec.slice(at + 1)] : [spec, 'latest'];
}
