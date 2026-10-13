// Tests for src/shared/tokens.js (ARCHITECTURE.md section 4, "shared/tokens.js"; section 3.5 for the variable names).
//
// How the tests are wired
// - tokens.js imports FONT_STACKS from theme-schema.js, which imports css-validator.js (written by another agent). If that
//   file does not exist yet, a no-op stand-in is resolved for it through a module hook, so these tests never depend on a
//   sibling being finished. When the real file exists it is used untouched.
// - The selector map is the real data file (src/data/selector-map.source.json); edge cases are derived from it in the test.
// - jsdom does not resolve var() inside custom properties (verified), so cascade tests assert on WHICH declaration wins
//   (our `var(--cd-bg)` against YouTube's `#0f0f0f`), not on the final colour.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPage } from '../helpers/dom.js';
import { ALL_THEME_IDS } from '../../src/shared/constants.js';
import { contrastRatio, parseColor, pickReadableText, relativeLuminance, toHex } from '../../src/shared/contrast.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const cloneMap = () => structuredClone(MAP);
const themeJson = (id) => JSON.parse(readFileSync(path.join(SRC, 'themes', `${id}.json`), 'utf8'));
const THEMES = ALL_THEME_IDS.map(themeJson);
const byId = Object.fromEntries(THEMES.map((t) => [t.id, t]));

/** Imports `file`; any listed sibling that does not exist yet is replaced by a stand-in for the duration of the import. */
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

const schema = await importWithStandIns(path.join(SRC, 'shared', 'theme-schema.js'), [CSS_VALIDATOR_STAND_IN]);
const tokens = await importWithStandIns(path.join(SRC, 'shared', 'tokens.js'), [CSS_VALIDATOR_STAND_IN]);
const { FONT_STACKS } = schema;
const { deriveTokens, buildTokenCss, resolveAccent, TOKEN_SELECTOR, SPACING_PX, MOTION_MS, MIN_ACCENT_CONTRAST } = tokens;

// ---- helpers -----------------------------------------------------------------------------------------------------------

/** A tiny deterministic generator (mulberry32) so "random" colours are the same on every run. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const hex2 = (n) => n.toString(16).padStart(2, '0');
const randomHex = (next) => `#${hex2(Math.floor(next() * 256))}${hex2(Math.floor(next() * 256))}${hex2(Math.floor(next() * 256))}`;

/** Theme with some token paths replaced (deep copy of a launch theme). */
function withTokens(id, patch) {
  const t = structuredClone(byId[id]);
  for (const [group, values] of Object.entries(patch)) Object.assign(t.tokens[group], values);
  return t;
}

/** `prop:value;prop:value` -> Map. Values here never contain ; or {} (that is itself asserted). */
function parseRule(css) {
  const open = css.indexOf('{');
  assert.ok(open > 0 && css.endsWith('}'), `one rule expected: ${css.slice(0, 80)}`);
  assert.equal(css.indexOf('{', open + 1), -1, 'a second { in the token rule');
  assert.equal(css.indexOf('}'), css.length - 1, 'a } before the end of the token rule');
  const decls = new Map();
  for (const d of css.slice(open + 1, -1).split(';')) {
    const i = d.indexOf(':');
    assert.ok(i > 0, `declaration without a colon: ${d}`);
    const prop = d.slice(0, i);
    assert.ok(!decls.has(prop), `property written twice: ${prop}`);
    decls.set(prop, d.slice(i + 1));
  }
  return { selector: css.slice(0, open), decls };
}

// Independent oracle for the bridge (written separately from tokens.js on purpose).
const BRIDGE_TARGET = {
  bg: '--cd-bg', surface: '--cd-surface', menu: '--cd-menu', text: '--cd-text', muted: '--cd-muted', accent: '--cd-accent',
  accentHover: '--cd-accent-hover', border: '--cd-border', borderOpaque: '--cd-border', overlay: '--cd-scrim',
  hover: '--cd-hover', additive: '--cd-hover', tonal: '--cd-hover', active: '--cd-active', chipHover: '--cd-active',
  inverted: '--cd-text', invertedText: '--cd-bg', icon: '--cd-text', iconMuted: '--cd-muted',
};
// The obfuscated twins of YouTube's colour tokens in the 2026-10-08 build (--t<16 hex>, same light and dark values as the readable
// --yt-sys-color-baseline--* name; matched live by value pair, see LOCAL_VARS in tokens.js). Written out here on purpose, as an oracle.
const LOCAL_TWINS = {
  bg: ['--t3e41d7b17b187f69'],
  surface: ['--t518e925f61bdcb91', '--tbdeaf5bc17152abc'],
  menu: ['--t08a7c6c176cbc5c2'],
  text: ['--tffc2fd3a644f6275', '--t1405e70a39276293'],
  muted: ['--t4a6da19e16bf221a', '--t7e34d5baa4ea6277'],
  accent: ['--t2d807bb79e75606d'],
  accentHover: ['--t617db776af0de196'],
  border: ['--t20480717de80f555', '--t416e5931fc464589'],
  borderOpaque: ['--td8562cdc203bc683'],
  overlay: ['--ta889dfda9605a358'],
  invertedText: ['--t6216186c28b3834b'],
  additive: ['--t7c4965c11f8537c0', '--t7f4f2c6d54836ce0'],
};
const LOCAL_NAMES = new Set(Object.values(LOCAL_TWINS).flat());
const isAdVarName = (name) => {
  const parts = name.toLowerCase().split(/[-_]+/).filter(Boolean);
  return parts.some((p, i) => p === 'ad' || p === 'ads' || p.startsWith('sponsor') || (p === 'paid' && parts[i + 1] === 'content') || p === 'paidcontent');
};

const CONTRACT_VARS = ['--cd-bg', '--cd-surface', '--cd-text', '--cd-muted', '--cd-accent', '--cd-accent-text', '--cd-border', '--cd-radius',
  '--cd-shadow', '--cd-space', '--cd-font-family', '--cd-font-size', '--cd-heading-weight', '--cd-duration'];

// =============================================================================================================================

describe('deriveTokens: the --cd-* variables', () => {
  test('writes every variable of the contract, and color-scheme, for every launch theme', () => {
    for (const t of THEMES) {
      const out = deriveTokens(t, {}, MAP);
      for (const name of CONTRACT_VARS) assert.ok(typeof out[name] === 'string' && out[name] !== '', `${t.id}: ${name}`);
      assert.ok(out['color-scheme'] === 'dark' || out['color-scheme'] === 'light', t.id);
    }
  });

  test('does not claim variables that belong to other modules or to the theme CSS', () => {
    // density.js owns the three spacing vars (the token rule has higher specificity than html[cd-theme], so claiming them here
    // would silently beat the density rule); Studio's own CSS sets --cd-heading-font and the token rule would beat that too.
    const out = deriveTokens(byId.cinema, {}, MAP);
    for (const name of ['--cd-gap', '--cd-card-min', '--cd-row-gap', '--cd-heading-font']) assert.ok(!(name in out), name);
  });

  test('Cinema, value for value', () => {
    const out = deriveTokens(byId.cinema, {}, MAP);
    assert.equal(out['--cd-bg'], '#0b0b0f');
    assert.equal(out['--cd-surface'], '#16161d');
    assert.equal(out['--cd-menu'], '#16161d');
    assert.equal(out['--cd-text'], '#f2f2f5');
    assert.equal(out['--cd-muted'], '#a3a3b2');
    assert.equal(out['--cd-accent'], '#e8b04a');
    assert.equal(out['--cd-accent-text'], '#000000');
    assert.equal(out['--cd-border'], '#656572');
    assert.equal(out['--cd-radius'], '10px');
    assert.equal(out['--cd-space'], '6px');
    assert.equal(out['--cd-font-family'], FONT_STACKS.Inter);
    assert.equal(out['--cd-font-size'], '14px');
    assert.equal(out['--cd-font-scale'], '1');
    assert.equal(out['--cd-heading-weight'], '700');
    assert.equal(out['--cd-duration'], `${MOTION_MS}ms`);
    assert.equal(out['--cd-hover'], 'rgba(242,242,245,0.08)');
    assert.equal(out['--cd-active'], 'rgba(242,242,245,0.14)');
    assert.equal(out['--cd-scrim'], 'rgba(11,11,15,0.8)');
    assert.equal(out['color-scheme'], 'dark');
    assert.match(out['--cd-shadow'], /rgba\(0,0,0,/);
  });

  test('the output order is stable: --cd-* first, then color-scheme, then bridged YouTube variables', () => {
    const keys = Object.keys(deriveTokens(byId.cinema, {}, MAP));
    const at = keys.indexOf('color-scheme');
    assert.ok(at > 0);
    assert.ok(keys.slice(0, at).every((k) => k.startsWith('--cd-')));
    assert.ok(keys.slice(at + 1).every((k) => k.startsWith('--') && !k.startsWith('--cd-')));
    assert.ok(keys.length > at + 10, 'the real map bridges many variables');
    assert.deepEqual(keys, Object.keys(deriveTokens(byId.cinema, {}, MAP)), 'deterministic');
  });

  test('the shape of the output does not depend on the theme (themes are data only)', () => {
    const shape = Object.keys(deriveTokens(byId.cinema, {}, MAP));
    for (const t of THEMES) assert.deepEqual(Object.keys(deriveTokens(t, {}, MAP)), shape, t.id);
  });

  test('--cd-space follows the spacing scale 1..5 as 2/4/6/8/12 px', () => {
    assert.deepEqual([...SPACING_PX], [2, 4, 6, 8, 12]);
    for (let s = 1; s <= 5; s++) {
      const out = deriveTokens(withTokens('cinema', { shape: { spacing: s } }), {}, MAP);
      assert.equal(out['--cd-space'], `${SPACING_PX[s - 1]}px`, `spacing ${s}`);
    }
  });

  test('numbers are clamped to the schema range or replaced by the default, never passed through raw', () => {
    const d = (shape, type = {}) => deriveTokens(withTokens('cinema', { shape, type }), {}, MAP);
    assert.equal(d({ radius: 0 })['--cd-radius'], '0px');
    assert.equal(d({ radius: 32 })['--cd-radius'], '32px');
    assert.equal(d({ radius: 1e9 })['--cd-radius'], '32px');
    assert.equal(d({ radius: -5 })['--cd-radius'], '0px');
    assert.equal(d({ radius: 7.6 })['--cd-radius'], '8px');
    for (const bad of [NaN, Infinity, -Infinity, '12', null, undefined, {}, [], true]) {
      assert.equal(d({ radius: bad })['--cd-radius'], '12px', `radius ${String(bad)}`);
    }
    assert.equal(d({ spacing: 0 })['--cd-space'], '2px');
    assert.equal(d({ spacing: 99 })['--cd-space'], '12px');
    assert.equal(d({ spacing: 2.4 })['--cd-space'], '4px');
    assert.equal(d({ spacing: NaN })['--cd-space'], '6px');
    assert.equal(d({}, { baseSize: 5 })['--cd-font-size'], '12px');
    assert.equal(d({}, { baseSize: 100 })['--cd-font-size'], '20px');
    assert.equal(d({}, { baseSize: 15 })['--cd-font-size'], '15px');
    assert.equal(d({}, { baseSize: 15 })['--cd-font-scale'], '1.07');
    assert.equal(d({}, { baseSize: 13 })['--cd-font-scale'], '0.93');
    assert.equal(d({}, { baseSize: 'big' })['--cd-font-size'], '14px');
    assert.equal(d({}, { headingWeight: 50 })['--cd-heading-weight'], '100');
    assert.equal(d({}, { headingWeight: 1000 })['--cd-heading-weight'], '900');
    assert.equal(d({}, { headingWeight: NaN })['--cd-heading-weight'], '700');
  });

  test('textScale multiplies baseSize, clamps into [11, 22], and defaults to 1 for null or junk', () => {
    // Cinema default baseSize is 14
    assert.equal(deriveTokens(byId.cinema, { textScale: 1 }, MAP)['--cd-font-size'], '14px');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1 }, MAP)['--cd-font-scale'], '1');
    assert.equal(deriveTokens(byId.cinema, { textScale: null }, MAP)['--cd-font-size'], '14px');
    assert.equal(deriveTokens(byId.cinema, { textScale: undefined }, MAP)['--cd-font-size'], '14px');
    assert.equal(deriveTokens(byId.cinema, {}, MAP)['--cd-font-size'], '14px');

    // Discrete scales
    assert.equal(deriveTokens(byId.cinema, { textScale: 0.9 }, MAP)['--cd-font-size'], '12.6px');
    assert.equal(deriveTokens(byId.cinema, { textScale: 0.9 }, MAP)['--cd-font-scale'], '0.9');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.1 }, MAP)['--cd-font-size'], '15.4px');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.1 }, MAP)['--cd-font-scale'], '1.1');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.25 }, MAP)['--cd-font-size'], '17.5px');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.25 }, MAP)['--cd-font-scale'], '1.25');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.5 }, MAP)['--cd-font-size'], '21px');
    assert.equal(deriveTokens(byId.cinema, { textScale: 1.5 }, MAP)['--cd-font-scale'], '1.5');

    // Clamping to [11, 22]
    // Extreme large: baseSize 20 * 1.5 = 30 -> clamped to 22px
    const bigTheme = withTokens('cinema', { type: { baseSize: 20 } });
    assert.equal(deriveTokens(bigTheme, { textScale: 1.5 }, MAP)['--cd-font-size'], '22px');
    assert.equal(deriveTokens(bigTheme, { textScale: 1.5 }, MAP)['--cd-font-scale'], '1.57');

    // Extreme small: baseSize 12 * 0.9 = 10.8 -> clamped to 11px
    const smallTheme = withTokens('cinema', { type: { baseSize: 12 } });
    assert.equal(deriveTokens(smallTheme, { textScale: 0.9 }, MAP)['--cd-font-size'], '11px');
    assert.equal(deriveTokens(smallTheme, { textScale: 0.9 }, MAP)['--cd-font-scale'], '0.79');

    // Junk scales default to 1 (unscaled)
    for (const bad of [0, -1, NaN, Infinity, '1.5', {}, [], true, false]) {
      assert.equal(deriveTokens(byId.cinema, { textScale: bad }, MAP)['--cd-font-size'], '14px', `junk textScale ${String(bad)}`);
    }

    // buildTokenCss emits the scaled size
    const css = buildTokenCss(byId.cinema, { textScale: 1.25 }, MAP);
    assert.match(css, /--cd-font-size:17\.5px/);
    assert.match(css, /--cd-font-scale:1\.25/);
  });

  test('shadow is none unless the theme asks for it, and is dark or light to suit the background', () => {
    assert.equal(deriveTokens(withTokens('cinema', { shape: { shadow: false } }), {}, MAP)['--cd-shadow'], 'none');
    for (const bad of [1, 'true', null, undefined]) {
      assert.equal(deriveTokens(withTokens('cinema', { shape: { shadow: bad } }), {}, MAP)['--cd-shadow'], 'none', String(bad));
    }
    const dark = deriveTokens(withTokens('cinema', { shape: { shadow: true } }), {}, MAP)['--cd-shadow'];
    const light = deriveTokens(withTokens('studio', { shape: { shadow: true } }), {}, MAP)['--cd-shadow'];
    assert.notEqual(dark, 'none');
    assert.notEqual(light, 'none');
    assert.notEqual(dark, light);
    assert.match(dark, /rgba\(0,0,0/);
    assert.doesNotMatch(light, /rgba\(0,0,0/);
  });

  test('--cd-duration is 0ms when animations are off and the motion time otherwise', () => {
    assert.equal(deriveTokens(byId.cinema, { animations: false }, MAP)['--cd-duration'], '0ms');
    for (const user of [undefined, null, {}, { animations: true }, { animations: undefined }]) {
      assert.equal(deriveTokens(byId.cinema, user, MAP)['--cd-duration'], '160ms', JSON.stringify(user));
    }
    assert.equal(MOTION_MS, 160);
    assert.ok(MOTION_MS < 250, 'motion stays well inside the 150 ms theme-switch feel');
  });

  test('color-scheme follows the background luminance', () => {
    const want = { cinema: 'dark', primetime: 'dark', arcade: 'dark', minimal: 'light', classic: 'light', studio: 'light' };
    for (const t of THEMES) assert.equal(deriveTokens(t, {}, MAP)['color-scheme'], want[t.id], t.id);
    const scheme = (bg) => deriveTokens(withTokens('cinema', { color: { bg } }), {}, MAP)['color-scheme'];
    assert.equal(scheme('#000000'), 'dark');
    assert.equal(scheme('#ffffff'), 'light');
    assert.equal(scheme('#fff'), 'light');
    assert.equal(scheme('#2a2a2a'), 'dark');
    assert.equal(scheme('#d0d0d0'), 'light');
    // the choice is the one with more contrast, whatever the hue
    for (const bg of ['#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#808080', '#777777', '#767676']) {
      const expected = contrastRatio('#ffffff', bg) > contrastRatio('#000000', bg) ? 'dark' : 'light';
      assert.equal(scheme(bg), expected, bg);
    }
  });

  test('colours are written as normalised hex whatever notation the theme used', () => {
    const t = withTokens('cinema', {
      color: { bg: '#FFF', surface: 'rgb(10, 20, 30)', text: 'hsl(0 0% 0%)', muted: ' #AbCdEf ', accent: 'rgba(255,0,0,1)', border: '#112233' },
    });
    const out = deriveTokens(t, {}, MAP);
    assert.equal(out['--cd-bg'], '#ffffff');
    assert.equal(out['--cd-surface'], '#0a141e');
    assert.equal(out['--cd-text'], '#000000');
    assert.equal(out['--cd-muted'], '#abcdef');
    assert.equal(out['--cd-accent'], '#ff0000');
    assert.equal(out['--cd-border'], '#112233');
  });

  test('a translucent background is flattened (the page paints it) and a translucent surface gives an opaque menu', () => {
    const out = deriveTokens(withTokens('cinema', { color: { bg: '#00000080', surface: '#ffffff80' } }), {}, MAP);
    assert.equal(out['--cd-bg'], '#7f7f7f', 'black at 50% over the white canvas');
    assert.equal(out['--cd-surface'], '#ffffff80', 'the surface itself stays translucent');
    assert.match(out['--cd-menu'], /^#[0-9a-f]{6}$/, 'menus must be opaque');
    assert.equal(out['--cd-menu'], toHex(parseColor('#ffffff80', '#7f7f7f')));
  });

  test('the hover and active tints follow the text colour, scaled by its own alpha', () => {
    const solid = deriveTokens(withTokens('cinema', { color: { text: '#102030' } }), {}, MAP);
    assert.equal(solid['--cd-hover'], 'rgba(16,32,48,0.08)');
    assert.equal(solid['--cd-active'], 'rgba(16,32,48,0.14)');
    const faint = deriveTokens(withTokens('cinema', { color: { text: '#ffffff80' } }), {}, MAP);
    assert.match(faint['--cd-hover'], /^rgba\(255,255,255,0\.04\)$/);
  });

  test('--cd-font-family comes from FONT_STACKS, and an unknown key never leaks an Object member', () => {
    for (const [key, stack] of Object.entries(FONT_STACKS)) {
      const out = deriveTokens(withTokens('cinema', { type: { family: key } }), {}, MAP);
      assert.equal(out['--cd-font-family'], stack, key);
    }
    const fallback = FONT_STACKS.System;
    for (const bad of ['Comic Sans', '', 'inter', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf', null, undefined, 7, {}, ['Inter']]) {
      const out = deriveTokens(withTokens('cinema', { type: { family: bad } }), {}, MAP);
      assert.equal(out['--cd-font-family'], fallback, String(bad));
    }
  });

  test('every font stack survives the value filter (no stack is silently replaced)', () => {
    for (const key of Object.keys(FONT_STACKS)) {
      const css = buildTokenCss(withTokens('cinema', { type: { family: key } }), {}, MAP);
      assert.ok(css.includes(`--cd-font-family:${FONT_STACKS[key]}`), key);
    }
  });
});

// =============================================================================================================================

describe('--cd-accent-text and --cd-accent-hover', () => {
  test('the label colour is readable (>= 4.5:1) on the accent for all six themes, and is pickReadableText', () => {
    for (const t of THEMES) {
      const out = deriveTokens(t, {}, MAP);
      assert.equal(out['--cd-accent-text'], pickReadableText(out['--cd-accent']), t.id);
      assert.ok(contrastRatio(out['--cd-accent-text'], out['--cd-accent']) >= 4.5, t.id);
    }
  });

  test('hover moves away from the label colour, so the label never loses contrast on hover', () => {
    for (const t of THEMES) {
      const out = deriveTokens(t, {}, MAP);
      const before = contrastRatio(out['--cd-accent-text'], out['--cd-accent']);
      const after = contrastRatio(out['--cd-accent-text'], out['--cd-accent-hover']);
      assert.ok(after >= before, `${t.id}: ${before} -> ${after}`);
      assert.ok(after >= 4.5, t.id);
    }
    const next = rng(7);
    for (let i = 0; i < 300; i++) {
      const accent = randomHex(next);
      const out = deriveTokens(withTokens('arcade', { color: { accent } }), {}, MAP);
      assert.ok(contrastRatio(out['--cd-accent-text'], out['--cd-accent-hover']) >= contrastRatio(out['--cd-accent-text'], out['--cd-accent']) - 1e-9, accent);
      assert.match(out['--cd-accent-hover'], /^#[0-9a-f]{6}$/);
    }
  });

  test('a light accent gets black text and a lighter hover; a dark accent gets white text and a darker hover', () => {
    const light = deriveTokens(withTokens('cinema', { color: { accent: '#ffd966' } }), {}, MAP);
    assert.equal(light['--cd-accent-text'], '#000000');
    assert.ok(relativeLuminance(light['--cd-accent-hover']) > relativeLuminance(light['--cd-accent']));
    const dark = deriveTokens(withTokens('minimal', { color: { accent: '#1a3a8a' } }), {}, MAP);
    assert.equal(dark['--cd-accent-text'], '#ffffff');
    assert.ok(relativeLuminance(dark['--cd-accent-hover']) < relativeLuminance(dark['--cd-accent']));
  });
});

// =============================================================================================================================

describe('the user accent', () => {
  const cinemaBg = byId.cinema.tokens.color.bg;
  const accentOf = (themeId, user) => deriveTokens(byId[themeId], user, MAP)['--cd-accent'];

  test('a readable colour replaces the theme accent and everything derived from it follows', () => {
    const out = deriveTokens(byId.cinema, { accent: '#ff8800' }, MAP);
    assert.equal(out['--cd-accent'], '#ff8800');
    assert.equal(out['--cd-accent-text'], pickReadableText('#ff8800'));
    assert.notEqual(out['--cd-accent-hover'], deriveTokens(byId.cinema, {}, MAP)['--cd-accent-hover']);
  });

  test('every accepted notation is normalised to lowercase #rrggbb', () => {
    for (const input of ['#ff8800', '#FF8800', '#f80', 'rgb(255, 136, 0)', 'rgb(255 136 0)', 'rgba(255,136,0,1)', 'hsl(32 100% 50%)', '  #ff8800  ']) {
      assert.equal(accentOf('cinema', { accent: input }), toHex(parseColor(input)), input);
      assert.match(accentOf('cinema', { accent: input }), /^#[0-9a-f]{6}$/);
    }
  });

  test('unreadable, translucent, non-string and hostile values fall back to the theme accent', () => {
    const themeAccent = byId.cinema.tokens.color.accent;
    const rejected = [
      'red', 'orange', 'transparent', 'currentColor', 'inherit', 'var(--cd-bg)', 'url(x)', '#12', '#12345', '#gggggg', 'rgb(300,0,0)',
      'rgb(1,2)', 'calc(1)', 'rgba(255,136,0,0.5)', '#ff880080', 'hsla(32,100%,50%,0.2)', '', '   ', 'x'.repeat(500),
      '#fff;}body{display:none', '#fff} body {display:none', '#fff/*', '#fff\n#000', 'expression(alert(1))', '\u0000#fff',
      42, 0, true, false, {}, [], ['#ff8800'], () => '#ff8800', Symbol('x'),
    ];
    for (const bad of rejected) assert.equal(accentOf('cinema', { accent: bad }), themeAccent, String(typeof bad === 'symbol' ? 'symbol' : bad).slice(0, 40));
    for (const none of [null, undefined]) assert.equal(accentOf('cinema', { accent: none }), themeAccent);
  });

  test('nothing hostile in the accent can reach the stylesheet', () => {
    const css = buildTokenCss(byId.cinema, { accent: '#fff;}body{display:none;--x:' }, MAP);
    assert.doesNotMatch(css, /display|body/);
    assert.equal(css.split('{').length, 2);
  });

  test('3:1 against the background is the line: the darkest grey that passes is accepted, one step below is not', () => {
    for (const t of THEMES) {
      const bg = t.tokens.color.bg;
      const dark = relativeLuminance(bg) < 0.5;
      // walk the grey ramp towards readability
      const greys = Array.from({ length: 256 }, (_, i) => `#${hex2(i).repeat(3)}`);
      const ramp = dark ? greys : [...greys].reverse();
      const firstPass = ramp.findIndex((g) => contrastRatio(g, bg) >= MIN_ACCENT_CONTRAST);
      assert.ok(firstPass > 0, t.id);
      assert.equal(accentOf(t.id, { accent: ramp[firstPass] }), ramp[firstPass], `${t.id} accepts ${ramp[firstPass]}`);
      assert.equal(accentOf(t.id, { accent: ramp[firstPass - 1] }), t.tokens.color.accent, `${t.id} rejects ${ramp[firstPass - 1]}`);
    }
    assert.equal(MIN_ACCENT_CONTRAST, 3);
  });

  test('property: an accepted accent always has >= 3:1 on the background, a rejected one is below 3:1 (or unreadable)', () => {
    const next = rng(2026);
    for (const t of THEMES) {
      const bg = t.tokens.color.bg;
      for (let i = 0; i < 200; i++) {
        const candidate = randomHex(next);
        const got = accentOf(t.id, { accent: candidate });
        if (got === candidate) assert.ok(contrastRatio(candidate, bg) >= 3, `${t.id} ${candidate}`);
        else {
          assert.equal(got, t.tokens.color.accent);
          assert.ok(contrastRatio(candidate, bg) < 3, `${t.id} ${candidate}`);
        }
      }
    }
  });

  test('a colour that is invisible on one theme can be fine on another (the check is per background)', () => {
    const nearBlack = '#14141c'; // ~1.1:1 on Cinema, ~17:1 on Minimal
    assert.equal(accentOf('cinema', { accent: nearBlack }), byId.cinema.tokens.color.accent);
    assert.equal(accentOf('minimal', { accent: nearBlack }), nearBlack);
    const yellow = '#ffee00'; // ~1.2:1 on white, ~17:1 on Cinema
    assert.equal(accentOf('minimal', { accent: yellow }), byId.minimal.tokens.color.accent);
    assert.equal(accentOf('cinema', { accent: yellow }), yellow);
    assert.ok(contrastRatio(nearBlack, cinemaBg) < 3);
  });

  test('resolveAccent explains the decision', () => {
    const bg = '#0b0b0f';
    assert.deepEqual(resolveAccent('#e8b04a', null, bg), { accent: '#e8b04a', source: 'theme', rejected: null, ratio: null });
    assert.deepEqual(resolveAccent('#e8b04a', undefined, bg), { accent: '#e8b04a', source: 'theme', rejected: null, ratio: null });
    assert.deepEqual(resolveAccent('#e8b04a', '', bg), { accent: '#e8b04a', source: 'theme', rejected: null, ratio: null });
    const ok = resolveAccent('#e8b04a', '#FF8800', bg);
    assert.equal(ok.accent, '#ff8800');
    assert.equal(ok.source, 'user');
    assert.equal(ok.rejected, null);
    assert.ok(Math.abs(ok.ratio - contrastRatio('#ff8800', bg)) < 1e-9);
    assert.equal(resolveAccent('#e8b04a', 'nope', bg).rejected, 'unreadable');
    assert.equal(resolveAccent('#e8b04a', 'rgba(255,0,0,0.4)', bg).rejected, 'translucent');
    const low = resolveAccent('#e8b04a', '#101018', bg);
    assert.equal(low.rejected, 'contrast');
    assert.equal(low.accent, '#e8b04a');
    assert.equal(low.source, 'theme');
    assert.ok(low.ratio < 3);
    assert.equal(resolveAccent('#e8b04a', 123, bg).rejected, 'unreadable');
  });
});

// =============================================================================================================================

describe('the colour bridge (map.vars)', () => {
  const bridged = (map, theme = byId.cinema) => {
    const out = deriveTokens(theme, {}, map);
    // the built-in twins are covered by their own tests below; everything else comes from the map
    return Object.fromEntries(Object.entries(out).filter(([k]) => !k.startsWith('--cd-') && k !== 'color-scheme' && !LOCAL_NAMES.has(k)));
  };

  test('the real map: the measured YouTube variables point at the right Cinedrape variable', () => {
    const b = bridged(MAP);
    assert.equal(b['--yt-sys-color-baseline--base-background'], 'var(--cd-bg)');
    assert.equal(b['--yt-deprecated-general-background-a'], 'var(--cd-bg)');
    assert.equal(b['--yt-spec-base-background'], 'var(--cd-bg)');
    assert.equal(b['--yt-sys-color-baseline--raised-background'], 'var(--cd-surface)');
    assert.equal(b['--yt-sys-color-baseline--surface-container'], 'var(--cd-surface)');
    assert.equal(b['--yt-sys-color-baseline--menu-background'], 'var(--cd-menu)');
    assert.equal(b['--yt-sys-color-baseline--text-primary'], 'var(--cd-text)');
    assert.equal(b['--yt-sys-color-baseline--text-secondary'], 'var(--cd-muted)');
    assert.equal(b['--yt-sys-color-baseline--call-to-action'], 'var(--cd-accent)');
    assert.equal(b['--yt-sys-color-baseline--call-to-action-hover'], 'var(--cd-accent-hover)');
    assert.equal(b['--yt-sys-color-baseline--outline'], 'var(--cd-border)');
    assert.equal(b['--yt-sys-color-baseline--outline-opaque'], 'var(--cd-border)');
    assert.equal(b['--yt-sys-color-baseline--frosted-glass-desktop'], 'var(--cd-scrim)');
  });

  test('completeness: every valid variable the map lists for a known colour is bridged, nothing else is', () => {
    const expected = new Map();
    for (const [key, target] of Object.entries(BRIDGE_TARGET)) {
      for (const name of MAP.vars[key] || []) {
        if (/^--[A-Za-z][A-Za-z0-9_-]*$/.test(name) && !name.startsWith('--cd-') && !isAdVarName(name) && !expected.has(name)) expected.set(name, `var(${target})`);
      }
    }
    assert.ok(expected.size >= 20, 'the real map has a lot to bridge');
    // a name the map lists wins over (and is not duplicated by) the built-in list; the built-in twins add what the map lacks
    const mapNames = new Set(expected.keys());
    assert.deepEqual(bridged(MAP), Object.fromEntries([...expected].filter(([k]) => !LOCAL_NAMES.has(k))));
    const full = new Map(expected);
    for (const [key, target] of Object.entries(BRIDGE_TARGET)) for (const name of LOCAL_TWINS[key] || []) if (!full.has(name)) full.set(name, `var(${target})`);
    const all = Object.fromEntries(Object.entries(deriveTokens(byId.cinema, {}, MAP)).filter(([k]) => !k.startsWith('--cd-') && k !== 'color-scheme'));
    assert.deepEqual(all, Object.fromEntries(full));
    assert.ok(mapNames.size < full.size, 'the built-in twins add variables the real map does not list yet');
    // every key of the real map is one the bridge knows, so a typo in the map would show up here
    for (const key of Object.keys(MAP.vars)) assert.ok(key in BRIDGE_TARGET, `map.vars.${key} has no bridge target`);
  });

  test('the obfuscated twins of the current YouTube build are bridged with or without a map', () => {
    for (const map of [MAP, null, undefined, {}, { vars: {} }]) {
      const out = deriveTokens(byId.cinema, {}, map);
      for (const [key, names] of Object.entries(LOCAL_TWINS)) {
        for (const name of names) assert.equal(out[name], `var(${BRIDGE_TARGET[key]})`, `${name} (${key})`);
      }
    }
    // the two that decide readability in a light YouTube under a dark theme: page colour and primary text (verified live)
    const out = deriveTokens(byId.studio, {}, MAP);
    assert.equal(out['--t3e41d7b17b187f69'], 'var(--cd-bg)');
    assert.equal(out['--tffc2fd3a644f6275'], 'var(--cd-text)');
    assert.equal(out['--t6216186c28b3834b'], 'var(--cd-bg)', 'the label colour of a filled mono button (the inverse of the text)');
  });

  test('themes differ by data only: the bridged declarations are identical for all six themes', () => {
    const first = bridged(MAP, byId.cinema);
    for (const t of THEMES) assert.deepEqual(bridged(MAP, t), first, t.id);
  });

  test('a YouTube variable rename is fixed by a map update alone', () => {
    const map = cloneMap();
    map.vars.text = ['--yt-sys-color-v2--text-primary'];
    map.vars.accent = ['--yt-sys-color-v2--call-to-action', ...map.vars.accent];
    const b = bridged(map);
    assert.equal(b['--yt-sys-color-v2--text-primary'], 'var(--cd-text)');
    assert.equal(b['--yt-sys-color-v2--call-to-action'], 'var(--cd-accent)');
    assert.ok(!('--yt-sys-color-baseline--text-primary' in b), 'the old name is gone with the old map');
    assert.equal(b['--yt-sys-color-baseline--call-to-action'], 'var(--cd-accent)', 'old names still listed are still bridged');
  });

  test('optional keys work (translucent tints, inverted surfaces, icons)', () => {
    const map = cloneMap();
    map.vars.additive = ['--yt-sys-color-baseline--additive-background'];
    map.vars.tonal = ['--yt-sys-color-baseline--tonal-background'];
    map.vars.chipHover = ['--yt-sys-color-baseline--button-chip-background-hover'];
    map.vars.inverted = ['--yt-sys-color-baseline--inverted-background'];
    map.vars.invertedText = ['--yt-x-inverted-text'];
    map.vars.icon = ['--yt-x-icon'];
    map.vars.iconMuted = ['--yt-x-icon-muted'];
    map.vars.hover = ['--yt-x-hover'];
    map.vars.active = ['--yt-x-active'];
    const b = bridged(map);
    assert.equal(b['--yt-sys-color-baseline--additive-background'], 'var(--cd-hover)', 'a name that merely starts with "ad" is not an ad variable');
    assert.equal(b['--yt-sys-color-baseline--tonal-background'], 'var(--cd-hover)');
    assert.equal(b['--yt-sys-color-baseline--button-chip-background-hover'], 'var(--cd-active)');
    assert.equal(b['--yt-sys-color-baseline--inverted-background'], 'var(--cd-text)');
    assert.equal(b['--yt-x-inverted-text'], 'var(--cd-bg)');
    assert.equal(b['--yt-x-icon'], 'var(--cd-text)');
    assert.equal(b['--yt-x-icon-muted'], 'var(--cd-muted)');
    assert.equal(b['--yt-x-hover'], 'var(--cd-hover)');
    assert.equal(b['--yt-x-active'], 'var(--cd-active)');
  });

  test('keys the bridge does not know are ignored (a newer map may carry more)', () => {
    const map = cloneMap();
    map.vars.somethingNew = ['--yt-sys-color-baseline--something-new'];
    Object.defineProperty(map.vars, '__proto__', { value: ['--yt-proto'], enumerable: true, configurable: true });
    assert.ok(!('--yt-sys-color-baseline--something-new' in bridged(map)));
    assert.ok(!('--yt-proto' in bridged(map)));
  });

  test('only well-formed custom property names are written; anything else would be a way out of the declaration', () => {
    const map = cloneMap();
    const evil = [
      'color: red', '--ok;color:red', '--a{b', '--a}b', 'no-dashes', '-', '--', '--1abc', '--a b', '--a\nb', '--a/*', '--a\\b', '--é', '',
      `--${'x'.repeat(200)}`, 42, null, undefined, {}, [], true,
    ];
    map.vars.bg = [...evil, '--the-good-one'];
    const b = bridged(map);
    assert.equal(b['--the-good-one'], 'var(--cd-bg)');
    for (const k of Object.keys(b)) assert.match(k, /^--[A-Za-z][A-Za-z0-9_-]{0,127}$/);
    const css = buildTokenCss(byId.cinema, {}, map);
    assert.equal(css.split('{').length, 2);
    assert.equal(css.split('}').length, 2);
  });

  test('variables of the --cd- namespace are never overwritten by the map', () => {
    const map = cloneMap();
    map.vars.text = ['--cd-bg', '--cd-accent', '--CD-x', '--cd-', '--yt-fine'];
    const out = deriveTokens(byId.cinema, {}, map);
    assert.equal(out['--cd-bg'], '#0b0b0f');
    assert.equal(out['--cd-accent'], '#e8b04a');
    assert.equal(out['--yt-fine'], 'var(--cd-text)');
    assert.ok(!('--cd-' in out));
  });

  test('ad and sponsorship colours are never recoloured (they are YouTube\'s own markers)', () => {
    const map = cloneMap();
    const ads = [
      '--yt-sys-color-baseline--static-ad-yellow', '--static-ad-yellow', '--yt-spec-ad-badge', '--yt-spec-ads-banner-bg', '--ad', '--ads',
      '--YT-AD-X', '--yt-sponsor-bg', '--yt-sponsored-label', '--yt-paid-content-bg', '--yt-paid_content-text', '--x_ad_y',
    ];
    const fine = ['--yt-sys-color-baseline--additive-background', '--yt-spec-adaptive-surface', '--yt-spec-add-on', '--yt-spec-bad-news', '--yt-spec-padded-bg', '--yt-spec-reads-bg', '--yt-spec-ready'];
    map.vars.bg = [...ads, ...fine];
    map.vars.accent = ['--yt-ad-accent'];
    const b = bridged(map);
    for (const name of ads.concat('--yt-ad-accent')) assert.ok(!(name in b), `${name} must not be bridged`);
    for (const name of fine) assert.equal(b[name], 'var(--cd-bg)', `${name} is not an ad variable`);
  });

  test('the real map lists no ad variable, so the guard is only a safety net', () => {
    for (const [key, names] of Object.entries(MAP.vars)) for (const n of names) assert.ok(!isAdVarName(n), `${key}: ${n}`);
  });

  test('a name listed under two colours is written once, by the first colour in bridge order', () => {
    const map = cloneMap();
    map.vars.text = ['--yt-shared'];
    map.vars.bg = ['--yt-shared'];
    map.vars.muted = ['--yt-shared'];
    assert.equal(bridged(map)['--yt-shared'], 'var(--cd-bg)');
    const css = buildTokenCss(byId.cinema, {}, map);
    assert.equal(css.split('--yt-shared:').length, 2, 'written exactly once');
  });

  test('a hostile map cannot produce more than 200 bridged variables', () => {
    const map = cloneMap();
    map.vars = { bg: Array.from({ length: 5000 }, (_, i) => `--yt-flood-${i}`), text: Array.from({ length: 5000 }, (_, i) => `--yt-flood2-${i}`) };
    const b = bridged(map);
    assert.equal(Object.keys(b).length, 200);
    assert.ok(buildTokenCss(byId.cinema, {}, map).length < 20000);
  });

  test('a missing, empty or malformed map still produces the --cd-* variables', () => {
    const baseline = Object.keys(deriveTokens(byId.cinema, {}, undefined));
    assert.ok(baseline.includes('--cd-bg'));
    assert.ok(baseline.every((k) => k.startsWith('--cd-') || k === 'color-scheme' || LOCAL_NAMES.has(k)), 'only the built-in twins besides the contract variables');
    const hostile = [
      undefined, null, 0, 'map', [], {}, { vars: null }, { vars: 'x' }, { vars: [] }, { vars: { bg: 'not-a-list' } }, { vars: { bg: { 0: '--x' } } },
      { vars: { bg: null } }, { vars: { bg: [[]] } }, Object.create({ vars: { bg: ['--inherited'] } }),
      { get vars() { throw new Error('getter must not run'); } },
      { vars: { get bg() { throw new Error('getter must not run'); } } },
    ];
    for (const map of hostile) {
      const out = deriveTokens(byId.cinema, {}, map);
      assert.deepEqual(Object.keys(out), baseline, `map ${Object.prototype.toString.call(map)}`);
    }
  });

  test('prototype pollution cannot add variables or change colours', () => {
    Object.prototype.vars = { bg: ['--polluted-var'] };
    Object.prototype.accent = '#ff0000';
    Object.prototype.animations = false;
    Object.prototype.tokens = { color: { bg: '#123456' } };
    try {
      const out = deriveTokens(byId.cinema, {}, {});
      assert.ok(!('--polluted-var' in out));
      assert.equal(out['--cd-accent'], '#e8b04a');
      assert.equal(out['--cd-duration'], '160ms');
      assert.equal(out['--cd-bg'], '#0b0b0f');
      const bare = deriveTokens({}, {}, {});
      assert.equal(bare['--cd-bg'], '#0f0f0f', 'inherited tokens are ignored too');
    } finally {
      delete Object.prototype.vars;
      delete Object.prototype.accent;
      delete Object.prototype.animations;
      delete Object.prototype.tokens;
    }
  });
});

// =============================================================================================================================

describe('buildTokenCss', () => {
  test('one rule on the four-part selector that beats YouTube\'s html[dark] block and the [dark] elements below it', () => {
    // the last part: ytd-masthead carries its own dark attribute in YouTube dark mode and YouTube's [dark] block redefines the palette on it
    assert.equal(TOKEN_SELECTOR, 'html[cd-theme], html[cd-theme][dark], html[cd-theme]:not([dark]), html[cd-theme] [dark]');
    const css = buildTokenCss(byId.cinema, {}, MAP);
    const { selector } = parseRule(css);
    assert.equal(selector, TOKEN_SELECTOR);
    assert.ok(css.startsWith(`${TOKEN_SELECTOR}{`));
  });

  test('is exactly deriveTokens printed out (round trip), for every theme and a custom accent', () => {
    for (const t of THEMES) {
      for (const user of [{}, { accent: '#ff8800', animations: false }]) {
        const { decls } = parseRule(buildTokenCss(t, user, MAP));
        const want = deriveTokens(t, user, MAP);
        assert.deepEqual(Object.fromEntries(decls), want, `${t.id} ${JSON.stringify(user)}`);
      }
    }
  });

  test('stays small enough for a 150 KB content script and a 64 KB first-paint cache', () => {
    for (const t of THEMES) assert.ok(buildTokenCss(t, {}, MAP).length < 4000, t.id);
  });

  test('contains nothing that can load, run or escape: no url(), expression(), comment, @, <, backslash or newline', () => {
    for (const t of THEMES) {
      const css = buildTokenCss(t, { accent: '#abcdef' }, MAP);
      assert.doesNotMatch(css, /url\(|expression\(|\/\*|\*\/|@|<|>|\\|[\r\n]/i, t.id);
    }
  });

  test('hostile theme values cannot break out of their declaration', () => {
    const evil = '#fff;}body{display:none;}';
    const t = withTokens('cinema', {
      color: { bg: evil, surface: evil, text: evil, muted: evil, accent: evil, border: evil },
      type: { family: `Inter;}body{display:none`, baseSize: evil, headingWeight: evil },
      shape: { radius: evil, spacing: evil, shadow: evil },
    });
    const css = buildTokenCss(t, { accent: evil, animations: evil }, MAP);
    assert.doesNotMatch(css, /display|body/);
    const { decls } = parseRule(css);
    assert.equal(decls.get('--cd-bg'), '#0f0f0f', 'falls back to the neutral dark palette');
    assert.equal(decls.get('--cd-radius'), '12px');
  });

  test('values that would end a declaration are dropped, not repaired', () => {
    const map = cloneMap();
    map.vars.bg = ['--yt-fine'];
    const evilFamilyTheme = structuredClone(byId.cinema);
    evilFamilyTheme.tokens.type.family = 'Serif';
    const css = buildTokenCss(evilFamilyTheme, {}, map);
    assert.equal(parseRule(css).decls.get('--yt-fine'), 'var(--cd-bg)');
  });

  test('applies to the page in both YouTube modes and only when cd-theme is set (jsdom cascade)', () => {
    const page = createPage('home');
    const { document, window } = page;
    const root = document.documentElement;
    const youtube = document.createElement('style');
    youtube.textContent = 'html[dark]{--yt-sys-color-baseline--base-background:#0f0f0f;--yt-sys-color-baseline--text-primary:#f1f1f1}'
      + 'html:not([dark]){--yt-sys-color-baseline--base-background:#ffffff;--yt-sys-color-baseline--text-primary:#0f0f0f}';
    document.head.appendChild(youtube);
    const ours = document.createElement('style');
    ours.textContent = buildTokenCss(byId.cinema, {}, MAP);
    document.head.appendChild(ours);
    assert.equal(ours.sheet.cssRules.length, 1, 'the sheet parsed as one rule');

    const read = (name) => window.getComputedStyle(root).getPropertyValue(name);
    // 1. no cd-theme attribute: YouTube is untouched
    assert.ok(root.hasAttribute('dark'));
    assert.equal(read('--yt-sys-color-baseline--base-background'), '#0f0f0f');
    assert.equal(read('--cd-bg'), '');
    // 2. cd-theme + YouTube dark mode
    root.setAttribute('cd-theme', 'cinema');
    assert.equal(read('--cd-bg'), '#0b0b0f');
    assert.equal(read('--yt-sys-color-baseline--base-background'), 'var(--cd-bg)', 'ours beats html[dark]');
    assert.equal(read('--yt-sys-color-baseline--text-primary'), 'var(--cd-text)');
    assert.equal(read('color-scheme'), 'dark');
    // 3. cd-theme + YouTube light mode (the theme is dark, so it must still win, with a dark colour-scheme)
    root.removeAttribute('dark');
    assert.equal(read('--yt-sys-color-baseline--base-background'), 'var(--cd-bg)', 'ours beats html:not([dark])');
    assert.equal(read('--cd-text'), '#f2f2f5');
    // 4. removing the attribute gives the page back
    root.removeAttribute('cd-theme');
    assert.equal(read('--yt-sys-color-baseline--base-background'), '#ffffff');
    assert.equal(read('--cd-bg'), '');
  });

  test('wins whatever the injection order (before or after YouTube\'s own block)', () => {
    const page = createPage('watch');
    const { document, window } = page;
    const ours = document.createElement('style');
    ours.textContent = buildTokenCss(byId.minimal, {}, MAP);
    document.head.appendChild(ours);
    const youtube = document.createElement('style');
    youtube.textContent = 'html[dark]{--yt-sys-color-baseline--base-background:#0f0f0f}';
    document.body.appendChild(youtube); // later in the document than ours
    document.documentElement.setAttribute('cd-theme', 'minimal');
    const cs = window.getComputedStyle(document.documentElement);
    assert.equal(cs.getPropertyValue('--yt-sys-color-baseline--base-background'), 'var(--cd-bg)');
    assert.equal(cs.getPropertyValue('--cd-bg'), '#ffffff');
    assert.equal(cs.getPropertyValue('color-scheme'), 'light');
  });

  test('the density module\'s html[cd-theme] block can still override variables it owns (no clash with ours)', () => {
    const page = createPage('home');
    const { document, window } = page;
    const style = document.createElement('style');
    style.textContent = `${buildTokenCss(byId.cinema, {}, MAP)}\nhtml[cd-theme]{--cd-gap:16px;--cd-card-min:190px;--cd-row-gap:30px}`;
    document.head.appendChild(style);
    document.documentElement.setAttribute('cd-theme', 'cinema');
    const cs = window.getComputedStyle(document.documentElement);
    assert.equal(cs.getPropertyValue('--cd-gap'), '16px');
    assert.equal(cs.getPropertyValue('--cd-card-min'), '190px');
    assert.equal(cs.getPropertyValue('--cd-row-gap'), '30px');
  });
});

// =============================================================================================================================

describe('robustness: junk in, safe stylesheet out', () => {
  const junkThemes = [
    undefined, null, 0, 1, '', 'cinema', true, [], {}, () => {}, Symbol('t'),
    { tokens: null }, { tokens: 'x' }, { tokens: [] }, { tokens: {} }, { tokens: { color: null, type: null, shape: null } },
    { tokens: { color: { bg: 'banana', surface: 7, text: null, muted: {}, accent: [], border: undefined } } },
    { tokens: { color: { bg: '#000000' } } }, { tokens: { type: { family: null, baseSize: {}, headingWeight: 'bold' } } },
    { tokens: { get color() { throw new Error('getter must not run'); } } },
    Object.create({ tokens: { color: { bg: '#123456' } } }),
  ];

  test('never throws and always yields a complete, well-formed rule', () => {
    for (const theme of junkThemes) {
      const css = buildTokenCss(theme, undefined, MAP);
      const { decls } = parseRule(css);
      for (const name of CONTRACT_VARS) assert.ok(decls.has(name), `${String(typeof theme)}: ${name}`);
      assert.match(decls.get('--cd-bg'), /^#[0-9a-f]{6}$/);
      assert.match(decls.get('--cd-text'), /^#[0-9a-f]{6,8}$/);
    }
  });

  test('a theme with no readable colours gets a readable neutral palette', () => {
    const out = deriveTokens({}, {}, MAP);
    assert.equal(out['color-scheme'], 'dark');
    assert.ok(contrastRatio(out['--cd-text'], out['--cd-bg']) >= 4.5);
    assert.ok(contrastRatio(out['--cd-muted'], out['--cd-bg']) >= 4.5);
    assert.ok(contrastRatio(out['--cd-accent'], out['--cd-bg']) >= 3);
    assert.ok(contrastRatio(out['--cd-border'], out['--cd-bg']) >= 3);
    assert.equal(out['--cd-radius'], '12px');
    assert.equal(out['--cd-space'], '6px');
    assert.equal(out['--cd-font-family'], FONT_STACKS.System);
  });

  test('junk user settings are ignored', () => {
    for (const user of [undefined, null, 0, 'x', [], () => {}, { accent: {} }, { animations: 'no' }, { get accent() { throw new Error('no'); } }]) {
      const out = deriveTokens(byId.arcade, user, MAP);
      assert.equal(out['--cd-accent'], byId.arcade.tokens.color.accent);
      assert.equal(out['--cd-duration'], '160ms');
    }
  });

  test('inputs are not mutated, including frozen ones', () => {
    const freeze = (o) => {
      if (o && typeof o === 'object' && !Object.isFrozen(o)) {
        Object.freeze(o);
        for (const v of Object.values(o)) freeze(v);
      }
      return o;
    };
    const theme = freeze(structuredClone(byId.studio));
    const user = freeze({ accent: '#336699', animations: false });
    const map = freeze(cloneMap());
    const before = JSON.stringify([theme, user, map]);
    const css = buildTokenCss(theme, user, map);
    assert.equal(JSON.stringify([theme, user, map]), before);
    assert.equal(buildTokenCss(theme, user, map), css, 'pure: same input, same output');
  });

  test('the same input always gives byte-identical output', () => {
    for (const t of THEMES) assert.equal(buildTokenCss(t, { accent: '#336699' }, MAP), buildTokenCss(structuredClone(t), { accent: '#336699' }, structuredClone(MAP)));
  });

  test('the colour tokens of every launch theme survive unchanged (nothing is "improved" behind the theme\'s back)', () => {
    for (const t of THEMES) {
      const out = deriveTokens(t, {}, MAP);
      const c = t.tokens.color;
      assert.equal(out['--cd-bg'], c.bg, t.id);
      assert.equal(out['--cd-surface'], c.surface, t.id);
      assert.equal(out['--cd-text'], c.text, t.id);
      assert.equal(out['--cd-muted'], c.muted, t.id);
      assert.equal(out['--cd-accent'], c.accent, t.id);
      assert.equal(out['--cd-border'], c.border, t.id);
    }
  });
});
