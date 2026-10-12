// What jsdom's selector engine and CSS engine can and cannot do. The ad-safety tests (ARCHITECTURE.md section 6)
// depend on :not(:has(<ads>)), so this file fails LOUDLY if that ever stops working.
//
// Verified result (jsdom 29.1.1, Node 25): :has(), :is(), :where(), :not(:has(...)), relative :has(> a > b) and attribute
// selectors on custom elements all work in querySelector/querySelectorAll/matches/closest AND in getComputedStyle for
// top-level rules. Known gaps, each pinned by a test below so an upgrade that changes them is noticed:
//   1. duplicate ids: el.querySelector('#x') returns null when an earlier element OUTSIDE el has the same id (dom.js fixes it)
//   2. rules inside @media/@supports are parsed (cssRules) but never applied by getComputedStyle
//   3. no layout (every rect is 0), no document.adoptedStyleSheets, no IntersectionObserver/ResizeObserver/matchMedia (shimmed)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createPage, selectorSupported, rewriteIdSelectors, installIdFix, installShims } from './dom.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const ids = (doc, sel) => [...doc.querySelectorAll(sel)].map((e) => e.id || e.tagName.toLowerCase());
const count = (doc, sel) => doc.querySelectorAll(sel).length;

// ---- the canary --------------------------------------------------------------------------------------------------

test('CANARY: jsdom supports :has() - ad-safety tests depend on it', () => {
  const { window } = new JSDOM('<body><div id="a"><p></p></div><div id="b"></div></body>');
  assert.equal(
    selectorSupported(window, 'div:has(p)'),
    true,
    ':has() is NOT supported by this jsdom. The ad-safety tests need it: upgrade jsdom, or add a matches(el, selectorWithHas) fallback to test/helpers/dom.js before trusting any "never hides ads" result.',
  );
  assert.deepEqual(ids(window.document, 'div:has(p)'), ['a']);
  assert.deepEqual(ids(window.document, 'div:not(:has(p))'), ['b']);
});

// ---- selector features on a realistic page ------------------------------------------------------------------------

test(':has / :not(:has) separate ad items from content items (feed grid)', () => {
  const { document } = createPage('home', { tiles: 6, ads: 2 });
  assert.equal(count(document, 'ytd-rich-item-renderer'), 8);
  assert.equal(count(document, 'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)'), 2);
  assert.equal(count(document, 'ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))'), 6);
  assert.equal(count(document, 'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)'), 2);
  assert.equal(count(document, 'ytd-rich-item-renderer:has(> #content > yt-lockup-view-model)'), 6);
  assert.equal(count(document, 'ytd-rich-item-renderer:has(a[href^="/watch"])'), 6);
});

test(':not(:has(<a, list, of, ads>)) - the shape safeHide() produces', () => {
  const { document } = createPage('watch', { tiles: 4, ads: true });
  const guard = ':not(:has(ytd-ad-slot-renderer, .ytp-ad-module, .ytp-paid-content-overlay-text))';
  assert.equal(count(document, `yt-lockup-view-model${guard}`), 4);
  assert.equal(count(document, `#movie_player${guard}`), 0, 'the player holds .ytp-ad-module so the guard excludes it');
  assert.equal(count(document, `ytd-watch-flexy${guard}`), 0);
  assert.equal(count(document, `#related${guard}`), 0, '#related holds ytd-ad-slot-renderer');
  assert.equal(count(document, `#primary-inner > #below${guard}`), 1, 'the metadata/comments block holds no ads');
});

test(':is() and :where() accept selector lists', () => {
  const { document } = createPage('home', { tiles: 3, shorts: true });
  assert.equal(count(document, ':is(ytd-rich-item-renderer, ytd-rich-section-renderer, ytd-nope)'), 7, '3 tiles + the shelf section + its 3 Shorts items');
  assert.equal(count(document, ':where(ytd-rich-shelf-renderer[is-shorts], ytd-reel-shelf-renderer)'), 1);
  assert.equal(count(document, 'ytd-rich-grid-renderer :is(#contents, #header) > ytd-rich-item-renderer'), 6);
  assert.equal(count(document, ':is(ytd-rich-item-renderer, ytd-video-renderer):has(a[href^="/shorts/"])'), 3);
  assert.equal(count(document, ':is(ytd-rich-item-renderer):not(:has(a[href^="/shorts/"]))'), 3);
  assert.equal(count(document, ':is(.nonexistent-a, .nonexistent-b)'), 0);
});

test('attribute selectors on custom elements: presence, =, ^=, $=, *=, ~=, and the i flag', () => {
  const { document } = createPage('home', { tiles: 4, shorts: true });
  assert.equal(count(document, 'ytd-browse[page-subtype]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype="home"]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype^="ho"]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype$="me"]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype*="om"]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype="HOME" i]'), 1);
  assert.equal(count(document, 'ytd-browse[page-subtype="HOME"]'), 0);
  assert.equal(count(document, 'ytd-rich-shelf-renderer[is-shorts]'), 1);
  assert.equal(count(document, 'ytd-rich-item-renderer[is-shorts-grid]'), 3);
  assert.equal(count(document, 'ytd-rich-grid-renderer[is-default-grid]:not([is-slim-grid])'), 1);
  assert.equal(count(document, '[class~="ytLockupViewModelWrapper"]'), 4);
  assert.equal(count(document, 'div[class*="ytLockupViewModelVertical"]'), 4);
  assert.equal(count(document, 'html[dark]'), 1);
  assert.equal(count(document, 'html[dark][darker-dark-theme]'), 1);
  assert.equal(count(document, 'a[href^="/shorts/"]'), 7, '3 Shorts x (thumbnail + title link) + the mini-guide Shorts entry');
  assert.equal(count(document, 'ytd-mini-guide-entry-renderer a[href^="/shorts"]'), 1);
});

test('matches() and closest() accept :has() and :not(:has())', () => {
  const { document } = createPage('home', { tiles: 3, ads: true });
  const ad = document.querySelector('ytd-ad-slot-renderer');
  const item = ad.closest('ytd-rich-item-renderer');
  assert.ok(item.matches('ytd-rich-item-renderer:has(ytd-ad-slot-renderer)'));
  assert.ok(!item.matches('ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))'));
  assert.equal(ad.closest('ytd-rich-item-renderer:has(ytd-ad-slot-renderer)'), item);
  assert.equal(ad.closest('ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))'), null);
  const tile = document.querySelector('ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))');
  assert.ok(tile.matches(':is(ytd-rich-item-renderer, ytd-video-renderer):has(yt-lockup-view-model)'));
});

test(':has() with sibling and descendant relative selectors', () => {
  const { document } = createPage('home', { tiles: 4 });
  assert.equal(count(document, 'ytd-rich-item-renderer:has(+ ytd-rich-item-renderer)'), 3, 'all but the last item have a next sibling item');
  assert.equal(count(document, 'ytd-rich-item-renderer:has(~ ytd-continuation-item-renderer)'), 4);
  assert.equal(count(document, '#contents:has(> ytd-continuation-item-renderer)'), 1);
  assert.equal(count(document, 'ytd-rich-grid-renderer:has(ytd-continuation-item-renderer) #contents'), 1);
});

test('structural pseudo-classes used by the CSS builders', () => {
  const { document } = createPage('home', { tiles: 5 });
  assert.equal(count(document, 'ytd-rich-grid-renderer #contents > ytd-rich-item-renderer:first-child'), 1);
  assert.equal(count(document, 'ytd-rich-grid-renderer #contents > ytd-rich-item-renderer:nth-child(2n)'), 2);
  assert.equal(count(document, 'ytd-continuation-item-renderer:last-child'), 1);
  assert.equal(count(document, '#masthead-ad:empty'), 2, 'both #masthead-ad containers (ytd-browse and the grid) are empty without ads');
  assert.equal(count(document, 'ytd-mini-guide-renderer[hidden]'), 1);
  assert.equal(count(document, 'ytd-rich-item-renderer:not([hidden])'), 5);
});

// ---- selectorSupported -------------------------------------------------------------------------------------------

test('selectorSupported() reports invalid selectors without throwing', () => {
  const { window } = createPage('home', { tiles: 1 });
  assert.equal(selectorSupported(window, 'ytd-rich-item-renderer:has(a)'), true);
  assert.equal(selectorSupported(window, 'ytd-rich-item-renderer:has('), false);
  assert.equal(selectorSupported(window, '::definitely-not-real:::'), false);
});

// ---- CSS parsing and getComputedStyle ---------------------------------------------------------------------------

function inject(page, css) {
  const style = page.document.createElement('style');
  style.textContent = css;
  page.document.head.appendChild(style);
  return style;
}
const disp = (page, el) => page.window.getComputedStyle(el).display;

test('stylesheets keep :not(:has()) rules and getComputedStyle applies them (ad items stay visible)', () => {
  const page = createPage('home', { tiles: 6, ads: 2 });
  const style = inject(page, 'ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer)) { display: none !important; }');
  assert.equal(style.sheet.cssRules.length, 1, 'the :has rule must survive parsing (style-injector verifies cssRules.length)');
  assert.match(style.sheet.cssRules[0].selectorText, /:not\(:has\(ytd-ad-slot-renderer\)\)/);
  const items = [...page.document.querySelectorAll('ytd-rich-item-renderer')];
  const hidden = items.filter((el) => disp(page, el) === 'none');
  const shown = items.filter((el) => disp(page, el) !== 'none');
  assert.equal(hidden.length, 6);
  assert.equal(shown.length, 2);
  assert.ok(shown.every((el) => el.querySelector('ytd-ad-slot-renderer')), 'every visible item is an ad item');
});

test('custom properties and attribute-gated rules (the cd-* contract on <html>) resolve in getComputedStyle', () => {
  const page = createPage('home', { tiles: 2 });
  inject(page, 'html[cd-theme] { --cd-bg: #101010; } html[cd-calm-hideShorts] ytd-rich-shelf-renderer[is-shorts] { display: none; }');
  const root = page.document.documentElement;
  assert.equal(page.window.getComputedStyle(root).getPropertyValue('--cd-bg').trim(), '');
  root.setAttribute('cd-theme', 'cinema');
  assert.equal(page.window.getComputedStyle(root).getPropertyValue('--cd-bg').trim(), '#101010');
});

test('LIMITATION: rules inside @media / @supports are parsed but NOT applied by getComputedStyle', (t) => {
  const page = createPage('home', { tiles: 1 });
  const style = inject(page, '@media (min-width: 1px) { ytd-rich-item-renderer { display: none; } } @supports (display: grid) { ytd-rich-grid-renderer { display: none; } }');
  assert.equal(style.sheet.cssRules.length, 2, 'parsed: both at-rules are in cssRules');
  assert.equal(style.sheet.cssRules[0].constructor.name, 'CSSMediaRule');
  const item = page.document.querySelector('ytd-rich-item-renderer');
  const applied = disp(page, item) === 'none';
  t.diagnostic(`@media rules applied by getComputedStyle: ${applied}`);
  assert.equal(applied, false, 'jsdom started applying @media rules - update test/fixtures/README.md and dom.js header, then flip this test');
  // Consequence for ad-safety tests: they must evaluate generated CSS statically (selector scan) or flatten at-rules first.
});

test('LIMITATION: jsdom has no layout, no adoptedStyleSheets; dom.js shims the observer/matchMedia gaps', () => {
  const bare = new JSDOM('<body><div id="x"></div></body>', { pretendToBeVisual: true });
  const w = bare.window;
  const rect = w.document.getElementById('x').getBoundingClientRect();
  assert.deepEqual([rect.x, rect.y, rect.width, rect.height, rect.top, rect.left], [0, 0, 0, 0, 0, 0]);
  assert.equal('adoptedStyleSheets' in w.document, false, 'constructable-stylesheet CSP fallback cannot be exercised in jsdom');
  for (const api of ['matchMedia', 'IntersectionObserver', 'ResizeObserver']) assert.equal(typeof w[api], 'undefined', `bare jsdom has no ${api}`);
  assert.equal(typeof w.requestAnimationFrame, 'function', 'pretendToBeVisual provides rAF');
  assert.equal(typeof w.MutationObserver, 'function');
  installShims(w);
  for (const api of ['matchMedia', 'IntersectionObserver', 'ResizeObserver']) assert.notEqual(typeof w[api], 'undefined', `shimmed ${api}`);
  assert.equal(w.matchMedia('(prefers-reduced-motion: reduce)').matches, false);
  assert.equal(w.CSS.supports('display', 'grid'), true);
});

test('matchMedia shim: reduced motion can be flipped live and listeners fire', () => {
  const page = createPage('home', { tiles: 1, reducedMotion: false });
  const mql = page.window.matchMedia('(prefers-reduced-motion: reduce)');
  const seen = [];
  mql.addEventListener('change', (e) => seen.push(e.matches));
  assert.equal(mql.matches, false);
  page.window.__cd.setReducedMotion(true);
  assert.equal(mql.matches, true);
  assert.deepEqual(seen, [true]);
  assert.equal(createPage('home', { tiles: 1, reducedMotion: true }).window.matchMedia('(prefers-reduced-motion: reduce)').matches, true);
  assert.equal(page.window.matchMedia('(prefers-color-scheme: dark)').matches, true);
  assert.equal(createPage('home', { tiles: 1, dark: false }).window.matchMedia('(prefers-color-scheme: dark)').matches, false);
});

// ---- the duplicate-id bug ----------------------------------------------------------------------------------------

test('LIMITATION: raw jsdom el.querySelector("#id") misses descendants when an earlier same-id element is outside el', (t) => {
  const { window } = new JSDOM(
    '<body><div id="a"><span id="content">first</span></div><div id="b"><span id="content">second</span></div></body>',
  );
  const b = window.document.getElementById('b');
  const viaAttr = b.querySelector('[id="content"]');
  assert.equal(viaAttr.textContent, 'second', '[id="x"] is unaffected');
  const raw = b.querySelector('#content');
  t.diagnostic(`raw jsdom b.querySelector("#content") -> ${raw ? `"${raw.textContent}"` : 'null (BUG present)'}`);
  assert.ok(raw === null || raw.textContent === 'second', 'if jsdom ever returns the FIRST (wrong) element, installIdFix is no longer enough');
});

test('dom.js installIdFix: #id queries work on tiles after the first, like a real browser', () => {
  const { document } = createPage('home', { tiles: 4 });
  const tiles = [...document.querySelectorAll('ytd-rich-item-renderer')];
  assert.equal(tiles.length, 4);
  const contents = tiles.map((t) => t.querySelector('#content'));
  assert.ok(contents.every(Boolean), 'every tile finds its own #content');
  contents.forEach((c, i) => assert.equal(c.parentElement, tiles[i], `tile ${i} resolved its own #content, not the first tile's`));
  assert.equal(tiles[2].querySelector(':scope > #content'), contents[2]);
  assert.equal(tiles[3].querySelector('div#content > yt-lockup-view-model'), contents[3].firstElementChild);
  assert.equal(tiles[1].querySelectorAll('#content').length, 1);
  const grid = document.querySelector('ytd-rich-grid-renderer');
  assert.ok(grid.querySelector('#header'), 'grid #header (a second #header exists earlier in ytd-browse)');
  assert.ok(grid.querySelector('#contents'));
  assert.equal(document.querySelector('ytd-rich-grid-renderer #contents > ytd-rich-item-renderer:first-child').id, '');
});

test('duplicateIdFix:false leaves the raw jsdom behaviour in place (opt-out)', () => {
  const raw = createPage('home', { tiles: 3, duplicateIdFix: false });
  const tiles = [...raw.document.querySelectorAll('ytd-rich-item-renderer')];
  // ytd-app > div#content comes first in the real shell, so raw jsdom misses #content inside EVERY tile.
  assert.equal(tiles[0].querySelector('#content'), null, 'raw jsdom duplicate-id bug (if this starts finding it, jsdom fixed the bug and installIdFix can go)');
  assert.equal(tiles[2].querySelector('[id="content"]').parentElement, tiles[2], 'attribute form always works');
  assert.equal(raw.window.Element.prototype.querySelector.__cdIdFix, undefined);
});

test('rewriteIdSelectors only touches real #id tokens', () => {
  assert.equal(rewriteIdSelectors('#a'), '[id="a"]');
  assert.equal(rewriteIdSelectors('div#a.b > #c-d_e'), 'div[id="a"].b > [id="c-d_e"]');
  assert.equal(rewriteIdSelectors(':not(#a), :is(#b, .c)'), ':not([id="a"]), :is([id="b"], .c)');
  assert.equal(rewriteIdSelectors('a[href="#top"]'), 'a[href="#top"]', 'inside attribute brackets');
  assert.equal(rewriteIdSelectors("a[href='#x'] #y"), "a[href='#x'] [id=\"y\"]");
  assert.equal(rewriteIdSelectors('.cls'), '.cls');
  assert.equal(rewriteIdSelectors('#1abc'), '#1abc', 'invalid ids are left for the engine to reject');
  assert.equal(rewriteIdSelectors('#a\\:b'), '#a\\:b', 'escaped ids are left alone');
  assert.equal(rewriteIdSelectors(42), 42);
  const { window } = new JSDOM('<body></body>');
  installIdFix(window);
  installIdFix(window);
  assert.equal(window.Element.prototype.querySelector.__cdIdFix, true);
});
