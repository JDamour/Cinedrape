// Tests for src/shared/css-validator.js (owner: css-validator). ARCHITECTURE.md section 4 and section 6.
//
// The part that matters most is the ad-safety corpus: every trick we could think of for hiding, collapsing, moving, fading,
// covering or disabling an ad, a sponsorship label, a player control or an element that can hold one must be refused, whether
// the declaration is written with CSS escapes, comments, odd case, vendor prefixes, !important, inside @media/@supports, through
// var() or through @keyframes; while ordinary theme CSS (including restyling those same elements) must still pass.
// Real data throughout: src/data/selector-map.source.json for the allow-list and test/helpers/dom.js pages for jsdom checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateCss, buildAllowList, describeHiding, parseSelectorString } from '../../src/shared/css-validator.js';
import { safeHide } from '../../src/shared/selector-map.js';
import { LIMITS } from '../../src/shared/constants.js';
import { createPage } from '../helpers/dom.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const MAP = JSON.parse(readFileSync(path.join(ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
const ALLOW = buildAllowList(MAP);
const PROTECTED = [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls];
const CTX = { allowList: ALLOW, protectedSelectors: PROTECTED };
const ADS_CSS = MAP.protected.ads.join(', ');
const GUARD = `:not(:has(${ADS_CSS}))`;
const SAFETY_CODES = new Set(['hides-protected', 'hides-container', 'covers-page']);
// The engine's own composed CSS legitimately styles YouTube geometry and uses guarded hides; it is scanned with the safety layer only.
const ENGINE = { ...CTX, profile: 'engine' };
const PROFILE_CODES = new Set(['property-not-allowed', 'value-not-allowed', 'custom-property']);

const check = (css, ctx = CTX) => validateCss(css, ctx);
const messages = (r) => r.errors.map((e) => e.message).join('\n');
const accepted = (css, ctx = CTX) => {
  const r = check(css, ctx);
  assert.equal(r.ok, true, `expected to pass: ${css.slice(0, 200)}\n${JSON.stringify(r.errors)}`);
  assert.deepEqual(r.errors, []);
};
const refused = (css, pattern, ctx = CTX) => {
  const r = check(css, ctx);
  assert.equal(r.ok, false, `expected to be refused: ${css.slice(0, 200)}`);
  assert.ok(r.errors.length > 0);
  if (pattern) assert.match(messages(r), pattern, css.slice(0, 200));
  return r;
};
/** Refused by the theme allow-list profile (property or value outside what a theme may do). */
const refusedByProfile = (css, pattern, ctx = CTX) => {
  const r = refused(css, pattern, ctx);
  assert.ok(r.errors.some((e) => PROFILE_CODES.has(e.code)), `refused for the wrong reason: ${css.slice(0, 200)}\n${JSON.stringify(r.errors)}`);
  return r;
};
/** Refused because of the ad-safety rules (not merely because of a syntax or allow-list error). */
const refusedForSafety = (css, ctx = CTX) => {
  const r = refused(css, undefined, ctx);
  assert.ok(r.errors.some((e) => SAFETY_CODES.has(e.code)), `refused for the wrong reason: ${css.slice(0, 200)}\n${JSON.stringify(r.errors)}`);
  return r;
};

// ---- API and result shape --------------------------------------------------------------------------------------------------

test('validateCss returns {ok, errors}; buildAllowList returns a frozen allow-list built from the map', () => {
  const r = check('.cd-a{border-radius:4px}');
  assert.deepEqual(Object.keys(r).sort(), ['errors', 'ok']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.errors, []);
  assert.ok(Object.isFrozen(ALLOW));
  for (const [set, member] of [['classes', 'ytp-ad-module'], ['classes', 'ytLockupViewModelContentImage'], ['ids', 'masthead-ad'], ['ids', 'movie_player'],
    ['tags', 'ytd-rich-item-renderer'], ['tags', 'yt-lockup-view-model'], ['attributes', 'page-subtype'], ['attributes', 'class'], ['attributes', 'target-id']]) {
    assert.ok(ALLOW[set] instanceof Set && ALLOW[set].has(member), `${set} should contain ${member}`);
  }
  assert.ok(!ALLOW.classes.has('cd-card'), 'cd- names are always allowed, they do not need to be listed');
});

test('errors are {line, column, message, text, code} with 1-based positions; text is "Line N: message"', () => {
  const r = refused('.cd-a{border-radius:4px}\n\n@import url(x);\n');
  assert.equal(r.errors.length, 1);
  const [e] = r.errors;
  assert.deepEqual(Object.keys(e).sort(), ['code', 'column', 'line', 'message', 'text']);
  assert.equal(e.line, 3);
  assert.equal(e.column, 1);
  assert.equal(e.message, '@import is not allowed');
  assert.equal(e.text, 'Line 3: @import is not allowed');
  assert.equal(e.code, 'at-rule');
});

test('empty and comment-only CSS is fine', () => {
  for (const css of ['', '   ', '\n\n', '/* nothing */', '/* a */ /* b */']) accepted(css);
});

test('non-string input is an error, never an exception', () => {
  for (const bad of [undefined, null, 0, 42, true, {}, [], ['.cd-a{}'], () => '', Symbol('x'), 10n, new String('.cd-a{}'), { toString() { throw new Error('boom'); } }]) {
    const r = check(bad);
    assert.equal(r.ok, false, String(typeof bad));
    assert.equal(r.errors[0].line, 1);
    assert.match(r.errors[0].message, /must be a string/);
  }
});

test('a hostile or missing context never throws: no ctx, junk ctx, junk allow-list, throwing getters', () => {
  const evil = new Proxy({}, { get() { throw new Error('hostile getter'); }, has() { throw new Error('hostile has'); } });
  const ctxs = [undefined, null, 0, 'x', [], {}, { allowList: null }, { allowList: 'x' }, { allowList: 42 }, { allowList: [] }, { allowList: new Set(['.a']) },
    { allowList: { classes: 7, tags: null } }, { protectedSelectors: 'nope' }, { protectedSelectors: [1, null, {}, '.x', '{']},
    { maxBytes: 'x' }, { maxBytes: -5 }, { maxBytes: NaN }, { allowList: evil }, { protectedSelectors: evil }, evil];
  for (const ctx of ctxs) {
    const r = validateCss('.cd-a{border-radius:4px}', ctx);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.errors));
    if (ctx === evil || (ctx && ctx.allowList === evil) || (ctx && ctx.protectedSelectors === evil)) continue;
    assert.equal(r.ok, true, `cd- only CSS passes with ctx ${JSON.stringify(ctx)}`);
  }
});

test('without an allow-list only cd- names are allowed; with list-like allow-lists the listed names are added', () => {
  refused('.foo{border-radius:4px}', /\.foo/, {});
  refused('ytd-app{border-radius:4px}', /ytd-app/, {});
  accepted('.cd-a .cd-b > cd-c{border-radius:4px}', {});
  accepted('.foo{border-radius:4px}', { allowList: { classes: ['foo'] } });
  accepted('.foo{border-radius:4px}', { allowList: { classes: new Set(['.foo']) } });
  accepted('.foo{border-radius:4px}', { allowList: ['.foo'] });
  accepted('ytd-thing[page-subtype="x"]{border-radius:4px}', { allowList: new Set(['ytd-thing[page-subtype]']) });
});

test('parseSelectorString (shared with selector-map.js) parses one or many selectors and reports errors', () => {
  assert.equal(parseSelectorString('a > b, c').list.length, 2);
  assert.equal(parseSelectorString(':not(:has(a, b))').list.length, 1);
  for (const bad of ['a >', '', ',', 'a{', 'a::', '[', 'a:foo(x)', 42, null]) {
    const r = parseSelectorString(bad);
    assert.equal(r.list, null, String(bad));
    assert.ok(r.errors.length > 0);
  }
});

// ---- ordinary theme CSS must pass -------------------------------------------------------------------------------------------

const LEGIT = [
  ['spec example', '.cd-hero h1 { letter-spacing: -0.02em; }'],
  ['no spaces', '.cd-hero h1{letter-spacing:-.02em}'],
  ['root scoped var()', 'html[cd-theme] ytd-rich-item-renderer{border-radius:var(--cd-radius)}'],
  ['dark / light variants', 'html[cd-theme][dark] .cd-card{border-radius:4px} html[cd-theme]:not([dark]) .cd-card{color:blue}'],
  ['hover lift', '.cd-card:hover .cd-card-thumb{transform:translateY(-4px) scale(1.02)}'],
  ['flex row', '.cd-row-track{display:flex;gap:var(--cd-gap);overflow-x:auto}'],
  ['theme colours on YouTube text', 'ytd-comments{color:var(--cd-text)}html[cd-theme] a{color:var(--cd-accent)}ytd-video-meta-block{color:var(--cd-muted)}'],
  ['accent label on the accent colour', 'ytd-comments{background-color:var(--cd-accent);color:var(--cd-accent-text)}'],
  ['selector list and combinators', '.cd-a,.cd-b>.cd-c+.cd-d~.cd-e .cd-f{border-radius:4px}'],
  ['pseudo-elements and content', '.cd-card::after{content:"";display:block}'],
  ['short content', '.cd-card::before{content:"New"}'],
  ['structural pseudo-classes', '.cd-row:first-child .cd-row-title:nth-child(2n+1):not(:last-child){font-size:1.2em}'],
  ['gradient background', '.cd-hero{background:linear-gradient(135deg,var(--cd-surface),var(--cd-bg));border-radius:calc(var(--cd-radius) * 1.6)}'],
  ['data: png', '.cd-card{background:url("data:image/png;base64,iVBORw0KGgo=")}'],
  ['data: svg', ".cd-card{background:url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'><path d='M0 0h1v1z'/></svg>\")}"],
  ['font longhands', '.cd-card{font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:14px;line-height:1.2}'],
  ['animation of our own keyframes', '@keyframes cd-fade{from{opacity:0}to{opacity:1}}.cd-card{animation:cd-fade .3s ease both}'],
  ['media query', '@media (min-width:1200px){.cd-hero-media{min-height:40vh}}'],
  ['reduced motion', '@media (prefers-reduced-motion:reduce){.cd-card{transition:none;animation:none}}'],
  ['supports', '@supports (backdrop-filter:blur(4px)){.cd-hero-body{backdrop-filter:blur(4px)}}'],
  ['layer and container', '@layer base, theme;@layer theme{.cd-a{border-radius:4px}}@container (min-width:400px){.cd-a{border-radius:4px}}'],
  ['custom properties', 'html[cd-theme]{--cd-heading-font:Georgia,\'Times New Roman\',serif}.cd-a{--cd-t-gap:calc(var(--cd-space) * 3);padding-left:var(--cd-t-gap)}'],
  ['comments everywhere', '/* c */.cd-a/* c */{/* c */color/* c */:/* c */red/* c */;/* c */}/* c */'],
  ['own element hidden', '.cd-card img{display:none}.cd-hero-meta{opacity:.6}.cd-row-prev{visibility:hidden}'],
  ['own element positioned and layered', '.cd-card-duration{position:absolute;bottom:4px;right:4px;z-index:2;pointer-events:none}'],
  ['own element with zero size', '.cd-spacer{width:0;height:0;overflow:hidden}'],
  ['own element faded and blurred', '.cd-hero::after{backdrop-filter:blur(8px);opacity:.5}'],
  ['own scrollbars hidden', '.cd-row-track::-webkit-scrollbar{display:none;width:0;height:0}'],
  ['page scrollbars restyled', 'html[cd-theme]::-webkit-scrollbar{display:none}html[cd-theme]::-webkit-scrollbar-thumb{background:var(--cd-border)}'],
  ['a YouTube element restyled', 'ytd-comments{border:1px solid var(--cd-border)}ytd-watch-metadata{border-radius:8px}'],
  ['restyle a tile (a container) without hiding', 'ytd-rich-item-renderer{border-radius:var(--cd-radius);box-shadow:var(--cd-shadow);transition:box-shadow .2s}'],
  ['restyle a tile on hover', 'ytd-rich-item-renderer:hover{box-shadow:0 8px 24px rgba(0,0,0,.4)}'],
  ['round a thumbnail', 'ytd-thumbnail{border-radius:12px}'],
  ['restyle an ad (border and radius; its colours stay its own)', 'ytd-ad-slot-renderer{border:1px solid var(--cd-border);border-radius:8px;box-shadow:var(--cd-shadow)}'],
  ['restyle the sponsorship label (border and radius only)', '.ytp-paid-content-overlay{border:1px solid var(--cd-border);border-radius:4px}'],
  ['restyle player controls (border, outline, radius)', '.ytp-chrome-bottom{border-radius:4px}.ytp-play-button{outline:2px solid var(--cd-accent);outline-offset:1px}'],
  ['restyle the masthead ad slot', '#masthead-ad{border:1px solid var(--cd-border);border-radius:4px}'],
  ['min-width 0 on our own grid child', '.cd-card{min-width:0}'],
  ['filter that does not obscure', '.cd-card-thumb{filter:grayscale(1)}.cd-card{filter:drop-shadow(0 2px 4px rgba(0,0,0,.3)) brightness(1.1)}'],
  ['semi-transparent border colours', '.cd-card{border-color:rgba(255,255,255,.2)}'],
  ['important and vendor prefixes', '.cd-card{-webkit-transition:none !important;color:red!important}'],
  ['attribute selectors from the map', 'ytd-browse[page-subtype="home"] .cd-home{padding-top:8px}'],
  ['escaped selector characters', '.cd-a\\:b{border-radius:4px}#cd-\\31 23{border-radius:4px}'],
  ['CRLF line endings', '.cd-a{\r\n  color: red;\r\n}\r\n.cd-b{color:blue}\r\n'],
];
for (const [name, css] of LEGIT) test(`legitimate theme CSS passes: ${name}`, () => accepted(css));

test('every role selector of the real map can be restyled (theme colours, radius), and so can every protected one (border and radius only)', () => {
  let n = 0;
  for (const section of [MAP.roles, MAP.protected, MAP.tileFields]) {
    for (const [group, list] of Object.entries(section)) {
      for (const sel of list) {
        // Colours are theme tokens; an element that is protected (an ad, a sponsorship label, a control) keeps its own colours.
        // (protected.containers only HOLD ads: they are restyled like any role.)
        if (section === MAP.protected && group !== 'containers') {
          accepted(`${sel}{border:1px solid var(--cd-border);border-radius:4px}`);
          refusedByProfile(`${sel}{color:var(--cd-text)}`);
          refusedByProfile(`${sel}{background-color:var(--cd-bg)}`);
        } else {
          accepted(`${sel}{color:var(--cd-text);border-radius:4px}`);
        }
        n++;
      }
    }
  }
  assert.ok(n > 250, `checked ${n} selectors`);
});

const THEMES_DIR = path.join(ROOT, 'src', 'themes');
test('the launch themes shipped in src/themes pass the validator', (t) => {
  if (!existsSync(THEMES_DIR)) { t.skip('src/themes does not exist yet'); return; }
  const files = readdirSync(THEMES_DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) { t.skip('no theme files yet'); return; }
  for (const f of files) {
    const theme = JSON.parse(readFileSync(path.join(THEMES_DIR, f), 'utf8'));
    if (typeof theme.css === 'string' && theme.css) accepted(theme.css);
  }
});

// ---- syntax: well-formed and malformed ---------------------------------------------------------------------------------------

const WELL_FORMED = [
  ['empty rule', '.cd-a{}'],
  ['stray semicolons in a block', '.cd-a{;;color:red;;}'],
  ['no trailing semicolon', '.cd-a{border-radius:4px}.cd-b{color:blue}'],
  ['spaces around colon and semicolon', '.cd-a { color : red ; background : blue }'],
  ['comments between tokens', '.cd-a{color:red /* c */ ;/* d */background:blue}'],
  ['braces inside strings', '.cd-a{content:"}{;/*"}'],
  ['escaped quote in a string', '.cd-a{content:"say \\"hi\\""}'],
  ['semicolon and brace inside a quoted name', '.cd-a{--cd-t-font:"A;B}",serif}'],
  ['bracket inside attribute string', '.cd-a[cd-x="]{"]{border-radius:4px}'],
  ['backslash-newline inside a string', '.cd-a{content:"a\\\nb"}'],
  ['form feed and lone CR line breaks', '.cd-a{border-radius:4px}\f.cd-b{color:blue}\r.cd-c{color:green}'],
  ['nested at-rules', '@media screen{@media (min-width:1px){@supports (display:grid){.cd-a{border-radius:4px}}}}'],
  ['keyframes with percentages', '@keyframes cd-pulse{0%,50%{opacity:1}100%{opacity:1}}'],
  ['vendor keyframes', '@-webkit-keyframes cd-spin{from{opacity:1}}'],
  ['keyframes with a quoted name', '@keyframes "cd-x"{to{border-radius:4px}}'],
  ['hex escapes in identifiers', '.cd-\\31 0{border-radius:4px}'],
  ['numbers with exponents and signs', '.cd-a{margin:+1px -1.5e1px .5em;line-height:1E0}'],
  ['unicode in strings', '.cd-a{content:"é 😀"}'],
  ['calc and min/max/clamp', '.cd-a{width:calc(100% - (2 * var(--cd-gap, 8px)));height:clamp(10px,5vw,40px);padding:max(4px,1vw)}'],
  ['grid tracks', '.cd-a{grid-template-columns:repeat(auto-fill,minmax(0,1fr))}'],
  ['flex shorthand that grows', '.cd-a{flex:1 1 0}'],
  ['values that undo things', '.cd-a{transform:none;filter:none;pointer-events:auto;opacity:1;visibility:visible}'],
  ['empty custom property', '.cd-a{--cd-t-x:;color:red}'],
  ['uppercase property and value', '.cd-a{COLOR:RED;Background:URL("data:image/png;base64,AA==")}'],
];
for (const [name, css] of WELL_FORMED) test(`well-formed CSS parses: ${name}`, () => accepted(css));

const MALFORMED = [
  ['unclosed block', '.cd-a{color:red', /Unclosed/],
  ['stray closing brace', '.cd-a{border-radius:4px}}', /Unexpected '\}'/],
  ['unclosed second block', '.cd-a{border-radius:4px}{', /Unclosed/],
  ['stray closing paren', '.cd-a{width:calc(1px))}', /Unexpected '\)'/],
  ['mismatched brackets', '.cd-a{width:calc(1px]}', /Expected '\)'/],
  ['unterminated string', '.cd-a{color:"red}', /Unterminated string/],
  ['string with a line break', '.cd-a{content:"a\nb"}', /Unterminated string/],
  ['unterminated comment', '.cd-a{border-radius:4px}/* x', /Unterminated comment/],
  ['declaration without a colon', '.cd-a{color}', /Expected ":"/],
  ['declaration without a name', '.cd-a{:red}', /property name/],
  ['numeric property name', '.cd-a{5px:red}', /property name/],
  ['declaration without a value', '.cd-a{color:}', /no value/],
  ['rule without a selector', '{border-radius:4px}', /Empty selector/],
  ['selector without a block', '.cd-a;', /Expected "\{"/],
  ['selector at EOF without a block', '.cd-a', /Expected "\{"/],
  ['top-level semicolon', ';', /Unexpected ";"/],
  ['a comment splitting a property name', '.cd-a{col/**/or:red}', /splitting/],
  ['nested rule', '.cd-a{color:red;.cd-b{color:blue}}', /Nested rules/],
  ['nesting with &', '.cd-a{&:hover{color:blue}}', /Nested rules/],
  ['at-rule inside a declaration block', '.cd-a{@media (min-width:1px){border-radius:4px}}', /Nested rules/],
  ['brace block as a custom property value', '.cd-a{--x:{a:b}}', /Nested rules|Unexpected "\{"/],
  ['HTML comment tokens', '.cd-a{border-radius:4px}<!-- .cd-b{color:blue} -->', /not allowed/],
  ['bang without important', '.cd-a{color:red !}', /Unexpected "!"/],
  ['misspelt important', '.cd-a{color:red !import}', /Unexpected "!"/],
  ['closing style tag', '.cd-a{border-radius:4px}</style><script>alert(1)</script>', /<\/style/],
  ['NUL character', '.cd-a{border-radius:4px}\u0000', /NUL/],
  ['bidirectional override in a string', '.cd-a{content:"‮"}', /Bidirectional/],
  ['at-rule without its block', '@media screen', /needs a/],
  ['at-rule with a semicolon instead of a block', '@media screen;', /needs a/],
  ['keyframes without its block', '@keyframes cd-x', /needs a/],
  ['keyframes without a name', '@keyframes{}', /exactly one name/],
  ['bogus keyframe selector', '@keyframes cd-x{from{border-radius:4px}bogus{border-radius:4px}}', /keyframe selector/],
  ['percent-like keyframe selector', '@keyframes cd-x{x%{border-radius:4px}}', /keyframe selector/],
  ['bad url token', '.cd-a{background:url(a b)}', /Malformed url/],
  ['unterminated url', '.cd-a{background:url(abc', /Unterminated url|Unclosed/],
  ['lone backslash', '.cd-a{border-radius:4px}\\\n', /Invalid escape/],
];
for (const [name, css, re] of MALFORMED) test(`malformed CSS is refused: ${name}`, () => refused(css, re));

const SELECTOR_SYNTAX_OK = ['.cd-a:nth-child(2n+1)', '.cd-a:nth-child(-n + 3)', '.cd-a:nth-child(odd)', '.cd-a:nth-child(2n+1 of .cd-b)', '.cd-a:nth-last-child(1)',
  '.cd-a:nth-of-type(2)', '.cd-a:not(.cd-b, .cd-c)', '.cd-a:is(.cd-b, .cd-c) .cd-d', '.cd-a:where(.cd-b)', '.cd-a:has(> .cd-b)', '.cd-a:has(+ .cd-b, ~ .cd-c)',
  '.cd-a:has(.cd-b .cd-c)', '.cd-a:lang(en)', '.cd-a:dir(rtl)', '.cd-a::part(x)', '.cd-a::slotted(span)', '.cd-a::selection', '.cd-a::placeholder', '.cd-a:before',
  '.cd-a:focus-visible', '.cd-a[cd-x]', '.cd-a[cd-x="y"]', '.cd-a[cd-x=y i]', '.cd-a[cd-x^="y"]', '.cd-a[cd-x$=y]', '.cd-a[cd-x*=y]', '.cd-a[cd-x~=y]', '.cd-a[cd-x|=y]',
  '.cd-a\n.cd-b', '.cd-a , .cd-b', '.cd-a:not(:hover)', '.cd-a :first-child', 'a.cd-a', 'span:first-child', '.cd-a:nth-child( 2n + 1 )'];
test('valid selector syntax is understood', () => {
  const ctx = { allowList: buildAllowList({ roles: { x: ['a', 'span'] } }) };
  for (const sel of SELECTOR_SYNTAX_OK) accepted(`${sel}{border-radius:4px}`, ctx);
});

const SELECTOR_SYNTAX_BAD = [
  ['.cd-a >', /combinator/], ['> .cd-a', /combinator/], ['.cd-a,,.cd-b', /Empty/], ['.cd-a,', /Empty/], [',.cd-a', /Empty/], ['.', /class name/], ['.cd-a::', /pseudo/],
  ['.cd-a:', /pseudo/], ['.cd-a:foo(x)', /not supported/], ['.cd-a:is()', /Empty/], ['.cd-a:not()', /Empty/], ['.cd-a[]', /attribute name/],
  ['.cd-a[cd-x=]', /after the attribute operator/], ['.cd-a[cd-x=1]', /identifier or a string/], ['.cd-a[*|cd-x]', /Namespace/], ['*|a', /Namespace/],
  ['&', /nesting/], ['.cd-a&', /nesting/], ['.cd-a::before.cd-b', /pseudo-element/], ['.cd-a::before[cd-x]', /pseudo-element/], ['.cd-a%', /Unexpected/],
  ['.cd-a 5', /Unexpected/], ['.5', /Unexpected/], ['.cd-a:has(>)', /combinator/], ['.cd-a:is(> .cd-b)', /cannot start/], ['#1abc', /valid id/],
  ['.cd-a:nth-child(2n+1 of)', /Empty/], ['.cd-a:nth-child(.cd-b)', /Unsupported/],
];
for (const [sel, re] of SELECTOR_SYNTAX_BAD) test(`invalid selector syntax is refused: ${sel}`, () => refused(`${sel}{border-radius:4px}`, re));

// ---- blocked at-rules, urls, functions -----------------------------------------------------------------------------------------

const BLOCKED_AT_RULES = ['import', 'font-face', 'namespace', 'charset', 'property', 'counter-style', 'font-feature-values', 'font-palette-values', 'page',
  'scope', 'document', '-moz-document', 'viewport', '-ms-viewport', 'view-transition', 'position-try', 'custom-media', 'tailwind', 'apply', 'unknown-future-rule'];
for (const name of BLOCKED_AT_RULES) {
  test(`@${name} is refused with its line, as a statement and as a block`, () => {
    for (const body of [`@${name} "x";`, `@${name} url(https://evil.example/x.css);`, `@${name}{font-family:x;src:url(https://evil.example/x.woff)}`]) {
      const r = refused(`.cd-ok{border-radius:4px}\n${body}\n.cd-ok2{border-radius:4px}`, new RegExp(`@${name.replace(/[-]/g, '\\-')} is not allowed`));
      const e = r.errors.find((x) => x.code === 'at-rule');
      assert.equal(e.line, 2, body);
      assert.equal(e.column, 1, body);
      assert.equal(e.text, `Line 2: @${name} is not allowed`);
    }
  });
}

test('blocked at-rules are caught in every disguise: case, escapes, inside @media, after a comment', () => {
  for (const css of ['@IMPORT "x";', '@ImPoRt "x";', '@\\69mport "x";', '@\\000069mport "x";', '@media screen{@import "x";}', '/* c */@import "x";', '@media print{@font-face{font-family:x}}',
    '@supports (display:grid){@namespace url(http://x);}', '@layer a{@property --x{syntax:"*";inherits:false}}']) {
    refused(css, /is not allowed/);
  }
});

test('url() policy: only data:image/(png|jpeg|webp|svg+xml) and (chrome|moz)-extension://', () => {
  const svg = "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>";
  const b64 = (s) => Buffer.from(s).toString('base64');
  const allowed = [
    'url("data:image/png;base64,iVBORw0KGgo=")', 'url(data:image/png;base64,iVBORw0KGgo=)', 'url( "data:image/jpeg;base64,/9j/4AAQ" )', 'url(DATA:IMAGE/WEBP;base64,UklGRg==)',
    'URL("Data:Image/Png;base64,AA==")', 'u\\72l("data:image/png;base64,AA==")', 'url("data:image/png,%89PNG")', `url("data:image/svg+xml;utf8,${svg}")`,
    `url("data:image/svg+xml,${encodeURIComponent(svg)}")`, `url("data:image/svg+xml;base64,${b64(svg)}")`, 'url("chrome-extension://abcdefghijklmnop/icon.png")',
    'url(moz-extension://12345678-1234/icon.png)', 'url("CHROME-EXTENSION://abc/x.png")',
    `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'><use xlink:href='#a'/><defs><path id='a' d='M0 0'/></defs></svg>")`,
  ];
  for (const u of allowed) accepted(`.cd-a{background:${u}}`);
  const refusedUrls = [
    ['http', 'url(http://evil.example/a.png)'], ['https quoted', 'url("https://evil.example/a.png")'], ['protocol relative', 'url(//evil.example/a.png)'],
    ['site relative', 'url(/a.png)'], ['relative', 'url(a.png)'], ['fragment', 'url(#frag)'], ['empty', 'url()'], ['javascript', 'url(javascript:alert(1))'],
    ['javascript quoted', 'url("javascript:alert(1)")'], ['spaced javascript', 'url("java\\9 script:alert(1)")'], ['data html', 'url("data:text/html,<script>alert(1)</script>")'],
    ['data gif', 'url("data:image/gif;base64,R0lGOD")'], ['data without comma', 'url("data:image/png")'], ['data svg wrong type', 'url("data:image/svg;base64,AA==")'],
    ['blob', 'url("blob:https://www.youtube.com/abc")'], ['filesystem', 'url("filesystem:https://www.youtube.com/temporary/a")'], ['ftp', 'url(ftp://evil.example/a)'],
    ['percent encoded scheme', 'url("%64ata:image/png;base64,AA==")'], ['other extension scheme', 'url("edge-extension://abc/x.png")'], ['single slash scheme', 'url("chrome-extension:/abc/x.png")'],
    ['uppercase http', 'URL(HTTP://EVIL.EXAMPLE/A)'], ['escaped function name', 'u\\72l(http://evil.example/a)'], ['escaped scheme', 'url("h\\74tp://evil.example/a")'],
    ['svg with script', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>")`],
    ['svg with foreignObject', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><foreignObject/></svg>")`],
    ['svg external image', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><image href='https://evil.example/a.png'/></svg>")`],
    ['svg xlink external', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' xmlns:xlink='http://www.w3.org/1999/xlink'><image xlink:href='http://evil.example/a.png'/></svg>")`],
    ['svg href not a fragment', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><use href='other.svg#a'/></svg>")`],
    ['svg protocol-relative href', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><image href='//evil.example/a.png'/></svg>")`],
    ['svg external style url', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect style='fill:url(http://evil.example/p)'/></svg>")`],
    ['svg url() not a fragment', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect fill='url(x.svg#p)'/></svg>")`],
    ['svg event handler', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'></svg>")`],
    ['svg doctype entity', `url("data:image/svg+xml;utf8,<!DOCTYPE svg [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><svg xmlns='http://www.w3.org/2000/svg'/>")`],
    ['svg char-reference obfuscation', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><image href='&#104;ttp://evil.example/a.png'/></svg>")`],
    ['svg percent-encoded external', `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'%3E%3Cimage href='https://evil.example/a'/%3E%3C/svg%3E")`],
    ['svg base64 external', `url("data:image/svg+xml;base64,${b64("<svg xmlns='http://www.w3.org/2000/svg'><image href='https://evil.example/a'/></svg>")}")`],
    ['svg base64 invalid', 'url("data:image/svg+xml;base64,@@@")'], ['svg backslash escape', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><rect style='fill:\\75 rl(http://x)'/></svg>")`],
    ['svg animate', `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'><a><animate attributeName='href' to='http://x'/></a></svg>")`],
    ['image-set', 'image-set("a.png" 1x)'], ['-webkit-image-set', '-webkit-image-set(url(data:image/png;base64,AA==) 1x)'], ['src()', 'src("a.png")'],
    ['image()', 'image("a.png")'], ['cross-fade', 'cross-fade(url(data:image/png;base64,AA==), url(data:image/png;base64,AA==), 50%)'], ['paint()', 'paint(worklet)'],
    ['element()', 'element(#x)'], ['attr as url', 'attr(data-x url)'],
  ];
  for (const [name, u] of refusedUrls) {
    const r = refused(`.cd-a{background:${u}}`);
    assert.ok(r.errors.some((e) => e.code === 'url'), `${name}: ${JSON.stringify(r.errors)}`);
  }
});

test('url() policy applies everywhere: other properties, custom properties, at-rule preludes, keyframes', () => {
  for (const css of ['.cd-a{cursor:url(http://evil.example/c.cur),auto}', '.cd-a{list-style-image:url(http://evil.example/i.png)}', '.cd-a{--x:url(http://evil.example/a.png)}',
    '.cd-a{content:url(http://evil.example/a.png)}', '@media (min-width:1px){.cd-a{background:url(http://evil.example/a.png)}}', '@supports (background:url(http://evil.example/a)){.cd-a{border-radius:4px}}',
    '@keyframes cd-x{to{background:url(http://evil.example/a.png)}}', '.cd-a{mask:url(http://evil.example/m.svg#m)}', '.cd-a{filter:url(http://evil.example/f.svg#f)}',
    '.cd-a{border-image:url(//evil.example/b.png) 1}']) {
    refused(css, /url|not allowed/i);
  }
});

const CODE_EXEC = [
  ['expression()', '.cd-a{width:expression(alert(1))}', /expression/], ['EXPRESSION()', '.cd-a{WIDTH:EXPRESSION(alert(1))}', /expression/],
  ['escaped expression', '.cd-a{width:ex\\70ression(alert(1))}', /expression/], ['-ms-expression', '.cd-a{width:-ms-expression(1)}', /expression/],
  ['behavior', '.cd-a{behavior:url(x.htc)}', /behavior/], ['-ms-behavior', '.cd-a{-ms-behavior:url(#default#VML)}', /behavior/],
  ['-moz-binding', '.cd-a{-moz-binding:url("x.xml#y")}', /binding/], ['uppercase -moz-binding', '.cd-a{-MOZ-BINDING:none}', /binding/], ['escaped -moz-binding', '.cd-a{-moz-b\\69nding:none}', /binding/],
  ['javascript: in a url', '.cd-a{background:url(javascript:alert(1))}', /url\(\)/], ['javascript: in a string', '.cd-a{content:"javascript:alert(1)"}', /javascript/],
  ['javascript: with control characters', '.cd-a{content:"java\\9 script:1"}', /javascript/], ['javascript: as a bare value', '.cd-a{width:javascript:alert(1)}', /javascript/],
  ['vbscript:', '.cd-a{content:"vbscript:msgbox(1)"}', /javascript/], ['progid filter', '.cd-a{filter:progid:DXImageTransform.Microsoft.gradient(startColorstr=#80000000)}', /progid/],
];
for (const [name, css, re] of CODE_EXEC) test(`script-ish constructs are refused: ${name}`, () => refused(css, re));

// ---- content length ------------------------------------------------------------------------------------------------------------

test('content values are limited to LIMITS.contentMaxChars characters (strings summed, escapes counted once)', () => {
  const max = LIMITS.contentMaxChars;
  assert.equal(max, 100);
  accepted(`.cd-a::after{content:"${'x'.repeat(max)}"}`);
  refused(`.cd-a::after{content:"${'x'.repeat(max + 1)}"}`, /limit is 100/);
  accepted(`.cd-a::after{content:'${'x'.repeat(max)}'}`);
  refused(`.cd-a::after{content:"${'x'.repeat(60)}" "${'y'.repeat(60)}"}`, /120 characters/);
  accepted(`.cd-a::after{content:"${'\\201C'.repeat(max)}"}`);
  refused(`.cd-a::after{content:"${'\\201C'.repeat(max + 1)}"}`, /limit is 100/);
  // Only strings, none and normal are values of content in a theme (attr() and counter() are refused by the allow-list, not the length rule).
  refusedByProfile(`.cd-a::after{content:"${'x'.repeat(max)}" attr(title)}`, /string, none or normal/);
  refusedByProfile(`.cd-a::after{content:counter(item) ". "}`, /string, none or normal/);
  accepted(`.cd-a::after{animation-name:"${'x'.repeat(300)}"}`);   // long strings elsewhere are not the length rule's business
  accepted(`.cd-a::after{content:url("data:image/png;base64,${'A'.repeat(300)}")}`.replace('content:', 'background:'));
  refused(`.cd-a::after{CONTENT:"${'x'.repeat(max + 1)}" !important}`, /limit is 100/);
  refused(`@media print{.cd-a::after{content:"${'x'.repeat(max + 1)}"}}`, /limit is 100/);
  refused(`@keyframes cd-x{to{content:"${'x'.repeat(max + 1)}"}}`, /limit is 100/);
});

test('long text cannot be smuggled through a custom property either', () => {
  accepted(`html[cd-theme]{--cd-t-label:"${'x'.repeat(100)}"}`);
  refused(`html[cd-theme]{--cd-t-label:"${'x'.repeat(101)}"}.cd-a::after{content:var(--cd-t-label)}`, /custom property/);
});

// ---- keyframes -----------------------------------------------------------------------------------------------------------------

test('@keyframes names must start with cd-', () => {
  for (const name of ['spin', 'ytSpin', 'CD-spin', 'Cd-spin', 'cd_spin', '-cd-spin', 'xcd-spin', '"spin"']) {
    refused(`@keyframes ${name}{from{border-radius:4px}}`, /must start with "cd-"/);
    refused(`@-webkit-keyframes ${name}{from{border-radius:4px}}`, /must start with "cd-"/);
  }
  for (const name of ['cd-spin', 'cd-', 'cd-a-b', '"cd-q"']) accepted(`@keyframes ${name}{from{border-radius:4px}}`);
  const r = refused('.cd-a{border-radius:4px}\n\n@keyframes spin {\n  from{border-radius:4px}\n}');
  assert.equal(r.errors[0].line, 3);
  assert.equal(r.errors[0].column, 12, 'points at the name');
});

// ---- selector rules ------------------------------------------------------------------------------------------------------------

test('classes, ids, tags and attributes must be cd- prefixed or in the selector map', () => {
  refused('.foo{border-radius:4px}', /"\.foo".*not a Cinedrape class/);
  refused('#foo{border-radius:4px}', /"#foo".*not a Cinedrape id/);
  refused('foo-bar{border-radius:4px}', /"foo-bar".*not a Cinedrape element/);
  refused('div.foo span#bar{border-radius:4px}');
  refused('.cd-a[foo]{border-radius:4px}', /\[foo\]/);
  refused('.cd-a [foo=bar]{border-radius:4px}', /\[foo\]/);
  refused('ytd-nope-renderer{border-radius:4px}', /ytd-nope-renderer/);
  refused('.cd-a:not(.foo){border-radius:4px}', /"\.foo"/);
  refused('.cd-a:is(.cd-b,.foo){border-radius:4px}', /"\.foo"/);
  refused('.cd-a:has(> .foo){border-radius:4px}', /"\.foo"/);
  refused('.cd-a:nth-child(2n of .foo){border-radius:4px}', /"\.foo"/);
  refused('.CD-a{border-radius:4px}', /CD-a/);
  refused('.cd_a{border-radius:4px}', /cd_a/);
  accepted('.ytLockupViewModelContentImage{border-radius:4px}');
  accepted('#masthead-ad{border-radius:4px}');
  accepted('ytd-rich-item-renderer{border-radius:4px}');
  accepted('YTD-RICH-ITEM-RENDERER{border-radius:4px}');
  accepted('ytd-browse[page-subtype=home] ytd-rich-grid-renderer{border-radius:4px}');
  accepted('ytd-browse[PAGE-SUBTYPE="home"]{border-radius:4px}');
  accepted('a[href^="/watch"]{border-radius:4px}');
  accepted('.cd-a[cd-anything]{border-radius:4px}');
  accepted('cd-widget .cd-a{border-radius:4px}');
  accepted('.cd-a:not(.ytLockupViewModelContentImage){border-radius:4px}');
});

test('html, body, :root and * are not allowed bare; html[cd-...] and :root[cd-...] are', () => {
  for (const sel of ['html', 'body', ':root', '*', 'HTML', 'html:hover', 'html:not([cd-theme])', ':root:not(.cd-a)', 'html[dark]', 'body.foo', '*:hover', 'html body', 'html[cd-theme] body',
    'html[cd-theme] *', '.cd-a *', '.cd-a > *', ':is(*)', ':is(html)', '.cd-a:not(*)', 'html .cd-a', ':root .cd-a', 'body .cd-a', '* .cd-a', '*,.cd-a']) {
    refused(`${sel}{border-radius:4px}`, /cannot be targeted without|universal selector/);
  }
  for (const sel of ['html[cd-theme]', 'html[cd-theme][dark]', 'html[cd-theme]:not([dark])', 'html.cd-dark', 'html#cd-root', ':root[cd-theme]', 'html[cd-theme] .cd-a', 'html[cd-calm-hideShorts] .cd-a',
    '*.cd-a', '*[cd-x]', 'body[cd-x]', 'html[cd-theme] ytd-app', 'html[cd-theme]:is([dark], [light])']) {
    accepted(`${sel}{border-radius:4px}`);
  }
  const r = refused('.cd-a{}\nhtml{border-radius:4px}');
  assert.equal(r.errors[0].line, 2);
});

test('selectors longer than 1000 characters are refused; the ad guard text does not count against the limit', () => {
  accepted(`.cd-${'a'.repeat(996)}{border-radius:4px}`);
  const r = refused(`.cd-${'a'.repeat(997)}{border-radius:4px}`, /1001 characters long; the limit is 1000/);
  assert.equal(r.errors[0].column, 1);
  accepted(`.cd-a ${'.cd-b '.repeat(150)}{border-radius:4px}`.replace(/\s+\{/, '{'));
  refused(`${'.cd-b,'.repeat(5)}.cd-${'a'.repeat(1000)}{border-radius:4px}`, /characters long/);
  assert.ok(GUARD.length > 1000, 'the real ad guard is longer than the selector limit');
  accepted(`${safeHide(MAP, 'ytd-rich-item-renderer')}{display:none}`, ENGINE);
  accepted(`${safeHide(MAP, '.ytLockupViewModelContentImage')}{display:none}`, ENGINE);
});

test('selectors nested deeper than 6 pseudo-class levels are refused', () => {
  const nest = (n) => `${':is('.repeat(n)}.cd-z${')'.repeat(n)}`;
  accepted(`.cd-a${nest(6)}{border-radius:4px}`);
  refused(`.cd-a${nest(7)}{border-radius:4px}`, /nested more than 6 levels/);
  refused(`.cd-a${nest(40)}{border-radius:4px}`);
  accepted('.cd-a:not(:has(.cd-b:is(.cd-c:where(.cd-d))))' + '{border-radius:4px}');
  const mixed = ':not(:is(:has(:where(:is(:not(.cd-z))))))';
  accepted(`.cd-a${mixed}{border-radius:4px}`);
  refused(`.cd-a${mixed.replace('.cd-z', ':is(.cd-z)')}{border-radius:4px}`, /nested more than 6 levels/);
});

test('selector errors point at the offending simple selector', () => {
  const r = refused('.cd-ok{border-radius:4px}\n.cd-a   .nope .cd-b{border-radius:4px}');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
  assert.equal(r.errors[0].column, 9, '".cd-a" is columns 1-5, three spaces, ".nope" starts at column 9');
  assert.equal(r.errors[0].code, 'selector-not-allowed');
});

// ---- ad safety: hiding declarations on protected elements ----------------------------------------------------------------------

const AD_TARGETS = ['ytd-ad-slot-renderer', '#masthead-ad', '.ytp-paid-content-overlay', '.ytp-chrome-bottom', '.ytp-ad-module', 'ytd-info-panel-container-renderer', '.ytp-play-button'];

const HIDING_DECLARATIONS = [
  ['display none', 'display:none'], ['display none spaced', 'display : none'], ['display none !important', 'display:none !important'], ['display none ! important', 'display:none ! important'],
  ['display none upper case', 'DISPLAY:NONE'], ['display none mixed case', 'DiSpLaY:nOnE'], ['display escaped name (hex)', String.raw`\64isplay:none`], ['display escaped name (char)', String.raw`d\isplay:none`],
  ['display escaped name (padded hex)', String.raw`\000064isplay:none`], ['display escaped value', String.raw`display:\6eone`], ['display escaped value (char)', String.raw`display:no\ne`],
  ['display with comment before value', 'display:/**/none'], ['display with comments around', 'display/**/:/**/none/**/'], ['display none with vendor prefix', '-webkit-display:none'],
  ['display contents', 'display:contents'], ['display table-column', 'display:table-column'], ['display none then block', 'display:none;display:block;display:none'],
  ['visibility hidden', 'visibility:hidden'], ['visibility collapse', 'visibility:collapse'], ['visibility hidden upper case', 'VISIBILITY:HIDDEN'],
  ['opacity 0', 'opacity:0'], ['opacity .5', 'opacity:.5'], ['opacity 0.99', 'opacity:0.99'], ['opacity 50%', 'opacity:50%'], ['opacity 0%', 'opacity:0%'], ['opacity tiny', 'opacity:1e-9'],
  ['opacity -1', 'opacity:-1'], ['opacity calc', 'opacity:calc(1 - 1)'], ['opacity calc fraction', 'opacity:calc(1 / 2)'], ['opacity min', 'opacity:min(1,0)'], ['opacity vendor prefix', '-moz-opacity:0'],
  ['fill-opacity 0', 'fill-opacity:0'], ['stroke-opacity .1', 'stroke-opacity:.1'],
  ['height 0', 'height:0'], ['height 0px', 'height:0px'], ['height 0%', 'height:0%'], ['height 0em', 'height:0em'], ['height -0', 'height:-0'], ['height .5px', 'height:.5px'], ['height 1px', 'height:1px'],
  ['height calc zero', 'height:calc(1px - 1px)'], ['height calc percent zero', 'height:calc(100% - 100%)'], ['height calc negative', 'height:calc(100% - 200%)'], ['height calc times zero', 'height:calc(50px * 0)'],
  ['height min with zero', 'height:min(0px,10px)'], ['height clamp zero', 'height:clamp(0px,0px,0px)'], ['width 0', 'width:0'], ['width 0 important', 'width:0!important'],
  ['max-height 0', 'max-height:0'], ['max-height 2px', 'max-height:2px'], ['max-height 20px', 'max-height:20px'], ['max-width 0', 'max-width:0'],
  ['block-size 0', 'block-size:0'], ['inline-size 0', 'inline-size:0'], ['max-block-size 0', 'max-block-size:0'],
  ['overflow hidden with zero height', 'overflow:hidden;height:0'], ['flex 0 0 0', 'flex:0 0 0'], ['flex 0', 'flex:0'], ['flex 0 0 0px', 'flex:0 0 0px'],
  ['overflow hidden alone', 'overflow:hidden'], ['overflow clip alone', 'overflow:clip'], ['overflow-x hidden', 'overflow-x:hidden'], ['overflow pair with hidden', 'overflow:hidden auto'],
  ['overflow hidden vendor prefix', '-webkit-overflow:hidden'],
  ['line-height 0', 'line-height:0'], ['line-height 0px', 'line-height:0px'], ['line-height 0em', 'line-height:0em'], ['line-height tiny', 'line-height:.5px'],
  ['line-height calc zero', 'line-height:calc(0px + 0px)'],
  ['font-size 0', 'font-size:0'], ['font-size 0px', 'font-size:0px'], ['font-size tiny', 'font-size:.001em'], ['font-size 1px', 'font-size:1px'], ['font-size 0%', 'font-size:0%'],
  ['font shorthand zero size', 'font:0/0 serif'], ['font shorthand zero with weight', 'font:italic bold 0px/1 serif'], ['font-size-adjust 0', 'font-size-adjust:0'],
  ['font shorthand zero line-height', 'font:12px/0 serif'], ['font shorthand tiny line-height', 'font:bold 12px/.5px serif'],
  ['backface-visibility hidden', 'backface-visibility:hidden'], ['backface-visibility hidden vendor prefix', '-webkit-backface-visibility:hidden'],
  ['clip rect zero', 'clip:rect(0,0,0,0)'], ['clip rect pixels', 'clip:rect(0px 0px 0px 0px)'], ['clip-path inset 50%', 'clip-path:inset(50%)'], ['clip-path circle 0', 'clip-path:circle(0)'],
  ['clip-path polygon', 'clip-path:polygon(0 0,0 0,0 0)'], ['clip-path vendor prefix', '-webkit-clip-path:polygon(0 0)'], ['clip-path inset with offsets', 'clip-path:inset(0 100% 0 0)'],
  ['transform scale 0', 'transform:scale(0)'], ['transform scaleY 0', 'transform:scaleY(0)'], ['transform scaleX 0', 'transform:scaleX(0)'], ['transform scale tiny', 'transform:scale(.01)'],
  ['transform scale3d zero', 'transform:scale3d(0,0,0)'], ['transform scale with spaces', 'transform:  scale( 0 , 0 )'], ['transform vendor prefix', '-webkit-transform:scale(0)'],
  ['transform translateX far', 'transform:translateX(-9999px)'], ['transform translate viewport', 'transform:translate(-100vw,0)'], ['transform translateY percent', 'transform:translateY(-5000%)'],
  ['transform translate3d far', 'transform:translate3d(0,99999px,0)'], ['transform rotateX 90', 'transform:rotateX(90deg)'], ['transform rotateY 270', 'transform:rotateY(270deg)'],
  ['transform rotate3d edge-on', 'transform:rotate3d(0,1,0,90deg)'], ['transform skewX 90', 'transform:skewX(90deg)'], ['transform matrix zero', 'transform:matrix(0,0,0,0,0,0)'],
  ['transform matrix far', 'transform:matrix(1,0,0,1,-9999,0)'], ['transform matrix3d flat', 'transform:matrix3d(0,0,0,0,0,0,0,0,0,0,1,0,0,0,0,1)'], ['transform calc scale', 'transform:scale(calc(1 - 1))'],
  ['transform scale after other functions', 'transform:translateX(1px) rotate(1deg) scale(0)'],
  ['scale property 0', 'scale:0'], ['scale property 0%', 'scale:0%'], ['translate property far', 'translate:-9999px'], ['translate property viewport', 'translate:0 -100vh'], ['rotate property edge-on', 'rotate:x 90deg'],
  ['left far negative', 'left:-9999px'], ['left far positive', 'left:9999px'], ['top far negative', 'top:-1000px'], ['right far', 'right:-100000px'], ['bottom far', 'bottom:-5000px'],
  ['inset far', 'inset:-9999px'], ['inset-inline-start far', 'inset-inline-start:-9999px'], ['left viewport', 'left:-100vw'], ['left percent', 'left:-500%'], ['left calc', 'left:calc(-50vw - 50vw)'],
  ['margin-left far', 'margin-left:-5000px'], ['margin shorthand far', 'margin:-2000px 0 0'], ['margin-inline-start far', 'margin-inline-start:-9999px'], ['margin far positive', 'margin-left:9999px'],
  ['text-indent far', 'text-indent:-9999px'], ['text-indent positive far', 'text-indent:9999px'], ['letter-spacing far', 'letter-spacing:-9999px'], ['word-spacing far', 'word-spacing:9999px'],
  ['padding pushes content away', 'padding-left:9999px'], ['gap pushes items away', 'gap:9999px'], ['border-width pushes content away', 'border-left-width:9999px'],
  ['object-position far', 'object-position:-9999px 0'], ['background-position far', 'background-position:-9999px 0'],
  ['pointer-events none', 'pointer-events:none'], ['pointer-events none upper', 'POINTER-EVENTS:NONE'], ['pointer-events with comment', 'pointer-events:/**/none'],
  ['position fixed', 'position:fixed'], ['position absolute', 'position:absolute'], ['position fixed with z-index', 'position:fixed;z-index:9999'], ['position absolute covering', 'position:absolute;inset:0;z-index:2147483647'],
  ['negative z-index', 'z-index:-1'], ['positive z-index', 'z-index:999'], ['z-index calc', 'z-index:calc(1 + 1)'],
  ['color transparent', 'color:transparent'], ['color rgba 0', 'color:rgba(0,0,0,0)'], ['color rgb slash 0', 'color:rgb(0 0 0 / 0)'], ['color rgb slash percent', 'color:rgb(0 0 0 / 0%)'],
  ['color hsla 0', 'color:hsla(0,0%,0%,0)'], ['color hex 4', 'color:#0000'], ['color hex 8', 'color:#00000000'], ['color hex 8 low alpha', 'color:#ffffff05'], ['color tiny alpha', 'color:rgb(0 0 0 / .05)'],
  ['color alpha none', 'color:rgb(0 0 0 / none)'], ['color-mix transparent', 'color:color-mix(in srgb, red 0%, transparent)'], ['color oklch alpha 0', 'color:oklch(50% .2 120 / 0)'],
  ['text fill transparent', '-webkit-text-fill-color:transparent'], ['svg fill transparent', 'fill:transparent'], ['svg stroke transparent', 'stroke:rgba(0,0,0,0)'],
  ['filter opacity 0', 'filter:opacity(0)'], ['filter opacity percent', 'filter:opacity(5%)'], ['filter blur big', 'filter:blur(20px)'], ['filter blur rem', 'filter:blur(2rem)'],
  ['filter brightness 0', 'filter:brightness(0)'], ['filter brightness huge', 'filter:brightness(50)'], ['filter contrast 0', 'filter:contrast(0)'], ['filter url fragment', 'filter:url(#x)'],
  ['filter after harmless ones', 'filter:grayscale(1) sepia(1) blur(9px)'], ['filter vendor prefix', '-webkit-filter:blur(20px)'], ['backdrop-filter blur', 'backdrop-filter:blur(9px)'],
  ['backdrop-filter opacity', '-webkit-backdrop-filter:opacity(0)'],
  ['mask linear-gradient', 'mask:linear-gradient(#000,transparent)'], ['mask-image gradient', 'mask-image:linear-gradient(#000,transparent)'], ['-webkit-mask-image', '-webkit-mask-image:linear-gradient(#000,transparent)'],
  ['mask-border', 'mask-border:linear-gradient(#000,transparent)'], ['mask data url', 'mask:url("data:image/png;base64,AA==")'],
  ['content-visibility hidden', 'content-visibility:hidden'], ['all unset', 'all:unset'], ['all initial', 'all:initial'], ['all revert', 'all:revert'], ['all inherit', 'all:inherit'],
  ['contain size', 'contain:size'], ['contain strict', 'contain:strict'], ['contain inline-size', 'contain:inline-size layout'], ['mix-blend-mode multiply', 'mix-blend-mode:multiply'], ['mix-blend-mode difference', 'mix-blend-mode:difference'],
  ['zoom 0', 'zoom:0'], ['zoom tiny', 'zoom:.01'], ['grid track zero', 'display:grid;grid-template-columns:0 1fr'], ['grid repeat zero', 'grid-template-rows:repeat(3,0)'],
  ['content image replaces element', 'content:url("data:image/png;base64,AA==")'], ['content gradient', 'content:linear-gradient(#fff,#fff)'],
  ['huge box-shadow covers neighbours', 'box-shadow:0 0 0 9999px #000'], ['huge outline covers neighbours', 'outline:9999px solid #000'], ['huge shadow blur', 'box-shadow:0 0 99999px 99999px #000'],
  ['transform scale enlarges over neighbours', 'transform:scale(50)'], ['translate lands on neighbours', 'transform:translateY(-300px)'], ['margin pulls over previous sibling', 'margin-top:-400px'],
];
for (const [label, decl] of HIDING_DECLARATIONS) {
  test(`ad safety: "${label}" is refused on ads, sponsorship labels and player controls`, () => {
    for (const target of AD_TARGETS) refusedForSafety(`${target}{${decl}}`);
  });
}

test('ad safety: the hiding declarations are never an AD-SAFETY finding on a Cinedrape element (they are ours; the allow-list bounds them)', () => {
  // Own elements are exempt from the hide/overlay classification. What a theme may do to them is the allow-list's business, with bounds
  // (test/shared/css-validator-hostile.test.js): position:fixed, z-index 999, a scale(0) card and so on are refused there, for their own reason.
  let fine = 0;
  for (const [label, decl] of HIDING_DECLARATIONS) {
    const r = check(`.cd-card{${decl}}`);
    assert.ok(!r.errors.some((e) => SAFETY_CODES.has(e.code)), `${label}: ${JSON.stringify(r.errors)}`);
    if (r.ok) fine++;
  }
  assert.ok(fine > 20, `${fine} of the declarations are fine on an own part`);
});

test('min-width/min-height/min-size of 0 is not a collapse (a minimum can only enlarge a box)', () => {
  for (const p of ['min-width', 'min-height', 'min-inline-size', 'min-block-size']) assert.equal(describeHiding(p, '0'), null, p);
  for (const sel of ['ytd-ad-slot-renderer', '#primary-inner > *', '.cd-card']) {
    const r = check(`${sel}{min-width:0;min-height:0}`, ENGINE);
    assert.deepEqual(r.errors.filter((e) => SAFETY_CODES.has(e.code)), [], sel);
  }
});

const WRAPPERS = [
  ['bare', (s, d) => `${s}{${d}}`],
  ['with !important', (s, d) => `${s}{${d} !important}`],
  ['after harmless declarations', (s, d) => `${s}{color:red;${d};border-radius:4px}`],
  ['first of several rules', (s, d) => `.cd-ok{border-radius:4px}\n${s}{${d}}\n.cd-ok2{border-radius:4px}`],
  ['inside @media', (s, d) => `@media print{${s}{${d}}}`],
  ['inside @media with a condition list', (s, d) => `@media (min-width:1px),print and (orientation:landscape){${s}{${d}}}`],
  ['inside @supports', (s, d) => `@supports (display:grid){${s}{${d}}}`],
  ['inside @supports not', (s, d) => `@supports not (display:flex){${s}{${d}}}`],
  ['inside @container', (s, d) => `@container (min-width:1px){${s}{${d}}}`],
  ['inside @layer', (s, d) => `@layer x{${s}{${d}}}`],
  ['deeply nested at-rules', (s, d) => `@media a{@supports (x:y){@media b{@layer z{${s}{${d}}}}}}`],
  ['among a selector list', (s, d) => `.cd-a,${s},.cd-b{${d}}`],
  ['with comments around everything', (s, d) => `/*a*/${s}/*b*/{/*c*/${d}/*d*/}/*e*/`],
  ['in a selector with a cd- ancestor', (s, d) => `.cd-home ${s}{${d}}`],
  ['under html[cd-theme]', (s, d) => `html[cd-theme] ${s}{${d}}`],
  ['with extra pseudo-classes', (s, d) => `${s}:hover{${d}}`],
  ['on a pseudo-element', (s, d) => `${s}::before{${d}}`],
  ['inside :is()', (s, d) => `:is(${s}){${d}}`],
  ['inside :where()', (s, d) => `:where(${s}){${d}}`],
  ['inside :not(:not())', (s, d) => `:not(:not(${s})){${d}}`],
  ['as a :has() subject', (s, d) => `.cd-x:has(${s}){${d}}`],
  ['after a sibling combinator', (s, d) => `.cd-x ~ ${s}{${d}}`],
  ['as a child', (s, d) => `.cd-x > ${s}{${d}}`],
  ['as an ancestor of ours', (s, d) => `${s} .cd-y{${d}}`],
  ['with CRLF', (s, d) => `${s}\r\n{\r\n${d}\r\n}\r\n`],
];
for (const [label, wrap] of WRAPPERS) {
  test(`ad safety: display:none on an ad cannot be wrapped: ${label}`, () => {
    for (const target of ['ytd-ad-slot-renderer', '#masthead-ad', '.ytp-paid-content-overlay', '.ytp-chrome-bottom']) {
      for (const decl of ['display:none', 'opacity:0', 'height:0', 'visibility:hidden']) refusedForSafety(wrap(target, decl));
    }
  });
}

test('ad safety: every selector the map protects is refused when hidden, and restyling it (border, radius) is fine', () => {
  let n = 0;
  for (const group of ['ads', 'sponsor', 'playerControls']) {
    for (const sel of MAP.protected[group]) {
      for (const decl of ['display:none', 'visibility:hidden', 'opacity:0', 'height:0', 'transform:scale(0)']) refusedForSafety(`${sel}{${decl}}`);
      accepted(`${sel}{border-radius:4px;border:1px solid var(--cd-border)}`);
      refusedByProfile(`${sel}{color:var(--cd-text)}`);
      n++;
    }
  }
  assert.equal(n, PROTECTED.length, 'every protected selector was checked');
  assert.ok(n > 50, `checked ${n} protected selectors`);
});

// ---- ad safety: selectors that reach protected elements without naming them -------------------------------------------------

const SNEAKY_SELECTORS = [
  ['inside :is()', ':is(ytd-ad-slot-renderer)'], ['inside :where()', ':where(.ytp-ad-module)'], ['inside :has()', 'ytd-comments:has(ytd-ad-slot-renderer)'],
  ['inside :has() with a combinator', 'ytd-comments:has(> .ytp-ad-module)'], ['inside nested :is(:where())', ':is(:where(ytd-ad-slot-renderer, .cd-a))'], ['double negation', ':not(:not(ytd-ad-slot-renderer))'],
  ['next to a cd- class', 'ytd-ad-slot-renderer.cd-x'], ['under a cd- ancestor', '.cd-a ytd-ad-slot-renderer'], ['after a sibling', 'ytd-comments ~ ytd-ad-slot-renderer'],
  ['upper case tag', 'YTD-AD-SLOT-RENDERER'], ['escaped tag', String.raw`ytd-ad-slot-\72 enderer`], ['escaped class', String.raw`.ytp-ad-\6dodule`], ['escaped id', String.raw`#mast\68 ead-ad`],
  ['attribute substring ad', '[class*=ad]'], ['attribute substring quoted', '[class*="ytp-ad"]'], ['attribute substring id', '[id*=ad]'], ['attribute prefix ytp', '[class^=ytp]'],
  ['attribute suffix', '[class$=module]'], ['attribute token', '[class~=ytp-ad-module]'], ['attribute equals', '[class="ytp-ad-module"]'], ['attribute presence class', '[class]'],
  ['attribute presence id', '[id]'], ['attribute with a tag', 'div[class*=ad]'], ['attribute case flag', 'div[class*=AD i]'], ['attribute upper case name', '[CLASS*=AD]'],
  ['attribute escaped value', String.raw`[class*=\61 d]`], ['attribute dash match', '[class|=ytp]'], ['attribute id prefix', '[id^=masthead]'], ['attribute target-id', 'ytd-engagement-panel-section-list-renderer[target-id]'],
  ['universal', '*'], ['universal under html', 'html[cd-theme] *'], ['universal child', '.cd-a > *'], ['universal in :is()', ':is(*)'], ['universal in :has()', 'ytd-comments:has(> *)'],
  ['only pseudo-classes', ':first-child'], ['only a negation', ':not(.cd-a)'], ['only :hover', ':hover'], ['bare tag of the shared ad panel', 'ytd-engagement-panel-section-list-renderer'],
  ['with a class from the player', '.ytp-chrome-bottom .cd-x'], ['a combinator chain', 'ytd-comments > #contents .ytp-ad-module'], ['nth-child of', ':nth-child(2 of .ytp-ad-module)'],
];
for (const [label, sel] of SNEAKY_SELECTORS) {
  test(`ad safety: a selector that reaches ads is refused when it hides: ${label}`, () => {
    for (const decl of ['display:none', 'opacity:0', 'visibility:hidden', 'height:0']) refusedForSafety(`${sel}{${decl}}`);
  });
}

test('ad safety: positive references are what count; :not() of an ad is harmless', () => {
  accepted('.cd-card:not(.ytp-ad-module){display:none}');
  accepted('.cd-card:not(ytd-ad-slot-renderer):not([class*=ad]){display:none}');
  accepted('.cd-a:not(:has(ytd-ad-slot-renderer)){display:none}');
  accepted('ytd-comments:not(:has(.ytp-ad-module)){display:none}', ENGINE);
  refusedForSafety('.cd-a:is(.ytp-ad-module){display:none}');
});

// ---- ad safety: containers that can hold an ad need the guard ------------------------------------------------------------------

test('ad safety: hiding a container is refused without the guard; with the full guard the safety layer accepts it (engine profile), a theme still may not', () => {
  let n = 0;
  for (const sel of MAP.protected.containers) {
    for (const decl of ['display:none', 'opacity:0', 'visibility:hidden', 'height:0', 'transform:scale(0)']) refusedForSafety(`${sel}{${decl}}`);
    const guarded = safeHide(MAP, sel);
    for (const decl of ['display:none', 'opacity:0', 'visibility:hidden', 'height:0']) accepted(`${guarded}{${decl}}`, ENGINE);
    // ... and a theme still may not hide YouTube DOM at all, guard or not: calm mode exists for that.
    refusedByProfile(`${guarded}{display:none}`);
    n++;
  }
  assert.ok(n > 50);
});

test('ad safety: safeHide output is accepted for leaf and wrapper subjects, lists, wrapping and pseudo-elements', () => {
  for (const sel of ['ytd-rich-item-renderer', 'yt-lockup-view-model', '#related', 'ytd-comments', '.ytp-ce-element', 'ytd-rich-item-renderer, ytd-video-renderer, #contents',
    'html[cd-calm-hideShorts] ytd-rich-item-renderer > #content', '.ytLockupViewModelContentImage', 'a[href^="/shorts/"]', 'ytd-mini-guide-renderer a[href="/shorts/"]']) {
    accepted(`${safeHide(MAP, sel)}{display:none !important}`, ENGINE);
    accepted(`@media (min-width:1px){${safeHide(MAP, sel)}{display:none}}`, ENGINE);
  }
  accepted(`${safeHide(MAP, 'ytd-rich-item-renderer::before')}{display:none}`, ENGINE);
  accepted(`${safeHide(MAP, ':is(ytd-rich-item-renderer, #contents)')}{opacity:0}`, ENGINE);
});

test('ad safety: the guard must list every protected ad selector, in the subject compound', () => {
  const ads = MAP.protected.ads;
  const guardOf = (list) => `:not(:has(${list.join(',')}))`;
  accepted(`ytd-rich-item-renderer${guardOf(ads)}{display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer${guardOf([...ads].reverse())}{display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer${guardOf([...ads, '.cd-extra'])}{display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer${guardOf(ads)}:hover{display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer${guardOf(ads)}:not(.cd-x){display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer:hover${guardOf(ads)}{display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer${guardOf(ads.slice(0, 20))}${guardOf(ads.slice(20))}{display:none}`, ENGINE);
  accepted(`:is(ytd-rich-item-renderer,#contents)${guardOf(ads)}{display:none}`, ENGINE);
  accepted(`:is(ytd-rich-item-renderer${guardOf(ads)},#contents${guardOf(ads)}){display:none}`, ENGINE);
  accepted(`ytd-rich-item-renderer:where(${guardOf(ads)}){display:none}`.replace(':where(:not(:has', ':where(:not(:has'), ENGINE);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(ads.slice(0, -1))}{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(ads.slice(1))}{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(['ytd-ad-slot-renderer'])}{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(MAP.protected.sponsor)}{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer:has(${ads.join(',')}){display:none}`);
  refusedForSafety(`ytd-rich-item-renderer:not(${ads.join(',')}){display:none}`);
  refusedForSafety(`ytd-rich-item-renderer:not(:not(:has(${ads.join(',')}))){display:none}`);
  refusedForSafety(`ytd-rich-item-renderer:not(:has(${ads.join(',')}) .cd-x){display:none}`);
  refusedForSafety(`:is(ytd-rich-item-renderer,#contents${guardOf(ads)}){display:none}`);
  refusedForSafety(`ytd-rich-grid-renderer${guardOf(ads)} ytd-rich-item-renderer{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(ads)}, #contents{display:none}`);
  refusedForSafety(`ytd-rich-item-renderer${guardOf(ads)} ~ #contents{display:none}`);
  refusedForSafety(`.cd-x:not(:has(${ads.join(',')})) + ytd-rich-item-renderer{display:none}`);
});

test('ad safety: leaf hiding is allowed (by the safety layer) where the map says nothing can hold an ad', () => {
  for (const sel of ['ytd-comments', 'ytd-comments#comments', 'ytd-watch-metadata', 'ytd-masthead', 'ytd-mini-guide-renderer', 'tp-yt-app-drawer#guide', 'ytd-guide-renderer', '#info',
    'ytd-watch-info-text', 'ytd-thumbnail', 'ytd-channel-name a'.replace(' a', '')]) {
    if (!ALLOW.tags.has(sel.split(/[#.[]/)[0]) && !ALLOW.ids.has(sel.split('#')[1] || '-')) continue;
    accepted(`${sel}{display:none}`, ENGINE);
    refusedByProfile(`${sel}{display:none}`);   // a theme cannot hide YouTube DOM at all, even where the safety layer would allow it
  }
  accepted('ytd-comments#comments{display:none !important}', ENGINE);
  accepted('ytd-comments{opacity:.5;filter:blur(4px)}', ENGINE);
  refusedByProfile('ytd-comments{opacity:.5}');
});

test('ad safety: generic elements (img, a, span, div, ...) cannot be hidden outside our own DOM, they also live inside ads', () => {
  for (const sel of ['img', 'a', 'span', 'div', 'h3', 'h1', 'ytd-rich-item-renderer img', 'ytd-comments span', 'html[cd-theme] a', '.ytThumbnailViewModelImage img', 'a[href^="/watch"]',
    '.ytLockupViewModelContentImage', '.ytp-ce-element', '#contents > div', 'a.ytLockupMetadataViewModelTitle']) {
    for (const decl of ['display:none', 'opacity:.1', 'visibility:hidden', 'height:0']) refusedForSafety(`${sel}{${decl}}`);
  }
  accepted('.cd-card img{display:none}');
  accepted('.cd-card a{opacity:0}');
  accepted('.cd-a > div{height:0}');
});

test('ad safety: the page root is never hidden, not even with the cd- anchor', () => {
  for (const sel of ['html[cd-theme]', 'html[cd-theme][dark]', ':root[cd-theme]', 'html.cd-x', 'html[cd-theme]:not(:hover)']) {
    for (const decl of ['display:none', 'opacity:0', 'opacity:.99', 'visibility:hidden', 'height:0', 'transform:scale(0)', 'filter:blur(9px)']) {
      const r = refusedForSafety(`${sel}{${decl}}`);
      assert.match(messages(r), /whole page|can hold an ad/, `${sel}{${decl}}`);
    }
  }
  accepted('html[cd-theme]{opacity:1;filter:grayscale(1);color-scheme:dark;--x:1}', ENGINE);
  accepted('html[cd-theme]{color-scheme:dark}');
  refusedByProfile('html[cd-theme]{filter:grayscale(1)}');
});

test('ad safety: a covering overlay cannot come from a YouTube element, pseudo-element or descendant', () => {
  for (const css of [
    'ytd-masthead::before{content:"";position:fixed;inset:0;z-index:99;background:#000}',
    'ytd-masthead::after{position:absolute;top:0;left:0;width:100vw;height:100vh;background:#000}',
    'ytd-masthead{position:fixed}', 'ytd-watch-metadata{position:absolute}', 'ytd-comments{z-index:9999}', 'ytd-thumbnail{z-index:1}',
    'ytd-thumbnail{box-shadow:0 0 0 9999px #000}', 'ytd-comments{outline:5000px solid #000}', 'ytd-masthead{transform:scale(40)}',
    '.cd-a ~ ytd-masthead{position:fixed}', 'html[cd-theme] ytd-masthead::before{position:fixed}', '@media print{ytd-masthead{position:fixed}}',
  ]) {
    const r = refused(css);
    assert.ok(r.errors.some((e) => e.code === 'covers-page'), css);
  }
  accepted('.cd-hero::after{content:"";position:absolute;inset:0;background:linear-gradient(transparent,#000)}');
  refusedByProfile('.cd-home{position:relative;z-index:1}');   // a page-level box is not positioned by a theme
  accepted('.cd-home{position:relative;z-index:1}', ENGINE);
  accepted('ytd-masthead{position:relative;position:sticky}', ENGINE);
});

// ---- ad safety: var(), @keyframes and other indirection ----------------------------------------------------------------------

test('ad safety: var() cannot smuggle a hiding value', () => {
  for (const [css, label] of [
    [`html[cd-theme]{--h:none}ytd-ad-slot-renderer{display:var(--h)}`, 'declared value'],
    [`ytd-ad-slot-renderer{display:var(--nothing,none)}`, 'fallback'],
    [`ytd-ad-slot-renderer{display:var(--nothing, none)}`, 'fallback with space'],
    [`html[cd-theme]{--z:0}ytd-ad-slot-renderer{opacity:var(--z)}`, 'number'],
    [`html[cd-theme]{--a:var(--b);--b:none}ytd-ad-slot-renderer{display:var(--a)}`, 'chain of two'],
    [`html[cd-theme]{--a:var(--b);--b:var(--c);--c:var(--d);--d:var(--e);--e:var(--f);--f:none}ytd-ad-slot-renderer{display:var(--a)}`, 'long chain'],
    [`html[cd-theme]{--h:0}ytd-rich-item-renderer{height:var(--h)}`, 'on a container'],
    [`.cd-a{--h:0}html[cd-theme]{--h:0px}ytd-ad-slot-renderer{max-height:var(--h)}`, 'declared twice'],
    [`html[cd-theme]{--x:-9999px}ytd-ad-slot-renderer{left:var(--x)}`, 'offscreen'],
    [`html[cd-theme]{--s:0}ytd-ad-slot-renderer{transform:scale(var(--s))}`, 'inside a function'],
    [`html[cd-theme]{--s:calc(1 - 1)}ytd-ad-slot-renderer{opacity:var(--s)}`, 'calc inside the variable'],
    [`ytd-ad-slot-renderer{opacity:calc(var(--nothing, 0) * 1)}`, 'var inside calc'],
    [`ytd-ad-slot-renderer{color:var(--nothing, transparent)}`, 'transparent fallback'],
    [`html[cd-theme]{--p:fixed}ytd-masthead{position:var(--p)}`, 'overlay position'],
    [`html[cd-theme]{--k:var(--k) none}ytd-ad-slot-renderer{display:var(--k)}`, 'self reference'],
    [`ytd-ad-slot-renderer{display:v\\61r(--nothing,none)}`, 'escaped var'],
    [`ytd-ad-slot-renderer{display:VAR(--nothing,none)}`, 'upper case var'],
  ]) {
    refusedForSafety(css);
    assert.ok(label);
  }
  accepted('html[cd-theme]{--h:flex}ytd-rich-item-renderer{display:var(--h)}', ENGINE);
  accepted('ytd-rich-item-renderer{display:var(--cd-display,block);margin:var(--cd-gap) 0}', ENGINE);
  accepted('ytd-ad-slot-renderer{border-radius:var(--cd-radius);opacity:var(--cd-opacity,1)}', ENGINE);
  accepted('ytd-ad-slot-renderer{border-radius:8px}');
  refusedByProfile('ytd-ad-slot-renderer{border-radius:var(--cd-radius)}');   // an ad frame is rounded by at most 12px (the radius token goes to 32px)
});

test('ad safety: var() chains and cycles are bounded and answered conservatively', () => {
  const chain = Array.from({ length: 200 }, (_, i) => `--v${i}:var(--v${i + 1})`).join(';');
  accepted(`html[cd-theme]{${chain};--v200:block}ytd-comments{display:var(--v0)}`, ENGINE);
  accepted('html[cd-theme]{--a:var(--b) var(--b);--b:var(--a) var(--a)}ytd-ad-slot-renderer{border-radius:var(--a)}', ENGINE);
  const t0 = performance.now();
  refusedForSafety(`html[cd-theme]{${Array.from({ length: 30 }, (_, i) => `--m${i}:var(--m${i + 1}) var(--m${i + 1})`).join(';')};--m30:none}ytd-ad-slot-renderer{display:var(--m0)}`);
  assert.ok(performance.now() - t0 < 1000);
});

test('ad safety: @keyframes that hide cannot be applied to protected elements or containers', () => {
  const frames = '@keyframes cd-x{from{opacity:1}to{opacity:0}}';
  for (const sel of ['ytd-ad-slot-renderer', 'ytd-rich-item-renderer', '#contents', '.ytp-chrome-bottom']) {
    refusedForSafety(`${frames}${sel}{animation:cd-x 1s forwards}`);
    refusedForSafety(`${sel}{animation:cd-x 1s}${frames}`);
    refusedForSafety(`${frames}${sel}{animation-name:cd-x}`);
    refusedForSafety(`${frames}${sel}{animation: 1s ease-in 0s infinite alternate both running cd-x}`);
    refusedForSafety(`${sel}{animation:ytSpin 1s}`);
    refusedForSafety(`${sel}{-webkit-animation:ytSpin 1s}`);
  }
  for (const body of ['to{display:none}', 'to{visibility:hidden}', 'to{height:0}', 'to{transform:scale(0)}', 'to{left:-9999px}', '50%{opacity:.5}', 'to{pointer-events:none}']) {
    refusedForSafety(`@keyframes cd-h{${body}}ytd-ad-slot-renderer{animation:cd-h 1s}`);
  }
  accepted(`${frames}.cd-card{animation:cd-x 1s forwards}`);
  accepted('@keyframes cd-in{from{transform:translateY(8px)}to{transform:none}}ytd-rich-item-renderer{animation:cd-in .3s ease}', ENGINE);
  refusedByProfile('@keyframes cd-in{from{transform:translateY(8px)}to{transform:none}}ytd-rich-item-renderer{animation:cd-in .3s ease}');
  accepted('@keyframes cd-glow{from{box-shadow:0 0 0 var(--cd-accent)}to{box-shadow:0 0 8px var(--cd-accent)}}ytd-rich-item-renderer{animation:cd-glow .3s ease}');
  accepted('ytd-rich-item-renderer{animation:none}');
  accepted('ytd-rich-item-renderer{animation:cd-undefined 1s}', ENGINE);
  refusedByProfile('ytd-rich-item-renderer{animation:cd-undefined 1s}');
  accepted('.cd-card{animation:ytSpin 1s}');
});

// ---- describeHiding: the declaration classifier on its own ------------------------------------------------------------------

test('describeHiding classifies single declarations', () => {
  const hiding = [['display', 'none'], ['DISPLAY', 'None'], ['d\\isplay', 'none'], ['dis/**/play', 'none'], ['-webkit-opacity', '0'], ['opacity', '.99'], ['height', '0'], ['font-size', '0'],
    ['color', 'transparent'], ['transform', 'scale(0)'], ['left', '-9999px'], ['all', 'unset'], ['visibility', 'hidden'], ['clip-path', 'circle(0)'], ['filter', 'opacity(0)'],
    ['position', 'fixed'], ['z-index', '-1'], ['pointer-events', 'none'], ['content-visibility', 'hidden'], ['contain', 'size'], ['mask', 'linear-gradient(#000,transparent)'],
    ['max-height', 'calc(100% - 100%)'], ['animation', 'someOutsideName 1s']];
  for (const [p, v] of hiding) assert.equal(typeof describeHiding(p, v), 'string', `${p}: ${v}`);
  const harmless = [['display', 'flex'], ['display', 'block !important'], ['opacity', '1'], ['opacity', '100%'], ['opacity', 'inherit'], ['height', '3px'], ['height', 'auto'], ['width', 'calc(100% - 24px)'],
    ['font-size', '12px'], ['font-size', '1em'], ['color', 'red'], ['color', 'rgba(0,0,0,.5)'], ['color', '#00000080'], ['transform', 'translateY(-4px) scale(1.02)'], ['transform', 'none'],
    ['left', '12px'], ['margin', '0 auto'], ['margin-left', '-16px'], ['filter', 'grayscale(1)'], ['clip-path', 'none'], ['clip-path', 'inset(0 round 8px)'], ['position', 'relative'],
    ['position', 'sticky'], ['z-index', '0'], ['z-index', 'auto'], ['pointer-events', 'auto'], ['visibility', 'visible'], ['mask', 'none'], ['border-radius', '8px'], ['background', 'transparent'],
    ['min-width', '10px'], ['flex', '1 1 0'], ['grid-template-columns', 'repeat(auto-fill,minmax(0,1fr))'], ['contain', 'layout paint'], ['mix-blend-mode', 'normal'], ['animation', 'cd-x 1s']];
  for (const [p, v] of harmless) assert.equal(describeHiding(p, v), null, `${p}: ${v} -> ${describeHiding(p, v)}`);
  assert.equal(describeHiding(undefined, undefined), null);
});

// ---- line and column accuracy ------------------------------------------------------------------------------------------------

test('line numbers are exact for every kind of error in a multi-line stylesheet', () => {
  const css = [
    '/* line 1 */',                                       // 1
    '.cd-card {',                                         // 2
    '  color: red;',                                      // 3
    '  background: url(https://evil.example/a.png);',     // 4
    '}',                                                  // 5
    '',                                                   // 6
    '@media (min-width: 100px) {',                        // 7
    '  .foo { border-radius: 4px }',                      // 8
    '}',                                                  // 9
    'ytd-ad-slot-renderer {',                             // 10
    '  border-radius: 4px;',                              // 11
    '  display: none;',                                   // 12
    '}',                                                  // 13
    '@keyframes spin { from { color: red } }',            // 14
    '.cd-card::after { content: "' + 'x'.repeat(120) + '"; }', // 15
    '.cd-a { width: expression(1) }',                     // 16
  ].join('\n');
  const r = refused(css);
  const at = (line) => r.errors.filter((e) => e.line === line);
  assert.equal(at(4).length, 1);
  assert.equal(at(4)[0].column, css.split('\n')[3].indexOf('url(') + 1);
  assert.equal(at(8).length, 1);
  assert.equal(at(8)[0].column, css.split('\n')[7].indexOf('.foo') + 1);
  assert.equal(at(12).length, 1, JSON.stringify(r.errors));
  assert.equal(at(12)[0].column, 3, 'the hiding declaration is reported where its property name starts');
  assert.equal(at(12)[0].code, 'hides-protected');
  assert.equal(at(14).length, 1);
  assert.equal(at(14)[0].column, css.split('\n')[13].indexOf('spin') + 1);
  assert.equal(at(15).length, 1);
  assert.equal(at(15)[0].column, css.split('\n')[14].indexOf('content') + 1);
  assert.equal(at(16).length, 1);
  assert.equal(at(16)[0].column, css.split('\n')[15].indexOf('expression') + 1);
  assert.deepEqual(r.errors.map((e) => e.line), [4, 8, 12, 14, 15, 16], 'errors come in source order, one each');
  for (const e of r.errors) assert.equal(e.text, `Line ${e.line}: ${e.message}`);
});

test('line counting handles CRLF, lone CR, form feed and unicode before the error', () => {
  const lines = ['.cd-a{border-radius:4px}', '.cd-b{border-radius:4px}', '@import "x";'];
  for (const [name, sep] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r'], ['FF', '\f'], ['mixed', '\r\n']]) {
    const css = name === 'mixed' ? `${lines[0]}\r\n${lines[1]}\n\r${lines[2]}` : lines.join(sep);
    const r = refused(css, /@import/);
    // mixed: "\r\n", then "\n", then a lone "\r" ("\n\r" is two breaks, not one) = three breaks, so the import is on line 4
    assert.equal(r.errors[0].line, name === 'mixed' ? 4 : 3, name);
    assert.equal(r.errors[0].column, 1, name);
  }
  const r = refused('.cd-a{content:"😀😀"} @import "x";');
  assert.equal(r.errors[0].line, 1);
  assert.equal(r.errors[0].column, '.cd-a{content:"😀😀"} '.length + 1, 'columns count UTF-16 code units');
});

test('structural errors are reported where the problem starts', () => {
  let r = refused('.cd-a{border-radius:4px}\n\n.cd-b {\n  color: red;\n');
  assert.equal(r.errors[0].line, 3);
  assert.equal(r.errors[0].column, 7, 'the unclosed "{" of ".cd-b {" is column 7');
  r = refused('.cd-a{border-radius:4px}\n\n/* never closed\nstill comment');
  assert.equal(r.errors[0].line, 3);
  assert.equal(r.errors[0].column, 1);
  r = refused('.cd-a{border-radius:4px}\n.cd-b{content:"never closed}\n.cd-c{border-radius:4px}', /Unterminated string/);
  assert.equal(r.errors[0].line, 2);
  const bad = r.errors.find((e) => /Unterminated string/.test(e.message));
  assert.equal(bad.line, 2);
  assert.equal(bad.column, 15, 'the opening quote: ".cd-b{content:" is 14 characters');
  r = refused('.cd-a{border-radius:4px}\n\n}\n');
  assert.equal(r.errors[0].line, 3);
});

test('a flood of errors is capped, and every error is still in source order', () => {
  const css = Array.from({ length: 300 }, (_, i) => `.nope${i}{border-radius:4px}`).join('\n');
  const r = refused(css);
  assert.equal(r.errors.length, 50);
  assert.deepEqual(r.errors.map((e) => e.line), Array.from({ length: 50 }, (_, i) => i + 1));
});

test('one hiding declaration gives one error even when several selectors in the list are bad', () => {
  const r = refusedForSafety('ytd-ad-slot-renderer, #masthead-ad, .ytp-chrome-bottom {\n  display: none;\n}');
  assert.equal(r.errors.length, 1);
  assert.equal(r.errors[0].line, 2);
});

test('size limit: more than LIMITS.cssMaxBytes of UTF-8 is refused up front', () => {
  assert.equal(LIMITS.cssMaxBytes, 20480);
  const base = '.cd-a{border-radius:4px}/*';
  const ok = `${base}${'x'.repeat(LIMITS.cssMaxBytes - base.length - 2)}*/`;
  assert.equal(Buffer.byteLength(ok), LIMITS.cssMaxBytes);
  accepted(ok);
  const r = refused(`${ok}x`, /limit is 20480/);
  assert.equal(r.errors[0].code, 'size');
  refused(`${'/*'}${'é'.repeat(10300)}*/`, /bytes; the limit/);
  accepted(ok.replace('/*', '/*'), { ...CTX, maxBytes: 1e6 });
  accepted(`${ok}${'/* more */'.repeat(100)}`, { ...CTX, maxBytes: 1e6 });
  refused(ok, /limit is 100/, { ...CTX, maxBytes: 100 });
});

// ---- robustness: garbage, pathological nesting, speed -------------------------------------------------------------------------

function lcg(seed) {
  let s = seed >>> 0;
  return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
}
const FUZZ_TOKENS = ['{', '}', '(', ')', '[', ']', ';', ':', ',', '"', "'", '\\', '/*', '*/', '/', '*', '@media', '@import', '@keyframes', '.cd-a', '#cd-b', 'ytd-ad-slot-renderer', 'display', 'none',
  '!important', ' ', '\n', '\r\n', '\f', 'url(', 'var(--x', 'calc(', ':is(', ':not(', ':has(', '>', '+', '~', '-', '0', '1.5e3px', '%', '<!--', '-->', '\u0000', '‮', 'é', '😀',
  '\\9', '\\6e one', 'cd-', 'html', '=', '^=', '|=', '$=', '*=', 'opacity', 'expression(', 'transparent', 'scale(0)'];
const SEED_CSS = ['.cd-hero h1{letter-spacing:-.02em}', 'html[cd-theme] ytd-rich-item-renderer{border-radius:var(--cd-radius)}', '@media (min-width:10px){.cd-a:not(.cd-b){color:red;--x:1}}',
  '@keyframes cd-x{from{opacity:0}to{opacity:1}}.cd-a{animation:cd-x 1s}', 'ytd-ad-slot-renderer{display:none}', '.cd-a{background:url("data:image/png;base64,AAA=")}'];

test('fuzz: random garbage and mutated stylesheets never throw, always return a consistent result, and stay fast', () => {
  const rnd = lcg(20261007);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  let slowest = 0;
  let accepted_ = 0;
  const run = (css) => {
    const t0 = performance.now();
    let r;
    assert.doesNotThrow(() => { r = check(css); }, JSON.stringify(css.slice(0, 120)));
    slowest = Math.max(slowest, performance.now() - t0);
    assert.equal(typeof r.ok, 'boolean');
    assert.ok(Array.isArray(r.errors));
    assert.equal(r.ok, r.errors.length === 0, 'ok is exactly "no errors"');
    assert.ok(r.errors.length <= 50);
    let prev = 0;
    for (const e of r.errors) {
      assert.ok(Number.isInteger(e.line) && e.line >= 1 && Number.isInteger(e.column) && e.column >= 1, JSON.stringify(e));
      assert.equal(typeof e.message, 'string');
      assert.ok(e.message.length > 0);
      assert.ok(e.line >= prev, 'sorted by line');
      prev = e.line;
    }
    if (r.ok) accepted_++;
  };
  for (let i = 0; i < 6000; i++) {
    let s = '';
    const n = 1 + Math.floor(rnd() * 50);
    for (let k = 0; k < n; k++) s += pick(FUZZ_TOKENS);
    run(s);
  }
  for (let i = 0; i < 6000; i++) {
    const arr = [...pick(SEED_CSS)];
    const edits = 1 + Math.floor(rnd() * 6);
    for (let k = 0; k < edits; k++) {
      const at = Math.floor(rnd() * (arr.length + 1));
      const op = rnd();
      if (op < 0.4) arr.splice(at, 0, pick(FUZZ_TOKENS));
      else if (op < 0.7) arr.splice(at, Math.floor(rnd() * 5));
      else arr.splice(at, 0, ...arr.slice(Math.floor(rnd() * arr.length), Math.floor(rnd() * arr.length) + 5));
    }
    run(arr.join(''));
  }
  for (let i = 0; i < 60; i++) {
    let s = '';
    for (let k = 0; k < 2000; k++) s += pick(FUZZ_TOKENS);
    run(s);
  }
  assert.ok(slowest < 100, `slowest single run took ${slowest.toFixed(1)} ms`);
  assert.ok(accepted_ >= 0);
});

test('fuzz: mutated stylesheets that hide an ad are never accepted by accident', () => {
  const rnd = lcg(7);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const hides = ['display:none', 'opacity:0', 'height:0', 'visibility:hidden', 'transform:scale(0)', 'left:-9999px', 'color:transparent', 'pointer-events:none'];
  // Whitespace and comments around the punctuation are meaning-neutral; a comment inside a name or value splits it into different tokens.
  // (Not around parentheses: "scale (0)" is not a function call, so that really is a different declaration.)
  const squash = (s) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s*([{}:;,])\s*/g, '$1').replace(/\s+/g, ' ').trim();
  let tried = 0;
  let preserved = 0;
  for (let i = 0; i < 3000; i++) {
    const css = `${pick(AD_TARGETS)}{${pick(hides)}}`;
    const open = css.indexOf('{');
    const colon = css.indexOf(':');
    const boundaries = [0, open, open + 1, colon, colon + 1, css.length - 1, css.length];
    const cuts = new Set();
    for (let k = 0; k < 3; k++) cuts.add(rnd() < 0.6 ? pick(boundaries) : Math.floor(rnd() * (css.length + 1)));
    let mutated = css;
    // Insert from the back so the earlier cut positions stay valid.
    for (const at of [...cuts].sort((a, b) => b - a)) mutated = mutated.slice(0, at) + pick([' ', '\n', '/**/', '\t', '/* x */']) + mutated.slice(at);
    const r = check(mutated);
    tried++;
    if (squash(mutated) === css) {
      // Same tokens, different spacing: the ad must still be protected.
      preserved++;
      assert.equal(r.ok, false, mutated);
      assert.ok(r.errors.some((e) => SAFETY_CODES.has(e.code)), mutated);
    }
    // A comment that splits a name or value (e.g. "transp/* x */arent") produces different tokens; the browser drops such a declaration,
    // so the validator is free to accept it (it does not validate colour or keyword syntax), and nothing is asserted for those.
  }
  assert.equal(tried, 3000);
  assert.ok(preserved > 500, `only ${preserved} meaning-preserving mutations were exercised`);
});

test('pathological nesting and sizes terminate quickly and are refused (size cap lifted)', () => {
  const big = { ...CTX, maxBytes: 1e9 };
  const cases = {
    parens: '('.repeat(200000), closeParens: ')'.repeat(100000), braces: '{'.repeat(100000), brackets: '['.repeat(100000), nestedMedia: '@media a{'.repeat(50000),
    nestedMediaShallow: `${'@media a{'.repeat(20)}.cd-a{border-radius:4px}${'}'.repeat(20)}`, deepIs: `.cd-a${':is('.repeat(50000)}.cd-b${')'.repeat(50000)}`, deepNot: `${':not('.repeat(8)}.cd-a${')'.repeat(8)}{border-radius:4px}`,
    longIdent: `.${'a'.repeat(2e6)}{border-radius:4px}`, longString: `.cd-a{content:"${'x'.repeat(2e6)}"}`, unterminatedComment: `/*${'x'.repeat(1e6)}`, unterminatedString: `"${'x'.repeat(1e6)}`,
    manyAlternatives: `ytd-rich-item-renderer:is(${Array.from({ length: 5000 }, (_, i) => `ytd-foo-${i}`).join(',')}){display:none}`, nuls: '\u0000'.repeat(100000), bidi: '‮'.repeat(1000),
    deepCalc: `.cd-a{width:${'calc('.repeat(60)}1px${')'.repeat(60)}}`, hexEscapes: `.cd-a{content:"${'\\0000'.repeat(100000)}"}`,
    varBomb: `html[cd-theme]{${Array.from({ length: 400 }, (_, i) => `--a${i}:var(--a${i + 1}) var(--a${i + 1})`).join(';')}}ytd-ad-slot-renderer{display:var(--a0)}`,
  };
  for (const [name, css] of Object.entries(cases)) {
    const t0 = performance.now();
    const r = check(css, big);
    const ms = performance.now() - t0;
    assert.equal(typeof r.ok, 'boolean', name);
    assert.ok(ms < 2000, `${name} took ${ms.toFixed(0)} ms`);
    if (!['nestedMediaShallow', 'deepCalc'].includes(name)) assert.equal(r.ok, false, name);
  }
  // With the default cap the same inputs are answered immediately.
  for (const [name, css] of Object.entries(cases)) {
    if (css.length <= LIMITS.cssMaxBytes) continue;
    const t0 = performance.now();
    assert.equal(check(css).ok, false, name);
    assert.ok(performance.now() - t0 < 50, name);
  }
});

test('performance: 20 KB of theme CSS validates in well under 20 ms', () => {
  const gen = (kind) => {
    let out = '';
    for (let i = 1; out.length < LIMITS.cssMaxBytes - 300; i++) {
      if (kind === 'own') out += `.cd-card-${i} > .cd-card-title:hover, .cd-row-${i} .cd-hero-meta{color:var(--cd-text);background:linear-gradient(135deg,var(--cd-surface),var(--cd-bg));border-radius:calc(var(--cd-radius) * 1.5);box-shadow:0 0 0 1px var(--cd-accent),0 0 18px var(--cd-accent);transition:transform var(--cd-duration) ease}\n`;
      else if (kind === 'youtube') out += `html[cd-theme] ytd-rich-item-renderer:nth-child(${i}) yt-lockup-view-model .ytLockupMetadataViewModelTitle{border-radius:var(--cd-radius);border:1px solid var(--cd-border);color:var(--cd-text);box-shadow:var(--cd-shadow);transition:color var(--cd-duration) ease}\n`;
      else out += `@media (min-width:${i}px){.cd-card-${i}{width:calc(100% - ${i}px);padding:${i % 20}px;font-family:Georgia,"Times New Roman",serif;font-weight:600;font-size:14px;line-height:1.2}}\n`;
    }
    return out;
  };
  for (const kind of ['own', 'youtube', 'media']) {
    const css = gen(kind);
    assert.ok(Buffer.byteLength(css) <= LIMITS.cssMaxBytes && Buffer.byteLength(css) > 19000, kind);
    accepted(css);
    for (let w = 0; w < 8; w++) check(css);
    const times = [];
    for (let i = 0; i < 40; i++) {
      const t0 = performance.now();
      check(css);
      times.push(performance.now() - t0);
    }
    times.sort((a, b) => a - b);
    // Best of 40: a real slowdown makes every run slow, CPU contention from parallel test files only some of them.
    assert.ok(times[0] < 20, `${kind}: best of 40 ${times[0].toFixed(1)} ms (median ${times[20].toFixed(1)} ms)`);
  }
});

// ---- the allow-list and the engine's own guard in a real DOM -----------------------------------------------------------------

test('buildAllowList tolerates broken maps and never throws', () => {
  for (const map of [undefined, null, 0, 'x', [], {}, { roles: null }, { roles: { a: 'x' } }, { roles: { a: [1, null, {}, '{{{'] } }, { protected: { ads: 'x' } },
    { roles: new Proxy({}, { ownKeys() { throw new Error('boom'); } }) }, JSON.parse('{"roles":{"__proto__":["a"]}}')]) {
    const a = buildAllowList(map);
    assert.ok(a.classes instanceof Set && a.ids instanceof Set && a.tags instanceof Set && a.attributes instanceof Set);
  }
  const a = buildAllowList({ roles: { x: ['ytd-foo.bar#baz[qux]:not(.nested)'] }, protected: { ads: ['.ad'], sponsor: [], playerControls: [], containers: ['#c'] } });
  assert.deepEqual([...a.classes].sort(), ['ad', 'bar', 'nested']);
  assert.deepEqual([...a.ids].sort(), ['baz', 'c']);
  assert.deepEqual([...a.tags], ['ytd-foo']);
  assert.deepEqual([...a.attributes], ['qux']);
  assert.deepEqual(a.protected.ads, ['.ad']);
});

for (const tileStyle of ['grid', 'home']) {
  test(`jsdom (${tileStyle} tiles): a safeHide rule the validator accepts hides tiles but never the in-feed ad item`, () => {
    const { document, window } = createPage('home', { tiles: 8, ads: 2, tileStyle });
    const css = `${safeHide(MAP, 'ytd-rich-item-renderer')}{display:none !important}`;
    accepted(css, ENGINE);
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const items = [...document.querySelectorAll('ytd-rich-item-renderer')];
    const adItems = items.filter((i) => i.querySelector('ytd-ad-slot-renderer'));
    assert.equal(adItems.length, 2);
    assert.ok(items.length >= 10);
    for (const item of items) {
      const hidden = window.getComputedStyle(item).display === 'none';
      assert.equal(hidden, !adItems.includes(item), adItems.includes(item) ? 'the ad item was hidden' : 'a normal tile stayed visible');
    }
    // The unguarded rule the validator refuses is exactly the one that would hide the ad as well.
    refusedForSafety('ytd-rich-item-renderer{display:none !important}');
    style.textContent = 'ytd-rich-item-renderer{display:none !important}';
    for (const ad of adItems) assert.equal(window.getComputedStyle(ad).display, 'none', 'the refused rule really would hide the ad');
    // Hiding the masthead ad slot's wrapper is impossible with the guard: the rich grid always holds #masthead-ad.
    style.textContent = `${safeHide(MAP, 'ytd-rich-grid-renderer')}{display:none !important}`;
    assert.notEqual(window.getComputedStyle(document.querySelector('ytd-rich-grid-renderer')).display, 'none');
    window.close();
  });
}

test('jsdom (watch): guarded wrapper hides never match; leaf hides do; the ad, sponsor label and controls stay', () => {
  const { document, window } = createPage('watch', { tiles: 4, ads: true });
  const style = document.createElement('style');
  document.head.appendChild(style);
  const display = (sel) => window.getComputedStyle(document.querySelector(sel)).display;
  for (const wrapper of ['#related', '#movie_player', 'ytd-watch-flexy', '#secondary', '#primary']) {
    accepted(`${safeHide(MAP, wrapper)}{display:none !important}`, ENGINE);
    style.textContent = `${safeHide(MAP, wrapper)}{display:none !important}`;
    assert.notEqual(display(wrapper), 'none', `${wrapper} holds an ad slot, so the guarded rule must not match`);
  }
  accepted(`${safeHide(MAP, 'ytd-comments')}{display:none !important}`, ENGINE);
  style.textContent = `${safeHide(MAP, 'ytd-comments')}{display:none !important}`;
  assert.equal(display('ytd-comments'), 'none');
  for (const protectedSel of ['.ytp-ad-module', '.ytp-paid-content-overlay', '.ytp-chrome-bottom', 'ytd-ad-slot-renderer']) {
    assert.ok(document.querySelector(protectedSel), `${protectedSel} exists on the watch fixture`);
    assert.notEqual(display(protectedSel), 'none');
  }
  // Restyling those same elements is allowed and does not hide them.
  const restyle = '.ytp-paid-content-overlay{border:1px solid var(--cd-border);border-radius:4px}ytd-ad-slot-renderer{border-radius:8px}.ytp-chrome-bottom{border-bottom:2px solid var(--cd-accent)}';
  accepted(restyle);
  style.textContent = restyle;
  for (const protectedSel of ['.ytp-paid-content-overlay', '.ytp-chrome-bottom', 'ytd-ad-slot-renderer']) assert.notEqual(display(protectedSel), 'none');
  window.close();
});
