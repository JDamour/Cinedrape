// Tier gating and the EffectiveConfig every CSS builder receives (ARCHITECTURE.md §3.4, §7.1).
// Pure and total: it never throws on junk input and never mutates settings, so a lapsed licence
// falls back silently and the user's stored choices come back when the licence is renewed.
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, FREE_CALM_KEYS, FREE_THEME_IDS,
  LAYOUT_HOME, LAYOUT_WATCH, LIMITS,
} from './constants.js';
import { parseColor, toHex } from './contrast.js';

/**
 * @typedef {{plan?:string, status?:string}} LicenceState  `{plan:'free'|'pro', status:'none'|'active'|'grace'|'expired'}`
 * @typedef {Object} EffectiveConfig
 * @property {object|null} theme      tier-checked NormalizedTheme; null only if `themes` holds no allowed theme (a build error)
 * @property {string|null} accent     '#rrggbb' or null
 * @property {boolean} animations
 * @property {'grid'|'rows'|'hero-rows'} home
 * @property {'default'|'cinema'|'focus'} watch
 * @property {1|2|3|4|5} density
 * @property {Record<string, boolean>} calm   always all CALM_KEYS, already tier-filtered
 * @property {string[]} disabled      FEATURES switched off by the health check
 * @property {boolean} pro
 * @property {boolean} trial
 */

const PRO_ONLY_THEME_IDS = ALL_THEME_IDS.filter((id) => !FREE_THEME_IDS.includes(id));

/** Own data property only: ignores the prototype chain (pollution) and never runs getters. */
function own(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && 'value' in d ? d.value : undefined;
}

const pickEnum = (v, allowed) => (allowed.includes(v) ? v : allowed[0]);
const level = (v) => (Number.isInteger(v) && v >= 1 && v <= 5 ? v : null);

/** Pro means plan 'pro' AND status active or grace. Kept for backwards compatibility. */
export function isPro(licenceState) {
  const status = own(licenceState, 'status');
  return own(licenceState, 'plan') === 'pro' && (status === 'active' || status === 'grace');
}

/**
 * In Cinedrape free-with-support, all valid themes are unlocked and free for all users.
 * A missing or unknown tier is never allowed.
 */
export function isThemeAllowed(theme, _licenceState) {
  const tier = own(theme, 'tier');
  return tier === 'free' || tier === 'pro';
}

/** In Cinedrape free-with-support, custom density (1..5) is 100% free for all users. */
export function canSetDensity(_licenceState) {
  return true;
}

/** In Cinedrape free-with-support, all calm keys are 100% free for all users. Fresh array. */
export function allowedCalmKeys(_licenceState) {
  return [...CALM_KEYS];
}

/**
 * In Cinedrape free-with-support, all supported features are 100% free for all users.
 * Unknown features are not allowed.
 */
export function isFeatureAllowed(feature, _licenceState) {
  return FEATURES.includes(feature);
}

/** Formats a timestamp into YYYY-MM-DD in UTC. */
export function getTrialDay(ms = Date.now()) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Checks whether a new trial can be started under the daily cap of 3 trials. */
export function canStartTrial(trialLog, nowMs = Date.now(), maxTrials = LIMITS.maxDailyTrials || 3) {
  if (trialLog === null || typeof trialLog !== 'object') return { ok: true, count: 0 };
  const today = getTrialDay(nowMs);
  const day = own(trialLog, 'day');
  const count = Number.isInteger(own(trialLog, 'count')) ? own(trialLog, 'count') : 0;
  if (day !== today) return { ok: true, count: 0 };
  if (count >= maxTrials) {
    return {
      ok: false,
      count,
      reason: 'daily-limit-reached',
      message: `Daily preview limit reached (${maxTrials} of ${maxTrials} used today). Try again tomorrow or get Pro.`,
    };
  }
  return { ok: true, count };
}

/** Checks whether a trial record is active at the given timestamp. */
export function isTrialActive(trial, nowMs = Date.now()) {
  if (trial === null || typeof trial !== 'object') return false;
  const until = own(trial, 'until');
  return typeof until === 'number' && Number.isFinite(until) && until > nowMs;
}

/**
 * @param {{settings?:object, licenceState?:LicenceState, themes?:object[], disabled?:string[]}} input
 *   `themes` is the array of validated themes (THEMES). `disabled` is the health check's list.
 * @returns {EffectiveConfig}
 */
export function computeEffectiveConfig(input) {
  const { settings, licenceState, themes, disabled } = input !== null && typeof input === 'object' ? input : {};
  const pro = isPro(licenceState);
  const trial = Boolean(own(input, 'trial'));
  const list = Array.isArray(themes) ? themes.filter((t) => t !== null && typeof t === 'object') : [];
  const byId = (id) => list.find((t) => own(t, 'id') === id);
  const themeAllowed = (t) => isThemeAllowed(t, licenceState);

  // Stored theme -> cinema -> first allowed theme. The stored id itself is never rewritten.
  const wanted = own(settings, 'themeId');
  let theme = typeof wanted === 'string' ? byId(wanted) : undefined;
  if (!theme || !themeAllowed(theme)) theme = byId(DEFAULT_SETTINGS.themeId);
  if (!theme || !themeAllowed(theme)) {
    theme = list.find((t) => themeAllowed(t)) || null;
  }

  const layout = own(theme, 'layout');
  const themeDensity = level(own(layout, 'density')) ?? 3;
  const override = level(own(settings, 'density'));

  const settingsLayout = own(settings, 'layout');
  const userHome = LAYOUT_HOME.includes(own(settingsLayout, 'home')) ? own(settingsLayout, 'home') : null;
  const userWatch = LAYOUT_WATCH.includes(own(settingsLayout, 'watch')) ? own(settingsLayout, 'watch') : null;
  const themeHome = pickEnum(own(layout, 'home'), LAYOUT_HOME);
  const themeWatch = pickEnum(own(layout, 'watch'), LAYOUT_WATCH);

  // settings.calm[key] decides when it is a boolean; otherwise the theme's default; then off.
  // In the free model, all CALM_KEYS are available to all users.
  const userCalm = own(settings, 'calm');
  const themeCalm = own(theme, 'calm');
  const calm = {};
  for (const key of CALM_KEYS) {
    let v = own(userCalm, key);
    if (typeof v !== 'boolean') v = own(themeCalm, key);
    calm[key] = v === true;
  }

  const accentColour = parseColor(own(settings, 'accent'));
  const animations = own(settings, 'animations');
  const rawScale = own(settings, 'textScale');
  const textScale = typeof rawScale === 'number' && [0.9, 1, 1.1, 1.25, 1.5].includes(rawScale) ? rawScale : null;
  const off = Array.isArray(disabled) ? disabled.filter((f) => FEATURES.includes(f)) : [];

  return {
    theme,
    accent: accentColour && accentColour.a === 1 ? toHex(accentColour) : null,
    animations: typeof animations === 'boolean' ? animations : DEFAULT_SETTINGS.animations,
    textScale,
    home: userHome !== null ? userHome : themeHome,
    watch: userWatch !== null ? userWatch : themeWatch,
    density: override !== null ? override : themeDensity,
    calm,
    disabled: [...new Set(off)],
    pro,
    trial,
  };
}
