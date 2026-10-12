// Tests for src/content/skin.js (ARCHITECTURE.md section 4, "content/skin.js"; section 6 for the ad rules).
//
// How the tests are wired
// - skin.js imports roleCss from src/shared/selector-map.js (another agent's file). If it does not exist yet a faithful
//   stand-in is resolved for it through a module hook; when the real file exists it is used. Failure modes of roleCss
//   (throwing, empty, junk, structurally broken text) are driven through the same hook with purpose-built sources, because
//   skin.js must stay safe whatever the real one does.
// - The selector map is the real data file; page tests use the real captured YouTube markup (test/fixtures/real) through
//   createPage(). A few components the fixtures cannot hold (buttons, menus: they were stripped from the captures) are added as
//   small SYNTHETIC snippets, marked as such below.
// - jsdom does not resolve var() in ordinary properties and does not apply @media, so cascade tests substitute the --cd-*
//   values into the CSS text first (inlineVars) and read real computed colours; at-rule CSS is checked by parsing the text.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPage } from '../helpers/dom.js';
import { ALL_THEME_IDS } from '../../src/shared/constants.js';
import { parseColor } from '../../src/shared/contrast.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const SKIN_FILE = path.join(SRC, 'content', 'skin.js');
const REAL_SELECTOR_MAP = path.join(SRC, 'shared', 'selector-map.js');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const cloneMap = () => structuredClone(MAP);
const themeJson = (id) => JSON.parse(readFileSync(path.join(SRC, 'themes', `${id}.json`), 'utf8'));
const THEMES = ALL_THEME_IDS.map(themeJson);
const CINEMA = themeJson('cinema');

// ---- module wiring -------------------------------------------------------------------------------------------------------

const ROLE_CSS_STAND_IN = `export function roleCss(map, role) {
  const list = map && map.roles && Object.hasOwn(map.roles, role) ? map.roles[role] : null;
  if (!Array.isArray(list) || !list.length) throw new Error('unknown or empty role ' + role);
  return list.join(', ');
}`;
// What a careless roleCss would do: join whatever is there, '' otherwise. skin.js must not rely on roleCss for safety.
const ROLE_CSS_NAIVE = `export function roleCss(map, role) {
  const list = map && map.roles && Object.hasOwn(map.roles, role) ? map.roles[role] : null;
  return Array.isArray(list) ? list.join(', ') : '';
}`;
const ROLE_CSS_THROWING = 'export function roleCss() { throw new Error("boom"); }';
const ROLE_CSS_EMPTY = 'export function roleCss() { return ""; }';
const ROLE_CSS_JUNK = 'export function roleCss(map, role) { return [undefined, null, 42, {}, [], true, () => "a"][role.length % 7]; }';
const ROLE_CSS_BROKEN = `export function roleCss(map, role) {
  return ['a[href="x', 'a)', '(', ']', "'unclosed", 'a, b)', '(a', 'a:is(b', 'a, [b'][role.length % 9];
}`;

let hookSeq = 0;
/** skin.js as its own module instance whose roleCss comes from `source` (null = the real file, or the stand-in if absent). */
async function loadSkin(source) {
  const parent = `${pathToFileURL(SKIN_FILE).href}?v${hookSeq++}`;
  const src = source ?? (existsSync(REAL_SELECTOR_MAP) ? null : ROLE_CSS_STAND_IN);
  if (src === null || typeof nodeModule.registerHooks !== 'function') return import(parent);
  const mapUrl = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '../shared/selector-map.js' && context.parentURL === parent) return { url: mapUrl, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(parent);
  } finally {
    hooks.deregister();
  }
}

async function importWithStandIns(file, standIns) {
  const missing = standIns.filter((s) => !existsSync(s.real));
  const url = pathToFileURL(file).href;
  if (!missing.length || typeof nodeModule.registerHooks !== 'function') return import(url);
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      const hit = missing.find((s) => s.specifier === specifier);
      if (hit) return { url: `data:text/javascript;base64,${Buffer.from(hit.source).toString('base64')}`, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try {
    return await import(url);
  } finally {
    hooks.deregister();
  }
}

const main = await loadSkin(null);
const { buildSkinCss, splitSelectorList, FALLBACK, DERIVED, SKIN_ROLES } = main;
const tokens = await importWithStandIns(path.join(SRC, 'shared', 'tokens.js'), [{
  specifier: './css-validator.js',
  real: path.join(SRC, 'shared', 'css-validator.js'),
  source: 'export const buildAllowList = () => []; export const validateCss = () => ({ ok: true, errors: [] });',
}]);
const { deriveTokens, buildTokenCss } = tokens;

const CFG = { theme: CINEMA, disabled: [] };
const CSS = buildSkinCss(MAP, CFG);

// ---- a CSS reader that is separate from skin.js ---------------------------------------------------------------------------

/** Splits on `sep` at nesting depth 0 (outside (), [] and quotes). */
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  assert.equal(depth, 0, `unbalanced brackets in: ${text.slice(0, 120)}`);
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Index of the next { that is structure (not inside a quoted attribute value or a bracket group). */
function findOpen(text, from) {
  let depth = 0;
  let quote = '';
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '{' && depth === 0) return i;
  }
  return -1;
}

function matchBrace(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new assert.AssertionError({ message: 'unbalanced braces in generated CSS' });
}

/** -> [{ selector, decls:[{prop,value}], media:string|null }] ; @media is read one level deep, anything else is an error. */
function parseSheet(css) {
  assert.ok(!/\/\*/.test(css), 'no comments are emitted');
  const rules = [];
  const walk = (text, media) => {
    let i = 0;
    while (i < text.length) {
      const open = findOpen(text, i);
      if (open < 0) { assert.equal(text.slice(i).trim(), '', 'text after the last rule'); break; }
      const head = text.slice(i, open).trim();
      const close = matchBrace(text, open);
      const body = text.slice(open + 1, close);
      if (head.startsWith('@')) {
        assert.ok(!media && /^@media /.test(head), `unexpected at-rule: ${head}`);
        walk(body, head);
      } else {
        const decls = splitTop(body, ';').map((d) => {
          const k = d.indexOf(':');
          assert.ok(k > 0, `declaration without a colon in "${head}": ${d}`);
          return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() };
        });
        rules.push({ selector: head, decls, media });
      }
      i = close + 1;
    }
  };
  walk(css, null);
  return rules;
}

const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw|ch)?$/;
/** True for what the contract calls hiding, collapsing, covering or fading. Used on skin output AND tested on bad CSS below. */
function hidesDecl({ prop, value }) {
  const v = value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  switch (prop.toLowerCase()) {
    case 'display': return v === 'none' || v === 'contents';
    case 'visibility': return v === 'hidden' || v === 'collapse';
    case 'opacity': return !(Number.parseFloat(v) >= 1);
    case 'height': case 'width': case 'max-height': case 'max-width': case 'font-size': case 'line-height': return ZERO.test(v);
    case 'clip': return v !== 'auto';
    case 'clip-path': case 'filter': case 'backdrop-filter': case 'mask': case 'mask-image': return v !== 'none';
    case 'transform': return /scale(x|y|3d)?\(\s*0(\.0+)?\s*[,)]/.test(v) || /translate/.test(v) && /-?\d{4,}/.test(v);
    case 'content-visibility': return v === 'hidden' || v === 'auto';
    case 'pointer-events': return v === 'none';
    case 'position': return v === 'fixed' || v === 'absolute' || v === 'sticky';
    case 'z-index': return true;
    case 'color': case 'background-color': return v === 'transparent';
    case 'text-indent': case 'left': case 'right': case 'top': case 'bottom': case 'margin-left': case 'margin-top': return /^-\d{3,}/.test(v);
    default: return false;
  }
}

const SKIN_PROPS = new Set([
  'background-color', 'background-image', 'color', 'scrollbar-color', 'accent-color', 'caret-color', 'font-family', 'font-size',
  'font-weight', 'border', 'border-color', 'border-radius', 'box-shadow', 'outline', 'outline-offset', 'overflow',
  'transition', 'transition-duration', 'animation', 'scroll-behavior', '--cd-duration',
]);
/** The inline tint palette YouTube sets on components that use the video's own colours: the only foreign custom properties the skin writes. */
const LIGHTSOURCE_PROP = /^--yt-lightsource-(?:section[1-4]-color|(?:primary|secondary)-title-color|icon-(?:activated|inactive|disabled)-color)$/;
/** What may ever be written onto an ad, a sponsorship disclosure or a player control: paint only, never geometry or visibility. */
const PAINT_ONLY = new Set([
  'background-color', 'background-image', 'color', 'caret-color', 'font-family', 'font-weight', 'border', 'border-color', 'border-radius',
  'box-shadow', 'outline', 'outline-offset', 'transition', 'overflow',
]);
const EVERY_PAGE = ['home', 'watch', 'search', 'channel', 'subscriptions', 'history', 'playlist'];

/** Substitutes var(--name[, fallback]) with token values so jsdom can compute colours. Unknown names use their fallback. */
function inlineVars(css, values) {
  let out = css;
  for (let i = 0; i < 6 && out.includes('var('); i++) {
    out = out.replace(/var\((--[\w-]+)(?:,([^()]*))?\)/g, (all, name, fallback) => (name in values ? values[name] : fallback !== undefined ? fallback : all));
  }
  return out;
}

const sameColour = (actual, expected, msg) => {
  const a = parseColor(actual);
  const e = parseColor(expected);
  assert.ok(a, `unreadable computed colour "${actual}" ${msg || ''}`);
  assert.ok(e, `unreadable expected colour "${expected}"`);
  assert.deepEqual([a.r, a.g, a.b], [e.r, e.g, e.b], `${msg || ''}: ${actual} vs ${expected}`);
  assert.ok(Math.abs(a.a - e.a) < 0.02, `${msg || ''}: alpha ${a.a} vs ${e.a}`);
};

// =============================================================================================================================

describe('the scanner used below (proved on bad CSS before it is trusted on skin output)', () => {
  test('hidesDecl catches every way to hide, collapse, cover or fade', () => {
    const bad = [
      ['display', 'none'], ['display', 'none !important'], ['visibility', 'hidden'], ['visibility', 'collapse'], ['opacity', '0'], ['opacity', '.5'],
      ['opacity', '0.99'], ['height', '0'], ['width', '0px'], ['max-height', '0'], ['max-width', '0'], ['font-size', '0'], ['clip', 'rect(0,0,0,0)'],
      ['clip-path', 'inset(50%)'], ['filter', 'blur(2px)'], ['transform', 'scale(0)'], ['transform', 'scale(0, 1)'], ['content-visibility', 'hidden'],
      ['pointer-events', 'none'], ['position', 'fixed'], ['position', 'absolute'], ['z-index', '9999'], ['color', 'transparent'],
      ['background-color', 'transparent'], ['text-indent', '-9999px'], ['left', '-9999px'], ['mask', 'linear-gradient(#000,transparent)'],
    ];
    for (const [prop, value] of bad) assert.ok(hidesDecl({ prop, value }), `${prop}:${value}`);
    const fine = [['opacity', '1'], ['color', 'var(--cd-text)'], ['height', 'auto'], ['filter', 'none'], ['display', 'block'], ['overflow', 'hidden'], ['transform', 'none']];
    for (const [prop, value] of fine) assert.ok(!hidesDecl({ prop, value }), `${prop}:${value}`);
  });

  test('parseSheet reads nested at-rules, quotes and :is() lists, and refuses broken CSS', () => {
    const rules = parseSheet('a{color:red}@media (x){b[c="d{e"],f:is(g,h){opacity:.5;margin:0}}');
    assert.deepEqual(rules.map((r) => [r.selector, r.media, r.decls.length]), [['a', null, 1], ['b[c="d{e"],f:is(g,h)', '@media (x)', 2]]);
    assert.throws(() => parseSheet('a{color:red'), /unbalanced/);
    assert.throws(() => parseSheet('a{color}'), /colon/);
    assert.throws(() => parseSheet('@import "x";'), /./);
    assert.throws(() => parseSheet('a{} /* c */'), /comments/);
  });

  test('inlineVars resolves nested fallbacks', () => {
    assert.equal(inlineVars('x:var(--a);y:var(--b,var(--a));z:var(--c,9px)', { '--a': '1', '--b': '2' }), 'x:1;y:2;z:9px');
    assert.equal(inlineVars('x:var(--unknown)', {}), 'x:var(--unknown)');
  });
});

// =============================================================================================================================

describe('the stylesheet', () => {
  const rules = parseSheet(CSS);

  test('is compact, deterministic and does not touch its inputs', () => {
    assert.ok(CSS.length > 3000, 'covers a lot of ground');
    assert.ok(CSS.length < 40 * 1024, `${CSS.length} bytes (budget 40 KB)`);
    assert.ok(CSS.length < 20 * 1024, 'and in practice far below it');
    assert.equal(buildSkinCss(MAP, CFG), CSS);
    assert.equal(buildSkinCss(structuredClone(MAP), structuredClone(CFG)), CSS);
    const frozen = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(frozen); } return o; };
    const map = frozen(cloneMap());
    const before = JSON.stringify(map);
    assert.equal(buildSkinCss(map, frozen({ theme: structuredClone(CINEMA), disabled: [] })), CSS);
    assert.equal(JSON.stringify(map), before);
  });

  test('is one rule per line, with no comments and no stray text', () => {
    const lines = CSS.split('\n');
    assert.equal(lines.length, rules.filter((r) => !r.media).length + 1 /* the @media line */);
    for (const line of lines) assert.ok(line.endsWith('}') && !line.startsWith(' '), line.slice(0, 80));
    assert.doesNotMatch(CSS, /\/\*|\*\/|@import|@font-face|@charset|@namespace|expression\(|(?<![-\w])behavior|-moz-binding|url\(|<|\\/i);
  });

  test('every rule is scoped under html[cd-theme] (page rules under [cd-page=...])', () => {
    assert.ok(rules.length > 40);
    // html[cd-theme][cd-theme] is the one deliberate specificity boost: the page colour must win its tie against YouTube's html[dark]{...!important}
    const scope = /^html\[cd-theme\](?:\[cd-theme\])?(?:\[cd-page="(?:search|channel|subscriptions|history|playlist)"\]|\[cd-motion="off"\])?(?: |$)/;
    for (const r of rules) assert.match(r.selector, scope, r.selector.slice(0, 100));
    for (const r of rules) assert.equal(splitTop(r.selector, ',').length, 1, 'one selector per rule (lists live inside :is())');
    const pages = new Set(rules.map((r) => /\[cd-page="([a-z]+)"\]/.exec(r.selector)?.[1]).filter(Boolean));
    assert.deepEqual([...pages].sort(), ['channel', 'history', 'playlist', 'search', 'subscriptions']);
  });

  test('has no hide rule of any kind: nothing hides, collapses, covers or fades (contract section 6)', () => {
    for (const r of rules) for (const d of r.decls) assert.ok(!hidesDecl(d), `${r.selector.slice(0, 80)} { ${d.prop}:${d.value} }`);
  });

  test('uses only a short allow-list of properties, so a new kind of declaration needs a decision', () => {
    const used = new Set(rules.flatMap((r) => r.decls.map((d) => d.prop)));
    for (const p of used) assert.ok(SKIN_PROPS.has(p) || LIGHTSOURCE_PROP.test(p), `property ${p} is not on the skin allow-list`);
    const overflowRules = rules.filter((r) => r.decls.some((d) => d.prop === 'overflow'));
    assert.equal(overflowRules.length, 1, 'overflow is only used to round thumbnails');
    assert.match(overflowRules[0].selector, /thumbnail/);
    assert.deepEqual(overflowRules[0].decls.find((d) => d.prop === 'overflow').value, 'hidden');
  });

  test('every --cd-* variable it reads is written by tokens.js (or has a fallback), so no value is silently undefined', () => {
    const defined = new Set(Object.keys(deriveTokens(CINEMA, {}, MAP)));
    const bySkin = new Set(['--cd-gap', '--cd-card-min', '--cd-row-gap']); // density.js
    const unresolved = [];
    for (const m of CSS.matchAll(/var\((--[\w-]+)(,)?/g)) {
      if (!m[1].startsWith('--cd-')) unresolved.push(`non-cd variable ${m[1]}`);
      else if (!defined.has(m[1]) && !bySkin.has(m[1]) && !m[2]) unresolved.push(`${m[1]} has neither a token nor a fallback`);
    }
    assert.deepEqual(unresolved, []);
    // the optional heading font is the only variable that is read but never written by tokens.js, and it always has a fallback
    const readOnly = [...new Set([...CSS.matchAll(/var\((--cd-[\w-]+)/g)].map((m) => m[1]))].filter((n) => !defined.has(n));
    assert.deepEqual(readOnly, ['--cd-heading-font']);
    assert.ok(CSS.includes('var(--cd-heading-font,var(--cd-font-family))'));
  });

  test('uses the tokens that make themes differ: radius, shadow, accent, surfaces, muted text', () => {
    for (const name of ['--cd-bg', '--cd-surface', '--cd-menu', '--cd-text', '--cd-muted', '--cd-accent', '--cd-accent-text', '--cd-accent-hover',
      '--cd-border', '--cd-radius', '--cd-shadow', '--cd-font-family', '--cd-font-scale', '--cd-heading-weight', '--cd-duration', '--cd-hover', '--cd-active', '--cd-scrim']) {
      assert.ok(CSS.includes(`var(${name}`), `${name} is never read`);
    }
  });

  test('contains no colour, radius or font literal that would stop a theme from changing it', () => {
    for (const r of rules) {
      for (const d of r.decls) {
        if (d.prop === '--cd-duration') continue;
        assert.doesNotMatch(d.value, /#[0-9a-f]{3,8}\b|\brgba?\(\s*\d|\bhsla?\(/i, `${r.selector.slice(0, 60)} { ${d.prop}:${d.value} }`);
        // `inherit` is the one non-token colour: it cannot freeze a theme colour, it hands the choice back to the surrounding text
        if (['color', 'background-color', 'border-color', 'caret-color', 'accent-color'].includes(d.prop)) assert.match(d.value, /var\(--cd-|^inherit(?:\s*!important)?$/);
        if (LIGHTSOURCE_PROP.test(d.prop)) assert.match(d.value, /^var\(--cd-(?:surface|text|muted|accent)\)!important$/);
        if (d.prop === 'font-family') assert.match(d.value, /var\(--cd-/);
      }
    }
    // the radius literals that remain are caps (min(..., 20px)) or the 1px outline, never the corner radius itself
    for (const r of rules) for (const d of r.decls) if (d.prop === 'border-radius') assert.match(d.value, /var\(--cd-radius\)/);
  });

  test('page rules cover masthead, search box, guide, chips, buttons, menus, cards, watch, search, channel, subscriptions, history, playlist', () => {
    const has = (re) => assert.ok(rules.some((r) => re.test(r.selector)), `no rule for ${re}`);
    has(/#background/); has(/ytSearchboxComponentInputBox/); has(/ytSearchboxComponentSearchButton/); has(/ytSearchboxComponentSuggestionsContainer/);
    has(/#contentContainer/); has(/ytd-mini-guide-renderer/); has(/ytd-guide-entry-renderer/);
    has(/chip/i); has(/yt-spec-button-shape-next--tonal/); has(/yt-spec-button-shape-next--filled/); has(/yt-spec-button-shape-next--outline/);
    has(/ytd-menu-popup-renderer/); has(/yt-thumbnail-view-model/); has(/ytLockupMetadataViewModelTitle/); has(/ytContentMetadataViewModelMetadataText/);
    has(/ytd-watch-metadata #title h1/); has(/#description/); has(/#comment-teaser/); has(/ytd-comments-header-renderer/);
    has(/cd-page="search"/); has(/cd-page="channel"/); has(/ytTabShapeTab/); has(/cd-page="subscriptions"/); has(/cd-page="history"/); has(/cd-page="playlist"/);
  });

  test('the page surface is set explicitly: html (!important, doubled attribute), the app shell and the page manager', () => {
    const find = (sel) => rules.find((r) => r.selector === sel);
    // YouTube paints <html> with html{background-color:#fff!important} and html[dark]{...!important}, so only !important and a higher
    // specificity (our <style> sits before <head> at document_start, so a tie goes to YouTube) put the theme colour on top
    const html = find('html[cd-theme][cd-theme]');
    assert.ok(html, 'a rule for the doubled attribute');
    assert.deepEqual(html.decls, [{ prop: 'background-color', value: 'var(--cd-bg)!important' }]);
    assert.ok(!find('html[cd-theme]').decls.some((d) => d.prop === 'background-color'), 'the plain html rule no longer carries the colour');
    for (const sel of ['ytd-app', 'ytd-page-manager']) {
      const r = rules.find((x) => x.selector.startsWith('html[cd-theme] ') && x.selector.includes(sel) && x.decls.some((d) => d.prop === 'background-color'));
      assert.ok(r, `${sel} rule`);
      assert.ok(r.decls.some((d) => d.prop === 'background-color' && d.value === 'var(--cd-bg)'), sel);
    }
  });

  test('the doubled html attribute outranks the selectors YouTube paints <html> with, whatever the source order', () => {
    // minimal specificity calculator for the compound selectors involved: (ids, classes + attributes + pseudo-classes, elements)
    const spec = (sel) => [(sel.match(/#[\w-]+/g) || []).length, (sel.match(/\[[^\]]*\]|\.[\w-]+|:[\w-]+/g) || []).length, (sel.match(/(?:^|[\s>+~])[a-z][\w-]*/g) || []).length];
    const beats = (a, b) => { const x = spec(a); const y = spec(b); for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
    for (const youtube of ['html', 'html[dark]', 'html[darker-dark-theme]']) {
      assert.ok(beats('html[cd-theme][cd-theme]', youtube), `beats ${youtube}`);
      assert.ok(!beats('html[cd-theme]', 'html[dark]') , 'the single attribute only ties with html[dark] (our style element comes first at document_start, so a tie is lost)');
    }
  });

  test('colours YouTube resolved for its own mode (inline styles) are overridden, with !important and nowhere else', () => {
    const run = rules.filter((r) => /style\*="color:"/.test(r.selector));
    assert.ok(run.length >= 1);
    for (const r of run) {
      assert.deepEqual(r.decls, [{ prop: 'color', value: 'inherit!important' }], r.selector.slice(0, 80));
      assert.match(r.selector, /:not\(\[style\*="background"\]\)/, 'an element with its own inline background is left alone');
    }
    const link = rules.find((r) => r.selector.includes('ytAttributedStringLinkCallToActionColor'));
    assert.deepEqual(link.decls, [{ prop: 'color', value: 'var(--cd-accent)!important' }]);
    // !important only where YouTube forces it: the page colour, inline colours, the inline tint palette, the font, and motion off
    for (const r of rules) {
      for (const d of r.decls.filter((x) => /!important$/.test(x.value))) {
        const where = `${r.selector.slice(0, 90)} { ${d.prop} }`;
        if (d.prop === 'background-color') assert.equal(r.selector, 'html[cd-theme][cd-theme]', where);
        else if (d.prop === 'color') assert.match(r.selector, /style\*="color:"|CallToActionColor/, where);
        else if (LIGHTSOURCE_PROP.test(d.prop)) assert.match(r.selector, /use-custom-colors/, where);
        else assert.ok(['font-family', 'font-size', 'transition-duration', 'animation', 'scroll-behavior', '--cd-duration'].includes(d.prop), where);
      }
    }
  });

  test('the video-tinted palette (--yt-lightsource-*) is mapped onto the theme, on [use-custom-colors] components only', () => {
    const r = rules.find((x) => x.selector.includes('use-custom-colors'));
    assert.ok(r);
    assert.equal(r.decls.length, 9);
    const get = (name) => r.decls.find((d) => d.prop === `--yt-lightsource-${name}`)?.value;
    for (const n of [1, 2, 3, 4]) assert.equal(get(`section${n}-color`), 'var(--cd-surface)!important');
    assert.equal(get('primary-title-color'), 'var(--cd-text)!important');
    assert.equal(get('secondary-title-color'), 'var(--cd-muted)!important');
    assert.equal(get('icon-activated-color'), 'var(--cd-accent)!important');
    assert.equal(get('icon-inactive-color'), 'var(--cd-muted)!important');
    assert.equal(get('icon-disabled-color'), 'var(--cd-muted)!important');
    assert.equal(rules.filter((x) => x.decls.some((d) => LIGHTSOURCE_PROP.test(d.prop))).length, 1);
  });
});

// =============================================================================================================================

describe('motion', () => {
  const rules = parseSheet(CSS);

  test('every transition runs on var(--cd-duration), and only on colour-ish properties', () => {
    const transitions = rules.flatMap((r) => r.decls.filter((d) => d.prop === 'transition'));
    assert.ok(transitions.length >= 5);
    for (const t of transitions) {
      for (const part of splitTop(t.value, ',')) {
        assert.match(part, /^(background-color|color|border-color|box-shadow) var\(--cd-duration\) ease$/, part);
      }
    }
    assert.doesNotMatch(CSS, /transition:[^;}]*\d+m?s/, 'no literal durations');
    assert.doesNotMatch(CSS, /@keyframes|animation:(?!none)|animation-name/);
  });

  test('prefers-reduced-motion zeroes the duration and stops Cinedrape\'s own elements', () => {
    const media = rules.filter((r) => r.media);
    assert.ok(media.length >= 2);
    assert.ok(media.every((r) => r.media === '@media (prefers-reduced-motion:reduce)'));
    assert.equal((CSS.match(/@media/g) || []).length, 1, 'one media block');
    const root = media.find((r) => r.selector === 'html[cd-theme]');
    assert.deepEqual(root.decls, [{ prop: '--cd-duration', value: '0ms!important' }]);
    const own = media.find((r) => r.selector.includes('cd-"'));
    assert.ok(own);
    const props = Object.fromEntries(own.decls.map((d) => [d.prop, d.value]));
    assert.equal(props['transition-duration'], '0s!important');
    assert.equal(props.animation, 'none!important');
    assert.equal(props['scroll-behavior'], 'auto!important');
  });

  test('the animations setting (cd-motion="off") stops Cinedrape\'s own elements the same way', () => {
    const rule = rules.find((r) => r.selector.startsWith('html[cd-theme][cd-motion="off"]'));
    assert.ok(rule);
    assert.ok(rule.decls.some((d) => d.prop === 'transition-duration' && d.value === '0s!important'));
    assert.ok(rule.decls.some((d) => d.prop === 'animation' && d.value === 'none!important'));
    assert.match(rule.selector, /\[class\^="cd-"\],\[class\*=" cd-"\]/);
  });

  test('the duration variable is what the transitions follow: 0ms from tokens when animations are off', () => {
    assert.equal(deriveTokens(CINEMA, { animations: false }, MAP)['--cd-duration'], '0ms');
    assert.match(buildTokenCss(CINEMA, { animations: false }, MAP), /--cd-duration:0ms/);
  });
});

// =============================================================================================================================

describe('selectors come from the selector map', () => {
  const ROLE_PREFIX = 'zz';
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const standalone = (css, sel) => new RegExp(`(?<![\\w#.\\-])${esc(sel)}(?![\\w\\-])`).test(css);

  const mapRoles = SKIN_ROLES.filter((r) => Object.hasOwn(MAP.roles, r));
  const localRoles = SKIN_ROLES.filter((r) => !Object.hasOwn(MAP.roles, r));

  test('the skin uses 16 of the roles the real map defines and the rest are its own (so the map can adopt them later)', () => {
    assert.ok(mapRoles.length >= 14, mapRoles.join());
    assert.ok(localRoles.length >= 20);
    for (const role of Object.keys(FALLBACK)) assert.ok(Array.isArray(FALLBACK[role]) && FALLBACK[role].length > 0, role);
    assert.ok(Object.isFrozen(FALLBACK) && Object.isFrozen(DERIVED) && Object.isFrozen(SKIN_ROLES));
    assert.deepEqual([...SKIN_ROLES], [...Object.keys(FALLBACK), ...Object.keys(DERIVED)]);
  });

  test('renaming any role in the map changes the skin: the new selector is used, the old one is gone, and no role is dead', () => {
    const dead = [];
    for (const role of SKIN_ROLES) {
      const map = cloneMap();
      const old = Object.hasOwn(map.roles, role) ? map.roles[role].slice() : (FALLBACK[role] || []).slice();
      const a = `${ROLE_PREFIX}-${role.toLowerCase()}-a`;
      const b = `${ROLE_PREFIX}-${role.toLowerCase()}-b`;
      map.roles[role] = [a, b];
      const css = buildSkinCss(map, CFG);
      if (!standalone(css, a) || !standalone(css, b)) { dead.push(role); continue; }
      assert.ok(css.split('\n').some((line) => line.includes(a) && line.includes(b)), `${role}: both entries are used by the same rule`);
      // the old selectors vanish, unless another role still legitimately uses the same text
      const others = [
        ...Object.entries(map.roles).filter(([k]) => k !== role && SKIN_ROLES.includes(k)).flatMap(([, v]) => v),
        ...Object.entries(FALLBACK).filter(([k]) => k !== role && !Object.hasOwn(map.roles, k)).flatMap(([, v]) => v),
      ];
      for (const sel of old) {
        if (others.some((o) => o === sel || standalone(o, sel))) continue;
        assert.ok(!standalone(css, sel), `${role}: old selector still in the skin: ${sel}`);
      }
    }
    assert.deepEqual(dead, [], 'roles the skin never reads');
  });

  test('derived roles follow their parent role, and a map that defines them wins', () => {
    const cases = [
      ['mastheadBar', 'masthead', ' #background'],
      ['frostedGlass', 'app', ' #frosted-glass'],
      ['guideContent', 'guide', ' #contentContainer'],
      ['channelTitle', 'channelHeader', ' h1'],
    ];
    assert.deepEqual(Object.keys(DERIVED).sort(), cases.map((c) => c[0]).sort());
    for (const [derived, parent, suffix] of cases) {
      const followed = cloneMap();
      followed.roles[parent] = [`zz-parent-a`, `zz-parent-b`];
      const css = buildSkinCss(followed, CFG);
      assert.ok(css.includes(`zz-parent-a${suffix}`) && css.includes(`zz-parent-b${suffix}`), `${derived} follows ${parent}`);
      const own = cloneMap();
      own.roles[derived] = ['zz-own'];
      own.roles[parent] = ['zz-ignored'];
      const css2 = buildSkinCss(own, CFG);
      assert.ok(css2.includes('zz-own'), `${derived} from the map`);
      assert.ok(!css2.includes(`zz-ignored${suffix}`), `${derived}: the map's own role beats the derived one`);
    }
  });

  test('no YouTube selector is hard-coded: every identifier in the output comes from the map or the declared fallbacks', () => {
    const idents = (text) => new Set(text
      .replace(/"[^"]*"|'[^']*'/g, '""')
      .replace(/::?[A-Za-z-]+/g, ' ')
      .match(/[.#]?[A-Za-z][\w-]*/g) || []);
    const known = new Set();
    for (const list of Object.values(MAP.roles)) for (const sel of list) idents(sel).forEach((i) => known.add(i));
    for (const list of Object.values(FALLBACK)) for (const sel of list) idents(sel).forEach((i) => known.add(i));
    ['html', 'cd-theme', 'cd-page', 'cd-motion', 'class', 'a', 'button', 'input', 'textarea', 'select', 'tabindex', 'role'].forEach((i) => known.add(i));
    const heads = parseSheet(CSS).map((r) => r.selector.replace(/\[class[^\]]*"cd-"\]/g, ''));
    const strays = new Set();
    for (const h of heads) for (const i of idents(h)) if (!known.has(i) && !/^(?:cd-|search|channel|subscriptions|history|playlist|off)/.test(i)) strays.add(i);
    // the suffixes of the derived roles are the only literal YouTube names in skin.js, and they are declared in DERIVED
    assert.deepEqual([...strays].sort(), ['#background', '#contentContainer', '#frosted-glass']);
  });

  test('without a map (null, {}, no roles, junk) the fallbacks produce the same declarations, only the selectors differ', () => {
    const declarations = (css) => parseSheet(css).map((r) => `${r.media || ''}|${r.decls.map((d) => `${d.prop}:${d.value}`).join(';')}`).sort();
    const reference = declarations(CSS);
    for (const map of [undefined, null, {}, { roles: {} }, { roles: null }, { roles: [] }, 'map', 0, { roles: { masthead: [], app: 'ytd-app', guide: null } }]) {
      const css = buildSkinCss(map, CFG);
      assert.deepEqual(declarations(css), reference, JSON.stringify(map));
      assert.ok(css.includes('ytd-masthead #background'), 'falls back to the declared selectors');
      assert.ok(css.includes('yt-searchbox .ytSearchboxComponentInputBox'));
    }
  });

  test('roleCss misbehaving (throwing, empty, junk, structurally broken text) never throws and never blanks a page', async () => {
    const reference = buildSkinCss(null, CFG);
    for (const [name, source] of [['throwing', ROLE_CSS_THROWING], ['empty', ROLE_CSS_EMPTY], ['junk', ROLE_CSS_JUNK], ['broken', ROLE_CSS_BROKEN]]) {
      const skin = await loadSkin(source);
      const css = skin.buildSkinCss(MAP, CFG);
      assert.equal(css, reference, `${name}: all roles fall back to the local lists`);
      parseSheet(css);
    }
  });

  test('a hostile map cannot inject rules: braces, semicolons, comments, escapes and runaway lengths are dropped', async () => {
    const skin = await loadSkin(ROLE_CSS_NAIVE);
    const map = cloneMap();
    map.roles.comments = [
      'x{display:none}', '} body{display:none', 'a; b', '/* c */ y', '<!-- z', 'q@import', 'w\\', '.a\\,b', `tall-${'x'.repeat(700)}`, 'ok-element', 'ok-two',
    ];
    map.roles.miniGuide = ['}', '{', ';'];
    const css = skin.buildSkinCss(map, CFG);
    assert.doesNotMatch(css, /display|body|@import|<!--|\/\*|\\/);
    const rules = parseSheet(css);
    assert.ok(rules.some((r) => r.selector === 'html[cd-theme] :is(ok-element,ok-two){color:var(--cd-text)}'.slice(0, -'{color:var(--cd-text)}'.length)));
    assert.ok(rules.some((r) => r.selector.includes('ytd-mini-guide-renderer')), 'a role with only unsafe entries falls back');
    // a broken entry in the middle of a good list is dropped, the good ones stay
    const mixed = cloneMap();
    mixed.roles.chips = ['chip-a', 'x{', 'chip-b'];
    assert.ok(skin.buildSkinCss(mixed, CFG).includes('html[cd-theme] :is(chip-a,chip-b){background-color:var(--cd-bg)}'));
  });

  test('unbalanced text from the map makes the whole role fall back (an open bracket would swallow the rest of the sheet)', async () => {
    const skin = await loadSkin(ROLE_CSS_NAIVE);
    for (const text of ['a[href="x', 'a)', 'b:is(c', 'd, [e', "f'", '(']) {
      const map = cloneMap();
      map.roles.chips = [text, 'chip-good'];
      const css = skin.buildSkinCss(map, CFG);
      assert.ok(!css.includes('chip-good'), `broken role text "${text}" must not be partially used`);
      assert.ok(css.includes('chip-bar-view-model'), 'fell back to the declared chips');
      parseSheet(css);
    }
  });

  test('multi-entry roles are wrapped in :is() (one unparsable entry costs only that entry); single entries are not', () => {
    assert.ok(CSS.includes(':is(.ytChipShapeChip,yt-chip-cloud-chip-renderer #chip-container)'));
    assert.ok(CSS.includes('html[cd-theme] ytd-mini-guide-renderer{'));
    assert.ok(!CSS.includes(':is(ytd-mini-guide-renderer)'));
  });

  test('every selector of a skin role in the real map survives splitting (none is silently dropped)', () => {
    for (const role of SKIN_ROLES.filter((r) => Object.hasOwn(MAP.roles, r))) {
      const entries = MAP.roles[role];
      assert.deepEqual(splitSelectorList(entries.join(', ')), entries, role);
    }
  });
});

// =============================================================================================================================

describe('splitSelectorList', () => {
  test('splits on top-level commas only', () => {
    assert.deepEqual(splitSelectorList('a, b ,c'), ['a', 'b', 'c']);
    assert.deepEqual(splitSelectorList('a:is(b, c), d'), ['a:is(b, c)', 'd']);
    assert.deepEqual(splitSelectorList('a:not(:has(b, c)) d, e'), ['a:not(:has(b, c)) d', 'e']);
    assert.deepEqual(splitSelectorList('a[title="x,y"], b[c=\'d,e\']'), ['a[title="x,y"]', "b[c='d,e']"]);
    assert.deepEqual(splitSelectorList('a[title="a)b"], c'), ['a[title="a)b"]', 'c']);
  });

  test('drops empty entries and duplicates, keeps order', () => {
    assert.deepEqual(splitSelectorList(',,a,,b , a,'), ['a', 'b']);
    assert.deepEqual(splitSelectorList('  '), []);
    assert.deepEqual(splitSelectorList(''), []);
  });

  test('returns [] for text that is structurally broken', () => {
    for (const bad of ['a[b', 'a)', 'a(b', ']a', 'a, b)', '"a', "a[b='c]", 'a:is(b, c']) assert.deepEqual(splitSelectorList(bad), [], bad);
  });

  test('drops entries that could end a rule, open a comment or smuggle an escape; an escaped comma never leaks a fragment', () => {
    assert.deepEqual(splitSelectorList('a{}, b'), ['b']);
    assert.deepEqual(splitSelectorList('a;b, c'), ['c']);
    assert.deepEqual(splitSelectorList('a/*, b'), ['b']);
    assert.deepEqual(splitSelectorList('.a\\,b, c'), ['c']);
    assert.deepEqual(splitSelectorList('a\\'), []);
    assert.deepEqual(splitSelectorList('a<b, c@d, e'), ['e']);
    assert.deepEqual(splitSelectorList('a\nb, c\rd, e'), ['e']);
    assert.deepEqual(splitSelectorList(`${'x'.repeat(601)}, y`), ['y']);
    assert.deepEqual(splitSelectorList(`${'x'.repeat(600)}, y`), ['x'.repeat(600), 'y']);
  });

  test('non-strings give []', () => {
    for (const v of [undefined, null, 0, 1, {}, [], ['a'], true, () => 'a']) assert.deepEqual(splitSelectorList(v), []);
  });

  test('copes with long hostile input quickly', () => {
    const start = Date.now();
    splitSelectorList('('.repeat(50000));
    splitSelectorList('a,'.repeat(50000));
    splitSelectorList('["'.repeat(20000));
    assert.ok(Date.now() - start < 1000);
  });
});

// =============================================================================================================================

describe('configuration', () => {
  test('cfg.disabled containing "theme" disables everything: the empty string, so nothing is blanked', () => {
    assert.equal(buildSkinCss(MAP, { theme: CINEMA, disabled: ['theme'] }), '');
    assert.equal(buildSkinCss(MAP, { theme: CINEMA, disabled: ['layout-home', 'theme', 'density'] }), '');
  });

  test('other disabled features do not change the skin (they belong to other modules)', () => {
    for (const disabled of [[], ['layout-home'], ['layout-watch', 'density'], ['calm-hideShorts', 'calm-hideComments'], ['unknown-feature']]) {
      assert.equal(buildSkinCss(MAP, { theme: CINEMA, disabled }), CSS, disabled.join());
    }
  });

  test('no theme (null) means leave YouTube alone; a missing or junk cfg still skins (it must not throw)', () => {
    assert.equal(buildSkinCss(MAP, { theme: null }), '');
    for (const cfg of [undefined, null, {}, 0, 'x', [], { disabled: null }, { disabled: 'theme' }, { disabled: {} }, { theme: undefined }]) {
      assert.doesNotThrow(() => buildSkinCss(MAP, cfg), JSON.stringify(cfg));
      assert.equal(typeof buildSkinCss(MAP, cfg), 'string');
    }
    assert.equal(buildSkinCss(MAP, undefined), CSS);
  });

  test('the same sheet serves every theme: themes differ by data only (tokens and theme CSS), never by skin rules', () => {
    for (const theme of THEMES) assert.equal(buildSkinCss(MAP, { theme, disabled: [] }), CSS, theme.id);
    for (const cfg of [{ accent: '#ff8800' }, { animations: false }, { density: 5, home: 'rows', watch: 'focus' }]) {
      assert.equal(buildSkinCss(MAP, { theme: CINEMA, disabled: [], ...cfg }), CSS, JSON.stringify(cfg));
    }
  });
});

// =============================================================================================================================

describe('against real YouTube markup (captured fixtures, jsdom)', () => {
  const rules = parseSheet(CSS).filter((r) => !r.media);
  /** :hover / :focus-visible cannot be true in jsdom; pseudo-elements never match. The structure is what is under test. */
  const structural = (sel) => sel.replace(/:hover|:focus-visible/g, '').replace(/::placeholder/g, '');
  const usable = rules.filter((r) => !r.selector.includes('::selection'));

  function skinnedPage(kind, opts = {}, attrs = {}) {
    const page = createPage(kind, opts);
    const root = page.document.documentElement;
    root.setAttribute('cd-theme', 'cinema');
    root.setAttribute('cd-page', kind);
    for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
    return page;
  }
  function matchedSets(document) {
    return usable.map((r) => {
      let list;
      try {
        list = document.querySelectorAll(structural(r.selector));
      } catch (e) {
        assert.fail(`jsdom cannot evaluate ${r.selector.slice(0, 120)}: ${e.message}`);
      }
      return { rule: r, els: new Set(list) };
    });
  }
  const selects = (snippet, selector) => (snippet instanceof RegExp ? snippet.test(selector) : selector.includes(snippet));
  const count = (sets, snippet) => sets.filter((s) => selects(snippet, s.rule.selector)).reduce((n, s) => n + s.els.size, 0);

  // [label, snippet of the rule's selector, pages where it must match something]
  const COVERAGE = [
    ['masthead bar (#background)', 'ytd-masthead #background', EVERY_PAGE],
    ['frosted glass', '#frosted-glass', EVERY_PAGE],
    ['search box', '.ytSearchboxComponentInputBox', EVERY_PAGE],
    ['search input', /\.ytSearchboxComponentInput$/, EVERY_PAGE],
    ['search button', /\.ytSearchboxComponentSearchButton$/, EVERY_PAGE],
    ['search suggestions', '.ytSearchboxComponentSuggestionsContainer', EVERY_PAGE],
    ['guide', '#contentContainer', EVERY_PAGE],
    ['mini guide', /^html\[cd-theme\] ytd-mini-guide-renderer$/, EVERY_PAGE],
    ['guide entries', /^html\[cd-theme\] ytd-guide-entry-renderer tp-yt-paper-item$/, EVERY_PAGE],
    ['navigation progress', 'yt-page-navigation-progress', EVERY_PAGE],
    ['chip bar', 'ytd-feed-filter-chip-bar-renderer', ['home']],
    ['chip bar (channel)', 'chip-bar-view-model', ['channel']],
    ['chip bar (search)', 'yt-chip-cloud-renderer', ['search']],
    ['chips', '.ytChipShapeChip', ['channel', 'search']],
    ['active chip', '.ytChipShapeActive', ['channel', 'search']],
    ['inactive chip', '.ytChipShapeInactive', ['channel', 'search']],
    ['thumbnails', 'yt-thumbnail-view-model', ['home', 'watch', 'channel', 'subscriptions', 'playlist', 'search']],
    ['tile titles', 'a.ytLockupMetadataViewModelTitle', EVERY_PAGE.filter((p) => p !== 'history')],
    ['tile meta', '.ytContentMetadataViewModelMetadataText', EVERY_PAGE.filter((p) => p !== 'history')],
    ['legacy result rows', 'a#video-title', ['search', 'history']],
    ['watch title', 'ytd-watch-metadata #title h1', ['watch']],
    ['watch metadata', 'ytd-watch-metadata,', ['watch']],
    ['description box', /#description$/, ['watch']],
    ['comment teaser', /#comment-teaser$/, ['watch']],
    ['comments header', 'ytd-comments-header-renderer', ['watch']],
    ['related column hover', '.ytLockupViewModelHost', ['watch', 'playlist']],
    ['search results', '[cd-page="search"] :is(ytd-search', ['search']],
    ['result snippet', '.metadata-snippet-text', ['search']],
    ['channel header', '[cd-page="channel"] :is(ytd-tabbed-page-header', ['channel']],
    ['channel title', 'ytd-tabbed-page-header h1', ['channel']],
    ['channel tabs', '.ytTabShapeTab,', ['channel']],
    ['selected tab', '.ytTabShapeTabSelected', ['channel']],
    ['tab bar', '.ytTabShapeTabBarSelected', ['channel']],
    ['subscriptions grid', '[cd-page="subscriptions"]', ['subscriptions']],
    ['history list', '[cd-page="history"]', ['history']],
    ['playlist panel', '[cd-page="playlist"] :is(ytd-browse[page-subtype="playlist"] yt-item-section-renderer', ['playlist']],
    ['playlist header', 'yt-page-header-renderer', ['playlist']],
  ];

  test('every part of the skin lands on real YouTube elements on the pages it is meant for', () => {
    const pages = Object.fromEntries(EVERY_PAGE.map((k) => [k, matchedSets(skinnedPage(k, { tiles: 4 }).document)]));
    const missing = [];
    for (const [label, snippet, expected] of COVERAGE) {
      const rulesWithSnippet = usable.filter((r) => selects(snippet, r.selector));
      if (!rulesWithSnippet.length) { missing.push(`${label}: no rule contains ${snippet}`); continue; }
      for (const kind of expected) if (count(pages[kind], snippet) === 0) missing.push(`${label} matches nothing on ${kind}`);
    }
    assert.deepEqual(missing, []);
  });

  test('page-scoped rules apply on their own page and nowhere else', () => {
    const scoped = [['search', 'search'], ['channel', 'channel'], ['subscriptions', 'subscriptions'], ['history', 'history'], ['playlist', 'playlist']];
    for (const [kind, scope] of scoped) {
      const right = matchedSets(skinnedPage(kind, { tiles: 4 }).document);
      const wrong = matchedSets(skinnedPage(kind, { tiles: 4 }, { 'cd-page': 'other' }).document);
      const onlyScope = (sets) => sets.filter((s) => s.rule.selector.includes(`[cd-page="${scope}"]`)).reduce((n, s) => n + s.els.size, 0);
      assert.ok(onlyScope(right) > 0, `${kind}: rules apply on the ${kind} page`);
      assert.equal(onlyScope(wrong), 0, `${kind}: ...but not when cd-page is something else`);
      for (const other of scoped.map((s) => s[1]).filter((s) => s !== scope)) {
        assert.equal(right.filter((s) => s.rule.selector.includes(`[cd-page="${other}"]`)).reduce((n, s) => n + s.els.size, 0), 0, `${kind} page: ${other} rules stay out`);
      }
    }
  });

  test('pages the skin has no page rules for (home, watch, shorts, other) stay on the global rules only', () => {
    for (const attr of ['home', 'watch', 'shorts', 'other']) {
      const sets = matchedSets(skinnedPage('home', { tiles: 3 }, { 'cd-page': attr }).document);
      assert.equal(sets.filter((s) => /\[cd-page=/.test(s.rule.selector)).reduce((n, s) => n + s.els.size, 0), 0, attr);
      assert.ok(count(sets, 'ytd-masthead #background') > 0, 'but the shell is still skinned');
    }
  });

  test('without the cd-theme attribute nothing matches: removing the theme returns the page to YouTube', () => {
    const page = skinnedPage('watch', { tiles: 4 });
    page.document.documentElement.removeAttribute('cd-theme');
    for (const s of matchedSets(page.document)) assert.equal(s.els.size, 0, s.rule.selector.slice(0, 100));
  });

  test('the player, its controls and everything inside are never touched by the page-wide rules', () => {
    const page = skinnedPage('watch', { tiles: 4, ads: true });
    const { document } = page;
    const sets = matchedSets(document);
    const broad = sets.filter((s) => s.rule.selector.includes(':where('));
    assert.equal(broad.length, 2, 'the font rule and the focus ring');
    const player = document.querySelector('#movie_player');
    assert.ok(player);
    const inside = [player, ...player.querySelectorAll('*')];
    assert.ok(inside.length > 40, 'the real player skeleton has many nodes');
    for (const required of ['.ytp-chrome-bottom', '.ytp-ce-element', '.ytp-paid-content-overlay', '.ytp-ad-progress-list', '.ytp-ad-module', 'video']) {
      assert.ok(player.querySelector(required), `fixture check: the player contains ${required}`);
    }
    for (const { rule, els } of broad) for (const el of inside) assert.ok(!els.has(el), `${rule.selector.slice(0, 60)}... reaches into the player: <${el.localName} class="${el.className}">`);
    // ...and they still reach the page around it
    const font = broad.find((s) => !s.rule.selector.includes(':focus-visible'));
    for (const sel of ['ytd-watch-metadata h1', 'ytd-masthead', '#related a', 'ytd-comments-header-renderer']) {
      assert.ok(font.els.has(document.querySelector(sel)), `${sel} gets the theme font`);
    }
    const focus = broad.find((s) => s.rule.selector.includes('focus-visible') || s.rule.decls.some((d) => d.prop === 'outline'));
    assert.ok(focus.els.has(document.querySelector('input.ytSearchboxComponentInput')), 'the search box gets a focus ring');
  });

  test('Cinedrape\'s own elements and their children keep the theme\'s font; look-alike classes do not', () => {
    const { document } = skinnedPage('home', { tiles: 4 });
    const host = document.querySelector('ytd-browse');
    host.insertAdjacentHTML('afterbegin', [
      '<div id="own1" class="cd-home"><div id="own2" class="cd-hero cd-x"><h2 id="own3" class="cd-hero-title">Title <a id="own4" href="/watch?v=a"><span id="own5">link</span></a></h2></div></div>',
      '<div id="own6" class="x cd-row"><a id="own7" href="#">card</a></div>',
      '<div id="yt1" class="abcd-foo">not ours</div><div id="yt2" class="mycd-x">not ours</div><div id="yt3" class="x scd-y"><b id="yt4">child</b></div>',
    ].join(''));
    const font = matchedSets(document).find((s) => s.rule.selector.includes(':where(') && !s.rule.selector.includes('focus'));
    for (const id of ['own1', 'own2', 'own3', 'own4', 'own5', 'own6', 'own7']) assert.ok(!font.els.has(document.getElementById(id)), `#${id} is ours`);
    for (const id of ['yt1', 'yt2', 'yt3', 'yt4']) assert.ok(font.els.has(document.getElementById(id)), `#${id} is YouTube's`);
    const tile = document.querySelector('yt-lockup-view-model');
    assert.ok(font.els.has(tile), 'YouTube tiles get the font');
    tile.setAttribute('cd-source', '');
    assert.ok(matchedSets(document).find((s) => s.rule.selector.includes(':where(') && !s.rule.selector.includes('focus')).els.has(tile), 'a mirrored source tile is still YouTube\'s');
  });

  test('ads, sponsorship disclosures and player controls only ever receive paint (never geometry, visibility or position)', () => {
    const protectedSelectors = ['ads', 'sponsor', 'playerControls'].flatMap((g) => MAP.protected[g]).join(',');
    const pages = [
      skinnedPage('home', { tiles: 6, ads: 3 }), skinnedPage('watch', { tiles: 6, ads: true }), skinnedPage('search', { tiles: 5, ads: 2 }),
      skinnedPage('channel', { tiles: 4, ads: 1 }), skinnedPage('subscriptions', { tiles: 4, ads: 1 }),
    ];
    let checked = 0;
    for (const page of pages) {
      const sets = matchedSets(page.document);
      const ads = [...page.document.querySelectorAll(protectedSelectors)];
      assert.ok(ads.length > 0, `${page.kind}: fixture has protected elements`);
      for (const el of ads) {
        checked++;
        const props = new Set(sets.filter((s) => s.els.has(el)).flatMap((s) => s.rule.decls.map((d) => d.prop)));
        for (const p of props) assert.ok(PAINT_ONLY.has(p), `${page.kind}: <${el.localName} class="${el.className}"> receives ${p}`);
        for (const s of sets.filter((x) => x.els.has(el))) for (const d of s.rule.decls) assert.ok(!hidesDecl(d), `${s.rule.selector.slice(0, 80)}`);
      }
    }
    assert.ok(checked > 40, `${checked} protected elements inspected`);
  });

  test('the skeleton of the page (grid, rows, continuation, page manager, player frame) gets no layout declaration at all', () => {
    const structure = ['homeGrid', 'homeGridContents', 'richItem', 'continuation', 'pageManager', 'watchFlexy', 'watchPlayerContainer', 'watchPrimary', 'watchSecondary', 'shortsShelf']
      .flatMap((role) => MAP.roles[role]);
    const geometry = new Set(['display', 'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height', 'margin', 'padding', 'position', 'top', 'left', 'z-index',
      'transform', 'visibility', 'opacity', 'overflow', 'flex', 'grid', 'contain', 'content-visibility']);
    for (const kind of ['home', 'channel', 'watch', 'playlist']) {
      const page = skinnedPage(kind, { tiles: 5, shorts: true });
      const sets = matchedSets(page.document);
      const els = [...page.document.querySelectorAll(structure.join(','))];
      assert.ok(els.length >= (kind === 'playlist' ? 1 : 4), `${kind}: structural elements present (${els.length})`);
      for (const el of els) {
        for (const s of sets.filter((x) => x.els.has(el))) for (const d of s.rule.decls) assert.ok(!geometry.has(d.prop), `${kind}: <${el.localName}> gets ${d.prop}`);
      }
    }
    // the infinite-scroll trigger in particular
    const page = skinnedPage('channel', { tiles: 4 });
    const cont = page.document.querySelector('ytd-continuation-item-renderer');
    assert.ok(cont);
    const props = new Set(matchedSets(page.document).filter((s) => s.els.has(cont)).flatMap((s) => s.rule.decls.map((d) => d.prop)));
    assert.deepEqual([...props].filter((p) => p !== 'font-family'), []);
  });

  test('the home grid is skinned in both tile shapes (default channel-grid tiles and the real home tile)', () => {
    for (const tileStyle of ['grid', 'home']) {
      const sets = matchedSets(skinnedPage('home', { tiles: 6, tileStyle }).document);
      assert.ok(count(sets, 'yt-thumbnail-view-model') >= 6, tileStyle);
      assert.ok(count(sets, 'a.ytLockupMetadataViewModelTitle') >= 6, tileStyle);
      assert.ok(count(sets, '.ytContentMetadataViewModelMetadataText') >= 6, tileStyle);
    }
  });

  test('survives a YouTube rename that the map has not caught up with: the renamed parts just stop matching, the rest still works', () => {
    // one of the tileTitle selectors (the h3 heading) keeps working on its own: that is what the map's fallbacks are for
    const partial = skinnedPage('home', { tiles: 4, rename: ['.ytLockupMetadataViewModelTitle'] });
    assert.ok(partial.renamed >= 4, 'fixture check: the rename touched the tiles');
    assert.ok(count(matchedSets(partial.document), 'a.ytLockupMetadataViewModelTitle') >= 4, 'the h3 fallback still matches');
    // rename everything the role knows about and the title rule matches nothing, without any error
    const page = skinnedPage('home', { tiles: 4, rename: ['.ytLockupMetadataViewModelTitle', '.ytLockupMetadataViewModelHeadingReset', 'yt-thumbnail-view-model'] });
    const sets = matchedSets(page.document);
    assert.equal(count(sets, 'a.ytLockupMetadataViewModelTitle'), 0);
    assert.equal(count(sets, 'yt-thumbnail-view-model'), 0);
    assert.ok(count(sets, 'ytd-masthead #background') > 0, 'the shell is still skinned');
    assert.ok(count(sets, '.ytContentMetadataViewModelMetadataText') >= 4, 'unrelated parts are unaffected');
  });
});

// =============================================================================================================================

describe('cascade: the skin beats YouTube\'s own rules (computed colours in jsdom)', () => {
  const values = deriveTokens(CINEMA, {}, MAP);
  const SKIN = inlineVars(CSS, values);
  // What YouTube's stylesheet would say about the same elements (selectors as in the fixtures, appended AFTER the skin).
  const YOUTUBE = `
    ytd-masthead #background{background-color:rgb(15,15,15)}
    .ytSearchboxComponentInputBox{background-color:#121212}
    .ytSearchboxComponentInput{color:#ffffff}
    a.ytLockupMetadataViewModelTitle{color:#f1f1f1;font-family:Roboto,Arial,sans-serif;font-weight:500}
    .ytContentMetadataViewModelMetadataText{color:#aaaaaa}
    .ytChipShapeInactive{background-color:rgba(255,255,255,0.1);color:#f1f1f1}
    .ytChipShapeActive{background-color:#f1f1f1;color:#0f0f0f}
    ytd-watch-metadata #title h1{color:#f1f1f1;font-family:Roboto,Arial,sans-serif}
    ytd-watch-metadata #description{background-color:rgba(255,255,255,0.1)}
    yt-formatted-string,ytd-comments-header-renderer,.ytp-time-display,.cd-hero-title,.cd-hero-title span{font-family:Roboto,Arial,sans-serif}
    .yt-spec-button-shape-next--filled.yt-spec-button-shape-next--mono{background-color:#f1f1f1;color:#0f0f0f}
    .yt-spec-button-shape-next--tonal{background-color:rgba(255,255,255,0.1);color:#f1f1f1}
    ytd-menu-popup-renderer{background-color:#282828;color:#f1f1f1}
    .metadata-snippet-text{color:#aaaaaa}
    yt-page-navigation-progress #progress{background-color:#f03}
    ytd-app{background-color:#ffffff}
    ytd-page-manager{background-color:#ffffff}
    .ytAttributedStringLinkCallToActionColor{color:#065fd4}
    ytd-expandable-metadata-renderer[use-custom-colors]{background:var(--yt-lightsource-section2-color);color:var(--yt-lightsource-primary-title-color)}
  `;

  // What YouTube's inline <style> says about <html> (verified live): !important in both modes. It goes into a sheet BEFORE the skin because
  // jsdom ranks two !important declarations by source order alone; a real browser ranks specificity first (see the specificity test above).
  const YOUTUBE_HTML = 'html{background-color:#ffffff!important} html[dark]{background-color:#0f0f0f!important}';

  function stage(kind, opts = {}) {
    const page = createPage(kind, { tiles: 4, ...opts });
    const { document } = page;
    const root = document.documentElement;
    root.setAttribute('cd-theme', 'cinema');
    root.setAttribute('cd-page', kind);
    // SYNTHETIC: components the fixtures were stripped of (buttons, menus, chip-less nav progress) and a Cinedrape hero
    document.querySelector('ytd-page-manager').insertAdjacentHTML('beforeend', `
      <div id="syn"><button id="subscribe" class="yt-spec-button-shape-next yt-spec-button-shape-next--filled yt-spec-button-shape-next--mono">Subscribe</button>
      <button id="tonal" class="yt-spec-button-shape-next yt-spec-button-shape-next--tonal">Join</button>
      <ytd-menu-popup-renderer id="menu">Menu</ytd-menu-popup-renderer>
      <span id="run" class="ytAttributedStringHost" style="color: rgb(19, 19, 19);">Handle</span>
      <span id="inh" class="ytAttributedStringLinkInheritColor" style="font-weight: 400; color: rgb(6, 95, 212);"><a id="cta" class="ytAttributedStringLink ytAttributedStringLinkCallToActionColor" href="#">link</a></span>
      <span id="badge" class="ytAttributedStringHost" style="color: #ff0000; background-color: #ffff00;">Badge</span>
      <ytd-expandable-metadata-renderer id="summary" use-custom-colors style="--yt-lightsource-section2-color: rgba(247,248,241,1); --yt-lightsource-primary-title-color: rgba(23,25,16,1);">Summary</ytd-expandable-metadata-renderer>
      <div class="cd-hero"><h2 class="cd-hero-title">Hero <span id="heroSpan">x</span></h2></div></div>`);
    const early = document.createElement('style');
    early.textContent = YOUTUBE_HTML;
    document.head.appendChild(early);
    const skin = document.createElement('style');
    skin.textContent = SKIN;
    document.head.appendChild(skin);
    const yt = document.createElement('style');
    yt.textContent = YOUTUBE;
    document.head.appendChild(yt);
    assert.ok(skin.sheet.cssRules.length >= 40, 'the browser engine parsed the skin');
    return { ...page, cs: (sel) => page.window.getComputedStyle(document.querySelector(sel)) };
  }

  test('colours: masthead, search box, titles, meta, chips, description, buttons, menu', () => {
    const p = stage('channel');
    sameColour(p.cs('ytd-masthead #background').backgroundColor, values['--cd-bg'], 'masthead bar');
    sameColour(p.cs('.ytSearchboxComponentInputBox').backgroundColor, values['--cd-surface'], 'search box');
    sameColour(p.cs('.ytSearchboxComponentInput').color, values['--cd-text'], 'search input text');
    sameColour(p.cs('a.ytLockupMetadataViewModelTitle').color, values['--cd-text'], 'tile title');
    sameColour(p.cs('.ytContentMetadataViewModelMetadataText').color, values['--cd-muted'], 'tile meta');
    sameColour(p.cs('.ytChipShapeActive').backgroundColor, values['--cd-accent'], 'active chip');
    sameColour(p.cs('.ytChipShapeActive').color, values['--cd-accent-text'], 'active chip label');
    sameColour(p.cs('.ytChipShapeInactive').backgroundColor, values['--cd-hover'], 'inactive chip');
    sameColour(p.cs('.ytChipShapeInactive').color, values['--cd-text'], 'inactive chip label');
    sameColour(p.cs('#subscribe').backgroundColor, values['--cd-accent'], 'primary button');
    sameColour(p.cs('#subscribe').color, values['--cd-accent-text'], 'primary button label');
    sameColour(p.cs('#tonal').backgroundColor, values['--cd-hover'], 'tonal button');
    sameColour(p.cs('#menu').backgroundColor, values['--cd-menu'], 'menu');
    sameColour(p.cs('yt-page-navigation-progress #progress').backgroundColor, values['--cd-accent'], 'progress bar');
    sameColour(p.cs('html').backgroundColor, values['--cd-bg'], 'page');
  });

  test('the page surface beats the !important html rules of YouTube in both modes, and the shell follows', () => {
    for (const dark of [false, true]) {
      const p = stage('channel', { dark });
      sameColour(p.cs('html').backgroundColor, values['--cd-bg'], `html, YouTube ${dark ? 'dark' : 'light'}`);
      sameColour(p.cs('ytd-app').backgroundColor, values['--cd-bg'], 'app shell');
      sameColour(p.cs('ytd-page-manager').backgroundColor, values['--cd-bg'], 'page manager');
    }
  });

  test('inline colours YouTube resolved for its own mode lose to the skin; ones with their own background are left alone', () => {
    const p = stage('channel');
    sameColour(p.cs('#run').color, values['--cd-text'], 'a run with an inline colour inherits the surrounding (theme) text colour');
    sameColour(p.cs('#inh').color, values['--cd-text'], 'the inherit-colour wrapper too');
    sameColour(p.cs('#cta').color, values['--cd-accent'], 'call-to-action links take the accent');
    sameColour(p.cs('#badge').color, '#ff0000', 'an element that paints its own background keeps its inline colour');
  });

  test('the video-tinted component palette is replaced by the surfaces and text of the theme', () => {
    const p = stage('search');
    const cs = p.cs('#summary');
    assert.equal(cs.getPropertyValue('--yt-lightsource-section2-color').trim(), values['--cd-surface']);
    assert.equal(cs.getPropertyValue('--yt-lightsource-primary-title-color').trim(), values['--cd-text']);
    // (jsdom does not resolve var() inside background/color, so the palette variables are what is checked; the browser run covers the paint)
  });

  test('colours: watch page title and description box; search snippets only on the search page', () => {
    const w = stage('watch');
    sameColour(w.cs('ytd-watch-metadata #title h1').color, values['--cd-text'], 'watch title');
    sameColour(w.cs('ytd-watch-metadata #description').backgroundColor, values['--cd-surface'], 'description box');
    const s = stage('search');
    sameColour(s.cs('.metadata-snippet-text').color, values['--cd-muted'], 'search snippet');
    const home = stage('home');
    home.document.querySelector('ytd-browse').insertAdjacentHTML('beforeend', '<div class="metadata-snippet-text" id="snip">s</div>');
    sameColour(home.cs('#snip').color, '#aaaaaa', 'the search rule does not leak onto the home page');
  });

  test('font: forced on YouTube text, but not in the player and not on Cinedrape\'s own elements', () => {
    const w = stage('watch');
    const fam = (v) => v.replace(/["']/g, '').replace(/\s*,\s*/g, ',').trim();
    const inter = fam(values['--cd-font-family']);
    const youtube = 'Roboto,Arial,sans-serif';
    assert.equal(fam(w.cs('ytd-watch-metadata #title h1').fontFamily), inter, 'title uses the heading font, which falls back to the theme font');
    assert.equal(fam(w.cs('ytd-comments-header-renderer').fontFamily), inter);
    assert.equal(fam(w.cs('a.ytLockupMetadataViewModelTitle').fontFamily), inter, 'beats a font set by a more specific YouTube rule');
    assert.equal(fam(w.cs('.ytp-time-display').fontFamily), youtube, 'the player keeps YouTube\'s font');
    assert.equal(fam(w.cs('.cd-hero-title').fontFamily), youtube, 'own elements are left to the theme');
    assert.equal(fam(w.cs('#heroSpan').fontFamily), youtube);
    assert.equal(fam(w.cs('html').fontFamily), inter);
  });

  test('a later YouTube rule of the same specificity does not undo the skin (it is scoped under html[cd-theme])', () => {
    const p = stage('channel');
    // YouTube's `ytd-masthead #background` (1,0,1) comes later than ours; ours is (1,1,2)
    sameColour(p.cs('ytd-masthead #background').backgroundColor, values['--cd-bg']);
    // and with the attribute gone the page is YouTube's again
    p.document.documentElement.removeAttribute('cd-theme');
    sameColour(p.cs('ytd-masthead #background').backgroundColor, 'rgb(15,15,15)');
    sameColour(p.cs('.ytChipShapeActive').backgroundColor, '#f1f1f1');
  });

  test('light themes work the same way: values come from the theme\'s tokens', () => {
    const minimal = themeJson('minimal');
    const light = deriveTokens(minimal, {}, MAP);
    const page = createPage('channel', { tiles: 3, dark: true });
    const { document, window } = page;
    document.documentElement.setAttribute('cd-theme', 'minimal');
    document.documentElement.setAttribute('cd-page', 'channel');
    const skin = document.createElement('style');
    skin.textContent = inlineVars(buildSkinCss(MAP, { theme: minimal, disabled: [] }), light);
    document.head.appendChild(skin);
    const yt = document.createElement('style');
    yt.textContent = YOUTUBE;
    document.head.appendChild(yt);
    const cs = (sel) => window.getComputedStyle(document.querySelector(sel));
    sameColour(cs('ytd-masthead #background').backgroundColor, '#ffffff');
    sameColour(cs('a.ytLockupMetadataViewModelTitle').color, light['--cd-text']);
    sameColour(cs('.ytChipShapeActive').backgroundColor, light['--cd-accent']);
    sameColour(cs('.ytChipShapeActive').color, light['--cd-accent-text']);
  });

  test('disabled: the empty sheet leaves every YouTube colour alone', () => {
    const page = createPage('channel', { tiles: 3 });
    const { document, window } = page;
    document.documentElement.setAttribute('cd-theme', 'cinema');
    const skin = document.createElement('style');
    skin.textContent = buildSkinCss(MAP, { theme: CINEMA, disabled: ['theme'] });
    document.head.appendChild(skin);
    const yt = document.createElement('style');
    yt.textContent = YOUTUBE;
    document.head.appendChild(yt);
    sameColour(window.getComputedStyle(document.querySelector('.ytChipShapeActive')).backgroundColor, '#f1f1f1');
  });
});

// =============================================================================================================================

describe('the whole stylesheet the engine injects (tokens + skin + theme CSS)', () => {
  test('parses cleanly in the browser engine for all six themes, with and without a custom accent', () => {
    for (const theme of THEMES) {
      for (const user of [{}, { accent: '#ff8800', animations: false }]) {
        const page = createPage('home', { tiles: 4 });
        const tokenCss = buildTokenCss(theme, user, MAP);
        const skinCss = buildSkinCss(MAP, { theme, disabled: [] });
        const full = [tokenCss, skinCss, theme.css].join('\n');
        const style = page.document.createElement('style');
        style.textContent = full;
        page.document.head.appendChild(style);
        const expected = 1 + parseSheet(skinCss).filter((r) => !r.media).length + 1 /* @media */ + parseSheet(theme.css).length;
        assert.equal(style.sheet.cssRules.length, expected, `${theme.id}: every rule was accepted`);
        assert.deepEqual(page.errors, [], `${theme.id}: no jsdom errors`);
        assert.ok(full.length < 40 * 1024 + 8 * 1024, `${theme.id}: ${full.length} bytes`);
      }
    }
  });

  test('theme tokens reach the page: --cd-* on html[cd-theme] and the YouTube variables point at them', () => {
    for (const theme of THEMES) {
      const page = createPage('watch', { tiles: 3, dark: theme.tokens.color.bg.length > 0 && ['cinema', 'primetime', 'arcade'].includes(theme.id) });
      const { document, window } = page;
      const style = document.createElement('style');
      style.textContent = [buildTokenCss(theme, {}, MAP), buildSkinCss(MAP, { theme, disabled: [] })].join('\n');
      document.head.appendChild(style);
      document.documentElement.setAttribute('cd-theme', theme.id);
      const cs = window.getComputedStyle(document.documentElement);
      assert.equal(cs.getPropertyValue('--cd-accent'), theme.tokens.color.accent, theme.id);
      assert.equal(cs.getPropertyValue('--cd-bg'), theme.tokens.color.bg, theme.id);
      assert.equal(cs.getPropertyValue('--yt-sys-color-baseline--base-background'), 'var(--cd-bg)', theme.id);
      assert.equal(cs.getPropertyValue('color-scheme'), ['cinema', 'primetime', 'arcade'].includes(theme.id) ? 'dark' : 'light', theme.id);
    }
  });
});
