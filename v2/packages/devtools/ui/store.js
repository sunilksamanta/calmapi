// Shared state for every panel, kept fresh by the /stream Server-Sent Events.

import { api, API, storage } from './lib.js';

const MAX_REQUESTS = 300;
const MAX_LOGS = 1000;
const MAX_ACTIVITY = 500;
const MAX_SECURITY = 300;

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
  activity: [], // project activity, newest first (calm dev + calm mcp)
  activitySeen: storage.get('activity-seen', null), // ISO time of the newest event seen in the panel
  security: null, // { matrix, events, posture } from GET /security
  audit: null, // last audit report (or { summary } when it ran elsewhere)
  auditRunning: false,
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

export async function loadActivity() {
  store.activity = await api('/activity');
  // First visit ever: start counting from now instead of flagging the whole history as new.
  if (store.activitySeen == null) markActivitySeen();
  emit('activity:reset');
}

export function markActivitySeen() {
  const newest = store.activity[0]?.time ?? new Date(0).toISOString();
  if (store.activitySeen && store.activitySeen >= newest) return;
  store.activitySeen = newest;
  storage.set('activity-seen', newest);
  emit('activity:seen');
}

export const unseenActivity = () => (store.activitySeen ? store.activity.filter((e) => e.time > store.activitySeen) : []);

export async function loadSecurity() {
  store.security = await api('/security');
  emit('security:reset');
  return store.security;
}

export async function runAudit() {
  if (store.auditRunning) return;
  store.auditRunning = true;
  emit('audit:start');
  try {
    store.audit = await api('/audit', { method: 'POST' });
  } catch (err) {
    store.audit = { error: err.message };
  } finally {
    store.auditRunning = false;
    emit('audit');
  }
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
      Promise.allSettled([loadOverview(), loadRequests(), loadLogs(), loadMails(), loadDoctor(), loadActivity()]);
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
  es.addEventListener('activity', (e) => {
    const event = JSON.parse(e.data);
    if (store.activity.some((x) => x.id === event.id)) return;
    store.activity.unshift(event);
    if (store.activity.length > MAX_ACTIVITY) store.activity.length = MAX_ACTIVITY;
    emit('activity', event);
  });
  es.addEventListener('security', (e) => {
    const event = JSON.parse(e.data);
    if (store.security) {
      store.security.events.unshift(event);
      if (store.security.events.length > MAX_SECURITY) store.security.events.length = MAX_SECURITY;
    }
    emit('security', event);
  });
  es.addEventListener('audit', (e) => {
    // An audit finished (here, in another tab, or from an agent via calm_audit).
    if (store.auditRunning) return;
    store.audit = { summary: JSON.parse(e.data), elsewhere: true };
    emit('audit');
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
