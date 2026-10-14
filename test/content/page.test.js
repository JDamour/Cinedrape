// Tests for src/content/page.js (owner: selectors agent).
//
// What is proven:
//   1. detectPageType: every page kind from real URLs and from real jsdom pages, unknown / hostile / foreign-host inputs, and that
//      the answer comes from the URL alone (YouTube keeps a hidden watch skeleton on every page, so DOM presence proves nothing).
//   2. detectWatchMode: theatre / fullscreen attributes, precedence, the hidden off-page skeleton, broken documents.
//   3. observeNavigation: the full set of real YouTube navigation signals (yt-navigate-start, yt-navigate-finish,
//      yt-page-data-updated, popstate) plus the ytd-page-manager childList observer; dispose; late page manager; and that no
//      timer of any kind is ever created.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createPage, navigateTo, PAGE_KINDS } from '../helpers/dom.js';
import { createSelectors } from '../../src/content/selectors.js';
import { detectPageType, detectWatchMode, observeNavigation } from '../../src/content/page.js';
import { PAGE_TYPES } from '../../src/shared/constants.js';

const MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const SOURCE = readFileSync(new URL('../../src/content/page.js', import.meta.url), 'utf8');

const open = [];
function page(kind, opts = {}) {
  const p = createPage(kind, { tiles: 3, ...opts });
  open.push(p);
  return p;
}
after(() => { for (const p of open) p.window.close(); });

/** A bare document at a URL, for tests that need to control readyState and the page manager themselves. */
function bare(html = '<ytd-app></ytd-app>', url = 'https://www.youtube.com/') {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`, { url, pretendToBeVisual: true });
  open.push({ window: dom.window });
  return dom.window;
}
/** Replaces win.MutationObserver with a subclass that records which observers are currently observing something. */
function trackObservers(win) {
  const live = new Set();
  const created = [];
  const Real = win.MutationObserver;
  win.MutationObserver = class extends Real {
    constructor(cb) { super(cb); created.push(this); }
    observe(...args) { live.add(this); return super.observe(...args); }
    disconnect() { live.delete(this); return super.disconnect(); }
  };
  return { live, created };
}
const tick = () => new Promise((resolve) => setImmediate(resolve)); // lets jsdom deliver MutationObserver records
const YT = 'https://www.youtube.com';

// ---- 1. detectPageType ---------------------------------------------------------------------------------------------

const URLS = {
  home: ['/', '', '/?bp=abc', '/#fragment', '//', '/?app=desktop&hl=en'],
  watch: ['/watch?v=BzpdP2APcIM', '/watch', '/watch/', '/watch?v=abc&list=PL123&index=4&t=30s', '/live/jfKfPfyJRdk', '/clip/UgkxAbCdEfGh', '/WATCH?v=x'],
  search: ['/results?search_query=nature+documentary', '/results', '/results/', '/results?search_query=%E3%83%86%E3%82%B9%E3%83%88'],
  channel: ['/@NatGeo', '/@NatGeo/videos', '/@NatGeo/shorts', '/@NatGeo/featured', '/@NatGeo/', '/channel/UCpVm7bg6pXKo1Pr6k5kxG9A', '/channel/UC123/videos',
    '/c/NationalGeographic', '/user/natgeo/videos', '/@%E3%83%86%E3%82%B9%E3%83%88', '/@a.b-c_d', '/@x/community'],
  subscriptions: ['/feed/subscriptions', '/feed/subscriptions/', '/feed/subscriptions?flow=1', '/feed/Subscriptions', '/feed/subscriptions/UCabc'],
  history: ['/feed/history', '/feed/history/', '/feed/history?x=1'],
  playlist: ['/playlist?list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO', '/playlist', '/playlist/'],
  shorts: ['/shorts/AbCdEfGhIjK', '/shorts/', '/shorts', '/shorts/AbCdEfGhIjK?feature=share'],
  other: ['/feed/you', '/feed/library', '/feed/trending', '/feed/channels', '/feed', '/premium', '/account', '/hashtag/nature', '/gaming', '/embed/BzpdP2APcIM',
    '/watch/extra', '/results/extra', '/playlist/extra', '/shorts/a/b', '/live', '/live/', '/clip', '/clip/', '/channel', '/channel/', '/c', '/user', '/@', '/@/videos',
    '/NatGeo', '/upload', '/redirect?q=x', '/s/player/base.js', '/%', '/%E0%A4%A', '/watchx', '/feeds/subscriptions', '/results.html', '/ watch', '/@/'],
};

test('detectPageType maps every page kind, from a string, a URL object, a Location-like object and a path-only object', () => {
  for (const [expected, paths] of Object.entries(URLS)) {
    for (const path of paths) {
      const at = `${expected}: ${JSON.stringify(path)}`;
      if (path === '') continue; // asserted separately: a blank string is not a location
      const url = path.startsWith('//') ? YT + path.slice(1) : YT + path;
      const asUrl = new URL(url);
      assert.equal(detectPageType(null, url), expected, `string ${at}`);
      assert.equal(detectPageType(null, asUrl), expected, `URL ${at}`);
      assert.equal(detectPageType(null, { pathname: asUrl.pathname, hostname: 'www.youtube.com' }), expected, `location-like ${at}`);
      assert.equal(detectPageType(null, { pathname: asUrl.pathname }), expected, `path only ${at}`);
      assert.equal(detectPageType(null, { href: url }), expected, `href only ${at}`);
    }
  }
});

test('every PAGE_TYPES entry is reachable, nothing else is ever returned, and the map describes exactly these page types', () => {
  const seen = new Set();
  for (const paths of Object.values(URLS)) for (const path of paths) seen.add(detectPageType(null, { pathname: path }));
  assert.deepEqual([...seen].sort(), [...PAGE_TYPES].sort());
  assert.deepEqual(Object.keys(MAP.pageRoles).sort(), [...PAGE_TYPES].sort(), 'pageRoles in the selector map has an entry for each page type');
});

test('real jsdom pages: the location of a createPage() document decides, for all seven kinds, with and without an explicit loc', () => {
  for (const kind of PAGE_KINDS) {
    const p = page(kind);
    assert.equal(detectPageType(p.document), kind, `${kind} from doc.location`);
    assert.equal(detectPageType(p.document, p.window.location), kind, `${kind} from window.location`);
    assert.equal(detectPageType(null, p.window.location), kind, `${kind} with no document at all`);
  }
  const home = page('home', { tileStyle: 'home' });
  assert.equal(detectPageType(home.document), 'home');
  assert.equal(detectPageType(page('home', { tiles: 0 }).document), 'home', 'the logged-out empty state is still the home page');
});

test('createPage url overrides: shorts, other and unknown paths on a real shell', () => {
  assert.equal(detectPageType(page('home', { url: '/shorts/AbCdEfGhIjK' }).document), 'shorts');
  assert.equal(detectPageType(page('home', { url: '/feed/you' }).document), 'other');
  assert.equal(detectPageType(page('watch', { url: '/' }).document), 'home', 'watch markup at the home URL is the home page');
  assert.equal(detectPageType(page('home', { url: '/watch?v=x' }).document), 'watch', 'and the other way round');
  assert.equal(detectPageType(page('channel', { url: '/@NatGeo/shorts' }).document), 'channel', 'a channel Shorts tab is a channel page, not the Shorts player');
});

test('the page type follows pushState navigation (navigateTo) through every kind and back', () => {
  const p = page('home');
  const order = ['watch', 'search', 'channel', 'subscriptions', 'history', 'playlist', 'home', 'watch', 'home'];
  for (const kind of order) {
    navigateTo(p, kind, { tiles: 2 });
    assert.equal(detectPageType(p.document), kind, `after navigating to ${kind}`);
  }
  p.window.history.pushState({}, '', '/shorts/AbCdEfGhIjK');
  assert.equal(detectPageType(p.document), 'shorts');
  p.window.history.pushState({}, '', '/feed/trending');
  assert.equal(detectPageType(p.document), 'other');
});

test('DOM presence proves nothing: a hidden watch skeleton on the home page (and the real selectors seeing it) still means home', () => {
  const p = page('home', { tiles: 3 });
  const pm = p.document.querySelector('ytd-page-manager');
  const skeleton = p.document.createElement('ytd-watch-flexy');
  skeleton.setAttribute('hidden', '');
  skeleton.setAttribute('video-id', '');
  skeleton.innerHTML = '<div id="columns"><div id="primary"><div id="player"><div id="movie_player" class="html5-video-player"></div></div></div><div id="secondary"></div></div>';
  pm.append(skeleton);
  const sel = createSelectors(MAP, p.document);
  assert.equal(sel.has('watchFlexy'), true, 'the watch role "exists" off the watch page');
  assert.equal(sel.has('watchPlayer'), true);
  assert.equal(detectPageType(p.document), 'home');
  // and the reverse: the real watch page with its URL moved elsewhere is not a watch page
  const w = page('watch');
  w.window.history.pushState({}, '', '/feed/you');
  assert.equal(createSelectors(MAP, w.document).has('watchFlexy'), true);
  assert.equal(detectPageType(w.document), 'other');
});

test('foreign hosts are never YouTube pages: music, studio, mobile, embed, nocookie, look-alikes', () => {
  for (const host of ['music.youtube.com', 'studio.youtube.com', 'm.youtube.com', 'tv.youtube.com', 'kids.youtube.com', 'www.youtube-nocookie.com', 'youtube.com.evil.example',
    'evilyoutube.com', 'www.youtu.be', 'youtu.be', 'example.com', 'localhost', 'www.youtube.co.uk']) {
    assert.equal(detectPageType(null, `https://${host}/watch?v=abc`), 'other', host);
    assert.equal(detectPageType(null, { hostname: host, pathname: '/' }), 'other', `${host} root`);
  }
  for (const host of ['www.youtube.com', 'youtube.com', 'WWW.YouTube.COM']) {
    assert.equal(detectPageType(null, { hostname: host, pathname: '/watch' }), 'watch', host);
  }
});

test('encoding, case and decoration: only the path matters; handles keep their case; bad escapes do not throw', () => {
  assert.equal(detectPageType(null, `${YT}/watch?v=x#t=1`), 'watch');
  assert.equal(detectPageType(null, `${YT}/results?search_query=/watch`), 'search', 'a path-looking query does not change the page');
  assert.equal(detectPageType(null, `${YT}/?next=/watch`), 'home');
  assert.equal(detectPageType(null, { pathname: '/watch?v=x' }), 'watch', 'a pathname that still carries a query');
  assert.equal(detectPageType(null, { pathname: '/@NatGeo#top' }), 'channel');
  assert.equal(detectPageType(null, { pathname: '/%40NatGeo' }), 'channel', 'an encoded @');
  assert.equal(detectPageType(null, { pathname: '/%E0%A4%A' }), 'other', 'invalid percent escape');
  assert.equal(detectPageType(null, { pathname: 'watch' }), 'other', 'a path without its leading slash');
  assert.equal(detectPageType(null, { pathname: '/watch\u0000' }), 'other');
  assert.equal(detectPageType(null, { pathname: '/Results' }), 'search', 'route words are matched case-insensitively');
  assert.equal(detectPageType(null, `${YT}/${'a'.repeat(100000)}`), 'other');
  assert.equal(detectPageType(null, `${YT}/@${'a'.repeat(100000)}`), 'channel');
});

test('unusable locations are "other", never an exception: null, blank, numbers, objects, throwing getters, detached documents', () => {
  const throwing = { get pathname() { throw new Error('boom'); } };
  const throwingHref = { pathname: undefined, get href() { throw new Error('boom'); } };
  for (const loc of [null, undefined, '', '   ', 0, 42, true, [], {}, { pathname: 5 }, { pathname: null, href: 5 }, throwing, throwingHref, () => '/watch', Symbol.iterator]) {
    let out;
    assert.doesNotThrow(() => { out = detectPageType(null, loc); }, String(typeof loc));
    assert.equal(out, 'other', JSON.stringify(Object.prototype.toString.call(loc)));
  }
  assert.equal(detectPageType(), 'other');
  assert.equal(detectPageType(null), 'other');
  assert.equal(detectPageType({}), 'other');
  assert.equal(detectPageType({ location: null }), 'other');
  assert.equal(detectPageType({ get location() { throw new Error('boom'); } }), 'other');
  assert.equal(detectPageType({ location: { pathname: '/watch' } }), 'watch', 'a document-like object with a location');
  assert.equal(detectPageType({ location: null, defaultView: { location: { pathname: '/results' } } }), 'search', 'falls back to defaultView.location');
  // An explicit loc beats the document.
  const p = page('watch');
  assert.equal(detectPageType(p.document, '/feed/history'), 'history');
});

test('property check: any string path, any garbage, always one of PAGE_TYPES and never a throw', () => {
  let seed = 0x2545f491;
  const rand = (n) => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % n; };
  const alphabet = ['/', '/', '/', 'watch', 'results', 'feed', 'shorts', '@', 'x', '%', '%E3', '?', '#', '.', '-', ' ', '\u0000', '\u{1F3AC}', 'live', 'channel', 'subscriptions'];
  for (let i = 0; i < 3000; i++) {
    let path = '';
    for (let k = rand(8); k >= 0; k--) path += alphabet[rand(alphabet.length)];
    for (const loc of [path, { pathname: path }, { hostname: 'www.youtube.com', pathname: `/${path}` }, `${YT}/${path}`]) {
      let out;
      assert.doesNotThrow(() => { out = detectPageType(null, loc); }, JSON.stringify(loc));
      assert.ok(PAGE_TYPES.includes(out), `${JSON.stringify(loc)} -> ${out}`);
    }
  }
});

// ---- 2. detectWatchMode --------------------------------------------------------------------------------------------

test('detectWatchMode: default, theatre and fullscreen on a real watch page, following the attributes live', () => {
  const p = page('watch');
  const flexy = p.document.querySelector('ytd-watch-flexy');
  assert.equal(detectWatchMode(p.document), 'default');
  flexy.setAttribute('theater', '');
  assert.equal(detectWatchMode(p.document), 'theatre');
  flexy.setAttribute('fullscreen', '');
  assert.equal(detectWatchMode(p.document), 'fullscreen', 'fullscreen wins over theatre');
  flexy.removeAttribute('fullscreen');
  assert.equal(detectWatchMode(p.document), 'theatre', 'and gives way when it ends');
  flexy.removeAttribute('theater');
  assert.equal(detectWatchMode(p.document), 'default');
  flexy.setAttribute('theater', 'true');
  assert.equal(detectWatchMode(p.document), 'theatre', 'attribute presence is what counts, not its value');
});

test('detectWatchMode: the platform fullscreen element and the player ytp-fullscreen class also mean fullscreen', () => {
  const p = page('watch');
  const { document } = p;
  const player = document.querySelector('#movie_player');
  assert.ok(player && player.classList.contains('html5-video-player'));
  player.classList.add('ytp-fullscreen');
  assert.equal(detectWatchMode(document), 'fullscreen');
  player.classList.remove('ytp-fullscreen');
  assert.equal(detectWatchMode(document), 'default');
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => player });
  assert.equal(detectWatchMode(document), 'fullscreen');
  document.querySelector('ytd-watch-flexy').setAttribute('theater', '');
  assert.equal(detectWatchMode(document), 'fullscreen', 'still wins over theatre');
  delete document.fullscreenElement;
  assert.equal(detectWatchMode(document), 'theatre');
});

test('detectWatchMode: the hidden off-page skeleton never reports a mode, even with stale theater / fullscreen attributes', () => {
  const p = page('home');
  const pm = p.document.querySelector('ytd-page-manager');
  const skeleton = p.document.createElement('ytd-watch-flexy');
  skeleton.setAttribute('hidden', '');
  skeleton.setAttribute('theater', '');
  skeleton.setAttribute('fullscreen', '');
  pm.append(skeleton);
  assert.equal(detectWatchMode(p.document), 'default');
  skeleton.removeAttribute('hidden');
  assert.equal(detectWatchMode(p.document), 'fullscreen', 'the same element, once shown, reports its attributes');

  // The real flow: watch in theatre mode, then navigate away. The watch element is replaced / hidden and the mode resets.
  const q = page('watch');
  q.document.querySelector('ytd-watch-flexy').setAttribute('theater', '');
  assert.equal(detectWatchMode(q.document), 'theatre');
  navigateTo(q, 'home', { tiles: 2 });
  assert.equal(detectWatchMode(q.document), 'default');
});

test('detectWatchMode: supports modern YouTube New UI ytd-watch-grid (default, theatre, fullscreen)', () => {
  const p = page('home');
  const pm = p.document.querySelector('ytd-page-manager');
  const grid = p.document.createElement('ytd-watch-grid');
  grid.setAttribute('video-id', 'BzpdP2APcIM');
  pm.append(grid);
  assert.equal(detectWatchMode(p.document), 'default');
  grid.setAttribute('theater', '');
  assert.equal(detectWatchMode(p.document), 'theatre');
  grid.setAttribute('fullscreen', '');
  assert.equal(detectWatchMode(p.document), 'fullscreen');
  grid.removeAttribute('fullscreen');
  assert.equal(detectWatchMode(p.document), 'theatre');
  grid.setAttribute('hidden', '');
  assert.equal(detectWatchMode(p.document), 'default', 'hidden watch-grid reports default');
});

test('detectWatchMode: pages without a watch element, empty documents and hostile inputs are "default"', () => {
  for (const kind of ['home', 'search', 'channel', 'subscriptions', 'history', 'playlist']) assert.equal(detectWatchMode(page(kind).document), 'default', kind);
  for (const doc of [null, undefined, 0, 'document', {}, [], { querySelector: 1 }, { querySelector() { return null; } }]) {
    assert.equal(detectWatchMode(doc), 'default', String(typeof doc));
  }
  assert.equal(detectWatchMode({ querySelector() { throw new Error('page script broke this'); } }), 'default');
  const p = page('watch');
  p.document.querySelector('ytd-watch-flexy').setAttribute('theater', '');
  p.document.querySelector = () => { throw new Error('boom'); };
  assert.equal(detectWatchMode(p.document), 'default', 'a thrower is a no-answer, not a crash');
});

// ---- 3. observeNavigation ------------------------------------------------------------------------------------------

function collect(win, doc) {
  const calls = [];
  const dispose = observeNavigation(win, doc, (info) => calls.push(info));
  return { calls, dispose, types: () => calls.map((c) => c.type) };
}

test('navigateTo() produces the three real YouTube events in order with the right url, then one page-manager record', async () => {
  const p = page('home');
  const { calls, types } = collect(p.window, p.document);
  const before = p.window.location.href;
  navigateTo(p, 'watch', { tiles: 2 });
  assert.deepEqual(types(), ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'], 'all three, synchronously, in YouTube order');
  assert.equal(calls[0].url, before, 'start fires before the URL changes');
  assert.equal(calls[1].url, `${YT}/watch?v=BzpdP2APcIM`);
  assert.equal(calls[2].url, `${YT}/watch?v=BzpdP2APcIM`);
  assert.equal(detectPageType(p.document, p.window.location), 'watch');
  await tick();
  assert.deepEqual(types(), ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated', 'page-manager'], 'the childList swap is one batched record');
  assert.equal(calls[3].url, `${YT}/watch?v=BzpdP2APcIM`);
  // A chain of navigations: every one reports, nothing is dropped or merged.
  calls.length = 0;
  for (const kind of ['search', 'channel', 'playlist', 'home']) navigateTo(p, kind, { tiles: 2 });
  await tick();
  assert.equal(types().filter((t) => t === 'yt-navigate-start').length, 4);
  assert.equal(types().filter((t) => t === 'yt-navigate-finish').length, 4);
  assert.equal(types().filter((t) => t === 'yt-page-data-updated').length, 4);
  assert.ok(types().includes('page-manager'));
  assert.ok(calls.every((c) => Object.keys(c).sort().join() === 'type,url' && typeof c.url === 'string'));
});

test('each real event is reported on its own: dispatched on window, on document, on a deep non-bubbling element', () => {
  const p = page('watch');
  const { win } = { win: p.window };
  const { calls, types } = collect(win, p.document);
  const Ev = win.CustomEvent;
  for (const type of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated']) {
    win.dispatchEvent(new Ev(type));
    p.document.dispatchEvent(new Ev(type, { bubbles: true }));
    p.document.querySelector('#movie_player').dispatchEvent(new Ev(type)); // does not bubble: capture on window still sees it
    p.document.querySelector('ytd-app').dispatchEvent(new Ev(type, { bubbles: true }));
  }
  assert.equal(calls.length, 12, 'three events from four dispatch sites');
  assert.deepEqual(types().slice(0, 4), Array(4).fill('yt-navigate-start'));
  assert.deepEqual(types().slice(4, 8), Array(4).fill('yt-navigate-finish'));
  assert.deepEqual(types().slice(8), Array(4).fill('yt-page-data-updated'));
  // An unrelated custom event is ignored.
  win.dispatchEvent(new Ev('yt-visibility-refresh'));
  win.dispatchEvent(new Ev('yt-navigate-error'));
  assert.equal(calls.length, 12);
});

test('popstate: a synthetic event and a real history.back() both report, with the restored url', async () => {
  const p = page('home');
  const { win } = { win: p.window };
  const { calls, types } = collect(win, p.document);
  win.dispatchEvent(new win.PopStateEvent('popstate', { state: null }));
  assert.deepEqual(types(), ['popstate']);
  calls.length = 0;
  win.history.pushState({}, '', '/watch?v=abc');
  win.history.pushState({}, '', '/results?search_query=x');
  assert.equal(calls.length, 0, 'pushState itself is silent: YouTube announces its own navigations through the yt-* events');
  const popped = new Promise((resolve) => win.addEventListener('popstate', () => resolve(), { once: true }));
  win.history.back();
  await popped;
  assert.deepEqual(types(), ['popstate']);
  assert.equal(calls[0].url, `${YT}/watch?v=abc`, 'the url is read at notification time');
  assert.equal(detectPageType(p.document), 'watch');
});

test('the ytd-page-manager childList observer reports swaps that no event announced, and only direct-child changes', async () => {
  const p = page('home');
  const { calls, types } = collect(p.window, p.document);
  const pm = p.document.querySelector('ytd-page-manager');
  // Deep changes (YouTube mutates the page constantly) must not count as navigation.
  pm.firstElementChild.append(p.document.createElement('div'));
  pm.querySelector('#contents').append(p.document.createElement('span'));
  await tick();
  assert.deepEqual(types(), [], 'subtree churn is ignored');
  // A swap of the current page element is a navigation even without events.
  const next = p.document.createElement('ytd-search');
  pm.replaceChildren(next);
  await tick();
  assert.deepEqual(types(), ['page-manager']);
  // Several synchronous swaps are one notification (batched by the observer).
  pm.append(p.document.createElement('ytd-watch-flexy'));
  pm.append(p.document.createElement('ytd-browse'));
  pm.firstElementChild.remove();
  await tick();
  assert.deepEqual(types(), ['page-manager', 'page-manager']);
  assert.equal(calls[1].url, p.window.location.href);
});

test('when YouTube replaces the ytd-page-manager element itself, the next event re-attaches the observer to the new one', async () => {
  const p = page('home');
  const { types } = collect(p.window, p.document);
  const oldPm = p.document.querySelector('ytd-page-manager');
  const newPm = p.document.createElement('ytd-page-manager');
  newPm.id = 'page-manager';
  oldPm.replaceWith(newPm);
  p.document.dispatchEvent(new p.window.CustomEvent('yt-navigate-finish', { bubbles: true }));
  assert.deepEqual(types(), ['yt-navigate-finish']);
  newPm.append(p.document.createElement('ytd-browse'));
  await tick();
  assert.deepEqual(types(), ['yt-navigate-finish', 'page-manager'], 'the new node is watched');
  oldPm.append(p.document.createElement('ytd-browse'));
  await tick();
  assert.deepEqual(types(), ['yt-navigate-finish', 'page-manager'], 'the old node is not');
});

test('dispose stops events, popstate and the page-manager observer; it is idempotent and safe from inside the callback', async () => {
  const p = page('home');
  const { win } = { win: p.window };
  const a = collect(win, p.document);
  const b = collect(win, p.document);
  const pm = p.document.querySelector('ytd-page-manager');
  navigateTo(p, 'search', { tiles: 2 });
  await tick();
  const seen = a.calls.length;
  assert.ok(seen >= 4 && b.calls.length === seen, 'two observers are independent and see the same things');
  a.dispose();
  a.dispose();
  navigateTo(p, 'watch', { tiles: 2 });
  win.dispatchEvent(new win.PopStateEvent('popstate'));
  pm.append(p.document.createElement('div'));
  await tick();
  assert.equal(a.calls.length, seen, 'a disposed observer hears nothing');
  assert.ok(b.calls.length > seen, 'and its sibling is unaffected');
  b.dispose();

  // Disposing from inside the callback stops the very next notification of the same dispatch.
  const q = page('home');
  let count = 0;
  let stop = () => {};
  stop = observeNavigation(q.window, q.document, () => { count++; stop(); });
  navigateTo(q, 'watch', { tiles: 2 }); // would be three events
  await tick();
  assert.equal(count, 1);
  // Records already queued when dispose() ran are dropped, not delivered.
  const r = page('home');
  const seenAfter = [];
  const stop2 = observeNavigation(r.window, r.document, (info) => seenAfter.push(info.type));
  r.document.querySelector('ytd-page-manager').append(r.document.createElement('div'));
  stop2();
  await tick();
  assert.deepEqual(seenAfter, []);
});

test('a page manager that does not exist yet (document_start) is picked up as soon as it is parsed, then the bootstrap observer stops', async () => {
  const win = bare('<ytd-app></ytd-app>');
  const doc = win.document;
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => 'loading' });
  const { live, created } = trackObservers(win);
  const { calls, types } = collect(win, doc);
  assert.equal(created.length, 1, 'only the bootstrap observer exists while there is nothing to watch');
  const boot = created[0];
  assert.equal(live.has(boot), true);
  const pm = doc.createElement('ytd-page-manager');
  doc.querySelector('ytd-app').append(pm);
  await tick();
  assert.equal(live.has(boot), false, 'the bootstrap observer is gone once the page manager is found');
  assert.equal(created.length, 2);
  assert.equal(live.has(created[1]), true, 'and a childList observer watches it');
  assert.equal(live.size, 1);
  pm.append(doc.createElement('ytd-browse'));
  await tick();
  assert.deepEqual(types(), ['page-manager']);
  assert.equal(calls.length, 1);
});

test('bootstrap also ends at DOMContentLoaded; the yt-* events then attach the observer when the page manager finally appears', async () => {
  const win = bare('<ytd-app></ytd-app>');
  const doc = win.document;
  Object.defineProperty(doc, 'readyState', { configurable: true, get: () => 'loading' });
  const { live: alive } = trackObservers(win);
  const { types, dispose } = collect(win, doc);
  assert.equal(alive.size, 1);
  doc.dispatchEvent(new win.Event('DOMContentLoaded'));
  assert.equal(alive.size, 0, 'no observer is left running on a document that has no page manager');
  const pm = doc.createElement('ytd-page-manager');
  doc.querySelector('ytd-app').append(pm);
  await tick();
  assert.deepEqual(types(), [], 'nobody was watching yet');
  win.dispatchEvent(new win.CustomEvent('yt-navigate-finish'));
  assert.equal(alive.size, 1, 'the first navigation event found it');
  pm.append(doc.createElement('ytd-browse'));
  await tick();
  assert.deepEqual(types(), ['yt-navigate-finish', 'page-manager']);
  dispose();
  assert.equal(alive.size, 0, 'dispose leaves no observer behind');
});

test('a fully loaded document without a page manager has no observer at all', () => {
  const win = bare('<main>not youtube</main>');
  Object.defineProperty(win.document, 'readyState', { configurable: true, get: () => 'complete' }); // jsdom reports "loading" until its first tick
  const { created } = trackObservers(win);
  const { dispose } = collect(win, win.document);
  assert.equal(created.length, 0);
  dispose();
});

test('NO TIMERS: observeNavigation (setup, every event, observers, dispose) never calls setTimeout, setInterval, rAF or idle callbacks', async () => {
  const p = page('home');
  const { window: win, document: doc } = p;
  const names = ['setTimeout', 'setInterval', 'requestAnimationFrame', 'requestIdleCallback', 'queueMicrotask'];
  const hits = [];
  const restore = [];
  const spy = (host, label) => {
    for (const name of names) {
      if (typeof host[name] !== 'function') continue;
      const original = host[name];
      host[name] = function spied(...args) { hits.push(`${label}.${name}`); return original.apply(this, args); };
      restore.push(() => { host[name] = original; });
    }
  };
  spy(win, 'window');
  spy(globalThis, 'globalThis');
  try {
    const { dispose } = collect(win, doc);
    navigateTo(p, 'watch', { tiles: 2 });
    navigateTo(p, 'home', { tiles: 2 });
    win.dispatchEvent(new win.PopStateEvent('popstate'));
    doc.querySelector('ytd-page-manager').append(doc.createElement('div'));
    await new Promise((resolve) => setImmediate(resolve)); // the test's own wait uses setImmediate, which is not on the spy list
    dispose();
  } finally {
    restore.forEach((fn) => fn());
  }
  // jsdom's MutationObserver may use queueMicrotask internally; the timer APIs are what the contract forbids.
  assert.deepEqual(hits.filter((h) => !h.endsWith('queueMicrotask')), [], 'no timer, rAF or idle callback was scheduled');
});

test('observeNavigation validates its callback and survives a window without addEventListener', () => {
  const p = page('home');
  for (const bad of [undefined, null, 'cb', 42, {}]) assert.throws(() => observeNavigation(p.window, p.document, bad), TypeError);
  // Only a document available: events come from it.
  const seen = [];
  const dispose = observeNavigation(null, p.document, (i) => seen.push(i.type));
  p.document.dispatchEvent(new p.window.CustomEvent('yt-navigate-finish', { bubbles: true }));
  assert.deepEqual(seen, ['yt-navigate-finish']);
  dispose();
  // Nothing usable at all: a no-op observer, still disposable.
  const none = observeNavigation(null, null, () => assert.fail('must not be called'));
  assert.doesNotThrow(() => none());
  assert.doesNotThrow(() => none());
});

test('the url in the callback is "" when location is unreadable, and the callback still runs', () => {
  const handlers = new Map();
  const fakeWin = {
    addEventListener(type, fn) { handlers.set(type, fn); },
    removeEventListener(type) { handlers.delete(type); },
    get location() { throw new Error('location is gone'); },
  };
  const seen = [];
  const dispose = observeNavigation(fakeWin, null, (info) => seen.push(info));
  assert.deepEqual([...handlers.keys()].sort(), ['popstate', 'yt-navigate-finish', 'yt-navigate-start', 'yt-page-data-updated']);
  handlers.get('yt-navigate-finish')();
  assert.deepEqual(seen, [{ type: 'yt-navigate-finish', url: '' }]);
  dispose();
  assert.equal(handlers.size, 0, 'every listener was removed');
});

// ---- 4. hygiene ----------------------------------------------------------------------------------------------------

test('source hygiene: no timers or polling, no network, no eval, no ambient document/window, no imports', () => {
  const code = SOURCE.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback|clearTimeout|clearInterval)\b/);
  assert.doesNotMatch(code, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b/);
  assert.doesNotMatch(code, /\beval\s*\(|new Function|\bimport\s*\(/);
  assert.doesNotMatch(code, /\b(document|window)\./, 'the document and window are always injected');
  assert.doesNotMatch(code, /^import /m, 'page.js is self-contained');
  assert.doesNotMatch(code, /chrome\./);
});
