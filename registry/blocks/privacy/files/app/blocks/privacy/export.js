import { serialize, maskToken } from '#calm';
import { decrypt, ownedBy } from './erase.js';

// Data export ("right to data portability"): one JSON file with everything a user owns.
//
// Records are read with one cursor per resource and written to the response as they come,
// so a large account never sits in memory. Each record goes through serialize() exactly as
// its owner would see it in the API: hidden and write-only fields and password hashes are
// never written, visibleTo() rules apply, encrypted fields are decrypted only where the
// owner is allowed to see them. The manifest is written last so its counts match the file.

const FORMAT = 'calmapi-export/1';

const pretty = (value, indent) => JSON.stringify(value, null, 2).replace(/\n/g, `\n${' '.repeat(indent)}`);

/** <app>-export-<date>.json, safe inside a quoted Content-Disposition filename. */
export function exportFilename(appName, date = new Date()) {
  const slug = String(appName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'app';
  return `${slug}-export-${date.toISOString().slice(0, 10)}.json`;
}

/** Write respecting backpressure; fail fast when the client went away. */
function writer(res) {
  return (text) => {
    if (res.destroyed) return Promise.reject(new Error('The client disconnected during the export'));
    if (res.write(text)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const done = (err) => {
        res.off('drain', onDrain);
        res.off('close', onClose);
        if (err) reject(err);
        else resolve();
      };
      const onDrain = () => done();
      const onClose = () => done(new Error('The client disconnected during the export'));
      res.once('drain', onDrain);
      res.once('close', onClose);
    });
  };
}

/**
 * Stream the export of `userId` to an Express response.
 * Resolves to the counts written ({ profile: 1, note: 3, sessions: 2, devices: 1 }).
 */
export async function streamExport(res, { app, userId, resources, batchSize }) {
  const User = app.model('user');
  const userDef = app.registry.get('user').def;
  const raw = await User.collection.findOne({ _id: new app.mongoose.Types.ObjectId(String(userId)) });
  if (!raw) return null;
  // Like req.user: fields the model never selects (hidden, write-only, password hashes) are dropped.
  for (const [key, field] of Object.entries(userDef.fields)) if (!field.isOutput) delete raw[key];
  const profileDoc = decrypt(userDef, raw, app.cipher);
  // The viewer is the data subject: owner rules pass, their own roles apply.
  const viewer = { ...profileDoc, id: String(profileDoc._id) };
  const generatedAt = new Date();
  const counts = { profile: 1 };
  const profile = await serialize(userDef, profileDoc, { user: viewer, registry: app.registry });

  res.status(200);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${exportFilename(app.config.app.name, generatedAt)}"`);
  res.setHeader('Cache-Control', 'no-store');
  const write = writer(res);
  await write(
    `{\n  "format": ${JSON.stringify(FORMAT)},\n  "app": ${JSON.stringify(app.config.app.name)},\n  "userId": ${JSON.stringify(viewer.id)},\n` +
      `  "generatedAt": ${JSON.stringify(generatedAt)},\n  "profile": ${pretty(profile, 2)},\n  "resources": {`,
  );

  for (const [i, p] of resources.entries()) {
    const { def, model } = p.entry;
    await write(`${i ? ',' : ''}\n    ${JSON.stringify(p.name)}: [`);
    let n = 0;
    let chunk = '';
    const cursor = model.collection.find(ownedBy(p.ownerField, profileDoc._id)).sort({ _id: 1 }).batchSize(batchSize);
    try {
      for await (const doc of cursor) {
        const out = await serialize(def, decrypt(def, doc, app.cipher), { user: viewer, registry: app.registry });
        chunk += `${n ? ',' : ''}\n      ${pretty(out, 6)}`;
        n += 1;
        if (n % batchSize === 0) {
          await write(chunk);
          chunk = '';
        }
      }
    } finally {
      await cursor.close();
    }
    await write(`${chunk}${n ? '\n    ' : ''}]`);
    counts[p.name] = n;
  }

  // Sessions without their token hashes, devices with masked push tokens.
  const sessions = app.auth
    ? (await app.auth.service.Session.find({ user: profileDoc._id }).sort({ createdAt: 1 }).lean()).map((s) => ({
        id: String(s._id),
        createdAt: s.createdAt,
        lastUsedAt: s.lastUsedAt ?? null,
        expiresAt: s.expiresAt,
        ip: s.ip ?? null,
        userAgent: s.userAgent ?? null,
      }))
    : [];
  const devices = app.push.devices
    ? (await app.push.devices.find({ user: profileDoc._id }).sort({ createdAt: 1 }).lean()).map((d) => ({
        id: String(d._id),
        platform: d.platform,
        name: d.name ?? null,
        appVersion: d.appVersion ?? null,
        locale: d.locale ?? null,
        token: maskToken(d.token),
        lastSeenAt: d.lastSeenAt ?? null,
        createdAt: d.createdAt,
      }))
    : [];
  counts.sessions = sessions.length;
  counts.devices = devices.length;

  const manifest = {
    format: FORMAT,
    generatedAt,
    userId: viewer.id,
    resources: resources.map((p) => p.name),
    counts,
    note: 'Records you own, as the API shows them to you. Hidden fields, password hashes and session tokens are never exported.',
  };
  await write(`${resources.length ? '\n  ' : ''}},\n  "sessions": ${pretty(sessions, 2)},\n  "devices": ${pretty(devices, 2)},\n  "manifest": ${pretty(manifest, 2)}\n}\n`);
  res.end();
  return counts;
}
