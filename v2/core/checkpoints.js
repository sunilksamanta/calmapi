// Checkpoints: snapshots of the development database in .calm/checkpoints/<id>/, so you
// can try something (a migration, a seed, an AI agent session) and put the data back
// exactly as it was.
//
//   const meta = await app.checkpoints.create({ name: 'before migration' });
//   await app.checkpoints.restore(meta.id);
//
// Every collection of the app's database is written to one newline-delimited file of
// canonical Extended JSON, so ObjectIds, dates, binary and number types survive the trip.
// Only documents are stored: indexes come back from the models (Mongoose creates them at
// boot), GridFS buckets are just two collections, and other databases are never touched.
// Development only: create and restore refuse to run in production.

import { createReadStream } from 'node:fs';
import { appendFile, mkdir, open, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import mongoose from 'mongoose';

const { EJSON } = mongoose.mongo.BSON;
const ID = /^[\w.-]+$/;
const BATCH = 500;
const WRITE_BATCH = 200;

export const checkpointsDir = (root) => join(root, '.calm', 'checkpoints');

/** Ids come from the file system or from a request: never let one escape .calm/checkpoints. */
function dirFor(root, id) {
  if (typeof id !== 'string' || !ID.test(id) || id === '.' || id === '..') {
    const err = new Error(`Invalid checkpoint id "${id}"`);
    err.status = 400;
    throw err;
  }
  return join(checkpointsDir(root), id);
}

function guard(app) {
  if (app?.config?.mode === 'production') throw new Error('Checkpoints are a development tool: they do not run in production.');
  const db = app?.mongoose?.connection?.db;
  if (!db) throw new Error('Not connected to MongoDB. Call app.start() first.');
  return db;
}

const slug = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'manual';

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function cleanActor(actor) {
  const kind = actor?.kind === 'agent' ? 'agent' : 'human';
  const name = typeof actor?.name === 'string' && actor.name.trim() ? actor.name.trim().slice(0, 60) : kind === 'agent' ? 'agent' : 'cli';
  return { kind, name };
}

async function calmVersion(root) {
  try {
    return JSON.parse(await readFile(join(root, 'calm.lock'), 'utf8')).calmapi ?? null;
  } catch {
    return null;
  }
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Same file and format as `calm dev` and `calm mcp` write (.calm/activity.jsonl). Best effort. */
async function appendActivity(root, event) {
  try {
    await mkdir(join(root, '.calm'), { recursive: true });
    await appendFile(join(root, '.calm', 'activity.jsonl'), `${JSON.stringify({ time: new Date().toISOString(), ...event })}\n`);
  } catch {
    // the checkpoint itself is on disk; the log line is a courtesy
  }
}

const totals = (collections) => ({ collections: collections.length, docs: collections.reduce((n, c) => n + c.docs, 0) });

async function collectionNames(db) {
  const list = await db.listCollections({}, { nameOnly: true }).toArray();
  return list
    .filter((c) => c.type !== 'view' && !c.name.startsWith('system.'))
    .map((c) => c.name)
    .sort();
}

/**
 * Dump every collection of the app's database. Returns the meta that is also written to
 * .calm/checkpoints/<id>/meta.json.
 *
 * @param {{ name?: string, note?: string, actor?: { kind: 'human' | 'agent', name: string }, auto?: boolean, silent?: boolean }} [options] silent: no Activity row (a replay's own checkpoint)
 */
export async function createCheckpoint(app, { name = 'manual', note = null, actor, auto = false, silent = false } = {}) {
  const db = guard(app);
  const label = typeof name === 'string' && name.trim() ? name.trim().slice(0, 80) : 'manual';
  const base = `${stamp()}-${slug(label)}`;
  let id = base;
  for (let n = 2; await exists(dirFor(app.root, id)); n++) id = `${base}-${n}`;
  const dir = dirFor(app.root, id);
  await mkdir(dir, { recursive: true });

  const collections = [];
  const used = new Set();
  for (const collection of await collectionNames(db)) {
    // One file per collection, named after it where the name is safe on disk.
    let file = `${collection.replace(/[^\w.-]/g, '_')}.ejson`;
    for (let n = 2; used.has(file); n++) file = `${collection.replace(/[^\w.-]/g, '_')}-${n}.ejson`;
    used.add(file);
    const docs = await dumpCollection(db.collection(collection), join(dir, file));
    collections.push({ name: collection, docs, file });
  }

  const meta = {
    id,
    name: label,
    note: typeof note === 'string' && note.trim() ? note.trim().slice(0, 500) : null,
    auto: auto === true,
    createdAt: new Date().toISOString(),
    database: db.databaseName,
    calmapi: await calmVersion(app.root),
    actor: cleanActor(actor),
    collections,
  };
  await writeFile(join(dir, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);
  if (!silent) await appendActivity(app.root, { type: 'checkpoint', action: 'created', id, name: label, actor: meta.actor, ...totals(collections) });
  return meta;
}

/** Stream a collection to disk, one canonical EJSON document per line. Returns the count. */
async function dumpCollection(collection, file) {
  const fh = await open(file, 'w');
  let docs = 0;
  let lines = [];
  try {
    // promoteValues: false keeps Int32, Double and Long apart, so a restore puts back the
    // same BSON types and not whatever JavaScript numbers would turn into.
    const cursor = collection.find({}, { promoteValues: false, sort: { _id: 1 } });
    for await (const doc of cursor) {
      lines.push(`${EJSON.stringify(doc, { relaxed: false })}\n`);
      docs++;
      if (lines.length >= WRITE_BATCH) {
        await fh.write(lines.join(''));
        lines = [];
      }
    }
    if (lines.length) await fh.write(lines.join(''));
  } finally {
    await fh.close();
  }
  return docs;
}

/** Metas of every checkpoint under root, newest first. Folders without a readable meta are skipped. */
export async function listCheckpoints(root) {
  let entries;
  try {
    entries = await readdir(checkpointsDir(root), { withFileTypes: true });
  } catch {
    return [];
  }
  const metas = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !ID.test(entry.name)) continue;
    try {
      metas.push(await readCheckpoint(root, entry.name));
    } catch {
      // half-written or foreign folder
    }
  }
  return metas.sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id));
}

export async function readCheckpoint(root, id) {
  const dir = dirFor(root, id);
  let meta;
  try {
    meta = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8'));
  } catch {
    const err = new Error(`No checkpoint "${id}" in .calm/checkpoints`);
    err.status = 404;
    throw err;
  }
  if (meta.id !== id || !Array.isArray(meta.collections)) {
    const err = new Error(`Checkpoint "${id}" has a broken meta.json`);
    err.status = 400;
    throw err;
  }
  return meta;
}

/**
 * Put the database back as it was in the checkpoint: every stored collection is emptied
 * and refilled, collections that did not exist then are dropped.
 *
 * @returns {Promise<{ id: string, name: string, collections: { name: string, docs: number }[], dropped: string[] }>}
 */
export async function restoreCheckpoint(app, id, { actor, silent = false } = {}) {
  const db = guard(app);
  const meta = await readCheckpoint(app.root, id);
  const dir = dirFor(app.root, id);
  const kept = new Set(meta.collections.map((c) => c.name));

  const dropped = [];
  for (const name of await collectionNames(db)) {
    if (kept.has(name)) continue;
    await db.dropCollection(name);
    dropped.push(name);
  }

  const collections = [];
  for (const c of meta.collections) {
    const collection = db.collection(c.name);
    await collection.deleteMany({});
    let docs = 0;
    let batch = [];
    const flush = async () => {
      if (!batch.length) return;
      await collection.insertMany(batch, { ordered: false });
      docs += batch.length;
      batch = [];
    };
    const lines = createInterface({ input: createReadStream(join(dir, c.file)), crlfDelay: Infinity });
    for await (const line of lines) {
      if (!line.trim()) continue;
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length >= BATCH) await flush();
    }
    await flush();
    collections.push({ name: c.name, docs });
  }

  // A dropped collection loses its indexes too. Models get them back at the next boot;
  // the ones this app knows about get them back now (unique email, for one).
  for (const entry of app.registry?.values?.() ?? []) {
    if (dropped.includes(entry.model?.collection?.collectionName)) await entry.model.createIndexes().catch(() => {});
  }

  const result = { id, name: meta.name, collections, dropped };
  if (!silent) await appendActivity(app.root, { type: 'checkpoint', action: 'restored', id, name: meta.name, actor: cleanActor(actor), ...totals(collections) });
  return result;
}

export async function deleteCheckpoint(root, id, { actor, silent = false } = {}) {
  const meta = await readCheckpoint(root, id);
  await rm(dirFor(root, id), { recursive: true, force: true });
  if (!silent) await appendActivity(root, { type: 'checkpoint', action: 'deleted', id, name: meta.name, actor: cleanActor(actor), ...totals(meta.collections) });
  return meta;
}
