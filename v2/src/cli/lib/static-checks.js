import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { PKG_ROOT, walk, readText, readJson, sha256 } from './files.js';

/** Minimal glob: supports `**` (any folders) and `*` (within a segment). */
export function globToRegex(glob) {
  const parts = glob.split('/');
  const re = parts
    .map((seg, i) => {
      if (seg === '**') return '(?:[^/]+/)*';
      const escaped = seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*');
      return i === parts.length - 1 ? escaped : `${escaped}/`;
    })
    .join('');
  return new RegExp(`^${re}$`);
}

const filesMatching = (root, files, glob) => {
  const re = globToRegex(glob);
  return files.filter((f) => re.test(f));
};

/** Check advisories.json against a project. Returns findings. */
export function scanAdvisories(root, kind) {
  const feed = process.env.CALM_ADVISORIES ?? join(PKG_ROOT, 'advisories.json');
  const { advisories } = readJson(feed, { advisories: [] });
  const files = walk(root, { ignore: ['node_modules', '.git'] });
  const hit = ({ files: glob, pattern }) =>
    filesMatching(root, files, glob).some((f) => new RegExp(pattern).test(readText(join(root, f))));

  const findings = [];
  for (const a of advisories) {
    if (a.project !== kind) continue;
    if (!a.match.every(hit)) continue;
    if ((a.absent ?? []).some(hit)) continue;
    findings.push({
      level: a.severity === 'low' ? 'warn' : 'error',
      id: a.id,
      title: `${a.id} (${a.severity}): ${a.title}`,
      detail: `${a.detail}\nFix: ${a.fix}\n${a.url}`,
    });
  }
  return findings;
}

const RULES = [
  {
    id: 'populate-without-select',
    level: 'warn',
    test: /\.populate\(\s*(['"`][\w.]+['"`]|\{\s*path:\s*['"`][\w.]+['"`]\s*\})\s*\)/,
    title: 'populate() without a select',
    detail: 'Populated documents come back whole. Pass a select, or use ?include= on resource routes (safe projections).',
  },
  {
    id: 'regex-from-input',
    level: 'warn',
    test: /new RegExp\([^)]*(req\.|ctx\.(query|body|params))/,
    title: 'RegExp built from request input',
    detail: 'User input in a RegExp allows ReDoS and regex injection. Escape it (escapeRegex) or use .searchable() fields.',
  },
  {
    id: 'weak-random',
    level: 'error',
    test: /Math\.random\(\)/,
    when: /token|otp|code|secret|password|nonce/i,
    title: 'Math.random() near secrets',
    detail: 'Math.random() is predictable. Use crypto.randomBytes / crypto.randomInt for anything secret.',
  },
  {
    id: 'raw-res-json',
    level: 'info',
    test: /\bres\.(json|send)\(/,
    title: 'Writes the response directly',
    detail: 'Returning a value from the handler gets serialization (hidden fields stripped) and consistent envelopes for free.',
  },
  {
    id: 'logs-secrets',
    level: 'warn',
    test: /console\.(log|info|debug)\([^)]*(password|token|otp|secret)/i,
    title: 'Logs something that looks secret',
    detail: 'Logs are often shipped to third parties. Remove secrets from log calls.',
  },
];

const SECRETS = [
  { id: 'aws-key', re: /AKIA[0-9A-Z]{16}/, what: 'an AWS access key' },
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/, what: 'a private key' },
  { id: 'stripe-key', re: /\b[sr]k_live_[0-9a-zA-Z]{16,}/, what: 'a Stripe live key' },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}/, what: 'a GitHub token' },
  { id: 'slack-token', re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { id: 'resend-key', re: /\bre_[A-Za-z0-9]{20,}/, what: 'a Resend API key' },
  { id: 'db-credentials', re: /mongodb(?:\+srv)?:\/\/[^\s'"`:@/]+:[^\s'"`@/]+@/, what: 'database credentials' },
  { id: 'generic-secret', re: /(?:api[_-]?key|secret|token|passw(?:or)?d)\s*[:=]\s*['"`][A-Za-z0-9_\-+/=.]{16,}['"`]/i, what: 'a hardcoded secret' },
];

/** Hardcoded credentials in source files (values are masked in the report). */
export function secretChecks(root) {
  const findings = [];
  const files = walk(root, { ignore: ['node_modules', '.git', 'calm', 'test', 'coverage'] }).filter(
    (f) => /\.(m?js|cjs|ts|json|ya?ml)$/.test(f) && !f.endsWith('package-lock.json') && f !== 'calm.lock' && !f.startsWith('.calm/'),
  );
  for (const rel of files) {
    const lines = readText(join(root, rel)).split('\n');
    lines.forEach((line, i) => {
      for (const s of SECRETS) {
        const m = s.re.exec(line);
        if (!m) continue;
        findings.push({
          level: 'error',
          id: `secret-${s.id}`,
          title: `Looks like ${s.what} in source code`,
          detail: `Found "${m[0].slice(0, 6)}…" Move it to an environment variable (.env, never committed) and rotate it: anything that reached git is compromised.`,
          file: `${rel}:${i + 1}`,
        });
        break;
      }
    });
  }
  return findings;
}

/** Pattern checks over app/ source plus project hygiene. */
export function staticChecks(root, lock) {
  const findings = [...secretChecks(root)];
  for (const rel of walk(join(root, 'app'))) {
    if (!rel.endsWith('.js')) continue;
    const text = readText(join(root, 'app', rel));
    const lines = text.split('\n');
    for (const rule of RULES) {
      if (rule.when && !rule.when.test(text)) continue;
      const idx = lines.findIndex((l) => rule.test.test(l));
      if (idx !== -1) findings.push({ level: rule.level, id: rule.id, title: rule.title, detail: rule.detail, file: `app/${rel}:${idx + 1}` });
    }
  }

  const gitignore = existsSync(join(root, '.gitignore')) ? readText(join(root, '.gitignore')) : '';
  if (!/^\.env$/m.test(gitignore)) findings.push({ level: 'error', id: 'env-not-ignored', title: '.env is not in .gitignore', detail: 'Secrets in .env would be committed. Add a line: .env' });

  if (lock?.core) {
    const changed = Object.entries(lock.core).filter(([rel, hash]) => existsSync(join(root, rel)) && sha256(readText(join(root, rel))) !== hash);
    const missing = Object.keys(lock.core).filter((rel) => !existsSync(join(root, rel)));
    if (changed.length) {
      findings.push({ level: 'info', id: 'core-modified', title: `${changed.length} framework file(s) in calm/ changed locally`, detail: `That is fine, they are yours. \`calm upgrade\` will merge upstream fixes into: ${changed.map(([r]) => r).join(', ')}` });
    }
    if (missing.length) findings.push({ level: 'warn', id: 'core-missing', title: `${missing.length} framework file(s) deleted from calm/`, detail: missing.join(', ') });
  }
  return findings;
}

/** .env committed to git? (only when the project is a git repository) */
export async function gitChecks(root, capture) {
  if (!existsSync(join(root, '.git'))) return [];
  const tracked = await capture('git', ['ls-files', '--error-unmatch', '.env'], { cwd: root }).catch(() => ({ code: 1 }));
  return tracked.code === 0
    ? [{ level: 'error', id: 'env-committed', title: '.env is committed to git', detail: 'Remove it from the repository (git rm --cached .env), rotate every secret in it, and keep it in .gitignore.' }]
    : [];
}

/** npm audit summary for production dependencies. */
export async function auditChecks(root, capture) {
  const res = await capture('npm', ['audit', '--json', '--omit=dev'], { cwd: root }).catch(() => null);
  let report;
  try {
    report = JSON.parse(res?.stdout ?? '');
  } catch {
    return [{ level: 'info', id: 'npm-audit', title: 'npm audit could not run', detail: 'Check your network or run `npm audit` yourself.' }];
  }
  const v = report.metadata?.vulnerabilities ?? {};
  const serious = (v.high ?? 0) + (v.critical ?? 0);
  if (!serious && !v.moderate) return [{ level: 'info', id: 'npm-audit', title: 'npm audit: no known vulnerabilities in production dependencies' }];
  return [{
    level: serious ? 'error' : 'warn',
    id: 'npm-audit',
    title: `npm audit: ${v.critical ?? 0} critical, ${v.high ?? 0} high, ${v.moderate ?? 0} moderate`,
    detail: 'Run `npm audit` for details and `npm audit fix` to update.',
  }];
}
