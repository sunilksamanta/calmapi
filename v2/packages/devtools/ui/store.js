// Shared state for every panel, kept fresh by the /stream Server-Sent Events.

import { api, API } from './lib.js';

const MAX_REQUESTS = 300;
const MAX_LOGS = 1000;

export const store = {
  overview: null,
  overviewAt: 0,
  requests: [],
  logs: [],
  mails: [],
  doctor: null,
  live: false,
  actAs: null, // { token, expiresAt, user } from POST /act-as, memory only
  prefill: null, // playground prefill from "Try it" buttons
  seenMail: new Set(),
  records: new Map(), // full request records by id
};

const listeners = new Map();

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event)?.delete(fn);
}

export function emit(event, data) {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(data);
    } catch (err) {
      console.error(err);
    }
  }
}

// ---- loading -------------------------------------------------------------------

let signature = '';
export async function loadOverview() {
  const ov = await api('/overview');
  store.overview = ov;
  store.overviewAt = Date.now();
  const sig = JSON.stringify([ov.resources, ov.routes, ov.panels, ov.blocks]);
  const changed = sig !== signature;
  signature = sig;
  emit('overview', { changed });
  return ov;
}

export async function loadRequests() {
  store.requests = await api('/requests');
  emit('requests:reset');
}

export async function loadLogs() {
  store.logs = await api('/logs');
  emit('logs:reset');
}

export async function loadMails() {
  store.mails = await api('/mails');
  emit('mails:reset');
}

export async function loadDoctor() {
  store.doctor = await api('/doctor');
  emit('doctor');
  return store.doctor;
}

export async function getRecord(id) {
  if (store.records.has(id)) return store.records.get(id);
  const rec = await api(`/requests/${encodeURIComponent(id)}`);
  store.records.set(id, rec);
  if (store.records.size > 60) store.records.delete(store.records.keys().next().value);
  return rec;
}

export async function clearRequests() {
  await api('/requests', { method: 'DELETE' });
  store.requests = [];
  store.records.clear();
  emit('requests:reset');
}

// ---- act as ----------------------------------------------------------------------

export async function startActAs(user) {
  const session = await api('/act-as', { method: 'POST', body: { userId: user.id } });
  store.actAs = session;
  emit('actas');
  return session;
}

export function stopActAs() {
  store.actAs = null;
  emit('actas');
}

export const authHeader = () => (store.actAs ? { Authorization: `Bearer ${store.actAs.token}` } : {});

// ---- live stream -------------------------------------------------------------------

export function connect() {
  let wasDown = false;
  const es = new EventSource(`${API}/stream`);
  es.addEventListener('open', () => {
    store.live = true;
    emit('live');
    if (wasDown) {
      // The server restarted (or the connection dropped): resync everything.
      wasDown = false;
      Promise.allSettled([loadOverview(), loadRequests(), loadLogs(), loadMails(), loadDoctor()]);
    }
  });
  es.addEventListener('error', () => {
    if (store.live) {
      store.live = false;
      emit('live');
    }
    wasDown = true;
  });
  es.addEventListener('request', (e) => {
    const r = JSON.parse(e.data);
    if (store.requests.some((x) => x.id === r.id)) return;
    store.requests.unshift(r);
    if (store.requests.length > MAX_REQUESTS) store.requests.length = MAX_REQUESTS;
    emit('request', r);
  });
  es.addEventListener('log', (e) => {
    const entry = JSON.parse(e.data);
    store.logs.push(entry);
    if (store.logs.length > MAX_LOGS) store.logs.splice(0, store.logs.length - MAX_LOGS);
    emit('log', entry);
  });
  es.addEventListener('mail', async () => {
    try {
      store.mails = await api('/mails');
    } catch {
      return;
    }
    emit('mails:reset', { fresh: true });
  });
  return es;
}
