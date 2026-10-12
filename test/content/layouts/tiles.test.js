// Tests for src/content/layouts/tiles.js (owner: layouts agent).
//
// Real selector map + real YouTube fixtures (createPage). What is proven:
//   1. extractTile agrees with an independent reader (readTile from the fixture helpers) on every real tile shape: channel grid,
//      home (avatar + "channel, views, age"), search rows, watch-related lockups, playlist rows, history rows.
//   2. The three metadata shapes of ARCHITECTURE.md section 1 come out as documented (meta / channel).
//   3. hrefs are absolute, keep their query string exactly, and only /watch pages on YouTube count.
//   4. Not-a-video things are null / skipped: ads (all synthetic ad shapes), Shorts, playlist and Mix lockups, placeholders,
//      tiles without a title or a link, off-site and javascript: links.
//   5. Renamed markup degrades (fallbacks) instead of throwing; hostile input never throws.
//   6. isAdTile fails closed on a map without an ad list and survives one unparseable entry in it.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage, createTile, readTile, loadTemplates } from '../../helpers/dom.js';
import { createSelectors } from '../../../src/content/selectors.js';
import { extractTile, collectTiles, isAdTile, readThumb } from '../../../src/content/layouts/tiles.js';

const MAP = JSON.parse(readFileSync(new URL('../../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const clone = (v) => structuredClone(v);

const open = [];
function page(kind, opts = {}) {
  const p = createPage(kind, { tiles: 6, ...opts });
  open.push(p);
  p.sel = createSelectors(MAP, p.document);
  return p;
}
after(() => { for (const p of open) p.window.close(); });

/** Replaces the home grid's tiles with the given HTML (keeps the continuation) and returns the contents element. */
function withTiles(p, ...items) {
  const contents = p.sel.find('homeGridContents');
  for (const c of [...contents.children]) if (!c.matches('ytd-continuation-item-renderer')) c.remove();
  const cont = contents.querySelector('ytd-continuation-item-renderer');
  for (const html of items) {
    const holder = p.document.createElement('template');
    holder.innerHTML = html;
    contents.insertBefore(holder.content, cont);
  }
  return contents;
}
const first = (p) => p.document.querySelector('ytd-rich-item-renderer');
const SHAPES = [['home', { tileStyle: 'grid' }], ['home', { tileStyle: 'home' }], ['channel', {}]];

// ---- 1. real tiles vs an independent reader ----------------------------------------------------------------------------

for (const [kind, opts] of SHAPES) {
  test(`${kind}/${opts.tileStyle || 'grid'}: every tile matches the fixture reader (id, title, duration, views, age)`, () => {
    const p = page(kind, { tiles: 9, ...opts });
    const items = [...p.document.querySelectorAll('ytd-rich-item-renderer')].filter((el) => el.querySelector('yt-lockup-view-model'));
    assert.equal(items.length, 9);
    for (const item of items) {
      const want = readTile(item);
      const tile = extractTile(item, p.sel);
      assert.ok(tile, `tile ${want.id} should extract`);
      assert.equal(tile.videoId, want.id);
      assert.equal(tile.title, want.title);
      assert.equal(tile.duration, want.duration);
      assert.equal(tile.href, `https://www.youtube.com/watch?v=${want.id}`);
      assert.match(tile.thumb, /^https:\/\/i\.ytimg\.com\/vi\/[\w-]+\/hq720\.jpg$/);
      assert.equal(tile.meta.at(-1), want.age);
      assert.ok(tile.meta.includes(want.views));
    }
  });

  test(`${kind}/${opts.tileStyle || 'grid'}: wrapper, lockup and collectTiles give the same tile`, () => {
    const p = page(kind, { tiles: 4, ...opts });
    const item = first(p);
    const viaWrapper = extractTile(item, p.sel);
    const viaLockup = extractTile(item.querySelector('yt-lockup-view-model'), p.sel);
    assert.deepEqual(viaWrapper, viaLockup);
    const all = collectTiles(p.document, p.sel);
    assert.equal(all.length, 4);
    assert.deepEqual(all[0], viaLockup);
    assert.equal(all[0].el, item.querySelector('yt-lockup-view-model'));
  });
}

test('metadata shapes: channel grid has no channel; home has channel first; both keep every text in order', () => {
  const g = page('home', { tiles: 2, tileStyle: 'grid' });
  const gridTile = extractTile(first(g), g.sel);
  assert.equal(gridTile.channel, '');
  assert.equal(gridTile.meta.length, 2);

  const h = page('home', { tiles: 2, tileStyle: 'home' });
  const homeTile = extractTile(first(h), h.sel);
  assert.equal(homeTile.channel, 'National Geographic');
  assert.deepEqual(homeTile.meta.length, 3);
  assert.equal(homeTile.meta[0], homeTile.channel);
});

test('watch-related lockups: channel comes from row 1, meta holds channel, views, age (age may read "Streamed ...")', () => {
  const p = page('watch', { tiles: 3 });
  const tiles = collectTiles(p.sel.find('watchRelated') || p.document, p.sel);
  assert.equal(tiles.length, 3);
  for (const t of tiles) {
    assert.ok(t.channel.length > 0);
    assert.equal(t.meta[0], t.channel);
    assert.equal(t.meta.length, 3);
  }
  for (const t of tiles.slice(0, 2)) assert.match(t.href, /[?&]pp=/, 'the pp tracking parameter is kept');
  assert.match(tiles[2].meta[2], /^Streamed /);
});

test('legacy renderers (search, history): channel from ytd-channel-name, meta is views and age only', () => {
  for (const kind of ['search', 'history']) {
    const p = page(kind, { tiles: 3 });
    const tiles = collectTiles(p.document, p.sel);
    assert.equal(tiles.length, 3, kind);
    for (const t of tiles) {
      assert.ok(t.channel, `${kind}: channel`);
      assert.equal(t.meta.length, 2, `${kind}: meta`);
      assert.notEqual(t.meta[0], t.channel);
    }
  }
});

test('playlist rows keep list= and index= in the href and report the row channel', () => {
  const p = page('playlist', { tiles: 3 });
  const tiles = collectTiles(p.document, p.sel);
  assert.equal(tiles.length, 3);
  assert.match(tiles[1].href, /[?&]list=PL[\w-]+&index=2&pp=/);
  assert.equal(tiles[1].videoId.length, 11);
});

test('a live stream and a collab keep their texts; empty and whitespace-only metadata spans are dropped', () => {
  const p = page('home', { tiles: 3, tileStyle: 'home' });
  const item = first(p);
  const row = item.querySelector('.ytContentMetadataViewModelMetadataRow');
  const texts = [...row.querySelectorAll('.ytContentMetadataViewModelMetadataText')];
  texts[2].textContent = '   ';
  texts[1].textContent = '591 watching';
  const t = extractTile(item, p.sel);
  assert.deepEqual(t.meta, ['National Geographic', '591 watching']);
  assert.equal(t.channel, 'National Geographic');
});

// ---- 2. hrefs ----------------------------------------------------------------------------------------------------------

test('href is absolute and keeps the original query string and fragment exactly', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  const raw = '/watch?v=abcdefghijk&pp=ygUSbmF0dXJl%3D%3D&t=95s&list=PLx';
  item.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', raw));
  assert.equal(extractTile(item, p.sel).href, `https://www.youtube.com${raw}`);
  item.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', 'https://www.youtube.com/watch?v=abcdefghijk#frag'));
  const t = extractTile(item, p.sel);
  assert.equal(t.href, 'https://www.youtube.com/watch?v=abcdefghijk#frag');
  assert.equal(t.videoId, 'abcdefghijk');
});

test('only /watch pages on YouTube are tiles: shorts, channels, off-site, javascript:, data:, empty and missing hrefs are not', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  const set = (href) => {
    item.querySelectorAll('a').forEach((a) => (href === null ? a.removeAttribute('href') : a.setAttribute('href', href)));
    return extractTile(item, p.sel);
  };
  for (const bad of ['/shorts/abcdefghijk', '/@NatGeo', '/playlist?list=PLx', 'https://evil.example/watch?v=abcdefghijk',
    'https://www.youtube.com.evil.example/watch?v=abcdefghijk', 'javascript:alert(1)', 'data:text/html,hi', '', '   ', null, '/watchfake?v=1']) {
    assert.equal(set(bad), null, JSON.stringify(bad));
  }
  assert.ok(set('/watch?v=abcdefghijk'));
  assert.ok(set('https://www.youtube.com/watch?v=abcdefghijk'));
  // A tile's main link must be on this origin: another youtube.com host, or an id that is not 11 characters, is not an organic
  // feed tile, so it is left in YouTube's grid (fail closed; the rule exists because no ad marker was ever seen on a real ad).
  for (const odd of ['https://m.youtube.com/watch?v=abcdefghijk', '/watch?v=short', '/watch?v=abcdefghijkl', '/watch', '/watch?list=PLx', '/watch/abcdefghijk']) {
    assert.equal(set(odd), null, odd);
  }
});

test('a /watch link without a v parameter is not a tile, whatever the lockup host class says (no id is invented)', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  item.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', '/watch/CDtile00001'));
  assert.equal(extractTile(item, p.sel), null);
});

// ---- 3. not a video ----------------------------------------------------------------------------------------------------

test('collectTiles skips every ad shape, the masthead ad, Shorts shelves and cells, on home and on watch', () => {
  for (const shorts of [true, 'grid', 'reel']) {
    const h = page('home', { tiles: 8, ads: 3, shorts, tileStyle: 'home' });
    const tiles = collectTiles(h.document, h.sel);
    assert.equal(tiles.length, 8, `home shorts=${shorts}`);
    assert.ok(tiles.every((t) => !t.href.includes('invalid') && !t.href.includes('/shorts/')));
  }
  const w = page('watch', { tiles: 5, ads: 2 });
  const tiles = collectTiles(w.document, w.sel);
  assert.equal(tiles.length, 5);
  assert.ok(tiles.every((t) => !t.href.includes('invalid')));
});

test('an ad slot never extracts, whatever is inside it', () => {
  const p = page('home', { tiles: 3, ads: 2 });
  const ads = [...p.document.querySelectorAll('[data-cd-synthetic="feed-ad"]')];
  assert.ok(ads.length >= 2);
  for (const ad of ads) {
    assert.equal(extractTile(ad, p.sel), null);
    assert.equal(isAdTile(ad, MAP), true);
  }
  // A perfectly normal-looking lockup that sits inside an ad slot, and one that carries an ad badge.
  const normal = first(p);
  const wrapped = p.document.createElement('ytd-ad-slot-renderer');
  normal.parentNode.insertBefore(wrapped, normal);
  wrapped.appendChild(normal);
  assert.equal(extractTile(normal, p.sel), null, 'inside ytd-ad-slot-renderer');
  wrapped.replaceWith(normal);
  assert.ok(extractTile(normal, p.sel));
  const badge = p.document.createElement('ad-badge-view-model');
  normal.querySelector('.ytLockupMetadataViewModelTextContainer').appendChild(badge);
  assert.equal(extractTile(normal, p.sel), null, 'tile holding an ad badge');
  badge.remove();
  const sponsored = p.document.createElement('span');
  sponsored.className = 'ytwAdBadge';
  normal.appendChild(sponsored);
  assert.equal(extractTile(normal, p.sel), null, 'tile holding .ytwAdBadge');
});

test('a tile that holds a sponsorship disclosure is not mirrored either (a card could not show it)', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  assert.ok(extractTile(item, p.sel));
  const holder = p.document.createElement('div');
  holder.innerHTML = loadTemplates('synthetic/ad-slot').sponsor;
  const overlay = holder.firstElementChild;
  overlay.querySelectorAll('a[href]').forEach((a) => a.setAttribute('href', '/watch?v=abcdefghijk'));   // the disclosure stays on youtube.com
  item.appendChild(overlay);
  assert.equal(extractTile(item, p.sel), null);
  assert.equal(isAdTile(item, MAP), false, 'isAdTile is about ads; the disclosure check is separate');
});

test('Shorts cells, playlist/Mix lockups and search playlist lockups are not tiles', () => {
  const s = page('search', { tiles: 3, shorts: true });
  const tiles = collectTiles(s.document, s.sel);
  assert.equal(tiles.length, 3, 'three videos; the playlist lockup and the Shorts shelf are skipped');
  assert.ok(tiles.every((t) => t.duration && !/videos$/.test(t.duration)));
  const lockups = [...s.document.querySelectorAll('yt-lockup-view-model')];
  const playlist = lockups.find((l) => l.querySelector('yt-collection-thumbnail-view-model'));
  assert.ok(playlist, 'fixture has the playlist lockup');
  assert.equal(extractTile(playlist, s.sel), null);
  assert.equal(extractTile(playlist.parentNode, s.sel), null, 'its parent holds it, still not a tile');

  const g = page('home', { tiles: 3, tileStyle: 'home' });
  const mix = first(g);
  mix.querySelector('.ytLockupViewModelHost').classList.add('ytLockupViewModelCollectionStack2');
  assert.equal(extractTile(mix, g.sel), null, 'Mix tile by class');

  const sh = page('home', { tiles: 2, shorts: 'rich' });
  const cells = [...sh.document.querySelectorAll('ytd-rich-item-renderer')].filter((el) => el.querySelector('a[href^="/shorts/"]'));
  assert.ok(cells.length > 0);
  for (const c of cells) assert.equal(extractTile(c, sh.sel), null);
});

test('placeholders and half-built tiles are null: empty content, no title, no link, title only in an attribute is accepted', () => {
  const p = page('home', { tiles: 4, tileStyle: 'home' });
  const [a, b, c, d] = [...p.document.querySelectorAll('ytd-rich-item-renderer')];
  a.querySelector('#content').replaceChildren();
  assert.equal(extractTile(a, p.sel), null, 'skeleton tile');
  b.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost').textContent = '  \n ';
  b.querySelector('h3').removeAttribute('title');
  assert.equal(extractTile(b, p.sel), null, 'no title text');
  c.querySelectorAll('a').forEach((x) => x.removeAttribute('href'));
  assert.equal(extractTile(c, p.sel), null, 'no links');
  d.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost').textContent = '';
  const t = extractTile(d, p.sel);
  assert.ok(t && t.title.length > 0, 'falls back to the h3 title attribute');
  assert.equal(t.title, d.querySelector('h3').getAttribute('title'));
});

test('titles are plain text: markup in a title is never parsed, whitespace is collapsed', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  const host = item.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost');
  host.textContent = '  <img src=x onerror=alert(1)>\n\n  Big   news  ';
  const t = extractTile(item, p.sel);
  assert.equal(t.title, '<img src=x onerror=alert(1)> Big news');
  assert.equal(item.querySelectorAll('img[src="x"]').length, 0);
});

// ---- 4. thumbnails -----------------------------------------------------------------------------------------------------

test('a lazy image (no src yet) is "" and readThumb picks the src up once the page sets it; data: placeholders are ignored', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  const img = item.querySelector('.ytThumbnailViewModelImage img');
  img.removeAttribute('src');
  assert.equal(extractTile(item, p.sel).thumb, '');
  assert.equal(readThumb(item, p.sel), '');
  img.setAttribute('src', 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
  assert.equal(readThumb(item, p.sel), '');
  img.setAttribute('src', 'https://i.ytimg.com/vi/kGIIPzvK9c0/hq720.jpg?sqp=abc');
  assert.equal(readThumb(item, p.sel), 'https://i.ytimg.com/vi/kGIIPzvK9c0/hq720.jpg?sqp=abc');
  assert.equal(extractTile(item, p.sel).thumb, 'https://i.ytimg.com/vi/kGIIPzvK9c0/hq720.jpg?sqp=abc');
  assert.equal(readThumb(null, p.sel), '');
  assert.equal(readThumb(item, null), '');
});

test('search rows captured live have lazy images: the tile is still a tile, with thumb ""', () => {
  const p = page('search', { tiles: 3 });
  const tiles = collectTiles(p.document, p.sel);
  assert.deepEqual(tiles.map((t) => t.thumb === ''), [false, true, true]);
});

// ---- 5. resilience -----------------------------------------------------------------------------------------------------

test('renamed classes fall back to the next selector, and to any /watch anchor when every link class is gone', () => {
  const p = page('home', { tiles: 3, tileStyle: 'home' });
  const item = first(p);
  const before = extractTile(item, p.sel);
  // Title class gone: the h3 fallback still gives the text.
  item.querySelector('.ytLockupMetadataViewModelTitle').classList.replace('ytLockupMetadataViewModelTitle', 'renamedTitle');
  assert.equal(extractTile(item, p.sel).title, before.title);
  // Both link classes gone: generic anchors still resolve.
  item.querySelector('.ytLockupViewModelContentImage').classList.replace('ytLockupViewModelContentImage', 'renamedImage');
  const t = extractTile(item, p.sel);
  assert.equal(t.href, before.href);
  assert.equal(t.videoId, before.videoId);
});

test('a map that lost its tile roles still reads tiles through tileFields, then the built-in fallbacks', () => {
  const p = page('home', { tiles: 3, tileStyle: 'home' });
  const want = extractTile(first(p), p.sel);
  const slim = clone(MAP);
  for (const role of ['tileLink', 'tileTitle', 'tileThumb', 'tileDuration', 'tileChannel', 'tileMeta', 'videoTile']) delete slim.roles[role];
  const sel = createSelectors(slim, p.document);
  const t = extractTile(first(p), sel);
  assert.equal(t.title, want.title);
  assert.equal(t.href, want.href);
  assert.equal(t.thumb, want.thumb);
  assert.equal(t.duration, want.duration);
  assert.deepEqual(t.meta, want.meta);
  delete slim.tileFields;
  const bare = createSelectors(slim, p.document);
  assert.equal(extractTile(first(p), bare).title, want.title);
  assert.equal(collectTiles(p.document, bare).length, 3, 'collectTiles falls back to the built-in tile tags');
});

test('hostile input never throws: nulls, non-elements, detached nodes, bad selectors objects', () => {
  const p = page('home', { tiles: 2 });
  const detached = p.document.createElement('div');
  detached.innerHTML = createTile({ id: 'abcdefghijk', title: 'x' });
  assert.ok(extractTile(detached, p.sel), 'a detached element that holds a tile is fine');
  for (const bad of [null, undefined, 0, 'x', {}, [], p.document, p.document.createTextNode('t'), p.document.createElement('div')]) {
    assert.doesNotThrow(() => extractTile(bad, p.sel));
    assert.equal(extractTile(bad, p.sel), null);
  }
  for (const badSel of [null, undefined, {}, { find() { throw new Error('boom'); } }, { find: () => null, map: () => { throw new Error('boom'); } }]) {
    assert.doesNotThrow(() => extractTile(first(p), badSel));
    assert.doesNotThrow(() => collectTiles(p.document, badSel));
  }
  for (const badContainer of [null, undefined, 3, {}, p.document.createTextNode('t')]) assert.deepEqual(collectTiles(badContainer, p.sel), []);
  // A selectors object whose role lookups throw: still a clean null.
  const throwing = { find() { throw new Error('x'); }, findAll() { throw new Error('x'); }, css() { throw new Error('x'); }, map: () => MAP };
  assert.doesNotThrow(() => extractTile(first(p), throwing));
  assert.deepEqual(collectTiles(p.document, throwing).length >= 0, true);
});

test('a detached tile (no document, no base URI) still extracts against youtube.com', () => {
  const p = page('home', { tiles: 2 });
  const copy = first(p).cloneNode(true);
  const t = extractTile(copy, p.sel);
  assert.equal(t.href.startsWith('https://www.youtube.com/watch?v='), true);
});

test('nested tile shapes count once: an outer ytd-rich-grid-media holding a lockup is one tile', () => {
  const p = page('home', { tiles: 2 });
  const item = first(p);
  const lockup = item.querySelector('yt-lockup-view-model');
  const outer = p.document.createElement('ytd-rich-grid-media');
  lockup.parentNode.insertBefore(outer, lockup);
  outer.appendChild(lockup);
  const tiles = collectTiles(item, p.sel);
  assert.equal(tiles.length, 1);
});

test('collectTiles on a 400-tile page returns all of them in document order and stays fast', () => {
  // jsdom's selector engine costs milliseconds per tile (a real browser, microseconds), so an absolute budget would only measure
  // the machine. What matters is that the cost per tile does not grow with the page: 4x the tiles must cost about 4x, not 16x.
  const small = page('home', { tiles: 100 });
  const t0 = process.hrtime.bigint();
  assert.equal(collectTiles(small.document, small.sel).length, 100);
  const smallMs = Number(process.hrtime.bigint() - t0) / 1e6;

  const p = page('home', { tiles: 400 });
  const t1 = process.hrtime.bigint();
  const tiles = collectTiles(p.document, p.sel);
  const bigMs = Number(process.hrtime.bigint() - t1) / 1e6;
  assert.equal(tiles.length, 400);
  assert.deepEqual(tiles.slice(0, 3).map((t) => t.videoId), ['kGIIPzvK9c0', 'Y0JIkdKL1jg', 'fwpjpQizZA4']);
  assert.ok(bigMs / 400 < (smallMs / 100) * 2.5 + 1, `no quadratic blowup: ${smallMs.toFixed(0)} ms for 100 tiles, ${bigMs.toFixed(0)} ms for 400`);
  assert.ok(bigMs < 60000, 'finishes');
});

// ---- 6. isAdTile -------------------------------------------------------------------------------------------------------

test('isAdTile: true for every synthetic ad shape and for things inside or holding an ad, false for plain tiles', () => {
  const templates = loadTemplates('synthetic/ad-slot');
  const host = createPage('home', { tiles: 2 });
  open.push(host);
  assert.deepEqual(Object.keys(templates).sort(), ['feed-ad', 'masthead-ad', 'player-ad', 'related-ad', 'search-ad', 'sponsor']);
  for (const [name, html] of Object.entries(templates)) {
    const holder = host.document.createElement('div');
    holder.innerHTML = html;
    const el = holder.firstElementChild;
    host.document.body.appendChild(el);
    // Every synthetic one also links off youtube.com (marker-independent evidence), the disclosure included. That a disclosure that
    // stays on youtube.com is NOT an ad is checked in the previous test.
    assert.equal(isAdTile(el, MAP), true, name);
    el.remove();
  }
  const plain = host.document.querySelector('ytd-rich-item-renderer');
  assert.equal(isAdTile(plain, MAP), false);
  assert.equal(isAdTile(null, MAP), false);
  assert.equal(isAdTile(host.document, MAP), false);
});

test('isAdTile fails closed without an ad list and survives an unparseable entry in it', () => {
  const p = page('home', { tiles: 2, ads: true });
  const plain = first(p);
  const noAds = clone(MAP);
  delete noAds.protected.ads;
  assert.equal(isAdTile(plain, noAds), true, 'no protected.ads: treat as ad');
  for (const bad of [null, undefined, {}, { protected: {} }, { protected: { ads: [] } }, { protected: { ads: [''] } }]) assert.equal(isAdTile(plain, bad), true);

  const withBad = clone(MAP);
  withBad.protected.ads.unshift('ytd-nope[[[');
  assert.equal(isAdTile(plain, withBad), false, 'plain tile stays plain');
  const ad = p.document.querySelector('ytd-ad-slot-renderer');
  assert.equal(isAdTile(ad, withBad), true, 'an ad is still found by the entries that parse');
  // The verdict is cached per map object: asking again gives the same answer.
  assert.equal(isAdTile(ad, withBad), true);
  assert.equal(isAdTile(plain, withBad), false);
});
