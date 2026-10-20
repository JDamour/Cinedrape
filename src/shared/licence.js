// Licence tokens: `base64url(claims JSON).base64url(signature)`, signed by the licence server and checked locally.
// The signature (ECDSA P-256 / SHA-256, see signing.js) covers the exact UTF-8 bytes of the claims JSON, i.e. the first
// segment after decoding. Claims: { v:1, sub, plan:'free'|'pro', iat, exp?, devices? }. `iat` and `exp` are Unix SECONDS
// (JWT NumericDate); every other time in this module (`nowMs`, `checkedAt`) is milliseconds.
import { LIMITS } from './constants.js';
import { base64urlDecode, base64urlEncode, signPayload, verifySignature } from './signing.js';

export const PLANS = ['free', 'pro'];
export const TIERS = ['founder', 'standard'];
export const CLOCK_SKEW_MS = 5 * 60 * 1000;     // an `iat` further ahead than this is rejected
const MAX_TOKEN_CHARS = 4096;
const MAX_SUB_CHARS = 320;
const MAX_SECONDS = 1e11;                        // ~year 5138; a millisecond timestamp (>= 1e12 today) lands above it

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isTimestamp = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_SECONDS;

/**
 * Shape-checks claims and returns a fresh object holding only the known fields (unknown ones are dropped).
 * @returns {{ok: true, claims: object} | {ok: false, reason: string}}
 */
export function parseClaims(raw) {
  if (!isObject(raw)) return { ok: false, reason: 'bad-claims' };
  if (typeof raw.v !== 'number') return { ok: false, reason: 'bad-claims' };
  if (raw.v !== 1) return { ok: false, reason: 'unsupported-version' };
  if (!PLANS.includes(raw.plan)) return { ok: false, reason: 'bad-plan' };
  if (typeof raw.sub !== 'string' || raw.sub === '' || raw.sub.length > MAX_SUB_CHARS) return { ok: false, reason: 'bad-claims' };
  if (!isTimestamp(raw.iat)) return { ok: false, reason: 'bad-claims' };
  if (raw.exp !== undefined && !isTimestamp(raw.exp)) return { ok: false, reason: 'bad-claims' };
  if (raw.devices !== undefined && !(Number.isInteger(raw.devices) && raw.devices >= 1 && raw.devices <= 10000)) {
    return { ok: false, reason: 'bad-claims' };
  }
  if (raw.tier !== undefined && (typeof raw.tier !== 'string' || !TIERS.includes(raw.tier))) {
    return { ok: false, reason: 'bad-claims' };
  }
  const claims = { v: 1, sub: raw.sub, plan: raw.plan, iat: raw.iat };
  if (raw.exp !== undefined) claims.exp = raw.exp;
  if (raw.devices !== undefined) claims.devices = raw.devices;
  if (raw.tier !== undefined) claims.tier = raw.tier;
  return { ok: true, claims };
}

const expired = (claims, nowMs) => claims.exp !== undefined && nowMs >= claims.exp * 1000;

/**
 * Verifies signature, claim shape and times. Never throws.
 * `claims` is non-null whenever the signature and the claim shape are good, including the time failures
 * ('expired', 'not-yet-valid'), so callers can explain them; trust it only when `valid` is true.
 * Reasons: ok, bad-time, malformed-token, bad-key, bad-signature, bad-claims, unsupported-version, bad-plan,
 * not-yet-valid (`iat` more than CLOCK_SKEW_MS ahead), expired (`nowMs >= exp*1000`).
 * @returns {Promise<{valid: boolean, reason: string, claims: object|null}>}
 */
export async function verifyLicenceToken(token, nowMs, publicKeyJwk) {
  const no = (reason, claims = null) => ({ valid: false, reason, claims });
  try {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return no('bad-time');
    if (typeof token !== 'string') return no('malformed-token');
    const text = token.trim();
    if (text === '' || text.length > MAX_TOKEN_CHARS) return no('malformed-token');
    const parts = text.split('.');
    if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return no('malformed-token');

    let claimBytes;
    try {
      claimBytes = base64urlDecode(parts[0]);
      base64urlDecode(parts[1]);
    } catch {
      return no('malformed-token');
    }

    const sig = await verifySignature(claimBytes, parts[1], publicKeyJwk);
    if (!sig.ok) return no(sig.reason === 'bad-key' || sig.reason === 'crypto-unavailable' ? sig.reason : 'bad-signature');

    let raw;
    try {
      raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(claimBytes));
    } catch {
      return no('bad-claims');
    }
    const parsed = parseClaims(raw);
    if (!parsed.ok) return no(parsed.reason);
    const { claims } = parsed;
    if (expired(claims, nowMs)) return no('expired', claims);
    if (claims.iat * 1000 > nowMs + CLOCK_SKEW_MS) return no('not-yet-valid', claims);
    return { valid: true, reason: 'ok', claims };
  } catch {
    return no('verify-error');
  }
}

/**
 * Entitlement state of a stored licence record `{ token, claims, checkedAt }` (checkedAt = ms of the last successful
 * verification or server re-check). Synchronous: it does not re-verify the signature, so only store claims that
 * verifyLicenceToken accepted.
 *   none     no usable token or claims                       -> free
 *   active   checked within licenceRecheckMs (inclusive)     -> claims.plan
 *   grace    older, within offlineGraceMs of checkedAt (inclusive) -> claims.plan
 *   expired  older than that, claims.exp passed (`nowMs >= exp*1000`), or the record's times are unusable -> free
 * A `checkedAt` more than CLOCK_SKEW_MS in the future cannot be trusted and counts as expired.
 * @returns {{plan: 'free'|'pro', status: 'none'|'active'|'grace'|'expired'}}
 */
export function licenceState(record, nowMs) {
  const none = { plan: 'free', status: 'none' };
  const lapsed = { plan: 'free', status: 'expired' };
  if (!isObject(record)) return none;
  const { token, checkedAt } = record;
  if (typeof token !== 'string' || token.trim() === '') return none;
  const parsed = parseClaims(record.claims);
  if (!parsed.ok) return none;
  const { claims } = parsed;

  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) return lapsed;
  if (expired(claims, nowMs)) return lapsed;
  if (typeof checkedAt !== 'number' || !Number.isFinite(checkedAt) || checkedAt < 0) return lapsed;
  const age = nowMs - checkedAt;
  if (age < -CLOCK_SKEW_MS) return lapsed;
  if (age <= LIMITS.licenceRecheckMs) return { plan: claims.plan, status: 'active' };
  if (age <= LIMITS.offlineGraceMs) return { plan: claims.plan, status: 'grace' };
  return lapsed;
}

/**
 * True when a stored `claims` object says exactly what the signed token says about the licence (plan, subscriber, issue and
 * expiry time). The stored copy is hand-editable, so every decision that can grant something takes the claims from the verified
 * token and treats a stored copy that disagrees as an edited record.
 */
export function claimsMatch(stored, verified) {
  const a = parseClaims(stored);
  const b = parseClaims(verified);
  if (!a.ok || !b.ok) return false;
  return a.claims.plan === b.claims.plan && a.claims.sub === b.claims.sub && a.claims.iat === b.claims.iat && a.claims.exp === b.claims.exp && a.claims.tier === b.claims.tier;
}

export const LAPSE_REASONS = ['token-expired', 'not-rechecked', 'invalid'];

/**
 * Why a record that licenceState() calls `expired` has lapsed: the token's own `exp` passed ('token-expired'), or it simply has
 * not been re-checked for longer than the grace period ('not-rechecked'; a token without `exp` never expires by itself).
 * Meaningful only for a record whose status is `expired`.
 */
export function lapseReason(record, nowMs) {
  const parsed = isObject(record) ? parseClaims(record.claims) : { ok: false };
  if (parsed.ok && typeof nowMs === 'number' && Number.isFinite(nowMs) && expired(parsed.claims, nowMs)) return 'token-expired';
  return 'not-rechecked';
}

/**
 * licenceState() for a stored record, with the signature checked and the claims taken from the SIGNED token (never from the
 * record's own, editable `claims`). The background and the popup use it, so they answer the way the page's engine does.
 *   free / none        nothing usable stored
 *   free / expired     + reason: 'token-expired' (signed exp passed), 'not-rechecked' (older than the grace period),
 *                      'invalid' (signature, key or time check failed, or the stored claims disagree with the signed ones)
 *   pro  / active|grace  only for a token that verifies right now
 * @param {{verify?: Function, state?: Function}} [fns] test seams
 * @returns {Promise<{plan: 'free'|'pro', status: string, reason?: string}>}
 */
export async function verifiedLicenceState(record, nowMs, publicKeyJwk, fns = {}) {
  const verify = fns.verify || verifyLicenceToken;
  const state = fns.state || licenceState;
  const base = state(record, nowMs);
  if (base.status === 'expired') return { plan: 'free', status: 'expired', reason: lapseReason(record, nowMs) };
  if (base.plan !== 'pro') return { plan: base.plan === 'pro' ? 'pro' : 'free', status: base.status };
  let result = null;
  try { result = await verify(record.token, nowMs, publicKeyJwk); } catch { result = null; }
  if (!result || result.valid !== true || !isObject(result.claims)) {
    return { plan: 'free', status: 'expired', reason: result && result.reason === 'expired' ? 'token-expired' : 'invalid' };
  }
  if (!claimsMatch(record.claims, result.claims)) return { plan: 'free', status: 'expired', reason: 'invalid' };
  return { plan: base.plan, status: base.status };
}

/**
 * Build-time: signs ANY JSON-able claims object into a token. It validates nothing, so tests can mint bad claims;
 * tools must run parseClaims first. Never called by the extension (no private key ships).
 */
export async function signLicenceToken(claims, privateKeyJwk) {
  const bytes = new TextEncoder().encode(JSON.stringify(claims));
  return `${base64urlEncode(bytes)}.${await signPayload(bytes, privateKeyJwk)}`;
}
