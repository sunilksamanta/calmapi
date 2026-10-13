// In-process event bus. Resources emit `<resource>.created|updated|deleted`, auth emits
// `auth.*`. Listeners run after the response path continues and never break a request:
// errors are logged. Patterns: exact name, 'post.*', or '*'.

import { trace } from './context.js';

export function createEvents(log) {
  const listeners = new Map();
  const pending = new Set();

  const matches = (pattern, name) =>
    pattern === '*' || pattern === name || (pattern.endsWith('.*') && name.startsWith(pattern.slice(0, -1)));

  return {
    on(pattern, fn) {
      if (!listeners.has(pattern)) listeners.set(pattern, new Set());
      listeners.get(pattern).add(fn);
      return () => listeners.get(pattern)?.delete(fn);
    },
    emit(name, payload) {
      let count = 0;
      for (const [pattern, fns] of listeners) {
        if (!matches(pattern, name)) continue;
        count += fns.size;
        for (const fn of fns) {
          const p = Promise.resolve()
            .then(() => fn(payload, name))
            .catch((err) => log.error(`Event listener for "${name}" failed`, { err }))
            .finally(() => pending.delete(p));
          pending.add(p);
        }
      }
      trace({ kind: 'event', name, detail: `${count} listener${count === 1 ? '' : 's'}` });
    },
    /** Resolves when every listener started so far has finished (tests, shutdown). */
    async idle() {
      while (pending.size) await Promise.allSettled([...pending]);
    },
  };
}
