// Tier gating and the EffectiveConfig every CSS builder receives (ARCHITECTURE.md §3.4, §7.1).
// Pure and total: it never throws on junk input and never mutates settings, so a lapsed licence
// falls back silently and the user's stored choices come back when the licence is renewed.
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, FREE_CALM_KEYS, FREE_THEME_IDS,
  LAYOUT_HOME, LAYOUT_WATCH,
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

/** Pro means plan 'pro' AND status active or grace. Anything else, including junk, is free. */
export function isPro(licenceState) {
  const status = own(licenceState, 'status');
  return own(licenceState, 'plan') === 'pro' && (status === 'active' || status === 'grace');
}

/**
 * A theme is usable when it is free, or the user is Pro. The requirement is the stricter of the
 * theme's own `tier` and the launch roster (a bundled Pro theme mislabelled 'free' stays Pro).
 * A missing or unknown tier is never allowed.
 */
export function isThemeAllowed(theme, licenceState) {
  const tier = own(theme, 'tier');
  if (tier !== 'free' && tier !== 'pro') return false;
  const needsPro = tier === 'pro' || PRO_ONLY_THEME_IDS.includes(own(theme, 'id'));
  return !needsPro || isPro(licenceState);
}

/** Density is a layout control that works independently of a theme, so it is Pro (§7.1). */
export function canSetDensity(licenceState) {
  return isPro(licenceState);
}

/** Calm keys the user may switch on: all five for Pro, FREE_CALM_KEYS otherwise. Fresh array. */
export function allowedCalmKeys(licenceState) {
  return isPro(licenceState) ? [...CALM_KEYS] : [...FREE_CALM_KEYS];
}

/**
 * Whether `feature` (one of FEATURES) is available to this licence. Layouts are not gated on their
 * own: a theme's bundled layout applies whenever the theme is allowed (§7.1), so only density and
 * the Pro calm toggles are locked for free users. Unknown features are not allowed.
 */
export function isFeatureAllowed(feature, licenceState) {
  if (!FEATURES.includes(feature)) return false;
  if (feature === 'density') return canSetDensity(licenceState);
  if (feature.startsWith('calm-')) return allowedCalmKeys(licenceState).includes(feature.slice(5));
  return true;
}

/**
 * @param {{settings?:object, licenceState?:LicenceState, themes?:object[], disabled?:string[]}} input
 *   `themes` is the array of validated themes (THEMES). `disabled` is the health check's list.
 * @returns {EffectiveConfig}
 */
export function computeEffectiveConfig(input) {
  const { settings, licenceState, themes, disabled } = input !== null && typeof input === 'object' ? input : {};
  const pro = isPro(licenceState);
  const list = Array.isArray(themes) ? themes.filter((t) => t !== null && typeof t === 'object') : [];
  const byId = (id) => list.find((t) => own(t, 'id') === id);

  // Stored theme -> cinema -> first allowed theme. The stored id itself is never rewritten.
  const wanted = own(settings, 'themeId');
  let theme = typeof wanted === 'string' ? byId(wanted) : undefined;
  if (!theme || !isThemeAllowed(theme, licenceState)) theme = byId(DEFAULT_SETTINGS.themeId);
  if (!theme || !isThemeAllowed(theme, licenceState)) {
    theme = list.find((t) => isThemeAllowed(t, licenceState)) || null;
  }

  const layout = own(theme, 'layout');
  const themeDensity = level(own(layout, 'density')) ?? 3;
  const override = level(own(settings, 'density'));

  // settings.calm[key] decides when it is a boolean; otherwise the theme's default; then off.
  // Free users keep only FREE_CALM_KEYS whatever is stored.
  const userCalm = own(settings, 'calm');
  const themeCalm = own(theme, 'calm');
  const allowed = allowedCalmKeys(licenceState);
  const calm = {};
  for (const key of CALM_KEYS) {
    let v = own(userCalm, key);
    if (typeof v !== 'boolean') v = own(themeCalm, key);
    calm[key] = allowed.includes(key) && v === true;
  }

  const accentColour = parseColor(own(settings, 'accent'));
  const animations = own(settings, 'animations');
  const off = Array.isArray(disabled) ? disabled.filter((f) => FEATURES.includes(f)) : [];

  return {
    theme,
    accent: accentColour && accentColour.a === 1 ? toHex(accentColour) : null,
    animations: typeof animations === 'boolean' ? animations : DEFAULT_SETTINGS.animations,
    home: pickEnum(own(layout, 'home'), LAYOUT_HOME),
    watch: pickEnum(own(layout, 'watch'), LAYOUT_WATCH),
    density: pro && override !== null ? override : themeDensity,
    calm,
    disabled: [...new Set(off)],
    pro,
  };
}
