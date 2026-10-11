import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { definePlugin, notFound, badRequest } from '#calm';
import { createQueue } from './queue.js';

/** Declare a job in app/jobs/<name>.js */
export const defineJob = (def) => ({ kind: 'calm.job', ...def });

export default definePlugin({
  name: 'jobs',
  async setup(calm) {
    const queue = createQueue(calm.app, { concurrency: Number(process.env.JOBS_CONCURRENCY || 4) });
    calm.provide('jobs', queue);

    const dir = join(calm.app.root, 'app', 'jobs');
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.js')).sort()) {
        const def = (await import(pathToFileURL(join(dir, file)).href)).default;
        if (def?.kind !== 'calm.job') throw new Error(`app/jobs/${file} must "export default defineJob({ ... })"`);
        queue.define(def);
      }
    }

    const workerOn = process.env.JOBS_WORKER !== 'off' && calm.config.mode !== 'test';
    if (workerOn) {
      calm.onStart(() => queue.start());
      calm.onShutdown(() => queue.stop());
    }

    calm.routes(
      (r) => {
        r.get('/', { policy: 'admin', summary: 'List jobs', tags: ['jobs'] }, async (ctx) => {
          const filter = {};
          if (ctx.query.status) filter.status = String(ctx.query.status);
          if (ctx.query.name) filter.name = String(ctx.query.name);
          const limit = Math.min(Number(ctx.query.limit) || 50, 200);
          const jobs = await queue.Job.find(filter).sort({ updatedAt: -1 }).limit(limit).lean();
          return jobs.map(view);
        });
        r.get('/stats', { policy: 'admin', summary: 'Job counts by name and status', tags: ['jobs'] }, () => queue.stats());
        r.post('/:jobId/retry', { policy: 'admin', summary: 'Retry a failed job', tags: ['jobs'] }, async (ctx) => {
          const job = await queue.retry(ctx.params.jobId).catch(() => null);
          if (!job) throw notFound('No failed job with that id');
          return view(job);
        });
        r.post('/enqueue', { policy: 'admin', summary: 'Queue a job by name', tags: ['jobs'] }, async (ctx) => {
          const { name, data } = ctx.req.body ?? {};
          if (typeof name !== 'string') throw badRequest('name is required');
          return view(await queue.enqueue(name, data ?? {}));
        });
      },
      { prefix: '/jobs' },
    );

    calm.devtools.panel('jobs', async () => {
      const stats = await queue.stats();
      const recent = await queue.Job.find().sort({ updatedAt: -1 }).limit(25).lean();
      return { ...stats, recent: recent.map(view) };
    });

    calm.doctor(() =>
      process.env.JOBS_WORKER === 'off'
        ? [{ level: 'info', id: 'jobs-worker-off', title: 'Jobs worker is off on this instance', detail: 'JOBS_WORKER=off: make sure another process runs with JOBS_WORKER=on.' }]
        : [],
    );
  },
});

const view = (j) => ({
  id: String(j._id),
  name: j.name,
  status: j.status,
  attempts: j.attempts,
  maxAttempts: j.maxAttempts,
  runAt: j.runAt,
  finishedAt: j.finishedAt ?? null,
  lastError: j.lastError ? j.lastError.split('\n')[0] : null,
  scheduled: Boolean(j.uniqueKey?.startsWith('schedule:')),
});
