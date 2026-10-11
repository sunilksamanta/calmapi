import { randomBytes, createHash } from 'node:crypto';

// Opaque random tokens. Only the SHA-256 hash is stored, so a database leak does not
// leak usable sessions or reset links. No JWT secret to configure, rotate or leak.

export const createToken = (prefix) => `${prefix}_${randomBytes(32).toString('base64url')}`;
export const hashToken = (token) => createHash('sha256').update(String(token)).digest('hex');
