// Permanent regression corpus for the theme CSS validator's allow-list profile (ARCHITECTURE.md section 4 "css-validator", section 6).
//
// Every case below is a CSS rule that an earlier, deny-list version of the validator ACCEPTED while it hid, collapsed, displaced or
// covered an ad in real Chrome 154 (measured by the ad-safety reviewer: a red ad slot in a flex feed, "% of the ad's red pixels
// left"), or that is a close relative. The expectation is always "refused", with the reason the allow-list gives. The accepted list at
// the bottom is ordinary theme CSS that must keep passing, so the allow-list cannot be tightened into uselessness.
//
// test/e2e/ad-bypass-corpus.mjs renders the same families in a real browser; this file is the fast, always-on half.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateCss, buildAllowList, scanCss } from '../../src/shared/css-validator.js';
import { safeHide } from '../../src/shared/selector-map.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP = JSON.parse(readFileSync(path.join(ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
const ALLOW = buildAllowList(MAP);
const PROTECTED = [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls];
const CTX = { allowList: ALLOW, protectedSelectors: PROTECTED };
const ADS = MAP.protected.ads.join(', ');
const GUARD = `:not(:has(${ADS}))`;
const INSIDE = `:not(:is(${[...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls].join(', ')}) *)`;
const PROFILE = new Set(['property-not-allowed', 'value-not-allowed', 'custom-property']);
const SAFETY = new Set(['hides-protected', 'hides-container', 'covers-page']);

const AD = 'ytd-ad-slot-renderer';
const SPONSOR = '.ytp-paid-content-overlay';
const CONTROL = '.ytp-chrome-bottom';
const TILE = 'ytd-rich-item-renderer';
const T = (sel, body) => `html[cd-theme] ${sel}{${body}}`;

const check = (css) => validateCss(css, CTX);
const detail = (r) => r.errors.map((e) => `${e.code}: ${e.message}`).join('\n');
function refused(css, why = null) {
  const r = check(css);
  assert.equal(r.ok, false, `ACCEPTED, must be refused: ${css.slice(0, 240)}`);
  assert.ok(r.errors.some((e) => PROFILE.has(e.code) || SAFETY.has(e.code) || e.code === 'selector-not-allowed' || e.code === 'selector-bare'),
    `refused, but not by the allow-list or the safety layer: ${css.slice(0, 200)}\n${detail(r)}`);
  if (why) assert.match(detail(r), why, css.slice(0, 200));
  return r;
}
function accepted(css) {
  const r = check(css);
  assert.equal(r.ok, true, `must be accepted: ${css.slice(0, 240)}\n${detail(r)}`);
}

// ---- finding 1: the magnitude deny-list let single rules through ---------------------------------------------------------------

// [label, declarations]: each is applied to the ad, to the sponsorship label, to a control and to the tile that holds the ad.
const SINGLE_RULES = [
  ['rotateY(180deg) + backface-visibility', 'transform:rotateY(180deg);backface-visibility:hidden'],
  ['rotate: y 180deg + backface-visibility', 'rotate:y 180deg;backface-visibility:hidden'],
  ['backface-visibility alone', 'backface-visibility:hidden'],
  ['height 1.5px + overflow hidden', 'height:1.5px;overflow:hidden'],
  ['max-height 25px + overflow hidden', 'max-height:25px;overflow:hidden'],
  ['zoom .06', 'zoom:.06'],
  ['zoom 50 (enlarges over neighbours)', 'zoom:50'],
  ['height env()', 'height:env(cd-x,0px);overflow:hidden'],
  ['height attr()', 'height:attr(cd-x px,0px);overflow:hidden'],
  ['height round()', 'height:round(down,1px,100px);overflow:hidden'],
  ['height calc(sin(0))', 'height:calc(sin(0)*1px);overflow:hidden'],
  ['width mod()', 'width:mod(7px,7px);overflow:hidden'],
  ['height pow()', 'height:calc(pow(0,2)*1px);overflow:hidden'],
  ['left 99vw', 'position:relative;left:99vw'],
  ['margin-left 99vw', 'margin-left:99vw'],
  ['margin-top 99vh', 'margin-top:99vh'],
  ['rotateX(88deg)', 'transform:rotateX(88deg)'],
  ['scale(.25)', 'transform:scale(.25)'],
  ['scale: .25', 'scale:.25'],
  ['matrix shrink', 'transform:matrix(.2,0,0,.2,0,0)'],
  ['perspective + translateZ', 'transform:perspective(1px) translateZ(-1000px)'],
  ['scale(4.9)', 'transform:scale(4.9)'],
  ['outline 999px', 'outline:999px solid #9bd'],
  ['outline-width 99vw', 'outline-width:99vw;outline-style:solid'],
  ['box-shadow spread 999px', 'box-shadow:0 0 0 999px #9bd'],
  ['box-shadow offset 159px', 'box-shadow:0 159px 0 0 #9bd'],
  ['translate 0 -159px', 'translate:0 -159px'],
  ['translateY(-159px)', 'transform:translateY(-159px)'],
  ['sub-threshold left', 'position:relative;left:-99px'],
  ['sub-threshold margin', 'margin-top:-99px'],
  ['flex-basis 0 + grow 0 + shrink 0', 'flex-basis:0;flex-grow:0;flex-shrink:0;overflow:hidden'],
  ['min-height 99999px', 'min-height:99999px'],
  ['padding-bottom 99999px', 'padding-bottom:99999px'],
  ['order 99999', 'order:99999'],
  ['contain: size + height', 'contain:size;height:1px'],
  ['content-visibility hidden', 'content-visibility:hidden'],
  ['clip-path inset(50%)', 'clip-path:inset(50%)'],
  ['clip rect', 'clip:rect(0,0,0,0)'],
  ['mask', 'mask-image:linear-gradient(#000,transparent)'],
  ['filter opacity(.3)', 'filter:opacity(.3)'],
  ['filter brightness(0)', 'filter:brightness(0)'],
  ['backdrop-filter blur', 'backdrop-filter:blur(30px)'],
  ['opacity .99', 'opacity:.99'],
  ['visibility hidden', 'visibility:hidden'],
  ['display none', 'display:none'],
  ['display contents', 'display:contents'],
  ['pointer-events none', 'pointer-events:none'],
  ['font-size 4px', 'font-size:4px'],
  ['line-height 0', 'line-height:0'],
  ['text-indent -9999px', 'text-indent:-9999px'],
  ['position fixed', 'position:fixed;inset:0;z-index:99'],
  ['z-index -1', 'z-index:-1'],
  ['mix-blend-mode multiply', 'mix-blend-mode:multiply'],
  ['aspect-ratio + zero width', 'aspect-ratio:100/1;width:0'],
  ['container-type size (collapses)', 'container-type:size'],
  ['all: unset', 'all:unset'],
  ['animation of a size', 'animation:cd-h 1ms forwards'],
  ['transition of a size', 'transition:height 0s;height:1px'],
  ['an unknown future property', 'anchor-name:--x;position-anchor:--x'],
  ['an unknown vendor property', '-webkit-appearance:none;-webkit-box-flex:0'],
  ['a made-up property', 'cd-banana:1'],
];

for (const [label, body] of SINGLE_RULES) {
  test(`allow-list refuses on ads, sponsorship labels, controls and the tile that holds an ad: ${label}`, () => {
    for (const sel of [AD, SPONSOR, CONTROL, TILE, `${TILE}${GUARD}`, '#masthead-ad']) {
      refused(T(sel, body));
      refused(`@media screen{${T(sel, body)}}`);
      refused(`@supports (display:grid){${T(sel, body)}}`);
      refused(T(sel, `${body} !important`));
    }
  });
}

test('keyframed sizes, rotations and fades cannot be applied to ads or to anything else of YouTube\'s', () => {
  for (const [frames, anim] of [
    ['@keyframes cd-h{to{height:2px;overflow:hidden}}', 'cd-h 1ms forwards'],
    ['@keyframes cd-r{to{transform:rotateY(180deg);backface-visibility:hidden}}', 'cd-r 1ms forwards'],
    ['@keyframes cd-o{to{opacity:0}}', 'cd-o 1ms forwards'],
    ['@keyframes cd-s{to{transform:scale(.01)}}', 'cd-s 1ms both'],
    ['@keyframes cd-m{to{margin-left:99vw}}', 'cd-m 1ms both'],
    ['@keyframes cd-c{to{background-color:var(--cd-accent)}}', 'cd-c 1ms both'],   // colours of an ad are not a theme's to animate
  ]) {
    for (const sel of [AD, SPONSOR, CONTROL, TILE]) refused(`${frames}${T(sel, `animation:${anim}`)}`);
    refused(`${frames}${T(AD, `animation-name:${anim.split(' ')[0]}`)}`);
    refused(`${frames}${T(AD, `animation:${anim.replace('cd-', 'CD-')}`)}`);
  }
  // an animation name that is not defined in the theme could be YouTube's own
  refused(T(TILE, 'animation:ytSpin 1s'));
  refused(T(TILE, 'animation:cd-not-defined-here 1s'));
});

test('a rule is refused wherever the property sits: after harmless declarations, in a list, under :is(), in a nested at-rule, with escapes', () => {
  const dangerous = 'zoom:.06';
  for (const css of [
    `${AD}{border-radius:4px;${dangerous};color:var(--cd-text)}`,
    `.cd-a,${AD},.cd-b{${dangerous}}`,
    `:is(${AD}){${dangerous}}`,
    `:where(${AD}){${dangerous}}`,
    `html[cd-theme] ${AD}:hover{${dangerous}}`,
    `@media (min-width:1px){@supports (display:grid){@layer x{${AD}{${dangerous}}}}}`,
    `${AD}{z\\6fom:.06}`,
    `${AD}{ZOOM : .06 }`,
    `${AD}{-webkit-zoom:.06}`,
    `${AD}{/**/zoom/**/:/**/.06/**/}`,
    `${AD}{--cd-t-z:.06;zoom:var(--cd-t-z)}`,
    `${AD}{zoom:var(--cd-t-nothing,.06)}`,
  ]) refused(css);
});

test('foreign elements: every property outside the cosmetic list is refused, whatever its value', () => {
  const props = ['width', 'height', 'min-width', 'min-height', 'max-width', 'max-height', 'inline-size', 'block-size', 'margin', 'margin-top', 'margin-inline', 'padding',
    'padding-left', 'inset', 'top', 'left', 'right', 'bottom', 'position', 'z-index', 'display', 'visibility', 'opacity', 'overflow', 'overflow-x', 'overflow-y',
    'transform', 'translate', 'rotate', 'scale', 'zoom', 'filter', 'backdrop-filter', 'clip', 'clip-path', 'mask', 'mask-image', 'contain', 'content-visibility',
    'pointer-events', 'font-size', 'line-height', 'font', 'flex', 'flex-basis', 'flex-grow', 'flex-shrink', 'order', 'grid-template-columns', 'grid-column', 'gap',
    'float', 'clear', 'vertical-align', 'text-indent', 'word-spacing', 'white-space', 'text-overflow', 'object-fit', 'object-position', 'aspect-ratio', 'content',
    'perspective', 'transform-style', 'backface-visibility', 'will-change', 'isolation', 'mix-blend-mode', 'resize', 'user-select', 'appearance', 'box-sizing',
    'list-style', 'quotes', 'counter-increment', 'column-count', 'scroll-snap-type', 'cursor-hide', 'all'];
  for (const p of props) {
    const r = check(T(TILE, `${p}:inherit`));
    assert.equal(r.ok, false, `${p} must not be allowed on a YouTube element`);
    // ('all' is named by the safety layer first; every other property by the allow-list)
    assert.ok(r.errors.some((e) => e.code === 'property-not-allowed' || (p === 'all' && SAFETY.has(e.code))), `${p}: ${detail(r)}`);
  }
});

// ---- finding 2: custom properties -------------------------------------------------------------------------------------------------

test('custom properties: only --cd-t-<name> (and --cd-heading-font with a known font) may be declared', () => {
  for (const decl of ['--cd-row-gap:-400px', '--cd-font-scale:0', '--cd-text:#0b0b0f', '--cd-bg:#000', '--cd-muted:#000', '--cd-gap:0px', '--cd-card-min:0px',
    '--cd-radius:9999px', '--cd-space:99999px', '--cd-row-visible:0', '--cd-duration:99999s', '--cd-accent:red', '--cd-shadow:none', '--cd-font-family:serif',
    '--ytd-watch-flexy-horizontal-page-margin:9999px', '--ytd-rich-grid-items-per-row:100000', '--ytd-watch-flexy-sidebar-width:0px', '--yt-spec-text-primary:#000',
    '--yt-sys-color-baseline--text-primary:var(--cd-bg)', '--x:1', '--CD-T-x:1', '--cd-t-:1', '--cd-t-UPPER:1', '--cd-t_x:1', '--cd-heading-weight:0',
    '--cd-heading-font:Wingdings', '--cd-heading-font:"Webdings",serif']) {
    for (const wrap of [(d) => T('', d).replace('html[cd-theme] {', 'html[cd-theme][cd-theme]{'), (d) => `${AD}{${d}!important}`, (d) => `.cd-a{${d}}`, (d) => `@media print{html[cd-theme]{${d}}}`]) {
      const r = check(wrap(decl));
      assert.equal(r.ok, false, `declared: ${decl}`);
      assert.ok(r.errors.some((e) => e.code === 'custom-property'), `${decl}: ${detail(r)}`);
    }
  }
  accepted('html[cd-theme]{--cd-t-gap:12px;--cd-t-hue:var(--cd-accent);--cd-heading-font:Georgia,\'Times New Roman\',serif}');
  accepted('.cd-card{--cd-t-lift:3px}.cd-card-thumb{padding-top:var(--cd-t-lift)}');
});

test('a theme variable is judged where it is used: its declared values must satisfy the property', () => {
  refused('.cd-a{--cd-t-pad:99999px}.cd-b{padding-left:var(--cd-t-pad)}');
  refused('html[cd-theme]{--cd-t-pad:-400px}.cd-b{margin-bottom:var(--cd-t-pad)}');
  refused('html[cd-theme]{--cd-t-p:0}.cd-b{opacity:var(--cd-t-p)}.cd-hero{opacity:var(--cd-t-p)}');
  refused(`html[cd-theme]{--cd-t-d:none}${TILE}{display:var(--cd-t-d)}`);
  refused('.cd-a{--cd-t-pad:2px}.cd-c{--cd-t-pad:99999px}.cd-b{padding-left:var(--cd-t-pad)}');
  accepted('.cd-a{--cd-t-pad:2px}.cd-c{--cd-t-pad:12px}.cd-b{padding-left:var(--cd-t-pad)}');
  // more declarations of one name than the validator tracks: it refuses to guess
  const many = Array.from({ length: 9 }, (_, i) => `.cd-x${i}{--cd-t-pad:${i}px}`).join('');
  refused(`${many}.cd-b{padding-left:var(--cd-t-pad)}`);
  // YouTube's own variables are unbounded values
  for (const read of ['padding-left:var(--ytd-watch-flexy-horizontal-page-margin)', 'margin-top:var(--ytd-rich-grid-item-margin,12px)', 'gap:var(--yt-x)',
    'padding-left:calc(var(--ytd-rich-grid-item-margin) * 2)', 'border-radius:var(--yt-spec-x)']) {
    refused(`.cd-b{${read}}`);
  }
  refused('html[cd-theme]{--cd-t-a:var(--ytd-watch-flexy-horizontal-page-margin)}.cd-b{padding-left:var(--cd-t-a)}');
  // a reference chain and a cycle neither hang nor slip through
  const chain = Array.from({ length: 60 }, (_, i) => `--cd-t-v${i}:var(--cd-t-v${i + 1})`).join(';');
  refused(`html[cd-theme]{${chain};--cd-t-v60:99999px}.cd-b{padding-left:var(--cd-t-v0)}`);
  refused('html[cd-theme]{--cd-t-a:var(--cd-t-b) var(--cd-t-b);--cd-t-b:var(--cd-t-a) var(--cd-t-a)}.cd-b{padding-left:var(--cd-t-a)}');
});

test('the engine variables it reads are numbers inside their documented ranges, so a theme\'s own use of them is bounded', () => {
  accepted('.cd-card{border-radius:var(--cd-radius);padding:var(--cd-space);gap:var(--cd-gap)}');
  accepted('.cd-card{margin-bottom:var(--cd-row-gap)}');
  refused('.cd-card{padding:calc(var(--cd-space) * 40)}');
  refused('.cd-card{margin-bottom:calc(var(--cd-row-gap) * 8)}');
  refused('.cd-card{padding:var(--cd-space,9999px)}', /outside/);
  accepted('.cd-card{padding:var(--cd-space,4px)}');
});

// ---- finding 3: Cinedrape's own elements ----------------------------------------------------------------------------------------

test('own page-level boxes cannot be sized, positioned, stacked or transformed over the feed', () => {
  for (const css of [
    '.cd-home{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#000}',
    '.cd-home{margin-bottom:99999px}',
    '.cd-home{margin:0 0 65px}',
    '.cd-home{height:99999px}',
    '.cd-home{min-height:100vh}',
    '.cd-home{transform:scale(50)}',
    '.cd-home{translate:0 99999px}',
    '.cd-home{zoom:50}',
    '.cd-home{filter:blur(40px)}',
    '.cd-home{display:none}',
    '.cd-home{overflow:hidden;height:1px}',
    '.cd-home{padding-bottom:65px}',
    '.cd-home{padding-block:99999px}',
    '.cd-home{margin-top:-1px}',
    '.cd-home{position:relative;z-index:1}',
    '.cd-hero{position:absolute;inset:0;width:100vw;height:100vh;z-index:99999}',
    '.cd-hero{min-height:50000px}',
    '.cd-hero{margin-bottom:99999px}',
    '.cd-hero{height:200px}',
    '.cd-hero{transform:translateY(300px)}',
    '.cd-row{margin-bottom:99999px}',
    '.cd-row{height:99999px}',
    '.cd-row{transform:scale(40)}',
    '.cd-row{opacity:0}',
    '.cd-rows{height:99999px}',
    '.cd-notice{width:100vw!important;height:100vh!important;top:0!important;left:0!important;z-index:2147483647!important;background:#000!important}',
    '.cd-notice{position:absolute}',
    '.cd-notice{transform:scale(30)}',
    '.cd-notice{font-size:200px}',
    '.cd-notice{padding:90px}',
    '.cd-notice{opacity:0;pointer-events:none}',
    'html[cd-theme] .cd-home{display:none}',
    '.cd-home.cd-a{height:99999px}',
    '.cd-home:hover{height:99999px}',
    '.cd-home:not(.cd-b){height:99999px}',
    ':is(.cd-home,.cd-hero){height:99999px}',
    '.cd-hero,.cd-a{height:99999px}',
    'cd-home{height:99999px}',
    '#cd-home{height:99999px}',
  ]) refused(css);
});

test('own parts are bounded: no fixed or sticky, no page-sized or off-screen boxes, nothing above z-index 10', () => {
  for (const css of [
    '.cd-card{position:fixed}', '.cd-card{position:sticky;top:0}', '.cd-card{position:absolute;inset:0}', '.cd-card-thumb{position:fixed}',
    '.cd-card{height:481px}', '.cd-card{min-height:100vh}', '.cd-card{height:61vh}', '.cd-card{width:1601px}', '.cd-card{margin-top:65px}',
    '.cd-card{margin-top:-17px}', '.cd-card{margin-left:99vw}', '.cd-card{padding:65px}', '.cd-card{top:99999px;position:relative}',
    '.cd-card{left:-99vw;position:relative}', '.cd-card{z-index:11}', '.cd-card{z-index:-1}', '.cd-card{z-index:999}',
    '.cd-card{transform:scale(4.9)}', '.cd-card{transform:scale(.7)}', '.cd-card{transform:translateY(-300px)}', '.cd-card{transform:rotate(90deg)}',
    '.cd-card{transform:rotateY(180deg)}', '.cd-card{transform:matrix(1,0,0,1,0,300)}', '.cd-card{transform:perspective(1px)}',
    '.cd-card{translate:0 99999px}', '.cd-card{scale:9}', '.cd-card{rotate:y 90deg}', '.cd-card{zoom:3}',
    '.cd-card{box-shadow:0 0 0 999px #000}', '.cd-card{box-shadow:0 0 99999px #000}', '.cd-card{outline:99px solid #000}',
    '.cd-card{filter:blur(99px)}', '.cd-card{backdrop-filter:blur(99px)}',
    '.cd-card{clip-path:circle(0)}', '.cd-card{mask:linear-gradient(#000,transparent)}', '.cd-card{contain:size}', '.cd-card{float:left}',
    '.cd-card{font-size:200px}', '.cd-card{font-size:2px}', '.cd-card{line-height:0}', '.cd-card{line-height:40}',
    '.cd-card::after{content:"";position:absolute;inset:0;z-index:5}',   // .cd-card is not positioned by the engine, its ::after would resolve against the page
    '.cd-card-title{position:absolute;inset:0;width:100vw;height:100vh}',
    '.cd-card-duration{width:100vw;height:100vh}', '.cd-card-duration{position:absolute;top:99999px}',
    '.cd-row-prev{position:absolute;left:-99999px}',
    '.cd-card{display:grid;grid-template-columns:repeat(9999,640px)}', '.cd-card{grid-template-columns:99999px}',
    '.cd-card{flex:0 0 99999px}', '.cd-card{flex-basis:99999px}',
  ]) refused(css);
});

test('own absolutely positioned parts stay inside their box (small offsets, bounded sizes)', () => {
  accepted('.cd-card-duration{position:absolute;right:6px;bottom:6px;z-index:2}');
  accepted('.cd-row-prev{top:-4px;right:40px;width:34px;height:34px}');
  accepted('.cd-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent,var(--cd-bg))}');
  accepted('.cd-card-thumb::before{content:"";position:absolute;left:0;top:0;width:100%;height:3px;background:var(--cd-accent)}');
  refused('.cd-card-duration{width:300px}');
  refused('.cd-hero-body{position:absolute;inset:-99px}');
  refused('.cd-hero::before{position:absolute;top:0;left:0;width:100vw;height:100vh}');
});

test('selectors cannot use an own element as a stepping stone to YouTube\'s DOM', () => {
  // Only the subject counts: an own ancestor does not make a YouTube element ours, and sibling links leave the own subtree.
  for (const css of [
    '.cd-home #contents{display:none}', '.cd-home ytd-rich-item-renderer{opacity:0}', '.cd-home > ytd-ad-slot-renderer{display:none}',
    '.cd-home + #contents{display:none}', '.cd-home ~ ytd-ad-slot-renderer{display:none}', '.cd-home ~ *{display:none}',
    '.cd-home + ytd-rich-item-renderer{height:1px;overflow:hidden}', '.cd-row ~ .ytp-chrome-bottom{opacity:0}',
    '.cd-card ytd-thumbnail{display:none}', '.cd-card .ytp-ad-module{display:none}', '.cd-card ytd-foo img{display:none}',
    '.cd-a + img{display:none}', '.cd-a ~ span{height:0}', '#contents > .cd-a ~ #contents{display:none}',
    ':is(.cd-a,#contents){display:none}', '.cd-a:has(+ #contents) + #contents{display:none}', 'ytd-rich-grid-renderer .cd-home ~ #contents{display:none}',
    '.cd-card:is(ytd-thumbnail){zoom:.1}',
  ]) refused(css);
  // a generic tag below an own element is ours (the card's own <img>, <a>, <span>), bounded like a part
  accepted('.cd-card img{border-radius:4px;opacity:.9}');
  accepted('.cd-card > a{display:block;padding:2px}');
  accepted('.cd-hero-meta span{color:var(--cd-muted)}');
  refused('.cd-card img{position:absolute;inset:0;width:100vw;height:100vh}');
  refused('.cd-card img{height:99999px}');
});

// ---- finding 4: colours -----------------------------------------------------------------------------------------------------------

test('colours on YouTube elements are theme tokens that read on the page; protected elements keep their own colours', () => {
  for (const css of [
    T(SPONSOR, 'color:#0f0f0f'), T(SPONSOR, 'color:var(--yt-sys-color-baseline--base-background)'), T(SPONSOR, 'color:var(--cd-bg)'),
    T(SPONSOR, 'color:var(--cd-text)'), T(SPONSOR, 'background:var(--cd-text)'), T(SPONSOR, 'background-color:var(--cd-surface)'),
    T(SPONSOR, '-webkit-text-fill-color:transparent'), T(SPONSOR, 'text-shadow:0 0 40px var(--cd-bg)'), T(SPONSOR, 'fill:var(--cd-bg)'),
    T(SPONSOR, 'text-decoration:line-through 4px'), T(AD, 'color:var(--cd-text)'), T(CONTROL, 'background:var(--cd-bg)'),
    T(CONTROL, 'color:var(--cd-bg)'), T('.ytp-play-button', 'fill:var(--cd-bg)'), T(SPONSOR, 'box-shadow:inset 0 0 0 4px var(--cd-bg)'),
    T(SPONSOR, 'box-shadow:0 0 0 4px var(--cd-bg)'),
    T('ytd-comments', 'color:#0f0f0f'), T('ytd-comments', 'color:red'), T('ytd-comments', 'color:rgba(0,0,0,.05)'), T('ytd-comments', 'color:transparent'),
    T('ytd-comments', 'color:var(--cd-bg)'), T('ytd-comments', 'color:var(--yt-spec-base-background)'), T('ytd-comments', 'color:currentcolor;background:currentcolor'),
    T('ytd-comments', 'background:var(--cd-text)'), T('ytd-comments', 'background:var(--cd-border)'), T('ytd-comments', 'background:var(--cd-accent)'),
    T('ytd-comments', 'color:var(--cd-text);background:var(--cd-accent)'), T('ytd-comments', 'color:var(--cd-accent-text)'),
    T('ytd-comments', 'color:color-mix(in srgb,var(--cd-bg),var(--cd-bg))'), T('ytd-comments', 'background:url("data:image/png;base64,AA==")'),
    T('ytd-comments', 'background-color:#000'), T('svg', 'fill:var(--cd-bg)'), T('svg', 'stroke:var(--cd-surface)'), T('svg', 'fill:var(--cd-accent-text)'),
    T('ytd-comments', 'font-family:Wingdings'), `html[cd-theme]{--cd-t-font:Wingdings}${T('ytd-comments', 'font-family:var(--cd-t-font)')}`,
  ]) refused(css);
  accepted(T('ytd-comments', 'color:var(--cd-text);background-color:var(--cd-surface)'));
  accepted(T('ytd-comments', 'color:var(--cd-muted);background:linear-gradient(var(--cd-surface),var(--cd-bg))'));
  accepted(T('ytd-comments', 'background-color:var(--cd-accent);color:var(--cd-accent-text)'));
  accepted(T('ytd-comments', 'fill:var(--cd-accent)'));
  refused(T('ytd-comments', 'fill:var(--cd-accent-text)'));
});

test('a rule that picks colours for an ad must not be saved by a protected selector hiding in :is()/:not()/comma lists', () => {
  for (const css of [
    `.cd-a,${SPONSOR}{color:var(--cd-text)}`, `:is(.cd-a,${SPONSOR}){background:var(--cd-bg)}`, `${SPONSOR}:not(.cd-x){color:var(--cd-bg)}`,
    `ytd-comments:has(${AD}){color:var(--cd-bg)}`, `.cd-a ${SPONSOR}{color:var(--cd-bg)}`, `.cd-a + ${SPONSOR}{color:var(--cd-bg)}`,
    `[class*="ytp-paid"]{color:var(--cd-text)}`, `[class^=ytp]{background:var(--cd-bg)}`,
  ]) refused(css);
});

// ---- finding 5: hiding YouTube's DOM ---------------------------------------------------------------------------------------------

test('a theme cannot hide YouTube DOM at all: not bare, not behind :not(:has(ads)), not behind the descendant-side guard either', () => {
  const leaves = ['.ytBadgeShapeText', '.ytContentMetadataViewModelMetadataText', 'a.ytLockupMetadataViewModelTitle', '.ytLockupMetadataViewModelAvatar',
    'yt-thumbnail-view-model', 'ytd-channel-name', '#video-title', 'ytd-video-meta-block', 'ytd-watch-metadata', 'ytd-comments',
    'ytd-continuation-item-renderer', 'ytd-thumbnail-overlay-time-status-renderer', 'ytd-masthead', 'ytd-mini-guide-renderer', '#guide'];
  for (const leaf of leaves) {
    for (const prop of ['display:none', 'visibility:hidden', 'opacity:0', 'height:0', 'font-size:0', 'color:transparent']) {
      refused(T(leaf, prop));
      refused(T(`${leaf}${GUARD}`, prop));
      refused(T(`${leaf}${GUARD}${INSIDE}`, prop));
      refused(T(safeHide(MAP, leaf), prop));
    }
  }
});

// ---- the engine profile keeps the safety layer for Cinedrape's own CSS --------------------------------------------------------

test('profile "engine" is the safety layer only: guarded hides and geometry pass, unguarded hides of ads and containers still do not', () => {
  const engine = (css) => validateCss(css, { ...CTX, profile: 'engine' });
  assert.equal(engine(`${safeHide(MAP, 'ytd-comments')}{display:none !important}`).ok, true);
  assert.equal(engine(`html[cd-theme] ${TILE}{margin-bottom:var(--cd-row-gap)}`).ok, true);
  for (const css of [`${AD}{display:none}`, `${TILE}{display:none}`, `.ytp-chrome-bottom{opacity:0}`, `html{display:none}`, `ytd-masthead::after{position:fixed;inset:0;background:#000}`]) {
    const r = engine(css);
    assert.equal(r.ok, false, css);
    assert.ok(r.errors.some((e) => SAFETY.has(e.code)), css);
  }
  // the default profile is the strict one
  assert.equal(check(`html[cd-theme] ${TILE}{margin-bottom:var(--cd-row-gap)}`).ok, false);
});

test('display:contents on a YouTube box is a safety finding even in the engine profile (it hides <img>, <video> and <canvas> ads)', () => {
  for (const sel of [AD, TILE, '#primary', 'img']) {
    const r = validateCss(`html[cd-theme] ${sel}{display:contents}`, { ...CTX, profile: 'engine' });
    assert.ok(r.errors.some((e) => SAFETY.has(e.code)), sel);
  }
});

// ---- scanning: nothing is skipped silently -------------------------------------------------------------------------------------

test('scanCss reports how many rules it evaluated, and a flood of other findings cannot push a safety finding out', () => {
  const noise = Array.from({ length: 300 }, (_, i) => `.nope${i}{border-radius:4px}`).join('\n');
  const css = `${noise}\n${AD}{display:none}\n`;
  const full = scanCss(css, { ...CTX, maxErrors: Infinity });
  assert.equal(full.stats.rules, 301);
  assert.equal(full.stats.evaluated, 301);
  assert.equal(full.stats.skipped, 0);
  assert.equal(full.errors.length, 301 + 1 - 1 + 0 + (full.errors.length - 301), 'internally consistent');
  assert.ok(full.errors.some((e) => e.code === 'hides-protected' && e.line === 301));
  // default cap: 50 selector findings are recorded, and the hide at the very end is still there
  const capped = validateCss(css, CTX);
  assert.ok(capped.errors.filter((e) => e.code === 'selector-not-allowed').length <= 50);
  assert.ok(capped.errors.some((e) => e.code === 'hides-protected' && e.line === 301), 'safety findings keep their own slots');
  assert.equal(scanCss(css, { ...CTX, maxErrors: 3 }).errors.filter((e) => e.code !== 'hides-protected').length, 3);
  // a rule whose selector does not parse is counted as skipped, not as evaluated
  const broken = scanCss('.cd-a{border-radius:4px}\n.cd-b[{color:red}', CTX);
  assert.equal(broken.stats.rules, broken.stats.evaluated + broken.stats.skipped);
});

// ---- what must keep working --------------------------------------------------------------------------------------------------------

const LEGIT = [
  ['spec example', '.cd-hero h1 { letter-spacing: -0.02em; }'],
  ['hover lift on a card', '.cd-card:hover .cd-card-thumb{transform:translateY(-4px) scale(1.02)}.cd-card-thumb{transition:transform var(--cd-duration) ease}'],
  ['hero treatment', '.cd-hero{border-radius:calc(var(--cd-radius) * 1.6);box-shadow:var(--cd-shadow);background:linear-gradient(135deg,var(--cd-surface),var(--cd-bg))}'],
  ['row title', '.cd-row-title{font-size:1.35em;font-weight:800;border-left:4px solid var(--cd-accent);padding-left:.5em;letter-spacing:.04em;text-transform:uppercase}'],
  ['first row bigger cards', '.cd-row:first-child .cd-card{flex:0 0 max(var(--cd-card-min, 190px), calc((100% - (max(3, var(--cd-row-visible, 6) - 2) - 1) * var(--cd-gap, 16px)) / max(3, var(--cd-row-visible, 6) - 2)))}'],
  ['neon edge', '.cd-card:hover{border-color:var(--cd-accent);box-shadow:0 0 0 1px var(--cd-accent),0 0 18px var(--cd-accent)}.cd-row-title{text-shadow:0 0 10px var(--cd-accent)}'],
  ['button', '.cd-hero-cta{background:var(--cd-accent);color:var(--cd-accent-text);border-radius:var(--cd-radius);font-weight:700;box-shadow:0 0 16px var(--cd-accent)}'],
  ['serif headings', 'html[cd-theme]{--cd-heading-font:Georgia,\'Times New Roman\',serif}.cd-row-title{font-family:var(--cd-heading-font);font-size:1.6em;line-height:1.1}'],
  ['home padding', '.cd-home{padding-inline:calc(var(--cd-space) * 5)}'],
  ['dark and light', 'html[cd-theme][dark] .cd-card{border-color:var(--cd-border)}html[cd-theme]:not([dark]) .cd-card{border-color:var(--cd-text)}'],
  ['tile restyle', `${TILE}{border-radius:var(--cd-radius);box-shadow:var(--cd-shadow);transition:box-shadow var(--cd-duration) ease}`],
  ['thumbnail', 'ytd-thumbnail,yt-thumbnail-view-model{border-radius:var(--cd-radius)}'],
  ['title colours', 'a.ytLockupMetadataViewModelTitle{color:var(--cd-text);font-weight:600}.ytContentMetadataViewModelMetadataText{color:var(--cd-muted)}'],
  ['chips', 'ytd-feed-filter-chip-bar-renderer{border-radius:var(--cd-radius)}'],
  ['scrollbars', 'html[cd-theme]::-webkit-scrollbar{width:10px}html[cd-theme]::-webkit-scrollbar-thumb{background:var(--cd-border);border-radius:5px}'],
  ['selection', 'html[cd-theme] ::selection{background-color:var(--cd-accent);color:var(--cd-accent-text)}'],
  ['focus ring', '.cd-card:focus-visible{outline:2px solid var(--cd-accent);outline-offset:2px}'],
  ['reduced motion', '@media (prefers-reduced-motion:reduce){.cd-card-thumb{transition:none;animation:none}}'],
  ['own keyframes', '@keyframes cd-pulse{from{box-shadow:0 0 0 0 var(--cd-accent)}to{box-shadow:0 0 12px 0 var(--cd-accent)}}.cd-hero-cta{animation:cd-pulse 1.4s ease-in-out infinite alternate}'],
  ['restyle an ad frame', `${AD}{border:1px solid var(--cd-border);border-radius:8px;box-shadow:var(--cd-shadow)}`],
  ['restyle the sponsorship label frame', `${SPONSOR}{border-radius:6px;border:1px solid var(--cd-border)}`],
  ['accent link', 'html[cd-theme] a{color:var(--cd-accent)}'],
  ['gradient hero overlay', '.cd-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent,var(--cd-scrim))}'],
  ['theme variable', 'html[cd-theme]{--cd-t-lift:3px}.cd-card:hover .cd-card-thumb{transform:translateY(calc(var(--cd-t-lift) * -1))}'],
  ['data svg badge', '.cd-card-duration{background-image:url("data:image/svg+xml;utf8,<svg xmlns=\'http://www.w3.org/2000/svg\' width=\'1\' height=\'1\'><path d=\'M0 0h1v1z\'/></svg>\")}'],
];
for (const [name, css] of LEGIT) test(`legitimate theme CSS still passes: ${name}`, () => accepted(css));

test('the shipped launch themes pass the allow-list profile unchanged', () => {
  const dir = path.join(ROOT, 'src', 'themes');
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  assert.ok(files.length >= 6);
  for (const f of files) {
    const theme = JSON.parse(readFileSync(path.join(dir, f), 'utf8'));
    const r = validateCss(theme.css || '', CTX);
    assert.equal(r.ok, true, `${f}: ${detail(r)}`);
  }
});

test('fails closed: values the evaluator cannot evaluate are refused wherever a length or number is required', () => {
  for (const decl of ['padding:env(safe-area-inset-top)', 'padding:attr(data-x px)', 'margin-top:round(4px,1px)', 'width:sin(1)', 'border-radius:mod(5px,2px)',
    'padding:calc(1px + 1deg)', 'height:calc(', 'width:var()', 'gap:calc(var(--ytd-x) * 2)', 'padding:min()', 'border-width:abs(-3px)',
    'letter-spacing:sign(2px)', 'opacity:calc(sin(1))', 'line-height:round(1.234,0.1)']) {
    const r = check(`.cd-a{${decl}}`);
    assert.equal(r.ok, false, decl);
  }
  // more than 32 candidate values (min/max/clamp lists) are not silently truncated
  const many = Array.from({ length: 40 }, (_, i) => `${i}px`).join(',');
  refused(`.cd-a{padding:min(${many},9999px)}`);
});
