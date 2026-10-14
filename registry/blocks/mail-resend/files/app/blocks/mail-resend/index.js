import { definePlugin } from '#calm';

// Sends app.mailer messages through https://resend.com. Without RESEND_API_KEY in
// development, the built-in dev transport (devtools Mail panel) keeps working.
export default definePlugin({
  name: 'mail-resend',
  env: {
    RESEND_API_KEY: { secret: true, description: 'API key from resend.com: without it, mail stays in devtools' },
    MAIL_FROM: 'Sender address, for example "Acme <hello@acme.com>"',
  },
  setup(calm) {
    const key = process.env.RESEND_API_KEY;
    if (!key) {
      calm.doctor(() =>
        calm.config.mode === 'production'
          ? [{ level: 'error', id: 'resend-key', title: 'RESEND_API_KEY is not set', detail: 'Emails cannot be delivered in production.' }]
          : [],
      );
      return;
    }
    calm.mailer.use({
      name: 'resend',
      async send({ to, from, subject, text, html }) {
        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: process.env.MAIL_FROM || from, to: [to].flat(), subject, text, html }),
        });
        if (!res.ok) throw new Error(`Resend answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
        return res.json();
      },
    });
  },
});
