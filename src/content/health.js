// Breakage detection (ARCHITECTURE.md section 4, spec feature F6).
//
// A feature is broken when a role it `requires` is missing on the current page (map.requires[feature] intersected with
// map.pageRoles[pageType]). evaluate() is the instant snapshot. watch() is the real check: roles legitimately appear late,
// so it only reports what is still missing after `timeoutMs`, and it counts that time only while the tab is visible.
//
// A role can all be present and the page still unreadable (YouTube renamed a colour variable: the theme's colours miss and every
// title lands at 1.1:1; seen in the real browser). So after the settle time a small readability sentinel samples the computed text
// colour of a few stable nodes against their effective background and, when the themed page is unreadable, reports the `theme`
// feature as broken (the engine then fails open to YouTube's own look). The verdict is sticky while the theme is switched off
// (nothing can be measured then) and is dropped when the theme or the selector map changes.
//
// Privacy: counters hold role names from the map (a closed vocabulary) and the theme id, nothing else. Every string that
// comes from a caller is checked against that vocabulary before it is stored. This module has no network access of any kind;
// the counters are only handed to whoever calls counters().
import { ALL_THEME_IDS, ATTR, FEATURES } from '../shared/constants.js';
import { contrastRatio, parseColor } from '../shared/contrast.js';

const DEFAULT_TIMEOUT_MS = 6000;
const MAX_TIMEOUT_MS = 120000;
// DOM changes are looked at at most this often. The deadline check is authoritative, so this only decides how soon a page whose
// roles all arrived is declared healthy; it keeps the cost of a busy YouTube page (thousands of mutations) at a few lookups per second.
const RECHECK_MS = 250;
const THEME_IDS = new Set(ALL_THEME_IDS); // a closed list: whatever a page script writes into cd-theme can never reach the counters
// Attributes whose change can make a role start matching without any node being added (ytd-browse is reused across pages).
const WATCHED_ATTRS = ['page-subtype', 'is-watch-page', 'video-id'];
const KNOWN_FEATURES = new Set(FEATURES);

/** Below this contrast (WCAG large-text level, far under any Cinedrape theme's own 4.5:1) text counts as unreadable. */
export const READABLE_MIN_RATIO = 3;
const SAMPLES_NEEDED = 2;           // fewer samples than this and nothing is judged (a page that has not rendered is not "unreadable")
const SENTINEL_RETRY_MS = 3000;     // not enough samples yet: look again, a few times
const SENTINEL_RETRIES = 3;
const SENTINEL_CONFIRM_MS = 2500;   // a bad reading must be seen twice, this far apart
const SEARCH_INPUT = 'input[name="search_query"], input#search';
const OWN_TITLES = '.cd-card-title, .cd-hero-title';
const MAX_TITLE_CANDIDATES = 24;
const WHITE = { r: 255, g: 255, b: 255, a: 1 };

const hasOwn = Object.prototype.hasOwnProperty;
const own = (obj, key) => (obj !== null && typeof obj === 'object' && hasOwn.call(obj, key) ? obj[key] : undefined);
const strings = (list) => (Array.isArray(list) ? [...new Set(list.filter((x) => typeof x === 'string'))] : []);
const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];

function normaliseTimeout(value) {
  const n = Number(value);
  if (value === undefined || value === null || !Number.isFinite(n) || n < 0) return DEFAULT_TIMEOUT_MS;
  return Math.min(n, MAX_TIMEOUT_MS);
}

const toResult = (broken) => ({ ok: broken.length === 0, broken });
const signature = (result) => JSON.stringify(result.broken.map((b) => [b.feature, b.missingRoles]).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0)));

// ---- readability sentinel ----------------------------------------------------------------------------------------------

/** Real layout exists (a browser); jsdom reports every rect as 0, where sizes must not decide visibility. */
function hasLayout(doc) {
  try {
    const r = doc.documentElement.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  } catch {
    return false;
  }
}

/** Shown on the page: no ancestor is display:none, hidden or visibility:hidden, and (with layout) it has a box. */
function isShown(win, el, layout) {
  try {
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      if (n.hasAttribute('hidden')) return false;
      const cs = win.getComputedStyle(n);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') return false;
    }
    if (layout) {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * The colour a node's text sits on: translucent layers composited from the first opaque ancestor up, the page canvas (white)
 * when none is opaque. null = cannot be judged: a background image anywhere on the way, or a colour syntax we do not read.
 */
function backdropOf(win, el) {
  const layers = [];
  let base = WHITE;
  for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
    const cs = win.getComputedStyle(n);
    const image = cs.backgroundImage;
    if (image && image !== 'none') return null;
    const raw = cs.backgroundColor;
    if (!raw || raw === 'transparent') continue;
    const c = parseColor(raw);
    if (!c) return null;
    if (c.a === 0) continue;
    if (c.a >= 1) { base = c; break; }
    layers.push(raw);
  }
  let under = base;
  for (let i = layers.length - 1; i >= 0; i--) {
    const flat = parseColor(layers[i], under);
    if (!flat) return null;
    under = flat;
  }
  return under;
}

/**
 * Samples up to five stable text nodes (the masthead search box, two tile titles or Cinedrape's own cards, the watch title on a
 * watch page) and measures their text colour against the effective background. Nodes whose colours cannot be read (an unresolved
 * var(), a colour space we do not parse, a background image) are skipped, never counted as readable or unreadable.
 * @param {{doc: Document, selectors?: object, pageType?: string, win?: Window}} p
 * @returns {{checked: number, low: {id: string, ratio: number}[], samples: {id: string, ratio: number}[]}}
 */
export function measureReadability({ doc, selectors, pageType, win } = {}) {
  const out = { checked: 0, low: [], samples: [] };
  const w = win || (doc && doc.defaultView);
  if (!doc || !w || typeof w.getComputedStyle !== 'function') return out;
  const layout = hasLayout(doc);
  const targets = [];
  const take = (id, el) => { if (el && !targets.some((x) => x.el === el)) targets.push({ id, el }); };
  const firstShown = (list, n = 1) => {
    const hits = [];
    for (const el of Array.from(list || []).slice(0, MAX_TITLE_CANDIDATES)) {
      if (!el.textContent || !el.textContent.trim()) continue;
      if (isShown(w, el, layout)) hits.push(el);
      if (hits.length >= n) break;
    }
    return hits;
  };
  try {
    const inputs = [...doc.querySelectorAll(SEARCH_INPUT)].filter((el) => isShown(w, el, layout));
    take('search', inputs[0]);
    let titles = [];
    try { titles = selectors && typeof selectors.findAll === 'function' ? selectors.findAll('tileTitle') : []; } catch { titles = []; }
    for (const el of firstShown(titles, 2)) take('tile', el);
    for (const el of firstShown(doc.querySelectorAll(OWN_TITLES), 1)) take('card', el);
    if (pageType === 'watch') {
      let titleEl = null;
      try { titleEl = selectors && typeof selectors.find === 'function' ? selectors.find('watchTitle') : null; } catch { titleEl = null; }
      if (titleEl && titleEl.textContent && titleEl.textContent.trim() && isShown(w, titleEl, layout)) take('watch', titleEl);
    }
  } catch {
    return out;
  }
  for (const { id, el } of targets.slice(0, 5)) {
    try {
      const text = parseColor(w.getComputedStyle(el).color);
      const back = backdropOf(w, el);
      if (!text || !back) continue;
      const ratio = contrastRatio(text, back);
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) continue;
      const row = { id, ratio: Math.round(ratio * 100) / 100 };
      out.samples.push(row);
      out.checked++;
      if (ratio < READABLE_MIN_RATIO) out.low.push(row);
    } catch { /* an unreadable node is not a sample */ }
  }
  return out;
}

/**
 * @param {object} deps
 * @param {Document} deps.doc
 * @param {{has:(role:string)=>boolean, map?:()=>object}} deps.selectors  its map() (when present) is the live map
 * @param {object} [deps.map]  used only when selectors.map() is unavailable
 * @param {(result:{ok:boolean,broken:{feature:string,missingRoles:string[]}[]})=>void} [deps.onChange]  the picture changed
 * @param {(result:{ok:boolean,broken:{feature:string,missingRoles:string[]}[]})=>void} [deps.onSettled]  a page finished settling
 *   (every time, changed or not); the engine persists the verdict and announces what is paused from it
 * @param {boolean|Function} [deps.readability]  false switches the sentinel off; a function replaces the measuring (tests)
 * @param {{setTimeout:Function,clearTimeout:Function}} [deps.timers]  injectable for tests, defaults to the document's window
 * @param {typeof MutationObserver} [deps.MutationObserver]
 */
export function createHealth({ doc, selectors, map, onChange, onSettled, readability = true, timers, MutationObserver: ObserverImpl } = {}) {
  if (!selectors || typeof selectors.has !== 'function') throw new TypeError('createHealth: selectors.has is required');

  const win = doc && doc.defaultView ? doc.defaultView : null;
  const clock = timers || {
    setTimeout: (fn, ms) => (win && win.setTimeout ? win.setTimeout(fn, ms) : setTimeout(fn, ms)),
    clearTimeout: (id) => (win && win.clearTimeout ? win.clearTimeout(id) : clearTimeout(id)),
  };
  const Observer = ObserverImpl || (win && win.MutationObserver) || globalThis.MutationObserver;

  const liveMap = () => {
    let fromSelectors = null;
    try {
      fromSelectors = typeof selectors.map === 'function' ? selectors.map() : null;
    } catch {
      fromSelectors = null;
    }
    if (fromSelectors && typeof fromSelectors === 'object') return fromSelectors;
    return map && typeof map === 'object' ? map : {};
  };
  const roleNames = () => {
    const roles = own(liveMap(), 'roles');
    return roles && typeof roles === 'object' ? new Set(Object.keys(roles)) : new Set();
  };

  /** Roles feature `f` needs on this page type: requires[f] intersected with pageRoles[pageType], in requires order. */
  function requiredOn(feature, pageType) {
    const m = liveMap();
    const required = own(own(m, 'requires'), feature);
    const expected = own(own(m, 'pageRoles'), pageType);
    if (!Array.isArray(required) || !Array.isArray(expected)) return [];
    const onPage = new Set(expected);
    return required.filter((role) => typeof role === 'string' && onPage.has(role));
  }

  const present = (role) => {
    try {
      return !!selectors.has(role);
    } catch {
      return false;
    }
  };

  /** Map feature -> roles that are missing right now (features with nothing missing are left out). */
  function missingNow(pageType, features) {
    const out = new Map();
    for (const feature of features) {
      const missing = requiredOn(feature, pageType).filter((role) => !present(role));
      if (missing.length) out.set(feature, missing);
    }
    return out;
  }

  // ---- state -----------------------------------------------------------------------------------------------------
  const state = {
    pageType: null,
    features: [],
    settled: new Map(), // feature -> roles still missing when the last watch() ran out of time
    recorded: new Map(), // feature -> roles a layout reported (mount failures); cleared by the next watch()
  };
  // Sticky "the themed page is unreadable" verdict: { themeId, mapVersion }. Applies only to that theme under that map.
  let unreadable = null;
  let sentinel = null;
  const counts = new Map(); // role -> number of page settles / reports in which it was missing
  const countedThisPage = new Set();
  let lastSignature = signature(toResult([]));
  let session = null;

  function bump(roles) {
    const known = roleNames();
    for (const role of roles) {
      if (!known.has(role) || countedThisPage.has(role)) continue;
      countedThisPage.add(role);
      counts.set(role, (counts.get(role) || 0) + 1);
    }
  }

  const unreadableApplies = () => !!unreadable && unreadable.themeId === themeId() && unreadable.mapVersion === own(liveMap(), 'mapVersion');

  function report() {
    const order = [...state.features];
    for (const feature of state.recorded.keys()) if (!order.includes(feature)) order.push(feature);
    const broken = [];
    for (const feature of order) {
      const settled = state.settled.get(feature);
      const recorded = state.recorded.get(feature);
      if (settled || recorded) broken.push({ feature, missingRoles: union(settled, recorded) });
    }
    if (unreadableApplies() && !broken.some((b) => b.feature === 'theme')) broken.push({ feature: 'theme', missingRoles: [] });
    return toResult(broken);
  }

  /** A page finished settling (or the sentinel passed judgement): hand the whole picture over, changed or not. */
  function settledNotice() {
    if (typeof onSettled !== 'function') return;
    try {
      onSettled(report());
    } catch (err) {
      if (win && typeof win.reportError === 'function') win.reportError(err);
    }
  }

  /** Tells onChange about the settled picture, but only when it differs from the last thing it was told. */
  function emit() {
    const result = report();
    const sig = signature(result);
    if (sig === lastSignature) return;
    lastSignature = sig; // before the call: a throwing handler must not be re-sent the same news
    if (typeof onChange !== 'function') return;
    try {
      onChange(result);
    } catch (err) {
      // record() runs inside layout code and the deadline runs inside a timer: a faulty listener must not break either.
      if (win && typeof win.reportError === 'function') win.reportError(err);
    }
  }

  // ---- public: evaluate ------------------------------------------------------------------------------------------
  function evaluate(pageType, activeFeatures) {
    const features = strings(activeFeatures);
    const missing = missingNow(pageType, features);
    const broken = [];
    for (const feature of features) {
      const roles = union(missing.get(feature), state.recorded.get(feature));
      if (missing.has(feature) || state.recorded.has(feature)) broken.push({ feature, missingRoles: roles });
    }
    if (unreadableApplies() && features.includes('theme') && !broken.some((b) => b.feature === 'theme')) broken.push({ feature: 'theme', missingRoles: [] });
    return toResult(broken);
  }

  // ---- public: watch ---------------------------------------------------------------------------------------------
  const isHidden = () => !!doc && doc.visibilityState === 'hidden';

  function teardown(s) {
    if (s.timer !== null) { clock.clearTimeout(s.timer); s.timer = null; }
    if (s.recheckTimer !== null) { clock.clearTimeout(s.recheckTimer); s.recheckTimer = null; }
    if (s.observer) { s.observer.disconnect(); s.observer = null; }
    if (s.onVisibility && doc) { doc.removeEventListener('visibilitychange', s.onVisibility); s.onVisibility = null; }
  }

  function endSession(s) {
    s.done = true;
    teardown(s);
    if (session === s) session = null;
  }

  function finalise(s) {
    if (s.done || session !== s) return;
    const missing = missingNow(state.pageType, state.features); // authoritative: look again at the deadline
    state.settled = missing;
    for (const roles of missing.values()) bump(roles);
    endSession(s);
    emit();
    settledNotice();
  }

  function recheck(s) {
    if (s.done || session !== s) return;
    const stillMissing = new Map();
    for (const [feature, roles] of s.pending) {
      const left = roles.filter((role) => !present(role));
      if (left.length) stillMissing.set(feature, left);
    }
    s.pending = stillMissing;
    if (stillMissing.size === 0) {
      state.settled = new Map(); // everything appeared in time
      endSession(s);
      emit();
      settledNotice();
    }
  }

  /** Coalesces a burst of mutations into one lookup: the first change schedules it, the rest ride along. */
  function scheduleRecheck(s) {
    if (s.done || session !== s || s.recheckTimer !== null) return;
    s.recheckTimer = clock.setTimeout(() => {
      s.recheckTimer = null;
      recheck(s);
    }, RECHECK_MS);
  }

  function arm(s, timeoutMs) {
    s.timer = clock.setTimeout(() => {
      s.timer = null;
      if (s.done || session !== s) return;
      if (isHidden()) { s.waitingForVisible = true; return; } // a background tab may not have rendered yet
      finalise(s);
    }, timeoutMs);
  }

  function watch(pageType, activeFeatures, opts) {
    const features = strings(activeFeatures);
    const timeoutMs = normaliseTimeout(opts && opts.timeoutMs);
    if (session) endSession(session);

    state.recorded.clear();
    countedThisPage.clear();
    // The last verdict is kept until the new look says otherwise, so a feature that is broken everywhere (theme: no app element) is
    // not switched back on for the length of every page's settle window. Features the new page does not judge, or finds healthy,
    // are dropped below.
    state.pageType = pageType;
    state.features = features;

    const pending = missingNow(pageType, features);
    const s = { pending, timer: null, recheckTimer: null, observer: null, onVisibility: null, waitingForVisible: false, done: false };
    const dispose = () => endSession(s);

    if (pending.size === 0) {
      state.settled = new Map();
      s.done = true;
      emit();
      settledNotice();
      armSentinel(timeoutMs);
      return () => { dispose(); stopSentinel(); };
    }
    session = s;
    // The prior verdict for a feature that is healthy now must not linger.
    for (const feature of [...state.settled.keys()]) if (!pending.has(feature)) state.settled.delete(feature);
    emit();
    if (session !== s) return dispose; // onChange started a newer watch()

    armSentinel(timeoutMs);
    const disposeAll = () => { dispose(); stopSentinel(); };
    if (timeoutMs === 0) {
      finalise(s);
      return disposeAll;
    }
    if (Observer && doc) {
      s.observer = new Observer(() => scheduleRecheck(s));
      s.observer.observe(doc.documentElement || doc, { childList: true, subtree: true, attributes: true, attributeFilter: WATCHED_ATTRS });
    }
    if (doc && typeof doc.addEventListener === 'function') {
      s.onVisibility = () => {
        if (!s.waitingForVisible || s.done || session !== s || isHidden()) return;
        s.waitingForVisible = false;
        arm(s, timeoutMs);
      };
      doc.addEventListener('visibilitychange', s.onVisibility);
    }
    arm(s, timeoutMs);
    return disposeAll;
  }

  // ---- readability sentinel ---------------------------------------------------------------------------------------
  function stopSentinel(s) {
    const cur = s || sentinel;
    if (!cur) return;
    if (cur.timer !== null) { clock.clearTimeout(cur.timer); cur.timer = null; }
    if (cur.onVisibility && doc) { doc.removeEventListener('visibilitychange', cur.onVisibility); cur.onVisibility = null; }
    cur.done = true;
    if (sentinel === cur) sentinel = null;
  }

  function themeIsApplied() {
    try {
      const root = doc && doc.documentElement;
      return !!root && root.hasAttribute(ATTR.theme) && !root.hasAttribute(ATTR.offPrefix + 'theme');
    } catch {
      return false;
    }
  }

  function setUnreadable(bad) {
    const was = unreadableApplies();
    unreadable = bad ? { themeId: themeId(), mapVersion: own(liveMap(), 'mapVersion') } : null;
    if (was !== unreadableApplies()) emit();
    settledNotice();
  }

  function measure() {
    if (typeof readability === 'function') return readability({ doc, selectors, pageType: state.pageType });
    return measureReadability({ doc, selectors, pageType: state.pageType });
  }

  /** After the settle time, once the themed page has had its chance to render: is it readable? Never runs while the theme is off. */
  function armSentinel(timeoutMs) {
    stopSentinel();
    if (readability === false || !doc) return;
    const s = { timer: null, onVisibility: null, waiting: false, retries: 0, strikes: 0, done: false };
    sentinel = s;
    const run = () => {
      s.timer = null;
      if (s.done || sentinel !== s) return;
      if (isHidden()) { s.waiting = true; return; }
      if (!themeIsApplied()) { stopSentinel(s); return; } // nothing themed to judge; a standing verdict stays
      let result = null;
      try { result = measure(); } catch { result = null; }
      const checked = result && Number.isFinite(result.checked) ? result.checked : 0;
      if (checked < SAMPLES_NEEDED) {
        if (++s.retries > SENTINEL_RETRIES) { stopSentinel(s); return; }
        s.timer = clock.setTimeout(run, SENTINEL_RETRY_MS);
        return;
      }
      const bad = Array.isArray(result.low) && result.low.length > 0;
      if (bad && s.strikes === 0) { s.strikes = 1; s.timer = clock.setTimeout(run, SENTINEL_CONFIRM_MS); return; }
      stopSentinel(s);
      setUnreadable(bad);
    };
    if (typeof doc.addEventListener === 'function') {
      s.onVisibility = () => {
        if (!s.waiting || s.done || sentinel !== s || isHidden()) return;
        s.waiting = false;
        s.timer = clock.setTimeout(run, SENTINEL_RETRY_MS);
      };
      doc.addEventListener('visibilitychange', s.onVisibility);
    }
    s.timer = clock.setTimeout(run, Math.max(0, timeoutMs));
  }

  /**
   * Starts from a verdict remembered from an earlier page load (the engine persists it): the unreadable theme is kept off from the
   * first frame instead of flashing on for the settle time. It applies only to that theme under that map, and a passing
   * measurement or a changed theme/map drops it.
   */
  function seedUnreadable(verdict) {
    if (verdict && typeof verdict.themeId === 'string' && typeof verdict.mapVersion === 'string') {
      unreadable = { themeId: verdict.themeId, mapVersion: verdict.mapVersion };
    } else {
      unreadable = null;
    }
  }

  // ---- public: record --------------------------------------------------------------------------------------------
  /**
   * A layout reports that it could not work (for example no tile could be mounted). Counts immediately; no settle time,
   * the layout already retried. Unknown features are refused, unknown role names are dropped.
   * @returns {boolean} whether the report was accepted
   */
  function record(feature, missingRoles) {
    const m = liveMap();
    const knownFeature = typeof feature === 'string' && (KNOWN_FEATURES.has(feature) || hasOwn.call(own(m, 'requires') || {}, feature));
    if (!knownFeature) return false;
    const known = roleNames();
    const asked = typeof missingRoles === 'string' ? [missingRoles] : strings(missingRoles);
    const roles = asked.filter((role) => known.has(role));
    state.recorded.set(feature, union(state.recorded.get(feature), roles));
    bump(roles);
    emit();
    return true;
  }

  // ---- public: counters ------------------------------------------------------------------------------------------
  function themeId() {
    try {
      const value = doc && doc.documentElement && doc.documentElement.getAttribute(ATTR.theme);
      return typeof value === 'string' && THEME_IDS.has(value) ? value : null;
    } catch {
      return null;
    }
  }

  /** @returns {{roles: Record<string, number>, themeId: string|null}} a copy; reading it changes nothing */
  function counters() {
    return { roles: Object.fromEntries([...counts].sort((a, b) => (a[0] < b[0] ? -1 : 1))), themeId: themeId() };
  }

  return { evaluate, watch, record, counters, seedUnreadable, isUnreadable: unreadableApplies };
}
