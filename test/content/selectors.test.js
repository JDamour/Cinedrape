// Tests for src/content/selectors.js (owner: selectors agent).
//
// Real selector map + real YouTube fixtures (createPage). What is proven:
//   1. The API surface and the construction contract.
//   2. find/findAll/has agree with an independent "first non-empty selector wins" oracle on every real page, for every role.
//   3. Fallback order on a synthetic document: first non-empty selector wins (never a union), invalid / junk entries are skipped.
//   4. Renamed YouTube elements fall through the selector list; a total rename means "missing".
//   5. setMap hot-swaps cleanly and refuses junk without losing the old map.
//   6. Stale, null, detached and hostile roots never throw and never widen the search to the whole document.
//   7. css(role) is the parseable union; the module has no timers, no network and no ambient DOM globals.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import { createPage, navigateTo, readTile } from '../helpers/dom.js';
import { createSelectors } from '../../src/content/selectors.js';

const MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const SOURCE = readFileSync(new URL('../../src/content/selectors.js', import.meta.url), 'utf8');

const open = [];
function page(kind, opts = {}) {
  const p = createPage(kind, { tiles: 6, ...opts });
  open.push(p);
  return p;
}
after(() => { for (const p of open) p.window.close(); });

/** A small hand-written document for the fallback-order tests. */
function tiny(html) {
  const dom = new JSDOM(`<!doctype html><html><body>${html}</body></html>`);
  open.push({ window: dom.window });
  return dom.window.document;
}
const mapOf = (roles) => ({ schema: 1, mapVersion: '0.0.0.1', roles });
const text = (el) => (el ? el.textContent.replace(/\s+/g, ' ').trim() : null);

const PAGES = [
  ['home', {}], ['home', { tileStyle: 'home' }], ['home', { tiles: 0 }], ['watch', {}], ['search', {}], ['channel', {}],
  ['subscriptions', {}], ['history', {}], ['playlist', {}], ['watch', { ads: 2 }], ['home', { shorts: true, ads: 1 }],
];

// ---- 1. surface ----------------------------------------------------------------------------------------------------

test('createSelectors exposes exactly find/findAll/has/css/setMap/map and returns the map it was given', () => {
  const { document } = page('home');
  const sel = createSelectors(MAP, document);
  assert.deepEqual(Object.keys(sel).sort(), ['css', 'find', 'findAll', 'has', 'map', 'setMap']);
  for (const fn of Object.values(sel)) assert.equal(typeof fn, 'function');
  assert.equal(sel.map(), MAP);
});

test('construction refuses a map it can never use (loudly, once) while every later call stays quiet', () => {
  const { document } = page('home');
  for (const bad of [null, undefined, 0, 'map', [], {}, { roles: null }, { roles: [] }, { roles: 'x' }]) {
    assert.throws(() => createSelectors(bad, document), TypeError, `map ${JSON.stringify(bad)}`);
  }
  assert.doesNotThrow(() => createSelectors(MAP, null));
  assert.doesNotThrow(() => createSelectors(MAP, undefined));
});

// ---- 2. oracle agreement on real pages -----------------------------------------------------------------------------

/** What the contract says, written independently of the module: the first selector with any match wins. */
function oracle(root, role) {
  for (const s of MAP.roles[role]) {
    const els = [...root.querySelectorAll(s)];
    if (els.length) return els;
  }
  return [];
}

test('find/findAll/has equal the first-non-empty oracle for every role on every real page variant', () => {
  let nonEmpty = 0;
  let checked = 0;
  for (const [kind, opts] of PAGES) {
    const { document } = page(kind, opts);
    const sel = createSelectors(MAP, document);
    for (const role of Object.keys(MAP.roles)) {
      const expected = oracle(document, role);
      const all = sel.findAll(role);
      assert.ok(Array.isArray(all), 'findAll returns a real Array');
      assert.equal(all.length, expected.length, `${kind}/${role}: findAll length`);
      all.forEach((el, i) => assert.equal(el, expected[i], `${kind}/${role}: findAll[${i}] is the same node, in document order`));
      assert.equal(sel.find(role), expected[0] ?? null, `${kind}/${role}: find`);
      assert.equal(sel.has(role), expected.length > 0, `${kind}/${role}: has`);
      checked++;
      if (expected.length) nonEmpty++;
    }
  }
  assert.ok(checked > 400, `only ${checked} role x page checks ran`);
  assert.ok(nonEmpty > 120, `only ${nonEmpty} of them were non-empty: the fixtures are not being exercised`);
});

test('real fixture facts through the API: shell, watch page, home grid, tiles', () => {
  const watch = page('watch', { tiles: 4 });
  const w = createSelectors(MAP, watch.document);
  assert.equal(w.find('app').localName, 'ytd-app');
  assert.equal(w.find('pageManager').id, 'page-manager');
  assert.match(text(w.find('watchTitle')), /^Destination Wild: Rwanda/);
  assert.equal(w.findAll('videoTile').length, 4, 'four related lockups');
  assert.equal(text(w.find('viewCounts')), '84k views', 'watch info text, first span only');
  assert.equal(w.findAll('endScreens').length, 2, 'the two real .ytp-ce-element cards');
  assert.equal(w.find('comments').id, 'comments');
  assert.ok(w.find('watchPlayer').matches('#movie_player'));

  const home = page('home', { tiles: 5, tileStyle: 'home' });
  const h = createSelectors(MAP, home.document);
  assert.equal(h.find('homeBrowse').getAttribute('page-subtype'), 'home');
  const contents = h.find('homeGridContents');
  assert.equal(contents.id, 'contents');
  assert.equal(contents.parentElement, h.find('homeGrid'));
  assert.equal(h.findAll('richItem').length, 5);
  assert.equal(h.find('continuation').localName, 'ytd-continuation-item-renderer');
  assert.equal(h.find('chips').localName, 'ytd-feed-filter-chip-bar-renderer');

  // Tile roles scoped to a tile (what collectTiles / extractTile do): the root narrows the search, it does not widen it.
  const item = h.findAll('richItem')[2];
  const expected = readTile(item);
  const lockup = h.find('videoTile', item);
  assert.equal(lockup.localName, 'yt-lockup-view-model');
  assert.equal(h.find('tileLink', item).getAttribute('href'), `/watch?v=${expected.id}`);
  assert.equal(text(h.find('tileTitle', item)), expected.title);
  assert.equal(text(h.find('tileDuration', item)), expected.duration);
  assert.equal(h.findAll('tileMeta', item).length, 3, 'home tile: channel, views, age');
  assert.equal(text(h.find('tileChannel', item)), 'Wild Frames', 'third synthetic channel');
  assert.notEqual(h.find('tileTitle', item), h.find('tileTitle'), 'scoped lookup returns this tile, not the first on the page');

  const grid = page('channel', { tiles: 3 });
  const g = createSelectors(MAP, grid.document);
  const gridItem = g.findAll('richItem')[1];
  assert.equal(g.find('tileChannel', gridItem), null, 'channel-grid tiles have no channel row: missing, not wrong');
  assert.equal(g.findAll('tileMeta', gridItem).length, 2, 'views, age');
});

// ---- 3. fallback order on a synthetic document ---------------------------------------------------------------------

test('fallback order: the first selector with a match wins and later ones are never unioned in', () => {
  const doc = tiny('<i class="b">b1</i><i class="b">b2</i><i class="c">c1</i><i class="c">c2</i><i class="c">c3</i>');
  const sel = createSelectors(mapOf({ multi: ['.a', '.b', '.c'], onlyC: ['.a', '.zzz', '.c'] }), doc);
  assert.equal(text(sel.find('multi')), 'b1');
  assert.deepEqual(sel.findAll('multi').map(text), ['b1', 'b2'], 'two .b, not the five .b/.c');
  assert.equal(sel.findAll('onlyC').length, 3, 'falls through two empty selectors to the third');
  doc.body.insertAdjacentHTML('afterbegin', '<i class="a">a1</i>');
  assert.equal(text(sel.find('multi')), 'a1', 'a higher-priority match appearing later takes over immediately (no caching)');
  assert.deepEqual(sel.findAll('multi').map(text), ['a1']);
  doc.querySelector('.a').remove();
  assert.equal(text(sel.find('multi')), 'b1', 'and gives way again when it goes');
});

test('junk inside a role is skipped, not thrown: invalid syntax, non-strings, blanks, a non-array role value', () => {
  const doc = tiny('<i class="b">ok</i>');
  const sel = createSelectors(mapOf({
    invalid: ['a[', ':is(', '.b'], mixed: [null, 42, '', '   ', {}, ['.b'], '.b'], empty: [], notArray: '.b', nested: { 0: '.b' }, nullRole: null,
  }), doc);
  for (let i = 0; i < 3; i++) { // the second and third time exercise the remembered "invalid" verdict
    assert.equal(text(sel.find('invalid')), 'ok');
    assert.equal(sel.findAll('invalid').length, 1);
    assert.equal(text(sel.find('mixed')), 'ok');
  }
  for (const role of ['empty', 'notArray', 'nested', 'nullRole']) {
    assert.equal(sel.find(role), null, role);
    assert.deepEqual(sel.findAll(role), [], role);
    assert.equal(sel.has(role), false, role);
    assert.equal(sel.css(role), '', role);
  }
});

test('unknown and hostile role names are plain misses (nothing is read from Object.prototype)', () => {
  const doc = tiny('<i class="b"></i>');
  const sel = createSelectors(mapOf({ real: ['.b'] }), doc);
  for (const role of ['nope', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf', undefined, null, 42, {}, [], Symbol('x')]) {
    assert.equal(sel.find(role), null, String(typeof role));
    assert.deepEqual(sel.findAll(role), []);
    assert.equal(sel.has(role), false);
    assert.equal(sel.css(role), '');
  }
  assert.equal(sel.find('real') !== null, true);
});

test('results are live: no node is ever cached between calls', () => {
  const { document } = page('home', { tiles: 4 });
  const sel = createSelectors(MAP, document);
  const before = sel.findAll('richItem');
  assert.equal(before.length, 4);
  before[0].remove();
  assert.equal(sel.findAll('richItem').length, 3);
  before.forEach((el) => el.remove());
  assert.deepEqual(sel.findAll('richItem'), []);
  assert.equal(sel.has('richItem'), false);
  assert.equal(before.length, 4, 'a returned array is a snapshot the caller owns');
});

// ---- 4. renamed YouTube elements -----------------------------------------------------------------------------------

test('renamed elements fall through the list to the next selector; a total rename is "missing"', () => {
  // masthead: ytd-masthead -> #masthead-container
  const a = page('home', { rename: ['ytd-masthead'] });
  assert.equal(a.renamed, 1);
  const sa = createSelectors(MAP, a.document);
  assert.equal(sa.find('masthead').id, 'masthead-container');
  assert.equal(sa.has('masthead'), true);
  const b = page('home', { rename: ['ytd-masthead', '#masthead-container'] });
  assert.equal(createSelectors(MAP, b.document).find('masthead'), null);

  // the two browse wrappers: either one keeps homeBrowse alive, both gone = missing, and homeGrid goes with them
  const c = page('home', { rename: ['ytd-browse'] });
  const sc = createSelectors(MAP, c.document);
  assert.equal(sc.find('homeBrowse').localName, 'ytd-two-column-browse-results-renderer');
  const d = page('home', { rename: ['ytd-browse', 'ytd-two-column-browse-results-renderer'] });
  const sd = createSelectors(MAP, d.document);
  assert.equal(sd.find('homeBrowse'), null);
  assert.equal(sd.has('homeGrid'), false);
  assert.equal(sd.has('homeGridContents'), false);

  // the only selector of 'app': renaming it is detected as a missing role
  const e = page('watch', { rename: ['ytd-app'] });
  assert.equal(createSelectors(MAP, e.document).find('app'), null);

  // endScreens: three shapes, all renamed
  const f = page('watch', { rename: ['.ytp-ce-element'] });
  const sf = createSelectors(MAP, f.document);
  assert.equal(sf.has('endScreens'), true, 'the endscreen content / shadow survive');
  assert.ok(sf.find('endScreens').matches('.ytp-endscreen-content, .ytp-ce-shadow'));
  const g = page('watch', { rename: ['.ytp-ce-element', '.ytp-endscreen-content', '.ytp-ce-shadow'] });
  assert.equal(createSelectors(MAP, g.document).has('endScreens'), false);
});

test('a rename applied AFTER construction is seen by the next call (selectors read the live document)', () => {
  const p = page('watch', { tiles: 3 });
  const sel = createSelectors(MAP, p.document);
  const player = sel.find('watchPlayer');
  assert.ok(player);
  player.removeAttribute('id');
  player.classList.remove('html5-video-player');
  assert.equal(sel.find('watchPlayer'), null, 'all three watchPlayer shapes need the id or the class');
  assert.equal(sel.has('watchPlayerContainer'), true, 'siblings of the broken role are unaffected');
});

// ---- 5. setMap -------------------------------------------------------------------------------------------------------

test('setMap hot-swaps the selector lists, css() and map() together, and leaves the old map object untouched', () => {
  const doc = tiny('<main id="m"></main><section class="s"></section>');
  const first = mapOf({ x: ['#m'], y: ['.s'], gone: ['.s'] });
  const frozen = JSON.stringify(first);
  const sel = createSelectors(first, doc);
  assert.equal(sel.find('x').id, 'm');
  const second = mapOf({ x: ['.s'], y: ['#nothing', '#m'], added: ['main'] });
  assert.equal(sel.setMap(second), true);
  assert.equal(sel.map(), second);
  assert.equal(sel.find('x').className, 's', 'same role, new selector');
  assert.equal(sel.find('y').id, 'm', 'new fallback order');
  assert.equal(sel.css('y'), '#nothing, #m');
  assert.equal(sel.find('added').localName, 'main');
  assert.equal(sel.find('gone'), null, 'a role dropped by the new map is missing');
  assert.equal(JSON.stringify(first), frozen, 'the previous map was not mutated');
  assert.equal(sel.setMap(first), true, 'and swapping back works');
  assert.equal(sel.find('x').id, 'm');
});

test('setMap refuses anything without a roles object and keeps serving the previous map', () => {
  const doc = tiny('<main id="m"></main>');
  const good = mapOf({ x: ['#m'] });
  const sel = createSelectors(good, doc);
  for (const bad of [null, undefined, 0, 'x', true, [], {}, { roles: null }, { roles: [] }, { roles: 'x' }]) {
    assert.equal(sel.setMap(bad), false, JSON.stringify(bad));
    assert.equal(sel.map(), good);
    assert.equal(sel.find('x').id, 'm');
  }
});

test('hot-swapping the real map for a new real map (new mapVersion) switches page lookups at once', () => {
  const p = page('home', { tiles: 3 });
  const sel = createSelectors(MAP, p.document);
  assert.equal(sel.find('masthead').localName, 'ytd-masthead');
  const next = JSON.parse(JSON.stringify(MAP));
  next.mapVersion = '2026.10.08.1';
  next.roles.masthead = ['#masthead-container', 'ytd-masthead'];
  assert.equal(sel.setMap(next), true);
  assert.equal(sel.find('masthead').id, 'masthead-container');
  assert.equal(sel.css('masthead'), '#masthead-container, ytd-masthead');
  assert.equal(MAP.roles.masthead[0], 'ytd-masthead', 'the original object is intact');
});

// ---- 6. stale, null, detached and hostile roots --------------------------------------------------------------------

test('a null root (a lookup the caller already failed) is "nothing", never "the whole document"', () => {
  const { document } = page('home', { tiles: 3 });
  const sel = createSelectors(MAP, document);
  assert.ok(sel.find('richItem'), 'the document does have rich items');
  assert.equal(sel.find('richItem', null), null);
  assert.deepEqual(sel.findAll('richItem', null), []);
  assert.equal(sel.has('richItem', null), false);
  assert.equal(sel.find('richItem', undefined) !== null, true, 'undefined (omitted) means the document');
});

test('stale root: an element YouTube already removed is searched as the detached subtree it is, and cannot reach the new page', () => {
  const p = page('home', { tiles: 3 });
  const { document } = p;
  const sel = createSelectors(MAP, document);
  const oldGrid = sel.find('homeGrid');
  const oldTiles = sel.findAll('richItem', oldGrid);
  assert.equal(oldTiles.length, 3);
  navigateTo(p, 'search', { tiles: 2 }); // the SPA swaps the page: oldGrid is no longer in the document
  assert.equal(oldGrid.isConnected, false);
  assert.doesNotThrow(() => sel.findAll('richItem', oldGrid));
  const stale = sel.findAll('richItem', oldGrid);
  assert.equal(stale.length, 3);
  assert.ok(stale.every((el) => !el.isConnected), 'only dead nodes: nothing from the live search page leaks in');
  assert.equal(sel.find('richItem'), null, 'the live document has none');
  assert.equal(sel.find('homeGrid', oldGrid), null, 'a root never matches itself');
});

test('detached containers work (extractTile-style tests parse a tile into a lone <div>)', () => {
  const doc = tiny('');
  const box = doc.createElement('div');
  box.innerHTML = '<ytd-rich-item-renderer><div id="content"><yt-lockup-view-model><a class="ytLockupMetadataViewModelTitle" href="/watch?v=abc">T</a></yt-lockup-view-model></div></ytd-rich-item-renderer>';
  const sel = createSelectors(MAP, doc);
  assert.equal(sel.find('richItem', box).localName, 'ytd-rich-item-renderer');
  assert.equal(sel.find('videoTile', box).localName, 'yt-lockup-view-model');
  assert.equal(sel.find('tileTitle', box).getAttribute('href'), '/watch?v=abc');
  const frag = doc.createDocumentFragment();
  frag.append(box);
  assert.equal(sel.findAll('videoTile', frag).length, 1, 'DocumentFragment roots work too');
});

test('roots that are not elements, or that misbehave, never throw and never poison later lookups', () => {
  const { document } = page('home', { tiles: 3 });
  const sel = createSelectors(MAP, document);
  const textNode = document.createTextNode('x');
  const comment = document.createComment('x');
  const hostile = [
    {}, [], 'ytd-app', 42, true, () => {}, Symbol('s'), textNode, comment, { querySelector: 1 }, { querySelector() {}, querySelectorAll: null },
    { querySelector() { throw new Error('page script broke this'); }, querySelectorAll() { throw new Error('page script broke this'); } },
    { querySelector() { throw new DOMException('not a syntax error', 'InvalidStateError'); }, querySelectorAll() { throw new DOMException('x', 'InvalidStateError'); } },
  ];
  for (const root of hostile) {
    assert.equal(sel.find('richItem', root), null);
    assert.deepEqual(sel.findAll('richItem', root), []);
    assert.equal(sel.has('richItem', root), false);
  }
  // None of that marked a perfectly good selector as invalid.
  assert.equal(sel.findAll('richItem').length, 3);
  assert.equal(sel.css('richItem'), 'ytd-rich-item-renderer, [rendered-from-rich-grid]');
});

test('a document whose querySelector page scripts replaced with a thrower cannot take the caller down', () => {
  const doc = tiny('<i class="b"></i>');
  const sel = createSelectors(mapOf({ r: ['.b'] }), doc);
  doc.querySelector = () => { throw new Error('boom'); };
  doc.querySelectorAll = () => { throw new Error('boom'); };
  assert.equal(sel.find('r'), null);
  assert.deepEqual(sel.findAll('r'), []);
  assert.equal(sel.has('r'), false);
});

test('without a document, only explicit roots work', () => {
  const doc = tiny('<i class="b"></i>');
  const sel = createSelectors(mapOf({ r: ['.b'] }), null);
  assert.equal(sel.find('r'), null);
  assert.deepEqual(sel.findAll('r'), []);
  assert.equal(sel.find('r', doc.body)?.className, 'b');
  assert.equal(sel.css('r'), '.b', 'css() needs no document');
});

test('a root from another window is searched in its own tree', () => {
  const a = page('home', { tiles: 2 });
  const b = page('home', { tiles: 5 });
  const sel = createSelectors(MAP, a.document);
  assert.equal(sel.findAll('richItem', b.document).length, 5);
  assert.equal(sel.findAll('richItem').length, 2);
});

// ---- 7. css(role) ----------------------------------------------------------------------------------------------------

test('css(role) is the comma-joined union of every selector, in map order, and every real role parses', () => {
  const { document } = page('search', { tiles: 3 });
  const sel = createSelectors(MAP, document);
  assert.equal(sel.css('chips'), 'ytd-feed-filter-chip-bar-renderer, chip-bar-view-model, yt-chip-cloud-renderer');
  assert.equal(sel.css('app'), 'ytd-app');
  assert.equal(sel.css('definitely-not-a-role'), '');
  for (const role of Object.keys(MAP.roles)) {
    const css = sel.css(role);
    assert.equal(css, MAP.roles[role].join(', '), `${role}: nothing dropped from a valid list`);
    const union = new Set(document.querySelectorAll(css));
    const parts = new Set(MAP.roles[role].flatMap((s) => [...document.querySelectorAll(s)]));
    assert.deepEqual([...union], [...parts].sort((x, y) => (x.compareDocumentPosition(y) & 4 ? -1 : 1)), `${role}: the union selects what the parts select`);
  }
  // find() deliberately returns one shape; css() covers all of them.
  assert.equal(sel.findAll('videoTile').length, 1, 'search: only the playlist lockup (the first non-empty shape)');
  assert.equal(document.querySelectorAll(sel.css('videoTile')).length, 4, 'but a stylesheet rule must reach the three video rows too');
});

test('css(role) drops entries that would make the whole rule invalid, and trims', () => {
  const doc = tiny('');
  const sel = createSelectors(mapOf({ r: ['  .a  ', 'a[', '.b', null, '', '#1x'], allBad: ['a[', 'b >'] }), doc);
  assert.equal(sel.css('r'), '.a, .b');
  assert.equal(sel.css('allBad'), '');
});

// ---- 8. hygiene ------------------------------------------------------------------------------------------------------

test('overhead: find costs what the raw querySelector chain costs, on a 300-tile page (jsdom itself is slow on :has)', () => {
  const { document } = page('home', { tiles: 300, tileStyle: 'home' });
  const sel = createSelectors(MAP, document);
  const roles = Object.keys(MAP.roles);
  const rawFirst = (root, role) => {
    for (const s of MAP.roles[role]) { const hit = root.querySelector(s); if (hit) return hit; }
    return null;
  };
  const tiles = sel.findAll('richItem');
  assert.equal(tiles.length, 300);
  const timeIt = (fn) => { const t0 = performance.now(); fn(); return performance.now() - t0; };
  rawFirst(document, 'viewCounts'); // warm the selector engine's caches for both sides
  const raw = timeIt(() => { for (const role of roles) rawFirst(document, role); for (const t of tiles.slice(0, 100)) { rawFirst(t, 'tileTitle'); rawFirst(t, 'tileLink'); } });
  const mine = timeIt(() => { for (const role of roles) sel.find(role); for (const t of tiles.slice(0, 100)) { sel.find('tileTitle', t); sel.find('tileLink', t); } });
  assert.ok(mine < raw * 2.5 + 150, `find took ${mine.toFixed(0)} ms against ${raw.toFixed(0)} ms for the same raw queries`);
});

test('source hygiene: no timers, no network, no eval, no ambient document/window (the document is injected)', () => {
  assert.doesNotMatch(SOURCE, /\b(setTimeout|setInterval|requestAnimationFrame|requestIdleCallback)\b/);
  assert.doesNotMatch(SOURCE, /\b(fetch|XMLHttpRequest|sendBeacon|WebSocket|EventSource|importScripts)\b/);
  assert.doesNotMatch(SOURCE, /\beval\s*\(|new Function|\bimport\s*\(/);
  assert.doesNotMatch(SOURCE, /\b(document|window|globalThis|chrome)\./);
  assert.doesNotMatch(SOURCE, /^import /m, 'selectors.js is self-contained');
});
