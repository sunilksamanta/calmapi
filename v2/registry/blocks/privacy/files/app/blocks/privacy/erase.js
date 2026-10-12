import { ResourceService, notFound, conflict } from '#calm';
import { hashToken } from '#calm/auth/tokens.js';
import { isEncrypted } from '#calm/security/encryption.js';

// Account deletion ("right to be forgotten").
//
// Order matters, so an interrupted deletion can always be finished later:
//   1. the user is marked { status: 'deleting', deletion: {...} }: from then on they cannot
//      sign in or call the API (privacy/index.js), and the sweep knows to finish the job;
//   2. sessions, devices, password resets and other access are removed;
//   3. owned records are deleted, anonymized or kept, resource by resource;
//   4. extra collections (options.alsoDelete) are cleaned;
//   5. the user record goes last, so until then the 'deleting' mark is still there.
// Every step is safe to run twice: rerunning a half-done deletion only does what is left.

export const BEHAVIORS = ['delete', 'anonymize', 'keep'];
const LEASE_MS = 10 * 60_000; // one purge at a time per user, even with several instances

/**
 * What happens to each resource that has an owner field when its owner is deleted.
 * Precedence: calm.config.js blocks.privacy.resources > resource('x', { onOwnerDelete }) > 'delete'.
 * Personal fields (blanked by 'anonymize'): fields flagged opts.pii, resource option
 * personalFields, and blocks.privacy.personalFields.<resource>.
 */
export function deletionPlan(registry, options) {
  const plan = [];
  for (const entry of registry.values()) {
    const { def } = entry;
    if (!def.ownerField || def.name === 'user') continue;
    const action = options.resources?.[def.name] ?? def.options.onOwnerDelete ?? 'delete';
    const personal = [
      ...new Set([
        ...Object.entries(def.fields).filter(([, field]) => field.opts.pii).map(([key]) => key),
        ...(def.options.personalFields ?? []),
        ...(options.personalFields?.[def.name] ?? []),
      ]),
    ].filter((key) => key !== def.ownerField);
    plan.push({ name: def.name, ownerField: def.ownerField, action, personal, entry, file: entry.files?.resource ?? null });
  }
  return plan;
}

/** Throw at boot for settings that would make a deletion fail or silently keep data. */
export function checkPlan(plan) {
  for (const p of plan) {
    if (!BEHAVIORS.includes(p.action)) throw new Error(`privacy: ${p.name} has onOwnerDelete "${p.action}"; use one of ${BEHAVIORS.join(', ')}`);
    if (p.action === 'anonymize' && p.ownerField === '_id') throw new Error(`privacy: ${p.name} is owned through its _id, so it cannot be anonymized; use 'delete' or 'keep'`);
    const unknown = p.personal.filter((key) => !p.entry.def.fields[key]);
    if (unknown.length) throw new Error(`privacy: personal field(s) ${unknown.join(', ')} do not exist on ${p.name}`);
  }
}

/** Decrypt .encrypted() fields of a raw document (raw driver reads skip the model's hooks). */
export function decrypt(def, doc, cipher) {
  if (!cipher) return doc;
  for (const [key, field] of Object.entries(def.fields)) {
    if (field.opts.encrypted && isEncrypted(doc[key])) doc[key] = cipher.decrypt(doc[key]);
  }
  return doc;
}

/** Owner values are stored as ObjectIds, but imported data sometimes holds the string form. */
export const ownedBy = (ownerField, oid) => ({ [ownerField]: { $in: [oid, String(oid)] } });

// A service that keeps the default no-op hooks can be cleaned with one deleteMany. Services
// with hooks (e.g. file.service.js removing the stored file) get one call per record.
const hasDeleteHooks = (service) =>
  service.beforeDelete !== ResourceService.prototype.beforeDelete || service.afterDelete !== ResourceService.prototype.afterDelete;

export function createEraser(calm, options) {
  const { app } = calm;
  const userEntry = () => app.registry.get('user');
  const users = () => userEntry().model.collection;
  const toId = (id) => new calm.mongoose.Types.ObjectId(String(id));

  /** Remove every way in: sessions, reset links, push devices, 2FA challenges, lockout counters. */
  async function revokeAccess(user) {
    const auth = app.auth?.service;
    const jobs = [
      auth?.Session.deleteMany({ user: user._id }),
      auth?.PasswordReset.deleteMany({ user: user._id }),
      app.push.devices?.deleteMany({ user: user._id }),
      calm.mongoose.models.calmMfaChallenge?.deleteMany({ user: user._id }),
    ];
    if (auth && typeof user.email === 'string') jobs.push(auth.LoginAttempt.deleteOne({ _id: hashToken(`login:${user.email.toLowerCase()}`) }));
    await Promise.all(jobs.filter(Boolean));
  }

  async function eraseResource(p, oid, ctx) {
    const { def, model, service } = p.entry;
    const where = ownedBy(p.ownerField, oid);
    // Raw collection calls: they also reach records hidden by query middleware (soft-deleted
    // ones are still personal data) and are not blocked by .immutable() on personal fields.
    if (p.action === 'keep') return { kept: await model.collection.countDocuments(where) };
    if (p.action === 'anonymize') {
      const $unset = Object.fromEntries([p.ownerField, ...p.personal].map((key) => [key, '']));
      const update = def.timestamps ? { $unset, $set: { updatedAt: new Date() } } : { $unset };
      const res = await model.collection.updateMany(where, update);
      return { anonymized: res.modifiedCount };
    }
    if (!hasDeleteHooks(service)) return { deleted: (await model.collection.deleteMany(where)).deletedCount };

    let deleted = 0;
    const cursor = model.collection.find(where).batchSize(options.batchSize);
    try {
      for await (const raw of cursor) {
        const doc = decrypt(def, raw, app.cipher);
        await service.beforeDelete(doc, ctx);
        deleted += (await model.collection.deleteOne({ _id: doc._id })).deletedCount;
        await service.afterDelete(doc, ctx);
      }
    } finally {
      await cursor.close();
    }
    return { deleted };
  }

  /**
   * Finish the deletion of one user marked 'deleting' whose date has come. Returns the
   * per-resource counts, or null when there was nothing to do (already gone, not due yet,
   * or another process is on it).
   */
  async function purge(userId) {
    const now = new Date();
    const _id = toId(userId);
    const user = await users().findOneAndUpdate(
      { _id, status: 'deleting', 'deletion.scheduledFor': { $lte: now }, 'deletion.lockedUntil': { $not: { $gt: now } } },
      { $set: { 'deletion.lockedUntil': new Date(now.getTime() + LEASE_MS) } },
      { returnDocument: 'after' },
    );
    if (!user) return null;

    const by = user.deletion?.by ?? 'self';
    const ctx = { system: true, user: null, privacy: { userId: String(_id), by } };
    await revokeAccess(user);

    const counts = {};
    for (const p of deletionPlan(app.registry, options)) counts[p.name] = await eraseResource(p, _id, ctx);
    for (const [collection, field] of Object.entries(options.alsoDelete ?? {})) {
      if (!field) continue;
      const res = await calm.mongoose.connection.db.collection(collection).deleteMany(ownedBy(field, _id));
      counts[collection] = { deleted: res.deletedCount };
    }

    // The user record last. Its service hooks run (an avatar file to remove...), but no
    // user.deleted event: audit-log would copy the erased profile into the audit trail.
    const { def, service } = userEntry();
    const passwordFields = Object.entries(def.fields).filter(([, field]) => field.type === 'password').map(([key]) => key);
    const doc = decrypt(def, Object.fromEntries(Object.entries(user).filter(([key]) => !passwordFields.includes(key))), app.cipher);
    await service.beforeDelete(doc, ctx);
    await users().deleteOne({ _id });
    await service.afterDelete(doc, ctx);
    await revokeAccess(user); // a reset link requested while this ran

    calm.events.emit('privacy.account_deleted', { userId: String(_id), by, resources: counts });
    calm.log.info('privacy: account deleted', { userId: String(_id), by });
    return counts;
  }

  /**
   * Start deleting an account: mark it, cut access, then purge now or after the grace period.
   * Resolves to { status: 'deleted' } or { status: 'scheduled', scheduledFor }.
   */
  async function request(userId, { by = 'self', adminId = null, immediate = false } = {}) {
    const _id = toId(userId);
    const user = await users().findOne({ _id });
    if (!user) throw notFound('User not found');
    const now = new Date();
    const graceMs = immediate ? 0 : Math.max(0, Number(options.graceDays) || 0) * 86_400_000;
    const scheduledFor = new Date(now.getTime() + graceMs);

    if (user.status !== 'deleting') {
      await users().updateOne(
        { _id, status: { $ne: 'deleting' } },
        { $set: { status: 'deleting', deletion: { requestedAt: now, scheduledFor, by, previousStatus: user.status ?? null } } },
      );
      calm.events.emit('privacy.deletion_requested', { userId: String(_id), by, adminId, scheduledFor });
    } else if (scheduledFor < (user.deletion?.scheduledFor ?? now)) {
      // Asked again: only ever bring the date forward (an admin deleting right away).
      await users().updateOne({ _id }, { $set: { 'deletion.scheduledFor': scheduledFor } });
    }
    await revokeAccess(user);

    const due = (await users().findOne({ _id }, { projection: { deletion: 1 } }))?.deletion?.scheduledFor ?? now;
    if (due > now) return { status: 'scheduled', scheduledFor: due };
    const counts = await purge(_id);
    return counts ? { status: 'deleted', resources: counts } : { status: 'deleting' };
  }

  /** Undo a scheduled deletion (grace period). Sessions and devices removed meanwhile stay removed. */
  async function cancel(userId) {
    const _id = toId(userId);
    const user = await users().findOne({ _id }, { projection: { status: 1, deletion: 1 } });
    if (!user || user.status !== 'deleting') throw notFound('No deletion is pending for this user');
    const previous = user.deletion?.previousStatus;
    const res = await users().updateOne(
      { _id, status: 'deleting', 'deletion.lockedUntil': { $not: { $gt: new Date() } } },
      previous == null ? { $unset: { status: '', deletion: '' } } : { $set: { status: previous }, $unset: { deletion: '' } },
    );
    if (!res.modifiedCount) throw conflict('The deletion is already running');
    calm.events.emit('privacy.deletion_cancelled', { userId: String(_id) });
  }

  /** Finish due and interrupted deletions. Runs on an interval; safe on several instances. */
  async function sweep({ limit = 100 } = {}) {
    if (!userEntry()) return 0;
    const due = await users()
      .find({ status: 'deleting', 'deletion.scheduledFor': { $lte: new Date() } }, { projection: { _id: 1 } })
      .limit(limit)
      .toArray();
    let done = 0;
    for (const { _id } of due) {
      try {
        if (await purge(_id)) done += 1;
      } catch (err) {
        calm.log.error('privacy: deletion failed, the next sweep retries it', { err, userId: String(_id) });
      }
    }
    return done;
  }

  return { request, purge, cancel, sweep, revokeAccess };
}
