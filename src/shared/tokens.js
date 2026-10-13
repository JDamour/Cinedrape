// Theme tokens -> CSS custom properties (ARCHITECTURE.md section 4, "shared/tokens.js").
//
// deriveTokens() turns a validated theme plus the user's accent/animation choice into one flat record of
// declarations; buildTokenCss() prints that record as a single rule on html[cd-theme]. Besides the --cd-*
// variables the rule bridges the theme colours onto every YouTube colour variable listed in map.vars, so a
// YouTube variable rename is fixed by a selector-map update instead of a release.
//
// Pure: no DOM, no chrome.*. Total: junk input (a half-formed theme, a hostile map) produces a safe
// stylesheet, never an exception and never a value that could break out of its declaration.
import { FONT_STACKS } from './theme-schema.js';
import { contrastRatio, parseColor, pickReadableText, toHex } from './contrast.js';

/**
 * Specificity (0,2,1) on the dark/light variants beats YouTube's html[dark] block whatever the injection order. The last selector
 * covers elements that carry their own dark attribute (ytd-masthead gets one in dark mode): YouTube's [dark] block redefines the
 * whole palette on them, so a bridge that stops at <html> is overridden for everything inside the masthead.
 */
export const TOKEN_SELECTOR = 'html[cd-theme], html[cd-theme][dark], html[cd-theme]:not([dark]), html[cd-theme] [dark]';

/** --cd-space for spacing scale 1..5 (multiples of this unit build paddings and gaps). */
export const SPACING_PX = Object.freeze([2, 4, 6, 8, 12]);
export const MOTION_MS = 160;
export const MIN_ACCENT_CONTRAST = 3;

// Neutral dark values (YouTube's own dark look) used only when a theme token is missing or unreadable.
const FALLBACK = Object.freeze({
  bg: '#0f0f0f', surface: '#212121', text: '#f1f1f1', muted: '#aaaaaa', accent: '#3ea6ff', border: '#717171',
});
const FALLBACK_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
const SAFE_FONT = /^[A-Za-z0-9 ,'"._-]{1,200}$/;
const VAR_NAME = /^--[A-Za-z][A-Za-z0-9_-]{0,127}$/;
// Ad/sponsor colours are YouTube's own markers (e.g. --static-ad-yellow). Never recolour them.
const AD_VAR = /(?:^|[-_])(?:ads?|sponsor\w*|paid[-_]?content)(?:[-_]|$)/i;
const MAX_BRIDGED_VARS = 200;

// token -> value written onto each YouTube variable listed under that key of map.vars. Keys the map does not
// list are skipped; keys this table does not know are ignored (a newer map may carry more).
const BRIDGE = Object.freeze({
  bg: 'var(--cd-bg)',
  surface: 'var(--cd-surface)',
  menu: 'var(--cd-menu)',
  text: 'var(--cd-text)',
  muted: 'var(--cd-muted)',
  accent: 'var(--cd-accent)',
  accentHover: 'var(--cd-accent-hover)',
  border: 'var(--cd-border)',
  borderOpaque: 'var(--cd-border)',
  overlay: 'var(--cd-scrim)',
  // optional keys: a map may list the YouTube variables for translucent tints, inverted surfaces and icons. Light themes
  // need them (YouTube's own tints are white-on-white there), so adding a key to map.vars is all a rename takes.
  hover: 'var(--cd-hover)',
  additive: 'var(--cd-hover)',
  tonal: 'var(--cd-hover)',
  active: 'var(--cd-active)',
  chipHover: 'var(--cd-active)',
  inverted: 'var(--cd-text)',
  invertedText: 'var(--cd-bg)',
  icon: 'var(--cd-text)',
  iconMuted: 'var(--cd-muted)',
});

/**
 * YouTube variables of the current build for the tokens above, used BESIDE map.vars (the map's names come first; this list only
 * adds). YouTube now writes most colours twice: the readable --yt-sys-color-baseline--* name and an obfuscated twin (--t<16 hex>)
 * with identical light and dark values, and its stylesheet reads only the twin (verified live 2026-10-08:
 * .title.ytd-mini-guide-entry-renderer{color:var(--tffc2fd3a644f6275)}, ytd-app{background:var(--t3e41d7b17b187f69)}). A bridge that
 * knows only the readable names leaves half of the page in YouTube's own palette, which is the wrong polarity whenever the theme
 * and YouTube's mode disagree. The twins were matched to their tokens by value pair (light/dark). A YouTube rebuild can rename
 * them: the e2e readability audit then fails, and the lasting fix is to list the new names under vars in the signed map.
 */
export const LOCAL_VARS = Object.freeze({
  bg: Object.freeze(['--t3e41d7b17b187f69']),
  surface: Object.freeze(['--t518e925f61bdcb91', '--tbdeaf5bc17152abc']),
  menu: Object.freeze(['--t08a7c6c176cbc5c2']),
  text: Object.freeze(['--tffc2fd3a644f6275', '--t1405e70a39276293']),
  muted: Object.freeze(['--t4a6da19e16bf221a', '--t7e34d5baa4ea6277']),
  accent: Object.freeze(['--t2d807bb79e75606d']),
  accentHover: Object.freeze(['--t617db776af0de196']),
  border: Object.freeze(['--t20480717de80f555', '--t416e5931fc464589']),
  borderOpaque: Object.freeze(['--td8562cdc203bc683']),
  overlay: Object.freeze(['--ta889dfda9605a358']),
  invertedText: Object.freeze(['--t6216186c28b3834b']),
  additive: Object.freeze(['--t7c4965c11f8537c0', '--t7f4f2c6d54836ce0']),
});

/** Own data property only: ignores the prototype chain and never runs a getter. */
function own(obj, key) {
  if (obj === null || typeof obj !== 'object') return undefined;
  const d = Object.getOwnPropertyDescriptor(obj, key);
  return d && 'value' in d ? d.value : undefined;
}

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const num = (v, fallback, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback);
const fmt = (n) => String(Math.round(n * 100) / 100);

/** Strict colour read: '#rrggbb' / '#rrggbbaa' or the fallback. */
function colour(raw, fallback) {
  const hex = toHex(parseColor(raw));
  return hex || fallback;
}

/** rgba() of an already-normalised hex colour at the given alpha. */
function withAlpha(hex, alpha) {
  const c = parseColor(hex);
  if (!c) return hex;
  return `rgba(${c.r},${c.g},${c.b},${fmt(alpha * c.a)})`;
}

/** Mixes two normalised hex colours in sRGB: `t` of `b` over `a`. Alpha is dropped (used for opaque accents). */
function mix(a, b, t) {
  const x = parseColor(a);
  const y = parseColor(b);
  if (!x || !y) return a;
  const ch = (p, q) => Math.round(p * (1 - t) + q * t);
  return toHex({ r: ch(x.r, y.r), g: ch(x.g, y.g), b: ch(x.b, y.b), a: 1 });
}

/**
 * The accent actually used. A user colour must be an opaque, readable colour with at least 3:1 against the
 * background (WCAG non-text contrast); anything else falls back to the theme's accent.
 * @param {string} themeAccent  normalised '#rrggbb' of the theme
 * @param {unknown} userAccent  settings.accent
 * @param {string} bg           normalised background
 * @returns {{accent:string, source:'theme'|'user', rejected:null|'unreadable'|'translucent'|'contrast', ratio:number|null}}
 */
export function resolveAccent(themeAccent, userAccent, bg) {
  if (userAccent === null || userAccent === undefined || userAccent === '') {
    return { accent: themeAccent, source: 'theme', rejected: null, ratio: null };
  }
  const c = parseColor(userAccent);
  if (!c) return { accent: themeAccent, source: 'theme', rejected: 'unreadable', ratio: null };
  if (c.a < 1) return { accent: themeAccent, source: 'theme', rejected: 'translucent', ratio: null };
  const hex = toHex(c);
  const ratio = contrastRatio(hex, bg);
  if (ratio === null || ratio < MIN_ACCENT_CONTRAST) return { accent: themeAccent, source: 'theme', rejected: 'contrast', ratio };
  return { accent: hex, source: 'user', rejected: null, ratio };
}

function fontStack(family) {
  const stack = typeof family === 'string' && Object.prototype.hasOwnProperty.call(FONT_STACKS || {}, family)
    ? FONT_STACKS[family] : own(FONT_STACKS, 'System');
  return typeof stack === 'string' && SAFE_FONT.test(stack) ? stack : FALLBACK_FONT;
}

function shadowFor(on, dark) {
  if (!on) return 'none';
  return dark
    ? '0 1px 2px rgba(0,0,0,0.5), 0 8px 24px rgba(0,0,0,0.45)'
    : '0 1px 2px rgba(20,20,30,0.12), 0 8px 24px rgba(20,20,30,0.14)';
}

/**
 * @param {object} theme  a validated, normalised theme (a hand-built one with missing fields is tolerated)
 * @param {{accent?:string|null, animations?:boolean}} [user]
 * @param {object} [map]  selector map; only `map.vars` is read
 * @returns {Record<string,string>} declarations in output order ('--cd-*', 'color-scheme', then bridged YouTube variables)
 */
export function deriveTokens(theme, user, map) {
  const tokens = own(theme, 'tokens');
  const colors = own(tokens, 'color');
  const type = own(tokens, 'type');
  const shape = own(tokens, 'shape');

  const bg = toHex(parseColor(own(colors, 'bg'), '#ffffff')) || FALLBACK.bg; // the page paints it, so never translucent
  const surface = colour(own(colors, 'surface'), FALLBACK.surface);
  const text = colour(own(colors, 'text'), FALLBACK.text);
  const muted = colour(own(colors, 'muted'), FALLBACK.muted);
  const border = colour(own(colors, 'border'), FALLBACK.border);
  const themeAccent = colour(own(colors, 'accent'), FALLBACK.accent);
  const { accent } = resolveAccent(themeAccent, own(user, 'accent'), bg);

  // Light or dark: whichever of white and black reads better on the background.
  const dark = (contrastRatio('#ffffff', bg) ?? 0) > (contrastRatio('#000000', bg) ?? 0);
  const menu = toHex(parseColor(surface, bg)) || surface; // popups must be opaque even over a translucent surface
  const accentText = pickReadableText(accent);

  const radius = Math.round(num(own(shape, 'radius'), 12, 0, 32));
  const spacing = Math.round(num(own(shape, 'spacing'), 3, 1, 5));
  const baseSize = num(own(type, 'baseSize'), 14, 12, 20); // the schema's own range
  const userScale = own(user, 'textScale');
  const scale = typeof userScale === 'number' && Number.isFinite(userScale) && userScale > 0 ? userScale : 1;
  const scaledSize = clamp(baseSize * scale, 11, 22);
  const weight = Math.round(num(own(type, 'headingWeight'), 700, 100, 900));
  const motion = own(user, 'animations') === false ? 0 : MOTION_MS;

  /** @type {Record<string,string>} */
  const out = {
    '--cd-bg': bg,
    '--cd-surface': surface,
    '--cd-menu': menu,
    '--cd-text': text,
    '--cd-muted': muted,
    '--cd-accent': accent,
    // Hover moves the accent AWAY from its label colour (lighter under black text, darker under white), so the
    // label never loses contrast on hover.
    '--cd-accent-hover': mix(accent, accentText === '#000000' ? '#ffffff' : '#000000', 0.16),
    '--cd-accent-text': accentText,
    '--cd-border': border,
    '--cd-hover': withAlpha(text, 0.08),
    '--cd-active': withAlpha(text, 0.14),
    '--cd-scrim': withAlpha(bg, 0.8),
    '--cd-radius': `${radius}px`,
    '--cd-shadow': shadowFor(own(shape, 'shadow') === true, dark),
    '--cd-space': `${SPACING_PX[spacing - 1]}px`,
    '--cd-font-family': fontStack(own(type, 'family')),
    '--cd-font-size': `${fmt(scaledSize)}px`,
    '--cd-font-scale': fmt(scaledSize / 14),
    '--cd-heading-weight': String(weight),
    '--cd-duration': `${motion}ms`,
    'color-scheme': dark ? 'dark' : 'light',
  };

  const vars = own(map, 'vars');
  let bridged = 0;
  for (const token of Object.keys(BRIDGE)) {
    const listed = own(vars, token); // own() is total: a missing or malformed map just contributes nothing
    const names = [...(Array.isArray(listed) ? listed : []), ...(own(LOCAL_VARS, token) || [])];
    for (const name of names) {
      if (bridged >= MAX_BRIDGED_VARS) break;
      if (typeof name !== 'string' || !VAR_NAME.test(name) || name.startsWith('--cd-') || AD_VAR.test(name)) continue;
      if (Object.prototype.hasOwnProperty.call(out, name)) continue;
      out[name] = BRIDGE[token];
      bridged++;
    }
  }
  return out;
}

/** True when a declaration value cannot end its declaration or rule early. Belt and braces: values are built above. */
const SAFE_VALUE = /^[^;{}<>\\@\n\r]*$/;

/**
 * One rule on html[cd-theme] (and its [dark] / :not([dark]) variants) holding every derived declaration.
 * @param {object} theme
 * @param {{accent?:string|null, animations?:boolean}} [user]
 * @param {object} [map]
 * @returns {string}
 */
export function buildTokenCss(theme, user, map) {
  const decls = [];
  for (const [prop, value] of Object.entries(deriveTokens(theme, user, map))) {
    if (typeof value !== 'string' || !SAFE_VALUE.test(value) || /url\(|expression\(|\/\*/i.test(value)) continue;
    decls.push(`${prop}:${value}`);
  }
  return `${TOKEN_SELECTOR}{${decls.join(';')}}`;
}
