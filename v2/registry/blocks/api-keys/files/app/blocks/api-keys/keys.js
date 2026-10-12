import { randomBytes, timingSafeEqual } from 'node:crypto';
import { crc32 } from 'node:zlib';

// API key format: calm_ak_<32 random base62 chars><6 char base62 CRC32 checksum>
//
//  - The fixed prefix lets secret scanners (GitHub, GitGuardian, your own grep) find
//    leaked keys in code, logs and chat messages.
//  - 32 base62 characters are about 190 random bits: guessing is not an option.
//  - The checksum catches typos and truncated copies before any database lookup, the same
//    idea as GitHub tokens. It is not a security feature: anyone can compute it.
//  - Only letters and digits after the prefix, so a double click selects the whole key.

export const KEY_PREFIX = 'calm_ak_';
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RANDOM_LENGTH = 32;
const CHECKSUM_LENGTH = 6; // 62^6 > 2^32, so any CRC32 fits
const SHAPE = new RegExp(`^${KEY_PREFIX}([0-9A-Za-z]{${RANDOM_LENGTH}})([0-9A-Za-z]{${CHECKSUM_LENGTH}})$`);

/** How many characters of a key are stored and shown so people can tell keys apart. */
export const DISPLAY_LENGTH = KEY_PREFIX.length + 6;

function randomBase62(length) {
  let out = '';
  while (out.length < length) {
    for (const byte of randomBytes(length * 2)) {
      // 248 = 4 * 62: skipping bytes above it keeps every character equally likely.
      if (byte < 248 && out.length < length) out += ALPHABET[byte % 62];
    }
  }
  return out;
}

function base62(n) {
  let out = '';
  do {
    out = ALPHABET[n % 62] + out;
    n = Math.floor(n / 62);
  } while (n > 0);
  return out;
}

const checksum = (body) => base62(crc32(`${KEY_PREFIX}${body}`)).padStart(CHECKSUM_LENGTH, '0');

/** A new random key. Show it to its owner once, store only hashToken(key). */
export function generateKey() {
  const body = randomBase62(RANDOM_LENGTH);
  return `${KEY_PREFIX}${body}${checksum(body)}`;
}

/**
 * True when the token has the exact shape of an API key. Anything else (session tokens,
 * other blocks' tokens) is not ours, even if it happens to start with the prefix.
 */
export const isKeyShaped = (token) => typeof token === 'string' && SHAPE.test(token);

/** True when the checksum matches. Compared in constant time out of habit. */
export function hasValidChecksum(token) {
  const m = SHAPE.exec(token);
  if (!m) return false;
  return timingSafeEqual(Buffer.from(checksum(m[1])), Buffer.from(m[2]));
}

/** The part of a key that is safe to store and display: calm_ak_X7pQ2m */
export const displayPrefix = (key) => key.slice(0, DISPLAY_LENGTH);
