import { CalmError } from '#calm';
import { TokenError, decodeJwt, candidateKeys, verifySignature, checkClaims } from './jwt.js';

// Providers: built-in presets, OpenID Connect discovery, the code exchange and the profile.
//
//  - Every endpoint comes from calm.config.js or from the discovery document of an issuer
//    set there, never from a request, so callers cannot point the server at other hosts.
//    Redirects are not followed, and production refuses endpoints that are not https.
//  - The discovery document must name the configured issuer (OpenID Connect Discovery 4.3),
//    so a document served from the wrong place cannot swap the keys or endpoints.
//  - JWKS are cached for an hour and fetched again (at most every 10 s) when a token is
//    signed with a key id we do not know yet: that is how providers rotate keys.

export const PRESETS = {
  google: {
    type: 'oidc',
    name: 'Google',
    issuer: 'https://accounts.google.com',
    // Google signs some ID tokens with the issuer written without the scheme.
    issuers: ['https://accounts.google.com', 'accounts.google.com'],
    scopes: ['openid', 'email', 'profile'],
    clientIdEnv: 'GOOGLE_CLIENT_ID',
    clientSecretEnv: 'GOOGLE_CLIENT_SECRET',
  },
  github: {
    type: 'github',
    name: 'GitHub',
    authorizationUrl: 'https://github.com/login/oauth/authorize',
    tokenUrl: 'https://github.com/login/oauth/access_token',
    userinfoUrl: 'https://api.github.com/user',
    emailsUrl: 'https://api.github.com/user/emails',
    scopes: ['read:user', 'user:email'],
    clientIdEnv: 'GITHUB_CLIENT_ID',
    clientSecretEnv: 'GITHUB_CLIENT_SECRET',
  },
};

const TYPES = ['oidc', 'oauth2', 'github'];
const DISCOVERY_TTL_MS = 60 * 60_000;
const JWKS_TTL_MS = 60 * 60_000;
const JWKS_REFRESH_MS = 10_000;

/** Failure talking to the provider, or an answer we refuse. `reason` goes to security events. */
export class ProviderError extends CalmError {
  constructor(status, code, message, reason) {
    super(status, code, message);
    this.reason = reason;
  }
}
const failed = (reason, message = 'Sign-in with this provider failed. Try again.') => new ProviderError(400, 'OAUTH_FAILED', message, reason);
const unreachable = (reason) => new ProviderError(502, 'OAUTH_PROVIDER_ERROR', 'The sign-in provider did not answer. Try again in a moment.', reason);

/**
 * Turn options.providers into provider records. Entries are merged over the preset of the
 * same id (or `preset`); `false` turns an entry off. Records without credentials are kept
 * with enabled: false so doctor can name them.
 */
export function resolveProviders(entries, env) {
  const out = [];
  for (const [id, entry] of Object.entries(entries ?? {})) {
    if (entry === false || entry === null) continue;
    if (!/^[a-z][a-z0-9-]*$/.test(id)) throw new Error(`oauth: provider id "${id}" must be lowercase letters, digits and dashes`);
    const preset = PRESETS[entry.preset ?? id] ?? {};
    const p = { id, ...preset, ...entry };
    if (!TYPES.includes(p.type)) throw new Error(`oauth: provider "${id}" needs type: ${TYPES.map((x) => `'${x}'`).join(', ')}`);
    if (p.type === 'oidc' && !p.issuer) throw new Error(`oauth: provider "${id}" (oidc) needs an issuer`);
    if (p.type !== 'oidc' && !(p.authorizationUrl && p.tokenUrl && p.userinfoUrl)) {
      throw new Error(`oauth: provider "${id}" needs authorizationUrl, tokenUrl and userinfoUrl`);
    }
    p.name ??= id;
    p.clientId ??= p.clientIdEnv ? env(p.clientIdEnv) : undefined;
    p.clientSecret ??= p.clientSecretEnv ? env(p.clientSecretEnv) : undefined;
    p.issuers ??= p.issuer ? [p.issuer] : [];
    if (entry.issuer && !entry.issuers) p.issuers = [entry.issuer]; // a new issuer replaces the preset's aliases
    p.scopes ??= p.type === 'oidc' ? ['openid', 'email', 'profile'] : [];
    p.pkce ??= true;
    p.tokenAuth ??= 'post';
    p.enabled = Boolean(p.clientId && p.clientSecret);
    out.push(p);
  }
  return out;
}

/** HTTP calls, discovery and key caches for a set of providers. */
export function createClient({ timeoutMs, production, userAgent }) {
  const discovery = new Map(); // issuer -> { doc, at }
  const jwks = new Map(); // url -> { keys, at }

  function checkUrl(url, what) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error(`oauth: ${what} "${url}" is not a URL`);
    }
    // Codes, client secrets and tokens travel on these requests: never in clear text in production.
    if (production && parsed.protocol !== 'https:') throw new Error(`oauth: ${what} must use https in production (${parsed.origin})`);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`oauth: ${what} must be an http(s) URL`);
    return parsed.href;
  }

  async function call(url, init, what) {
    let res;
    try {
      res = await fetch(checkUrl(url, what), { ...init, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('oauth:')) throw err;
      throw unreachable(`${what}_unreachable`);
    }
    const text = await res.text().catch(() => '');
    let body;
    try {
      body = JSON.parse(text);
    } catch {
      body = text.includes('=') ? Object.fromEntries(new URLSearchParams(text)) : null;
    }
    return { status: res.status, ok: res.ok, body };
  }

  const getJson = async (url, what, headers = {}) => {
    const res = await call(url, { headers: { accept: 'application/json', 'user-agent': userAgent, ...headers } }, what);
    if (res.status >= 500) throw unreachable(`${what}_${res.status}`);
    return res;
  };

  /** Endpoints of a provider: explicit ones win, OIDC providers fill the rest from discovery. */
  async function endpoints(p) {
    const explicit = { authorizationUrl: p.authorizationUrl, tokenUrl: p.tokenUrl, userinfoUrl: p.userinfoUrl, jwksUrl: p.jwksUrl };
    if (p.type !== 'oidc' || (explicit.authorizationUrl && explicit.tokenUrl && explicit.jwksUrl)) return explicit;
    let cached = discovery.get(p.issuer);
    if (!cached || Date.now() - cached.at > DISCOVERY_TTL_MS) {
      const url = p.discoveryUrl ?? `${p.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
      const res = await getJson(url, 'discovery');
      const doc = res.body;
      if (!res.ok || !doc || typeof doc !== 'object') throw unreachable('discovery_failed');
      if (doc.issuer !== p.issuer) throw failed('discovery_issuer_mismatch', 'The sign-in provider is misconfigured');
      cached = { doc, at: Date.now() };
      discovery.set(p.issuer, cached);
    }
    const d = cached.doc;
    return {
      authorizationUrl: explicit.authorizationUrl ?? d.authorization_endpoint,
      tokenUrl: explicit.tokenUrl ?? d.token_endpoint,
      userinfoUrl: explicit.userinfoUrl ?? d.userinfo_endpoint,
      jwksUrl: explicit.jwksUrl ?? d.jwks_uri,
    };
  }

  async function keys(url, refresh = false) {
    const cached = jwks.get(url);
    const fresh = cached && Date.now() - cached.at < (refresh ? JWKS_REFRESH_MS : JWKS_TTL_MS);
    if (fresh) return cached.keys;
    const res = await getJson(url, 'jwks');
    if (!res.ok || !Array.isArray(res.body?.keys)) throw unreachable('jwks_failed');
    jwks.set(url, { keys: res.body.keys, at: Date.now() });
    return res.body.keys;
  }

  /** The provider's authorize URL for one flow. */
  async function authorizeUrl(p, { state, nonce, challenge, redirectUri }) {
    const { authorizationUrl } = await endpoints(p);
    const url = new URL(checkUrl(authorizationUrl, 'authorizationUrl'));
    const params = {
      response_type: 'code',
      client_id: p.clientId,
      redirect_uri: redirectUri,
      scope: p.scopes.join(' '),
      state,
      ...(p.type === 'oidc' ? { nonce } : {}),
      ...(p.pkce ? { code_challenge: challenge, code_challenge_method: 'S256' } : {}),
      ...(p.authParams ?? {}),
    };
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    return url.href;
  }

  /** Exchange the authorization code (with the PKCE verifier) for tokens. */
  async function exchange(p, { code, verifier, redirectUri }) {
    const { tokenUrl } = await endpoints(p);
    const form = new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri });
    if (p.pkce) form.set('code_verifier', verifier);
    const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', 'user-agent': userAgent };
    if (p.tokenAuth === 'basic') {
      // RFC 6749 2.3.1: both parts are form-encoded before base64.
      const enc = (s) => encodeURIComponent(s).replace(/%20/g, '+');
      headers.authorization = `Basic ${Buffer.from(`${enc(p.clientId)}:${enc(p.clientSecret)}`).toString('base64')}`;
    } else {
      form.set('client_id', p.clientId);
      form.set('client_secret', p.clientSecret);
    }
    const res = await call(tokenUrl, { method: 'POST', headers, body: form.toString() }, 'token');
    if (res.status >= 500) throw unreachable(`token_${res.status}`);
    // GitHub answers 200 with { error } for a bad code, so the body decides, not the status.
    if (!res.ok || !res.body?.access_token || res.body.error) throw failed(`token_${res.body?.error ?? res.status}`);
    return res.body;
  }

  async function verifyIdToken(p, idToken, nonceHash) {
    const { jwksUrl } = await endpoints(p);
    if (!jwksUrl) throw failed('no_jwks', 'The sign-in provider is misconfigured');
    const decoded = decodeJwt(idToken);
    let candidates = candidateKeys(decoded.header, await keys(jwksUrl));
    if (!candidates.length) candidates = candidateKeys(decoded.header, await keys(jwksUrl, true)); // rotated keys
    if (!candidates.length) throw new TokenError('unknown_key', 'The ID token is signed with an unknown key');
    if (!verifySignature(decoded, candidates)) throw new TokenError('bad_signature', 'The ID token signature is invalid');
    return checkClaims(decoded.claims, { issuers: p.issuers, clientId: p.clientId, nonceHash });
  }

  const verified = (v) => v === true || v === 'true';
  const bearer = (tokens) => ({ authorization: `Bearer ${tokens.access_token}` });

  /**
   * Who signed in: { subject, email, emailVerified, name, picture }. Emails are lowercased;
   * emailVerified is true only when the provider says so explicitly.
   */
  async function profile(p, tokens, { nonceHash }) {
    let out;
    if (p.type === 'oidc') {
      if (!tokens.id_token) throw failed('no_id_token');
      let claims;
      try {
        claims = await verifyIdToken(p, tokens.id_token, nonceHash);
      } catch (err) {
        if (err instanceof TokenError) throw failed(`id_token_${err.reason}`);
        throw err;
      }
      out = { subject: claims.sub, email: claims.email, emailVerified: verified(claims.email_verified), name: claims.name, picture: claims.picture };
      const { userinfoUrl } = await endpoints(p);
      if (!out.email && userinfoUrl) {
        const res = await getJson(userinfoUrl, 'userinfo', bearer(tokens));
        // UserInfo must describe the same person as the ID token (OIDC Core 5.3.2).
        if (res.ok && res.body?.sub === claims.sub) {
          Object.assign(out, { email: res.body.email, emailVerified: verified(res.body.email_verified), name: out.name ?? res.body.name });
        }
      }
    } else {
      const { userinfoUrl } = await endpoints(p);
      const res = await getJson(userinfoUrl, 'userinfo', bearer(tokens));
      if (!res.ok || !res.body || typeof res.body !== 'object') throw failed(`userinfo_${res.status}`);
      const raw = res.body;
      if (p.profile) out = await p.profile(raw, tokens);
      else if (p.type === 'github') {
        out = { subject: raw.id, name: raw.name || raw.login, picture: raw.avatar_url, email: null, emailVerified: false };
        // The public email on /user is whatever the user typed, never checked: only the
        // primary address GitHub marks as verified counts.
        const emails = p.emailsUrl ? await getJson(p.emailsUrl, 'emails', bearer(tokens)) : null;
        const primary = Array.isArray(emails?.body) ? emails.body.find((e) => e?.primary && e?.verified) : null;
        if (primary) Object.assign(out, { email: primary.email, emailVerified: true });
      } else {
        out = { subject: raw.sub ?? raw.id, email: raw.email, emailVerified: verified(raw.email_verified), name: raw.name, picture: raw.picture };
      }
    }
    if (out?.subject === undefined || out.subject === null || out.subject === '') throw failed('no_subject');
    const email = typeof out.email === 'string' && /^[^\s@]+@[^\s@]+$/.test(out.email) ? out.email.trim().toLowerCase() : null;
    return {
      subject: String(out.subject).slice(0, 255),
      email,
      emailVerified: Boolean(email && out.emailVerified === true),
      name: typeof out.name === 'string' ? out.name.slice(0, 100) : null,
      picture: typeof out.picture === 'string' ? out.picture.slice(0, 2000) : null,
    };
  }

  return { endpoints, authorizeUrl, exchange, profile, checkUrl };
}
