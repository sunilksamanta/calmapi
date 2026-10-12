import { definePlugin, f, forbidden, unauthorized, notFound, validationError, verifyPassword } from '#calm';
import { createEraser, deletionPlan, checkPlan } from './erase.js';
import { streamExport } from './export.js';

// Privacy: data export (GDPR art. 20, portability) and account deletion (art. 17, erasure).
//
//   GET    /api/auth/me/export                      your data as a JSON download
//   DELETE /api/auth/me              { password }   delete your account and your data
//   POST   /api/admin/users/:id/export              admins, for support requests
//   DELETE /api/admin/users/:id      { immediate? } admins, for support requests
//   POST   /api/admin/users/:id/cancel-deletion     admins, during the grace period
//
// What happens to each resource is decided per resource (default 'delete'):
//   resource('post', { onOwnerDelete: 'anonymize', personalFields: ['authorName'], fields })
// or centrally in calm.config.js: blocks: { privacy: { resources: { post: 'keep' } } }.
// `calm doctor` lists the plan and warns about resources that keep data.

const isId = (s) => typeof s === 'string' && /^[a-f\d]{24}$/i.test(s);

export default definePlugin({
  name: 'privacy',
  options: {
    graceDays: 0, // > 0: the account is locked at once and erased this many days later
    sweepEveryMinutes: 60, // how often scheduled and interrupted deletions are finished; 0 = never
    resources: {}, // { post: 'delete' | 'anonymize' | 'keep' }, overrides onOwnerDelete
    personalFields: {}, // { post: ['authorName'] }, blanked when a record is anonymized
    alsoDelete: { calm_idempotency: 'user' }, // other collections to clean: { collection: userIdField }
    exportLimit: { windowMs: 60 * 60_000, max: 5 }, // exports per user (needs config.rateLimit.enabled); false = no limit
    batchSize: 200,
    cascadeCrudDelete: true, // DELETE /api/users/:id (user CRUD) erases the same way
  },
  setup(calm, options) {
    const eraser = createEraser(calm, options);
    calm.provide('privacy', { ...eraser, plan: () => deletionPlan(calm.app.registry, options) });

    calm.onResource((def) => {
      if (def.name !== 'user') return def;
      // Present while an account is being deleted: { requestedAt, scheduledFor, by, previousStatus, lockedUntil }.
      def.fields.deletion = f.json().hidden();
      return def;
    });

    // Every way an account can be deleted goes through the same erasure.
    calm.onService(({ def, service }) => {
      if (def.name !== 'user' || !options.cascadeCrudDelete) return;
      service.remove = async (id, ctx = {}) => {
        const doc = await service.findOne({ _id: id }, ctx);
        if (!doc) throw notFound('user not found');
        const self = ctx.user && String(ctx.user.id) === String(doc._id);
        await eraser.request(doc._id, { by: !ctx.user ? 'system' : self ? 'self' : 'admin', adminId: self ? null : (ctx.user?.id ?? null), immediate: true });
        return doc;
      };
    });

    // A user marked 'deleting' is out: no new session, and no request with any credential
    // (sessions are revoked anyway; this covers API keys and other authenticators).
    calm.loginChallenge((user) => {
      if (user.status === 'deleting') throw forbidden('This account is being deleted');
      return null;
    });
    calm.guard((ctx) => {
      if (ctx.user?.status === 'deleting') throw unauthorized('This account is being deleted');
    });

    async function exportTo(ctx, userId, meta) {
      const resources = deletionPlan(calm.app.registry, options);
      let counts;
      try {
        counts = await streamExport(ctx.res, { app: calm.app, userId, resources, batchSize: options.batchSize });
      } catch (err) {
        if (!ctx.res.headersSent) {
          ctx.res.removeHeader('Content-Disposition');
          throw err;
        }
        // Half a file must not look like a whole one: cut the connection so the download fails.
        if (ctx.res.destroyed) calm.log.info('privacy: export cancelled by the client', { userId: String(userId) });
        else calm.log.error('privacy: export failed midway', { err, userId: String(userId) });
        ctx.res.destroy();
        return;
      }
      if (!counts) throw notFound('User not found');
      calm.events.emit('privacy.exported', { userId: String(userId), ...meta, counts });
    }

    const answer = (ctx, result) =>
      result.status === 'deleted' ? undefined : ctx.reply({ status: result.status, scheduledFor: result.scheduledFor ?? null }, { status: 202 });

    const userId = (ctx) => {
      if (!isId(ctx.params.userId)) throw notFound('User not found');
      return ctx.params.userId;
    };

    calm.routes((r) => {
      if (!calm.app.auth) {
        calm.log.warn('privacy: auth is off, so the export and delete routes are not registered');
        return;
      }
      checkPlan(deletionPlan(calm.app.registry, options));
      const userDef = calm.app.registry.get('user').def;
      const passwordField = Object.entries(userDef.fields).find(([, field]) => field.type === 'password')?.[0];
      const limit = options.exportLimit ? { ...options.exportLimit, key: (req) => `user:${req.user?.id ?? req.ip}` } : null;
      const tags = ['privacy'];

      r.get('/auth/me/export', { policy: 'authenticated', summary: 'Download everything you own (JSON file)', rateLimit: limit, tags }, (ctx) =>
        exportTo(ctx, ctx.user.id, { by: 'self' }),
      );

      r.delete(
        '/auth/me',
        {
          policy: 'authenticated',
          summary: 'Delete your account and your data (confirm with your password)',
          description: `204 when deleted, 202 when scheduled (grace period of ${options.graceDays} days).`,
          rateLimit: 'auth',
          input: { password: f.string().required().max(128) },
          tags,
        },
        async (ctx) => {
          const user = await calm.app.model('user').findById(ctx.user._id).select(`+${passwordField}`).lean();
          if (!(await verifyPassword(ctx.body.password, user?.[passwordField]))) {
            calm.events.emit('security.account_delete_failed', { userId: ctx.user.id, ip: ctx.req.ip });
            throw validationError({ password: 'Password is incorrect' });
          }
          return answer(ctx, await eraser.request(ctx.user._id, { by: 'self' }));
        },
      );

      r.post('/admin/users/:userId/export', { policy: 'admin', summary: "Download a user's data (support request)", tags }, (ctx) =>
        exportTo(ctx, userId(ctx), { by: 'admin', adminId: ctx.user.id }),
      );

      r.delete(
        '/admin/users/:userId',
        { policy: 'admin', summary: 'Delete an account and its data (support request)', input: { immediate: f.boolean() }, tags },
        async (ctx) => answer(ctx, await eraser.request(userId(ctx), { by: 'admin', adminId: ctx.user.id, immediate: ctx.body.immediate === true })),
      );

      r.post('/admin/users/:userId/cancel-deletion', { policy: 'admin', summary: 'Cancel a scheduled account deletion', tags }, async (ctx) => {
        await eraser.cancel(userId(ctx));
      });
    });

    let timer = null;
    calm.onStart(() => {
      const minutes = Number(options.sweepEveryMinutes);
      if (!minutes) return;
      timer = setInterval(() => eraser.sweep().catch((err) => calm.log.error('privacy: sweep failed', { err })), minutes * 60_000);
      timer.unref();
    });
    calm.onShutdown(() => clearInterval(timer));

    calm.doctor((app) => {
      if (!app.auth) return [{ level: 'warn', id: 'privacy-no-auth', title: 'privacy: auth is off', detail: 'The export and delete routes need auth and a user resource.' }];
      const plan = deletionPlan(app.registry, options);
      const findings = [];
      const what = (p) =>
        p.action === 'delete'
          ? `${p.name} deleted`
          : p.action === 'anonymize'
            ? `${p.name} kept without owner (${[p.ownerField, ...p.personal].join(', ')} removed)`
            : `${p.name} kept as is`;
      const extra = Object.entries(options.alsoDelete ?? {}).filter(([, field]) => field).map(([c, field]) => `${c} (by ${field})`);
      const grace = Number(options.graceDays) > 0 ? `${options.graceDays} days (the account is locked meanwhile)` : 'none, data is erased right away';
      findings.push({
        level: 'info',
        id: 'privacy-plan',
        title: 'What deleting an account does',
        detail:
          `Owned records: ${plan.length ? plan.map(what).join('; ') : 'no resource has an owner field'}. ` +
          `Always deleted: the profile, sessions, push devices, password reset links${extra.length ? `, ${extra.join(', ')}` : ''}. Grace period: ${grace}.`,
      });
      for (const p of plan.filter((x) => x.action === 'keep')) {
        findings.push({
          level: 'warn',
          id: `privacy-keep-${p.name}`,
          title: `${p.name}: records stay when their owner deletes their account`,
          detail: `onOwnerDelete is 'keep', so ${p.name}.${p.ownerField} keeps the deleted account's id and any personal data in these records stays. Prefer 'anonymize' (with personalFields) or 'delete' unless you must keep them (invoices...), and say so in your privacy policy.`,
          file: p.file,
        });
      }
      const unknown = Object.keys(options.resources ?? {}).filter((name) => !plan.some((p) => p.name === name));
      if (unknown.length) findings.push({ level: 'warn', id: 'privacy-unknown-resource', title: `privacy: blocks.privacy.resources names ${unknown.join(', ')}`, detail: 'No resource with an owner field has that name. Check the spelling.' });
      const refs = [];
      for (const { def } of app.registry.values()) {
        for (const [key, field] of Object.entries(def.fields)) {
          const target = field.type === 'ref' ? field.opts.ref : field.type === 'array' && field.opts.of.type === 'ref' ? field.opts.of.opts.ref : null;
          if (target === 'user' && key !== def.ownerField) refs.push(`${def.name}.${key}`);
        }
      }
      if (refs.length) findings.push({ level: 'info', id: 'privacy-user-refs', title: 'User references that are not owner fields', detail: `${refs.join(', ')} keep pointing at deleted accounts (the records are not the user's, so they are not erased).` });
      return findings;
    });
  },
});
