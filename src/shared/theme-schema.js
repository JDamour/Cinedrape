// Theme format: strict validation + normalisation (ARCHITECTURE.md §3.3/§4, spec "Theme format").
//
// A theme is data. validateTheme builds a FRESH object from known keys only, so nothing the input
// carried that this version does not understand (unknown keys, __proto__ tricks, getters, extra
// colours) can reach the engine. It never throws and never mutates its input.
import { CALM_KEYS, LAYOUT_HOME, LAYOUT_WATCH, LIMITS } from './constants.js';
import { checkThemeContrast, contrastRatio, parseColor } from './contrast.js';
import { buildAllowList, validateCss } from './css-validator.js';

export const LATEST_SCHEMA = 1;

/** Font keys -> CSS font-family lists. System fonts only: nothing is downloaded. */
export const FONT_STACKS = Object.freeze({
  Inter: "Inter, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  System: "system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif",
  Serif: "Georgia, 'Times New Roman', serif",
  Mono: "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace",
  Rounded: "ui-rounded, 'SF Pro Rounded', 'Hiragino Maru Gothic ProN', Quicksand, Nunito, 'Segoe UI', system-ui, sans-serif",
  Condensed: "'Arial Narrow', 'Roboto Condensed', 'Helvetica Neue Condensed', 'Franklin Gothic Medium', 'Segoe UI', system-ui, sans-serif",
});

/**
 * @typedef {Object} NormalizedTheme
 * @property {number} schema
 * @property {string} id @property {string} name @property {string} author @property {string} version
 * @property {'free'|'pro'} tier
 * @property {{color:{bg:string,surface:string,text:string,muted:string,accent:string,border:string},
 *   type:{family:string,baseSize:number,headingWeight:number},
 *   shape:{radius:number,shadow:boolean,spacing:number}}} tokens
 * @property {{home:string,watch:string,density:number}} layout
 * @property {Record<string, boolean>} calm   only the keys the theme set
 * @property {string} css                     NOT validated unless validateTheme got a selectorMap
 * @typedef {{path:string, message:string, line?:number, column?:number}} Issue   path '' is the document root
 */

const MAX_REPORTED = 50;       // errors and warnings are each capped; a hostile file must not flood the UI
const MAX_KEYS = 200;          // per object
const MAX_COLOR_CHARS = 64;
const MAX_TEXT_CHARS = 64;     // name, author
const MAX_VERSION_CHARS = 32;
const RESERVED_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const RESERVED_IDS = new Set(['constructor', 'prototype']);   // would shadow Object members in a plain-object lookup

const ID_RE = /^[a-z0-9-]{2,40}$/;
const VERSION_RE = /^\d{1,6}\.\d{1,6}(?:\.\d{1,6})?(?:[-+][0-9A-Za-z][0-9A-Za-z.+-]*)?$/;
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FN_COLOR_RE = /^(?:rgb|hsl)a?\(/i;
const CSS_WS_RE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
// C0/C1 controls, bidi marks and overrides: never legitimate in a display name.
const BAD_TEXT_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/;

const COLOR_KEYS = ['bg', 'surface', 'text', 'muted', 'accent', 'border'];
const TOP_KEYS = ['schema', 'id', 'name', 'author', 'version', 'tier', 'tokens', 'layout', 'calm', 'css'];
const SHAPE_DEFAULTS = { radius: 12, shadow: false, spacing: 3 };
const LAYOUT_DEFAULTS = { home: 'grid', watch: 'default', density: 3 };

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const at = (base, key) => (base ? `${base}.${key}` : key);

/** Plain JSON-like object, also across realms (jsdom, iframes); rejects arrays, Map, Date, class instances. */
function isPlain(v) {
  if (v === null || typeof v !== 'object' || Object.prototype.toString.call(v) !== '[object Object]') return false;
  const proto = Object.getPrototypeOf(v);
  return proto === null || Object.getPrototypeOf(proto) === null;
}

/** UTF-8 size without allocating; lone surrogates count 3 bytes, as TextEncoder's U+FFFD does. */
export function utf8ByteLength(s) {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

function createReport() {
  const errors = [];
  const warnings = [];
  const seen = new Set();
  const push = (list, issue) => {
    if (list.length < MAX_REPORTED) list.push(issue);
    else if (list.length === MAX_REPORTED) list.push({ path: '', message: 'Too many problems; the rest are not listed.' });
  };
  return {
    errors,
    warnings,
    // One complaint per path (a getter is both 'not plain' and 'missing'); css may carry many, one per line.
    err: (path, message, extra) => {
      if (path !== 'css' && seen.has(path)) return;
      seen.add(path);
      push(errors, { path, message, ...extra });
    },
    warn: (path, message) => push(warnings, { path, message }),
  };
}

/**
 * Copies an object's own enumerable DATA properties into a null-prototype snapshot, so later reads
 * cannot hit the prototype chain or run a getter. Reports reserved keys and accessors. Returns null
 * (after reporting) when `v` is not a plain object, or has absurdly many keys.
 */
function open(v, path, rep) {
  if (!isPlain(v)) {
    rep.err(path, 'Must be an object.');
    return null;
  }
  const keys = Object.keys(v);
  if (keys.length > MAX_KEYS) {
    rep.err(path, `Has too many keys (more than ${MAX_KEYS}).`);
    return null;
  }
  const snap = Object.create(null);
  for (const k of keys) {
    if (RESERVED_KEYS.has(k)) {
      rep.err(at(path, k), 'Reserved key is not allowed.');
      continue;
    }
    const d = Object.getOwnPropertyDescriptor(v, k);
    if (!d || !('value' in d)) {
      rep.err(at(path, k), 'Must be a plain value, not a getter.');
      continue;
    }
    snap[k] = d.value;
  }
  return snap;
}

function warnUnknown(snap, known, path, rep) {
  for (const k of Object.keys(snap)) {
    if (!known.includes(k)) rep.warn(at(path, k), 'Unknown field was ignored.');
  }
}

/** An optional or required nested object: returns its snapshot, or null (error already reported) / undefined (absent, optional). */
function section(snap, key, path, rep, required) {
  const v = snap[key];
  if (v === undefined) {
    if (required) rep.err(path, 'Required.');
    return required ? null : undefined;
  }
  return open(v, path, rep);
}

function text(v, path, rep, max) {
  if (v === undefined) return void rep.err(path, 'Required.');
  if (typeof v !== 'string') return void rep.err(path, 'Must be a string.');
  if (v.length > max * 4) return void rep.err(path, `Must be at most ${max} characters.`);
  const s = v.replace(CSS_WS_RE, '');
  if (s.length === 0) return void rep.err(path, 'Must not be empty.');
  if (s.length > max) return void rep.err(path, `Must be at most ${max} characters.`);
  if (BAD_TEXT_RE.test(s)) return void rep.err(path, 'Must not contain control or direction-override characters.');
  return s;
}

function number(v, path, rep, lo, hi, { int = false, step = 0 } = {}) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return void rep.err(path, 'Must be a finite number.');
  const range = `from ${lo} to ${hi}`;
  if (int && !Number.isInteger(v)) return void rep.err(path, `Must be a whole number ${range}.`);
  if (v < lo || v > hi) return void rep.err(path, `Must be ${int ? 'a whole number' : 'a number'} ${range}.`);
  if (step && v % step !== 0) return void rep.err(path, `Must be a multiple of ${step} ${range}.`);
  return v === 0 ? 0 : v;   // -0 -> 0
}

function colour(v, path, rep) {
  if (v === undefined) return void rep.err(path, 'Required.');
  const why = 'Must be a colour: #rgb, #rrggbb, #rrggbbaa, rgb(), rgba(), hsl() or hsla() (no names, var() or url()).';
  if (typeof v !== 'string' || v.length > MAX_COLOR_CHARS * 2) return void rep.err(path, why);
  const s = v.replace(CSS_WS_RE, '');
  const ok = s.length <= MAX_COLOR_CHARS && (HEX_COLOR_RE.test(s) || (FN_COLOR_RE.test(s) && parseColor(s) !== null));
  if (!ok) return void rep.err(path, why);
  return s;
}

function oneOf(v, allowed, path, rep) {
  if (v === undefined) return void rep.err(path, 'Required.');
  if (typeof v !== 'string' || !allowed.includes(v)) return void rep.err(path, `Must be one of: ${allowed.join(', ')}.`);
  return v;
}

/** Flat list of selectors a theme must never hide, cover or fade (§6). */
function protectedSelectorsOf(map) {
  const p = map && typeof map === 'object' ? map.protected : null;
  const out = [];
  for (const group of ['ads', 'sponsor', 'playerControls']) {
    const list = p && p[group];
    if (Array.isArray(list)) for (const s of list) if (typeof s === 'string') out.push(s);
  }
  return out;
}

/** Runs the CSS validator when a selector map was supplied. Fails closed: if it cannot run, that is an error. */
function checkCss(css, opts, rep) {
  const map = opts.selectorMap;
  if (map === undefined || map === null) return false;
  if (css === '') return true;
  const tools = opts.cssValidator || { validateCss, buildAllowList };
  let result;
  try {
    result = tools.validateCss(css, { allowList: tools.buildAllowList(map), protectedSelectors: protectedSelectorsOf(map) });
  } catch {
    rep.err('css', 'The CSS could not be checked because the selector map is unusable.');
    return true;
  }
  if (!result || typeof result !== 'object') {
    rep.err('css', 'The CSS could not be checked.');
    return true;
  }
  if (result.ok === true) return true;
  const list = Array.isArray(result.errors) ? result.errors : [];
  if (list.length === 0) rep.err('css', 'The CSS was refused by the validator.');
  for (const e of list) {
    const msg = e && typeof e.message === 'string' ? e.message : 'Not allowed.';
    const line = e && Number.isInteger(e.line) && e.line >= 1 ? e.line : undefined;
    const column = e && Number.isInteger(e.column) && e.column >= 1 ? e.column : undefined;
    rep.err('css', line ? `Line ${line}: ${msg}` : msg, { ...(line && { line }), ...(column && { column }) });
  }
  return true;
}

/**
 * The colours become --cd-text / --cd-muted / --cd-bg and are bridged onto YouTube's own text and background variables, so a theme
 * whose text equals its background (or is transparent) would make every page text, ad titles and the "Sponsored" label included,
 * unreadable. Section 6 of the contract: a theme is refused unless it reads. Errors name the foreground colour that fails.
 */
function enforceContrast(colors, rep) {
  if (!COLOR_KEYS.every((k) => typeof colors[k] === 'string')) return;   // a colour that did not parse was already reported
  for (const k of ['bg', 'text', 'muted']) {
    const c = parseColor(colors[k]);
    if (c && c.a < 1) rep.err(at('tokens.color', k), `Must be fully opaque (no alpha): the page background and the text on it cannot depend on what is behind them.`);
  }
  for (const r of checkThemeContrast({ tokens: { color: colors } })) {
    if (r.pass) continue;
    const [fg, base] = r.pair.split('/');
    const got = r.ratio === null ? 'could not be measured' : `is ${r.ratio}:1`;
    rep.err(at('tokens.color', fg), `Contrast of ${fg} on ${base} ${got}; at least ${r.required}:1 is required (WCAG AA) so the text stays readable.`);
  }
  const onSurface = contrastRatio(colors.accent, colors.surface, colors.bg);
  if (onSurface !== null && onSurface < 3) {
    rep.err(at('tokens.color', 'accent'), `Contrast of accent on surface is ${Math.floor(onSurface * 100) / 100}:1; at least 3:1 is required.`);
  }
}

// MIGRATIONS[n] upgrades a schema-n theme to n + 1. Schema 1 is the first, so there are none yet.
const MIGRATIONS = Object.create(null);

/**
 * Brings an older theme up to LATEST_SCHEMA. Pure; v1 is the identity (returns the same object).
 * @returns {{ok:true, theme:object, errors:[]} | {ok:false, theme:null, errors:Issue[]}}
 */
export function migrateTheme(input) {
  const fail = (path, message) => ({ ok: false, theme: null, errors: [{ path, message }] });
  try {
    if (!isPlain(input)) return fail('', 'Theme must be a JSON object.');
    const d = Object.getOwnPropertyDescriptor(input, 'schema');
    if (!d) return fail('schema', 'Missing "schema" version number (this version of Cinedrape writes schema 1).');
    if (!('value' in d)) return fail('schema', 'Must be a plain value, not a getter.');
    const schema = d.value;
    if (!Number.isInteger(schema) || schema < 1) return fail('schema', 'Must be a whole number, 1 or higher.');
    if (schema > LATEST_SCHEMA) {
      return fail('schema', `This theme was made for a newer version of Cinedrape (schema ${schema}); this version understands up to schema ${LATEST_SCHEMA}. Update Cinedrape to use it.`);
    }
    let theme = input;
    for (let v = schema; v < LATEST_SCHEMA; v++) {
      if (typeof MIGRATIONS[v] !== 'function') return fail('schema', `No way to upgrade schema ${v} themes.`);
      theme = MIGRATIONS[v](theme);
    }
    return { ok: true, theme, errors: [] };
  } catch {
    return fail('', 'The theme could not be read.');
  }
}

function normalise(raw, opts, rep) {
  const top = open(raw, '', rep);
  if (!top) return { theme: null, cssValidated: false };
  warnUnknown(top, TOP_KEYS, '', rep);

  const out = { schema: LATEST_SCHEMA };

  const id = top.id;
  if (id === undefined) rep.err('id', 'Required.');
  else if (typeof id !== 'string' || !ID_RE.test(id)) rep.err('id', 'Must be a slug: 2 to 40 characters of a-z, 0-9 and "-".');
  else if (RESERVED_IDS.has(id)) rep.err('id', 'This id is reserved.');
  else out.id = id;

  out.name = text(top.name, 'name', rep, MAX_TEXT_CHARS);
  out.author = text(top.author, 'author', rep, MAX_TEXT_CHARS);

  const ver = top.version;
  if (ver === undefined) rep.err('version', 'Required.');
  else if (typeof ver !== 'string' || ver.length > MAX_VERSION_CHARS || !VERSION_RE.test(ver)) {
    rep.err('version', 'Must look like 1.0.0 (or 1.0, optionally with a suffix such as -beta.1).');
  } else out.version = ver;

  out.tier = oneOf(top.tier, ['free', 'pro'], 'tier', rep);

  // tokens ------------------------------------------------------------------------------------
  const tokens = section(top, 'tokens', 'tokens', rep, true);
  const tk = { color: undefined, type: undefined, shape: undefined };
  if (tokens) {
    warnUnknown(tokens, ['color', 'type', 'shape'], 'tokens', rep);

    const color = section(tokens, 'color', 'tokens.color', rep, true);
    if (color) {
      warnUnknown(color, COLOR_KEYS, 'tokens.color', rep);
      tk.color = {};
      for (const k of COLOR_KEYS) tk.color[k] = colour(color[k], at('tokens.color', k), rep);
      enforceContrast(tk.color, rep);
    }

    const type = section(tokens, 'type', 'tokens.type', rep, true);
    if (type) {
      warnUnknown(type, ['family', 'baseSize', 'headingWeight'], 'tokens.type', rep);
      const fam = type.family;
      let family;
      if (fam === undefined) rep.err('tokens.type.family', 'Required.');
      else if (typeof fam !== 'string' || !hasOwn(FONT_STACKS, fam)) {
        rep.err('tokens.type.family', `Must be one of: ${Object.keys(FONT_STACKS).join(', ')}.`);
      } else family = fam;
      const baseSize = type.baseSize === undefined
        ? void rep.err('tokens.type.baseSize', 'Required.')
        : number(type.baseSize, 'tokens.type.baseSize', rep, 12, 20);
      const headingWeight = type.headingWeight === undefined
        ? void rep.err('tokens.type.headingWeight', 'Required.')
        : number(type.headingWeight, 'tokens.type.headingWeight', rep, 100, 900, { int: true, step: 100 });
      tk.type = { family, baseSize, headingWeight };
    }

    const shape = section(tokens, 'shape', 'tokens.shape', rep, false);
    tk.shape = { ...SHAPE_DEFAULTS };
    if (shape) {
      warnUnknown(shape, ['radius', 'shadow', 'spacing'], 'tokens.shape', rep);
      if (shape.radius !== undefined) tk.shape.radius = number(shape.radius, 'tokens.shape.radius', rep, 0, 32);
      if (shape.shadow !== undefined) {
        if (typeof shape.shadow === 'boolean') tk.shape.shadow = shape.shadow;
        else rep.err('tokens.shape.shadow', 'Must be true or false.');
      }
      if (shape.spacing !== undefined) tk.shape.spacing = number(shape.spacing, 'tokens.shape.spacing', rep, 1, 5, { int: true });
    }
  }
  out.tokens = { color: tk.color, type: tk.type, shape: tk.shape };

  // layout ------------------------------------------------------------------------------------
  out.layout = { ...LAYOUT_DEFAULTS };
  const layout = section(top, 'layout', 'layout', rep, false);
  if (layout) {
    warnUnknown(layout, ['home', 'watch', 'density'], 'layout', rep);
    if (layout.home !== undefined) out.layout.home = oneOf(layout.home, LAYOUT_HOME, 'layout.home', rep);
    if (layout.watch !== undefined) out.layout.watch = oneOf(layout.watch, LAYOUT_WATCH, 'layout.watch', rep);
    if (layout.density !== undefined) out.layout.density = number(layout.density, 'layout.density', rep, 1, 5, { int: true });
  }

  // calm --------------------------------------------------------------------------------------
  out.calm = {};
  const calm = section(top, 'calm', 'calm', rep, false);
  if (calm) {
    for (const k of Object.keys(calm)) {
      if (!CALM_KEYS.includes(k)) rep.warn(at('calm', k), 'Unknown field was ignored.');
      else if (typeof calm[k] !== 'boolean') rep.err(at('calm', k), 'Must be true or false.');
      else out.calm[k] = calm[k];
    }
  }

  // css ---------------------------------------------------------------------------------------
  out.css = '';
  let cssValidated = false;
  const css = top.css;
  if (css !== undefined) {
    if (typeof css !== 'string') rep.err('css', 'Must be a string.');
    else if (css.length > LIMITS.cssMaxBytes || utf8ByteLength(css) > LIMITS.cssMaxBytes) {
      // UTF-8 is never shorter than UTF-16 code units, so the length test above rejects huge input without scanning it.
      rep.err('css', `Must be at most ${LIMITS.cssMaxBytes} bytes (${LIMITS.cssMaxBytes / 1024} KB) of UTF-8.`);
    } else {
      out.css = css;
      cssValidated = checkCss(css, opts, rep);
    }
  } else cssValidated = opts.selectorMap !== undefined && opts.selectorMap !== null;

  return { theme: out, cssValidated };
}

/**
 * Validates and normalises a theme. Never throws, never mutates `input`.
 *
 * Errors make `ok` false and `theme` null. Unknown keys are warnings and are dropped from `theme`.
 * Pass `opts.selectorMap` to also run the CSS validator (errors then carry `line`/`column` and a
 * message naming the line); without it the CSS is only size-checked and `cssValidated` is false, so
 * the engine must validate it before injecting. `opts.cssValidator` swaps in another
 * `{validateCss, buildAllowList}` (used by tests).
 * @param {unknown} input
 * @param {{selectorMap?: object, cssValidator?: {validateCss: Function, buildAllowList: Function}}} [opts]
 * @returns {{ok: boolean, errors: Issue[], warnings: Issue[], theme: NormalizedTheme|null, cssValidated: boolean}}
 */
export function validateTheme(input, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const rep = createReport();
  let theme = null;
  let cssValidated = false;
  try {
    const migrated = migrateTheme(input);
    if (!migrated.ok) for (const e of migrated.errors) rep.err(e.path, e.message);
    else ({ theme, cssValidated } = normalise(migrated.theme, options, rep));
  } catch {
    rep.err('', 'The theme could not be read.');
  }
  const ok = rep.errors.length === 0 && theme !== null;
  return { ok, errors: rep.errors, warnings: rep.warnings, theme: ok ? theme : null, cssValidated };
}

/**
 * Serialises a theme into a valid Schema v1 JSON string.
 * Optionally incorporates user overrides (custom accent, density, layouts, calm, css).
 *
 * @param {object} theme - NormalizedTheme or bundled theme
 * @param {object} [overrides] - optional user overrides
 * @returns {string} Formatted JSON string
 */
export function exportTheme(theme, overrides = {}) {
  if (!theme || typeof theme !== 'object') {
    throw new TypeError('exportTheme requires a theme object');
  }
  const ov = overrides && typeof overrides === 'object' ? overrides : {};
  const id = typeof ov.id === 'string' && ov.id ? ov.id : (typeof theme.id === 'string' ? theme.id : 'custom-theme');
  const name = typeof ov.name === 'string' && ov.name ? ov.name : (typeof theme.name === 'string' ? theme.name : 'Custom Theme');
  const author = typeof ov.author === 'string' && ov.author ? ov.author : (typeof theme.author === 'string' ? theme.author : 'User');
  const version = typeof ov.version === 'string' && ov.version ? ov.version : (typeof theme.version === 'string' ? theme.version : '1.0.0');
  const tier = (ov.tier === 'pro' || ov.tier === 'free') ? ov.tier : (theme.tier === 'pro' ? 'pro' : 'free');

  const baseTokens = theme.tokens && typeof theme.tokens === 'object' ? theme.tokens : {};
  const baseColor = baseTokens.color && typeof baseTokens.color === 'object' ? baseTokens.color : {};
  const baseType = baseTokens.type && typeof baseTokens.type === 'object' ? baseTokens.type : {};
  const baseShape = baseTokens.shape && typeof baseTokens.shape === 'object' ? baseTokens.shape : {};

  const tokens = {
    color: {
      bg: baseColor.bg || '#0b0b0f',
      surface: baseColor.surface || '#16161f',
      text: baseColor.text || '#f2f2f5',
      muted: baseColor.muted || '#9a9aa8',
      accent: ov.accent || baseColor.accent || '#e8b04a',
      border: baseColor.border || '#656572',
    },
    type: {
      family: baseType.family || 'System',
      baseSize: typeof baseType.baseSize === 'number' ? baseType.baseSize : 14,
      headingWeight: typeof baseType.headingWeight === 'number' ? baseType.headingWeight : 600,
    },
    shape: {
      radius: typeof baseShape.radius === 'number' ? baseShape.radius : 10,
      shadow: typeof baseShape.shadow === 'boolean' ? baseShape.shadow : true,
      spacing: typeof baseShape.spacing === 'number' ? baseShape.spacing : 3,
    },
  };

  const baseLayout = theme.layout && typeof theme.layout === 'object' ? theme.layout : {};
  const layout = {
    home: ov.home || baseLayout.home || 'grid',
    watch: ov.watch || baseLayout.watch || 'default',
    density: (ov.density !== undefined && ov.density !== null) ? ov.density : (baseLayout.density || 3),
  };

  const baseCalm = theme.calm && typeof theme.calm === 'object' ? theme.calm : {};
  const calm = { ...baseCalm, ...(ov.calm && typeof ov.calm === 'object' ? ov.calm : {}) };

  const css = typeof ov.css === 'string' ? ov.css : (typeof theme.css === 'string' ? theme.css : '');

  const exported = {
    schema: 1,
    id,
    name,
    author,
    version,
    tier,
    tokens,
    layout,
    calm,
    css,
  };

  return JSON.stringify(exported, null, 2);
}

/**
 * Parses and validates an imported theme JSON string.
 *
 * @param {string} jsonString - raw JSON string
 * @param {object} [opts] - validation options forwarded to validateTheme
 * @returns {{ ok: boolean, errors: Issue[], warnings: Issue[], theme: NormalizedTheme|null, cssValidated: boolean }}
 */
export function importTheme(jsonString, opts = {}) {
  if (typeof jsonString !== 'string') {
    return {
      ok: false,
      errors: [{ path: '', message: 'Imported theme must be a JSON string.' }],
      warnings: [],
      theme: null,
      cssValidated: false,
    };
  }

  const maxBytes = LIMITS.maxCustomThemeBytes || 65536;
  if (jsonString.length > maxBytes || utf8ByteLength(jsonString) > maxBytes) {
    return {
      ok: false,
      errors: [{ path: '', message: `Theme exceeds maximum allowed size of ${maxBytes / 1024} KB.` }],
      warnings: [],
      theme: null,
      cssValidated: false,
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      ok: false,
      errors: [{ path: '', message: `Invalid JSON: ${err.message}` }],
      warnings: [],
      theme: null,
      cssValidated: false,
    };
  }

  return validateTheme(parsed, opts);
}

