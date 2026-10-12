import { isDeepStrictEqual } from 'node:util';
import { definePlugin, currentRequest } from '#calm';

// Records every create/update/delete. Hidden, write-only and password fields are
// never stored in the log, only the fact that they changed.
export default definePlugin({
  name: 'audit-log',
  env: {
    AUDIT_RETENTION_DAYS: 'Days to keep audit entries (default 365)',
  },
  setup(calm) {
    const { Schema } = calm.mongoose;
    const days = Number(process.env.AUDIT_RETENTION_DAYS || 365);
    const schema = new Schema(
      {
        action: { type: String, enum: ['created', 'updated', 'deleted'], required: true },
        resource: { type: String, required: true },
        recordId: { type: String, required: true },
        user: { type: Schema.Types.ObjectId, ref: 'user' },
        changes: Schema.Types.Mixed,
        requestId: String,
        ip: String,
        at: { type: Date, default: () => new Date() },
      },
      { collection: 'calm_audit_log', versionKey: false },
    );
    schema.index({ resource: 1, recordId: 1, at: -1 });
    schema.index({ user: 1, at: -1 });
    schema.index({ at: 1 }, { expireAfterSeconds: days * 86_400 });
    const Audit = calm.mongoose.model('calmAudit', schema);
    calm.provide('audit', Audit);

    calm.on('*', async (payload, name) => {
      const m = /^([\w-]+)\.(created|updated|deleted)$/.exec(name);
      if (!m) return;
      const entry = calm.app.registry.get(m[1]);
      if (!entry || entry.def.options.audit === false) return;
      const req = currentRequest()?.req;
      await Audit.create({
        action: m[2],
        resource: m[1],
        recordId: String(payload.doc._id),
        user: payload.user?.id ?? null,
        changes: diff(entry.def, m[2] === 'created' ? {} : payload.previous ?? payload.doc, m[2] === 'deleted' ? {} : payload.doc),
        requestId: currentRequest()?.id,
        ip: req?.ip,
      });
    });

    calm.routes(
      (r) => {
        r.get('/', { policy: 'admin', summary: 'Audit trail', tags: ['audit'] }, async (ctx) => {
          const filter = {};
          for (const key of ['resource', 'recordId', 'action']) if (typeof ctx.query[key] === 'string') filter[key] = ctx.query[key];
          if (typeof ctx.query.user === 'string' && /^[a-f\d]{24}$/i.test(ctx.query.user)) filter.user = ctx.query.user;
          const limit = Math.min(Number(ctx.query.limit) || 50, 200);
          const rows = await Audit.find(filter).sort({ at: -1 }).limit(limit).populate({ path: 'user', select: 'name' }).lean();
          return rows.map(({ _id, user, ...rest }) => ({ id: String(_id), user: user ? { id: String(user._id), name: user.name } : null, ...rest }));
        });
      },
      { prefix: '/audit-log' },
    );
  },
});

function diff(def, before, after) {
  const changes = {};
  for (const [key, field] of Object.entries(def.fields)) {
    const a = before?.[key];
    const b = after?.[key];
    if (isDeepStrictEqual(normalize(a), normalize(b))) continue;
    changes[key] = field.isOutput ? { from: normalize(a) ?? null, to: normalize(b) ?? null } : { changed: true };
  }
  return changes;
}

const normalize = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
