import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context. Anything running inside a request (services, hooks, Mongo
// commands, logs) can call currentRequest() without passing req around.
const storage = new AsyncLocalStorage();

export const runWithRequest = (store, fn) => storage.run(store, fn);
export const currentRequest = () => storage.getStore();

const tenth = (n) => Math.round(n * 10) / 10;

/**
 * Record one step of the path a request takes through the code (the Path tab in
 * devtools, `calm_explain` for agents). A step is { kind, name, file?, line?, detail?, outcome? }
 * with kind one of middleware | rateLimit | auth | guard | policy | input | service | hook |
 * handler | event | error. Outside a request, or when devtools is off, it is a no-op, so
 * production pays nothing. Blocks and your own code can add their own steps:
 *
 *   trace({ kind: 'guard', name: 'tenant', detail: 'org acme', outcome: 'passed' });
 */
export function trace(step) {
  const store = storage.getStore();
  if (!store?.steps) return null;
  const rec = { at: tenth(performance.now() - store.startedAt), ...step };
  store.steps.push(rec);
  return rec;
}

/**
 * Run fn as a step: records when it started, how long it took (ms) and whether it threw.
 * `after(result)` can add fields once the result is known (a detail, another outcome).
 */
export async function traced(step, fn, after) {
  const rec = trace(step);
  if (!rec) return fn();
  const started = performance.now();
  try {
    const out = await fn();
    Object.assign(rec, { outcome: 'passed', ms: tenth(performance.now() - started) }, after?.(out));
    return out;
  } catch (err) {
    Object.assign(rec, { outcome: 'failed', ms: tenth(performance.now() - started), detail: rec.detail ?? describeError(err) });
    throw err;
  }
}

/** One line for an error: per-field messages when it has them, else its message. */
function describeError(err) {
  const details = err?.details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    return Object.entries(details).map(([k, v]) => `${k}: ${v}`).join(', ');
  }
  return err?.message ?? String(err);
}
