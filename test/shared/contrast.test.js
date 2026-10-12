import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkThemeContrast, contrastRatio, parseColor, pickReadableText, relativeLuminance, toHex,
} from '../../src/shared/contrast.js';

const near = (actual, expected, eps, msg) => assert.ok(
  Math.abs(actual - expected) <= eps, `${msg || ''} expected ${expected} +/- ${eps}, got ${actual}`,
);

// Independent re-implementation of WCAG 2.2 straight from the definition, for differential tests.
// (0.03928 is the older threshold; no 8-bit channel falls between it and 0.04045, so results match.)
function refLum([r, g, b]) {
  const f = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
const refRatio = (a, b) => {
  const [hi, lo] = [refLum(a), refLum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

// Small seeded PRNG so failures reproduce.
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const randomRgb = (rand) => [0, 0, 0].map(() => Math.floor(rand() * 256));
const hex = ([r, g, b]) => `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;

test('contrastRatio matches published reference values', () => {
  const table = [
    ['#000000', '#ffffff', 21, 1e-9],
    ['#ffffff', '#ffffff', 1, 1e-9],
    ['#000', '#000', 1, 1e-9],
    ['#777777', '#ffffff', 4.478, 0.002],   // the classic "just fails AA" grey
    ['#767676', '#ffffff', 4.542, 0.002],   // the lightest grey that passes AA on white
    ['#595959', '#ffffff', 7.0, 0.01],
    ['#ff0000', '#ffffff', 3.998, 0.002],
    ['#0000ff', '#ffffff', 8.592, 0.005],
    ['#00ff00', '#000000', 15.304, 0.005],
    ['#808080', '#ffffff', 3.949, 0.005],
    ['#808080', '#000000', 5.317, 0.005],
    ['#ffff00', '#ffffff', 1.074, 0.002],
    ['#949494', '#ffffff', 3.030, 0.005],   // lightest grey with 3:1 on white
  ];
  for (const [a, b, expected, eps] of table) {
    near(contrastRatio(a, b), expected, eps, `${a} on ${b}`);
    near(contrastRatio(b, a), expected, eps, `${b} on ${a} (symmetric)`);
  }
});

test('contrastRatio agrees with an independent implementation on 2000 random pairs', () => {
  const rand = rng(42);
  for (let i = 0; i < 2000; i++) {
    const a = randomRgb(rand);
    const b = randomRgb(rand);
    near(contrastRatio(hex(a), hex(b)), refRatio(a, b), 1e-9, `${hex(a)} / ${hex(b)}`);
  }
});

test('ratio is always between 1 and 21 and never null for readable colours', () => {
  const rand = rng(7);
  for (let i = 0; i < 500; i++) {
    const r = contrastRatio(hex(randomRgb(rand)), hex(randomRgb(rand)));
    assert.ok(r >= 1 && r <= 21 + 1e-9, String(r));
  }
});

test('relativeLuminance uses the WCAG coefficients', () => {
  near(relativeLuminance('#000'), 0, 1e-12);
  near(relativeLuminance('#fff'), 1, 1e-12);
  near(relativeLuminance('#ff0000'), 0.2126, 1e-9);
  near(relativeLuminance('#00ff00'), 0.7152, 1e-9);
  near(relativeLuminance('#0000ff'), 0.0722, 1e-9);
  // linear segment (c <= 0.04045): 8-bit value 10 -> 10/255/12.92
  near(relativeLuminance('rgb(10, 10, 10)'), 10 / 255 / 12.92, 1e-12);
  near(relativeLuminance({ r: 255, g: 255, b: 255 }), 1, 1e-12);
});

test('relativeLuminance ignores alpha unless a background is given', () => {
  near(relativeLuminance('#ffffff00'), 1, 1e-12);
  near(relativeLuminance('#ffffff00', '#000'), 0, 1e-12);
  near(relativeLuminance('#ffffff80', '#000'), relativeLuminance('rgb(128,128,128)'), 1e-12);
});

test('luminance and ratio return null (not NaN, not a throw) for unreadable input', () => {
  for (const bad of ['red', '', 'var(--x)', null, undefined, 5, {}, [], '#12']) {
    assert.equal(relativeLuminance(bad), null, String(bad));
    assert.equal(contrastRatio(bad, '#fff'), null, String(bad));
    assert.equal(contrastRatio('#fff', bad), null, String(bad));
  }
  assert.equal(contrastRatio('#fff', '#000', 'nonsense'), null);
  assert.equal(relativeLuminance('#fff', 'nonsense'), null);
});

test('parseColor reads every supported syntax', () => {
  const table = [
    ['#fff', { r: 255, g: 255, b: 255, a: 1 }],
    ['#FFF', { r: 255, g: 255, b: 255, a: 1 }],
    ['#0b0b0f', { r: 11, g: 11, b: 15, a: 1 }],
    ['#0B0B0F', { r: 11, g: 11, b: 15, a: 1 }],
    ['#abc', { r: 170, g: 187, b: 204, a: 1 }],
    ['#000000ff', { r: 0, g: 0, b: 0, a: 1 }],
    ['#00000000', { r: 0, g: 0, b: 0, a: 0 }],
    ['rgb(1,2,3)', { r: 1, g: 2, b: 3, a: 1 }],
    ['RGB( 1 , 2 , 3 )', { r: 1, g: 2, b: 3, a: 1 }],
    ['rgb(1 2 3)', { r: 1, g: 2, b: 3, a: 1 }],
    ['rgb(1.4 2.6 3)', { r: 1, g: 3, b: 3, a: 1 }],
    ['rgb(100% 0% 50%)', { r: 255, g: 0, b: 128, a: 1 }],
    ['rgba(255, 0, 0, 0.5)', { r: 255, g: 0, b: 0, a: 0.5 }],
    ['rgba(255, 0, 0, .25)', { r: 255, g: 0, b: 0, a: 0.25 }],
    ['rgb(255 0 0 / 50%)', { r: 255, g: 0, b: 0, a: 0.5 }],
    ['rgb(255 0 0/0.5)', { r: 255, g: 0, b: 0, a: 0.5 }],
    ['rgb(255, 0, 0, 25%)', { r: 255, g: 0, b: 0, a: 0.25 }],
    ['hsl(0, 100%, 50%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(120 100% 50%)', { r: 0, g: 255, b: 0, a: 1 }],
    ['hsl(240, 100%, 50%)', { r: 0, g: 0, b: 255, a: 1 }],
    ['hsl(210, 50%, 40%)', { r: 51, g: 102, b: 153, a: 1 }],
    ['hsl(0, 0%, 50%)', { r: 128, g: 128, b: 128, a: 1 }],
    ['hsl(0, 0%, 0%)', { r: 0, g: 0, b: 0, a: 1 }],
    ['hsl(0, 0%, 100%)', { r: 255, g: 255, b: 255, a: 1 }],
    ['hsl(360, 100%, 50%)', { r: 255, g: 0, b: 0, a: 1 }],
    ['hsl(-120, 100%, 50%)', { r: 0, g: 0, b: 255, a: 1 }],
    ['hsl(480, 100%, 50%)', { r: 0, g: 255, b: 0, a: 1 }],
    ['hsl(0.5turn, 100%, 50%)', { r: 0, g: 255, b: 255, a: 1 }],
    ['hsl(200grad 100% 50%)', { r: 0, g: 255, b: 255, a: 1 }],
    ['hsl(180deg 100% 50%)', { r: 0, g: 255, b: 255, a: 1 }],
    ['hsla(120, 100%, 25%, 0.5)', { r: 0, g: 128, b: 0, a: 0.5 }],
    ['hsl(120 100% 25% / 50%)', { r: 0, g: 128, b: 0, a: 0.5 }],
  ];
  for (const [input, expected] of table) assert.deepEqual(parseColor(input), expected, input);
  near(parseColor('hsl(3.14159265rad 100% 50%)').g, 255, 0, 'radians');
  near(parseColor('#ff000080').a, 128 / 255, 1e-12);
});

test('parseColor trims CSS whitespace only', () => {
  assert.deepEqual(parseColor('  #fff \n'), { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(parseColor(' #fff'), null, 'NBSP is not CSS whitespace');
  assert.equal(parseColor('#fff '), null);
  assert.equal(parseColor('#fff '), null);
});

test('parseColor rejects everything it cannot read exactly', () => {
  const bad = [
    '', ' ', 'red', 'transparent', 'currentcolor', 'inherit', 'none', 'RED',
    'var(--x)', 'var(--x, #fff)', 'url(x.png)', 'expression(alert(1))', 'calc(1)', 'color-mix(in srgb, red, blue)', 'lab(50% 0 0)', 'color(srgb 1 0 0)',
    '#', '#f', '#ff', '#fffff', '#fffffff', '#fffffffff', '#ggg', '#12345g', 'fff', '# fff',
    'rgb(0,0)', 'rgb(0,0,0,0,0)', 'rgb()', 'rgb(0,0,0', 'rgb 0,0,0)', 'rgb(0 0 0 0)', 'rgb(0, 0, 0 / 0.5)', 'rgb(0 0 0 / )', 'rgb(0 0 0 / 0.5 0.5)',
    'rgb(0,,0)', 'rgb(0,0,0,)', 'rgb(,0,0)', 'rgb(0 0, 0)', 'rgb(1, 2 3)', 'rgb(0 0 0 //0.5)',
    'rgb(256,0,0)', 'rgb(-1,0,0)', 'rgb(0,0,256)', 'rgb(101%,0%,0%)', 'rgb(-1%,0%,0%)', 'rgb(50%, 0, 0)', 'rgb(0 50% 0)',
    'rgb(0,0,0,1.01)', 'rgb(0,0,0,-0.1)', 'rgb(0,0,0,101%)', 'rgba(0,0,0,2)',
    'rgb(1e2,0,0)', 'rgb(NaN,0,0)', 'rgb(Infinity,0,0)', 'rgb(0x10,0,0)', 'rgb(5.,0,0)', 'rgb(--5,0,0)', 'rgb(1_0,0,0)',
    'rgb(var(--r),0,0)', 'rgb(calc(1),0,0)', 'rgb(0,0,0);', 'rgb(0,0,0)}', 'rgb(0,0,0) !important', 'rgb(0,0,0)/**/', 'rgb(0,0,0))',
    'rgb((0),0,0)', 'rgb(0,0,0)rgb(0,0,0)',
    'hsl(0, 0, 0)', 'hsl(0 100 50)', 'hsl(0, 101%, 50%)', 'hsl(0, 100%, 101%)', 'hsl(0, -1%, 50%)', 'hsl(red, 100%, 50%)',
    'hsl(0foo, 100%, 50%)', 'hsl(0, 100%)', 'hsl(, 100%, 50%)', 'hsla(0,0%,0%,2)', 'hsl(1e3, 100%, 50%)', 'hsl(0 0% 0% / none)',
    '\u0000', '#fff\u0000', 'rgb(0,0,0)\n}', '#fff\n}', '１２３',
    'x'.repeat(65), `#${'f'.repeat(100)}`, `rgb(${'1 '.repeat(100000)})`, ' '.repeat(100000) + '#fff',
    null, undefined, 0, 1, NaN, true, {}, [], ['#fff'], () => '#fff', Symbol('x'), 10n,
  ];
  for (const input of bad) assert.equal(parseColor(input), null, String(typeof input === 'string' ? input.slice(0, 40) : input));
});

test('parseColor accepts a 64-character colour but not 65', () => {
  const pad = ' '.repeat(64 - 'rgb(1,2,3)'.length);
  assert.ok(parseColor(`rgb(1,${pad}2,3)`), 'a legal colour padded to exactly 64 chars');
  assert.equal(parseColor(`rgb(1,${pad} 2,3)`), null);
});

test('parseColor composites alpha over the given background and rounds like a browser', () => {
  assert.deepEqual(parseColor('rgba(255,255,255,0.5)', '#000'), { r: 128, g: 128, b: 128, a: 1 });
  assert.deepEqual(parseColor('rgba(255,0,0,0.5)', '#0000ff'), { r: 128, g: 0, b: 128, a: 1 });
  assert.deepEqual(parseColor('#ff000000', '#123456'), { r: 0x12, g: 0x34, b: 0x56, a: 1 }, 'fully transparent shows the background');
  assert.deepEqual(parseColor('#ff0000', '#123456'), { r: 255, g: 0, b: 0, a: 1 }, 'opaque ignores the background');
  assert.deepEqual(parseColor('#fff8', { r: 0, g: 0, b: 0, a: 1 }), { r: 136, g: 136, b: 136, a: 1 }, 'background may be an Rgba');
  assert.equal(parseColor('#fff', 'nonsense'), null);
  assert.equal(parseColor('nonsense', '#fff'), null);
  // A translucent background is flattened onto white first.
  assert.deepEqual(parseColor('#ff000080', '#00000000'), { r: 255, g: 127, b: 127, a: 1 });
});

test('toHex round-trips and reports alpha', () => {
  assert.equal(toHex('#FFF'), '#ffffff');
  assert.equal(toHex('rgb(255, 0, 0)'), '#ff0000');
  assert.equal(toHex('hsl(120 100% 50%)'), '#00ff00');
  assert.equal(toHex('#ff000080'), '#ff000080');
  assert.equal(toHex({ r: 1, g: 2, b: 3 }), '#010203');
  assert.equal(toHex('red'), null);
  assert.equal(toHex(null), null);
  const rand = rng(3);
  for (let i = 0; i < 200; i++) {
    const c = hex(randomRgb(rand));
    assert.equal(toHex(c), c);
    assert.equal(toHex(parseColor(c)), c);
  }
});

test('translucent colours are composited, not ignored', () => {
  // white text at 50% over black behaves like #808080, not like pure white
  const half = contrastRatio('rgba(255,255,255,0.5)', '#000');
  near(half, contrastRatio('#808080', '#000'), 1e-9);
  assert.ok(half < 6);
  // translucent bg over the default (white) canvas: alpha 0x80 is 50.196%, so white 255 mixes down to 127
  near(contrastRatio('#000', '#00000080'), contrastRatio('#000', '#7f7f7f'), 1e-9);
  // explicit canvas
  near(contrastRatio('#fff', '#00000080', '#000'), contrastRatio('#fff', '#000'), 1e-9);
});

test('pickReadableText chooses the higher-contrast of black and white', () => {
  assert.equal(pickReadableText('#000000'), '#ffffff');
  assert.equal(pickReadableText('#ffffff'), '#000000');
  assert.equal(pickReadableText('#0b0b0f'), '#ffffff');
  assert.equal(pickReadableText('#e8b04a'), '#000000', 'Cinema gold accent needs dark text');
  assert.equal(pickReadableText('#ffff00'), '#000000');
  assert.equal(pickReadableText('#000080'), '#ffffff');
  assert.equal(pickReadableText('#ff0000'), '#000000', 'pure red: 5.25 with black, 4.0 with white');
  assert.equal(pickReadableText('hsl(210 80% 30%)'), '#ffffff');
  assert.equal(pickReadableText('#767676'), '#000000', 'crossover sits at luminance ~0.179');
  assert.equal(pickReadableText('#707070'), '#ffffff');
});

test('pickReadableText is the argmax for random backgrounds and always reaches 4.5:1 or close', () => {
  const rand = rng(99);
  for (let i = 0; i < 1000; i++) {
    const c = randomRgb(rand);
    const pick = pickReadableText(hex(c));
    assert.ok(pick === '#000000' || pick === '#ffffff');
    const chosen = refRatio(c, pick === '#000000' ? [0, 0, 0] : [255, 255, 255]);
    const other = refRatio(c, pick === '#000000' ? [255, 255, 255] : [0, 0, 0]);
    assert.ok(chosen >= other - 1e-9, `${hex(c)} picked ${pick}`);
    assert.ok(chosen >= 4.58, `best of black/white is never below 4.58 (${hex(c)} -> ${chosen})`);
  }
});

test('pickReadableText handles translucent backgrounds and junk', () => {
  assert.equal(pickReadableText('#00000000'), '#000000', 'transparent over the default white canvas');
  assert.equal(pickReadableText('#00000000', '#000'), '#ffffff', 'transparent over a black canvas');
  assert.equal(pickReadableText('#00000080'), '#000000', 'half black over white is mid grey, black wins');
  for (const bad of ['red', '', null, undefined, 5, {}, 'var(--x)']) assert.equal(pickReadableText(bad), '#ffffff', String(bad));
  assert.equal(pickReadableText('#fff', 'nonsense'), '#ffffff');
});

// ---- checkThemeContrast ---------------------------------------------------------------------

const cinema = () => ({
  tokens: { color: { bg: '#0b0b0f', surface: '#16161d', text: '#f2f2f5', muted: '#9a9aa8', accent: '#e8b04a', border: '#26262f' } },
});
const withColor = (over) => ({ tokens: { color: { ...cinema().tokens.color, ...over } } });
const byPair = (results) => Object.fromEntries(results.map((r) => [r.pair, r]));

test('checkThemeContrast returns the six contract pairs in order with their thresholds', () => {
  const res = checkThemeContrast(cinema());
  assert.deepEqual(res.map((r) => [r.pair, r.required]), [
    ['text/bg', 4.5], ['text/surface', 4.5], ['muted/bg', 4.5], ['muted/surface', 4.5], ['accent/bg', 3], ['border/bg', 3],
  ]);
  for (const r of res) assert.deepEqual(Object.keys(r), ['pair', 'ratio', 'required', 'pass']);
});

test('the spec example theme passes everything except its border, which is only about 1.3:1', () => {
  const res = byPair(checkThemeContrast(cinema()));
  for (const p of ['text/bg', 'text/surface', 'muted/bg', 'muted/surface', 'accent/bg']) assert.equal(res[p].pass, true, p);
  const c = cinema().tokens.color;
  near(res['text/bg'].ratio, refRatio([0xf2, 0xf2, 0xf5], [0x0b, 0x0b, 0x0f]), 0.01);
  near(res['muted/surface'].ratio, refRatio([0x9a, 0x9a, 0xa8], [0x16, 0x16, 0x1d]), 0.01);
  assert.equal(c.border, '#26262f');
  assert.equal(res['border/bg'].pass, false, 'the spec example border is below the 3:1 the contract asks for, so shipped themes need stronger borders');
});

test('each pair fails on its own', () => {
  const cases = [
    ['text/bg', { text: '#0b0b10' }, ['text/bg', 'text/surface']],
    ['text/surface', { surface: '#f2f2f4' }, ['text/surface', 'muted/surface']],
    ['muted/bg', { muted: '#101018' }, ['muted/bg', 'muted/surface']],
    ['accent/bg', { accent: '#0d0d12' }, ['accent/bg']],
    ['border/bg', { border: '#0c0c10' }, ['border/bg']],
  ];
  for (const [label, over, mustFail] of cases) {
    const res = byPair(checkThemeContrast(withColor({ border: '#8a8a99', ...over })));
    for (const p of mustFail) assert.equal(res[p].pass, false, `${label}: ${p}`);
  }
  // the all-good baseline with a strong border passes everything
  const good = checkThemeContrast(withColor({ border: '#8a8a99' }));
  assert.ok(good.every((r) => r.pass), JSON.stringify(good));
});

test('thresholds are exact: 4.5 and 3 pass, just below fails', () => {
  const white = (over) => byPair(checkThemeContrast({ tokens: { color: { bg: '#ffffff', surface: '#ffffff', text: '#000', muted: '#000', accent: '#000', border: '#000', ...over } } }));
  assert.equal(white({ text: '#767676' })['text/bg'].pass, true);
  assert.equal(white({ text: '#777777' })['text/bg'].pass, false);
  assert.equal(white({ muted: '#767676' })['muted/surface'].pass, true);
  assert.equal(white({ muted: '#777777' })['muted/surface'].pass, false);
  assert.equal(white({ accent: '#949494' })['accent/bg'].pass, true);
  assert.equal(white({ accent: '#959595' })['accent/bg'].pass, false);
  assert.equal(white({ border: '#949494' })['border/bg'].pass, true);
  assert.equal(white({ border: '#959595' })['border/bg'].pass, false);
});

test('reported ratio is floored to two decimals, never rounded up past the true value', () => {
  const rand = rng(11);
  for (let i = 0; i < 300; i++) {
    const t = { tokens: { color: { bg: hex(randomRgb(rand)), surface: hex(randomRgb(rand)), text: hex(randomRgb(rand)), muted: hex(randomRgb(rand)), accent: hex(randomRgb(rand)), border: hex(randomRgb(rand)) } } };
    const c = t.tokens.color;
    const res = byPair(checkThemeContrast(t));
    const exact = contrastRatio(c.text, c.bg);
    assert.ok(res['text/bg'].ratio <= exact + 1e-12);
    assert.ok(exact - res['text/bg'].ratio < 0.01 + 1e-9);
    assert.equal(res['text/bg'].pass, res['text/bg'].ratio >= 4.5);
    assert.equal(Math.round(res['text/bg'].ratio * 100) / 100, res['text/bg'].ratio);
  }
});

test('surface and text are judged as painted: translucent surface sits on bg, text on the result', () => {
  const t = { tokens: { color: { bg: '#000000', surface: '#ffffff80', text: '#ffffff', muted: '#ffffff', accent: '#ffffff', border: '#ffffff' } } };
  const res = byPair(checkThemeContrast(t));
  assert.equal(res['text/bg'].pass, true);
  assert.equal(res['text/surface'].pass, false, 'white on the mid-grey the surface really is');
  assert.equal(res['text/surface'].ratio, 3.94, 'white on #808080 is 3.949, floored');
  // translucent text over the surface
  const t2 = { tokens: { color: { bg: '#000000', surface: '#000000', text: '#ffffff80', muted: '#fff', accent: '#fff', border: '#fff' } } };
  assert.equal(byPair(checkThemeContrast(t2))['text/bg'].ratio, 5.31, '#808080 on black is 5.317, floored');
});

test('a translucent bg is judged against both a white and a black canvas, worst case wins', () => {
  const t = (bg) => ({ tokens: { color: { bg, surface: '#000000', text: '#000000', muted: '#000000', accent: '#000000', border: '#000000' } } });
  const res = byPair(checkThemeContrast(t('#00000080')));
  assert.equal(res['text/bg'].pass, false, 'black text on a half-black bg is unreadable if the canvas is black');
  assert.equal(res['text/bg'].ratio, 1);
  // an opaque bg is unaffected by any of this
  assert.equal(byPair(checkThemeContrast(t('#ffffff')))['text/bg'].ratio, 21);
  // translucent bg that is readable on both canvases passes
  const ok = { tokens: { color: { bg: '#ffffffcc', surface: '#ffffff', text: '#000000', muted: '#000000', accent: '#000000', border: '#000000' } } };
  assert.equal(byPair(checkThemeContrast(ok))['text/bg'].pass, true);
  const bad = { tokens: { color: { bg: '#00000000', surface: '#ffffff', text: '#ffffff', muted: '#ffffff', accent: '#ffffff', border: '#ffffff' } } };
  assert.equal(byPair(checkThemeContrast(bad))['text/bg'].pass, false, 'white text on a transparent bg is unreadable over a white canvas');
});

test('checkThemeContrast never throws and reports null/false for missing or unreadable colours', () => {
  const junk = [undefined, null, 5, 'theme', [], {}, { tokens: null }, { tokens: [] }, { tokens: { color: null } }, { tokens: { color: [] } }, { tokens: { color: 'x' } }];
  for (const j of junk) {
    const res = checkThemeContrast(j);
    assert.equal(res.length, 6);
    assert.ok(res.every((r) => r.ratio === null && r.pass === false), JSON.stringify(j));
  }
  const res = byPair(checkThemeContrast(withColor({ text: 'red', accent: 5, border: undefined })));
  assert.equal(res['text/bg'].ratio, null);
  assert.equal(res['text/bg'].pass, false);
  assert.equal(res['accent/bg'].ratio, null);
  assert.equal(res['border/bg'].pass, false);
  assert.equal(res['muted/bg'].pass, true, 'unrelated pairs are still evaluated');
  // missing surface only affects the surface pairs
  const noSurface = byPair(checkThemeContrast({ tokens: { color: { ...cinema().tokens.color, surface: undefined } } }));
  assert.equal(noSurface['text/bg'].pass, true);
  assert.equal(noSurface['text/surface'].ratio, null);
  assert.equal(noSurface['muted/surface'].pass, false);
});

test('checkThemeContrast ignores inherited properties and does not mutate its input', () => {
  Object.prototype.bg = '#000000'; // eslint-disable-line no-extend-native
  try {
    const res = byPair(checkThemeContrast({ tokens: { color: { text: '#fff' } } }));
    assert.equal(res['text/bg'].ratio, null, 'bg must come from the theme, not Object.prototype');
  } finally {
    delete Object.prototype.bg;
  }
  const t = cinema();
  const snapshot = JSON.stringify(t);
  checkThemeContrast(t);
  assert.equal(JSON.stringify(t), snapshot);
});

// ---- real data: colours measured on live youtube.com (test/fixtures/real/computed-colors.json) ----

const REAL = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'real', 'computed-colors.json'), 'utf8'));
const SYS = REAL.sysColorsBaseline;
const sys = (name) => SYS[`--yt-sys-color-baseline--${name}`];

test('every colour string captured from live YouTube parses (raw custom-property values and computed rgb()/rgba())', () => {
  const found = [];
  for (const v of [...Object.values(SYS), ...Object.values(REAL.deprecatedGeneralBackground)]) found.push(v);
  for (const entry of Object.values(REAL.surfaces)) {
    if (entry === null || typeof entry !== 'object') continue;
    for (const [k, v] of Object.entries(entry)) if (/color/i.test(k) && typeof v === 'string') found.push(v);
  }
  assert.ok(found.length > 40, `expected a good sample, got ${found.length}`);
  for (const v of found) assert.notEqual(parseColor(v), null, v);
  assert.deepEqual(parseColor(sys('static-brand-red')), { r: 255, g: 0, b: 51, a: 1 }, '#f03, a 3-digit hex straight from YouTube');
  assert.deepEqual(parseColor(sys('outline')), { r: 255, g: 255, b: 255, a: 0.2 }, 'rgba() with no spaces');
  assert.deepEqual(parseColor(REAL.surfaces.html.backgroundColor), { r: 15, g: 15, b: 15, a: 1 });
  assert.equal(parseColor(REAL.surfaces.body.backgroundColor).a, 0, 'computed transparent');
});

test('compositing reproduces what YouTube itself paints: outline over the base background is its outline-opaque', () => {
  assert.equal(toHex(parseColor(sys('outline'), sys('base-background'))), sys('outline-opaque'));
  assert.equal(toHex(parseColor(sys('frosted-glass-desktop'), '#000')), '#0c0c0c');
});

test('YouTube dark palette: the real text pairs clear AA, the disabled text does not (and is not meant to)', () => {
  const bg = sys('base-background');
  assert.ok(contrastRatio(sys('text-primary'), bg) > 15);
  assert.ok(contrastRatio(sys('text-secondary'), bg) >= 4.5);
  assert.ok(contrastRatio(sys('text-secondary'), sys('raised-background')) >= 4.5);
  assert.ok(contrastRatio(sys('call-to-action'), bg) >= 3);
  const disabled = contrastRatio(sys('text-disabled'), bg);
  assert.ok(disabled < 4.5 && disabled > 3, String(disabled));
  near(contrastRatio(sys('text-primary'), bg), refRatio([0xf1, 0xf1, 0xf1], [0x0f, 0x0f, 0x0f]), 1e-9);
});

test('YouTube own dark palette run through checkThemeContrast: only its hairline border misses the 3:1 the contract asks for', () => {
  const res = byPair(checkThemeContrast({ tokens: { color: {
    bg: sys('base-background'), surface: sys('raised-background'), text: sys('text-primary'),
    muted: sys('text-secondary'), accent: sys('call-to-action'), border: sys('outline-opaque'),
  } } }));
  for (const p of ['text/bg', 'text/surface', 'muted/bg', 'muted/surface', 'accent/bg']) assert.equal(res[p].pass, true, p);
  assert.equal(res['border/bg'].pass, false);
  assert.ok(res['border/bg'].ratio > 1.7 && res['border/bg'].ratio < 1.9, String(res['border/bg'].ratio));
});
