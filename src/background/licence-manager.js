// Licence manager (ARCHITECTURE.md §4, background; spec "Licence checks").
//
// The licence is a server-signed token the user pastes in. It is verified locally against LICENCE_PUBLIC_KEY and kept in
// chrome.storage.local as `{token, claims, checkedAt}`; `checkedAt` is the last time the token was verified or the server
// re-confirmed it. Shared/licence.js turns that record into `{plan, status}`: active for 7 days after `checkedAt`, then a
// 30 day offline grace, then expired. So this module's whole job is to keep `checkedAt` honest:
//  - activate() stores a record only for a token that verifies, and never touches the old one otherwise;
//  - recheck() without an apiBase (the MVP default) never touches the network: it verifies the stored token again locally
//    (signature + exp) and, when that holds, moves `checkedAt` to now, so with no server the token's own exp is the only
//    expiry (the 7/30 day machinery below would otherwise lapse every licence a month after activation, with nobody to
//    refresh it). With an apiBase it POSTs ONLY `{token}` to `${apiBase}/licence/refresh`; any failure (offline, timeout, 5xx,
//    garbage) leaves the record, and so the cached licence, exactly as it was, and grace simply runs out on its own. Only a
//    verified answer moves `checkedAt`;
//  - the server can never grant anything by itself: a plan comes from a signed token, never from a response field.
//
// Server protocol (the backend does not exist yet; this is the minimal shape this module expects):
//   POST {apiBase}/licence/refresh   body {"token": "<current token>"}
//   200 {"status":"active"}                      still valid: checkedAt moves to now (the stored token is re-verified first)
//   200 {"status":"active","token":"<token>"}    same, with a fresh signed token (must verify and keep the same `sub`)
//   2xx/4xx {"status":"revoked"}                 licence refunded or revoked: the record is removed
//   anything else (5xx, HTML, non-JSON, unknown status): ignored, treated as "could not check"
import { STORAGE_KEYS } from '../shared/constants.js';
import {
  verifyLicenceToken as defaultVerifyLicenceToken, licenceState as defaultLicenceState, verifiedLicenceState,
} from '../shared/licence.js';
import { fetchTextCapped, resolveApiUrl, NetError, FETCH_TIMEOUT_MS } from './map-updater.js';

export const REFRESH_MAX_BYTES = 8 * 1024;
export const MAX_TOKEN_CHARS = 4096;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const noLicence = () => ({ plan: 'free', status: 'none' });

/** Pasted tokens often carry line breaks or spaces; a base64url token never contains whitespace, so strip it all. */
function normaliseToken(raw) {
  if (typeof raw !== 'string') return null;
  if (raw.length > MAX_TOKEN_CHARS * 2) return null;     // do not even scan something absurd
  const token = raw.replace(/\s+/g, '');
  return token !== '' && token.length <= MAX_TOKEN_CHARS ? token : null;
}

/**
 * @param {object} p
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>, remove(key: string): Promise<void>}} p.store
 * @param {() => number} [p.now]
 * @param {string} [p.apiBase]                empty = recheck() is a no-op
 * @param {(url: string, init?: object) => Promise<Response>} [p.fetch]
 * @param {object} p.publicKey                LICENCE_PUBLIC_KEY (JWK)
 * @param {Function} [p.verifyLicenceToken]   override for tests; defaults to shared/licence.js
 * @param {Function} [p.licenceState]         override for tests; defaults to shared/licence.js
 * @param {number} [p.timeoutMs]
 */
export function createLicenceManager({
  store, now = Date.now, apiBase = '', fetch, publicKey,
  verifyLicenceToken = defaultVerifyLicenceToken, licenceState = defaultLicenceState,
  timeoutMs = FETCH_TIMEOUT_MS,
} = {}) {
  /** The stored record if it has the right shape, else null. */
  async function readRecord() {
    let record;
    try {
      record = await store.get(STORAGE_KEYS.licence);
    } catch {
      return null;
    }
    if (!isObject(record) || typeof record.token !== 'string' || record.token === '') return null;
    if (!isObject(record.claims) || typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt)) return null;
    return record;
  }

  function stateOf(record) {
    try {
      const state = licenceState(record, now());
      const out = { plan: state.plan === 'pro' ? 'pro' : 'free', status: String(state.status) };
      const tier = state.tier || (record && record.claims && record.claims.tier);
      if (tier) out.tier = tier;
      return out;
    } catch {
      return noLicence();
    }
  }

  /**
   * `{plan, status}`; `{plan:'free', status:'none'}` when nothing valid is stored. Reads storage only, never the network.
   * A Pro answer needs the token's signature to verify right now and the stored claims to say what the signed ones say (the stored
   * copy is editable), so the popup never shows "Pro active" for a record the page would refuse. A lapsed licence carries `reason`:
   * 'token-expired' (the signed exp passed), 'not-rechecked' (older than the grace period) or 'invalid'.
   */
  async function getState() {
    const record = await readRecord();
    if (!record) return noLicence();
    try {
      const state = await verifiedLicenceState(record, now(), publicKey, { verify: verifyLicenceToken, state: licenceState });
      const out = { plan: state.plan === 'pro' ? 'pro' : 'free', status: String(state.status) };
      const tier = state.tier || (record && record.claims && record.claims.tier);
      if (tier) out.tier = tier;
      if (typeof state.reason === 'string') out.reason = state.reason;
      return out;
    } catch {
      return noLicence();
    }
  }

  /** @returns {Promise<{ok: true, state: {plan: string, status: string}} | {ok: false, reason: string}>} */
  async function activate(rawToken) {
    const token = normaliseToken(rawToken);
    if (!token) return { ok: false, reason: 'malformed' };
    if (!isObject(publicKey)) return { ok: false, reason: 'no-key' };
    let result;
    try {
      result = await verifyLicenceToken(token, now(), publicKey);
    } catch {
      return { ok: false, reason: 'verify-error' };
    }
    if (!result || result.valid !== true || !isObject(result.claims)) {
      const reason = typeof result?.reason === 'string' && result.reason.length <= 64 ? result.reason : 'invalid';
      return { ok: false, reason: reason === 'ok' ? 'invalid' : reason };
    }
    const record = { token, claims: result.claims, checkedAt: now() };
    try {
      await store.set(STORAGE_KEYS.licence, record);
    } catch {
      return { ok: false, reason: 'storage-error' };
    }
    return { ok: true, state: stateOf(record) };
  }

  /** True while the stored record is still the one a network call started from (activate() may have replaced it). */
  async function stillCurrent(record) {
    const current = await readRecord();
    return current !== null && current.token === record.token;
  }

  /**
   * No server exists yet (apiBase is empty), so "re-checked" can only mean "verified again on this machine": the stored token's
   * signature and its own `exp` are checked now and, when they hold, `checkedAt` moves to now and `claims` are rewritten from the
   * signed token. The token's `exp` is then the only expiry (a token without one never lapses by itself), and a hand-edited record
   * is healed. Nothing leaves the browser. A token that does not verify is left alone: licenceState / getState already refuse it.
   */
  async function recheckLocally() {
    try {
      const record = await readRecord();
      if (!record) return { skipped: true, reason: 'no-licence' };
      if (!isObject(publicKey)) return { ok: false, reason: 'no-key' };
      let verified;
      try {
        verified = await verifyLicenceToken(record.token, now(), publicKey);
      } catch {
        return { ok: false, reason: 'verify-error' };
      }
      if (!verified || verified.valid !== true || !isObject(verified.claims)) {
        const reason = typeof verified?.reason === 'string' && verified.reason.length <= 64 && verified.reason !== 'ok' ? verified.reason : 'token-invalid';
        return { ok: false, reason };
      }
      if (!(await stillCurrent(record))) return { ok: false, reason: 'superseded' };
      const next = { token: record.token, claims: verified.claims, checkedAt: now() };
      await store.set(STORAGE_KEYS.licence, next);
      return { ok: true, refreshed: true, local: true, state: stateOf(next) };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  /**
   * @returns {Promise<{skipped: true, reason: 'no-licence'}
   *   | {ok: true, refreshed?: true, local?: true, revoked?: true, state: object} | {ok: false, reason: string}>}
   */
  async function recheck() {
    if (typeof apiBase === 'string' ? apiBase.trim() === '' : !apiBase) return recheckLocally();
    try {
      const record = await readRecord();
      if (!record) return { skipped: true, reason: 'no-licence' };
      const url = resolveApiUrl(apiBase, 'licence/refresh');
      if (!url) return { ok: false, reason: 'bad-api-base' };
      if (!isObject(publicKey)) return { ok: false, reason: 'no-key' };
      if (typeof fetch !== 'function') return { ok: false, reason: 'error' };

      let response;
      try {
        response = await fetchTextCapped(fetch, url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: record.token }),     // nothing else leaves the browser
          credentials: 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer',
        }, { timeoutMs, maxBytes: REFRESH_MAX_BYTES });
      } catch (err) {
        return { ok: false, reason: err instanceof NetError ? err.reason : 'network' };
      }

      let body = null;
      try { body = JSON.parse(response.text); } catch { /* handled below */ }

      if (isObject(body) && body.status === 'revoked' && response.status < 500) {
        if (!(await stillCurrent(record))) return { ok: false, reason: 'superseded' };
        await store.remove(STORAGE_KEYS.licence);
        return { ok: true, revoked: true, state: noLicence() };
      }
      if (!response.ok) return { ok: false, reason: `http-${response.status}` };
      if (!isObject(body) || body.status !== 'active') return { ok: false, reason: 'invalid-response' };

      // Re-verify before extending anything: the token the server just vouched for (or the fresh one it sent) must be
      // valid right now, and a fresh one must belong to the same subscriber.
      const candidate = body.token === undefined ? record.token : normaliseToken(body.token);
      if (candidate === null) return { ok: false, reason: 'invalid-response' };
      let verified;
      try {
        verified = await verifyLicenceToken(candidate, now(), publicKey);
      } catch {
        return { ok: false, reason: 'verify-error' };
      }
      if (!verified || verified.valid !== true || !isObject(verified.claims)) return { ok: false, reason: 'token-invalid' };
      if (candidate !== record.token && verified.claims.sub !== record.claims.sub) return { ok: false, reason: 'invalid-response' };

      if (!(await stillCurrent(record))) return { ok: false, reason: 'superseded' };
      const next = { token: candidate, claims: verified.claims, checkedAt: now() };
      await store.set(STORAGE_KEYS.licence, next);
      return { ok: true, refreshed: true, state: stateOf(next) };
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  return { activate, getState, recheck };
}
