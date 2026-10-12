// WCAG 2.2 colour maths. Pure: no DOM, no chrome.*.
//
// parseColor is deliberately strict: it returns null for anything it cannot read EXACTLY
// (out-of-range channels, mixed units, named colours, var(), calc(), exponents, junk), so the
// theme schema can use it as the single gatekeeper for colour strings.

/** @typedef {{r:number, g:number, b:number, a:number}} Rgba  r/g/b are integers 0..255, a is 0..1 */

const MAX_COLOR_CHARS = 64;
const WHITE = Object.freeze({ r: 255, g: 255, b: 255, a: 1 });
const BLACK = Object.freeze({ r: 0, g: 0, b: 0, a: 1 });

// CSS whitespace only (not JS \s, which also matches NBSP, BOM, U+2028 ...).
const TRIM_RE = /^[ \t\n\r\f]+|[ \t\n\r\f]+$/g;
const SPLIT_RE = /[ \t\n\r\f]+/;
const HEX_RE = /^#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FN_RE = /^(rgba?|hsla?)\(([^()]*)\)$/i;
const NUM_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/;
const PCT_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%$/;
const ANGLE_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|grad|rad|turn)?$/i;

const num = (t) => (NUM_RE.test(t) ? Number(t) : null);
const pct = (t) => (PCT_RE.test(t) ? Number(t.slice(0, -1)) : null);
const inRange = (v, lo, hi) => Number.isFinite(v) && v >= lo && v <= hi;

function parseAlpha(tok) {
  if (tok === undefined) return 1;
  const n = num(tok);
  if (n !== null) return inRange(n, 0, 1) ? n : null;
  const p = pct(tok);
  if (p !== null) return inRange(p, 0, 100) ? p / 100 : null;
  return null;
}

function parseAngle(tok) {
  const m = ANGLE_RE.exec(tok);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const unit = (m[2] || 'deg').toLowerCase();
  const deg = unit === 'deg' ? v : unit === 'grad' ? v * 0.9 : unit === 'rad' ? (v * 180) / Math.PI : v * 360;
  return ((deg % 360) + 360) % 360;
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = l - c / 2;
  return [r + m, g + m, b + m].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255));
}

function parseHex(s) {
  const m = HEX_RE.exec(s);
  if (!m) return null;
  let h = m[1];
  if (h.length <= 4) h = h.replace(/./g, (c) => c + c);
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r, g, b, a };
}

function parseFunctional(s) {
  const m = FN_RE.exec(s);
  if (!m) return null;
  const isRgb = m[1].toLowerCase().startsWith('rgb');
  const body = m[2].replace(TRIM_RE, '');
  let parts;
  let alphaTok;
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    parts = body.split(',').map((t) => t.replace(TRIM_RE, ''));
    if (parts.length === 4) alphaTok = parts.pop();
    else if (parts.length !== 3) return null;
  } else {
    const halves = body.split('/');
    if (halves.length > 2) return null;
    parts = halves[0].replace(TRIM_RE, '').split(SPLIT_RE);
    if (parts.length !== 3) return null;
    if (halves.length === 2) alphaTok = halves[1].replace(TRIM_RE, '');
  }
  if (parts.some((t) => t === '') || alphaTok === '') return null;
  const a = parseAlpha(alphaTok);
  if (a === null) return null;

  if (isRgb) {
    const ns = parts.map(num);
    const ps = parts.map(pct);
    let ch;
    if (ns.every((v) => v !== null)) ch = ns;
    else if (ps.every((v) => v !== null)) ch = ps.map((v) => (inRange(v, 0, 100) ? (v * 255) / 100 : NaN));
    else return null;
    if (!ch.every((v) => inRange(v, 0, 255))) return null;
    return { r: Math.round(ch[0]), g: Math.round(ch[1]), b: Math.round(ch[2]), a };
  }

  const h = parseAngle(parts[0]);
  const sat = pct(parts[1]);
  const lig = pct(parts[2]);
  if (h === null || sat === null || lig === null) return null;
  if (!inRange(sat, 0, 100) || !inRange(lig, 0, 100)) return null;
  const [r, g, b] = hslToRgb(h, sat / 100, lig / 100);
  return { r, g, b, a };
}

function isRgbaLike(v) {
  return v !== null && typeof v === 'object' && inRange(v.r, 0, 255) && inRange(v.g, 0, 255) && inRange(v.b, 0, 255);
}

function normRgba(v) {
  return { r: Math.round(v.r), g: Math.round(v.g), b: Math.round(v.b), a: inRange(v.a, 0, 1) ? v.a : 1 };
}

/** Anything parseColor accepts, plus an already-parsed {r,g,b,a?}. Returns a fresh Rgba or null. */
function toRgba(input) {
  if (typeof input === 'string') return parseColor(input);
  return isRgbaLike(input) ? normRgba(input) : null;
}

function over(fg, bg) {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b, a: 1 };
  const mix = (f, b) => Math.round(f * fg.a + b * (1 - fg.a));
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: 1 };
}

/** Flattens `bg` onto `canvas` (opaque), then `fg` onto that. Both inputs are Rgba. */
function flatten(fg, bg, canvas) {
  return over(fg, over(bg, canvas));
}

/**
 * Reads a CSS colour: #rgb #rgba #rrggbb #rrggbbaa, rgb()/rgba(), hsl()/hsla() in the legacy comma
 * and the modern space/slash syntax, hue in deg|grad|rad|turn, alpha as number or percentage.
 * Returns null for everything else (named colours, var(), calc(), `none`, out-of-range values,
 * mixed number/percentage channels, strings over 64 characters, non-strings).
 *
 * With `background`, a translucent colour is composited onto it and the result is opaque (a = 1).
 * A translucent `background` is first flattened onto white, the browser's default canvas.
 * @param {string} input
 * @param {string|Rgba} [background]
 * @returns {Rgba|null}
 */
export function parseColor(input, background) {
  if (typeof input !== 'string' || input.length > MAX_COLOR_CHARS + 16) return null;
  const s = input.replace(TRIM_RE, '');
  if (s.length === 0 || s.length > MAX_COLOR_CHARS) return null;
  const c = s.charCodeAt(0) === 35 ? parseHex(s) : parseFunctional(s);
  if (!c) return null;
  if (background === undefined) return c;
  const bg = toRgba(background);
  if (!bg) return null;
  return flatten(c, bg, WHITE);
}

/** '#rrggbb' for an opaque colour, '#rrggbbaa' when translucent; null when unreadable. */
export function toHex(input) {
  const c = toRgba(input);
  if (!c) return null;
  const h = (v) => v.toString(16).padStart(2, '0');
  const alpha = c.a < 1 ? h(Math.round(c.a * 255)) : '';
  return `#${h(c.r)}${h(c.g)}${h(c.b)}${alpha}`;
}

const lin = (v) => {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/**
 * WCAG 2.2 relative luminance (0 = black, 1 = white). Alpha is ignored unless `background` is
 * given, in which case the colour is composited onto it first. Null when unreadable.
 * @param {string|Rgba} color
 * @param {string|Rgba} [background]
 */
export function relativeLuminance(color, background) {
  let c = toRgba(color);
  if (!c) return null;
  if (background !== undefined) {
    const bg = toRgba(background);
    if (!bg) return null;
    c = flatten(c, bg, WHITE);
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

function ratioOf(l1, l2) {
  const hi = Math.max(l1, l2);
  const lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * WCAG contrast ratio, 1..21, NOT rounded (WCAG says 4.499 does not pass 4.5). A translucent
 * `b` is flattened onto `canvas` (default white); a translucent `a` is then flattened onto `b`.
 * Null if either colour is unreadable.
 * @param {string|Rgba} a
 * @param {string|Rgba} b
 * @param {string|Rgba} [canvas]
 */
export function contrastRatio(a, b, canvas = WHITE) {
  const fg = toRgba(a);
  const bg = toRgba(b);
  const cv = toRgba(canvas);
  if (!fg || !bg || !cv) return null;
  const under = over(bg, over(cv, WHITE));
  const top = over(fg, under);
  return ratioOf(relativeLuminance(top), relativeLuminance(under));
}

/**
 * '#000000' or '#ffffff', whichever contrasts more with `bg` (ties go to white). A translucent bg is
 * flattened onto `canvas` (default white). Unreadable input yields '#ffffff'.
 * @param {string|Rgba} bg
 * @param {string|Rgba} [canvas]
 * @returns {'#000000'|'#ffffff'}
 */
export function pickReadableText(bg, canvas = WHITE) {
  const c = toRgba(bg);
  const cv = toRgba(canvas);
  if (!c || !cv) return '#ffffff';
  const l = relativeLuminance(over(c, over(cv, WHITE)));
  return ratioOf(l, 0) > ratioOf(l, 1) ? '#000000' : '#ffffff';
}

const PAIRS = [
  ['text', 'bg', null, 4.5],
  ['text', 'surface', 'surface', 4.5],
  ['muted', 'bg', null, 4.5],
  ['muted', 'surface', 'surface', 4.5],
  ['accent', 'bg', null, 3],
  ['border', 'bg', null, 3],
];

const floor2 = (r) => Math.floor(r * 100 + 1e-9) / 100;

/**
 * Contract §4: text/bg, text/surface, muted/bg, muted/surface need 4.5:1; accent/bg and border/bg
 * need 3:1. Never throws; an unreadable or missing colour gives ratio null and pass false.
 *
 * Translucent colours are judged as painted: surface over bg, text over that. If the bg itself is
 * translucent the ratio is the worst case over a white and a black canvas, so a pass means the
 * pair is readable whatever shows through. `ratio` is floored to two decimals (the same rounding
 * the pass test uses); call contrastRatio for the exact value.
 * @param {{tokens?:{color?:Record<string,string>}}} theme
 * @returns {{pair:string, ratio:number|null, required:number, pass:boolean}[]}
 */
export function checkThemeContrast(theme) {
  const colors = theme && typeof theme === 'object' && theme.tokens && typeof theme.tokens === 'object'
    && theme.tokens.color && typeof theme.tokens.color === 'object' ? theme.tokens.color : {};
  const read = (k) => (Object.prototype.hasOwnProperty.call(colors, k) ? toRgba(colors[k]) : null);
  const bg = read('bg');
  const surface = read('surface');
  const canvases = bg && bg.a < 1 ? [WHITE, BLACK] : [WHITE];

  return PAIRS.map(([fgKey, baseKey, layerKey, required]) => {
    const pair = `${fgKey}/${baseKey}`;
    const fg = read(fgKey);
    const layer = layerKey ? surface : null;
    if (!fg || !bg || (layerKey && !layer)) return { pair, ratio: null, required, pass: false };
    let worst = Infinity;
    for (const canvas of canvases) {
      const base = over(bg, canvas);
      const under = layer ? over(layer, base) : base;
      worst = Math.min(worst, ratioOf(relativeLuminance(over(fg, under)), relativeLuminance(under)));
    }
    const ratio = floor2(worst);
    return { pair, ratio, required, pass: ratio >= required };
  });
}
