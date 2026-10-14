// Outgoing email. The built-in transport only works in development: it prints a short
// notice and hands the full message to devtools (open /_calm → Mail).
// For real delivery add a transport block: `calm add mail-resend` (or SMTP),
// or register your own: app.mailer.use({ name: 'x', send: async (msg, { meta }) => {} }).
//
// `meta` is for observers (devtools, tests) and may hold secrets such as a reset token, so
// it is never part of the outgoing message. Transports get it as a second argument and pick
// what they need deliberately (a provider tag from meta.kind, for example), never all of it.

export function createMailer({ log, mode, from }) {
  let transport = null;
  const observers = [];

  return {
    use(t) {
      transport = t;
    },
    get transport() {
      return transport?.name ?? (mode === 'production' ? null : 'dev-console');
    },
    observe(fn) {
      observers.push(fn);
    },
    async send(message) {
      const msg = { from, ...message, sentAt: new Date() };
      for (const fn of observers) fn(msg);
      const { meta: _meta, ...outgoing } = msg;
      if (transport) return transport.send(outgoing, { meta: { ...(msg.meta ?? {}) } });
      if (mode === 'production') {
        log.error('Email not sent: no mail transport configured. Add one with `calm add mail-resend`.', {
          subject: msg.subject,
        });
        return;
      }
      log.info(`Email to ${msg.to}: "${msg.subject}" (dev transport, open /_calm to read it)`);
      if (mode === 'development' && process.env.CALM_MAIL_PRINT === '1') log.info(msg.text);
    },
  };
}
