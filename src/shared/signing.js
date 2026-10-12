// Signatures for server-signed data: selector-map envelopes and licence tokens.
// WebCrypto only, so the same code runs in Node, MV3 service workers and content scripts.
// Scheme: ECDSA P-256 + SHA-256. A signature is the raw IEEE-P1363 r||s (64 bytes) as unpadded base64url.
// Verification functions never throw: every bad input resolves to { ok: false, reason }.
// sign* / toPublicJwk exist for tools/ and tests; no private key ever ships, and bundlers drop them from the extension.

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const LOOKUP = (() => {
  const table = new Int8Array(128).fill(-1);
  for (let i = 0; i < ALPHABET.length; i++) table[ALPHABET.charCodeAt(i)] = i;
  return table;
})();

export const SIGNATURE_BYTES = 64;

const CURVE = { name: 'ECDSA', namedCurve: 'P-256' };
const ALGORITHM = { name: 'ECDSA', hash: 'SHA-256' };
const ENCODER = new TextEncoder();
// A lone surrogate is turned into U+FFFD by UTF-8 encoding, so two different strings would share one signature.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

const fail = (reason) => ({ ok: false, reason });
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const getSubtle = () => globalThis.crypto && globalThis.crypto.subtle;

function toBytes(input) {
  if (typeof input === 'string') return ENCODER.encode(input);
  if (Object.prototype.toString.call(input) === '[object ArrayBuffer]') return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  throw new TypeError('expected a string, an ArrayBuffer or a typed array');
}

export function isWellFormed(str) {
  return typeof str === 'string' && !LONE_SURROGATE.test(str);
}

/** Unpadded base64url of a string (UTF-8), ArrayBuffer or typed array. */
export function base64urlEncode(input) {
  const bytes = toBytes(input);
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63] + ALPHABET[n & 63];
  }
  if (bytes.length - i === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63];
  } else if (bytes.length - i === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18] + ALPHABET[(n >> 12) & 63] + ALPHABET[(n >> 6) & 63];
  }
  return out;
}

/**
 * Strict inverse of base64urlEncode. Throws TypeError on anything but canonical unpadded base64url
 * (padding, '+' '/', whitespace, impossible length, non-zero trailing bits), so one byte string has exactly one spelling.
 */
export function base64urlDecode(str) {
  if (typeof str !== 'string') throw new TypeError('base64url input must be a string');
  const len = str.length;
  if (len % 4 === 1) throw new TypeError('invalid base64url length');
  const out = new Uint8Array(Math.floor((len * 3) / 4));
  let acc = 0;
  let bits = 0;
  let o = 0;
  for (let i = 0; i < len; i++) {
    const code = str.charCodeAt(i);
    const v = code < 128 ? LOOKUP[code] : -1;
    if (v < 0) throw new TypeError(`invalid base64url character at index ${i}`);
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
      acc &= (1 << bits) - 1;
    }
  }
  if (acc !== 0) throw new TypeError('non-canonical base64url (non-zero trailing bits)');
  return out;
}

function pickPublic(jwk) {
  if (!isObject(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256') return null;
  if (typeof jwk.x !== 'string' || typeof jwk.y !== 'string') return null;
  return { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y };
}

async function importVerifyKey(subtle, jwk) {
  try {
    // A JWK that still carries `d` is a private key: refuse, so a leaked private half is never "verified" against quietly.
    if (isObject(jwk) && 'd' in jwk) return null;
    const pub = pickPublic(jwk);
    if (!pub || base64urlDecode(pub.x).length !== 32 || base64urlDecode(pub.y).length !== 32) return null;
    return await subtle.importKey('jwk', { ...pub, ext: true }, CURVE, false, ['verify']);
  } catch {
    return null;
  }
}

/**
 * Verifies a detached signature over `data` (string = its UTF-8 bytes, or bytes).
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function verifySignature(data, signature, publicKeyJwk) {
  try {
    const subtle = getSubtle();
    if (!subtle) return fail('crypto-unavailable');
    if (typeof data === 'string' && !isWellFormed(data)) return fail('bad-payload');
    const key = await importVerifyKey(subtle, publicKeyJwk);
    if (!key) return fail('bad-key');
    if (typeof signature !== 'string') return fail('bad-signature');
    let sig;
    try {
      sig = base64urlDecode(signature);
    } catch {
      return fail('bad-signature');
    }
    if (sig.length !== SIGNATURE_BYTES) return fail('bad-signature');
    const ok = await subtle.verify(ALGORITHM, key, sig, toBytes(data));
    return ok ? { ok: true } : fail('bad-signature');
  } catch {
    return fail('verify-error');
  }
}

/**
 * Verifies a signed envelope `{ payload: string, sig: base64url, kid }` against a public JWK.
 * When the JWK carries a `kid`, the envelope's `kid` must equal it.
 * @returns {Promise<{ok: true, payload: string} | {ok: false, reason: string}>}
 */
export async function verifyEnvelope(envelope, publicKeyJwk) {
  try {
    if (!isObject(envelope)) return fail('malformed-envelope');
    const { payload, sig, kid } = envelope;
    if (typeof payload !== 'string') return fail('bad-payload');
    if (typeof sig !== 'string' || sig === '') return fail('bad-signature');
    if (typeof kid !== 'string' || kid === '') return fail('bad-kid');
    if (isObject(publicKeyJwk) && typeof publicKeyJwk.kid === 'string' && publicKeyJwk.kid !== kid) {
      return fail('kid-mismatch');
    }
    const result = await verifySignature(payload, sig, publicKeyJwk);
    return result.ok ? { ok: true, payload } : result;
  } catch {
    return fail('verify-error');
  }
}

// ---- build-time helpers (tools/ and tests) --------------------------------------------------------------------------

async function importSignKey(jwk) {
  const subtle = getSubtle();
  if (!subtle) throw new Error('WebCrypto is not available');
  if (!isObject(jwk) || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || ['x', 'y', 'd'].some((k) => typeof jwk[k] !== 'string')) {
    throw new TypeError('expected a P-256 private JWK with x, y and d');
  }
  return subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, ext: true }, CURVE, false, ['sign']);
}

/** Signs a string (UTF-8) or bytes; returns the base64url r||s signature. Throws on a bad key. */
export async function signPayload(data, privateKeyJwk) {
  if (typeof data === 'string' && !isWellFormed(data)) throw new TypeError('payload contains a lone surrogate');
  const key = await importSignKey(privateKeyJwk);
  const sig = await getSubtle().sign(ALGORITHM, key, toBytes(data));
  return base64urlEncode(sig);
}

/** Signs a string payload into `{ payload, sig, kid }`. */
export async function signEnvelope(payload, privateKeyJwk, kid) {
  if (typeof payload !== 'string') throw new TypeError('payload must be a string');
  if (typeof kid !== 'string' || kid === '') throw new TypeError('kid is required');
  return { payload, sig: await signPayload(payload, privateKeyJwk), kid };
}

/** The public half of a P-256 JWK (private `d` and every other member dropped), with a `kid` when one is known. */
export function toPublicJwk(jwk, kid = jwk && jwk.kid) {
  const pub = pickPublic(jwk);
  if (!pub) throw new TypeError('expected a P-256 EC JWK with x and y');
  return typeof kid === 'string' && kid !== '' ? { ...pub, kid } : pub;
}

/**
 * Compares dotted numeric versions such as `2026.10.07.1` segment by segment as numbers ("...9" < "...10"), missing
 * segments counting as 0. Returns -1, 0 or 1, or NaN when either side is not a dotted-numeric string.
 */
export function compareMapVersions(a, b) {
  const parse = (v) => (typeof v === 'string' && /^\d{1,9}(\.\d{1,9}){0,7}$/.test(v) ? v.split('.').map(Number) : null);
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return NaN;
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}
