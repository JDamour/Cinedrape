// Selector-map refresh (ARCHITECTURE.md §3.1 and §4, background).
//
// Fetches `${apiBase}/selector-map.json`, accepts it only when it is a correctly signed, well-formed and strictly
// newer map, and stores the verified envelope (exactly `{payload, sig, kid}`) under STORAGE_KEYS.selectorMap.
//
// Rules this module keeps:
//  - no network at all without an apiBase (the MVP default), and only ever a plain GET: no body, no custom headers,
//    no cookies, no referrer, no query string, so nothing identifies the user or the install;
//  - nothing is trusted before its signature verifies; nothing unverified is parsed beyond the outer envelope;
//  - a map that is older than the bundled or the stored one is a downgrade and is refused; an equal one is a no-op;
//  - a signed map that would leave the ad guard empty is refused (§6: hide rules rely on `protected.ads`);
//  - it never throws: every failure is a `{ok:false, reason}` result, and a slow server is cut off after 10 s.
//
// The network helpers (resolveApiUrl, fetchTextCapped) live here because licence-manager.js needs the same ones.
import { STORAGE_KEYS } from '../shared/constants.js';
import { compareMapVersions, verifyEnvelope as defaultVerifyEnvelope } from '../shared/signing.js';
import { validateMapShape as defaultValidateMapShape } from '../shared/selector-map.js';

export const FETCH_TIMEOUT_MS = 10000;
export const MAP_MAX_BYTES = 256 * 1024;          // the shipped map is about 18 KB; anything near this is not a map
export const SUPPORTED_SCHEMA = 1;

const MAX_ROLES = 256;
const MAX_SELECTORS_PER_LIST = 64;
const MAX_SELECTOR_CHARS = 1000;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- network helpers -------------------------------------------------------------------------------------------------

/** A failure with a stable, machine-readable `reason` ('timeout', 'network', 'too-large'). */
export class NetError extends Error {
  constructor(reason) {
    super(reason);
    this.name = 'NetError';
    this.reason = reason;
  }
}

const isLocalHost = (host) => host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host.endsWith('.localhost');

/**
 * `${apiBase}/${path}` or null when apiBase is not a usable base. https only (plain http only for a local dev server);
 * no credentials, query or fragment in the base, so a path can be appended unambiguously and nothing rides along.
 */
export function resolveApiUrl(apiBase, path) {
  if (typeof apiBase !== 'string' || apiBase.trim() === '') return null;
  let url;
  try {
    url = new URL(apiBase.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLocalHost(url.hostname))) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}`;
  return url.href;
}

async function readCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try { await res.body?.cancel?.(); } catch { /* the body is being dropped anyway */ }
    throw new NetError('too-large');
  }
  if (res.body && typeof res.body.getReader === 'function') {
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* ditto */ }
        throw new NetError('too-large');
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.byteLength; }
    return new TextDecoder('utf-8').decode(bytes);
  }
  const text = await res.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new NetError('too-large');
  return text;
}

/**
 * One request with a hard deadline that covers connecting AND reading the body, and a cap on the body size.
 * Resolves `{ok, status, text}` for ANY HTTP status; throws NetError('timeout'|'network'|'too-large').
 * The deadline is a race, not just an abort signal, so a fetch that ignores `signal` still cannot hang the worker.
 */
export async function fetchTextCapped(fetchFn, url, init, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAP_MAX_BYTES } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new NetError('timeout'));
    }, timeoutMs);
  });
  const work = (async () => {
    const res = await fetchFn(url, { ...init, signal: controller.signal });
    const text = await readCapped(res, maxBytes);
    return { ok: Boolean(res.ok), status: Number(res.status) || 0, text };
  })();
  work.catch(() => {});                           // if the deadline wins, a late failure of `work` must not go unhandled
  try {
    return await Promise.race([work, deadline]);
  } catch (err) {
    if (err instanceof NetError) throw err;
    throw new NetError(timedOut ? 'timeout' : 'network');
  } finally {
    clearTimeout(timer);
  }
}

// ---- map checks --------------------------------------------------------------------------------------------------------

function isSelectorList(v) {
  return Array.isArray(v) && v.length > 0 && v.length <= MAX_SELECTORS_PER_LIST
    && v.every((s) => typeof s === 'string' && s.trim() !== '' && s.length <= MAX_SELECTOR_CHARS);
}

const isStringList = (v) => Array.isArray(v) && v.length <= 4 * MAX_SELECTORS_PER_LIST
  && v.every((s) => typeof s === 'string' && s.length <= MAX_SELECTOR_CHARS);

/**
 * Cheap structural sanity check, independent of shared/selector-map.js (which does the deep validation). It exists so a
 * correctly signed but broken map (server bug, wrong file signed) can never blank the extension, and so the ad guard
 * can never end up empty. Returns a short reason, or null when the map looks usable.
 */
export function checkMapShape(map) {
  if (!isObject(map)) return 'not-an-object';
  if (map.schema !== SUPPORTED_SCHEMA) return 'unsupported-schema';
  if (Number.isNaN(compareMapVersions(map.mapVersion, map.mapVersion))) return 'bad-version';
  if (typeof map.issuedAt !== 'string' || Number.isNaN(Date.parse(map.issuedAt))) return 'bad-issued-at';
  if (!isObject(map.roles)) return 'bad-roles';
  const roleNames = Object.keys(map.roles);
  if (roleNames.length === 0 || roleNames.length > MAX_ROLES || !roleNames.every((r) => isSelectorList(map.roles[r]))) return 'bad-roles';
  if (!isObject(map.pageRoles)) return 'bad-page-roles';
  if (map.requires !== undefined && !isObject(map.requires)) return 'bad-requires';
  if (!isObject(map.vars)) return 'bad-vars';
  const guard = map.protected;
  if (!isObject(guard) || !isSelectorList(guard.ads) || !isSelectorList(guard.sponsor)) return 'bad-protected';
  for (const group of ['playerControls', 'containers']) {
    if (guard[group] !== undefined && !isStringList(guard[group])) return 'bad-protected';
  }
  return null;
}

/** The `mapVersion` inside an envelope's payload, WITHOUT verifying the signature (use for housekeeping only), or null. */
export function parseMapVersion(envelope) {
  try {
    if (!isObject(envelope) || typeof envelope.payload !== 'string') return null;
    const map = JSON.parse(envelope.payload);
    const version = isObject(map) ? map.mapVersion : undefined;
    return Number.isNaN(compareMapVersions(version, version)) ? null : version;
  } catch {
    return null;
  }
}

/** Interprets whatever shared/selector-map.js `validateMapShape` returns: false, {ok:false}, or a non-empty errors list reject. */
function shapeRejected(result) {
  if (result === false) return true;
  if (Array.isArray(result)) return result.length > 0;
  if (isObject(result)) return result.ok === false || (Array.isArray(result.errors) && result.errors.length > 0);
  return false;
}

/** The highest mapVersion we already hold: the bundled one and the stored one, the latter only if it still verifies. */
async function currentVersion({ store, publicKey, bundledVersion, verifyEnvelope }) {
  let best = Number.isNaN(compareMapVersions(bundledVersion, bundledVersion)) ? null : bundledVersion;
  try {
    const stored = await store.get(STORAGE_KEYS.selectorMap);
    const version = parseMapVersion(stored);
    // A stored map that no longer verifies is ignored, otherwise a corrupted or planted huge version would block every update.
    if (version && (best === null || compareMapVersions(version, best) > 0)) {
      const verified = await verifyEnvelope(stored, publicKey);
      if (verified && verified.ok === true) best = version;
    }
  } catch { /* an unreadable store just means "nothing stored" */ }
  return best;
}

// ---- refresh -----------------------------------------------------------------------------------------------------------

/**
 * @param {object} p
 * @param {(url: string, init?: object) => Promise<Response>} p.fetch
 * @param {string} p.apiBase                  empty = do nothing, no network
 * @param {() => number} [p.now]
 * @param {object} p.publicKey                SELECTOR_MAP_PUBLIC_KEY (JWK)
 * @param {{get(key: string): Promise<any>, set(key: string, value: any): Promise<void>}} p.store
 * @param {string} [p.bundledVersion]         mapVersion of the map shipped in the package (the floor for downgrades)
 * @param {Function} [p.verifyEnvelope]       override for tests; defaults to shared/signing.js
 * @param {Function} [p.validateMapShape]     override for tests; defaults to shared/selector-map.js
 * @param {number} [p.timeoutMs]
 * @param {number} [p.maxBytes]
 * @returns {Promise<{skipped: true} | {ok: true, updated: boolean, mapVersion: string, checkedAt: number, reason?: string}
 *   | {ok: false, reason: string}>}
 * Failure reasons: bad-api-base, no-key, timeout, network, too-large, http-<status>, not-json, bad-envelope, unsigned,
 * bad-signature (and the verifier's own reasons), bad-payload, unsupported-schema and the other checkMapShape reasons,
 * invalid-map, downgrade, storage-error, error. 'up-to-date' (same version) is a success with `updated: false`.
 */
export async function refreshSelectorMap({
  fetch, apiBase, now = Date.now, publicKey, store, bundledVersion,
  verifyEnvelope = defaultVerifyEnvelope, validateMapShape = defaultValidateMapShape,
  timeoutMs = FETCH_TIMEOUT_MS, maxBytes = MAP_MAX_BYTES,
} = {}) {
  try {
    if (typeof apiBase === 'string' ? apiBase.trim() === '' : !apiBase) return { skipped: true };
    const url = resolveApiUrl(apiBase, 'selector-map.json');
    if (!url) return { ok: false, reason: 'bad-api-base' };
    if (!isObject(publicKey)) return { ok: false, reason: 'no-key' };      // cannot verify, so do not even ask
    if (typeof fetch !== 'function' || !store) return { ok: false, reason: 'error' };

    let response;
    try {
      response = await fetchTextCapped(fetch, url, {
        method: 'GET', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
      }, { timeoutMs, maxBytes });
    } catch (err) {
      return { ok: false, reason: err instanceof NetError ? err.reason : 'network' };
    }
    if (!response.ok) return { ok: false, reason: `http-${response.status}` };

    let envelope;
    try {
      envelope = JSON.parse(response.text);
    } catch {
      return { ok: false, reason: 'not-json' };
    }
    if (!isObject(envelope) || typeof envelope.payload !== 'string') return { ok: false, reason: 'bad-envelope' };
    if (typeof envelope.sig !== 'string' || envelope.sig === '') return { ok: false, reason: 'unsigned' };
    // Keep exactly the three known members; whatever else the server sent is not stored.
    const signed = { payload: envelope.payload, sig: envelope.sig, kid: envelope.kid };

    const verified = await verifyEnvelope(signed, publicKey);
    if (!verified || verified.ok !== true) {
      return { ok: false, reason: typeof verified?.reason === 'string' ? verified.reason : 'bad-signature' };
    }

    let map;
    try {
      map = JSON.parse(signed.payload);
    } catch {
      return { ok: false, reason: 'bad-payload' };
    }
    const problem = checkMapShape(map);
    if (problem) return { ok: false, reason: problem };
    try {
      if (shapeRejected(await validateMapShape(map))) return { ok: false, reason: 'invalid-map' };
    } catch {
      return { ok: false, reason: 'invalid-map' };
    }

    const held = await currentVersion({ store, publicKey, bundledVersion, verifyEnvelope });
    const order = held === null ? 1 : compareMapVersions(map.mapVersion, held);
    const checkedAt = now();
    if (order < 0) return { ok: false, reason: 'downgrade' };
    if (order === 0) return { ok: true, updated: false, reason: 'up-to-date', mapVersion: map.mapVersion, checkedAt };

    try {
      await store.set(STORAGE_KEYS.selectorMap, { payload: signed.payload, sig: signed.sig, kid: signed.kid });
    } catch {
      return { ok: false, reason: 'storage-error' };
    }
    return { ok: true, updated: true, mapVersion: map.mapVersion, checkedAt };
  } catch {
    return { ok: false, reason: 'error' };
  }
}
