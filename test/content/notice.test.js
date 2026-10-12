// Tests for src/content/notice.js (owner: selectors agent).
//
// What is proven:
//   1. Structure and ARIA: div.cd-notice[role=status] with a native dismiss button, text built from labels (never HTML).
//   2. Placement: first child of <body>, never inside the player / app shell / ad containers, leaves YouTube's DOM untouched,
//      picks the free corner (and the least-bad one when none is free), follows resize and navigation.
//   3. Keyboard and focus: takes no focus, is the first tab stop, Escape / click dismiss, Enter / Space / Escape never reach
//      YouTube's hotkeys, focus goes back to where it was.
//   4. Once per feature per session (document + sessionStorage), merging into a live notice, hostile input.
//   5. It styles itself without any stylesheet, with the right fallbacks, and never hides, fades or covers anything.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createPage } from '../helpers/dom.js';
import { createSelectors } from '../../src/content/selectors.js';
import { createHealth } from '../../src/content/health.js';
import { showNotice, retireNotice, FEATURE_LABELS, DEFAULT_AVOID } from '../../src/content/notice.js';
import { FEATURES } from '../../src/shared/constants.js';

const MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const SOURCE = readFileSync(new URL('../../src/content/notice.js', import.meta.url), 'utf8');
const STORE_KEY = 'cd:v1:noticeShown';

const open = [];
/** Every test gets its own document, so "once per session" never leaks between tests. */
function page(kind = 'watch', opts = {}) {
  const p = createPage(kind, { tiles: 3, ...opts });
  open.push(p);
  return p;
}
after(() => { for (const p of open) p.window.close(); });

const labelOf = (feature) => FEATURE_LABELS[feature];
const text = (el) => el.textContent.replace(/\s+/g, ' ').trim();
const key = (win, type, init = {}) => new win.KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
const rect = (left, top, right, bottom) => ({ left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top });
const dismissButton = (root) => root.querySelector('button.cd-notice-dismiss');
const TABBABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
const luminance = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => { const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x); return (hi + 0.05) / (lo + 0.05); };

// ---- 1. structure and ARIA -----------------------------------------------------------------------------------------

test('the notice is div.cd-notice[role=status] with a polite atomic live region, a text span and one native dismiss button', () => {
  const { document } = page();
  const root = showNotice(document, { features: ['layout-home'] });
  assert.equal(root.localName, 'div');
  assert.ok(root.classList.contains('cd-notice'));
  assert.equal(root.getAttribute('role'), 'status');
  assert.equal(root.getAttribute('aria-live'), 'polite', 'a notice must never interrupt a screen reader that is reading the video page');
  assert.equal(root.getAttribute('aria-atomic'), 'true');
  assert.equal(root.hasAttribute('aria-hidden'), false);
  assert.equal(root.hasAttribute('tabindex'), false, 'the container is not a tab stop; only the button is');
  assert.deepEqual([...root.children].map((c) => c.localName + '.' + c.className), ['span.cd-notice-text', 'button.cd-notice-dismiss']);
  const button = dismissButton(root);
  assert.equal(button.getAttribute('type'), 'button', 'never a submit button inside a YouTube form');
  assert.equal(button.disabled, false);
  assert.equal(button.hasAttribute('tabindex'), false, 'natively focusable, in DOM order');
  assert.equal(text(button), 'Dismiss', 'an accessible name');
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Home layout because YouTube changed. Everything else still works.');
  assert.equal(root.ownerDocument, document);
});

test('text is composed from fixed labels only: one, two, three and nine features, never markup', () => {
  const cases = [
    [['layout-home'], 'Home layout'],
    [['layout-home', 'density'], 'Home layout and Density'],
    [['layout-home', 'density', 'calm-hideShorts'], 'Home layout, Density and Hide Shorts'],
  ];
  for (const [features, expected] of cases) {
    const { document } = page();
    const root = showNotice(document, { features });
    assert.equal(root.querySelector('.cd-notice-text').textContent, `Cinedrape turned off ${expected} because YouTube changed. Everything else still works.`);
    assert.equal(root.querySelectorAll('*').length, 2, 'no element was created from the text');
  }
  const { document } = page();
  const all = showNotice(document, { features: FEATURES });
  assert.equal(all.querySelector('.cd-notice-text').textContent.split(' and ').length, 2);
  for (const feature of FEATURES) assert.ok(all.textContent.includes(labelOf(feature)), feature);
});

test('FEATURE_LABELS: one human label per contract feature, all distinct, frozen', () => {
  assert.deepEqual(Object.keys(FEATURE_LABELS).sort(), [...FEATURES].sort());
  const labels = Object.values(FEATURE_LABELS);
  assert.ok(labels.every((l) => typeof l === 'string' && l.trim() && !/[<>&]/.test(l)));
  assert.equal(new Set(labels).size, labels.length);
  assert.ok(Object.isFrozen(FEATURE_LABELS));
});

// ---- 2. placement and the hard rules -------------------------------------------------------------------------------

test('it is the first child of <body>: never inside the player, the app shell, an ad slot or any protected container', () => {
  const { document } = page('watch', { ads: 2 });
  const root = showNotice(document, { features: ['layout-watch'] });
  assert.equal(root.parentElement, document.body);
  assert.equal(document.body.firstElementChild, root, 'first stop for keyboard users');
  assert.equal(document.querySelectorAll('.cd-notice').length, 1);
  const hosts = ['ytd-app', 'ytd-player', '#movie_player', '.html5-video-player', 'ytd-watch-flexy', '#player', '#player-container', '#related', '#secondary'];
  for (const host of hosts) assert.equal(root.closest(host), null, `not inside ${host}`);
  for (const group of ['ads', 'sponsor', 'playerControls', 'containers']) {
    for (const selector of MAP.protected[group]) assert.equal(root.closest(selector), null, `not inside protected.${group} ${selector}`);
  }
  const player = document.querySelector('#movie_player');
  assert.equal(player.contains(root), false);
  assert.equal(root.contains(player), false);
  assert.ok(document.querySelectorAll(MAP.protected.ads.join(',')).length >= 3, 'the page really has ad containers');
});

test('YouTube\'s DOM is untouched while the notice is up and after it is gone', () => {
  const { document } = page('watch', { ads: 2 });
  const before = document.body.innerHTML;
  const htmlAttrs = [...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).join('|');
  const root = showNotice(document, { features: ['density', 'layout-watch'] });
  const clone = document.body.cloneNode(true);
  clone.querySelector('.cd-notice').remove();
  assert.equal(clone.innerHTML, before, 'with the notice lifted out, the body is byte-identical');
  assert.equal([...document.documentElement.attributes].map((a) => `${a.name}=${a.value}`).join('|'), htmlAttrs, '<html> attributes are not touched');
  assert.equal(document.head.querySelectorAll('style, link').length, 0, 'no stylesheet is injected');
  dismissButton(root).click();
  assert.equal(document.body.innerHTML, before);
});

test('ads and sponsorship disclosures stay in the DOM, visible, and the notice never wraps, hides or restyles them', () => {
  const { document, window } = page('watch', { ads: 2 });
  const selector = [...MAP.protected.ads, ...MAP.protected.sponsor].join(',');
  const adNodes = [...document.querySelectorAll(selector)];
  assert.ok(adNodes.length >= 4);
  const styles = adNodes.map((el) => el.getAttribute('style'));
  const root = showNotice(document, { features: FEATURES });
  for (const [i, el] of adNodes.entries()) {
    assert.ok(el.isConnected, 'still in the page');
    assert.equal(el.getAttribute('style'), styles[i], 'its style attribute is unchanged');
    assert.equal(root.contains(el), false);
    assert.notEqual(window.getComputedStyle(el).display, 'none');
    assert.notEqual(window.getComputedStyle(el).visibility, 'hidden');
  }
  // The notice itself never uses a declaration that hides, collapses, clips, fades or ignores clicks.
  const styleText = root.getAttribute('style');
  assert.doesNotMatch(styleText, /display:\s*none|visibility|opacity|clip|transform|filter|pointer-events|height:\s*0|width:\s*0|overflow:\s*hidden/i);
  assert.doesNotMatch(dismissButton(root).getAttribute('style'), /display:\s*none|visibility|opacity|clip|transform|filter|pointer-events/i);
});

test('it styles itself with no stylesheet at all: fixed, below YouTube\'s masthead and menus, theme variables with a readable fallback', () => {
  const { document } = page('home');
  const root = showNotice(document, { features: ['theme'] });
  const style = root.style;
  assert.equal(style.getPropertyValue('position'), 'fixed');
  const z = Number(style.getPropertyValue('z-index'));
  assert.ok(z > 0 && z < 2000, `z-index ${z} is above page content but under the masthead (2020) and menus`);
  assert.equal(style.getPropertyValue('display'), 'flex');
  assert.match(style.getPropertyValue('background'), /^var\(--cd-surface, #[0-9a-f]{6}\)$/i);
  assert.match(style.getPropertyValue('color'), /^var\(--cd-text, #[0-9a-f]{6}\)$/i);
  assert.match(style.getPropertyValue('border'), /var\(--cd-border, #[0-9a-f]{6}\)/i);
  const fallbackBg = /#[0-9a-f]{6}/i.exec(style.getPropertyValue('background'))[0];
  const fallbackText = /#[0-9a-f]{6}/i.exec(style.getPropertyValue('color'))[0];
  assert.ok(contrast(fallbackBg, fallbackText) >= 4.5, `fallback text contrast ${contrast(fallbackBg, fallbackText).toFixed(2)}`);
  const fallbackBorder = /#[0-9a-f]{6}/i.exec(style.getPropertyValue('border'))[0];
  assert.ok(contrast(fallbackBg, fallbackBorder) >= 3, 'the outline is visible against the fallback surface');
  // The button is not a "ghost" that only shows on hover and has a target big enough to hit.
  const button = dismissButton(root);
  assert.ok(parseInt(button.style.getPropertyValue('min-height'), 10) >= 24);
  assert.ok(parseInt(button.style.getPropertyValue('min-width'), 10) >= 24);
  assert.match(button.style.getPropertyValue('border'), /^1px solid/, 'a visible outline in the current text colour (the initial border-color)');
});

test('focus ring: the button shows an outline when focused and drops it on blur (no :focus-visible without a stylesheet)', () => {
  const { document } = page();
  const root = showNotice(document, { features: ['density'] });
  const button = dismissButton(root);
  assert.equal(button.style.getPropertyValue('outline'), 'none');
  button.focus();
  assert.match(button.style.getPropertyValue('outline'), /2px solid var\(--cd-accent, #3ea6ff\)/);
  assert.ok(contrast('#212121', '#3ea6ff') >= 3, 'the fallback ring colour is visible on the fallback surface');
  button.blur();
  assert.equal(button.style.getPropertyValue('outline'), 'none');
});

// ---- 2b. choosing a corner -----------------------------------------------------------------------------------------

/** Stubs layout: jsdom has none. Returns the anchor the notice picked. */
function anchorFor({ player = null, ad = null, avoid } = {}) {
  const { document } = page('watch', { ads: 1 });
  if (player) document.querySelector('#movie_player').getBoundingClientRect = () => player;
  if (ad) document.querySelector('.ytp-ad-module').getBoundingClientRect = () => ad;
  const root = showNotice(document, { features: ['layout-watch'], avoid });
  return { anchor: root.getAttribute('data-cd-anchor'), root, document };
}

test('corner choice (viewport 1024x768): bottom-left by default, then the first corner the player does not touch', () => {
  assert.equal(anchorFor().anchor, 'bottom-left', 'no player geometry: bottom-left');
  assert.equal(anchorFor({ player: rect(0, 600, 500, 768) }).anchor, 'bottom-right');
  assert.equal(anchorFor({ player: rect(0, 600, 1024, 768) }).anchor, 'top-right', 'a player along the whole bottom pushes it to the top');
  assert.equal(anchorFor({ player: rect(0, 0, 400, 768) }).anchor, 'bottom-right');
  assert.equal(anchorFor({ player: rect(400, 100, 1024, 768) }).anchor, 'bottom-left', 'left strip is free');
  assert.equal(anchorFor({ player: rect(300, 100, 1024, 768) }).anchor, 'flow', 'no free corner: in the flow under the masthead, never over the player');
  assert.equal(anchorFor({ player: rect(0, 0, 0, 0) }).anchor, 'bottom-left', 'zero-size boxes are ignored (hidden players)');
});

test('when every corner touches the player (theatre mode, a narrow window) the notice is placed in the flow under the masthead, not over the player', () => {
  for (const player of [rect(0, 0, 1000, 700), rect(0, 0, 1024, 768), rect(100, 100, 900, 700)]) {
    const full = anchorFor({ player });
    assert.equal(full.anchor, 'flow', JSON.stringify(player));
    const style = full.root.style;
    assert.equal(style.getPropertyValue('position'), 'relative', 'a part of the document: it pushes content, it covers none');
    assert.equal(style.getPropertyValue('margin-top'), '56px', 'starts below the fixed masthead');
    for (const side of ['top', 'bottom', 'left', 'right']) assert.equal(style.getPropertyValue(side), 'auto', side);
    assert.equal(full.document.body.firstChild, full.root, 'still the first child of <body>');
  }
  // A corner notice that later has to move into the flow (and back) fully replaces the old placement.
  const { document, window } = page('watch');
  const player = document.querySelector('#movie_player');
  let box = rect(0, 0, 1024, 768);
  player.getBoundingClientRect = () => box;
  const root = showNotice(document, { features: ['layout-watch'] });
  assert.equal(root.getAttribute('data-cd-anchor'), 'flow');
  box = rect(0, 0, 400, 768);
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(root.getAttribute('data-cd-anchor'), 'bottom-right');
  assert.equal(root.style.getPropertyValue('position'), 'fixed');
  assert.equal(root.style.getPropertyValue('margin-top'), '0px');
  const top = anchorFor({ player: rect(0, 600, 1024, 768) });
  assert.equal(top.anchor, 'top-right');
  const topRight = anchorFor({ player: rect(0, 300, 1024, 768) });
  assert.equal(topRight.anchor, 'top-right');
  assert.equal(topRight.root.style.getPropertyValue('top'), '72px', 'below the masthead');
  assert.equal(topRight.root.style.getPropertyValue('bottom'), 'auto');
  assert.equal(topRight.root.style.getPropertyValue('right'), '16px');
  assert.equal(topRight.root.style.getPropertyValue('left'), 'auto');
  const bl = anchorFor();
  assert.equal(bl.root.style.getPropertyValue('bottom'), '16px');
  assert.equal(bl.root.style.getPropertyValue('top'), 'auto');
  assert.equal(bl.root.style.getPropertyValue('left'), '16px');
});

test('the default avoid list covers the control bar, ad / sponsorship UI in the player and the page ad slots', () => {
  const lists = DEFAULT_AVOID.split(',').map((s) => s.trim());
  for (const sel of ['.ytp-chrome-bottom', '[class*="ytp-ad-"]', '[class*="ytp-paid-content"]', 'ytd-ad-slot-renderer', '#masthead-ad', '.ytp-ad-module', '#movie_player']) {
    assert.ok(lists.includes(sel), sel);
  }
  const probe = (build) => {
    const { document } = page('home');
    const el = build(document);
    el.getBoundingClientRect = () => rect(0, 600, 500, 768);
    return showNotice(document, { features: ['density'] }).getAttribute('data-cd-anchor');
  };
  const add = (tag, attrs) => (document) => {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    document.body.append(el);
    return el;
  };
  assert.equal(probe(add('div', { class: 'ytp-chrome-bottom' })), 'bottom-right', 'player control bar');
  assert.equal(probe(add('div', { class: 'ytp-ad-text ytp-ad-preview' })), 'bottom-right', 'in-player ad text');
  assert.equal(probe(add('div', { class: 'ytp-paid-content-overlay' })), 'bottom-right', 'sponsorship disclosure');
  assert.equal(probe(add('ytd-ad-slot-renderer', {})), 'bottom-right', 'in-feed ad slot');
  assert.equal(probe(add('div', { id: 'masthead-ad' })), 'bottom-right', 'home masthead ad');
});

test('in-player ad UI is avoided too, and `avoid` replaces the default list', () => {
  assert.equal(anchorFor({ ad: rect(0, 600, 500, 768) }).anchor, 'bottom-right', 'the .ytp-ad-module counts as an obstacle');
  const { document } = page('watch');
  document.querySelector('#movie_player').getBoundingClientRect = () => rect(0, 600, 500, 768);
  document.querySelector('#secondary').getBoundingClientRect = () => rect(600, 600, 1024, 768);
  assert.equal(showNotice(document, { features: ['density'], avoid: '#secondary' }).getAttribute('data-cd-anchor'), 'bottom-left', 'only #secondary is avoided: the player is ignored');
  const second = page('watch');
  second.document.querySelector('#movie_player').getBoundingClientRect = () => rect(0, 600, 500, 768);
  assert.equal(showNotice(second.document, { features: ['density'], avoid: '   ' }).getAttribute('data-cd-anchor'), 'bottom-right', 'a blank avoid falls back to the default');
  const third = page('watch');
  third.document.querySelector('#movie_player').getBoundingClientRect = () => rect(0, 600, 500, 768);
  assert.doesNotThrow(() => showNotice(third.document, { features: ['density'], avoid: 'a[' }), 'an invalid selector must not break the notice');
});

test('it moves when the window is resized and when YouTube finishes a navigation, and stops listening once dismissed', () => {
  const { document, window } = page('watch');
  const player = document.querySelector('#movie_player');
  let box = rect(0, 600, 500, 768);
  let calls = 0;
  player.getBoundingClientRect = () => { calls++; return box; };
  const root = showNotice(document, { features: ['layout-watch'] });
  assert.equal(root.getAttribute('data-cd-anchor'), 'bottom-right');
  box = rect(500, 600, 1024, 768); // the layout changed (theatre mode, a resize)
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(root.getAttribute('data-cd-anchor'), 'bottom-left');
  box = rect(0, 600, 1024, 768);
  document.dispatchEvent(new window.CustomEvent('yt-navigate-finish', { bubbles: true }));
  assert.equal(root.getAttribute('data-cd-anchor'), 'top-right', 'a page swap moves the player: look again');
  window.dispatchEvent(new window.CustomEvent('yt-navigate-finish'));
  assert.equal(root.getAttribute('data-cd-anchor'), 'top-right', 'also when dispatched on window');
  dismissButton(root).click();
  const seen = calls;
  window.dispatchEvent(new window.Event('resize'));
  document.dispatchEvent(new window.CustomEvent('yt-navigate-finish', { bubbles: true }));
  assert.equal(calls, seen, 'after dismissal nothing is measured: the listeners are gone');
});

test('a notice that YouTube (or anything else) removed from the page cleans up its listeners on the next resize', () => {
  const { document, window } = page('watch');
  const removed = [];
  const original = window.removeEventListener.bind(window);
  window.removeEventListener = (type, fn, opts) => { removed.push(type); return original(type, fn, opts); };
  const root = showNotice(document, { features: ['density'] });
  root.remove();
  window.dispatchEvent(new window.Event('resize'));
  assert.deepEqual(removed.sort(), ['resize', 'yt-navigate-finish']);
  // And a fresh feature can still be announced (a dead notice is not "live").
  const next = showNotice(document, { features: ['layout-home'] });
  assert.ok(next && next !== root && next.isConnected);
  assert.equal(text(next.querySelector('.cd-notice-text')).includes('Home layout'), true);
  assert.equal(text(next.querySelector('.cd-notice-text')).includes('Density'), false, 'density was announced before; it is not repeated');
});

// ---- 3. keyboard and focus -----------------------------------------------------------------------------------------

test('it takes no focus when it appears, and it is the first Tab stop on the page', () => {
  const { document } = page('watch');
  const prior = document.querySelector('#movie_player');
  prior.setAttribute('tabindex', '0');
  prior.focus();
  assert.equal(document.activeElement, prior);
  const root = showNotice(document, { features: ['density'] });
  assert.equal(document.activeElement, prior, 'a status message does not steal focus from the video');
  const tabbable = [...document.querySelectorAll(TABBABLE)];
  assert.equal(tabbable[0], dismissButton(root), 'the first thing Tab reaches');
  assert.equal(tabbable.filter((el) => root.contains(el)).length, 1, 'exactly one stop inside the notice');
});

test('click, and Escape while the notice has focus, dismiss it; Escape elsewhere does not', () => {
  const { document, window } = page('watch');
  const root = showNotice(document, { features: ['density'] });
  // Escape somewhere else on the page (YouTube uses it to close dialogs): the notice must not react.
  document.body.dispatchEvent(key(window, 'keydown', { key: 'Escape' }));
  document.querySelector('#movie_player').dispatchEvent(key(window, 'keydown', { key: 'Escape' }));
  assert.ok(root.isConnected);
  const button = dismissButton(root);
  button.focus();
  const esc = key(window, 'keydown', { key: 'Escape' });
  button.dispatchEvent(esc);
  assert.equal(root.isConnected, false);
  assert.equal(esc.defaultPrevented, true);

  const again = showNotice(document, { features: ['layout-home'] });
  dismissButton(again).click();
  assert.equal(again.isConnected, false);
  assert.equal(document.querySelectorAll('.cd-notice').length, 0);
});

test('Enter, Space and Escape inside the notice never reach YouTube\'s hotkeys; other keys are left alone', () => {
  const { document, window } = page('watch');
  const root = showNotice(document, { features: ['density'] });
  const button = dismissButton(root);
  const reached = [];
  const spy = (e) => reached.push(`${e.type}:${e.key}`);
  document.addEventListener('keydown', spy);
  document.addEventListener('keyup', spy);
  window.addEventListener('keydown', spy);
  for (const k of ['Enter', ' ', 'Spacebar']) {
    button.dispatchEvent(key(window, 'keydown', { key: k }));
    button.dispatchEvent(key(window, 'keyup', { key: k }));
  }
  assert.deepEqual(reached, [], 'Space would pause the video, Enter would activate whatever YouTube has focused');
  for (const k of ['ArrowRight', 'k', 'Tab', 'f']) button.dispatchEvent(key(window, 'keydown', { key: k }));
  assert.deepEqual(reached.filter((r) => r.startsWith('keydown')).length, 8, 'unrelated keys propagate (document + window listeners)');
  button.dispatchEvent(key(window, 'keydown', { key: 'Escape' }));
  button.dispatchEvent(key(window, 'keyup', { key: 'Escape' }));
  assert.equal(reached.length, 8, 'Escape was consumed too');
  assert.equal(root.isConnected, false);
});

test('focus returns to where it was when the notice is dismissed (keyboard and mouse), or leaves the dead element otherwise', () => {
  const { document, window } = page('watch');
  const before = document.createElement('button');
  before.id = 'before';
  document.querySelector('#secondary').prepend(before);
  before.focus();
  const root = showNotice(document, { features: ['density'] });
  const button = dismissButton(root);
  button.focus();
  assert.equal(document.activeElement, button);
  button.dispatchEvent(key(window, 'keydown', { key: 'Escape' }));
  assert.equal(document.activeElement, before, 'back on the element the user came from');

  // The origin disappeared (YouTube re-rendered): nothing is left focused on a removed node.
  const second = showNotice(document, { features: ['layout-home'] });
  before.focus();
  dismissButton(second).focus();
  before.remove();
  dismissButton(second).click();
  assert.equal(second.isConnected, false);
  assert.ok(document.activeElement === document.body || document.activeElement === null, 'no focus trapped in a removed notice');

  // Dismissed without ever having focus: focus is not touched.
  const third = showNotice(document, { features: ['calm-hideShorts'] });
  const other = document.createElement('button');
  document.body.append(other);
  other.focus();
  dismissButton(third).click();
  assert.equal(document.activeElement, other);
});

test('onDismiss: called once with every feature the notice announced, after it is gone; later clicks are no-ops; a faulty handler does not stop the next', () => {
  const { document, window } = page('watch');
  const reported = [];
  window.reportError = (err) => reported.push(err.message);
  const calls = [];
  const rootOpen = [];
  const root = showNotice(document, {
    features: ['layout-home', 'density'],
    onDismiss: (features) => { rootOpen.push(root.isConnected); calls.push(['first', features]); throw new Error('handler bug'); },
  });
  const same = showNotice(document, { features: ['calm-hideShorts'], onDismiss: (features) => calls.push(['second', features]) });
  assert.equal(same, root, 'a feature announced while the notice is still up joins it');
  assert.equal(document.querySelectorAll('.cd-notice').length, 1);
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Home layout, Density and Hide Shorts because YouTube changed. Everything else still works.');
  dismissButton(root).click();
  dismissButton(root).click();
  window.dispatchEvent(new window.Event('resize'));
  assert.deepEqual(calls, [['first', ['layout-home', 'density', 'calm-hideShorts']], ['second', ['layout-home', 'density', 'calm-hideShorts']]]);
  assert.deepEqual(rootOpen, [false], 'handlers run after removal');
  assert.deepEqual(reported, ['handler bug']);
});

// ---- 4. once per feature per session ---------------------------------------------------------------------------------

test('once per feature per session: asking again is a no-op, new features still get through, dismissing does not reset it', () => {
  const { document } = page('watch');
  const first = showNotice(document, { features: ['layout-home'] });
  assert.ok(first);
  assert.equal(showNotice(document, { features: ['layout-home'] }), null, 'same feature while the notice is up');
  assert.equal(document.querySelectorAll('.cd-notice').length, 1);
  assert.equal(showNotice(document, { features: ['layout-home', 'layout-home', 'layout-home'] }), null);
  const merged = showNotice(document, { features: ['layout-home', 'calm-hideComments'] });
  assert.equal(merged, first, 'only the new feature is added to the live notice');
  assert.equal(text(first.querySelector('.cd-notice-text')), 'Cinedrape turned off Home layout and Hide comments because YouTube changed. Everything else still works.');
  dismissButton(first).click();
  assert.equal(showNotice(document, { features: ['layout-home'] }), null, 'dismissed is not forgotten');
  assert.equal(showNotice(document, { features: ['layout-home', 'calm-hideComments'] }), null);
  const fresh = showNotice(document, { features: ['layout-home', 'density'] });
  assert.ok(fresh && fresh !== first, 'a feature never announced gets a new notice');
  assert.equal(text(fresh.querySelector('.cd-notice-text')), 'Cinedrape turned off Density because YouTube changed. Everything else still works.');
});

test('each document is its own session', () => {
  const a = page('watch');
  const b = page('home');
  assert.ok(showNotice(a.document, { features: ['density'] }));
  assert.ok(showNotice(b.document, { features: ['density'] }), 'another tab / page load starts fresh');
  assert.equal(showNotice(a.document, { features: ['density'] }), null);
});

test('the session survives a page reload through sessionStorage (feature ids only), and never throws without storage', () => {
  const a = page('watch');
  showNotice(a.document, { features: ['density', 'layout-home'] });
  assert.deepEqual(JSON.parse(a.window.sessionStorage.getItem(STORE_KEY)), ['density', 'layout-home']);
  // "Reload": a new document of the same tab shares sessionStorage; here we hand the stored value to a fresh page.
  const b = page('watch');
  b.window.sessionStorage.setItem(STORE_KEY, a.window.sessionStorage.getItem(STORE_KEY));
  assert.equal(showNotice(b.document, { features: ['density'] }), null, 'already announced in this tab session');
  const root = showNotice(b.document, { features: ['density', 'calm-hideShorts'] });
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Hide Shorts because YouTube changed. Everything else still works.');
  assert.deepEqual(JSON.parse(b.window.sessionStorage.getItem(STORE_KEY)), ['density', 'layout-home', 'calm-hideShorts'], 'the whole session is kept, not just the last notice');
});

test('corrupt or hostile sessionStorage content is ignored; unknown ids in it are dropped; storage that throws is survivable', () => {
  for (const junk of ['not json', '{"a":1}', 'null', '5', '"density"', '[1,2]', '["__proto__","constructor"]', '[null]', '']) {
    const p = page('watch');
    p.window.sessionStorage.setItem(STORE_KEY, junk);
    const root = showNotice(p.document, { features: ['density'] });
    assert.ok(root, `junk ${JSON.stringify(junk)} must not suppress a real feature`);
  }
  const quota = page('watch');
  quota.window.Storage.prototype.setItem = () => { throw new quota.window.DOMException('full', 'QuotaExceededError'); };
  assert.ok(showNotice(quota.document, { features: ['density'] }));
  assert.equal(showNotice(quota.document, { features: ['density'] }), null, 'the in-memory session still holds');

  const blocked = page('watch');
  Object.defineProperty(blocked.window, 'sessionStorage', { configurable: true, get() { throw new blocked.window.DOMException('blocked', 'SecurityError'); } });
  assert.ok(showNotice(blocked.document, { features: ['layout-home'] }));
  assert.equal(showNotice(blocked.document, { features: ['layout-home'] }), null);
});

test('nothing else is ever written to storage: no cookie, no localStorage', () => {
  const p = page('watch');
  const writes = [];
  const original = p.window.Storage.prototype.setItem;
  p.window.Storage.prototype.setItem = function setItem(k, v) { writes.push([this === p.window.localStorage ? 'local' : 'session', k, v]); return original.call(this, k, v); };
  showNotice(p.document, { features: FEATURES });
  assert.deepEqual(writes, [['session', STORE_KEY, JSON.stringify(FEATURES)]]);
  assert.equal(p.document.cookie, '');
  assert.equal(p.window.localStorage.length, 0);
});

// ---- 4b. hostile and odd input -----------------------------------------------------------------------------------------

test('nothing to say means null and no DOM: unknown features, junk lists, missing options, non-documents', () => {
  const { document } = page('watch');
  const before = document.documentElement.outerHTML;
  for (const options of [undefined, null, {}, { features: [] }, { features: 'density' }, { features: { 0: 'density' } }, { features: [null, undefined, 5, {}, [], 'nope'] },
    { features: ['__proto__', 'constructor', 'toString', 'hasOwnProperty'] }, { features: [{ feature: 'nope' }, { name: 'density' }, { feature: 5 }] }, 'density', 5]) {
    assert.equal(showNotice(document, options), null, JSON.stringify(options));
  }
  assert.equal(document.documentElement.outerHTML, before);
  for (const doc of [null, undefined, 0, 'document', {}, { createElement: 1 }, []]) assert.equal(showNotice(doc, { features: ['density'] }), null);
});

test('health.evaluate().broken goes straight in (objects with a feature name), mixed with plain strings; markup in names is not trusted', () => {
  const { document } = page('watch');
  const root = showNotice(document, { features: [{ feature: 'calm-hideComments', missingRoles: ['comments'] }, 'density', { feature: '<img src=x onerror=alert(1)>' }, 'calm-hideShorts'] });
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Hide comments, Density and Hide Shorts because YouTube changed. Everything else still works.');
  assert.equal(root.querySelector('img'), null);
});

test('a document without a <body> (document_start) still gets the notice, as the first child of <html>', () => {
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'https://www.youtube.com/', pretendToBeVisual: true });
  open.push({ window: dom.window });
  const { document } = dom.window;
  document.body.remove();
  assert.equal(document.body, null);
  const root = showNotice(document, { features: ['theme'] });
  assert.ok(root && root.isConnected);
  assert.equal(root.parentElement, document.documentElement);
  assert.equal(document.documentElement.firstElementChild, root);
});

test('a document with no window (detached) still builds the notice without listeners', () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>');
  open.push({ window: dom.window });
  const detached = dom.window.document.implementation.createHTMLDocument('detached');
  assert.equal(detached.defaultView, null);
  const root = showNotice(detached, { features: ['density'] });
  assert.ok(root);
  assert.equal(root.getAttribute('data-cd-anchor'), 'bottom-left');
  assert.doesNotThrow(() => dismissButton(root).click());
});

// ---- 5. with the real health check -----------------------------------------------------------------------------------

test('integration: a renamed YouTube element is detected by health and the notice names exactly that feature, once', () => {
  const p = page('watch');
  for (const el of p.document.querySelectorAll('ytd-comments, #comments, #comment-teaser')) el.remove();
  const selectors = createSelectors(MAP, p.document);
  const health = createHealth({ doc: p.document, selectors, map: MAP });
  const verdict = health.evaluate('watch', FEATURES);
  assert.deepEqual(verdict.broken.map((b) => b.feature), ['calm-hideComments']);
  const root = showNotice(p.document, { features: verdict.broken });
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Hide comments because YouTube changed. Everything else still works.');
  assert.equal(showNotice(p.document, { features: health.evaluate('watch', FEATURES).broken }), null, 'the next health round does not nag');
  // A second, different breakage joins the same notice.
  for (const el of p.document.querySelectorAll('#secondary')) el.remove();
  const next = health.evaluate('watch', FEATURES);
  assert.deepEqual(next.broken.map((b) => b.feature), ['layout-watch', 'calm-hideComments']);
  const joined = showNotice(p.document, { features: next.broken });
  assert.equal(joined, root);
  assert.match(text(root.querySelector('.cd-notice-text')), /Hide comments and Watch layout/);
});

// ---- 5b. retiring: the notice tells the truth when a paused feature comes back -------------------------------------------------

test('retireNotice: a healed feature leaves the sentence, the notice goes with the last one, and nobody is told it was dismissed', () => {
  const { document } = page();
  const dismissed = [];
  const root = showNotice(document, { features: ['calm-hideComments', 'layout-watch', 'density'], onDismiss: (f) => dismissed.push(f) });
  assert.match(text(root.querySelector('.cd-notice-text')), /Hide comments, Watch layout and Density/);
  assert.equal(retireNotice(document, ['layout-watch']), true);
  assert.equal(root.isConnected, true);
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Hide comments and Density because YouTube changed. Everything else still works.');
  assert.equal(retireNotice(document, ['layout-watch']), false, 'retiring something that is not in the sentence changes nothing');
  assert.equal(retireNotice(document, [{ feature: 'density' }, 'nonsense', 7, null]), true, 'entries from health.evaluate().broken are accepted, junk is ignored');
  assert.equal(text(root.querySelector('.cd-notice-text')), 'Cinedrape turned off Hide comments because YouTube changed. Everything else still works.');
  assert.equal(retireNotice(document, ['calm-hideComments']), true);
  assert.equal(root.isConnected, false, 'the last feature healed: the notice is gone');
  assert.equal(document.querySelectorAll('.cd-notice').length, 0);
  assert.deepEqual(dismissed, [], 'a retired notice is not a dismissal');
  assert.equal(retireNotice(document, ['calm-hideComments']), false, 'nothing on screen: a no-op');
});

test('retireNotice: it never throws and never touches what it does not own (no notice, junk input, a notice YouTube removed)', () => {
  const { document } = page();
  assert.equal(retireNotice(document, ['density']), false);
  assert.equal(retireNotice(null, ['density']), false);
  assert.equal(retireNotice(document, null), false);
  assert.equal(retireNotice(document, 'density'), false);
  const root = showNotice(document, { features: ['density'] });
  root.remove();
  assert.equal(retireNotice(document, ['density']), false, 'a notice that is no longer connected is left alone');
});

test('retireNotice: the feature stays announced for the session, so a flapping feature does not bring the notice back; a different one does', () => {
  const { document } = page();
  showNotice(document, { features: ['calm-hideComments'] });
  assert.equal(retireNotice(document, ['calm-hideComments']), true);
  assert.equal(showNotice(document, { features: ['calm-hideComments'] }), null);
  const again = showNotice(document, { features: ['calm-hideComments', 'density'] });
  assert.match(text(again.querySelector('.cd-notice-text')), /turned off Density because/);
  assert.equal(JSON.parse(document.defaultView.sessionStorage.getItem(STORE_KEY)).includes('calm-hideComments'), true);
});

test('retireNotice: focus on the dismiss button is handed back like a dismissal, and the listeners are released', () => {
  const { document, window } = page();
  const outside = document.createElement('button');
  document.body.append(outside);
  outside.focus();
  const root = showNotice(document, { features: ['density'] });
  const button = dismissButton(root);
  button.focus();
  assert.equal(document.activeElement, button);
  assert.equal(retireNotice(document, ['density']), true);
  assert.equal(document.activeElement, outside);
  const before = root.getAttribute('data-cd-anchor');
  window.dispatchEvent(new window.Event('resize'));
  assert.equal(root.getAttribute('data-cd-anchor'), before);
});

// ---- 6. hygiene --------------------------------------------------------------------------------------------------------

test('source hygiene: no markup injection, no network, no eval, no cookies; its only import is the constants file', () => {
  const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\b(innerHTML|outerHTML|insertAdjacentHTML|document\.write|createContextualFragment|DOMParser)\b/);
  assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts|postMessage)\b/);
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bimport\s*\(/);
  assert.doesNotMatch(code, /\b(cookie|localStorage|indexedDB)\b/);
  assert.doesNotMatch(code, /\bsetInterval\b|\brequestAnimationFrame\b/, 'no polling, no animation loop');
  assert.doesNotMatch(code, /\b(document|window)\./, 'the document is injected');
  assert.deepEqual(code.match(/^import .*$/gm), ["import { FEATURES } from '../shared/constants.js';"]);
  assert.doesNotMatch(code, /\.\s*(append|prepend|insertBefore|appendChild)\([^)]*(player|ytd-app|movie_player)/i);
});
