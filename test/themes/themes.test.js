// Tests for the six launch themes (src/themes/*.json, src/themes/index.js). ARCHITECTURE.md section 3.3 / 4, spec "Launch theme briefs".
//
// How the tests are wired
// - validateTheme runs with the REAL selector map. theme-schema.js imports css-validator.js, another agent's file; when it does not
//   exist yet a no-op stand-in lets the module load, and the tests that need the real validator are skipped with a reason.
//   Everything the contract promises about theme CSS is ALSO checked here by an independent reader, so a missing validator never
//   leaves the CSS unchecked.
// - Theme CSS is run against a DOM built from the class list of section 3.5 (and the structure home.js builds), so a typo in a
//   class name, or a rule that can never match, fails here.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { ALL_THEME_IDS, CALM_KEYS, FREE_CALM_KEYS, FREE_THEME_IDS, LAYOUT_HOME, LAYOUT_WATCH, LIMITS } from '../../src/shared/constants.js';
import { checkThemeContrast, contrastRatio, parseColor, relativeLuminance } from '../../src/shared/contrast.js';
import { computeEffectiveConfig } from '../../src/shared/entitlements.js';
import { THEMES, THEME_META, getTheme } from '../../src/themes/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const REAL_VALIDATOR = existsSync(path.join(SRC, 'shared', 'css-validator.js'));
const NEEDS_VALIDATOR = REAL_VALIDATOR ? false : 'src/shared/css-validator.js is not written yet';
const FILES = Object.fromEntries(ALL_THEME_IDS.map((id) => [id, path.join(SRC, 'themes', `${id}.json`)]));
const RAW = Object.fromEntries(ALL_THEME_IDS.map((id) => [id, readFileSync(FILES[id], 'utf8')]));
const JSON_THEMES = ALL_THEME_IDS.map((id) => JSON.parse(RAW[id]));
const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));

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
const CSS_VALIDATOR_STAND_IN = {
  specifier: './css-validator.js',
  real: path.join(SRC, 'shared', 'css-validator.js'),
  source: 'export const buildAllowList = () => []; export const validateCss = () => ({ ok: true, errors: [] });',
};
const { validateTheme, FONT_STACKS } = await importWithStandIns(path.join(SRC, 'shared', 'theme-schema.js'), [CSS_VALIDATOR_STAND_IN]);
const { deriveTokens, buildTokenCss } = await importWithStandIns(path.join(SRC, 'shared', 'tokens.js'), [CSS_VALIDATOR_STAND_IN]);

// ---- an independent reader for theme CSS ---------------------------------------------------------------------------------

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
  assert.equal(depth, 0, 'unbalanced brackets');
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}

/** [{selectors:[string], decls:[{prop,value}]}]. Theme CSS may not contain at-rules (asserted separately). */
function parseThemeCss(css) {
  assert.ok(!css.includes('@'), 'the launch themes use no at-rules');
  assert.ok(!css.includes('/*'), 'no comments');
  const rules = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open < 0) { assert.equal(css.slice(i).trim(), ''); break; }
    const close = css.indexOf('}', open);
    assert.ok(close > open, 'unclosed rule');
    assert.ok(!css.slice(open + 1, close).includes('{'), 'nested rule');
    const decls = splitTop(css.slice(open + 1, close), ';').map((d) => {
      const k = d.indexOf(':');
      assert.ok(k > 0, `declaration without a colon: ${d}`);
      return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() };
    });
    rules.push({ selectors: splitTop(css.slice(i, open), ','), decls });
    i = close + 1;
  }
  return rules;
}

const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw|ch)?$/;
function hidesDecl({ prop, value }) {
  const v = value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  switch (prop.toLowerCase()) {
    case 'display': return v === 'none' || v === 'contents';
    case 'visibility': return v === 'hidden' || v === 'collapse';
    case 'opacity': return !(Number.parseFloat(v) >= 1);
    case 'height': case 'width': case 'max-height': case 'max-width': case 'font-size': case 'line-height': return ZERO.test(v);
    case 'clip': return v !== 'auto';
    case 'clip-path': case 'filter': case 'backdrop-filter': case 'mask': case 'mask-image': return v !== 'none';
    case 'transform': return /scale(x|y|3d)?\(\s*0(\.0+)?\s*[,)]/.test(v);
    case 'content-visibility': return v === 'hidden' || v === 'auto';
    case 'pointer-events': return v === 'none';
    case 'position': return v === 'fixed' || v === 'absolute' || v === 'sticky';
    case 'z-index': return true;
    case 'color': case 'background-color': return v === 'transparent';
    case 'text-indent': case 'left': case 'right': case 'top': case 'bottom': case 'margin-left': case 'margin-top': return /^-\d{3,}/.test(v);
    default: return false;
  }
}

/** The classes section 3.5 gives to Cinedrape's own DOM. */
const OWN_CLASSES = new Set(['cd-home', 'cd-hero', 'cd-hero-media', 'cd-hero-body', 'cd-hero-title', 'cd-hero-meta', 'cd-hero-cta', 'cd-row', 'cd-row-title',
  'cd-row-track', 'cd-row-prev', 'cd-row-next', 'cd-card', 'cd-card-thumb', 'cd-card-title', 'cd-card-meta', 'cd-card-duration', 'cd-notice']);
// Variables a theme may read: tokens.js, density.js, or its own declaration.
const DENSITY_VARS = new Set(['--cd-gap', '--cd-card-min', '--cd-row-gap']);

/** Checks one selector: only html[cd-...] roots, .cd- classes, :pseudo-classes and combinators. Returns a list of complaints. */
function selectorProblems(sel) {
  const problems = [];
  const stripped = sel.replace(/\[[^\]]*\]/g, (m) => {
    if (!/^\[cd-[a-z-]+(?:="[^"]*")?\]$/.test(m)) problems.push(`attribute ${m} is not a cd- attribute`);
    return '[]';
  });
  for (const m of stripped.matchAll(/(^|[\s>+~(,])([A-Za-z][\w-]*)/g)) if (m[2] !== 'html') problems.push(`element selector "${m[2]}"`);
  for (const m of stripped.matchAll(/\.([\w-]+)/g)) if (!m[1].startsWith('cd-')) problems.push(`class .${m[1]}`);
  if (/#[\w-]/.test(stripped)) problems.push('an id selector');
  if (/(^|\s)\*/.test(stripped) || /\*\s*[{,]?$/.test(stripped)) problems.push('universal selector');
  if (/^html\[\]\s*$/.test(stripped) && !/^html\[cd-theme\]$/.test(sel)) problems.push('bare root');
  return problems;
}

const sameColourHex = (a, b) => {
  const x = parseColor(a);
  const y = parseColor(b);
  return x && y && x.r === y.r && x.g === y.g && x.b === y.b;
};
const hue = (hex) => {
  const { r, g, b } = parseColor(hex);
  return { max: Math.max(r, g, b), min: Math.min(r, g, b), r, g, b };
};
const lum = (hex) => relativeLuminance(hex);

// =============================================================================================================================

describe('the bundle', () => {
  test('16 themes, in the order of ALL_THEME_IDS, ids and names unique', () => {
    assert.equal(THEMES.length, 16);
    assert.deepEqual(THEMES.map((t) => t.id), ALL_THEME_IDS);
    assert.deepEqual(ALL_THEME_IDS, [
      'cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade',
      'oled', 'frost', 'mocha', 'midnight-city', 'ember', 'paper', 'matcha', 'sunset', 'terminal', 'imax',
    ]);
    assert.deepEqual(THEMES.map((t) => t.name), [
      'Cinema', 'Minimal', 'Classic', 'Prime Time', 'Studio', 'Arcade',
      'True Black', 'Frost', 'Mocha', 'Midnight City', 'Ember', 'Paper Study', 'Matcha', 'Sunset', 'Retro Terminal', 'Big Screen',
    ]);
    assert.equal(new Set(THEMES.map((t) => t.id)).size, 16);
    assert.equal(new Set(THEMES.map((t) => t.name)).size, 16);
  });

  test('tiers match the constants: all 16 themes are free', () => {
    assert.deepEqual(THEMES.filter((t) => t.tier === 'free').map((t) => t.id), FREE_THEME_IDS);
    assert.deepEqual(FREE_THEME_IDS, ALL_THEME_IDS);
    assert.equal(THEMES.filter((t) => t.tier === 'free').length, 16);
    assert.equal(THEMES.filter((t) => t.tier === 'pro').length, 0);
    for (const t of THEMES) assert.equal(t.tier, 'free', t.id);
  });

  test('every theme file is fully specified: the bundled object equals the file, and every field of section 3.3 is present', () => {
    for (const [i, t] of THEMES.entries()) {
      assert.deepEqual(t, JSON_THEMES[i], t.id);
      assert.equal(t.schema, 1);
      assert.equal(t.author, 'Cinedrape');
      assert.match(t.version, /^\d+\.\d+\.\d+$/);
      for (const k of ['bg', 'surface', 'text', 'muted', 'accent', 'border']) assert.match(t.tokens.color[k], /^#[0-9a-f]{6}$/, `${t.id}.${k}`);
      assert.ok(Object.hasOwn(FONT_STACKS, t.tokens.type.family), `${t.id} font ${t.tokens.type.family}`);
      assert.ok(t.tokens.type.baseSize >= 12 && t.tokens.type.baseSize <= 20);
      assert.ok(Number.isInteger(t.tokens.type.headingWeight) && t.tokens.type.headingWeight % 100 === 0);
      assert.equal(typeof t.tokens.shape.shadow, 'boolean');
      assert.ok(Number.isInteger(t.tokens.shape.spacing) && t.tokens.shape.spacing >= 1 && t.tokens.shape.spacing <= 5);
      assert.ok(t.tokens.shape.radius >= 0 && t.tokens.shape.radius <= 32);
      assert.ok(LAYOUT_HOME.includes(t.layout.home) && LAYOUT_WATCH.includes(t.layout.watch));
      assert.ok(Number.isInteger(t.layout.density) && t.layout.density >= 1 && t.layout.density <= 5);
      assert.equal(typeof t.css, 'string');
    }
  });

  test('files are plain ASCII with LF line endings, no BOM, one trailing newline', () => {
    for (const id of ALL_THEME_IDS) {
      const raw = RAW[id];
      assert.doesNotMatch(raw, /[^\x09\x0a\x20-\x7e]/, `${id}: non-ASCII or control character`);
      assert.ok(!raw.includes('\r'), `${id}: CR`);
      assert.ok(raw.endsWith('}\n') && !raw.endsWith('\n\n'), `${id}: ends with one newline`);
      assert.ok(raw.length < 3000, `${id}: ${raw.length} bytes`);
    }
  });

  test('each theme is distinct: backgrounds, accents and personalities all differ', () => {
    for (const key of ['bg', 'accent']) assert.equal(new Set(THEMES.map((t) => t.tokens.color[key])).size, 16, key);
    assert.equal(new Set(THEMES.map((t) => t.css)).size, 16);
  });

  test('the bundle is frozen all the way down: a caller cannot change a theme for everyone', () => {
    assert.ok(Object.isFrozen(THEMES));
    for (const t of THEMES) {
      assert.ok(Object.isFrozen(t) && Object.isFrozen(t.tokens) && Object.isFrozen(t.tokens.color) && Object.isFrozen(t.layout) && Object.isFrozen(t.calm));
    }
    assert.throws(() => { THEMES[0].tokens.color.bg = '#000000'; }, TypeError);
    assert.throws(() => { THEMES.push({}); }, TypeError);
    assert.throws(() => { THEMES[0].css = 'x'; }, TypeError);
    assert.equal(THEMES[0].tokens.color.bg, '#0b0b0f');
  });
});

describe('getTheme and THEME_META', () => {
  test('getTheme returns the bundled object for each id, and null for everything else', () => {
    for (const t of THEMES) assert.equal(getTheme(t.id), t);
    for (const bad of ['', 'Cinema', 'CINEMA', ' cinema', 'nope', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', 'prototype',
      undefined, null, 0, 1, true, {}, [], ['cinema'], { id: 'cinema' }, () => 'cinema', Symbol('cinema')]) {
      assert.equal(getTheme(bad), null, String(typeof bad === 'symbol' ? 'symbol' : bad));
    }
  });

  test('THEME_META has what the popup needs and nothing heavy: id, name, tier, swatch colours', () => {
    assert.deepEqual(THEME_META.map((m) => m.id), ALL_THEME_IDS);
    assert.ok(Object.isFrozen(THEME_META));
    for (const [i, m] of THEME_META.entries()) {
      const t = THEMES[i];
      assert.deepEqual(Object.keys(m).sort(), ['id', 'name', 'swatch', 'tier']);
      assert.equal(m.name, t.name);
      assert.equal(m.tier, t.tier);
      assert.deepEqual(Object.keys(m.swatch).sort(), ['accent', 'bg', 'border', 'surface', 'text']);
      for (const [k, v] of Object.entries(m.swatch)) assert.equal(v, t.tokens.color[k], `${m.id}.${k}`);
      assert.ok(Object.isFrozen(m) && Object.isFrozen(m.swatch));
      assert.ok(JSON.stringify(m).length < 300, `${m.id} meta is small`);
      assert.throws(() => { m.tier = 'free'; }, TypeError);
    }
  });
});

// =============================================================================================================================

describe('validateTheme (schema, and the CSS validator when it exists)', () => {
  test('every theme passes with the real selector map: no errors, no warnings, nothing normalised away', () => {
    for (const t of JSON_THEMES) {
      const res = validateTheme(t, { selectorMap: MAP });
      assert.deepEqual(res.errors, [], t.id);
      assert.deepEqual(res.warnings, [], t.id);
      assert.equal(res.ok, true, t.id);
      assert.equal(res.cssValidated, true, `${t.id}: validated against the map`);
      assert.deepEqual(res.theme, t, `${t.id}: normalising changes nothing`);
    }
  });

  test('every theme passes without a map too (schema only)', () => {
    for (const t of JSON_THEMES) {
      const res = validateTheme(t);
      assert.equal(res.ok, true, `${t.id} ${JSON.stringify(res.errors)}`);
      assert.equal(res.cssValidated, false);
    }
  });

  test('the real CSS validator is in the loop: it refuses CSS that hides an ad or loads from outside', { skip: NEEDS_VALIDATOR }, () => {
    const t = structuredClone(JSON_THEMES[0]);
    for (const css of ['ytd-ad-slot-renderer{display:none}', '.cd-hero{background:url(https://example.invalid/x.png)}', '@import "x.css";', '.ytp-chrome-bottom{opacity:0}',
      '.cd-hero{content:"' + 'x'.repeat(101) + '"}', '#masthead-ad{height:0}']) {
      const res = validateTheme({ ...t, css }, { selectorMap: MAP });
      assert.equal(res.ok, false, css);
      assert.ok(res.errors.some((e) => e.path === 'css' && Number.isInteger(e.line)), `${css}: the error names a line`);
    }
  });

  test('...and accepts what the launch themes use', { skip: NEEDS_VALIDATOR }, () => {
    for (const t of JSON_THEMES) assert.equal(validateTheme(t, { selectorMap: MAP }).ok, true, t.id);
  });

  test('CSS stays inside LIMITS.cssMaxBytes with a lot of room, and each theme has a short personality (5 to 25 lines)', () => {
    for (const t of THEMES) {
      assert.ok(Buffer.byteLength(t.css) < LIMITS.cssMaxBytes / 4, `${t.id}: ${Buffer.byteLength(t.css)} bytes`);
      const lines = t.css.split('\n');
      assert.ok(lines.length >= 5 && lines.length <= 25, `${t.id}: ${lines.length} lines`);
      assert.ok(lines.every((l) => l.trim() !== ''), `${t.id}: no blank lines`);
    }
  });
});

// =============================================================================================================================

describe('WCAG AA (contract section 4)', () => {
  test('checkThemeContrast passes all six pairs for every theme', () => {
    for (const t of THEMES) {
      const results = checkThemeContrast(t);
      assert.deepEqual(results.map((r) => r.pair), ['text/bg', 'text/surface', 'muted/bg', 'muted/surface', 'accent/bg', 'border/bg']);
      for (const r of results) assert.ok(r.pass, `${t.id} ${r.pair} ${r.ratio} < ${r.required}`);
    }
  });

  test('with room to spare, not by a hair (a user\'s display and a font renderer will not be as exact as the maths)', () => {
    for (const t of THEMES) {
      const c = t.tokens.color;
      assert.ok(contrastRatio(c.text, c.bg) >= 7, `${t.id} text/bg (AAA)`);
      assert.ok(contrastRatio(c.muted, c.bg) >= 5, `${t.id} muted/bg`);
      assert.ok(contrastRatio(c.muted, c.surface) >= 5, `${t.id} muted/surface`);
      assert.ok(contrastRatio(c.accent, c.bg) >= 3.4, `${t.id} accent/bg`);
      assert.ok(contrastRatio(c.border, c.bg) >= 3.1, `${t.id} border/bg`);
    }
  });

  test('also where the skin and the cards put them: border on surface, accent on surface, label on accent', () => {
    for (const t of THEMES) {
      const c = t.tokens.color;
      assert.ok(contrastRatio(c.border, c.surface) >= 3, `${t.id} border/surface ${contrastRatio(c.border, c.surface)}`);
      assert.ok(contrastRatio(c.accent, c.surface) >= 3, `${t.id} accent/surface`);
      const tokens = deriveTokens(t, {}, MAP);
      assert.ok(contrastRatio(tokens['--cd-accent-text'], c.accent) >= 4.5, `${t.id} accent label`);
      assert.ok(contrastRatio(tokens['--cd-accent-text'], tokens['--cd-accent-hover']) >= 4.5, `${t.id} accent label on hover`);
    }
  });

  test('the spec\'s own Cinema example would fail the 3:1 border rule, which is why the bundled border is lighter', () => {
    const example = { tokens: { color: { bg: '#0b0b0f', surface: '#16161d', text: '#f2f2f5', muted: '#9a9aa8', accent: '#e8b04a', border: '#26262f' } } };
    const failed = checkThemeContrast(example).filter((r) => !r.pass).map((r) => r.pair);
    assert.deepEqual(failed, ['border/bg']);
    const cinema = byId.cinema.tokens.color;
    for (const k of ['bg', 'surface', 'text', 'accent']) assert.equal(cinema[k], example.tokens.color[k], k);
  });
});

// =============================================================================================================================

describe('the briefs', () => {
  test('Cinema: near-black with a gold accent, hero banner + cinema watch page, poster-like cards with radius 10', () => {
    const t = byId.cinema;
    assert.equal(t.tokens.color.bg, '#0b0b0f');
    assert.ok(lum(t.tokens.color.bg) < 0.01, 'near-black');
    const a = hue(t.tokens.color.accent);
    assert.ok(a.r > a.g && a.g > a.b && a.r >= 0xd0 && a.g >= 0x90 && a.b <= 0x70, 'gold');
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tokens.shape.radius, 10);
    assert.equal(t.tokens.shape.shadow, true);
    assert.equal(t.tier, 'free');
    assert.match(t.css, /\.cd-hero\b/);
    assert.match(t.css, /\.cd-card-thumb[^{]*\{[^}]*box-shadow/);
  });

  test('Minimal: white or light grey, a plain grid, density 4 (generous), quiet type, nothing that moves on hover', () => {
    const t = byId.minimal;
    assert.ok(lum(t.tokens.color.bg) > 0.85 && lum(t.tokens.color.surface) > 0.85);
    assert.equal(t.layout.home, 'grid');
    assert.equal(t.layout.density, 4);
    assert.ok(t.tokens.shape.spacing >= 4, 'generous spacing');
    assert.equal(t.tokens.shape.shadow, false);
    assert.ok(t.tokens.type.headingWeight <= 500, 'quiet type');
    assert.equal(t.tier, 'free');
    const rules = parseThemeCss(t.css);
    for (const r of rules) for (const d of r.decls) {
      assert.ok(!['animation', 'animation-name'].includes(d.prop), 'no animation');
      if (d.prop === 'transform') assert.equal(d.value, 'none', 'no transform on hover');
      if (d.prop === 'transition') assert.equal(d.value, 'none');
      if (d.prop === 'box-shadow') assert.equal(d.value, 'none');
    }
    assert.match(t.css, /transition:none/);
  });

  test('Classic: compact and nostalgic: low density, small type, near-square corners, no shadows, light', () => {
    const t = byId.classic;
    assert.ok(t.layout.density <= 2, 'compact');
    assert.ok(t.tokens.type.baseSize <= 13);
    assert.ok(t.tokens.shape.radius <= 4);
    assert.equal(t.tokens.shape.shadow, false);
    assert.ok(t.tokens.shape.spacing <= 2);
    assert.ok(lum(t.tokens.color.bg) > 0.7, 'light grey page');
    assert.equal(t.layout.home, 'grid');
    assert.equal(t.tier, 'free');
    assert.match(t.css, /linear-gradient/, 'glossy early-2010s controls');
  });

  test('Prime Time: deep blue, rows by category, a big first strip', () => {
    const t = byId.primetime;
    const bg = hue(t.tokens.color.bg);
    assert.ok(bg.b > bg.r + 20 && bg.b > bg.g + 10, 'blue');
    assert.ok(lum(t.tokens.color.bg) < 0.03, 'deep');
    assert.ok(['rows', 'hero-rows'].includes(t.layout.home));
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tier, 'free');
    assert.ok(t.tokens.type.headingWeight >= 800, 'bold rows');
    assert.match(t.css, /\.cd-row:first-child \.cd-row-title\{[^}]*font-size/, 'the first row title is bigger');
  });

  test('Prime Time\'s first strip shows two fewer cards at once (never fewer than 3), so its cards are bigger at every density and width', async () => {
    // home.js sizes a card as: flex: 0 0 max(--cd-card-min, (100% - (visible - 1) * gap) / visible), with --cd-row-visible set
    // on .cd-home. The theme's rule is the same formula with a smaller visible count, so the maths is re-done here from the
    // numbers in the CSS and compared with density.js's own table.
    const density = await import(pathToFileURL(path.join(SRC, 'content', 'layouts', 'density.js')).href);
    const rule = parseThemeCss(byId.primetime.css).find((r) => r.selectors.includes('.cd-row:first-child .cd-card'));
    assert.ok(rule, 'a rule for the cards of the first row');
    assert.deepEqual(rule.decls.map((d) => d.prop), ['flex']);
    const value = rule.decls[0].value;
    const m = /^0 0 max\(var\(--cd-card-min, (\d+)px\), calc\(\(100% - \(max\((\d+), var\(--cd-row-visible, (\d+)\) - (\d+)\) - 1\) \* var\(--cd-gap, (\d+)px\)\) \/ max\(\2, var\(--cd-row-visible, \3\) - \4\)\)\)$/.exec(value);
    assert.ok(m, `the formula keeps the shape this test models: ${value}`);
    const [minFallback, floor, visibleFallback, fewer] = m.slice(1, 5).map(Number);
    assert.equal(visibleFallback, density.DENSITY_TABLE[3].visible, 'the fallbacks are the default density\'s numbers');
    assert.equal(minFallback, density.DENSITY_TABLE[3].cardMin);
    assert.equal(fewer, 2);
    for (let level = 1; level <= 5; level++) {
      const d = density.DENSITY_TABLE[level];
      const shown = Math.max(floor, d.visible - fewer);
      for (const width of [700, 1000, 1400, 2000]) {
        const normal = Math.max(d.cardMin, (width - (d.visible - 1) * d.gap) / d.visible);
        const strip = Math.max(d.cardMin, (width - (shown - 1) * d.gap) / shown);
        assert.ok(strip >= normal, `density ${level}, ${width}px: ${strip} < ${normal}`);
        assert.ok(strip / normal <= 2.2, `density ${level}, ${width}px: not absurdly large`);
        if (width >= 1400) assert.ok(strip / normal >= 1.25, `density ${level}, ${width}px: ${strip / normal}`);
      }
    }
  });

  test('Prime Time reads the variables home.js and density.js write, each with a fallback', () => {
    const css = byId.primetime.css;
    for (const name of ['--cd-card-min', '--cd-row-visible', '--cd-gap']) assert.match(css, new RegExp(`var\\(${name},`), name);
  });

  test('Studio: light and airy, serif headings, wide margins, roomy', () => {
    const t = byId.studio;
    assert.ok(lum(t.tokens.color.bg) > 0.85);
    assert.ok(t.tokens.shape.spacing >= 4, 'airy');
    assert.ok(t.layout.density >= 4, 'roomy');
    assert.equal(t.tier, 'free');
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'focus');
    assert.match(t.css, /--cd-heading-font:\s*Georgia[^;}]*serif/, 'serif heading font');
    assert.match(t.css, /\.cd-hero-title\{[^}]*font-family:var\(--cd-heading-font\)/);
    assert.match(t.css, /\.cd-row-title\{[^}]*font-family:var\(--cd-heading-font\)/);
    assert.match(t.css, /\.cd-home\{[^}]*padding-inline:calc\(var\(--cd-space\) \* [3-9]\)/, 'wide margins');
    assert.match(FONT_STACKS.Serif, /^Georgia/, 'the serif stack the heading font mirrors');
  });

  test('Arcade: dark with a neon accent, a dense grid, gaming-style cards', () => {
    const t = byId.arcade;
    assert.ok(lum(t.tokens.color.bg) < 0.01);
    const a = hue(t.tokens.color.accent);
    assert.ok(a.max - a.min >= 180 && a.max >= 220, 'saturated and bright: neon');
    assert.equal(t.layout.home, 'grid');
    assert.ok(t.layout.density <= 2, 'dense');
    assert.equal(t.tokens.type.family, 'Condensed');
    assert.equal(t.tier, 'free');
    assert.match(t.css, /\.cd-card:hover\{[^}]*box-shadow:[^}]*var\(--cd-accent\)/, 'glow on hover');
    assert.match(t.css, /\.cd-card-title\{[^}]*text-transform:uppercase/);
  });

  test('OLED: True Black base, dark surface, cool cyan accent, hero-rows cinema', () => {
    const t = byId.oled;
    assert.equal(t.tokens.color.bg, '#000000');
    assert.equal(t.tokens.color.surface, '#0d0d0d');
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tier, 'free');
  });

  test('Frost: slate/ice with cyan accent, calm developer look', () => {
    const t = byId.frost;
    assert.equal(t.tokens.color.bg, '#0f172a');
    assert.equal(t.tokens.color.surface, '#1e293b');
    assert.equal(t.tokens.color.accent, '#22d3ee');
    assert.equal(t.layout.home, 'grid');
    assert.equal(t.layout.watch, 'default');
    assert.equal(t.tier, 'free');
  });

  test('Mocha: warm espresso dark, peach accent, rows cinema', () => {
    const t = byId.mocha;
    assert.equal(t.tokens.color.bg, '#1e181b');
    assert.equal(t.tokens.color.surface, '#2a2226');
    assert.equal(t.tokens.color.accent, '#f5a97f');
    assert.equal(t.layout.home, 'rows');
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tier, 'free');
  });

  test('Midnight City: cyberpunk dark navy, neon violet accent', () => {
    const t = byId['midnight-city'];
    assert.equal(t.tokens.color.bg, '#060814');
    assert.equal(t.tokens.color.surface, '#0f1224');
    assert.equal(t.tokens.color.accent, '#a855f7');
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tier, 'free');
  });

  test('Ember: retro warm dark olive, rust accent', () => {
    const t = byId.ember;
    assert.equal(t.tokens.color.bg, '#151811');
    assert.equal(t.tokens.color.surface, '#21261b');
    assert.equal(t.tokens.color.accent, '#e06b3a');
    assert.equal(t.layout.home, 'grid');
    assert.equal(t.layout.watch, 'default');
    assert.equal(t.tier, 'free');
  });

  test('Paper Study: warm editorial cream, serif headings, calm defaults', () => {
    const t = byId.paper;
    assert.equal(t.tokens.color.bg, '#f6f3eb');
    assert.equal(t.tokens.color.surface, '#ffffff');
    assert.equal(t.tokens.color.accent, '#8c3822');
    assert.equal(t.tokens.type.family, 'Serif');
    assert.equal(t.layout.home, 'grid');
    assert.equal(t.layout.watch, 'focus');
    assert.equal(t.calm.hideShorts, true);
    assert.equal(t.calm.hideHomeRecs, true);
    assert.equal(t.tier, 'free');
  });

  test('Matcha: soft sage light green, quiet rows focus', () => {
    const t = byId.matcha;
    assert.equal(t.tokens.color.bg, '#edf3eb');
    assert.equal(t.tokens.color.surface, '#f7faf5');
    assert.equal(t.tokens.color.accent, '#2c6e3b');
    assert.equal(t.layout.home, 'rows');
    assert.equal(t.layout.watch, 'focus');
    assert.equal(t.tier, 'free');
  });

  test('Sunset: rose dawn pastel peach light, playful hero-rows', () => {
    const t = byId.sunset;
    assert.equal(t.tokens.color.bg, '#fff2eb');
    assert.equal(t.tokens.color.surface, '#ffffff');
    assert.equal(t.tokens.color.accent, '#c93b66');
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'default');
    assert.equal(t.tier, 'free');
  });

  test('Retro Terminal: CRT phosphor monochrome, Mono font, density 1', () => {
    const t = byId.terminal;
    assert.equal(t.tokens.color.bg, '#050905');
    assert.equal(t.tokens.color.surface, '#0d140d');
    assert.equal(t.tokens.color.accent, '#00ff41');
    assert.equal(t.tokens.type.family, 'Mono');
    assert.equal(t.layout.density, 1);
    assert.equal(t.tier, 'free');
  });

  test('Big Screen (IMAX): cinematic wide near-black, density 5, amber accent', () => {
    const t = byId.imax;
    assert.equal(t.tokens.color.bg, '#07070a');
    assert.equal(t.tokens.color.surface, '#111116');
    assert.equal(t.tokens.color.accent, '#ff9f1c');
    assert.equal(t.layout.density, 5);
    assert.equal(t.layout.home, 'hero-rows');
    assert.equal(t.layout.watch, 'cinema');
    assert.equal(t.tier, 'free');
  });

  test('density and layout values are what the engine accepts (LAYOUT_HOME, LAYOUT_WATCH, 1..5)', () => {
    for (const t of THEMES) {
      assert.ok(LAYOUT_HOME.includes(t.layout.home));
      assert.ok(LAYOUT_WATCH.includes(t.layout.watch));
    }
  });

  test('calm defaults only use keys that exist, and a free theme only asks for what a free user may keep', () => {
    for (const t of THEMES) {
      for (const [k, v] of Object.entries(t.calm)) {
        assert.ok(CALM_KEYS.includes(k), `${t.id}.${k}`);
        assert.equal(typeof v, 'boolean');
        if (t.tier === 'free' && v) assert.ok(FREE_CALM_KEYS.includes(k), `${t.id}: ${k} would be silently dropped for free users`);
      }
    }
  });

  test('no other company\'s name appears anywhere in a theme (names, author, CSS, colours)', () => {
    const brands = ['netflix', 'hulu', 'hbo', 'disney', 'amazon', 'prime video', 'primevideo', 'apple', 'google', 'youtube', 'spotify', 'twitch', 'vimeo', 'dailymotion', 'roku',
      'paramount', 'peacock', 'crunchyroll', 'tiktok', 'steam', 'xbox', 'playstation', 'nintendo', 'sega', 'atari', 'myspace', 'facebook', 'metacafe', 'megavideo', 'limewire'];
    for (const id of ALL_THEME_IDS) {
      const text = RAW[id].toLowerCase();
      for (const brand of brands) assert.ok(!new RegExp(`(^|[^a-z])${brand}([^a-z]|$)`).test(text), `${id} mentions ${brand}`);
    }
    // "Prime Time" is the spec's own name for the theme; the word "prime" alone is fine, a streaming brand is not
    assert.equal(byId.primetime.name, 'Prime Time');
  });
});

// =============================================================================================================================

describe('theme CSS (checked by a reader that is independent of the CSS validator)', () => {
  test('selectors target only html[cd-...] roots and cd- classes: nothing of YouTube\'s, so nothing can touch an ad', () => {
    for (const t of THEMES) {
      const rules = parseThemeCss(t.css);
      assert.ok(rules.length >= 5, t.id);
      for (const r of rules) {
        for (const sel of r.selectors) {
          assert.deepEqual(selectorProblems(sel), [], `${t.id}: ${sel}`);
          // a rule is either about a cd- element, or it is the root rule that carries a variable (and nothing else)
          if (!/\.cd-[\w-]+/.test(sel)) {
            assert.match(sel, /^(?:html)?\[cd-theme\]$/, `${t.id}: ${sel} names no cd- class`);
            assert.ok(r.decls.every((d) => d.prop.startsWith('--cd-')), `${t.id}: a root rule may only set variables`);
          }
        }
      }
    }
  });

  test('selectorProblems itself catches what it should', () => {
    for (const bad of ['div', '.foo', '.cd-a .foo', '#x', 'ytd-ad-slot-renderer', 'html[dark]', '*', '.cd-a *', 'body .cd-a', '[class^="ytd-"]', '.cd-a > yt-lockup-view-model']) {
      assert.notDeepEqual(selectorProblems(bad), [], bad);
    }
    for (const good of ['.cd-card', '.cd-card:hover .cd-card-thumb', 'html[cd-theme]', '[cd-theme]', '[cd-density="3"] .cd-row:first-child', '.cd-row-prev']) {
      assert.deepEqual(selectorProblems(good), [], good);
    }
  });

  test('every cd- class a theme uses is one of the classes of section 3.5 (a typo would style nothing)', () => {
    for (const t of THEMES) {
      const used = new Set([...t.css.matchAll(/\.(cd-[\w-]+)/g)].map((m) => m[1]));
      assert.ok(used.size >= 3, t.id);
      for (const c of used) assert.ok(OWN_CLASSES.has(c), `${t.id}: .${c}`);
    }
  });

  test('no declaration hides, collapses, covers or fades anything (contract section 6)', () => {
    for (const t of THEMES) for (const r of parseThemeCss(t.css)) for (const d of r.decls) assert.ok(!hidesDecl(d), `${t.id}: ${r.selectors.join()} { ${d.prop}:${d.value} }`);
  });

  test('nothing that loads or runs: no url(), @-rule, expression(), behavior, binding, import; content values are short', () => {
    for (const t of THEMES) {
      assert.doesNotMatch(t.css, /url\(|@|expression\(|behavior\s*:|-moz-binding|javascript:|<\/?style|\\|\/\*/i, t.id);
      for (const m of t.css.matchAll(/content\s*:\s*([^;}]*)/g)) assert.ok(m[1].length <= 100, `${t.id}: long content value`);
    }
  });

  test('no custom property refers to itself (a cycle makes the property invalid, as the first Prime Time draft did)', () => {
    for (const t of THEMES) {
      for (const r of parseThemeCss(t.css)) {
        for (const d of r.decls) {
          if (!d.prop.startsWith('--')) continue;
          const refs = [...d.value.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
          assert.ok(!refs.includes(d.prop), `${t.id}: ${d.prop} refers to itself`);
        }
      }
    }
  });

  test('every variable read is defined by tokens.js, density.js, or the theme itself (or carries a fallback)', () => {
    const defined = new Set([...Object.keys(deriveTokens(byId.cinema, {}, MAP)), ...DENSITY_VARS]);
    for (const t of THEMES) {
      const own = new Set([...t.css.matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]));
      for (const m of t.css.matchAll(/var\((--[\w-]+)(,)?/g)) {
        assert.ok(m[1].startsWith('--cd-'), `${t.id}: reads ${m[1]}`);
        assert.ok(defined.has(m[1]) || own.has(m[1]) || m[2], `${t.id}: ${m[1]} is never defined`);
      }
    }
  });

  test('theme CSS never sets a variable tokens.js owns (the token rule would win by specificity and the line would do nothing)', () => {
    const owned = new Set(Object.keys(deriveTokens(byId.cinema, {}, MAP)).filter((k) => k.startsWith('--cd-')));
    for (const t of THEMES) {
      for (const r of parseThemeCss(t.css)) for (const d of r.decls) {
        if (!d.prop.startsWith('--cd-')) continue;
        assert.ok(!owned.has(d.prop), `${t.id}: ${d.prop} is a token`);
      }
    }
  });

  test('colours come from the tokens: the only literal colours are the nostalgic gradients of Classic', () => {
    for (const t of THEMES) {
      const literal = [...t.css.matchAll(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/g)].map((m) => m[0]);
      if (t.id === 'classic') assert.ok(literal.length > 0 && literal.length <= 8, 'classic gradients');
      else assert.deepEqual(literal, [], t.id);
    }
  });

  test('a theme still reads right if the user\'s accent replaces the theme\'s: no rule bakes the accent in', () => {
    for (const t of THEMES) {
      assert.ok(!t.css.toLowerCase().includes(t.tokens.color.accent.toLowerCase()), t.id);
      assert.ok(!t.css.toLowerCase().includes(t.tokens.color.bg.toLowerCase()), t.id);
    }
  });
});

// =============================================================================================================================

describe('theme CSS on Cinedrape\'s own DOM (structure as built by layouts/home.js)', () => {
  const HERO = '<div class="cd-hero"><a class="cd-hero-link" href="/watch?v=a"><span class="cd-hero-media"><img alt=""></span>'
    + '<span class="cd-hero-body"><h2 class="cd-hero-title">T</h2><span class="cd-hero-meta"><span>a</span><span>b</span></span><span class="cd-hero-cta">Watch</span></span></a></div>';
  const HOME = (hero = true) => `
    <div class="cd-home">
      ${hero ? HERO : ''}
      <div class="cd-row"><h2 class="cd-row-title">Row</h2><button class="cd-row-prev">&lt;</button><button class="cd-row-next">&gt;</button>
        <div class="cd-row-track">${'<a class="cd-card" href="/watch?v=b"><span class="cd-card-thumb"><img alt=""><span class="cd-card-duration">1:00</span></span><span class="cd-card-body"><span class="cd-card-title">t</span><span class="cd-card-meta"><span>m</span></span></span></a>'.repeat(3)}</div></div>
      <div class="cd-row"><h2 class="cd-row-title">Row 2</h2><button class="cd-row-prev">&lt;</button><button class="cd-row-next">&gt;</button><div class="cd-row-track"></div></div>
    </div>`;

  /** `hero` = the hero-rows layout (a hero comes before the rows); without it the first row is the first child (rows layout). */
  function domFor(density, hero = true) {
    const dom = new JSDOM(`<!doctype html><html cd-theme="x" cd-density="${density}"><body>${HOME(hero)}</body></html>`);
    return dom.window.document;
  }
  const structural = (sel) => sel.replace(/:hover|:focus-visible|:active|:focus/g, '');

  test('no rule is dead: every rule of every theme matches an element of the home layout (with or without the hero)', () => {
    const docs = [true, false].flatMap((hero) => [1, 2, 3, 4, 5].map((level) => domFor(level, hero)));
    for (const t of THEMES) {
      for (const r of parseThemeCss(t.css)) {
        for (const sel of r.selectors) {
          const hit = docs.some((d) => d.querySelector(structural(sel)));
          assert.ok(hit, `${t.id}: ${sel} matches nothing`);
        }
      }
    }
  });

  test('Prime Time\'s first-strip rules reach the first row only, in the rows layout (no hero before it)', () => {
    const doc = domFor(3, false);
    const rows = doc.querySelectorAll('.cd-row');
    assert.equal(rows.length, 2);
    for (const sel of ['.cd-row:first-child .cd-row-title', '.cd-row:first-child .cd-card']) {
      const hits = [...doc.querySelectorAll(sel)];
      assert.ok(hits.length >= 1, sel);
      assert.ok(hits.every((el) => rows[0].contains(el) && !rows[1].contains(el)), `${sel}: first row only`);
    }
    assert.equal(doc.querySelectorAll('.cd-row:first-child .cd-card').length, 3, 'all three cards of the first row');
    // with a hero in front (hero-rows) the strip rules deliberately do not fire: the hero is the big element there
    assert.equal(domFor(3, true).querySelectorAll('.cd-row:first-child').length, 0);
  });

  test('theme CSS applies in the browser engine: every rule is accepted, for all six themes', () => {
    for (const t of THEMES) {
      const dom = new JSDOM(`<!doctype html><html cd-theme="${t.id}" cd-density="3"><head></head><body>${HOME()}</body></html>`);
      const style = dom.window.document.createElement('style');
      style.textContent = [buildTokenCss(t, {}, MAP), t.css].join('\n');
      dom.window.document.head.appendChild(style);
      assert.equal(style.sheet.cssRules.length, 1 + parseThemeCss(t.css).length, t.id);
    }
  });

  test('Studio\'s heading font variable is set on the root and reaches the hero title', () => {
    const t = byId.studio;
    const dom = new JSDOM(`<!doctype html><html cd-theme="studio" cd-density="4"><head></head><body>${HOME()}</body></html>`);
    const { window } = dom;
    const { document } = window;
    const style = document.createElement('style');
    style.textContent = [buildTokenCss(t, {}, MAP), t.css].join('\n');
    document.head.appendChild(style);
    const read = (sel, name) => window.getComputedStyle(document.querySelector(sel)).getPropertyValue(name);
    for (const sel of ['html', '.cd-hero-title', '.cd-row-title']) assert.match(read(sel, '--cd-heading-font'), /Georgia.*serif/, sel);
    assert.match(read('html', '--cd-font-family'), /^Inter/, 'body text keeps the theme font');
    // the variable is a hook for the theme CSS and the skin only: the token rule never sets it, so the theme's value is not overridden
    assert.ok(!('--cd-heading-font' in deriveTokens(t, {}, MAP)));
    // and the other five themes do not set it at all, so their headings follow the theme font
    for (const other of THEMES.filter((x) => x.id !== 'studio')) assert.ok(!other.css.includes('--cd-heading-font'), other.id);
  });
});

// =============================================================================================================================

describe('the themes through the rest of the pipeline', () => {
  const settings = (themeId, extra = {}) => ({ themeId, accent: null, density: null, animations: true, calm: {}, ...extra });
  const FREE = { plan: 'free', status: 'none' };
  const PRO = { plan: 'pro', status: 'active' };

  test('every theme is available for all users under the free model', () => {
    for (const t of THEMES) {
      const cfg = computeEffectiveConfig({ settings: settings(t.id), licenceState: FREE, themes: THEMES });
      assert.equal(cfg.theme.id, t.id, t.id);
      assert.equal(cfg.pro, false);
    }
  });

  test('a Pro user gets every theme, with its own layout and density', () => {
    for (const t of THEMES) {
      const cfg = computeEffectiveConfig({ settings: settings(t.id), licenceState: PRO, themes: THEMES });
      assert.equal(cfg.theme, t);
      assert.equal(cfg.home, t.layout.home);
      assert.equal(cfg.watch, t.layout.watch);
      assert.equal(cfg.density, t.layout.density);
    }
  });

  test('a lapsed licence preserves the user theme choice under the free model', () => {
    const stored = settings('arcade');
    const cfg = computeEffectiveConfig({ settings: stored, licenceState: { plan: 'pro', status: 'expired' }, themes: THEMES });
    assert.equal(cfg.theme.id, 'arcade');
    assert.equal(stored.themeId, 'arcade');
  });

  test('free users get the free themes\' own layouts: Cinema keeps its hero rows (spec decision 7.1)', () => {
    const cfg = computeEffectiveConfig({ settings: settings('cinema'), licenceState: FREE, themes: THEMES });
    assert.equal(cfg.home, 'hero-rows');
    assert.equal(cfg.watch, 'cinema');
    assert.equal(cfg.density, 3);
  });

  test('every theme produces tokens whose text, muted, accent and border colours pass the same AA pairs as written', () => {
    for (const t of THEMES) {
      const out = deriveTokens(t, {}, MAP);
      const fromTokens = { tokens: { color: { bg: out['--cd-bg'], surface: out['--cd-surface'], text: out['--cd-text'], muted: out['--cd-muted'], accent: out['--cd-accent'], border: out['--cd-border'] } } };
      for (const r of checkThemeContrast(fromTokens)) assert.ok(r.pass, `${t.id} ${r.pair}`);
      assert.equal(out['color-scheme'], lum(t.tokens.color.bg) > 0.18 ? 'light' : 'dark', t.id);
    }
  });

  test('a user accent on top of each theme either passes 3:1 against that theme\'s background or the theme keeps its own', () => {
    for (const t of THEMES) {
      for (const accent of ['#ff0055', '#00c2ff', '#ffd400', '#222222', '#dddddd', '#7a7a7a']) {
        const got = deriveTokens(t, { accent }, MAP)['--cd-accent'];
        if (contrastRatio(accent, t.tokens.color.bg) >= 3) assert.ok(sameColourHex(got, accent), `${t.id} ${accent}`);
        else assert.ok(sameColourHex(got, t.tokens.color.accent), `${t.id} ${accent}`);
      }
    }
  });
});
