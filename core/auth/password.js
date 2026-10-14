import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';

// Password hashing with Node's built-in scrypt: no native addon to compile, no dependency.
// Format: scrypt$<logN>$<r>$<p>$<salt>$<hash>  (base64url). Parameters are stored with
// the hash, so you can raise the cost later and old hashes keep working.
// Default cost (N=2^15, r=8, p=3, 32 MiB) follows the OWASP Password Storage Cheat Sheet.

const KEYLEN = 32;

const derive = (password, salt, { logN, r, p }) =>
  new Promise((resolve, reject) => {
    const N = 2 ** logN;
    scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r, p, maxmem: 256 * N * r + 1024 * 1024 }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });

export async function hashPassword(password, params = { logN: 15, r: 8, p: 3 }) {
  const { logN, r, p } = params;
  const salt = randomBytes(16);
  const key = await derive(password, salt, { logN, r, p });
  return `scrypt$${logN}$${r}$${p}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, salt, hash] = parts;
  const expected = Buffer.from(hash, 'base64url');
  const actual = await derive(password, Buffer.from(salt, 'base64url'), { logN: Number(logN), r: Number(r), p: Number(p) });
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/** True when a stored hash uses weaker parameters than the current config. */
export function needsRehash(stored, { logN, r, p }) {
  const parts = String(stored).split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < logN || Number(parts[2]) < r || Number(parts[3]) < p;
}
