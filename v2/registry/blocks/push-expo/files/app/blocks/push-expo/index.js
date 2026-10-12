import { definePlugin } from '#calm';
import { providerPayloads } from '#calm/push.js';

// Sends app.push notifications through the Expo push service
// (https://docs.expo.dev/push-notifications/sending-notifications/). The payload is the
// same one the devtools Push panel shows under "Expo".
const BATCH = 100; // Expo accepts up to 100 messages per request
const isExpoToken = (token) => /^Expo(nent)?PushToken\[.+\]$/.test(token);

export default definePlugin({
  name: 'push-expo',
  setup(calm) {
    const accessToken = process.env.EXPO_ACCESS_TOKEN;
    const endpoint = process.env.EXPO_PUSH_URL || 'https://exp.host/--/api/v2/push/send';
    calm.doctor(() =>
      !accessToken && calm.config.mode === 'production'
        ? [{ level: 'warn', id: 'expo-access-token', title: 'EXPO_ACCESS_TOKEN is not set', detail: 'Anyone who learns a device token can send it notifications. Turn on enhanced push security in your Expo project and set EXPO_ACCESS_TOKEN.' }]
        : [],
    );

    // Tests capture notifications in t.pushes instead of calling Expo (unless EXPO_PUSH_URL
    // points at a fake). Development delivers to real Expo tokens, so you can test on a phone.
    if (calm.config.mode === 'test' && !process.env.EXPO_PUSH_URL) return;

    async function post(messages) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { accept: 'application/json', 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
        body: JSON.stringify(messages),
        signal: AbortSignal.timeout(15_000),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !Array.isArray(body?.data)) {
        const reason = body?.errors?.map((e) => e.message ?? e.code).join('; ') || `HTTP ${res.status}`;
        throw new Error(`Expo rejected the request: ${reason}`);
      }
      return body.data;
    }

    calm.push.use({
      name: 'expo',
      async send(message, devices) {
        const results = devices.map((d) => (isExpoToken(d.token) ? null : { ok: false, error: 'Not an Expo push token (expected ExponentPushToken[...])' }));
        const pending = devices.map((d, i) => [d, i]).filter(([, i]) => !results[i]);
        for (let start = 0; start < pending.length; start += BATCH) {
          const chunk = pending.slice(start, start + BATCH);
          let tickets;
          try {
            tickets = await post(chunk.map(([d]) => providerPayloads(message, d.token).expo.payload));
          } catch (err) {
            for (const [, i] of chunk) results[i] = { ok: false, error: err.message };
            continue;
          }
          chunk.forEach(([, i], n) => {
            const ticket = tickets[n] ?? {};
            if (ticket.status === 'ok') results[i] = { ok: true, id: ticket.id };
            else {
              const code = ticket.details?.error;
              results[i] = { ok: false, error: [code, ticket.message].filter(Boolean).join(': ') || 'Expo returned no ticket', unregistered: code === 'DeviceNotRegistered' };
            }
          });
        }
        return results;
      },
    });
  },
});
