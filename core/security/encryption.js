// Field encryption at rest: f.string().encrypted()
//
// Values are encrypted with AES-256-GCM before they reach MongoDB and decrypted when
// read through the model, so a database dump, a backup or a stolen replica only
// holds ciphertext. Stored format:  enc:v1:<keyId>:<iv>:<tag>:<ciphertext>  (base64url)
//
// Keys come from the environment:
//   CALM_ENCRYPTION_KEYS=k2:<base64 32 bytes>,k1:<base64 32 bytes>
// The first key encrypts; every listed key can decrypt, so rotation is: add a new key
// in front, deploy, re-save records at your pace, then drop the old key.
// `npx calm keygen` prints a new key line.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const PREFIX = 'enc:v1:';

export function parseKeys(text = process.env.CALM_ENCRYPTION_KEYS ?? process.env.CALM_ENCRYPTION_KEY ?? '') {
  const keys = [];
  for (const part of text.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [id, b64] = part.includes(':') ? part.split(':') : ['k1', part];
    const key = Buffer.from(b64, 'base64');
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (base64). Generate one with \`npx calm keygen\`.`);
    if (!/^[\w-]{1,16}$/.test(id)) throw new Error(`Invalid encryption key id "${id}"`);
    keys.push({ id, key });
  }
  return keys;
}

export const generateKey = (id = 'k1') => `${id}:${randomBytes(32).toString('base64')}`;
export const isEncrypted = (v) => typeof v === 'string' && v.startsWith(PREFIX);

export function createCipher(keys) {
  const byId = new Map(keys.map((k) => [k.id, k.key]));
  const current = keys[0];

  return {
    keyIds: keys.map((k) => k.id),
    encrypt(value) {
      if (value === null || value === undefined || isEncrypted(value)) return value;
      if (!current) throw new Error('No encryption key configured (CALM_ENCRYPTION_KEYS)');
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      const plain = Buffer.from(JSON.stringify(value), 'utf8');
      const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
      const tag = cipher.getAuthTag();
      return `${PREFIX}${current.id}:${iv.toString('base64url')}:${tag.toString('base64url')}:${ct.toString('base64url')}`;
    },
    decrypt(value) {
      if (!isEncrypted(value)) return value;
      const [, , id, iv, tag, ct] = value.split(':');
      const key = byId.get(id);
      if (!key) throw new Error(`Cannot decrypt: encryption key "${id}" is not configured`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      decipher.setAuthTag(Buffer.from(tag, 'base64url'));
      const plain = Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]);
      return JSON.parse(plain.toString('utf8'));
    },
    /** True when a stored value was encrypted with an older key (re-save to rotate). */
    isStale: (value) => isEncrypted(value) && value.split(':')[2] !== current?.id,
  };
}

const QUERY_RESULTS = ['find', 'findOne', 'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace'];
const UPDATES = ['findOneAndUpdate', 'updateOne', 'updateMany'];

/** Mongoose schema plugin: encrypt `paths` on write, decrypt on read (lean or not). */
export function encryptionPlugin(paths, cipher) {
  return (schema) => {
    schema.pre('save', function () {
      for (const p of paths) {
        const v = this.get(p);
        if (v !== undefined && v !== null && !isEncrypted(v)) this.set(p, cipher.encrypt(v));
      }
    });

    for (const hook of UPDATES) {
      schema.pre(hook, function () {
        const update = this.getUpdate();
        if (!update) return;
        for (const target of [update, update.$set, update.$setOnInsert]) {
          if (!target) continue;
          for (const p of paths) if (p in target && target[p] !== null) target[p] = cipher.encrypt(target[p]);
        }
      });
    }

    const decryptDoc = (doc) => {
      if (!doc || typeof doc !== 'object') return;
      for (const p of paths) {
        const v = typeof doc.get === 'function' ? doc.get(p) : doc[p];
        if (!isEncrypted(v)) continue;
        const plain = cipher.decrypt(v);
        if (typeof doc.set === 'function' && doc.$__) {
          doc.$__.activePaths?.clearPath?.(p);
          doc._doc[p] = plain; // bypass casting and dirty tracking: in-memory plaintext only
        } else {
          doc[p] = plain;
        }
      }
    };
    for (const hook of QUERY_RESULTS) {
      schema.post(hook, (res) => (Array.isArray(res) ? res.forEach(decryptDoc) : decryptDoc(res)));
    }
    schema.post('save', (doc) => decryptDoc(doc));
  };
}
