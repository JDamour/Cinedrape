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
import {
  DEFAULT_SETTINGS, LIMITS, MSG, STORAGE_KEYS, UNINSTALL_URL, WELCOME_URL,
} from '../shared/constants.js';
import * as publicKeys from '../shared/public-keys.js';
import { compareMapVersions, verifyEnvelope as defaultVerifyEnvelope } from '../shared/signing.js';
import { parseEnvelopePayload } from '../shared/selector-map.js';
import { messageId, messagePatch } from '../shared/messages.js';
import { createLicenceManager } from './licence-manager.js';
import { parseMapVersion, refreshSelectorMap } from './map-updater.js';
import { calculateNextBoundaryMs, createSettingsStore } from './settings-store.js';
import { canStartTrial, getTrialDay, isTrialActive } from '../shared/entitlements.js';
import defaultBundledEnvelope from '../data/selector-map.signed.json' with { type: 'json' };

/** Base URL of the Cinedrape API, no trailing slash needed. Empty = the extension never touches the network. */
export const API_BASE = '';

export const ALARM_LICENCE = 'cd-licence';
export const ALARM_MAP = 'cd-map';
export const ALARM_SCHEDULE = 'cd-schedule';
export const ALARM_TRIAL_END = 'cd-trial-end';
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
    chrome, fetch, now = () => Date.now(), apiBase = '', keys = DEFAULT_KEYS, readBundledVersion, readBundledMap,
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

  // The packaged map (data/selector-map.json). Reading our own file is not network access. A failed read is not cached.
  let bundledMapCache = null;
  async function bundledMap() {
    if (bundledMapCache) return bundledMapCache;
    try {
      let map = null;
      if (readBundledMap) {
        map = await readBundledMap();
      } else {
        const res = await globalThis.fetch(chrome.runtime.getURL(BUNDLED_MAP_PATH));
        if (res.ok) map = parseEnvelopePayload(await res.json());
      }
      if (map && typeof map === 'object') bundledMapCache = map;
    } catch {}
    if (!bundledMapCache && defaultBundledEnvelope) {
      bundledMapCache = parseEnvelopePayload(defaultBundledEnvelope);
    }
    return bundledMapCache;
  }

  /** Verified cached map when it is newer than the packaged one, else the packaged map (null only if unreadable). */
  async function getActiveSelectorMap() {
    const bundled = await bundledMap();
    const stored = await store.get(STORAGE_KEYS.selectorMap);
    if (stored) {
      try {
        const res = await (verifyEnvelope || defaultVerifyEnvelope)(stored, mapKey);
        if (res && res.ok && res.payload) {
          const map = JSON.parse(res.payload);
          if (!bundled || compareMapVersions(map.mapVersion, bundled.mapVersion) > 0) return map;
        }
      } catch {}
    }
    return bundled;
  }

  const settingsStore = createSettingsStore({
    chrome,
    now,
    licence,
    getSelectorMap: getActiveSelectorMap,
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
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: { ...JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), calm: {} },
      [STORAGE_KEYS.install]: { installedAt: now(), day7Dismissed: false },
    });
    return true;
  }

  /** Creates the alarms when missing, or when an update changed their period. */
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
    await updateScheduleAlarm();
  }

  /** Updates the schedule alarm based on stored schedule. */
  async function updateScheduleAlarm() {
    if (!chrome.alarms) return;
    const schedule = await settingsStore.getScheduleRecord();
    const existing = await chrome.alarms.get(ALARM_SCHEDULE);
    if (schedule && schedule.enabled) {
      if (!existing || existing.periodInMinutes !== 1) {
        await chrome.alarms.create(ALARM_SCHEDULE, { periodInMinutes: 1 });
      }
    } else if (existing) {
      await chrome.alarms.clear(ALARM_SCHEDULE);
    }
  }

  /** Applies the schedule's current slot if it has not been applied yet (see settings-store `checkSchedule`). */
  function checkSchedule() {
    return settingsStore.checkSchedule();
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

  // Allow content scripts to read session storage if supported
  try {
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.setAccessLevel === 'function') {
      chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});
    }
  } catch {}

  async function checkTrialExpiry() {
    if (!chrome.storage || !chrome.storage.session) return;
    try {
      const items = await chrome.storage.session.get([STORAGE_KEYS.trial]);
      const trial = items ? items[STORAGE_KEYS.trial] : undefined;
      if (trial && typeof trial.until === 'number') {
        if (trial.until <= now()) {
          await chrome.storage.session.remove(STORAGE_KEYS.trial);
          await chrome.storage.session.set({ cd_trialEnded: true });
          if (chrome.alarms) await chrome.alarms.clear(ALARM_TRIAL_END);
        } else if (chrome.alarms) {
          const existing = await chrome.alarms.get(ALARM_TRIAL_END);
          if (!existing) {
            await chrome.alarms.create(ALARM_TRIAL_END, { when: trial.until });
          }
        }
      }
    } catch (err) {
      debug('checkTrialExpiry failed', err);
    }
  }

  async function startTrial() {
    if (!chrome.storage || !chrome.storage.session) {
      return { ok: false, reason: 'unsupported', message: 'Session storage is not available in this browser.' };
    }
    const trialLog = await store.get(STORAGE_KEYS.trialLog);
    const check = canStartTrial(trialLog, now(), LIMITS.maxDailyTrials);
    if (!check.ok) {
      return { ok: false, reason: check.reason, message: check.message };
    }
    const today = getTrialDay(now());
    const count = check.count + 1;
    await store.set(STORAGE_KEYS.trialLog, { day: today, count });

    const duration = LIMITS.trialDurationMs || (10 * 60 * 1000);
    const until = now() + duration;
    const trial = { until, used: count };
    await chrome.storage.session.set({ [STORAGE_KEYS.trial]: trial });
    await chrome.storage.session.remove('cd_trialEnded').catch(() => {});

    if (chrome.alarms) {
      await chrome.alarms.create(ALARM_TRIAL_END, { when: until });
    }
    return { ok: true, trial };
  }

  async function getTrial() {
    let trial = null;
    let trialEnded = false;
    if (chrome.storage && chrome.storage.session) {
      try {
        const items = await chrome.storage.session.get([STORAGE_KEYS.trial, 'cd_trialEnded']);
        if (items) {
          const raw = items[STORAGE_KEYS.trial];
          if (isTrialActive(raw, now())) trial = raw;
          if (items.cd_trialEnded) trialEnded = true;
        }
      } catch {}
    }
    const trialLog = await store.get(STORAGE_KEYS.trialLog);
    const check = canStartTrial(trialLog, now(), LIMITS.maxDailyTrials);
    return { ok: true, trial, trialEnded, trialLog: trialLog || null, canStart: check.ok };
  }

  function initialise() {
    return serial(async () => {
      for (const step of [ensureDefaults, ensureAlarms, pruneStaleMap, refreshLicenceLocally, checkSchedule, checkTrialExpiry]) {
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
    else if (name === ALARM_SCHEDULE) {
      job = async () => {
        const result = await checkSchedule();
        await updateScheduleAlarm();
        return result;
      };
    }
    else if (name === ALARM_TRIAL_END) {
      job = async () => {
        if (chrome.storage && chrome.storage.session) {
          await chrome.storage.session.remove(STORAGE_KEYS.trial);
          await chrome.storage.session.set({ cd_trialEnded: true }).catch(() => {});
        }
        if (chrome.alarms) await chrome.alarms.clear(ALARM_TRIAL_END);
        return { ok: true };
      };
    }
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
        return respondAsync(sendResponse, async () => {
          const res = await licence.activate(message.token);
          // Pro may have just started: arm (or clear) the schedule alarm without waiting for the next start-up.
          await updateScheduleAlarm().catch(() => {});
          return res;
        });
      case MSG.REFRESH_MAP:
        return respondAsync(sendResponse, async () => ({ ok: true, ...(await refreshFromMessage()) }));
      case MSG.SAVE_THEME:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => settingsStore.saveTheme(message.theme, {
          mode: message.mode,
          expectedRevision: message.expectedRevision,
          apply: message.apply,
        }));
      case MSG.DELETE_THEME:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => settingsStore.deleteTheme(messageId(message), {
          expectedRevision: message.expectedRevision,
          resetReferences: message.resetReferences,
        }));
      case MSG.SAVE_PROFILE:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => settingsStore.saveProfile(message.profile, message.expectedRevision));
      case MSG.DELETE_PROFILE:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, async () => {
          const res = await settingsStore.deleteProfile(messageId(message), message.expectedRevision);
          // Deleting a profile a schedule used disables that schedule; drop its alarm too.
          if (res.ok) await updateScheduleAlarm().catch(() => {});
          return res;
        });
      case MSG.APPLY_PROFILE:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => settingsStore.applyProfile(messageId(message)));
      case MSG.UPDATE_SCHEDULE:
      case 'cd:updateSchedule':
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, async () => {
          const res = message.schedule ? await settingsStore.updateSchedule(message.schedule) : { ok: true };
          if (!res.ok) return res;
          await updateScheduleAlarm();
          const checkRes = await checkSchedule();
          return { ok: true, schedule: res.schedule, check: checkRes };
        });
      case MSG.SAVE_SETTINGS:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => settingsStore.saveSettings(messagePatch(message)));
      case MSG.START_TRIAL:
        if (!fromExtensionPage(sender)) {
          send(sendResponse, { ok: false, reason: 'forbidden' });
          return false;
        }
        return respondAsync(sendResponse, () => startTrial());
      case MSG.GET_TRIAL:
        return respondAsync(sendResponse, () => getTrial());
      default:
        return false;
    }
  }

  async function handleInstalled(details) {
    if (details && details.reason === 'install') {
      if (chrome.tabs && typeof chrome.tabs.create === 'function') {
        try {
          await chrome.tabs.create({ url: WELCOME_URL });
        } catch (err) {
          debug('welcome tab failed', err);
        }
      }
    }
    if (chrome.runtime && typeof chrome.runtime.setUninstallURL === 'function') {
      try {
        await chrome.runtime.setUninstallURL(UNINSTALL_URL);
      } catch (err) {
        debug('setUninstallURL failed', err);
      }
    }
    return initialise();
  }

  // ---- wiring ----------------------------------------------------------------------------------------------------------
  /** Attaches every listener. Call it synchronously at top level of the worker, never from a promise or timer. */
  function register() {
    chrome.runtime.onInstalled.addListener((details) => handleInstalled(details));
    chrome.runtime.onStartup.addListener(() => initialise());
    if (chrome.alarms) chrome.alarms.onAlarm.addListener((alarm) => handleAlarm(alarm));
    chrome.runtime.onMessage.addListener(handleMessage);
    if (chrome.runtime && typeof chrome.runtime.setUninstallURL === 'function') {
      try {
        chrome.runtime.setUninstallURL(UNINSTALL_URL);
      } catch (err) {
        debug('setUninstallURL failed', err);
      }
    }
  }

  return {
    licence, register, refreshMap, settingsStore,
    ensureDefaults, ensureAlarms, pruneStaleMap, refreshLicenceLocally,
    updateScheduleAlarm, checkSchedule,
    checkTrialExpiry, startTrial, getTrial,
    handleInstalled, handleStartup: initialise, handleAlarm, handleMessage,
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
