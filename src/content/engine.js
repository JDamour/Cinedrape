// The content-script engine (ARCHITECTURE.md section 4): turns settings, licence and selector map into one injected stylesheet,
// a handful of <html> attributes, the home layout and the health check, and keeps them current.
//
// Rules the code below is built around:
//  - FAIL-OPEN. Any exception leaves YouTube in its default look (injected CSS, attributes and layout removed), logs one
//    console.warn and is never rethrown. After that the engine stays off; GET_STATUS still answers.
//  - stop() undoes everything start() added, so the document is byte-identical to before.
//  - One handler per frame. Storage changes, navigation signals and the reduced-motion query all feed schedule(), which runs the
//    whole pipeline once in the next animation frame (queueMicrotask where there is no rAF). No timers of its own.
//  - The first paint comes from the localStorage cache and is applied synchronously; everything else waits for chrome.storage.
//  - The last health verdict is remembered (chrome.storage.local, STORAGE_KEYS.health) and is the initial disabled set of the next
//    page load, so a feature that is broken everywhere does not flash on for the settle time after every load. It is never trusted
//    past a healthy settle, a different map version, or (for the readability verdict) a different theme / a day's age.
import { ALL_THEME_IDS, ATTR, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, MSG, PAGE_TYPES, STORAGE_KEYS } from '../shared/constants.js';
import { computeEffectiveConfig, isFeatureAllowed } from '../shared/entitlements.js';
import { claimsMatch, licenceState as toLicenceState, verifyLicenceToken } from '../shared/licence.js';
import { LICENCE_PUBLIC_KEY, SELECTOR_MAP_PUBLIC_KEY } from '../shared/public-keys.js';
import { parseEnvelopePayload } from '../shared/selector-map.js';
import { compareMapVersions, verifyEnvelope } from '../shared/signing.js';
import { applyCalmAttributes } from './calm.js';
import { createHealth } from './health.js';
import { createHomeLayout } from './layouts/home.js';
import { isWatchLive, hasWatchMetadata } from './layouts/watch.js';
import { retireNotice, showNotice } from './notice.js';
import { detectPageType, observeNavigation } from './page.js';
import { createSelectors } from './selectors.js';
import { composeStylesheet } from './stylesheet.js';
import { createStyleInjector, sanitizePaintVerdict } from './style-injector.js';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
const LAYOUT_ROLES = ['homeGrid', 'homeGridContents', 'richItem', 'videoTile'];
const LAPSED = Object.freeze({ plan: 'free', status: 'expired' });
/** A remembered "the themed page is unreadable" verdict is re-tested after this long (it cannot re-test itself while the theme is off). */
export const UNREADABLE_TTL_MS = 24 * 3600 * 1000;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const has = (obj, key) => isPlain(obj) && Object.hasOwn(obj, key);

/** Stored settings over the defaults. Junk is dropped field by field; `calm` keeps only what the user actually stored, so a
 *  theme's own calm defaults (Minimal hides Shorts) still apply until the user decides. */
export function normalizeSettings(raw) {
  const out = { ...DEFAULT_SETTINGS, calm: {} };
  if (!isPlain(raw)) return out;
  if (typeof raw.themeId === 'string') out.themeId = raw.themeId;
  if (raw.accent === null || typeof raw.accent === 'string') out.accent = raw.accent;
  if (raw.density === null || (Number.isInteger(raw.density) && raw.density >= 1 && raw.density <= 5)) out.density = raw.density;
  if (typeof raw.animations === 'boolean') out.animations = raw.animations;
  if (raw.textScale === null || (typeof raw.textScale === 'number' && [0.9, 1, 1.1, 1.25, 1.5].includes(raw.textScale))) out.textScale = raw.textScale;
  if (typeof raw.telemetryOptIn === 'boolean') out.telemetryOptIn = raw.telemetryOptIn;
  if (isPlain(raw.calm)) for (const key of CALM_KEYS) if (typeof raw.calm[key] === 'boolean') out.calm[key] = raw.calm[key];
  return out;
}

/** The <html> attributes the stylesheet depends on, as the first-paint cache stores them (names lower case, like the DOM reports them).
 *  cd-theme comes from the cache key and cd-page from the URL; cd-off-* is the health verdict and is re-derived after the settle time. */
function paintAttrs(cfg) {
  const attrs = {
    [ATTR.home]: cfg.home, [ATTR.watch]: cfg.watch, [ATTR.density]: String(cfg.density), [ATTR.motion]: cfg.animations ? 'on' : 'off',
  };
  if (cfg.textScale !== null && cfg.textScale !== undefined) attrs[ATTR.textScale] = String(cfg.textScale);
  for (const key of CALM_KEYS) if (cfg.calm[key] === true && !cfg.disabled.includes(`calm-${key}`)) attrs[(ATTR.calmPrefix + key).toLowerCase()] = '';
  return attrs;
}

/**
 * The stored health verdict, validated field by field (anything else in storage is junk and means "no verdict").
 * Shape: {mapVersion, themeId, broken:[feature], pages:{<pageType>:[feature]}, unreadable?:true, at:ms}.
 */
export const normalizeVerdict = sanitizePaintVerdict;

/** FNV-1a: a short fingerprint of the stylesheet (and the attributes that go with it) for the first-paint key. */
function fingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
}

/**
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {Window} [deps.win]            default doc.defaultView
 * @param {object} deps.chrome           chrome (storage.local + onChanged, runtime.onMessage)
 * @param {Location} [deps.loc]          default win.location
 * @param {() => number} [deps.now]
 * @param {object[]} deps.themes         validated themes (THEMES)
 * @param {{payload:string,sig:string,kid:string}} deps.bundledEnvelope  the signed map shipped in the package
 * @param {{selectorMap?:object, licence?:object}} [deps.publicKeys]
 * Test seams: compose (default composeStylesheet), createHealth, healthTimeoutMs (health settle time), readability (false turns the
 * health check's readability sentinel off; a function replaces its measuring).
 */
export function createEngine(deps = {}) {
  const { doc, chrome, themes, bundledEnvelope } = deps;
  const win = deps.win || (doc && doc.defaultView);
  if (!doc || !win) throw new TypeError('createEngine({doc, win}) needs a document and a window');
  if (!chrome || !chrome.storage || !chrome.storage.local) throw new TypeError('createEngine({chrome}) needs chrome.storage.local');
  if (!Array.isArray(themes) || !themes.length) throw new TypeError('createEngine({themes}) needs the theme list');
  const loc = deps.loc || win.location;
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now();
  const keys = { selectorMap: SELECTOR_MAP_PUBLIC_KEY, licence: LICENCE_PUBLIC_KEY, ...(deps.publicKeys || {}) };
  const compose = typeof deps.compose === 'function' ? deps.compose : composeStylesheet;
  const makeHealth = typeof deps.createHealth === 'function' ? deps.createHealth : createHealth;
  const settleMs = Number.isFinite(deps.healthTimeoutMs) ? deps.healthTimeoutMs : undefined;
  const readabilitySeam = deps.readability === undefined ? true : deps.readability;

  /** The running instance, or null. Every callback captures its own `s` and ignores itself once `st !== s`. */
  let st = null;

  // ---- small helpers ---------------------------------------------------------------------------------------------------

  const root = () => doc.documentElement;
  const alive = () => {
    try { return !chrome.runtime || typeof chrome.runtime.id === 'string'; } catch { return false; }
  };

  function frame(fn) {
    if (typeof win.requestAnimationFrame === 'function') return win.requestAnimationFrame(fn);
    queueMicrotask(fn);
    return null;
  }

  function setAttr(name, value) {
    const el = root();
    if (el && el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  function flagAttr(name, on) {
    const el = root();
    if (!el) return;
    if (on && !el.hasAttribute(name)) el.setAttribute(name, '');
    else if (!on && el.hasAttribute(name)) el.removeAttribute(name);
  }

  function reducedMotion() {
    try { return !!(win.matchMedia && win.matchMedia(REDUCED_MOTION).matches); } catch { return false; }
  }

  /**
   * The entitlement the page runs on. Until the token's signature has been checked (a few milliseconds after load) the stored
   * record is trusted so a paying user's first paint is not a free one. After that the plan, subscriber, issue and expiry time come
   * from the VERIFIED token only: the record's own copy of the claims is editable, so a copy that disagrees with the signed one, a token
   * that fails, or a token past its signed exp is lapsed (free), the same answer the worker and the popup give.
   */
  function effectiveLicence(s) {
    const record = s.licenceRecord;
    const token = record && record.token;
    const verdict = typeof token === 'string' ? s.verified.get(token) : undefined;
    if (verdict === false) return LAPSED;
    if (verdict && verdict.claims) {
      if (!claimsMatch(record.claims, verdict.claims)) return LAPSED;
      return toLicenceState({ ...record, claims: verdict.claims }, now());
    }
    return toLicenceState(record, now());
  }

  // ---- fail-open and teardown ------------------------------------------------------------------------------------------

  function guarded(s, fn) {
    try { fn(); } catch (err) { failOpen(s, err); }
  }

  function failOpen(s, err) {
    if (!s || s.failed) return;
    s.failed = true;
    try { console.warn('[Cinedrape] turned off, YouTube keeps its default look:', err && err.message ? err.message : err); } catch { /* no console */ }
    detachWork(s);
    cleanupDom(s);
    s.injector.clearFirstPaint();
  }

  /** Listeners and observers that do work. The message listener stays so a failed engine still answers GET_STATUS. */
  function detachWork(s) {
    s.stopped = true;
    for (const off of s.cleanups.splice(0)) { try { off(); } catch { /* already detached */ } }
    stopMountWatch(s);
    stopWatchLiveWatch(s);
    if (s.disposeWatch) { try { s.disposeWatch(); } catch { /* ignore */ } s.disposeWatch = null; }
    if (s.handle !== null && typeof win.cancelAnimationFrame === 'function') { try { win.cancelAnimationFrame(s.handle); } catch { /* ignore */ } }
    s.handle = null;
    s.pending = false;
  }

  /** Removes every trace of the engine from the page. */
  function cleanupDom(s) {
    if (s.layout) { try { s.layout.unmount(); } catch { /* ignore */ } s.layout = null; }
    for (const el of s.notices.splice(0)) { try { el.remove(); } catch { /* ignore */ } }
    try { s.injector.remove(); } catch { /* ignore */ }
    const el = root();
    if (el) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name;
        if (name === ATTR.theme || name === ATTR.page || name === ATTR.home || name === ATTR.watch || name === ATTR.watchLive || name === ATTR.density
          || name === ATTR.motion || name === ATTR.textScale || name.startsWith(ATTR.calmPrefix) || name.startsWith(ATTR.offPrefix)) el.removeAttribute(name);
      }
    }
  }

  /** The extension was reloaded or removed under this script: stop working, but leave the page to the new script. */
  function orphan(s) {
    detachWork(s);
    s.failed = true;
    if (st === s) st = null;
  }

  // ---- scheduling ------------------------------------------------------------------------------------------------------

  function schedule(s) {
    if (st !== s || s.stopped || s.pending) return;
    s.pending = true;
    s.handle = frame(() => {
      if (st !== s || s.stopped) return;
      s.pending = false;
      s.handle = null;
      if (!alive()) { orphan(s); return; }
      if (s.loaded) guarded(s, () => applyAll(s));
    });
  }

  // ---- the pipeline ----------------------------------------------------------------------------------------------------

  function wantedFeatures(s, cfg) {
    const list = ['theme'];
    if (cfg.home !== 'grid') list.push('layout-home');
    if (cfg.watch !== 'default') list.push('layout-watch');
    if (cfg.pro && Number.isInteger(s.settings.density)) list.push('density');
    for (const key of CALM_KEYS) if (cfg.calm[key]) list.push(`calm-${key}`);
    return list;
  }

  function applyAll(s) {
    const cfg = computeEffectiveConfig({ settings: s.settings, licenceState: effectiveLicence(s), themes, disabled: [...s.disabled] });
    if (!cfg.theme) throw new Error('no usable theme');
    if (reducedMotion()) cfg.animations = false;
    s.cfg = cfg;
    s.pageType = detectPageType(doc, loc);
    const { css, warnings } = compose({ map: s.map, cfg });
    if (typeof css !== 'string') throw new TypeError('compose() returned no stylesheet');
    s.warnings = warnings || [];

    s.injector.apply(css);
    setAttr(ATTR.theme, cfg.theme.id);
    setAttr(ATTR.page, s.pageType);
    setAttr(ATTR.home, cfg.home);
    setAttr(ATTR.watch, cfg.watch);
    setAttr(ATTR.density, String(cfg.density));
    setAttr(ATTR.motion, cfg.animations ? 'on' : 'off');
    if (cfg.textScale !== null && cfg.textScale !== undefined) setAttr(ATTR.textScale, String(cfg.textScale));
    else { const el = root(); if (el) el.removeAttribute(ATTR.textScale); }
    applyCalmAttributes(doc, cfg.calm, cfg.disabled);
    for (const feature of FEATURES) flagAttr(ATTR.offPrefix + feature, cfg.disabled.includes(feature));
    syncWatchLive(s);

    if (css === '') {
      s.injector.clearFirstPaint();
      s.paintedKey = '';
    } else {
      const attrs = paintAttrs(cfg);
      const key = `${cfg.theme.id}:${fingerprint(css + '\n' + JSON.stringify(attrs))}`;
      if (key !== s.paintedKey) s.paintedKey = s.injector.writeFirstPaint(key, css, attrs, s.verdict) ? key : '';
    }

    // Health first: watch() forgets what layouts recorded, so a layout that fails during this pass must report after it.
    syncHealth(s);
    syncLayout(s);
  }

  // ---- home layout -----------------------------------------------------------------------------------------------------

  const wantsLayout = (s) => !!s.cfg && s.pageType === 'home' && s.cfg.home !== 'grid' && !s.disabled.has('layout-home');

  function ensureLayout(s) {
    if (!s.layout) {
      s.layout = createHomeLayout({
        doc, win, selectors: s.selectors, map: s.map, getConfig: () => s.cfg, onFail: (reason) => layoutFailed(s, reason),
      });
    }
    return s.layout;
  }

  function syncLayout(s) {
    if (!wantsLayout(s)) {
      stopMountWatch(s);
      if (s.layout) s.layout.unmount();
      return;
    }
    const layout = ensureLayout(s);
    if (layout.isMounted()) {
      layout.update();
      stopMountWatch(s);
    } else if (layout.mount()) {
      stopMountWatch(s);
    } else if (wantsLayout(s)) {
      startMountWatch(s);
    }
  }

  /** The grid and its tiles arrive after document_start: retry (once per frame) while the page changes, until it mounts. */
  function startMountWatch(s) {
    const Observer = win.MutationObserver;
    if (s.mountObserver || !Observer || !root()) return;
    s.mountObserver = new Observer(() => {
      if (s.mountPending) return;
      s.mountPending = true;
      frame(() => {
        s.mountPending = false;
        if (st !== s || s.stopped) return;
        guarded(s, () => {
          if (!wantsLayout(s)) { stopMountWatch(s); return; }
          const layout = ensureLayout(s);
          if (layout.isMounted() || layout.mount()) stopMountWatch(s);
        });
      });
    });
    s.mountObserver.observe(root(), { childList: true, subtree: true });
  }

  function stopMountWatch(s) {
    if (s.mountObserver) { s.mountObserver.disconnect(); s.mountObserver = null; }
  }

  function stopWatchLiveWatch(s) {
    if (s.watchLiveObserver) { s.watchLiveObserver.disconnect(); s.watchLiveObserver = null; }
  }

  function startWatchLiveWatch(s) {
    const Observer = win.MutationObserver;
    if (s.watchLiveObserver || !Observer || s.pageType !== 'watch') return;
    const target = doc.querySelector('ytd-watch-flexy') || root();
    if (!target) return;
    s.watchLiveObserver = new Observer(() => {
      if (st !== s || s.stopped || s.pageType !== 'watch') {
        stopWatchLiveWatch(s);
        return;
      }
      const live = isWatchLive(doc, s.selectors);
      if (live) {
        flagAttr(ATTR.watchLive, true);
        stopWatchLiveWatch(s);
      } else if (hasWatchMetadata(doc, s.selectors)) {
        stopWatchLiveWatch(s);
      }
    });
    s.watchLiveObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }

  function syncWatchLive(s) {
    if (s.pageType !== 'watch') {
      stopWatchLiveWatch(s);
      flagAttr(ATTR.watchLive, false);
      return;
    }
    const isLive = isWatchLive(doc, s.selectors);
    flagAttr(ATTR.watchLive, isLive);
    if (!isLive && !hasWatchMetadata(doc, s.selectors)) {
      startWatchLiveWatch(s);
    } else {
      stopWatchLiveWatch(s);
    }
  }

  function layoutFailed(s, reason) {
    void reason;
    if (st !== s || s.failed) return;
    const missing = LAYOUT_ROLES.filter((role) => !s.selectors.has(role));
    s.health.record('layout-home', missing);
    if (!s.disabled.has('layout-home')) setDisabled(s, new Set([...s.disabled, 'layout-home']));
  }

  // ---- health ----------------------------------------------------------------------------------------------------------

  function syncHealth(s) {
    const pageType = s.pageType;
    const features = wantedFeatures(s, s.cfg);
    const key = `${pageType}|${features.join(',')}|${s.map.mapVersion}|${s.cfg.theme.id}`;
    if (key === s.watchKey && !s.navDirty) return;
    s.watchKey = key;
    s.navDirty = false;
    if (s.disposeWatch) s.disposeWatch();
    s.disposeWatch = s.health.watch(pageType, features, settleMs === undefined ? undefined : { timeoutMs: settleMs });
  }

  function onHealth(s, result) {
    if (st !== s || s.stopped || s.failed) return;
    const broken = Array.isArray(result && result.broken) ? result.broken : [];
    const next = new Set(broken.map((b) => b && b.feature).filter((f) => FEATURES.includes(f)));
    s.missing = [...new Set(broken.flatMap((b) => (b && Array.isArray(b.missingRoles) ? b.missingRoles : [])))].sort();
    setDisabled(s, next);
  }

  /** A page finished settling: the picture is final for this page. Say what is paused (once per feature per tab session) and remember it. */
  function onSettled(s, result) {
    if (st !== s || s.stopped || s.failed) return;
    onHealth(s, result);
    const features = [...s.disabled];
    if (features.length) {
      try {
        const el = showNotice(doc, { features });
        if (el && !s.notices.includes(el)) s.notices.push(el);
      } catch { /* the notice is a courtesy */ }
    }
    persistVerdict(s, features);
  }

  /** The verdict kept for the next page load: per page type, plus the readability flag. A healthy settle clears its page type. */
  function persistVerdict(s, features) {
    if (!s.cfg || !s.map) return;
    const mapVersion = s.map.mapVersion;
    const themeId = s.cfg.theme.id;
    const unreadable = !!(s.health && typeof s.health.isUnreadable === 'function' && s.health.isUnreadable());
    const prev = s.verdict && s.verdict.mapVersion === mapVersion ? s.verdict : null;
    const pages = { ...(prev ? prev.pages : {}) };
    if (features.length) pages[s.pageType] = [...features].sort();
    else delete pages[s.pageType];
    const broken = [...new Set(Object.values(pages).flat())];
    if (unreadable && !broken.includes('theme')) broken.push('theme');
    broken.sort();
    let next = null;
    if (broken.length) {
      const keepsClock = !!prev && prev.unreadable && unreadable && prev.themeId === themeId;
      next = { mapVersion, themeId, broken, pages, unreadable, at: keepsClock ? prev.at : now() };
    }
    const sameVerdict = (a, b) => a.mapVersion === b.mapVersion && a.themeId === b.themeId && a.unreadable === b.unreadable
      && JSON.stringify(a.broken) === JSON.stringify(b.broken) && JSON.stringify(a.pages) === JSON.stringify(b.pages);
    if (next === null ? s.verdict === null : (s.verdict !== null && sameVerdict(next, s.verdict))) return;
    s.verdict = next;
    try {
      const area = chrome.storage.local;
      const done = next === null ? area.remove(STORAGE_KEYS.health) : area.set({ [STORAGE_KEYS.health]: next });
      if (done && typeof done.catch === 'function') done.catch(() => {});
    } catch { /* storage unavailable: the verdict is only an optimisation */ }
    s.injector.writeFirstPaintVerdict(next);
  }

  /**
   * The disabled set to start from: what the last settle of this page type said, for the same selector map. A readability verdict is
   * also bound to its theme and expires after a day (it cannot re-test itself while the theme is off). Seeds the health check so
   * a standing readability verdict is not mistaken for a healed page at the first settle.
   */
  function initialDisabled(s, verdict) {
    if (!verdict || verdict.mapVersion !== s.map.mapVersion) return new Set();
    const cfg = computeEffectiveConfig({ settings: s.settings, licenceState: effectiveLicence(s), themes, disabled: [] });
    const themeId = cfg.theme ? cfg.theme.id : null;
    const list = Object.hasOwn(verdict.pages, s.pageType) ? verdict.pages[s.pageType] : verdict.broken;
    const out = new Set(list);
    const readableAgain = verdict.unreadable && (verdict.themeId !== themeId || now() - verdict.at > UNREADABLE_TTL_MS || now() < verdict.at);
    if (verdict.unreadable && !readableAgain) {
      out.add('theme');
      if (s.health && typeof s.health.seedUnreadable === 'function') s.health.seedUnreadable({ themeId: verdict.themeId, mapVersion: verdict.mapVersion });
    } else if (verdict.unreadable) {
      out.delete('theme');
    }
    return out;
  }

  function setDisabled(s, next) {
    const added = [...next].filter((f) => !s.disabled.has(f));
    const removed = [...s.disabled].filter((f) => !next.has(f));
    if (!added.length && !removed.length) return;
    s.disabled = next;
    if (next.has('layout-home') && s.layout) s.layout.unmount();
    schedule(s);
    if (removed.length) {
      // A feature that came back is no longer "turned off": the notice that said so must not outlive the problem.
      try { retireNotice(doc, removed); } catch { /* the notice is a courtesy */ }
    }
    if (added.length) {
      try {
        const el = showNotice(doc, { features: added });
        if (el && !s.notices.includes(el)) s.notices.push(el);
      } catch { /* the notice is a courtesy */ }
    }
    try {
      const sent = chrome.runtime.sendMessage({ type: MSG.STATUS_CHANGED });
      if (sent && typeof sent.catch === 'function') sent.catch(() => {});
    } catch { /* nobody is listening (popup closed) */ }
  }

  // ---- licence and selector map ----------------------------------------------------------------------------------------

  function setLicenceRecord(s, record) {
    s.licenceRecord = isPlain(record) ? record : null;
  }

  function verifyLicence(s) {
    const token = s.licenceRecord && s.licenceRecord.token;
    if (typeof token !== 'string' || toLicenceState(s.licenceRecord, now()).plan !== 'pro' || s.verified.has(token)) return;
    s.verified.set(token, null);
    // Remembered per token: false, or the claims the SIGNATURE vouches for (effectiveLicence() reads them, never the record's).
    const done = (verdict) => {
      s.verified.set(token, verdict);
      schedule(s);
    };
    verifyLicenceToken(token, now(), keys.licence).then(
      (r) => done(r && r.valid === true && isPlain(r.claims) ? { claims: r.claims } : false),
      () => done(false),
    );
  }

  /** The cached map when it is signed by our key AND newer than the bundled one; null otherwise. */
  async function evaluateMap(s, envelope) {
    if (!isPlain(envelope)) return null;
    const verdict = await verifyEnvelope(envelope, keys.selectorMap);
    if (!verdict.ok) return null;
    const map = parseEnvelopePayload(envelope);
    if (!map) return null;
    return compareMapVersions(map.mapVersion, s.bundledMap.mapVersion) > 0 ? map : null;
  }

  function useMap(s, map) {
    const next = map || s.bundledMap;
    if (next === s.map) return false;
    s.map = next;
    s.selectors.setMap(next);
    if (s.layout) { s.layout.unmount(); s.layout = null; }
    s.watchKey = '';
    return true;
  }

  // ---- events ----------------------------------------------------------------------------------------------------------

  function onStorage(s, changes, area) {
    if (st !== s || s.stopped || (area && area !== 'local') || !isPlain(changes)) return;
    guarded(s, () => {
      if (!alive()) { orphan(s); return; }
      let changed = false;
      if (has(changes, STORAGE_KEYS.settings)) {
        s.settings = normalizeSettings(changes[STORAGE_KEYS.settings].newValue);
        s.touched.add('settings');
        changed = true;
      }
      if (has(changes, STORAGE_KEYS.licence)) {
        setLicenceRecord(s, changes[STORAGE_KEYS.licence].newValue);
        verifyLicence(s);
        s.touched.add('licence');
        changed = true;
      }
      if (has(changes, STORAGE_KEYS.selectorMap)) {
        const seq = ++s.mapSeq;
        evaluateMap(s, changes[STORAGE_KEYS.selectorMap].newValue).then((map) => {
          if (st === s && !s.stopped && seq === s.mapSeq && useMap(s, map)) schedule(s);
        }, () => {});
      }
      if (changed) schedule(s);
    });
  }

  function onMessage(s, message, sender, sendResponse) {
    void sender;
    if (!message || message.type !== MSG.GET_STATUS) return false;
    const reply = () => { try { sendResponse(getStatus()); } catch { /* the asker went away */ } };
    if (s.loaded || s.failed || s.stopped) { reply(); return false; }
    s.ready.then(reply, reply);
    return true;
  }

  // ---- public API ------------------------------------------------------------------------------------------------------

  function createState() {
    return {
      stopped: false, failed: false, loaded: false, pending: false, handle: null,
      injector: createStyleInjector({ doc, win }),
      settings: normalizeSettings(null), licenceRecord: null, verified: new Map(), verdict: null,
      bundledMap: null, map: null, selectors: null, health: null, layout: null,
      cfg: null, pageType: 'other', disabled: new Set(), missing: [], warnings: [],
      paintedKey: '', watchKey: '', navDirty: false, disposeWatch: null,
      mountObserver: null, mountPending: false, watchLiveObserver: null, notices: [], cleanups: [],
      touched: new Set(), mapSeq: 0, ready: Promise.resolve(),
    };
  }

  function listen(s) {
    const onChanged = (changes, area) => onStorage(s, changes, area);
    chrome.storage.onChanged.addListener(onChanged);
    s.cleanups.push(() => chrome.storage.onChanged.removeListener(onChanged));

    const dispose = observeNavigation(win, doc, () => { s.navDirty = true; schedule(s); });
    s.cleanups.push(dispose);

    let mql = null;
    try { mql = win.matchMedia ? win.matchMedia(REDUCED_MOTION) : null; } catch { mql = null; }
    if (mql) {
      const onChange = () => schedule(s);
      if (typeof mql.addEventListener === 'function') {
        mql.addEventListener('change', onChange);
        s.cleanups.push(() => mql.removeEventListener('change', onChange));
      } else if (typeof mql.addListener === 'function') {
        mql.addListener(onChange);
        s.cleanups.push(() => mql.removeListener(onChange));
      }
    }

    if (chrome.runtime && chrome.runtime.onMessage) {
      const handler = (message, sender, sendResponse) => onMessage(s, message, sender, sendResponse);
      chrome.runtime.onMessage.addListener(handler);
      s.dropMessages = () => chrome.runtime.onMessage.removeListener(handler);
    }
  }

  async function load(s) {
    let got = {};
    try {
      got = (await chrome.storage.local.get([STORAGE_KEYS.settings, STORAGE_KEYS.licence, STORAGE_KEYS.selectorMap, STORAGE_KEYS.health])) || {};
    } catch { got = {}; }
    if (st !== s || s.stopped) return;
    if (!s.touched.has('settings')) s.settings = normalizeSettings(got[STORAGE_KEYS.settings]);
    if (!s.touched.has('licence')) setLicenceRecord(s, got[STORAGE_KEYS.licence]);
    if (got[STORAGE_KEYS.selectorMap] !== undefined) {
      const seq = s.mapSeq;
      const map = await evaluateMap(s, got[STORAGE_KEYS.selectorMap]);
      if (st !== s || s.stopped) return;
      if (seq === s.mapSeq) useMap(s, map);
    }
    const storageVerdict = normalizeVerdict(got[STORAGE_KEYS.health]);
    if (storageVerdict !== null) {
      s.verdict = storageVerdict;
      s.disabled = initialDisabled(s, s.verdict);
      s.injector.writeFirstPaintVerdict(storageVerdict);
    } else if (!s.verdict) {
      s.verdict = null;
    }
    s.pageType = detectPageType(doc, loc);
    s.loaded = true;
    applyAll(s);
    verifyLicence(s);
  }

  /** Applies the first-paint cache synchronously, then loads state. Resolves once the first full pass is done. */
  function start() {
    if (st) {
      if (!st.failed) return st.ready;
      if (st.dropMessages) st.dropMessages();
    }
    const s = createState();
    st = s;
    try {
      s.bundledMap = parseEnvelopePayload(bundledEnvelope);
      if (!s.bundledMap) throw new Error('the bundled selector map is unreadable');
      s.map = s.bundledMap;
      s.selectors = createSelectors(s.map, doc);
      s.health = makeHealth({
        doc, selectors: s.selectors, map: s.map, readability: readabilitySeam, onChange: (result) => onHealth(s, result), onSettled: (result) => onSettled(s, result),
      });
      s.pageType = detectPageType(doc, loc);
      setAttr(ATTR.page, s.pageType);

      const painted = s.injector.readFirstPaint();
      const themeId = painted ? painted.key.split(':')[0] : '';
      if (painted && ALL_THEME_IDS.includes(themeId)) {
        // If the first-paint entry carries a verdict, seed s.verdict and s.disabled synchronously
        // so broken features never flash on before chrome.storage answers or health settles.
        if (painted.verdict) {
          s.verdict = painted.verdict;
          s.disabled = initialDisabled(s, painted.verdict);
        }
        const themeDisabled = s.disabled.has('theme');
        if (!themeDisabled) {
          s.injector.apply(painted.css);
          setAttr(ATTR.theme, themeId);
          s.paintedKey = painted.key;
        }
        for (const feature of s.disabled) flagAttr(ATTR.offPrefix + feature, true);
        if (painted.attrs) {
          for (const [name, value] of Object.entries(painted.attrs)) {
            if (name === ATTR.home && s.disabled.has('layout-home')) { setAttr(ATTR.home, 'grid'); continue; }
            if (name === ATTR.watch && s.disabled.has('layout-watch')) { setAttr(ATTR.watch, 'default'); continue; }
            if (name === ATTR.density && s.disabled.has('density')) continue;
            if (name.startsWith(ATTR.calmPrefix)) {
              const calmKey = name.slice(ATTR.calmPrefix.length);
              const matched = CALM_KEYS.find((k) => k.toLowerCase() === calmKey);
              if (matched && s.disabled.has(`calm-${matched}`)) continue;
            }
            setAttr(name, value);
          }
        }
      }
      listen(s);
    } catch (err) {
      failOpen(s, err);
      return s.ready;
    }
    s.ready = load(s).catch((err) => failOpen(s, err));
    return s.ready;
  }

  function stop() {
    const s = st;
    if (!s) return;
    st = null;
    detachWork(s);
    if (s.dropMessages) { try { s.dropMessages(); } catch { /* ignore */ } s.dropMessages = null; }
    cleanupDom(s);
    s.injector.clearFirstPaint();
  }

  function recompute() {
    const s = st;
    if (!s || s.failed || s.stopped) return Promise.resolve();
    return s.ready.then(() => {
      if (st !== s || s.stopped || s.failed) return;
      s.navDirty = true;
      guarded(s, () => applyAll(s));
    });
  }

  function featureState(s, id, lic) {
    const cfg = s.cfg;
    if (!isFeatureAllowed(id, lic)) return 'locked';
    if (s.disabled.has(id)) return 'broken';
    if (!cfg) return 'off';
    if (id === 'theme') return 'on';
    if (id === 'layout-home') return cfg.home !== 'grid' ? 'on' : 'off';
    if (id === 'layout-watch') return cfg.watch !== 'default' ? 'on' : 'off';
    if (id === 'density') return cfg.pro && Number.isInteger(s.settings.density) ? 'on' : 'off';
    return cfg.calm[id.slice('calm-'.length)] ? 'on' : 'off';
  }

  function getStatus() {
    const s = st;
    const features = {};
    if (!s || s.failed) {
      for (const id of FEATURES) features[id] = 'off';
      return { themeId: null, pageType: s ? s.pageType : 'other', pro: false, features, missingRoles: [], mapVersion: s && s.map ? s.map.mapVersion : null, liveCount: null };
    }
    if (!s.cfg) {
      for (const id of FEATURES) features[id] = s.disabled.has(id) ? 'broken' : 'off';
      return { themeId: null, pageType: s.pageType, pro: false, features, missingRoles: [...s.missing], mapVersion: s.map ? s.map.mapVersion : null, liveCount: null };
    }
    const lic = effectiveLicence(s);
    for (const id of FEATURES) features[id] = featureState(s, id, lic);
    const liveCount = s.layout && typeof s.layout.isMounted === 'function' && s.layout.isMounted() && typeof s.layout.getLiveCount === 'function'
      ? s.layout.getLiveCount()
      : null;
    return { themeId: s.cfg.theme.id, pageType: s.pageType, pro: s.cfg.pro, features, missingRoles: [...s.missing], mapVersion: s.map.mapVersion, liveCount };
  }

  return { start, stop, getStatus, recompute };
}
