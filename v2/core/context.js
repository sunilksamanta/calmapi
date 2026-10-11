import { AsyncLocalStorage } from 'node:async_hooks';

// Per-request context. Anything running inside a request (services, hooks, Mongo
// commands, logs) can call currentRequest() without passing req around.
const storage = new AsyncLocalStorage();

export const runWithRequest = (store, fn) => storage.run(store, fn);
export const currentRequest = () => storage.getStore();
