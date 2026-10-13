// A disposable copy of the development database for an AI agent (calm dev --agent-db).
// The copy lives next to the original on the same server, named <db>_agent, and is dropped
// when calm dev stops. A copy left behind by a crash is replaced on the next run.
// The work runs in a child process with the project's own MongoDB driver.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { capture } from './project.js';
import { readText } from './files.js';

/** MONGODB_URI as the app would see it: the environment first, then .env. */
export function devDatabaseUri(root, env = process.env) {
  if (env.MONGODB_URI) return env.MONGODB_URI;
  const file = join(root, '.env');
  if (!existsSync(file)) return null;
  const m = /^\s*MONGODB_URI\s*=\s*(.+?)\s*$/m.exec(readText(file));
  return m ? m[1].replace(/^(['"])(.*)\1$/, '$2') : null;
}

/** The copy's URI and names: same server and options, database <name>_agent. */
export function agentUri(uri) {
  // Not new URL(): a replica set lists several hosts (mongodb://a:1,b:2/db), which URL rejects.
  const m = /^(mongodb(?:\+srv)?:\/\/[^/?]+)(?:\/([^?]*))?(\?.*)?$/.exec(String(uri).trim());
  if (!m) throw new Error('MONGODB_URI is not a valid connection string (mongodb://host:27017/name)');
  const from = decodeURIComponent(m[2] ?? '') || 'test';
  if (from.endsWith('_agent')) throw new Error(`MONGODB_URI already points at an agent copy (${from}): point it at your development database`);
  const to = `${from}_agent`;
  if (to.length > 63) throw new Error(`The database name ${from} is too long for a copy (${to} has more than 63 characters)`);
  return { from, to, uri: `${m[1]}/${encodeURIComponent(to)}${m[3] ?? ''}` };
}

const SCRIPT = `
const op = JSON.parse(process.env.CALM_AGENT_DB);
const { default: mongoose } = await import('mongoose');
let result;
try {
  const conn = await mongoose.createConnection(op.uri, { serverSelectionTimeoutMS: 5000 }).asPromise();
  const client = conn.getClient();
  const target = client.db(op.to);
  await target.dropDatabase();
  if (op.kind === 'copy') {
    const source = client.db(op.from);
    const names = (await source.listCollections({}, { nameOnly: true }).toArray()).filter((c) => c.type !== 'view' && !c.name.startsWith('system.')).map((c) => c.name);
    const collections = [];
    for (const name of names) {
      let docs = 0;
      try {
        // On the server, in one step (MongoDB 4.4+).
        await source.collection(name).aggregate([{ $match: {} }, { $out: { db: op.to, coll: name } }]).toArray();
        docs = await target.collection(name).estimatedDocumentCount();
      } catch {
        // Older servers or restricted users: copy in batches through this process.
        let batch = [];
        for await (const doc of source.collection(name).find({})) {
          batch.push(doc);
          if (batch.length === 500) { await target.collection(name).insertMany(batch, { ordered: false }); docs += batch.length; batch = []; }
        }
        if (batch.length) { await target.collection(name).insertMany(batch, { ordered: false }); docs += batch.length; }
      }
      const indexes = (await source.collection(name).indexes()).filter((i) => i.name !== '_id_');
      for (const { v, ns, key, name: indexName, ...options } of indexes) await target.collection(name).createIndex(key, { name: indexName, ...options }).catch(() => {});
      collections.push({ name, docs });
    }
    result = { collections };
  } else result = { dropped: op.to };
  await conn.close();
} catch (err) {
  result = { error: err.message };
}
process.stdout.write('\\n@@CALM@@' + JSON.stringify(result));
process.exit(0);
`;

async function runOp(root, op) {
  const res = await capture(process.execPath, ['--input-type=module', '-e', SCRIPT], { cwd: root, env: { CALM_AGENT_DB: JSON.stringify(op) } });
  const marker = res.stdout.lastIndexOf('@@CALM@@');
  if (marker === -1) throw new Error(`Could not reach MongoDB:\n${res.stderr || res.stdout}`.trim());
  const result = JSON.parse(res.stdout.slice(marker + 8));
  if (result.error) throw new Error(result.error);
  return result;
}

/** Copy the dev database to <db>_agent. Returns { from, to, uri, collections }. */
export async function createAgentDb(root, uri) {
  const names = agentUri(uri);
  const { collections } = await runOp(root, { kind: 'copy', uri, from: names.from, to: names.to });
  return { ...names, collections };
}

export const dropAgentDb = (root, uri, to) => runOp(root, { kind: 'drop', uri, to });
