// Cinedrape background service worker (ARCHITECTURE.md §4, background).
//
// MV3 workers are killed whenever Chrome likes, so this file keeps NO state that matters: settings, the licence and the
// selector map all live in chrome.storage.local under STORAGE_KEYS, and the only things held in memory are optimisations
// (a single-flight map refresh and a cooldown for manual refreshes) that are safe to lose.
//
// Privacy: no identifiers, no telemetry, and no network at all unless API_BASE is set. It is empty in the MVP, which turns
// the 6-hourly map refresh into a no-op and the weekly licence re-check into a purely local re-verification of the stored token. If you set it, also add the API origin to
// `host_permissions` in manifest.json (or make the server answer CORS), and see licence-manager.js for the protocol.
//
// Structure: createBackground() builds all the handlers from injected dependencies (tests pass chrome-mock and fakes); the
// few lines at the bottom wire the real `chrome` and register every listener synchronously at top level, which is the only
// way MV3 delivers the event that woke the worker.
import { DEFAULT_SETTINGS, LIMITS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import * as publicKeys from '../shared/public-keys.js';
import { compareMapVersions } from '../shared/signing.js';
import { createLicenceManager } from './licence-manager.js';
import { parseMapVersion, refreshSelectorMap } from './map-updater.js';

/** Base URL of the Cinedrape API, no trailing slash needed. Empty = the extension never touches the network. */
export const API_BASE = '';

export const ALARM_LICENCE = 'cd-licence';
export const ALARM_MAP = 'cd-map';
export const MANUAL_REFRESH_COOLDOWN_MS = 30000;
export const BUNDLED_MAP_PATH = 'data/selector-map.json';

const DEFAULT_KEYS = Object.freeze({
  licence: publicKeys.LICENCE_PUBLIC_KEY,
  selectorMap: publicKeys.SELECTOR_MAP_PUBLIC_KEY,
});

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const debug = (...args) => {
  if (typeof __DEV__ !== 'undefined' && __DEV__) console.debug('[cinedrape]', ...args);
};

/** Adapts a chrome.storage area to the `{get, set, remove}` store the managers use. */
export function createChromeStore(area) {
  return {
    async get(key) {
      const items = await area.get(key);
      return items ? items[key] : undefined;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}

/**
 * @param {object} options
 * @param {object} options.chrome       chrome.storage.local, chrome.alarms, chrome.runtime
 * @param {Function} [options.fetch]    network fetch; only used when apiBase is set
 * @param {() => number} [options.now]
 * @param {{licence?: object, selectorMap?: object}} [options.keys]   public JWKs (default: shared/public-keys.js)
 * @param {string} [options.apiBase]
 * @param {() => Promise<string|undefined>} [options.readBundledVersion]  mapVersion of the map shipped in the package
 * Everything else (verifyLicenceToken, licenceState, verifyEnvelope, validateMapShape, timeoutMs) is forwarded to the
 * managers and exists so tests can inject fakes.
 */
export function createBackground(options = {}) {
  const {
    chrome, fetch, now = () => Date.now(), apiBase = '', keys = DEFAULT_KEYS, readBundledVersion,
    verifyLicenceToken, licenceState, verifyEnvelope, validateMapShape, timeoutMs,
  } = options;
  if (!chrome || !chrome.storage || !chrome.storage.local) throw new TypeError('createBackground: chrome.storage.local is required');

  const base = typeof apiBase === 'string' ? apiBase.trim() : apiBase;
  const store = createChromeStore(chrome.storage.local);
  const licenceKey = keys.licence ?? keys.LICENCE_PUBLIC_KEY;
  const mapKey = keys.selectorMap ?? keys.SELECTOR_MAP_PUBLIC_KEY;

  const licence = createLicenceManager({
    store, now, apiBase: base, fetch, publicKey: licenceKey, verifyLicenceToken, licenceState, timeoutMs,
  });

  // ---- bundled map version (the floor for downgrade checks) ----------------------------------------------------------
  async function bundledVersion() {
    try {
      let version;
      if (readBundledVersion) {
        version = await readBundledVersion();
      } else {
        // Reading our own packaged file is not network access; it deliberately does not use the injected `fetch`.
        const res = await globalThis.fetch(chrome.runtime.getURL(BUNDLED_MAP_PATH));
        if (res.ok) version = parseMapVersion(await res.json());
      }
      return typeof version === 'string' && !Number.isNaN(compareMapVersions(version, version)) ? version : undefined;
    } catch {
      return undefined;
    }
  }

  // ---- install / startup -----------------------------------------------------------------------------------------------
  // onInstalled and onStartup can both fire for one launch, so lifecycle work is queued: the second run then sees what
  // the first one did instead of racing it (a second alarms.create would also reset the alarm's schedule).
  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  /** Writes DEFAULT_SETTINGS only when nothing is stored yet. An existing value, even a strange one, is never touched.
   *  `calm` is seeded empty: explicit false values would override a theme's own calm defaults (Minimal hides Shorts)
   *  before the user has ever chosen anything. Only toggles the user actually sets are stored. */
  async function ensureDefaults() {
    const current = await store.get(STORAGE_KEYS.settings);
    if (current !== undefined && current !== null) return false;
    await store.set(STORAGE_KEYS.settings, { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), calm: {} });
    return true;
  }

  /** Creates the two alarms when missing, or when an update changed their period. */
  async function ensureAlarms() {
    if (!chrome.alarms) return;
    const wanted = [
      [ALARM_LICENCE, LIMITS.licenceRecheckMs / 60000],
      [ALARM_MAP, LIMITS.mapRefreshMs / 60000],
    ];
    for (const [name, periodInMinutes] of wanted) {
      const existing = await chrome.alarms.get(name);
      if (existing && existing.periodInMinutes === periodInMinutes) continue;
      await chrome.alarms.create(name, { periodInMinutes });
    }
  }

  /**
   * A stored map that is older than the one in the package (after an extension update) must not keep overriding it, and an
   * unreadable one is just garbage. Deleting it is safe: the next refresh stores a verified one again.
   */
  async function pruneStaleMap() {
    const bundled = await bundledVersion();
    if (!bundled) return false;
    const stored = await store.get(STORAGE_KEYS.selectorMap);
    if (stored === undefined) return false;
    const version = parseMapVersion(stored);
    if (version && compareMapVersions(version, bundled) >= 0) return false;
    await store.remove(STORAGE_KEYS.selectorMap);
    return true;
  }

  /**
   * With no server, a licence has nobody to re-check it, so its checkedAt would age out (7 d active, 30 d grace) whenever the
   * weekly alarm did not get to run (a browser that was closed for a month). Verifying the stored token locally at every start
   * keeps its own exp the only expiry. Not done when an API_BASE exists: then only a server answer may move checkedAt.
   */
  async function refreshLicenceLocally() {
    if (base) return false;
    const result = await licence.recheck();
    return !!(result && result.ok === true);
  }

  function initialise() {
    return serial(async () => {
      for (const step of [ensureDefaults, ensureAlarms, pruneStaleMap, refreshLicenceLocally]) {
        try { await step(); } catch (err) { debug('init step failed', step.name, err); }
      }
    });
  }

  // ---- map refresh -----------------------------------------------------------------------------------------------------
  let inflight = null;
  let lastManualRefresh = null;

  async function runRefresh() {
    try {
      return await refreshSelectorMap({
        fetch, apiBase: base, now, publicKey: mapKey, store,
        bundledVersion: base ? await bundledVersion() : undefined,
        verifyEnvelope, validateMapShape, timeoutMs,
      });
    } catch {
      return { ok: false, reason: 'error' };
    }
  }

  /** One refresh at a time: the alarm and a manual request that overlap share the same network call. */
  function refreshMap() {
    if (!inflight) inflight = runRefresh().finally(() => { inflight = null; });
    return inflight;
  }

  async function refreshFromMessage() {
    if (!base || inflight) return refreshMap();
    const at = now();
    const since = lastManualRefresh === null ? Infinity : at - lastManualRefresh;
    if (since >= 0 && since < MANUAL_REFRESH_COOLDOWN_MS) return { ok: false, reason: 'rate-limited' };
    lastManualRefresh = at;
    return refreshMap();
  }

  // ---- alarms ----------------------------------------------------------------------------------------------------------
  function handleAlarm(alarm) {
    const name = isObject(alarm) ? alarm.name : undefined;
    let job;
    if (name === ALARM_LICENCE) job = () => licence.recheck();
    else if (name === ALARM_MAP) job = () => refreshMap();
    else return Promise.resolve(undefined);
    return Promise.resolve().then(job).catch((err) => {
      debug('alarm failed', name, err);
      return { ok: false, reason: 'error' };
    });
  }

  // ---- messages --------------------------------------------------------------------------------------------------------
  const extensionOrigin = (() => {
    try { return chrome.runtime.getURL(''); } catch { return ''; }
  })();

  /** Licence activation must come from one of our own pages (the popup), not from a content script on youtube.com. */
  function fromExtensionPage(sender) {
    if (!isObject(sender)) return false;
    if (typeof sender.id === 'string' && chrome.runtime.id && sender.id !== chrome.runtime.id) return false;
    if (sender.tab === undefined) return true;
    return typeof sender.url === 'string' && extensionOrigin !== '' && sender.url.startsWith(extensionOrigin);
  }

  const send = (sendResponse, value) => {
    try { sendResponse(value); } catch (err) { debug('sendResponse failed', err); }
  };

  /** Answers asynchronously; the caller returns true so Chrome keeps the message channel open. */
  function respondAsync(sendResponse, work) {
    Promise.resolve().then(work).then(
      (value) => send(sendResponse, value),
      (err) => {
        debug('message handler failed', err);
        send(sendResponse, { ok: false, reason: 'error' });
      },
    );
    return true;
  }

  /**
   * Replies (all with an `ok` flag):
   *   GET_LICENCE      {ok:true, state:{plan,status,reason?}, plan, status}   (plan/status mirrored at the top level; reason only
   *                    on an expired state: token-expired | not-rechecked | invalid)
   *   ACTIVATE_LICENCE {ok:true, state} | {ok:false, reason}           reasons: malformed, no-key, forbidden, <verifier reason>
   *   REFRESH_MAP      {ok, skipped?, updated?, mapVersion?, reason?}  (rate-limited: at most one request per 30 s)
   * Messages that are not ours get no reply and `false`, so other listeners can answer them.
   */
  function handleMessage(message, sender, sendResponse) {
    if (!isObject(message) || typeof message.type !== 'string') return false;
    switch (message.type) {
      case MSG.GET_LICENCE:
        return respondAsync(sendResponse, async () => {
          const state = await licence.getState();
          return { ok: true, state, plan: state.plan, status: state.status };
        });
      case MSG.ACTIVATE_LICENCE:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => licence.activate(message.token));
      case MSG.REFRESH_MAP:
        return respondAsync(sendResponse, async () => ({ ok: true, ...(await refreshFromMessage()) }));
      default:
        return false;
    }
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------------
  /** Attaches every listener. Call it synchronously at top level of the worker, never from a promise or timer. */
  function register() {
    chrome.runtime.onInstalled.addListener(() => initialise());
    chrome.runtime.onStartup.addListener(() => initialise());
    if (chrome.alarms) chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm));
    chrome.runtime.onMessage.addListener(handleMessage);
  }

  return {
    licence, register, refreshMap,
    ensureDefaults, ensureAlarms, pruneStaleMap, refreshLicenceLocally,
    handleInstalled: initialise, handleStartup: initialise, handleAlarm, handleMessage,
  };
}

// The real worker: `chrome` exists only inside the extension, so importing this file under node:test has no side effects.
if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
  createBackground({
    chrome,
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    keys: DEFAULT_KEYS,
    apiBase: API_BASE,
  }).register();
}
