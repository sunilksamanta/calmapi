import { randomBytes } from 'node:crypto';
import { definePlugin, badRequest, unauthorized, serialize } from '#calm';

// Server-Sent Events for resource changes. Every event is checked per subscriber:
// read policy, owner scoping, the service scope() and field visibility, so the stream
// never shows anything the REST API would not.
//
// EventSource cannot send an Authorization header, and session tokens must not go in
// URLs, so signed-in clients first exchange their session for a one-time ticket.

const TICKET_TTL_MS = 60_000;

export default definePlugin({
  name: 'realtime-sse',
  setup(calm) {
    const tickets = new Map(); // ticket -> { user, expires }
    const subscribers = new Set();

    const sweep = setInterval(() => {
      const now = Date.now();
      for (const [t, v] of tickets) if (v.expires < now) tickets.delete(t);
    }, 30_000);
    sweep.unref();

    calm.routes(
      (r) => {
        r.post('/ticket', { policy: 'authenticated', summary: 'One-time ticket for the event stream', tags: ['realtime'] }, (ctx) => {
          const ticket = randomBytes(24).toString('base64url');
          tickets.set(ticket, { user: ctx.user, expires: Date.now() + TICKET_TTL_MS });
          return { ticket, expiresIn: TICKET_TTL_MS / 1000 };
        });

        r.get('/stream', { policy: 'public', summary: 'Server-Sent Events stream of resource changes', tags: ['realtime'] }, (ctx) => {
          let user = null;
          if (typeof ctx.query.ticket === 'string') {
            const t = tickets.get(ctx.query.ticket);
            tickets.delete(ctx.query.ticket);
            if (!t || t.expires < Date.now()) throw unauthorized('Ticket is invalid or expired');
            user = t.user;
          }
          const names = String(ctx.query.resources ?? '').split(',').map((s) => s.trim()).filter(Boolean);
          if (!names.length) throw badRequest('Pass ?resources=post,product');
          const unknown = names.filter((n) => !calm.app.registry.has(n));
          if (unknown.length) throw badRequest(`Unknown resources: ${unknown.join(', ')}`);

          const res = ctx.res;
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
          res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ resources: names, user: user ? user.id : null })}\n\n`);
          const sub = { user, names: new Set(names), res };
          subscribers.add(sub);
          const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
          ctx.req.on('close', () => {
            clearInterval(ping);
            subscribers.delete(sub);
          });
        });
      },
      { prefix: '/realtime' },
    );

    calm.on('*', async (payload, name) => {
      const m = /^([\w-]+)\.(created|updated|deleted|restored)$/.exec(name);
      if (!m || !subscribers.size) return;
      const entry = calm.app.registry.get(m[1]);
      if (!entry) return;
      for (const sub of subscribers) {
        if (!sub.names.has(m[1])) continue;
        try {
          if (!(await calm.app.canRead(entry, payload.doc, sub.user, { deleted: m[2] === 'deleted' }))) continue;
          const data = m[2] === 'deleted' ? { id: String(payload.doc._id) } : await serialize(entry.def, payload.doc, { user: sub.user, registry: calm.app.registry });
          sub.res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
        } catch (err) {
          calm.log.warn('realtime: could not deliver event', { err: err.message });
        }
      }
    });

    calm.onShutdown(() => {
      for (const sub of subscribers) sub.res.end();
      subscribers.clear();
    });

    calm.devtools.panel('realtime', () => ({
      subscribers: [...subscribers].map((s) => ({ user: s.user?.id ?? 'anonymous', resources: [...s.names] })),
      pendingTickets: tickets.size,
    }));
  },
});
