// Pure popup logic: validation, tier gating, the derived view and all user-facing copy.
// No DOM, no chrome.*: app.js owns the wiring, this file owns the decisions (and is unit-tested on its own).
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SCHEDULE, DEFAULT_SETTINGS, FEATURES, FREE_CALM_KEYS, FREE_THEME_IDS,
  LAYOUT_HOME, LAYOUT_WATCH, LIMITS, PAGE_TYPES,
} from '../shared/constants.js';
import {
  allowedCalmKeys, canSetDensity, canStartTrial, computeEffectiveConfig, getTrialDay, isPro, isThemeAllowed, isTrialActive,
} from '../shared/entitlements.js';
import { contrastRatio } from '../shared/contrast.js';
import { LAPSE_REASONS, licenceState, verifiedLicenceState } from '../shared/licence.js';

export { isPro, canStartTrial, isTrialActive };

/** The accent must reach 3:1 on the theme background or tokens.js falls back to the theme's own accent. */
export const ACCENT_MIN_CONTRAST = 3;

export const ACCENT_SWATCHES = Object.freeze([
  { name: 'Gold', hex: '#e8b04a' },
  { name: 'Ember', hex: '#ff7a45' },
  { name: 'Rose', hex: '#f4678b' },
  { name: 'Orchid', hex: '#c084fc' },
  { name: 'Indigo', hex: '#7c8cff' },
  { name: 'Sky', hex: '#4cc3ff' },
  { name: 'Mint', hex: '#3ddc97' },
  { name: 'Pearl', hex: '#f2f2f5' },
]);

export const DENSITY_LABELS = Object.freeze(['Compact', 'Cosy', 'Balanced', 'Airy', 'Roomy']);

export const CALM_COPY = Object.freeze({
  hideShorts: { label: 'Hide Shorts', hint: 'Shorts shelves and tiles' },
  hideHomeRecs: { label: 'Hide home recommendations', hint: 'The recommendation grid on the home page' },
  hideComments: { label: 'Hide comments', hint: 'The comments under a video' },
  hideEndScreens: { label: 'Hide end screens', hint: 'Suggestion cards at the end of a video' },
  hideViewCounts: { label: 'Hide view counts', hint: 'View counts on tiles and the watch page' },
  hideLive: { label: 'Hide live streams', hint: 'Live streams in feed rows (works with rows layouts)' },
});

export const FEATURE_LABELS = Object.freeze({
  theme: 'Theme',
  'layout-home': 'Home layout',
  'layout-watch': 'Watch page layout',
  density: 'Density',
  'calm-hideShorts': 'Hide Shorts',
  'calm-hideHomeRecs': 'Hide home recommendations',
  'calm-hideComments': 'Hide comments',
  'calm-hideEndScreens': 'Hide end screens',
  'calm-hideViewCounts': 'Hide view counts',
  'calm-hideLive': 'Hide live streams',
});

export const PAGE_LABELS = Object.freeze({
  home: 'the Home page',
  watch: 'a watch page',
  search: 'search results',
  channel: 'a channel page',
  subscriptions: 'Subscriptions',
  history: 'History',
  playlist: 'a playlist',
  shorts: 'Shorts',
  other: 'this page',
});

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

// ---- colour and number parsing ----------------------------------------------------------------------------------------

/** '#abc', 'ABCDEF', ' #aabbcc ' -> '#aabbcc'; anything else -> null. Used for what the user types. */
export function parseHex(input) {
  if (typeof input !== 'string') return null;
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  let hex = m[1].toLowerCase();
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return `#${hex}`;
}

/** Strict '#rrggbb' (what settings may hold), lower-cased; anything else -> null. */
export function strictHex(input) {
  return typeof input === 'string' && /^#[0-9a-f]{6}$/i.test(input) ? input.toLowerCase() : null;
}

export const isDensity = (n) => Number.isInteger(n) && n >= 1 && n <= 5;
export const TEXT_SCALES = Object.freeze([0.9, 1, 1.1, 1.25, 1.5]);
export const isTextScale = (n) => typeof n === 'number' && TEXT_SCALES.includes(n);

/** Formats milliseconds remaining into M:SS countdown string. */
export function formatCountdown(ms) {
  const totalSec = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Colour strings from theme data are only applied to swatches when they are plainly colours. */
export function safeCssColor(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const v = value.trim();
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) return v;
  if (/^(?:rgb|hsl)a?\(\s*[-+0-9.%\s,/a-z]*\)$/i.test(v) && !/[;{}\\]/.test(v)) return v;
  return null;
}

// ---- settings: validate, merge ----------------------------------------------------------------------------------------

/**
 * Validates a settings patch. Allowed keys: themeId, accent, density, animations, calm. Nothing else gets through,
 * so a tampered DOM or a future bug cannot write an arbitrary key into cd.settings.
 * @returns {{ok:true, patch:object} | {ok:false, error:string}}
 */
export function sanitizePatch(patch, allowedCustomIds = []) {
  if (!isPlainObject(patch)) return { ok: false, error: 'Nothing to save.' };
  const out = {};
  const customIds = Array.isArray(allowedCustomIds) ? allowedCustomIds : [];
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    switch (key) {
      case 'themeId':
        if (typeof value !== 'string' || (!ALL_THEME_IDS.includes(value) && !customIds.includes(value))) {
          return { ok: false, error: 'That theme is not available.' };
        }
        out.themeId = value;
        break;
      case 'accent': {
        if (value === null) { out.accent = null; break; }
        const hex = strictHex(value);
        if (!hex) return { ok: false, error: 'Enter a colour like #e8b04a.' };
        out.accent = hex;
        break;
      }
      case 'density':
        if (value !== null && !isDensity(value)) return { ok: false, error: 'Density must be a whole number from 1 to 5.' };
        out.density = value;
        break;
      case 'animations':
        if (typeof value !== 'boolean') return { ok: false, error: 'Animations must be on or off.' };
        out.animations = value;
        break;
      case 'textScale':
        if (value !== null && !isTextScale(value)) return { ok: false, error: 'Text size must be 0.9, 1, 1.1, 1.25, or 1.5.' };
        out.textScale = value;
        break;
      case 'layout': {
        if (!isPlainObject(value)) return { ok: false, error: 'Layout settings are invalid.' };
        const l = {};
        for (const k of Object.keys(value)) {
          if (k === 'home') {
            if (value[k] !== null && !LAYOUT_HOME.includes(value[k])) return { ok: false, error: 'Home layout is invalid.' };
            l.home = value[k];
          } else if (k === 'watch') {
            if (value[k] !== null && !LAYOUT_WATCH.includes(value[k])) return { ok: false, error: 'Watch layout is invalid.' };
            l.watch = value[k];
          } else {
            return { ok: false, error: 'Layout settings are invalid.' };
          }
        }
        out.layout = l;
        break;
      }
      case 'calm': {
        if (!isPlainObject(value)) return { ok: false, error: 'Calm settings are invalid.' };
        const calm = {};
        for (const k of Object.keys(value)) {
          if (!CALM_KEYS.includes(k) || typeof value[k] !== 'boolean') return { ok: false, error: 'Calm settings are invalid.' };
          calm[k] = value[k];
        }
        out.calm = calm;
        break;
      }
      default:
        return { ok: false, error: 'Unknown setting.' };
    }
  }
  return Object.keys(out).length ? { ok: true, patch: out } : { ok: false, error: 'Nothing to save.' };
}

/**
 * The object that is written to storage: whatever is already stored (unknown keys from other modules survive), with the
 * patch merged in; `calm` is merged key by key. With nothing stored yet the defaults are the base.
 */
export function mergeSettings(stored, patch) {
  const base = isPlainObject(stored) ? stored : DEFAULT_SETTINGS;
  const out = { ...base };
  for (const key of Object.keys(patch)) {
    if (key === 'calm') {
      const prev = isPlainObject(base.calm) ? base.calm : DEFAULT_SETTINGS.calm;
      out.calm = { ...prev, ...patch.calm };
    } else if (key === 'layout') {
      const prev = isPlainObject(base.layout) ? base.layout : DEFAULT_SETTINGS.layout;
      out.layout = { ...prev, ...patch.layout };
    } else {
      out[key] = patch[key];
    }
  }
  if (!isPlainObject(out.calm)) out.calm = { ...DEFAULT_SETTINGS.calm };
  return out;
}

/** Settings with every default filled in, used only as input to the display view. */
export function withDefaults(stored) {
  const base = isPlainObject(stored) ? stored : {};
  return {
    ...DEFAULT_SETTINGS,
    ...base,
    layout: { ...DEFAULT_SETTINGS.layout, ...(isPlainObject(base.layout) ? base.layout : {}) },
    calm: { ...DEFAULT_SETTINGS.calm, ...(isPlainObject(base.calm) ? base.calm : {}) },
  };
}

// ---- licence ----------------------------------------------------------------------------------------------------------

const PLAN_STATUSES = ['none', 'active', 'grace', 'expired'];

/**
 * `{plan, status}` from a GET_LICENCE reply (bare, or wrapped as `{state}`); null when it is not one. An expired state may carry
 * `reason` (LAPSE_REASONS: why it lapsed), which only picks the wording; anything else is dropped.
 */
export function parseLicence(res) {
  const s = isPlainObject(res) && isPlainObject(res.state) ? res.state : res;
  if (!isPlainObject(s)) return null;
  if (s.plan !== 'free' && s.plan !== 'pro') return null;
  if (!PLAN_STATUSES.includes(s.status)) return null;
  const out = { plan: s.plan, status: s.status };
  if (s.tier === 'founder' || s.tier === 'standard') out.tier = s.tier;
  if (s.status === 'expired' && LAPSE_REASONS.includes(s.reason)) out.reason = s.reason;
  return out;
}

/**
 * The licence state straight from the stored `cd.licence` record, for when the background cannot be asked (an MV3 service worker
 * that is asleep, restarting or crashed). Same rules as the background's own getState(): a record needs a token, claims and a numeric
 * `checkedAt`, anything else is "no licence", and the age rules are shared/licence.js licenceState. `undefined` or junk is a
 * truthful "free": the record is the authority, the background only reads it.
 */
export function licenceFromRecord(record, nowMs) {
  const none = { plan: 'free', status: 'none' };
  if (!isPlainObject(record) || typeof record.token !== 'string' || record.token === '') return none;
  if (!isPlainObject(record.claims) || typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt)) return none;
  try {
    const s = licenceState(record, nowMs);
    const out = { plan: s.plan === 'pro' ? 'pro' : 'free', status: PLAN_STATUSES.includes(s.status) ? s.status : 'none' };
    const tier = s.tier || (record.claims && record.claims.tier);
    if (tier === 'founder' || tier === 'standard') out.tier = tier;
    return out;
  } catch {
    return none;
  }
}

/**
 * The same state with the token's signature checked and the claims taken from the signed token (shared/licence.js
 * verifiedLicenceState), for the fallback that runs when the background cannot answer: the popup must not say "Pro active" for a
 * record the page would refuse. Same shape rules as licenceFromRecord; `publicKeyJwk` is LICENCE_PUBLIC_KEY.
 */
export async function licenceFromRecordVerified(record, nowMs, publicKeyJwk, fns) {
  const none = { plan: 'free', status: 'none' };
  if (!isPlainObject(record) || typeof record.token !== 'string' || record.token === '') return none;
  if (!isPlainObject(record.claims) || typeof record.checkedAt !== 'number' || !Number.isFinite(record.checkedAt)) return none;
  try {
    const s = await verifiedLicenceState(record, nowMs, publicKeyJwk, fns);
    const out = { plan: s.plan === 'pro' ? 'pro' : 'free', status: PLAN_STATUSES.includes(s.status) ? s.status : 'none' };
    const tier = s.tier || (record.claims && record.claims.tier);
    if (tier === 'founder' || tier === 'standard') out.tier = tier;
    if (out.status === 'expired' && LAPSE_REASONS.includes(s.reason)) out.reason = s.reason;
    return out;
  } catch {
    return none;
  }
}

/**
 * 'free' | 'active' | 'grace' | 'expired' | 'lapsed' | 'invalid' | 'unknown'.
 * 'expired' is only for a token whose own expiry date has passed; a licence that merely was not re-checked is 'lapsed' and one
 * that did not verify is 'invalid' (an expired state without a reason keeps the old wording: 'expired').
 */
export function licenceKey(licence, known = true) {
  if (!known || !licence) return 'unknown';
  if (isPro(licence)) return licence.status === 'grace' ? 'grace' : 'active';
  if (licence.status !== 'expired') return 'free';
  if (licence.reason === 'not-rechecked') return 'lapsed';
  if (licence.reason === 'invalid') return 'invalid';
  return 'expired';
}

export const LICENCE_COPY = Object.freeze({
  free: { label: 'Free', detail: 'Free themes, accent colour, animations and basic calm mode.' },
  active: { label: 'Pro active', detail: 'All themes, density and every calm toggle are unlocked.' },
  grace: {
    label: 'Pro (offline grace)',
    detail: 'Cinedrape could not re-check your licence recently. Pro keeps working while it retries.',
  },
  expired: {
    label: 'Pro expired',
    detail: 'Your licence has expired, so Pro features are paused. Activate a new token to bring them back.',
  },
  lapsed: {
    label: 'Pro paused',
    detail: 'Cinedrape could not re-check this licence for over a month, so Pro features are paused. Paste your token again to bring them back.',
  },
  invalid: {
    label: 'Pro paused',
    detail: 'This licence could not be verified, so Pro features are paused. Paste your token again, or ask for a new one.',
  },
  unknown: {
    label: 'Licence status unavailable',
    detail: 'Cinedrape could not check your licence. Close and reopen this popup to try again.',
  },
});

// Same ceiling as the background's licence manager (MAX_TOKEN_CHARS), so the popup never sends what it would refuse.
const TOKEN_MAX = 4096;

/** Cleans a pasted token (whitespace from wrapped lines, wrapping quotes) and rejects what cannot be one. */
export function normalizeToken(raw) {
  const empty = { ok: false, code: 'empty', message: 'Paste your licence token first.' };
  if (typeof raw !== 'string') return empty;
  if (raw.length > TOKEN_MAX * 2) return { ok: false, code: 'too-long', message: 'That is too long to be a Cinedrape licence token.' };
  const token = raw.replace(/\s+/g, '').replace(/^["'`]+|["'`]+$/g, '');
  if (!token) return empty;
  if (token.length > TOKEN_MAX) return { ok: false, code: 'too-long', message: 'That is too long to be a Cinedrape licence token.' };
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) {
    return { ok: false, code: 'format', message: "That doesn't look like a Cinedrape licence token. Paste the whole token." };
  }
  return { ok: true, token };
}

/** The background answers `{ok:true, state}` or `{ok:false, reason}`; `valid` is accepted as a synonym of `ok`. */
export function parseActivateResponse(res) {
  if (!isPlainObject(res)) return { ok: false, reason: 'no-response', state: null };
  const ok = res.ok === true || res.valid === true;
  const state = parseLicence(res);
  const reason = typeof res.reason === 'string' ? res.reason.slice(0, 64) : '';
  return { ok, reason: ok ? '' : (reason || 'invalid'), state };
}

/** Friendly copy for a failed activation. Never contains the token, only the reason code's meaning. */
export function activationErrorCopy(reason) {
  const r = String(reason || '').toLowerCase();
  if (r === 'refunded' || r === 'revoked') return 'This token was refunded.';
  if (r === 'expired') return 'This licence has expired. Ask for a new token.';
  if (r === 'not-yet-valid' || r === 'bad-time') return "This token isn't valid yet. Check your computer's date and time.";
  if (r === 'malformed' || r === 'malformed-token' || r === 'bad-claims' || r === 'unsupported-version' || r === 'bad-plan') {
    return "That doesn't look like a Cinedrape licence token. Paste the whole token.";
  }
  if (r === 'bad-signature' || r === 'invalid') return "That token isn't valid — check you copied all of it.";
  if (r === 'no-key' || r === 'bad-key' || r === 'verify-error' || r === 'crypto-unavailable') {
    return 'Cinedrape could not verify tokens in this browser. Try again later.';
  }
  if (r === 'storage-error') return 'The token is valid, but it could not be saved. Check your browser storage and try again.';
  if (r === 'no-response' || r === 'timeout') return 'Cinedrape did not answer. Close and reopen this popup, then try again.';
  return "That token isn't valid — check you copied all of it.";
}

// ---- derived view -----------------------------------------------------------------------------------------------------

/** A usable theme: known id or valid custom theme, and a tier the engine accepts. Duplicates keep the first. */
export function usableThemes(themes, customThemes = []) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(themes) ? themes : []) {
    if (!isPlainObject(t) || typeof t.id !== 'string' || !ALL_THEME_IDS.includes(t.id) || seen.has(t.id)) continue;
    if (t.tier !== 'free' && t.tier !== 'pro') continue;
    seen.add(t.id);
    out.push(t);
  }
  const customList = isPlainObject(customThemes)
    ? Object.values(customThemes)
    : (Array.isArray(customThemes) ? customThemes : []);
  for (const t of customList) {
    if (!isPlainObject(t) || typeof t.id !== 'string' || seen.has(t.id)) continue;
    if (t.tier !== 'free' && t.tier !== 'pro') continue;
    seen.add(t.id);
    out.push({ ...t, isCustom: true });
  }
  return out;
}

export const themeNeedsPro = (theme) => theme.tier === 'pro' || (!theme.isCustom && !FREE_THEME_IDS.includes(theme.id));

/**
 * Everything the UI shows, derived from stored settings + licence + themes. Values are the EFFECTIVE ones (what the open
 * tab actually renders), so a lapsed licence shows Cinema/theme density/no Pro calm while the stored choices stay intact;
 * `suppressed` lists what is saved but currently not applied.
 */
export function deriveView({
  settings, licence, licenceKnown = true, themes, customThemes = [], profiles = [], schedule = null,
  trial = null, trialEnded = false, install = null, nowMs = Date.now(),
}) {
  const list = usableThemes(themes, customThemes);
  const stored = withDefaults(settings);
  const pro = isPro(licence);
  const tier = (licence && (licence.tier === 'founder' || licence.tier === 'standard'))
    ? licence.tier
    : ((licence && licence.claims && licence.claims.tier === 'founder') ? 'founder' : 'standard');
  const trialActive = isTrialActive(trial, nowMs);
  const cfg = computeEffectiveConfig({ settings: stored, licenceState: licence, themes: list, trial: trialActive });
  const effectiveTheme = cfg.theme;
  const storedTheme = list.find((t) => t.id === stored.themeId) || null;
  const densityLocked = false;
  const storedDensity = isDensity(stored.density) ? stored.density : null;
  const layoutLocked = false;
  const storedLayout = isPlainObject(stored.layout) ? stored.layout : {};
  const storedHome = LAYOUT_HOME.includes(storedLayout.home) ? storedLayout.home : null;
  const storedWatch = LAYOUT_WATCH.includes(storedLayout.watch) ? storedLayout.watch : null;
  const layoutCustom = storedHome !== null || storedWatch !== null;
  const layoutSuppressed = false;

  const installInfo = (install && typeof install === 'object') ? install : null;
  const installedAt = installInfo && typeof installInfo.installedAt === 'number' ? installInfo.installedAt : null;
  const day7Dismissed = Boolean(installInfo && installInfo.day7Dismissed);
  const isDay7 = installedAt !== null && (nowMs - installedAt >= (LIMITS.day7UpgradeMs || (7 * 864e5)));
  const showDay7Card = !day7Dismissed && isDay7;

  const themeViews = list.map((t) => {
    return {
      id: t.id,
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id,
      pro: false,
      locked: false,
      checked: !!effectiveTheme && t.id === effectiveTheme.id,
      colors: t.tokens && isPlainObject(t.tokens.color) ? t.tokens.color : {},
      isCustom: !!t.isCustom,
    };
  });

  const calm = CALM_KEYS.map((key) => {
    return {
      key,
      label: CALM_COPY[key].label,
      hint: CALM_COPY[key].hint,
      locked: false,
      on: cfg.calm[key] === true,
      suppressed: false,
    };
  });

  const suppressed = [];

  const profileList = Array.isArray(profiles)
    ? profiles.filter((p) => p && typeof p.id === 'string' && typeof p.name === 'string')
    : [];

  const scheduleView = (schedule && typeof schedule === 'object') ? {
    enabled: Boolean(schedule.enabled),
    dayProfileId: typeof schedule.dayProfileId === 'string' ? schedule.dayProfileId : null,
    nightProfileId: typeof schedule.nightProfileId === 'string' ? schedule.nightProfileId : null,
    dayTime: typeof schedule.dayTime === 'string' ? schedule.dayTime : DEFAULT_SCHEDULE.dayTime,
    nightTime: typeof schedule.nightTime === 'string' ? schedule.nightTime : DEFAULT_SCHEDULE.nightTime,
  } : { ...DEFAULT_SCHEDULE };

  return {
    pro,
    tier: pro ? tier : null,
    trial: {
      active: trialActive,
      until: trial && typeof trial.until === 'number' ? trial.until : null,
      used: trial && typeof trial.used === 'number' ? trial.used : 0,
      msRemaining: trial && typeof trial.until === 'number' ? Math.max(0, trial.until - nowMs) : 0,
      formatted: trial && typeof trial.until === 'number' ? formatCountdown(trial.until - nowMs) : '',
      ended: trialEnded,
    },
    licenceKey: licenceKey(licence, licenceKnown),
    themes: themeViews,
    theme: effectiveTheme ? { id: effectiveTheme.id, name: themeViews.find((t) => t.id === effectiveTheme.id)?.name || effectiveTheme.id } : null,
    themeBg: effectiveTheme && effectiveTheme.tokens && effectiveTheme.tokens.color ? effectiveTheme.tokens.color.bg : null,
    themeAccent: effectiveTheme && effectiveTheme.tokens && effectiveTheme.tokens.color ? effectiveTheme.tokens.color.accent : null,
    accent: cfg.accent,
    animations: cfg.animations,
    textScale: {
      value: isTextScale(stored.textScale) ? stored.textScale : 1,
      custom: isTextScale(stored.textScale),
    },
    density: {
      value: cfg.density,
      label: DENSITY_LABELS[cfg.density - 1],
      locked: densityLocked,
      custom: !densityLocked && storedDensity !== null,
      suppressed: densityLocked && storedDensity !== null,
    },
    layout: {
      home: {
        value: cfg.home,
        locked: layoutLocked,
        custom: !layoutLocked && storedHome !== null,
        suppressed: layoutLocked && storedHome !== null,
      },
      watch: {
        value: cfg.watch,
        locked: layoutLocked,
        custom: !layoutLocked && storedWatch !== null,
        suppressed: layoutLocked && storedWatch !== null,
      },
      locked: layoutLocked,
      custom: layoutCustom,
      suppressed: layoutSuppressed,
    },
    calm,
    suppressed,
    profiles: profileList,
    profilesLocked: false,
    schedule: scheduleView,
    scheduleLocked: false,
    day7Card: {
      show: showDay7Card,
      dismissed: day7Dismissed,
      installedAt,
    },
  };
}

/** Is `patch` (already sanitised) something this licence may write? Locked controls never write. */
export function checkEntitlement(patch, { licence, trial = null, trialActive = false, themes, customThemes = [] }) {
  if (patch.themeId !== undefined) {
    const theme = usableThemes(themes, customThemes).find((t) => t.id === patch.themeId);
    // A theme the popup does not know cannot be shown or verified, so it is refused for everyone.
    if (!theme) return { ok: false, kind: 'unknown-theme', key: patch.themeId };
  }
  return { ok: true };
}

/** Returns title, description and colors for the locked feature sheet preview. */
export function sheetFeatureInfo(kind, key, theme = null) {
  if (kind === 'theme' && theme) {
    return {
      title: `${theme.name} Theme`,
      desc: `Experience the luxury ${theme.name} palette with tailored contrast and ambient tone. Try it free on your own YouTube.`,
      previewBg: theme.tokens?.color?.bg || '#111',
      previewAccent: theme.tokens?.color?.accent || '#e8b04a',
    };
  }
  if (kind === 'layout') {
    return {
      title: 'Mix & Match Layouts',
      desc: 'Customize Home and Watch page layouts independently with any theme: Hero + rows, Cinema watch, and Focus mode.',
      previewBg: '#18181b',
      previewAccent: '#38bdf8',
    };
  }
  if (kind === 'density') {
    return {
      title: 'Custom Density',
      desc: 'Dial in your spacing from Compact (dense cards) to Roomy (cinematic breathing room).',
      previewBg: '#1c1917',
      previewAccent: '#f59e0b',
    };
  }
  if (kind === 'calm') {
    return {
      title: 'Advanced Calm Mode',
      desc: 'Hide distracting view counts and live streams to keep your focus entirely on what you want to watch.',
      previewBg: '#0f172a',
      previewAccent: '#10b981',
    };
  }
  return {
    title: 'Unlock Cinedrape Pro',
    desc: 'Preview luxury Pro themes, custom layouts, density, and all calm mode filters on your own YouTube for 10 minutes.',
    previewBg: '#18181b',
    previewAccent: '#e8b04a',
  };
}

/** Explanation for a locked control; the notice also offers "Activate Pro". */
export function lockedCopy(check, key) {
  const lead = key === 'expired' ? 'Your Pro licence has expired. '
    : (key === 'lapsed' || key === 'invalid' ? 'Your Pro licence is paused. ' : '');
  if (check.kind === 'theme') return `${lead}${check.name} is a Pro theme. Activate Pro to use it.`;
  if (check.kind === 'density') return `${lead}Density is a Pro setting. Activate Pro to adjust it.`;
  if (check.kind === 'layout') return `${lead}Layout customisation is a Pro feature. Activate Pro to use it.`;
  if (check.kind === 'calm') return `${lead}${check.name} is a Pro setting. Activate Pro to turn it on.`;
  if (check.kind === 'profiles') return `${lead}Profiles are a Pro feature. Activate Pro to create and manage profiles.`;
  if (check.kind === 'schedule') return `${lead}Time-based scheduling is a Pro feature. Activate Pro to use it.`;
  return 'That is not available.';
}

// ---- accent contrast --------------------------------------------------------------------------------------------------

/**
 * Warning text when the chosen accent fails 3:1 against the active theme's background (tokens.js then keeps the theme's
 * own accent, so the user would see no change); null when it passes or cannot be judged.
 */
export function accentWarning(view) {
  if (!view.accent || !view.themeBg || !view.theme) return null;
  let ratio = null;
  try { ratio = contrastRatio(view.accent, view.themeBg); } catch { ratio = null; }
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio >= ACCENT_MIN_CONTRAST) return null;
  const shown = (Math.floor(ratio * 10) / 10).toFixed(1);
  return `Low contrast on ${view.theme.name}: ${shown}:1, and 3:1 is needed. Cinedrape will keep the theme's own accent here.`;
}

// ---- health status ----------------------------------------------------------------------------------------------------

/**
 * Reads a GET_STATUS reply (`engine.getStatus()` bare, or wrapped as `{status}`):
 * {broken:[{id,label}], themeId, pageType} or null when it is not a status object.
 */
export function summarizeStatus(raw) {
  const status = isPlainObject(raw) && isPlainObject(raw.features)
    ? raw
    : (isPlainObject(raw) && isPlainObject(raw.status) && isPlainObject(raw.status.features) ? raw.status : null);
  if (!status) return null;
  const ids = Object.keys(status.features).filter((id) => status.features[id] === 'broken');
  const rank = (id) => { const i = FEATURES.indexOf(id); return i === -1 ? FEATURES.length : i; };
  ids.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : a > b ? 1 : 0));
  return {
    broken: ids.map((id) => ({ id, label: hasOwn(FEATURE_LABELS, id) ? FEATURE_LABELS[id] : String(id).slice(0, 40) })),
    themeId: typeof status.themeId === 'string' ? status.themeId : null,
    pageType: PAGE_TYPES.includes(status.pageType) ? status.pageType : null,
    liveCount: typeof status.liveCount === 'number' && Number.isInteger(status.liveCount) && status.liveCount >= 0 ? status.liveCount : null,
  };
}

/** Headline and detail for the status card. `state` is one of checking | idle | unreachable | ok | paused. */
export function statusCopy(state, { summary = null, themes = [] } = {}) {
  switch (state) {
    case 'checking': return { text: 'Checking this tab…', detail: '' };
    case 'idle': return { text: 'Open a YouTube tab to see status', detail: '' };
    case 'unreachable':
      return { text: 'Cinedrape is not running in this tab', detail: 'Reload the YouTube tab to connect it.' };
    case 'paused': {
      const names = summary.broken.map((b) => b.label);
      const shown = names.length > 3 ? `${names.slice(0, 3).join(', ')} and ${names.length - 3} more` : names.join(', ');
      return {
        text: `Paused: ${shown} — YouTube changed, a fix is on the way`,
        detail: 'Everything else keeps working.',
      };
    }
    case 'ok': {
      const theme = summary && summary.themeId ? usableThemes(themes).find((t) => t.id === summary.themeId) : null;
      const bits = [];
      if (theme) bits.push(`${typeof theme.name === 'string' && theme.name ? theme.name : theme.id} theme`);
      if (summary && summary.pageType) bits.push(`on ${PAGE_LABELS[summary.pageType]}`);
      const text = summary && typeof summary.liveCount === 'number' && summary.liveCount > 0
        ? `Working — ${summary.liveCount} live now`
        : 'Working';
      return { text, detail: bits.join(' ') };
    }
    default: return { text: '', detail: '' };
  }
}

// ---- calm presets -----------------------------------------------------------------------------------------------------

export const CALM_PRESETS = Object.freeze({
  study: Object.freeze({
    id: 'study',
    name: 'Study',
    hint: 'No distractions: hides recommendations, comments, end screens, and Shorts',
    calm: Object.freeze({
      hideShorts: true,
      hideHomeRecs: true,
      hideComments: true,
      hideEndScreens: true,
      hideViewCounts: false,
      hideLive: true,
    }),
  }),
  winddown: Object.freeze({
    id: 'winddown',
    name: 'Wind-down',
    hint: 'Quiet evening viewing: hides metric counters and algorithmic feeds',
    calm: Object.freeze({
      hideShorts: true,
      hideHomeRecs: true,
      hideComments: true,
      hideEndScreens: true,
      hideViewCounts: true,
      hideLive: true,
    }),
  }),
  zen: Object.freeze({
    id: 'zen',
    name: 'Zen',
    hint: 'Pure minimalist viewing: all calm filters active',
    calm: Object.freeze({
      hideShorts: true,
      hideHomeRecs: true,
      hideComments: true,
      hideEndScreens: true,
      hideViewCounts: true,
      hideLive: true,
    }),
  }),
  reset: Object.freeze({
    id: 'reset',
    name: 'Reset',
    hint: 'Turn off all calm filters',
    calm: Object.freeze({
      hideShorts: false,
      hideHomeRecs: false,
      hideComments: false,
      hideEndScreens: false,
      hideViewCounts: false,
      hideLive: false,
    }),
  }),
});

/**
 * Applies a calm preset against user's licence entitlements.
 * For free users, only allowed calm keys are enabled; pro keys remain false and are reported in `proBlockedCount`.
 */
export function applyCalmPreset(presetId, currentCalm = {}, licence = null) {
  const preset = CALM_PRESETS[presetId];
  if (!preset) return { ok: false, error: 'Unknown calm preset.' };
  const allowed = allowedCalmKeys(licence);
  const out = { ...currentCalm };
  let proBlockedCount = 0;
  for (const [key, value] of Object.entries(preset.calm)) {
    if (!allowed.includes(key)) {
      if (value) proBlockedCount++;
    } else {
      out[key] = value;
    }
  }
  const notice = proBlockedCount > 0
    ? `Applied "${preset.name}" preset (${proBlockedCount} setting${proBlockedCount > 1 ? 's' : ''} require Pro).`
    : presetId === 'reset' ? 'Calm settings reset.' : `Applied "${preset.name}" preset.`;
  return {
    ok: true,
    calm: out,
    preset,
    proBlockedCount,
    notice,
  };
}

// ---- backup & restore -------------------------------------------------------------------------------------------------

/**
 * Creates a clean backup bundle JSON object containing user settings, custom themes, profiles, and schedule.
 */
export function createBackupBundle({ settings, customThemes = {}, profiles = [], schedule = null }) {
  return {
    schema: 1,
    cinedrapeBackup: true,
    version: '0.1.0',
    exportedAt: new Date().toISOString(),
    settings: settings || DEFAULT_SETTINGS,
    customThemes: customThemes || {},
    profiles: Array.isArray(profiles) ? profiles : [],
    schedule: schedule || DEFAULT_SCHEDULE,
  };
}

/**
 * Validates a parsed backup bundle structure before restoring.
 */
export function validateBackupBundle(bundle, allowedCustomIds = []) {
  if (!isPlainObject(bundle)) return { ok: false, error: 'Backup must be a JSON object.' };
  if (!bundle.cinedrapeBackup && !bundle.settings) return { ok: false, error: 'File is not a Cinedrape backup.' };

  let cleanSettings = null;
  if (bundle.settings) {
    const res = sanitizePatch(bundle.settings, allowedCustomIds);
    if (!res.ok) return { ok: false, error: `Invalid settings in backup: ${res.error}` };
    cleanSettings = res.patch;
  }

  return {
    ok: true,
    bundle: {
      settings: cleanSettings,
      customThemes: isPlainObject(bundle.customThemes) ? bundle.customThemes : {},
      profiles: Array.isArray(bundle.profiles) ? bundle.profiles : [],
      schedule: isPlainObject(bundle.schedule) ? bundle.schedule : null,
    },
  };
}

// ---- diagnostics ------------------------------------------------------------------------------------------------------

/**
 * Generates an anonymous, privacy-safe diagnostic report (no personal data, no URLs).
 */
export function createDiagnostics({ manifestVersion, userAgent, pageType, settings, schedule, licence, selectorMapVersion }) {
  return {
    app: 'Cinedrape',
    version: manifestVersion || '0.1.0',
    userAgent: userAgent || 'unknown',
    pageType: pageType || 'unknown',
    theme: settings?.themeId || 'default',
    accent: settings?.accent || null,
    density: settings?.density || null,
    textScale: settings?.textScale || 1.0,
    calm: settings?.calm || {},
    scheduleEnabled: Boolean(schedule?.enabled),
    plan: licence?.plan || 'free',
    mapVersion: selectorMapVersion || 'bundled',
    timestamp: new Date().toISOString(),
  };
}

