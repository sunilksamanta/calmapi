// Where cached responses live. A store is any object with these async methods:
//
//   get(key)            the entry, or null (expired entries count as missing)
//   set(key, entry)     entry = { body, contentType, etag, tags, path, expiresAt (ms) }
//   deleteTag(tag)      remove every entry carrying this tag
//   deletePrefix(path)  remove every entry whose path starts with this
//   clear()
//
// Pass your own as blocks.cache.store (Redis, ...). The two below ship with the block.

/**
 * In memory, per process: fastest, but each instance has its own copy and invalidations
 * reach only the process that saw the change. An LRU: the least recently used entry goes
 * first when maxEntries is reached.
 */
export function memoryStore({ maxEntries = 1000 } = {}) {
  const entries = new Map(); // Map keeps insertion order: re-inserting on read makes it an LRU
  const drop = (test) => {
    for (const [key, entry] of entries) if (test(entry)) entries.delete(key);
  };
  return {
    name: 'memory',
    async get(key) {
      const entry = entries.get(key);
      if (!entry) return null;
      entries.delete(key);
      if (entry.expiresAt <= Date.now()) return null;
      entries.set(key, entry);
      return entry;
    },
    async set(key, entry) {
      entries.delete(key);
      entries.set(key, entry);
      while (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    async deleteTag(tag) {
      drop((e) => e.tags.includes(tag));
    },
    async deletePrefix(prefix) {
      drop((e) => e.path.startsWith(prefix));
    },
    async clear() {
      entries.clear();
    },
    size: () => entries.size,
  };
}

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * In MongoDB (calm_cache): shared by every instance, so an invalidation on one clears it for
 * all. A TTL index removes expired entries; reads also skip them, since the TTL monitor
 * only runs once a minute. Bodies are encrypted at rest when CALM_ENCRYPTION_KEYS is set:
 * cached answers can hold personal data.
 */
export function mongoStore({ mongoose, cipher = null }) {
  const { Schema } = mongoose;
  const schema = new Schema(
    {
      _id: String, // the cache key (a SHA-256)
      body: { type: String, required: true },
      contentType: String,
      etag: String,
      tags: { type: [String], index: true },
      path: { type: String, index: true },
      expiresAt: { type: Date, required: true },
    },
    { collection: 'calm_cache', versionKey: false },
  );
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  const Entry = mongoose.model('calmCacheEntry', schema);
  const seal = (text) => (cipher ? cipher.encrypt(text) : text);
  const open = (text) => (cipher ? cipher.decrypt(text) : text);

  return {
    name: 'mongo',
    model: Entry,
    init: () => Entry.init(),
    async get(key) {
      const doc = await Entry.findOne({ _id: key, expiresAt: { $gt: new Date() } }).lean();
      if (!doc) return null;
      try {
        return { ...doc, body: open(doc.body), expiresAt: doc.expiresAt.getTime() };
      } catch {
        return null; // encrypted with a key that is gone: a miss, recomputed
      }
    },
    async set(key, entry) {
      const doc = { body: seal(entry.body), contentType: entry.contentType, etag: entry.etag, tags: entry.tags, path: entry.path, expiresAt: new Date(entry.expiresAt) };
      await Entry.replaceOne({ _id: key }, doc, { upsert: true });
    },
    async deleteTag(tag) {
      await Entry.deleteMany({ tags: tag });
    },
    async deletePrefix(prefix) {
      await Entry.deleteMany({ path: { $regex: `^${escapeRegex(prefix)}` } });
    },
    async clear() {
      await Entry.deleteMany({});
    },
  };
}
