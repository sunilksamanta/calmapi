import nodemailer from 'nodemailer';
import { definePlugin } from '#calm';

export default definePlugin({
  name: 'mail-smtp',
  setup(calm) {
    const url = process.env.SMTP_URL;
    if (!url || url.includes('smtp.example.com')) {
      calm.doctor(() =>
        calm.config.mode === 'production' ? [{ level: 'error', id: 'smtp-url', title: 'SMTP_URL is not configured', detail: 'Emails cannot be delivered in production.' }] : [],
      );
      return;
    }
    const transport = nodemailer.createTransport(url);
    calm.mailer.use({
      name: 'smtp',
      send: ({ to, from, subject, text, html }) => transport.sendMail({ from: process.env.MAIL_FROM || from, to, subject, text, html }),
    });
    calm.onShutdown(() => transport.close());
  },
});
