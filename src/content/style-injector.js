// Style injection and the first-paint cache (ARCHITECTURE.md section 4 and 5).
//
// apply(css) keeps exactly one <style id=STYLE_ID> under <html> (it works at document_start, when only documentElement exists)
// and replaces its text in one write, so the page never shows a half-updated look. If the browser did not turn the text into
// rules (a CSP that blocks inline styles), the same CSS goes into a constructable stylesheet in adoptedStyleSheets and the
// <style> is removed.
//
// The first-paint cache lives in the page's localStorage: {v:1, key, css, attrs?}. It is read synchronously at document_start so
// the previous look is there before YouTube paints; every access is in try/catch because storage can be blocked or full.
// `attrs` are the <html> attributes the css depends on (cd-home, cd-watch, cd-density, cd-motion, cd-calm-*): without them the
// cached css would paint a half-styled page until chrome.storage answers and the engine sets them. They are validated strictly
// (known names, closed value sets) because any script on the origin can write the key.
//
// What the cache is NOT: authenticated. At document_start the extension has no secret that page scripts do not also have, and it
// cannot wait for chrome.storage without losing the first paint, so a script on youtube.com can write any entry. The defences are
// structural: (1) the entry is only a stylesheet, filtered below, and is replaced by the engine's own composed css as soon as
// chrome.storage answers (milliseconds; applyAll rewrites the entry, failOpen and stop() clear it); (2) a page script on
// youtube.com can already add any style it likes, so a forged entry gains it nothing it did not have; (3) it carries no
// entitlement: Pro is decided from the signed licence, never from this value.
import { ALL_THEME_IDS, ATTR, CALM_KEYS, FEATURES, FIRST_PAINT_LS_KEY, LAYOUT_HOME, LAYOUT_WATCH, PAGE_TYPES, STYLE_ID } from '../shared/constants.js';

export const FIRST_PAINT_MAX_BYTES = 64 * 1024;

// The attributes a first-paint entry may carry, with the only values each may have. Calm flags are present-or-absent (value '').
// Names are lower case, as the browser reports them for an HTML document.
const ATTR_VALUES = new Map([
  [ATTR.home, new Set(LAYOUT_HOME)],
  [ATTR.watch, new Set(LAYOUT_WATCH)],
  [ATTR.density, new Set(['1', '2', '3', '4', '5'])],
  [ATTR.motion, new Set(['on', 'off'])],
  [ATTR.textScale, new Set(['0.9', '1', '1.1', '1.25', '1.5'])],
]);
for (const key of CALM_KEYS) ATTR_VALUES.set((ATTR.calmPrefix + key).toLowerCase(), new Set(['']));

/**
 * The attribute map if it is exactly a set of known attributes with allowed values, else null. One unknown name or value rejects
 * the whole set (a tampered entry is not partly trusted); the css of the entry is judged separately.
 * @returns {Record<string,string>|null}
 */
export function sanitizePaintAttrs(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const name of Object.keys(raw)) {
    const allowed = ATTR_VALUES.get(name);
    if (!allowed || !isString(raw[name]) || !allowed.has(raw[name])) return null;
    out[name] = raw[name];
  }
  return out;
}

/**
 * The health verdict if it matches the expected structure and allowed values, else null.
 * Validated strictly because any script on the origin can write to localStorage.
 * @returns {{mapVersion:string, themeId:string, broken:string[], pages:Record<string,string[]>, unreadable:boolean, at:number}|null}
 */
export function sanitizePaintVerdict(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  if (!isString(raw.mapVersion) || raw.mapVersion === '' || raw.mapVersion.length > 40) return null;
  if (!isString(raw.themeId) || !ALL_THEME_IDS.includes(raw.themeId)) return null;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at) || raw.at < 0) return null;
  const features = (list) => (Array.isArray(list) ? [...new Set(list.filter((f) => isString(f) && FEATURES.includes(f)))].sort() : []);
  const pages = {};
  if (raw.pages !== null && typeof raw.pages === 'object' && !Array.isArray(raw.pages)) {
    for (const key of Object.keys(raw.pages)) {
      if (PAGE_TYPES.includes(key) && Array.isArray(raw.pages[key])) {
        pages[key] = features(raw.pages[key]);
      }
    }
  }
  const broken = [...new Set([...features(raw.broken), ...Object.values(pages).flat()])].sort();
  return { mapVersion: raw.mapVersion, themeId: raw.themeId, broken, pages, unreadable: raw.unreadable === true, at: raw.at };
}

// The cache is a localStorage value any script on the origin can write, so refuse anything the theme validator would refuse
// at the coarsest level: imports, fonts, scripting hooks, an escape from <style>, and url() other than inline images.
const UNSAFE_CACHED_CSS = /@import|@font-face|@charset|@namespace|expression\s*\(|(?<![\w-])behaviou?r\s*:|-moz-binding|<\/style|url\(\s*(?!['"]?\s*(?:data:image\/(?:png|jpeg|webp|svg\+xml)|chrome-extension:))/i;
const QUOTED = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g;
const AT_WORD = /@([A-Za-z-]+)/g;
const CACHE_AT_RULES = new Set(['media', 'keyframes', '-webkit-keyframes', 'supports']);
// Declarations that take something off the screen. Every engine-built rule that has one carries the :not(:has(<ads>)) guard
// (contract section 6; test/ad-safety.test.js), so a cached rule that hides without it did not come from the engine.
const HIDING = /(?:^|[;\s{])(?:display\s*:\s*none|visibility\s*:\s*(?:hidden|collapse)|opacity\s*:\s*0(?![.\d])|(?:max-)?(?:height|width)\s*:\s*0(?![.\d%a-z])|clip(?:-path)?\s*:|content-visibility\s*:\s*hidden)/i;

/** True when some style rule hides, collapses or clips something and its selector does not carry the ad guard. @keyframes steps are not rules. */
function hasUnguardedHide(bare) {
  const stack = [];
  let start = 0;
  for (let i = 0; i < bare.length; i++) {
    const ch = bare[i];
    if (ch === '{') {
      stack.push({ head: bare.slice(start, i).trim(), from: i + 1, nested: false });
      if (stack.length > 1) stack[stack.length - 2].nested = true;
      start = i + 1;
    } else if (ch === '}') {
      const top = stack.pop();
      start = i + 1;
      if (!top || top.nested || top.head.startsWith('@')) continue;
      if (stack.some((s) => /^@(?:-webkit-)?keyframes/i.test(s.head))) continue;
      if (HIDING.test(bare.slice(top.from, i)) && !/:not\(\s*:has\(/.test(top.head)) return true;
    } else if (ch === ';' && stack.length === 0) {
      start = i + 1;
    }
  }
  return false;
}

/**
 * True when a cached stylesheet must not be applied. The plain list above cannot see through CSS escapes (`@\69mport`, `u\72l(`) or
 * `image-set("https://...")`, so on top of it: any backslash outside a quoted string (the engine's own css has one, inside
 * `content:"\2022"`), any `image-set(`, any unterminated quote and any at-rule other than @media / @keyframes / @supports; and a
 * rule that hides or collapses something without the ad guard (a forged entry that blanks an ad slot for the first moments).
 * This is a filter, not authentication: see the note at the top of this file.
 */
export function isUnsafeCachedCss(css) {
  if (!isString(css)) return true;
  if (UNSAFE_CACHED_CSS.test(css)) return true;
  const bare = css.replace(QUOTED, 'S').replace(/\/\*[\s\S]*?\*\//g, '');
  if (bare.includes('\\') || bare.includes('"') || bare.includes("'")) return true;
  if (/image-set\s*\(/i.test(bare)) return true;
  for (const m of bare.matchAll(AT_WORD)) if (!CACHE_AT_RULES.has(m[1].toLowerCase())) return true;
  return hasUnguardedHide(bare);
}

const isString = (v) => typeof v === 'string';

/**
 * @param {{doc: Document, win?: Window}} deps
 * @returns {{apply(css:string): 'style'|'adopted'|'none', remove(): void, mode(): 'style'|'adopted'|'none',
 *   readFirstPaint(): ({key:string, css:string, attrs?:Record<string,string>, verdict?:object}|null),
 *   writeFirstPaint(key:string, css:string, attrs?:Record<string,string>, verdict?:object): boolean,
 *   writeFirstPaintVerdict(verdict?:object|null): boolean, clearFirstPaint(): void}}
 */
export function createStyleInjector({ doc, win } = {}) {
  if (!doc) throw new TypeError('createStyleInjector({doc}) needs a document');
  const view = win || doc.defaultView;
  let style = null;          // the <style> this injector put (or adopted) in the page
  let sheet = null;          // the constructable stylesheet while the CSP fallback is active
  let lastCss = '';
  let currentMode = 'none';

  const root = () => doc.documentElement;
  const storage = () => {
    try { return view && view.localStorage ? view.localStorage : null; } catch { return null; }
  };

  function ownStyle() {
    if (style && style.isConnected) return style;
    // A leftover from a previous content script (extension reloaded) is taken over, never duplicated.
    const old = doc.getElementById(STYLE_ID);
    if (old && old.localName === 'style') { style = old; return style; }
    const parent = root();
    if (!parent) return null;
    style = doc.createElement('style');
    style.id = STYLE_ID;
    parent.appendChild(style);
    return style;
  }

  const hasRules = (el) => {
    try { return !!(el.sheet && el.sheet.cssRules && el.sheet.cssRules.length > 0); } catch { return false; }
  };

  function dropAdopted() {
    if (!sheet) return;
    try {
      if (doc.adoptedStyleSheets) doc.adoptedStyleSheets = Array.from(doc.adoptedStyleSheets).filter((s) => s !== sheet);
    } catch { /* nothing to undo */ }
    sheet = null;
  }

  function adopt(css) {
    const Ctor = view && view.CSSStyleSheet;
    if (typeof Ctor !== 'function' || !('adoptedStyleSheets' in doc)) return false;
    try {
      const next = sheet || new Ctor();
      next.replaceSync(css);
      if (!next.cssRules || next.cssRules.length === 0) return false;
      if (!sheet) doc.adoptedStyleSheets = [...Array.from(doc.adoptedStyleSheets), next];
      sheet = next;
      return true;
    } catch {
      return false;
    }
  }

  function removeStyleElement() {
    if (style) { try { style.remove(); } catch { /* already gone */ } }
    style = null;
  }

  function apply(css) {
    const text = isString(css) ? css : '';
    if (text === '') { remove(); return 'none'; }
    if (text === lastCss && currentMode !== 'none') {
      if (currentMode === 'adopted' ? !!sheet : !!(style && style.isConnected)) return currentMode;
    }
    const el = currentMode === 'adopted' ? null : ownStyle();
    if (el) {
      if (el.textContent !== text) el.textContent = text;
      if (hasRules(el)) {
        dropAdopted();
        lastCss = text;
        currentMode = 'style';
        return currentMode;
      }
    }
    // The <style> produced no rules: CSP, or an engine that refuses the text. Try the constructable sheet.
    if (adopt(text)) {
      removeStyleElement();
      lastCss = text;
      currentMode = 'adopted';
      return currentMode;
    }
    lastCss = text;
    currentMode = el ? 'style' : 'none';
    return currentMode;
  }

  function remove() {
    removeStyleElement();
    dropAdopted();
    lastCss = '';
    currentMode = 'none';
  }

  function readFirstPaint() {
    try {
      const ls = storage();
      if (!ls) return null;
      const raw = ls.getItem(FIRST_PAINT_LS_KEY);
      if (!isString(raw) || raw === '' || raw.length > FIRST_PAINT_MAX_BYTES) return null;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || data.v !== 1) return null;
      if (!isString(data.key) || data.key === '' || !isString(data.css) || data.css === '') return null;
      if (data.css.length > FIRST_PAINT_MAX_BYTES || isUnsafeCachedCss(data.css)) return null;
      const out = { key: data.key, css: data.css };
      if (data.attrs !== undefined) {
        const attrs = sanitizePaintAttrs(data.attrs);
        if (attrs) out.attrs = attrs;
      }
      if (data.verdict !== undefined) {
        const verdict = sanitizePaintVerdict(data.verdict);
        if (verdict) out.verdict = verdict;
      }
      return out;
    } catch {
      return null;
    }
  }

  function writeFirstPaint(key, css, attrs, verdict) {
    try {
      const ls = storage();
      if (!ls || !isString(key) || key === '' || !isString(css) || css === '') return false;
      const cleanAttrs = attrs === undefined ? undefined : sanitizePaintAttrs(attrs);
      const cleanVerdict = verdict === undefined || verdict === null ? undefined : sanitizePaintVerdict(verdict);
      const entry = { v: 1, key, css };
      if (cleanAttrs) entry.attrs = cleanAttrs;
      if (cleanVerdict) entry.verdict = cleanVerdict;
      const raw = JSON.stringify(entry);
      if (raw.length > FIRST_PAINT_MAX_BYTES) { clearFirstPaint(); return false; }
      ls.setItem(FIRST_PAINT_LS_KEY, raw);
      return true;
    } catch {
      return false;
    }
  }

  function writeFirstPaintVerdict(verdict) {
    try {
      const ls = storage();
      if (!ls) return false;
      const raw = ls.getItem(FIRST_PAINT_LS_KEY);
      if (!isString(raw) || raw === '' || raw.length > FIRST_PAINT_MAX_BYTES) return false;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object' || data.v !== 1 || !isString(data.key) || !isString(data.css)) return false;
      const cleanVerdict = verdict === undefined || verdict === null ? undefined : sanitizePaintVerdict(verdict);
      if (cleanVerdict) data.verdict = cleanVerdict;
      else delete data.verdict;
      const updated = JSON.stringify(data);
      if (updated.length > FIRST_PAINT_MAX_BYTES) return false;
      ls.setItem(FIRST_PAINT_LS_KEY, updated);
      return true;
    } catch {
      return false;
    }
  }

  function clearFirstPaint() {
    try {
      const ls = storage();
      if (ls) ls.removeItem(FIRST_PAINT_LS_KEY);
    } catch { /* blocked storage: nothing was cached */ }
  }

  return { apply, remove, mode: () => currentMode, readFirstPaint, writeFirstPaint, writeFirstPaintVerdict, clearFirstPaint };
}
