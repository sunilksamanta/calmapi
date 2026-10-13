import { createHash, createPublicKey, verify, constants } from 'node:crypto';

// ID token (JWT) verification with node:crypto only.
//
//  - Only asymmetric algorithms: "none" and HS* are refused, so a token cannot be signed
//    with the client secret (or nothing) and pass.
//  - The key comes from the provider's JWKS and must match the token's kid, key type and
//    algorithm, so a key published for encryption or another algorithm is never used.
//  - Claims are checked as OpenID Connect Core 3.1.3.7 asks: iss, aud (and azp when there
//    are several audiences), exp, iat and the nonce of the flow that asked for the token.

const ALGS = {
  RS256: { kty: 'RSA', hash: 'sha256' },
  RS384: { kty: 'RSA', hash: 'sha384' },
  RS512: { kty: 'RSA', hash: 'sha512' },
  PS256: { kty: 'RSA', hash: 'sha256', pss: true },
  PS384: { kty: 'RSA', hash: 'sha384', pss: true },
  PS512: { kty: 'RSA', hash: 'sha512', pss: true },
  ES256: { kty: 'EC', hash: 'sha256', crv: 'P-256' },
  ES384: { kty: 'EC', hash: 'sha384', crv: 'P-384' },
  ES512: { kty: 'EC', hash: 'sha512', crv: 'P-521' },
  EdDSA: { kty: 'OKP', hash: null },
};

export class TokenError extends Error {
  /** @param {string} reason short machine readable reason, for security events */
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

const json = (part) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));

/** Split a compact JWT. Throws TokenError('malformed') for anything else. */
export function decodeJwt(token) {
  const parts = String(token).split('.');
  if (parts.length !== 3 || parts.some((p) => !/^[\w-]*$/.test(p))) throw new TokenError('malformed', 'The ID token is not a JWT');
  try {
    const header = json(parts[0]);
    const claims = json(parts[1]);
    if (!header || typeof header !== 'object' || !claims || typeof claims !== 'object') throw new Error('not objects');
    return { header, claims, input: `${parts[0]}.${parts[1]}`, signature: Buffer.from(parts[2], 'base64url') };
  } catch {
    throw new TokenError('malformed', 'The ID token is not a JWT');
  }
}

/** Keys of a JWKS that may have signed this token: same kid, key type and algorithm, not for encryption. */
export function candidateKeys(header, keys) {
  const alg = ALGS[header.alg];
  if (!alg) throw new TokenError('bad_alg', `ID tokens signed with "${header.alg}" are not accepted`);
  return (keys ?? []).filter(
    (k) =>
      k &&
      k.kty === alg.kty &&
      (!alg.crv || k.crv === alg.crv) &&
      (!k.use || k.use === 'sig') &&
      (!k.alg || k.alg === header.alg) &&
      (header.kid === undefined ? true : k.kid === header.kid),
  );
}

/** True when one of the keys verifies the signature. */
export function verifySignature(decoded, keys) {
  const alg = ALGS[decoded.header.alg];
  for (const jwk of keys) {
    let key;
    try {
      key = createPublicKey({ key: jwk, format: 'jwk' });
    } catch {
      continue; // a malformed key in the set is skipped, not trusted
    }
    const opts = { key };
    if (alg.pss) Object.assign(opts, { padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
    if (alg.kty === 'EC') opts.dsaEncoding = 'ieee-p1363'; // JWS signatures are r || s, not DER
    try {
      if (verify(alg.hash, Buffer.from(decoded.input), opts, decoded.signature)) return true;
    } catch {
      // wrong key size or curve for this signature: try the next key
    }
  }
  return false;
}

/**
 * Check the claims of a verified ID token. `nonceHash` is the SHA-256 (hex) of the nonce
 * stored with the flow. Returns the claims.
 */
export function checkClaims(claims, { issuers, clientId, nonceHash, now = Date.now(), skewSeconds = 60 }) {
  const t = Math.floor(now / 1000);
  if (!issuers.includes(claims.iss)) throw new TokenError('wrong_issuer', 'The ID token comes from another issuer');
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(clientId)) throw new TokenError('wrong_audience', 'The ID token was issued for another application');
  // Several audiences: the token must say it was issued to us (authorized party).
  if ((aud.length > 1 || claims.azp !== undefined) && claims.azp !== clientId) throw new TokenError('wrong_audience', 'The ID token was issued for another application');
  if (typeof claims.exp !== 'number' || claims.exp + skewSeconds <= t) throw new TokenError('expired', 'The ID token has expired');
  if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - skewSeconds > t)) throw new TokenError('bad_iat', 'The ID token was issued in the future');
  if (typeof claims.sub !== 'string' || !claims.sub) throw new TokenError('no_subject', 'The ID token has no subject');
  // The nonce ties the token to the flow this browser started: a token from another flow
  // (replayed or injected) carries another nonce.
  if (typeof claims.nonce !== 'string' || createHash('sha256').update(claims.nonce).digest('hex') !== nonceHash) {
    throw new TokenError('wrong_nonce', 'The ID token does not belong to this sign-in');
  }
  return claims;
}
