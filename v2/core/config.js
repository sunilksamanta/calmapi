import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isPlainObject } from './utils/strings.js';

/** Identity helper so editors can autocomplete calm.config.js. */
export const defineConfig = (config) => config;

/**
 * Load configuration: .env file, then calm.config.js, merged over the defaults below.
 * Fails fast with a readable list of problems instead of booting half configured.
 */
export async function loadConfig(root, overrides = {}) {
  const envFile = join(root, '.env');
  if (existsSync(envFile) && process.env.CALM_SKIP_ENV_FILE !== '1') process.loadEnvFile(envFile);

  const env = process.env;
  // Secure by default: anything that is not explicitly development or test (staging,
  // preview, unset...) runs with production rules. `calm dev` sets NODE_ENV=development;
  // tests pass { mode: 'test' }. The raw value stays available as config.nodeEnv.
  const nodeEnv = overrides.mode ?? env.NODE_ENV ?? '';
  const mode = nodeEnv === 'development' || nodeEnv === 'test' ? nodeEnv : 'production';
  const pkg = readJson(join(root, 'package.json')) ?? {};

  let user = {};
  const file = join(root, 'calm.config.js');
  if (existsSync(file)) {
    const mod = await import(pathToFileURL(file).href);
    user = typeof mod.default === 'function' ? await mod.default({ env, mode }) : (mod.default ?? {});
  }

  const port = Number(env.PORT) || 5001;
  const defaults = {
    root,
    mode,
    nodeEnv,
    app: { name: pkg.name ?? 'calm-app', version: pkg.version ?? '0.0.0', url: env.APP_URL || `http://localhost:${port}` },
    port,
    host: env.HOST || undefined,
    apiPrefix: '/api',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    bodyLimit: '1mb',
    jsonLimits: { maxDepth: 20, maxKeys: 10_000 },
    db: { uri: env.MONGODB_URI, autoIndex: true, connectRetries: 5 },
    cors: { origins: env.CORS_ORIGINS ? env.CORS_ORIGINS.split(',').map((s) => s.trim()) : mode === 'production' ? [] : '*' },
    pagination: { defaultLimit: 20, maxLimit: 100 },
    unknownFields: 'reject',
    rateLimit: {
      enabled: mode !== 'test',
      global: { windowMs: 60_000, max: 300 },
      auth: { windowMs: 15 * 60_000, max: 10 },
    },
    auth: {
      enabled: true,
      register: true,
      sessionTtlDays: 30,
      resetTokenTtlMinutes: 30,
      resetUrl: null,
      password: { logN: 15, r: 8, p: 3 }, // scrypt cost; length rules live on f.password()
      lockout: { maxAttempts: 5, windowMinutes: 15, lockMinutes: 15 }, // per account, 0 disables
      devicesFollowSessions: true, // push devices stop with the session that registered them
    },
    openapi: { enabled: true, path: '/openapi.json' },
    devtools: { enabled: mode === 'development' },
    blocks: {}, // per-block settings: blocks: { jobs: { pollMs: 500 } } (see each block's options)
    // Promises that must stay true: 'no public write routes', 'personal data is never public'... (calm/invariants.js)
    invariants: [],
    // What a route may cost: { 'GET /api/feed': { queries: 4, p95: '150ms', response: '200kb' }, '*': { queries: 12 } } (calm/budgets.js)
    budgets: {},
    agents: { scope: 'full', protected: ['calm/security/**', 'calm/auth/**', 'calm.config.js'] }, // AI agents over calm mcp: default scope (read | scaffold | full) and paths they must not edit without you
    log: { level: env.LOG_LEVEL || (mode === 'test' ? 'silent' : 'info'), format: mode === 'production' ? 'json' : 'pretty' },
    shutdownTimeoutMs: 10_000,
  };

  const { mode: _mode, ...rest } = overrides; // mode was normalized above
  const config = deepMerge(deepMerge(defaults, user), rest);
  config.auth.resetUrl ??= `${config.app.url.replace(/\/$/, '')}/reset-password`;
  if (mode === 'production') config.devtools.enabled = false; // never, whatever the config says

  const problems = [];
  if (!config.db.uri) problems.push('MONGODB_URI is not set (add it to .env)');
  if (mode === 'production' && !env.APP_URL) problems.push('APP_URL must be set in production (used in emails and links)');
  if (problems.length) {
    const err = new Error(`Invalid configuration:\n  - ${problems.join('\n  - ')}`);
    err.code = 'CALM_CONFIG';
    throw err;
  }
  return config;
}

export function deepMerge(base, extra) {
  if (!isPlainObject(extra)) return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function parseTrustProxy(value) {
  if (value === undefined || value === '') return false;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^\d+$/.test(value) ? Number(value) : value;
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}
