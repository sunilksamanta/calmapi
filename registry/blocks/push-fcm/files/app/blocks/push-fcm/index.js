import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { definePlugin, providerPayloads } from '#calm';

// Sends app.push notifications through Firebase Cloud Messaging HTTP v1
// (https://firebase.google.com/docs/cloud-messaging/send-message). Authenticates with a
// service account: a JWT signed with its private key is exchanged for an access token.
// The payload is the same one the devtools Push panel shows under "FCM".
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const CONCURRENCY = 10;

/** FCM_SERVICE_ACCOUNT (JSON or a path to the JSON file) or GOOGLE_APPLICATION_CREDENTIALS. */
function loadServiceAccount() {
  const raw = process.env.FCM_SERVICE_ACCOUNT || process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!raw) return { missing: true };
  try {
    const json = JSON.parse(raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8'));
    const problems = ['project_id', 'client_email', 'private_key'].filter((k) => typeof json[k] !== 'string' || !json[k]);
    return problems.length ? { error: `The service account has no ${problems.join(', ')}` } : { account: json };
  } catch (err) {
    return { error: `Cannot read the service account: ${err.message}` };
  }
}

const base64url = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url');

export default definePlugin({
  name: 'push-fcm',
  env: {
    FCM_SERVICE_ACCOUNT: { secret: true, description: 'Firebase service account: the JSON, or a path to the file' },
    GOOGLE_APPLICATION_CREDENTIALS: 'Path to a service account file, used when FCM_SERVICE_ACCOUNT is not set',
    FCM_API_URL: 'FCM API base URL, for tests and proxies',
  },
  setup(calm) {
    const { account, missing, error } = loadServiceAccount();
    calm.doctor(() => {
      if (error) return [{ level: 'error', id: 'fcm-service-account', title: 'FCM service account is invalid', detail: error }];
      if (missing && calm.config.mode === 'production') return [{ level: 'error', id: 'fcm-service-account', title: 'FCM_SERVICE_ACCOUNT is not set', detail: 'Push notifications cannot be delivered in production.' }];
      return [];
    });
    if (!account) return;
    // Tests capture notifications in t.pushes instead of calling Google (unless FCM_API_URL
    // points at a fake). Development delivers to real tokens, so you can test on a phone.
    if (calm.config.mode === 'test' && !process.env.FCM_API_URL) return;

    const api = (process.env.FCM_API_URL || 'https://fcm.googleapis.com').replace(/\/$/, '');
    const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
    let cached = null; // { token, expiresAt }

    async function accessToken() {
      if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
      const now = Math.floor(Date.now() / 1000);
      const unsigned = `${base64url({ alg: 'RS256', typ: 'JWT' })}.${base64url({ iss: account.client_email, scope: SCOPE, aud: tokenUri, iat: now, exp: now + 3600 })}`;
      const signature = createSign('RSA-SHA256').update(unsigned).sign(account.private_key).toString('base64url');
      const res = await fetch(tokenUri, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.access_token) throw new Error(`Google rejected the service account: ${body?.error_description ?? body?.error ?? `HTTP ${res.status}`}`);
      cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
      return cached.token;
    }

    async function sendOne(message, device, token) {
      const res = await fetch(`${api}/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(providerPayloads(message, device.token).fcm.payload),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (res.ok) return { ok: true, id: body?.name };
      if (res.status === 401) cached = null;
      // UNREGISTERED: the app was uninstalled or the token expired. Remove the device.
      const code = body?.error?.details?.find((d) => d.errorCode)?.errorCode ?? body?.error?.status;
      return { ok: false, error: [code, body?.error?.message].filter(Boolean).join(': ') || `HTTP ${res.status}`, unregistered: code === 'UNREGISTERED' };
    }

    calm.push.use({
      name: 'fcm',
      // Native FCM tokens. Expo push tokens belong to push-expo (they can be installed together).
      accepts: (device) => !/^Expo(nent)?PushToken\[/.test(device.token),
      async send(message, devices) {
        const token = await accessToken();
        const results = new Array(devices.length);
        let next = 0;
        const worker = async () => {
          while (next < devices.length) {
            const i = next++;
            results[i] = await sendOne(message, devices[i], token).catch((err) => ({ ok: false, error: err.message }));
          }
        };
        await Promise.all(Array.from({ length: Math.min(CONCURRENCY, devices.length) }, worker));
        return results;
      },
    });
  },
});
