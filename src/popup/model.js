// Pure popup logic: validation, tier gating, the derived view and all user-facing copy.
// No DOM, no chrome.*: app.js owns the wiring, this file owns the decisions (and is unit-tested on its own).
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, FREE_THEME_IDS, PAGE_TYPES,
} from '../shared/constants.js';
import {
  allowedCalmKeys, canSetDensity, computeEffectiveConfig, isPro, isThemeAllowed,
} from '../shared/entitlements.js';
import { contrastRatio } from '../shared/contrast.js';
import { LAPSE_REASONS, licenceState, verifiedLicenceState } from '../shared/licence.js';

export { isPro };

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
export function sanitizePatch(patch) {
  if (!isPlainObject(patch)) return { ok: false, error: 'Nothing to save.' };
  const out = {};
  for (const key of Object.keys(patch)) {
    const value = patch[key];
    switch (key) {
      case 'themeId':
        if (typeof value !== 'string' || !ALL_THEME_IDS.includes(value)) return { ok: false, error: 'That theme is not available.' };
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
    return { plan: s.plan === 'pro' ? 'pro' : 'free', status: PLAN_STATUSES.includes(s.status) ? s.status : 'none' };
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
  if (r === 'expired') return 'This licence has expired. Ask for a new token.';
  if (r === 'not-yet-valid' || r === 'bad-time') return "This token isn't valid yet. Check your computer's date and time.";
  if (r === 'malformed' || r === 'malformed-token' || r === 'bad-claims' || r === 'unsupported-version' || r === 'bad-plan') {
    return "That doesn't look like a Cinedrape licence token. Paste the whole token.";
  }
  if (r === 'bad-signature' || r === 'invalid') return 'That token could not be verified. Check you copied it exactly.';
  if (r === 'no-key' || r === 'bad-key' || r === 'verify-error' || r === 'crypto-unavailable') {
    return 'Cinedrape could not verify tokens in this browser. Try again later.';
  }
  if (r === 'storage-error') return 'The token is valid, but it could not be saved. Check your browser storage and try again.';
  if (r === 'no-response' || r === 'timeout') return 'Cinedrape did not answer. Close and reopen this popup, then try again.';
  return 'That token could not be activated. Check it and try again.';
}

// ---- derived view -----------------------------------------------------------------------------------------------------

/** A usable theme: known id and a tier the engine accepts. Duplicates keep the first. */
export function usableThemes(themes) {
  const seen = new Set();
  const out = [];
  for (const t of Array.isArray(themes) ? themes : []) {
    if (!isPlainObject(t) || typeof t.id !== 'string' || !ALL_THEME_IDS.includes(t.id) || seen.has(t.id)) continue;
    if (t.tier !== 'free' && t.tier !== 'pro') continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

export const themeNeedsPro = (theme) => theme.tier === 'pro' || !FREE_THEME_IDS.includes(theme.id);

/**
 * Everything the UI shows, derived from stored settings + licence + themes. Values are the EFFECTIVE ones (what the open
 * tab actually renders), so a lapsed licence shows Cinema/theme density/no Pro calm while the stored choices stay intact;
 * `suppressed` lists what is saved but currently not applied.
 */
export function deriveView({ settings, licence, licenceKnown = true, themes }) {
  const list = usableThemes(themes);
  const stored = withDefaults(settings);
  const pro = isPro(licence);
  const cfg = computeEffectiveConfig({ settings: stored, licenceState: licence, themes: list });
  const effectiveTheme = cfg.theme;
  const storedTheme = list.find((t) => t.id === stored.themeId) || null;
  const allowedCalm = allowedCalmKeys(licence);
  const densityLocked = !canSetDensity(licence);
  const storedDensity = isDensity(stored.density) ? stored.density : null;

  const themeViews = list.map((t) => {
    const locked = !isThemeAllowed(t, licence);
    return {
      id: t.id,
      name: typeof t.name === 'string' && t.name.trim() ? t.name.trim() : t.id,
      pro: themeNeedsPro(t),
      locked,
      checked: !!effectiveTheme && t.id === effectiveTheme.id,
      colors: t.tokens && isPlainObject(t.tokens.color) ? t.tokens.color : {},
    };
  });

  const calm = CALM_KEYS.map((key) => {
    const locked = !allowedCalm.includes(key);
    return {
      key,
      label: CALM_COPY[key].label,
      hint: CALM_COPY[key].hint,
      locked,
      on: cfg.calm[key] === true,
      suppressed: locked && stored.calm[key] === true,
    };
  });

  const suppressed = [];
  if (storedTheme && effectiveTheme && storedTheme.id !== effectiveTheme.id) {
    suppressed.push(typeof storedTheme.name === 'string' && storedTheme.name ? `${storedTheme.name} theme` : 'your theme');
  }
  if (densityLocked && storedDensity !== null) suppressed.push('density');
  for (const c of calm) if (c.suppressed) suppressed.push(c.label.toLowerCase());

  return {
    pro,
    licenceKey: licenceKey(licence, licenceKnown),
    themes: themeViews,
    theme: effectiveTheme ? { id: effectiveTheme.id, name: themeViews.find((t) => t.id === effectiveTheme.id)?.name || effectiveTheme.id } : null,
    themeBg: effectiveTheme && effectiveTheme.tokens && effectiveTheme.tokens.color ? effectiveTheme.tokens.color.bg : null,
    themeAccent: effectiveTheme && effectiveTheme.tokens && effectiveTheme.tokens.color ? effectiveTheme.tokens.color.accent : null,
    accent: cfg.accent,
    animations: cfg.animations,
    density: {
      value: cfg.density,
      label: DENSITY_LABELS[cfg.density - 1],
      locked: densityLocked,
      custom: !densityLocked && storedDensity !== null,
      suppressed: densityLocked && storedDensity !== null,
    },
    calm,
    suppressed,
  };
}

/** Is `patch` (already sanitised) something this licence may write? Locked controls never write. */
export function checkEntitlement(patch, { licence, themes }) {
  if (patch.themeId !== undefined) {
    const theme = usableThemes(themes).find((t) => t.id === patch.themeId);
    // A theme the popup does not know cannot be shown or verified, so it is refused for everyone.
    if (!theme) return { ok: false, kind: 'unknown-theme', key: patch.themeId };
    if (!isThemeAllowed(theme, licence)) {
      return { ok: false, kind: 'theme', key: theme.id, name: typeof theme.name === 'string' && theme.name ? theme.name : theme.id };
    }
  }
  if (patch.density !== undefined && !canSetDensity(licence)) return { ok: false, kind: 'density', key: 'density' };
  if (patch.calm) {
    const allowed = allowedCalmKeys(licence);
    for (const key of Object.keys(patch.calm)) {
      if (!allowed.includes(key)) return { ok: false, kind: 'calm', key, name: CALM_COPY[key].label };
    }
  }
  return { ok: true };
}

/** Explanation for a locked control; the notice also offers "Activate Pro". */
export function lockedCopy(check, key) {
  const lead = key === 'expired' ? 'Your Pro licence has expired. '
    : (key === 'lapsed' || key === 'invalid' ? 'Your Pro licence is paused. ' : '');
  if (check.kind === 'theme') return `${lead}${check.name} is a Pro theme. Activate Pro to use it.`;
  if (check.kind === 'density') return `${lead}Density is a Pro setting. Activate Pro to adjust it.`;
  if (check.kind === 'calm') return `${lead}${check.name} is a Pro setting. Activate Pro to turn it on.`;
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
      return { text: 'Working', detail: bits.join(' ') };
    }
    default: return { text: '', detail: '' };
  }
}
