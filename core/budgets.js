// Budgets: how much a route may cost, written in calm.config.js and measured on every
// request in development and in tests.
//
//   budgets: {
//     'GET /api/feed':     { queries: 4, p95: '150ms', response: '200kb' },
//     'GET /api/posts/*':  { queries: 6 },
//     '*':                 { queries: 12, p95: '400ms' },   // every other route
//   },
//
// queries: MongoDB commands per request (the N+1 catcher); p95: the 95th percentile of the
// time to answer; response: the size of the JSON body. Devtools shows each route against its
// budget (Budgets), and `calm budgets --ci` runs your tests with the meter on and fails when a
// route goes over. Production never measures.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEEP = 200; // samples per route

function invalid(message) {
  const err = new Error(`Invalid configuration:\n  - ${message}`);
  err.code = 'CALM_CONFIG';
  return err;
}

/** '150ms', '1.5s', 150 -> milliseconds. */
export function parseDuration(value, where) {
  if (typeof value === 'number' && value > 0) return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s)\s*$/i.exec(String(value));
  if (!m) throw invalid(`${where}: "${value}" is not a duration like "150ms" or "1s"`);
  return Number(m[1]) * (m[2].toLowerCase() === 's' ? 1000 : 1);
}

/** '200kb', '1mb', 2048 -> bytes. */
export function parseSize(value, where) {
  if (typeof value === 'number' && value > 0) return value;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb)\s*$/i.exec(String(value));
  if (!m) throw invalid(`${where}: "${value}" is not a size like "200kb" or "1mb"`);
  return Math.round(Number(m[1]) * { b: 1, kb: 1024, mb: 1024 * 1024 }[m[2].toLowerCase()]);
}

/** Validate config.budgets into matchers, most specific first. Throws CALM_CONFIG on a mistake. */
export function parseBudgets(budgets) {
  if (budgets == null) return [];
  if (typeof budgets !== 'object' || Array.isArray(budgets)) throw invalid('budgets is an object: { "GET /api/feed": { queries: 4 } }');
  const out = [];
  for (const [key, spec] of Object.entries(budgets)) {
    const where = `budgets["${key}"]`;
    if (!spec || typeof spec !== 'object') throw invalid(`${where} must be an object like { queries: 4, p95: '150ms', response: '200kb' }`);
    const unknown = Object.keys(spec).filter((k) => !['queries', 'p95', 'response'].includes(k));
    if (unknown.length) throw invalid(`${where}: unknown limit ${unknown.join(', ')} (queries, p95, response)`);
    const limits = {};
    if (spec.queries !== undefined) {
      if (!Number.isInteger(spec.queries) || spec.queries < 0) throw invalid(`${where}.queries must be a whole number`);
      limits.queries = spec.queries;
    }
    if (spec.p95 !== undefined) limits.p95Ms = parseDuration(spec.p95, `${where}.p95`);
    if (spec.response !== undefined) limits.responseBytes = parseSize(spec.response, `${where}.response`);
    if (key.trim() === '*') {
      out.push({ key, rank: 0, test: () => true, limits });
      continue;
    }
    const m = /^([A-Z]+|\*)\s+(\/\S*)$/i.exec(key.trim());
    if (!m) throw invalid(`${where}: the key is "METHOD /path" (GET /api/feed, GET /api/posts/*) or "*"`);
    const method = m[1].toUpperCase();
    const segments = m[2].split('/').filter(Boolean);
    const wild = segments.some((s) => s === '*' || s === '**') || method === '*';
    out.push({
      key,
      rank: wild ? 1 : 2,
      limits,
      test: (reqMethod, route) => {
        if (method !== '*' && method !== reqMethod) return false;
        const other = route.split('/').filter(Boolean);
        for (let i = 0; i < segments.length; i++) {
          if (segments[i] === '**') return true;
          if (i >= other.length) return false;
          if (segments[i] !== '*' && segments[i] !== other[i]) return false;
        }
        return segments.length === other.length;
      },
    });
  }
  return out.sort((a, b) => b.rank - a.rank);
}

/** The budget of a route ("GET", "/api/posts/:id"): the most specific matching entry. */
export const budgetFor = (budgets, method, route) => budgets.find((b) => b.test(method, route)) ?? null;

const p95 = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
};

/** What a single request broke: queries and response size are per request; time is judged on p95. */
export function overBudget(limits, sample) {
  const over = [];
  if (limits.queries !== undefined && sample.queries > limits.queries) over.push({ limit: 'queries', value: sample.queries, max: limits.queries, text: `${sample.queries} queries (budget ${limits.queries})` });
  if (limits.responseBytes !== undefined && sample.bytes > limits.responseBytes) over.push({ limit: 'response', value: sample.bytes, max: limits.responseBytes, text: `${fmtBytes(sample.bytes)} response (budget ${fmtBytes(limits.responseBytes)})` });
  return over;
}

export const fmtBytes = (n) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`);

/** Samples per route, and the report devtools and `calm budgets` print. */
export function createMeter(budgets) {
  const routes = new Map();
  return {
    record(method, route, sample) {
      const key = `${method} ${route}`;
      if (!routes.has(key)) routes.set(key, { method, route, samples: [] });
      const r = routes.get(key);
      r.samples.push(sample);
      if (r.samples.length > KEEP) r.samples.shift();
    },
    samples: () => [...routes.values()],
    report: () => budgetReport(budgets, [...routes.values()]),
    clear: () => routes.clear(),
  };
}

export function budgetReport(budgets, routes) {
  const rows = routes.map(({ method, route, samples }) => {
    const budget = budgetFor(budgets, method, route);
    const stats = {
      count: samples.length,
      p95Ms: p95(samples.map((s) => s.ms)),
      maxQueries: Math.max(0, ...samples.map((s) => s.queries)),
      maxBytes: Math.max(0, ...samples.map((s) => s.bytes)),
    };
    const limits = budget?.limits ?? {};
    const over = [];
    if (limits.queries !== undefined && stats.maxQueries > limits.queries) over.push(`queries ${stats.maxQueries} > ${limits.queries}`);
    if (limits.p95Ms !== undefined && stats.p95Ms > limits.p95Ms) over.push(`p95 ${Math.round(stats.p95Ms)}ms > ${limits.p95Ms}ms`);
    if (limits.responseBytes !== undefined && stats.maxBytes > limits.responseBytes) over.push(`response ${fmtBytes(stats.maxBytes)} > ${fmtBytes(limits.responseBytes)}`);
    return { method, route, budget: budget?.key ?? null, limits, ...stats, over, ok: !over.length };
  });
  rows.sort((a, b) => Number(a.ok) - Number(b.ok) || `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`));
  return { configured: budgets.length > 0, routes: rows, over: rows.filter((r) => !r.ok).length };
}

/** In tests with CALM_BUDGETS set: write this process's samples where `calm budgets` collects them. */
export function writeSamples(app, meter) {
  const dir = process.env.CALM_BUDGETS_DIR;
  if (!dir) return;
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${process.pid}-${Date.now().toString(36)}.json`), JSON.stringify({ routes: meter.samples() }));
  } catch (err) {
    app.log.warn(`Could not write budget samples: ${err.message}`);
  }
}
