import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { parseSchedule, nextRun, parseDuration } from './cron.js';

// A job queue stored in MongoDB (collection calm_jobs). Workers claim jobs atomically
// with findOneAndUpdate, so you can run as many instances as you like.

export function createQueue(app, { concurrency = 4, pollMs = 1000, lockTimeoutMs = 5 * 60_000, keepCompletedDays = 7 } = {}) {
  const { Schema } = app.mongoose;
  const schema = new Schema(
    {
      name: { type: String, required: true },
      data: { type: Schema.Types.Mixed, default: {} },
      status: { type: String, enum: ['queued', 'running', 'completed', 'failed'], default: 'queued' },
      runAt: { type: Date, default: () => new Date() },
      attempts: { type: Number, default: 0 },
      maxAttempts: { type: Number, default: 3 },
      lockedAt: Date,
      lockedBy: String,
      lastError: String,
      finishedAt: Date,
      uniqueKey: String,
      result: Schema.Types.Mixed,
    },
    { collection: 'calm_jobs', timestamps: true, versionKey: false },
  );
  schema.index({ status: 1, runAt: 1 });
  schema.index({ name: 1, status: 1 });
  schema.index({ uniqueKey: 1 }, { unique: true, partialFilterExpression: { uniqueKey: { $type: 'string' } } });
  schema.index({ finishedAt: 1 }, { expireAfterSeconds: keepCompletedDays * 86_400, partialFilterExpression: { status: 'completed' } });
  const Job = app.mongoose.model('calmJob', schema);

  const definitions = new Map();
  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  let running = 0;
  let timer = null;
  let stopping = false;
  let ticks = 0;
  const inflight = new Set();

  const api = {
    Job,
    /** Register a job handler. */
    define(def) {
      if (!def?.name || typeof def.run !== 'function') throw new Error('defineJob({ name, run }) needs a name and a run function');
      if (definitions.has(def.name)) throw new Error(`Job "${def.name}" is defined twice`);
      const full = { retries: 3, backoff: '10s', ...def, scheduleParsed: def.schedule ? parseSchedule(def.schedule) : null };
      definitions.set(def.name, full);
      if (def.on) app.events.on(def.on, (payload) => api.enqueue(def.name, payload));
      return full;
    },

    /** Queue a job. opts: { delay: '5m' | ms, runAt: Date, uniqueKey, retries } */
    async enqueue(name, data = {}, opts = {}) {
      const def = definitions.get(name);
      if (!def) throw new Error(`Unknown job "${name}". Known: ${[...definitions.keys()].join(', ')}`);
      const runAt = opts.runAt ?? new Date(Date.now() + (opts.delay ? parseDuration(opts.delay) : 0));
      const doc = { name, data, runAt, maxAttempts: (opts.retries ?? def.retries) + 1, ...(opts.uniqueKey ? { uniqueKey: opts.uniqueKey } : {}) };
      try {
        return (await Job.create(doc)).toObject();
      } catch (err) {
        if (err.code === 11000 && opts.uniqueKey) return Job.findOne({ uniqueKey: opts.uniqueKey }).lean();
        throw err;
      }
    },

    async stats() {
      const rows = await Job.aggregate([{ $group: { _id: { name: '$name', status: '$status' }, count: { $sum: 1 } } }]);
      const byName = {};
      for (const { _id, count } of rows) (byName[_id.name] ??= { queued: 0, running: 0, completed: 0, failed: 0 })[_id.status] = count;
      return {
        worker: timer ? workerId : 'off',
        running,
        definitions: [...definitions.values()].map((d) => ({ name: d.name, schedule: d.schedule ?? null, on: d.on ?? null, retries: d.retries })),
        byName,
      };
    },

    async retry(id) {
      const res = await Job.findOneAndUpdate({ _id: id, status: 'failed' }, { $set: { status: 'queued', runAt: new Date(), attempts: 0 }, $unset: { lastError: 1, finishedAt: 1 } }, { returnDocument: 'after' }).lean();
      return res;
    },

    /** Process everything that is due right now (tests and scripts). */
    async drain() {
      for (let i = 0; i < 1000; i++) {
        const claimed = await claim();
        if (!claimed) break;
        await execute(claimed);
      }
      await Promise.all([...inflight]);
    },

    async start() {
      for (const def of definitions.values()) if (def.scheduleParsed) await ensureScheduled(def);
      stopping = false;
      timer = setInterval(() => tick().catch((err) => app.log.error('Job worker tick failed', { err })), pollMs);
      timer.unref();
      app.log.info(`Jobs worker started (${definitions.size} jobs, concurrency ${concurrency})`);
    },

    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = null;
      await Promise.race([Promise.all([...inflight]), new Promise((r) => setTimeout(r, 10_000))]);
    },
  };

  async function ensureScheduled(def) {
    await Job.updateOne(
      { uniqueKey: `schedule:${def.name}` },
      { $setOnInsert: { name: def.name, data: {}, status: 'queued', runAt: nextRun(def.scheduleParsed), attempts: 0, maxAttempts: def.retries + 1 } },
      { upsert: true },
    );
  }

  const claim = () =>
    Job.findOneAndUpdate(
      { status: 'queued', runAt: { $lte: new Date() }, name: { $in: [...definitions.keys()] } },
      { $set: { status: 'running', lockedAt: new Date(), lockedBy: workerId }, $inc: { attempts: 1 } },
      { sort: { runAt: 1 }, returnDocument: 'after' },
    ).lean();

  async function tick() {
    if (++ticks % 30 === 0) {
      // Recover jobs whose worker died mid-run.
      await Job.updateMany({ status: 'running', lockedAt: { $lt: new Date(Date.now() - lockTimeoutMs) } }, { $set: { status: 'queued' } });
    }
    while (!stopping && running < concurrency) {
      const job = await claim();
      if (!job) break;
      running++;
      const p = execute(job).finally(() => {
        running--;
        inflight.delete(p);
      });
      inflight.add(p);
    }
  }

  async function execute(job) {
    const def = definitions.get(job.name);
    const log = app.log;
    const started = Date.now();
    try {
      const result = await def.run(job.data, { app, job, log });
      if (def.scheduleParsed) {
        await Job.updateOne({ _id: job._id }, { $set: { status: 'queued', runAt: nextRun(def.scheduleParsed), attempts: 0, result: result ?? null }, $unset: { lockedAt: 1, lockedBy: 1, lastError: 1 } });
      } else {
        await Job.updateOne({ _id: job._id }, { $set: { status: 'completed', finishedAt: new Date(), result: result ?? null }, $unset: { lockedAt: 1, lockedBy: 1 } });
      }
      app.events.emit('job.completed', { id: String(job._id), name: job.name, ms: Date.now() - started });
    } catch (err) {
      const message = String(err?.stack ?? err).slice(0, 4000);
      if (job.attempts < job.maxAttempts) {
        const wait = parseDuration(def.backoff) * 2 ** (job.attempts - 1);
        await Job.updateOne({ _id: job._id }, { $set: { status: 'queued', runAt: new Date(Date.now() + Math.min(wait, 3_600_000)), lastError: message }, $unset: { lockedAt: 1, lockedBy: 1 } });
        log.warn(`Job ${job.name} failed (attempt ${job.attempts}/${job.maxAttempts}), retrying`, { err: err?.message });
      } else if (def.scheduleParsed) {
        await Job.updateOne({ _id: job._id }, { $set: { status: 'queued', runAt: nextRun(def.scheduleParsed), attempts: 0, lastError: message }, $unset: { lockedAt: 1, lockedBy: 1 } });
        log.error(`Scheduled job ${job.name} failed, will run again at its next time`, { err: err?.message });
      } else {
        await Job.updateOne({ _id: job._id }, { $set: { status: 'failed', finishedAt: new Date(), lastError: message }, $unset: { lockedAt: 1, lockedBy: 1 } });
        log.error(`Job ${job.name} failed permanently`, { err: err?.message });
        app.events.emit('job.failed', { id: String(job._id), name: job.name, error: err?.message });
      }
    }
  }

  return api;
}
