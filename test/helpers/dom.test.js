import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';
import {
  PAGE_KINDS, loadFixture, loadTemplates, createTile, readTile, tileId, createPage, navigateTo, applyRename,
} from './dom.js';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const count = (doc, sel) => doc.querySelectorAll(sel).length;
const parseFragment = (html) => {
  const { window } = new JSDOM('<body></body>');
  const t = window.document.createElement('template');
  t.innerHTML = html;
  return t.content;
};
const stripLeadingComments = (html) => html.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '');

// Selector that counts the "main" items of each page kind (what opts.tiles controls).
const TILE_SELECTOR = {
  home: 'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))',
  channel: 'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))',
  subscriptions: 'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))',
  search: 'ytd-search ytd-video-renderer',
  watch: '#related yt-lockup-view-model',
  history: 'ytd-video-renderer[is-history]',
  playlist: 'yt-item-section-renderer yt-lockup-view-model',
};
const CONTINUATION = {
  home: 'ytd-continuation-item-renderer', channel: 'ytd-continuation-item-renderer', subscriptions: 'ytd-continuation-item-renderer',
  search: 'ytd-continuation-item-renderer', history: 'ytd-continuation-item-renderer', playlist: 'yt-continuation-item-view-model',
};

// ---- fixtures parse ------------------------------------------------------------------------------------------------

const REAL_HTML = ['shell', 'channel-grid', 'search-results', 'watch', 'shorts-shelf', 'shorts-grid', 'playlist'];
const SYNTHETIC_HTML = ['ad-slot', 'shorts-shelf'];

test('every real HTML fixture parses to a single root element after its provenance comment', () => {
  const roots = {
    shell: 'ytd-app', 'channel-grid': 'ytd-browse', 'search-results': 'ytd-search', watch: 'ytd-watch-flexy',
    'shorts-shelf': 'grid-shelf-view-model', 'shorts-grid': 'ytd-rich-grid-renderer', playlist: 'ytd-browse',
  };
  for (const name of REAL_HTML) {
    const raw = loadFixture(`real/${name}`);
    assert.match(raw, /^<!-- REAL/, `${name}: starts with a REAL provenance comment`);
    assert.match(raw, /2026-10-07/, `${name}: dated`);
    const body = stripLeadingComments(raw);
    assert.ok(!body.replace('<!--PAGE-->', '').includes('-->'), `${name}: a comment inside the file ended early or leaked text`);
    const frag = parseFragment(body);
    const elements = [...frag.children];
    assert.equal(elements.length, 1, `${name}: exactly one root element`);
    assert.equal(elements[0].tagName.toLowerCase(), roots[name], `${name}: root tag`);
    const strayText = [...frag.childNodes].filter((n) => n.nodeType === 3 && n.textContent.trim()).length;
    assert.equal(strayText, 0, `${name}: no stray top-level text`);
    assert.ok(raw.length < 30000, `${name}: ${raw.length} bytes (keep fixtures small)`);
  }
});

test('shell.html has the PAGE marker exactly once, inside ytd-page-manager, and no leaked comment text', () => {
  const shell = stripLeadingComments(loadFixture('real/shell'));
  assert.equal(shell.split('<!--PAGE-->').length - 1, 1);
  const frag = parseFragment(shell);
  const pm = frag.querySelector('ytd-page-manager#page-manager');
  assert.ok(pm);
  assert.equal(pm.childNodes.length, 1);
  assert.equal(pm.firstChild.nodeType, 8);
  assert.equal(pm.firstChild.textContent, 'PAGE');
});

test('synthetic fixtures are loudly marked SYNTHETIC and expose their templates', () => {
  for (const name of SYNTHETIC_HTML) {
    const raw = loadFixture(`synthetic/${name}`);
    assert.match(raw, /^<!--[\s\S]*SYNTHETIC FIXTURE - NOT CAPTURED FROM YOUTUBE/, `${name}: header comment`);
  }
  const ads = loadTemplates('synthetic/ad-slot');
  assert.deepEqual(Object.keys(ads).sort(), ['feed-ad', 'masthead-ad', 'player-ad', 'related-ad', 'search-ad', 'sponsor']);
  for (const [id, html] of Object.entries(ads)) {
    const frag = parseFragment(html);
    assert.equal(frag.children.length, 1, `ad template ${id} has one root`);
    assert.ok(frag.firstElementChild.hasAttribute('data-cd-synthetic'), `ad template ${id} is marked data-cd-synthetic`);
    for (const a of frag.querySelectorAll('[href]')) assert.match(a.getAttribute('href'), /^https:\/\/ads\.example\.invalid\//, `${id}: no real hosts`);
  }
  const shelves = loadTemplates('synthetic/shorts-shelf');
  assert.deepEqual(Object.keys(shelves).sort(), ['reel-shelf', 'rich-shelf']);
  assert.equal(parseFragment(shelves['rich-shelf']).querySelectorAll('ytd-rich-shelf-renderer[is-shorts] a[href^="/shorts/"]').length, 6);
  assert.equal(parseFragment(shelves['reel-shelf']).querySelectorAll('ytd-reel-shelf-renderer ytd-reel-item-renderer a[href^="/shorts/"]').length, 3);
});

test('ad templates cover every protected class the selector map must match', () => {
  const html = Object.values(loadTemplates('synthetic/ad-slot')).join('\n');
  const frag = parseFragment(html);
  for (const sel of [
    'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer', 'ytd-video-masthead-ad-v3-renderer',
    'ytd-search-pyv-renderer', '.video-ads.ytp-ad-module', '.ytp-ad-player-overlay', '.ytp-ad-text', '.ytp-ad-skip-button-container',
    '.ytp-paid-content-overlay .ytp-paid-content-overlay-text',
  ]) assert.ok(frag.querySelector(sel), `synthetic ads include ${sel}`);
});

test('computed-colors.json holds the ARCHITECTURE.md section 1 dark values', () => {
  const c = JSON.parse(loadFixture('real/computed-colors.json'));
  assert.equal(c.mode, 'dark');
  assert.equal(c.date, '2026-10-07');
  const v = c.sysColorsBaseline;
  assert.deepEqual(
    {
      base: v['--yt-sys-color-baseline--base-background'], raised: v['--yt-sys-color-baseline--raised-background'],
      menu: v['--yt-sys-color-baseline--menu-background'], surface: v['--yt-sys-color-baseline--surface-container'],
      text: v['--yt-sys-color-baseline--text-primary'], muted: v['--yt-sys-color-baseline--text-secondary'],
      disabled: v['--yt-sys-color-baseline--text-disabled'], outline: v['--yt-sys-color-baseline--outline'],
      opaque: v['--yt-sys-color-baseline--outline-opaque'], cta: v['--yt-sys-color-baseline--call-to-action'],
      ctaHover: v['--yt-sys-color-baseline--call-to-action-hover'], additive: v['--yt-sys-color-baseline--additive-background'],
    },
    {
      base: '#0f0f0f', raised: '#212121', menu: '#282828', surface: '#181818', text: '#f1f1f1', muted: '#aaa', disabled: '#717171',
      outline: 'rgba(255,255,255,0.2)', opaque: '#3f3f3f', cta: '#3ea6ff', ctaHover: '#65b8ff', additive: 'rgba(255,255,255,0.1)',
    },
  );
  assert.equal(c.surfaces.html.backgroundColor, 'rgb(15, 15, 15)');
  assert.equal(c.surfaces['ytd-masthead'].backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(c.surfaces['tile title a.ytLockupMetadataViewModelTitle'].color, 'rgb(241, 241, 241)');
  assert.equal(c.surfaces['chip active (.ytChipShapeActive)'].backgroundColor, 'rgb(241, 241, 241)');
  assert.equal(c.surfaces['chip inactive (.ytChipShapeInactive)'].backgroundColor, 'rgba(255, 255, 255, 0.1)');
  assert.equal(c.deprecatedGeneralBackground['--yt-deprecated-general-background-a'], '#0f0f0f');
});

test('README.md documents provenance for every fixture file', () => {
  const readme = readFileSync(path.join(FIXTURES, 'README.md'), 'utf8');
  const files = [];
  for (const dir of ['real', 'synthetic']) for (const f of readdirSync(path.join(FIXTURES, dir))) files.push(`${dir}/${f}`);
  assert.ok(files.length >= 10);
  for (const f of files) assert.ok(readme.includes(f), `README mentions ${f}`);
  assert.match(readme, /2026-10-07/);
  assert.match(readme, /SYNTHETIC/);
  assert.match(readme, /DERIVED/i);
});

test('no personal data in any fixture (emails, cookies, tokens, session ids)', () => {
  for (const dir of ['real', 'synthetic']) {
    for (const f of readdirSync(path.join(FIXTURES, dir))) {
      const text = readFileSync(path.join(FIXTURES, dir, f), 'utf8');
      assert.ok(!/[\w.+-]+@[\w-]+\.[a-z]{2,}/i.test(text), `${dir}/${f}: looks like it contains an email address`);
      assert.ok(!/SAPISID|__Secure-|visitor_?data|LOGIN_INFO|SID=|Bearer /i.test(text), `${dir}/${f}: cookie/token marker`);
      assert.ok(!/\b\+?\d[\d ()-]{9,}\d\b/.test(text.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/[?&=][\w%-]{20,}/g, '')), `${dir}/${f}: looks like a phone number`);
    }
  }
});

test('captured facts that other modules rely on stay pinned (ARCHITECTURE.md section 1 and README discoveries)', () => {
  const grid = parseFragment(stripLeadingComments(loadFixture('real/channel-grid')));
  assert.equal(grid.querySelectorAll('ytd-browse[page-subtype="channels"] ytd-two-column-browse-results-renderer > #primary > ytd-rich-grid-renderer').length, 1);
  assert.equal(grid.querySelectorAll('ytd-rich-grid-renderer > #header chip-bar-view-model button[role="tab"]').length, 3);
  assert.equal(grid.querySelectorAll('ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer > #content > yt-lockup-view-model').length, 4);
  assert.equal(grid.querySelectorAll('#contents > ytd-continuation-item-renderer:last-child').length, 1);
  const tile = grid.querySelector('yt-lockup-view-model');
  for (const sel of [
    'a.ytLockupViewModelContentImage[href^="/watch"][aria-hidden="true"]', '.ytThumbnailViewModelImage img', '.ytBadgeShapeText',
    'badge-shape[aria-label]', 'h3.ytLockupMetadataViewModelHeadingReset[title] a.ytLockupMetadataViewModelTitle[href] span.ytAttributedStringHost',
    '.ytContentMetadataViewModelMetadataRow .ytContentMetadataViewModelMetadataText', '.ytContentMetadataViewModelDelimiter',
  ]) assert.ok(tile.querySelector(sel), `tile has ${sel}`);

  const search = parseFragment(stripLeadingComments(loadFixture('real/search-results')));
  assert.equal(search.querySelectorAll('ytd-video-renderer a#thumbnail[href^="/watch"]').length, 3);
  assert.equal(search.querySelectorAll('ytd-video-renderer a#video-title[title]').length, 3);
  assert.equal(search.querySelectorAll('ytd-item-section-renderer > #contents > yt-lockup-view-model.ytLockupViewModelWrapper').length, 1);
  assert.equal(search.querySelectorAll('.ytLockupViewModelCollectionStack2 a.ytLockupViewModelContentImage[href*="list="]').length, 1);
  assert.equal(search.querySelectorAll('yt-chip-cloud-renderer chip-shape').length, 4);

  const watch = parseFragment(stripLeadingComments(loadFixture('real/watch')));
  assert.equal(watch.querySelectorAll('ytd-watch-flexy#columns, ytd-watch-flexy > #columns').length, 1);
  assert.equal(watch.querySelectorAll('#player ytd-player#ytd-player #movie_player.html5-video-player .html5-video-container video.html5-main-video').length, 1);
  assert.equal(watch.querySelectorAll('#movie_player .ytp-chrome-bottom .ytp-progress-bar .ytp-ad-progress-list').length, 1, 'real empty ad progress list');
  assert.equal(watch.querySelectorAll('#movie_player .ytp-ce-element').length, 2);
  assert.equal(watch.querySelectorAll('#movie_player .ytp-ce-covering-overlay').length, 1);
  assert.equal(watch.querySelectorAll('#movie_player .ytp-endscreen-content').length, 1);
  assert.equal(watch.querySelectorAll('.ytp-paid-content-overlay').length, 1, 'the real (empty) sponsorship disclosure container exists');
  assert.equal(watch.querySelector('.ytp-paid-content-overlay .ytp-paid-content-overlay-text').textContent, '');
  assert.equal(watch.querySelectorAll('#related #player-ads').length, 1, 'real empty #player-ads container');
  assert.equal(watch.querySelectorAll('ytd-comments#comments ytd-comments-header-renderer').length, 1);
  assert.equal(watch.querySelectorAll('#secondary #related ytd-watch-next-secondary-results-renderer yt-lockup-view-model').length, 4);
  assert.equal(watch.querySelectorAll('ytd-watch-metadata #title h1').length, 1);
  assert.equal(watch.querySelectorAll('ytd-watch-info-text #info-container #info span').length > 0, true);

  const shell = parseFragment(stripLeadingComments(loadFixture('real/shell')));
  assert.equal(shell.querySelectorAll('ytd-app > #content > #masthead-container > ytd-masthead').length, 1, 'masthead lives in #masthead-container, not directly in ytd-app');
  assert.equal(shell.querySelectorAll('ytd-app tp-yt-app-drawer#guide ytd-guide-entry-renderer').length, 5);
  assert.equal(shell.querySelectorAll('ytd-mini-guide-renderer ytd-mini-guide-entry-renderer a[href="/shorts/"]').length, 1);
  const fullShorts = [...shell.querySelectorAll('ytd-guide-entry-renderer a')].find((a) => a.getAttribute('title') === 'Shorts');
  assert.ok(fullShorts && !fullShorts.hasAttribute('href'), 'REAL QUIRK: the full-guide Shorts entry has no href (title only)');

  const pl = parseFragment(stripLeadingComments(loadFixture('real/playlist')));
  assert.equal(pl.querySelectorAll('ytd-browse[page-subtype="playlist"] ytd-two-column-browse-results-renderer > #primary > yt-section-list-renderer yt-item-section-renderer > #contents > div > yt-lockup-view-model').length, 3);
  assert.equal(pl.querySelectorAll('yt-continuation-item-view-model').length, 1);

  const shortsGrid = parseFragment(stripLeadingComments(loadFixture('real/shorts-grid')));
  assert.equal(shortsGrid.querySelectorAll('ytd-rich-grid-renderer[is-shorts-grid] ytd-rich-item-renderer[is-shorts-grid] ytm-shorts-lockup-view-model-v2 a[href^="/shorts/"]').length, 4, '2 items x (thumbnail link + title link)');
  const realShelf = parseFragment(stripLeadingComments(loadFixture('real/shorts-shelf')));
  assert.equal(realShelf.querySelectorAll('grid-shelf-view-model .ytGridShelfViewModelGridShelfItem ytm-shorts-lockup-view-model a[href^="/shorts/"]').length, 6);
});

// ---- loadFixture ---------------------------------------------------------------------------------------------------

test('loadFixture resolves bare names, dirs and extensions; refuses escapes and unknown files', () => {
  assert.equal(loadFixture('channel-grid'), loadFixture('real/channel-grid'));
  assert.equal(loadFixture('channel-grid.html'), loadFixture('real/channel-grid.html'));
  assert.equal(loadFixture('ad-slot'), loadFixture('synthetic/ad-slot'));
  assert.equal(loadFixture('shorts-shelf'), loadFixture('real/shorts-shelf'), 'bare name prefers real/');
  assert.notEqual(loadFixture('synthetic/shorts-shelf'), loadFixture('real/shorts-shelf'));
  assert.equal(typeof loadFixture('computed-colors.json'), 'string');
  assert.throws(() => loadFixture('nope'), /fixture not found/);
  assert.throws(() => loadFixture('../helpers/dom.js'), /escapes fixtures dir|not found/);
  assert.throws(() => loadFixture(''), TypeError);
});

// ---- createTile ----------------------------------------------------------------------------------------------------

test('createTile is a faithful copy of the captured tile and round-trips through readTile', () => {
  const grid = parseFragment(stripLeadingComments(loadFixture('real/channel-grid')));
  const real = grid.querySelector('ytd-rich-item-renderer');
  const data = readTile(real);
  assert.deepEqual(data, { id: 'kGIIPzvK9c0', title: 'Expedition Amelia (Full Episode) | DOCUMENTARY SPECIAL | National Geographic', duration: '1:34:31', views: '45k', age: '6 hr ago' });
  const made = parseFragment(createTile(data)).firstElementChild;
  const norm = (el) => {
    const c = el.cloneNode(true);
    c.removeAttribute('is-in-first-column');
    c.querySelectorAll('img').forEach((i) => i.removeAttribute('src'));
    return c.outerHTML;
  };
  const a = norm(made);
  const b = norm(real);
  const at = [...a].findIndex((ch, i) => ch !== b[i]);
  assert.ok(a === b, `regenerated tile differs from the capture at char ${at}: ...${a.slice(Math.max(0, at - 40), at + 60)}... vs ...${b.slice(Math.max(0, at - 40), at + 60)}...`);
});

test('createTile fills every field, escapes text, and keeps the structure extractors rely on', () => {
  const html = createTile({ id: 'ABCDEFGHIJK', title: 'A "quoted" <b>bold</b> & more', duration: '2:03', views: '1.5m', age: '3 weeks ago', href: '/watch?v=ABCDEFGHIJK&t=5s' });
  const el = parseFragment(html).firstElementChild;
  assert.equal(el.tagName, 'YTD-RICH-ITEM-RENDERER');
  assert.ok(el.matches('ytd-rich-item-renderer:has(> #content > yt-lockup-view-model)'));
  assert.equal(el.querySelectorAll('b').length, 0, 'title text is escaped, not parsed as markup');
  assert.equal(el.querySelector('.ytLockupMetadataViewModelTitle').textContent, 'A "quoted" <b>bold</b> & more');
  assert.equal(el.querySelector('h3[title]').getAttribute('title'), 'A "quoted" <b>bold</b> & more');
  assert.equal(el.querySelector('a.ytLockupViewModelContentImage').getAttribute('href'), '/watch?v=ABCDEFGHIJK&t=5s');
  assert.equal(el.querySelector('a.ytLockupMetadataViewModelTitle').getAttribute('href'), '/watch?v=ABCDEFGHIJK&t=5s');
  assert.ok(el.querySelector('.ytLockupViewModelHost').classList.contains('content-id-ABCDEFGHIJK'));
  assert.equal(el.querySelector('.ytLockupViewModelHost').className.match(/content-id-/g).length, 1, 'old content-id removed');
  assert.equal(el.querySelector('.ytBadgeShapeText').textContent, '2:03');
  assert.equal(el.querySelector('badge-shape').getAttribute('aria-label'), '2 minutes, 3 seconds');
  const metas = el.querySelectorAll('.ytContentMetadataViewModelMetadataText');
  assert.deepEqual([...metas].map((m) => m.textContent), ['1.5m', '3 weeks ago']);
  assert.equal(metas[0].getAttribute('aria-label'), '1.5 million views');
  assert.equal(el.querySelector('img').getAttribute('src'), 'https://i.ytimg.com/vi/ABCDEFGHIJK/hq720.jpg');
  assert.ok(!el.hasAttribute('is-in-first-column'));
});

test('createTile defaults produce a valid, parseable tile; ids are unique per tileId(i)', () => {
  const el = parseFragment(createTile()).firstElementChild;
  assert.ok(el.querySelector('a[href^="/watch?v="]'));
  assert.equal(readTile(el).id, 'CDtile00001');
  assert.equal(tileId(0), 'CDtile00001');
  assert.equal(tileId(11), 'CDtile00012');
  assert.equal(tileId(0).length, 11, 'same length as a real video id');
  assert.equal(new Set(Array.from({ length: 500 }, (_, i) => tileId(i))).size, 500);
});

test('createTile spoken labels: hours, singulars, thousands/millions', () => {
  const t = (o) => parseFragment(createTile(o)).firstElementChild;
  assert.equal(t({ duration: '1:02:03' }).querySelector('badge-shape').getAttribute('aria-label'), '1 hour, 2 minutes, 3 seconds');
  assert.equal(t({ duration: '1:01' }).querySelector('badge-shape').getAttribute('aria-label'), '1 minute, 1 second');
  assert.equal(t({ duration: '0:45' }).querySelector('badge-shape').getAttribute('aria-label'), '0 minutes, 45 seconds');
  assert.equal(t({ views: '45k' }).querySelector('.ytContentMetadataViewModelMetadataText').getAttribute('aria-label'), '45 thousand views');
  assert.equal(t({ views: '570' }).querySelector('.ytContentMetadataViewModelMetadataText').getAttribute('aria-label'), '570 views');
});

test('createTile({channel}) produces the real home shape: avatar + one row "channel, views, age"', () => {
  const el = parseFragment(createTile({ id: 'HOMEHOMEHOM', channel: 'Nature Lab', views: '2.3m', age: '1 day ago' })).firstElementChild;
  assert.ok(el.querySelector('.ytLockupMetadataViewModelAvatar yt-decorated-avatar-view-model'));
  const rows = el.querySelectorAll('.ytContentMetadataViewModelMetadataRow');
  assert.equal(rows.length, 1);
  assert.deepEqual([...rows[0].querySelectorAll('.ytContentMetadataViewModelMetadataText')].map((s) => s.textContent), ['Nature Lab', '2.3m', '1 day ago']);
  assert.equal(rows[0].querySelectorAll('.ytContentMetadataViewModelDelimiter').length, 2);
  assert.deepEqual(readTile(el), { id: 'HOMEHOMEHOM', title: 'Synthetic tile 1: Savanna at dawn', duration: '3:21', views: '2.3m', age: '1 day ago' });
});

// ---- createPage: every kind ----------------------------------------------------------------------------------------

test('createPage builds every kind into a jsdom at a real youtube.com URL with no jsdom errors', () => {
  assert.deepEqual(PAGE_KINDS, ['home', 'watch', 'search', 'channel', 'subscriptions', 'history', 'playlist']);
  const urls = {
    home: 'https://www.youtube.com/', watch: 'https://www.youtube.com/watch?v=BzpdP2APcIM',
    search: 'https://www.youtube.com/results?search_query=nature+documentary', channel: 'https://www.youtube.com/@NatGeo/videos',
    subscriptions: 'https://www.youtube.com/feed/subscriptions', history: 'https://www.youtube.com/feed/history',
    playlist: 'https://www.youtube.com/playlist?list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO',
  };
  for (const kind of PAGE_KINDS) {
    const page = createPage(kind);
    assert.ok(page.dom && page.window && page.document, `${kind}: dom/window/document`);
    assert.equal(page.window, page.dom.window);
    assert.equal(page.document, page.window.document);
    assert.equal(page.kind, kind);
    assert.equal(page.window.location.href, urls[kind], `${kind}: url`);
    assert.equal(page.window.location.origin, 'https://www.youtube.com');
    assert.deepEqual(page.errors, [], `${kind}: jsdom errors`);
    assert.ok(page.document.documentElement.hasAttribute('dark'), `${kind}: html[dark] by default`);
    for (const sel of ['ytd-app', 'ytd-masthead', 'tp-yt-app-drawer#guide', 'ytd-mini-guide-renderer', 'ytd-page-manager#page-manager']) {
      assert.equal(count(page.document, sel), 1, `${kind}: shell has ${sel}`);
    }
    assert.equal(count(page.document, 'ytd-page-manager > *'), 1, `${kind}: exactly one page element in the page manager`);
    assert.equal(page.document.querySelector('ytd-page-manager').lastChild.nodeType === 8, false, `${kind}: PAGE marker replaced`);
    assert.equal(count(page.document, TILE_SELECTOR[kind]), 8, `${kind}: default 8 tiles`);
    assert.equal(page.meta.tiles, 8);
    page.window.close();
  }
});

test('page element and wrapper attributes per kind (verified live where marked, derived otherwise)', () => {
  const p = (k, o) => createPage(k, { tiles: 4, ...o }).document;
  let d = p('home');
  assert.equal(count(d, 'ytd-browse[page-subtype="home"] > ytd-two-column-browse-results-renderer[page-subtype="home"][disable-grid-state-aware].grid-disabled'), 1);
  assert.equal(count(d, 'ytd-rich-grid-renderer[is-default-grid]:not([is-slim-grid]) > #header ytd-feed-filter-chip-bar-renderer yt-chip-cloud-chip-renderer'), 4);
  assert.equal(count(d, 'ytd-tabbed-page-header'), 0, 'home has no channel header');
  d = p('channel');
  assert.equal(count(d, 'ytd-browse[page-subtype="channels"] ytd-tabbed-page-header h1'), 1);
  assert.equal(count(d, 'ytd-rich-grid-renderer chip-bar-view-model'), 1);
  d = p('subscriptions');
  assert.equal(count(d, 'ytd-browse[page-subtype="subscriptions"] > ytd-two-column-browse-results-renderer.grid-5-columns[page-subtype="subscriptions"]'), 1);
  d = p('history');
  assert.equal(count(d, 'ytd-browse[page-subtype="history"] > ytd-two-column-browse-results-renderer[has-secondary-column-data] ytd-section-list-renderer > #contents > ytd-item-section-renderer > #contents > ytd-video-renderer[is-history]'), 4);
  assert.equal(count(d, '#secondary ytd-button-renderer'), 2);
  d = p('playlist');
  assert.equal(count(d, 'ytd-browse[page-subtype="playlist"][has-page-header-sidebar] yt-page-header-renderer h1'), 1);
  d = p('search');
  assert.equal(count(d, 'ytd-search[page-subtype="search"] ytd-two-column-search-results-renderer #primary ytd-section-list-renderer ytd-item-section-renderer #contents > ytd-video-renderer'), 4);
  assert.equal(count(d, 'ytd-search yt-lockup-view-model.ytd-item-section-renderer'), 1, 'the playlist lockup stays');
  assert.equal(count(d, 'yt-chip-cloud-renderer'), 1);
  d = p('watch');
  assert.equal(count(d, 'ytd-app[is-watch-page]'), 1);
  assert.equal(count(d, '[guide-persistent-and-visible]'), 0, 'watch drops the persistent guide');
  assert.equal(count(d, 'ytd-watch-flexy[video-id] #columns > #primary #primary-inner #movie_player.html5-video-player'), 1);
  assert.equal(count(d, '#movie_player .ytp-chrome-bottom .ytp-chrome-controls'), 1);
  assert.equal(count(d, '#movie_player > .ytp-ce-element'), 2);
  assert.equal(count(d, 'ytd-comments#comments'), 1);
  assert.equal(count(d, '#columns > #secondary #related ytd-watch-next-secondary-results-renderer'), 1);
  for (const k of ['home', 'channel', 'search', 'subscriptions', 'history', 'playlist']) {
    const doc = p(k);
    assert.equal(count(doc, 'ytd-app[is-watch-page]'), 0, `${k}: not a watch page`);
    assert.ok(count(doc, 'ytd-app[guide-persistent-and-visible]') === 1, `${k}: guide persistent`);
  }
});

test('opts.tiles is honoured exactly for every kind (0, 1, 3, 4, 5, 8, 13, 30), including above the captured counts', () => {
  for (const kind of PAGE_KINDS) {
    for (const n of [0, 1, 3, 4, 5, 8, 13, 30]) {
      const page = createPage(kind, { tiles: n });
      assert.equal(count(page.document, TILE_SELECTOR[kind]), n, `${kind} tiles:${n}`);
      assert.equal(page.meta.tiles, n);
      const last = page.document.querySelector(`${kind === 'playlist' ? 'yt-section-list-renderer' : 'ytd-page-manager'} ${CONTINUATION[kind]}`);
      if (kind !== 'watch') assert.ok(last, `${kind} tiles:${n}: continuation item survives`);
    }
  }
});

test('tiles are unique (video ids, titles) and the first four keep the captured data', () => {
  for (const kind of ['home', 'channel', 'subscriptions']) {
    const d = createPage(kind, { tiles: 12 }).document;
    const tiles = [...d.querySelectorAll(TILE_SELECTOR[kind])].map(readTile);
    assert.equal(new Set(tiles.map((t) => t.id)).size, 12, `${kind}: unique ids`);
    assert.equal(new Set(tiles.map((t) => t.title)).size, 12, `${kind}: unique titles`);
    assert.equal(tiles[0].id, 'kGIIPzvK9c0');
    assert.equal(tiles[3].id, '7IQvvawUDzw');
    assert.equal(tiles[4].id, tileId(4));
    assert.ok(tiles.every((t) => /^[\w-]{11}$/.test(t.id)), 'ids look like video ids');
    assert.ok(tiles.every((t) => t.duration && t.views && t.age));
    const links = [...d.querySelectorAll(`${TILE_SELECTOR[kind]} a.ytLockupViewModelContentImage`)].map((a) => a.getAttribute('href'));
    assert.equal(new Set(links).size, 12);
    const firsts = [...d.querySelectorAll(TILE_SELECTOR[kind])].map((el) => el.hasAttribute('is-in-first-column'));
    assert.deepEqual(firsts.slice(0, 7), [true, false, false, true, false, false, true], `${kind}: first-column flag follows elements-per-row=3`);
  }
  const s = createPage('search', { tiles: 10 }).document;
  const ids = [...s.querySelectorAll('ytd-video-renderer a#video-title')].map((a) => new URL(a.href, 'https://www.youtube.com').searchParams.get('v'));
  assert.equal(new Set(ids).size, 10);
  assert.equal(ids[0], 'BzpdP2APcIM');
  const w = createPage('watch', { tiles: 9 }).document;
  const rel = [...w.querySelectorAll('#related yt-lockup-view-model')].map((l) => l.querySelector('.ytLockupViewModelHost').className.match(/content-id-([\w-]+)/)[1]);
  assert.equal(new Set(rel).size, 9);
  assert.equal(rel[0], '1mBc8VjDa1s');
  const pl = createPage('playlist', { tiles: 7 }).document;
  const hrefs = [...pl.querySelectorAll('yt-item-section-renderer yt-lockup-view-model a.ytLockupViewModelContentImage')].map((a) => a.getAttribute('href'));
  assert.equal(new Set(hrefs).size, 7);
  assert.ok(hrefs.every((h, i) => h.includes(`&index=${i + 1}&`) && h.includes('list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO')));
});

test('opts.dark toggles html[dark] and the dark-theme attributes', () => {
  const dark = createPage('home', { tiles: 1 }).document;
  assert.equal(count(dark, 'html[dark][darker-dark-theme][darker-dark-theme-deprecate]'), 1);
  assert.equal(count(dark, 'ytd-masthead[page-dark-theme]'), 1);
  const light = createPage('home', { tiles: 1, dark: false }).document;
  assert.equal(count(light, 'html[dark]'), 0);
  assert.equal(count(light, 'html[darker-dark-theme]'), 0);
  assert.equal(count(light, '[page-dark-theme], [is-dark-theme]'), 0);
  assert.equal(light.documentElement.getAttribute('color-version'), 'v2_0', 'other html attributes stay');
  assert.equal(count(createPage('watch', { tiles: 1, dark: false }).document, 'ytd-watch-flexy[is-dark-theme]'), 0);
});

test('opts.url overrides the URL (absolute or path); bad options throw', () => {
  assert.equal(createPage('search', { tiles: 1, url: '/results?search_query=cats' }).window.location.href, 'https://www.youtube.com/results?search_query=cats');
  assert.equal(createPage('watch', { tiles: 1, url: 'https://www.youtube.com/watch?v=abc&t=1' }).window.location.search, '?v=abc&t=1');
  assert.throws(() => createPage('bogus'), /unknown kind/);
  assert.throws(() => createPage('home', { tiles: -1 }), /tiles/);
  assert.throws(() => createPage('home', { tiles: 2.5 }), /tiles/);
  assert.throws(() => createPage('home', { shorts: 'sideways' }), /unknown shorts variant/);
});

test('createPage is deterministic: same options, identical markup', () => {
  for (const kind of PAGE_KINDS) {
    const a = createPage(kind, { tiles: 9, ads: true, shorts: true }).document.documentElement.outerHTML;
    const b = createPage(kind, { tiles: 9, ads: true, shorts: true }).document.documentElement.outerHTML;
    assert.equal(a, b, kind);
  }
});

test('tileStyle:"home" gives avatar + channel-first rows on grid pages', () => {
  const d = createPage('home', { tiles: 5, tileStyle: 'home' }).document;
  assert.equal(count(d, '#contents > ytd-rich-item-renderer .ytLockupMetadataViewModelAvatar'), 5);
  const first = d.querySelector('#contents > ytd-rich-item-renderer');
  assert.equal(first.querySelectorAll('.ytContentMetadataViewModelMetadataText').length, 3);
  assert.equal(readTile(first).id, 'kGIIPzvK9c0');
  assert.equal(readTile(first).views, '45k');
});

// ---- ads -----------------------------------------------------------------------------------------------------------

test('ads:false inserts nothing synthetic; ads:true inserts the right nodes per kind', () => {
  for (const kind of PAGE_KINDS) assert.equal(count(createPage(kind, { tiles: 4 }).document, '[data-cd-synthetic]'), 0, `${kind}: no synthetic nodes by default`);

  let page = createPage('home', { tiles: 6, ads: true });
  let d = page.document;
  assert.equal(count(d, 'ytd-rich-item-renderer > #content > ytd-ad-slot-renderer'), 1);
  assert.equal(count(d, 'ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer) ytd-in-feed-ad-layout-renderer .ytwAdBadgeText'), 1);
  assert.equal(d.querySelector('ytd-ad-slot-renderer .ytwAdBadgeText').textContent, 'Sponsored');
  assert.equal(count(d, '#masthead-ad ytd-video-masthead-ad-v3-renderer'), 1, 'home also gets a masthead ad inside the real #masthead-ad container');
  assert.equal(page.meta.ads, 2);
  assert.equal(count(d, TILE_SELECTOR.home), 6, 'ads do not change the tile count');
  const kids = [...d.querySelectorAll('#contents > ytd-rich-item-renderer')];
  const adIdx = kids.findIndex((k) => k.querySelector('ytd-ad-slot-renderer'));
  assert.ok(adIdx > 0 && adIdx < kids.length - 1, 'ad is interleaved, not first or last');

  d = createPage('channel', { tiles: 8, ads: 3 }).document;
  assert.equal(count(d, '#contents > ytd-rich-item-renderer:has(> #content > ytd-ad-slot-renderer)'), 3);
  assert.equal(count(d, '#masthead-ad ytd-video-masthead-ad-v3-renderer'), 0, 'channel has no masthead ad');
  const seq = [...d.querySelectorAll('#contents > ytd-rich-item-renderer')].map((k) => (k.querySelector('ytd-ad-slot-renderer') ? 'A' : 't')).join('');
  assert.equal(seq.length, 11);
  assert.ok(!seq.includes('AA'), `ads spread out (${seq})`);
  assert.equal(count(createPage('subscriptions', { tiles: 4, ads: 1 }).document, 'ytd-rich-item-renderer:has(ytd-ad-slot-renderer)'), 1);

  page = createPage('search', { tiles: 5, ads: true });
  d = page.document;
  assert.equal(count(d, 'ytd-item-section-renderer > #contents > ytd-ad-slot-renderer ytd-search-pyv-renderer'), 1);
  assert.equal(d.querySelector('ytd-item-section-renderer > #contents').firstElementChild.tagName, 'YTD-AD-SLOT-RENDERER', 'sponsored result leads, like the live page');
  assert.equal(count(d, TILE_SELECTOR.search), 5);
  assert.equal(page.meta.ads, 1);

  page = createPage('watch', { tiles: 6, ads: true });
  d = page.document;
  assert.equal(count(d, '#movie_player > .video-ads.ytp-ad-module .ytp-ad-player-overlay .ytp-ad-skip-button-container'), 1);
  assert.equal(count(d, '.ytp-paid-content-overlay'), 1, 'the real empty disclosure container is REPLACED, not duplicated');
  assert.equal(d.querySelector('.ytp-paid-content-overlay .ytp-paid-content-overlay-text').textContent, 'Includes paid promotion');
  assert.ok(d.querySelector('.ytp-paid-content-overlay').classList.contains('ytp-paid-content-overlay-visible'));
  assert.equal(count(d, '#related #player-ads ytd-ad-slot-renderer'), 1);
  assert.equal(count(d, '#related ytd-item-section-renderer > #contents > ytd-ad-slot-renderer'), 1);
  assert.equal(count(d, TILE_SELECTOR.watch), 6);
  assert.equal(page.meta.ads, 3);
  assert.equal(page.meta.sponsor, true);

  for (const kind of ['history', 'playlist']) {
    page = createPage(kind, { tiles: 3, ads: true, shorts: true });
    assert.equal(count(page.document, '[data-cd-synthetic]'), 0, `${kind}: ads/shorts are a documented no-op`);
    assert.equal(page.meta.ads, 0);
    assert.equal(page.meta.shorts, null);
  }
});

test('ad nodes are findable by the protected-ad selectors and are never confused with real tiles', () => {
  const d = createPage('watch', { tiles: 3, ads: true }).document;
  const adSelector = 'ytd-ad-slot-renderer, ytd-display-ad-renderer, .ytp-ad-module, .ytp-ad-player-overlay';
  assert.ok(count(d, adSelector) >= 4);
  // The inverse used by safeHide(): content that is NOT an ad and holds no ad.
  const clean = d.querySelectorAll(`#related yt-lockup-view-model:not(:has(${adSelector}))`);
  assert.equal(clean.length, 3);
  for (const el of d.querySelectorAll('[data-cd-synthetic]')) assert.ok(!el.matches('yt-lockup-view-model'), 'synthetic nodes are never confused with real tiles');
});

// ---- shorts --------------------------------------------------------------------------------------------------------

test('shorts:true inserts the natural Shorts shelf per kind, and shorts:"variant" forces one', () => {
  let page = createPage('home', { tiles: 8, shorts: true });
  let d = page.document;
  assert.equal(count(d, '#contents > ytd-rich-section-renderer > #content > ytd-rich-shelf-renderer[is-shorts]'), 1);
  assert.equal(count(d, 'ytd-rich-shelf-renderer[is-shorts] ytm-shorts-lockup-view-model-v2 a[href^="/shorts/"]'), 6);
  const seq = [...d.querySelectorAll('#contents > *')].map((e) => e.tagName.toLowerCase());
  assert.equal(seq[4], 'ytd-rich-section-renderer', 'the shelf sits after the 4th tile');
  assert.equal(seq.at(-1), 'ytd-continuation-item-renderer');
  assert.equal(count(d, TILE_SELECTOR.home), 8);
  assert.equal(page.meta.shorts, 'rich');

  d = createPage('channel', { tiles: 2, shorts: 'reel' }).document;
  assert.equal(count(d, '#contents > ytd-reel-shelf-renderer ytd-reel-item-renderer a.reel-item-endpoint[href^="/shorts/"]'), 3);

  page = createPage('search', { tiles: 5, shorts: true });
  d = page.document;
  assert.equal(count(d, 'ytd-item-section-renderer > #contents > grid-shelf-view-model h2'), 1);
  assert.equal(d.querySelector('grid-shelf-view-model h2').textContent, 'Shorts');
  assert.equal(count(d, 'grid-shelf-view-model ytm-shorts-lockup-view-model a[href^="/shorts/"]'), 6);
  assert.equal(count(d, TILE_SELECTOR.search), 5);
  assert.equal(page.meta.shorts, 'grid');
  const order = [...d.querySelectorAll('ytd-item-section-renderer > #contents > *')].map((e) => e.tagName.toLowerCase());
  assert.deepEqual(order.slice(0, 3), ['ytd-video-renderer', 'grid-shelf-view-model', 'yt-lockup-view-model']);

  page = createPage('watch', { tiles: 5, shorts: true });
  d = page.document;
  assert.equal(count(d, '#related #contents > ytd-reel-shelf-renderer'), 1);
  assert.equal(count(d, TILE_SELECTOR.watch), 5);
  assert.equal(page.meta.shorts, 'reel');

  d = createPage('subscriptions', { tiles: 6, shorts: 'grid' }).document;
  assert.equal(count(d, '#contents > grid-shelf-view-model'), 1);
  assert.equal(count(createPage('home', { tiles: 3 }).document, 'ytd-rich-shelf-renderer, ytd-reel-shelf-renderer, grid-shelf-view-model'), 0, 'no shelf by default');
  assert.equal(count(createPage('home', { tiles: 3 }).document, 'ytd-mini-guide-entry-renderer a[href="/shorts/"]'), 1, 'the nav Shorts entry is always present');
});

test('ads and Shorts together keep tile counts and fire no jsdom errors', () => {
  for (const kind of PAGE_KINDS) {
    const page = createPage(kind, { tiles: 7, ads: 2, shorts: true });
    assert.equal(count(page.document, TILE_SELECTOR[kind]), 7, `${kind}`);
    assert.deepEqual(page.errors, []);
  }
});

// ---- rename --------------------------------------------------------------------------------------------------------

test('rename: tag, class, id and attribute names change, so old selectors stop matching and new ones match', () => {
  const base = createPage('home', { tiles: 4 });
  assert.equal(count(base.document, 'ytd-rich-item-renderer'), 4);
  assert.equal(base.renamed, 0);

  let page = createPage('home', { tiles: 4, rename: ['ytd-rich-item-renderer'] });
  assert.equal(page.renamed, 4);
  assert.equal(count(page.document, 'ytd-rich-item-renderer'), 0);
  assert.equal(count(page.document, 'ytd-rich-item-renderer-x'), 4);
  assert.equal(count(page.document, 'ytd-rich-item-renderer-x > #content > yt-lockup-view-model'), 4, 'children and attributes moved intact');
  assert.equal(page.document.querySelector('ytd-rich-item-renderer-x').getAttribute('items-per-row'), '3');
  assert.equal(count(page.document, 'ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer'), 0, 'structural selectors that name the old tag now fail');
  assert.equal(count(page.document, 'ytd-continuation-item-renderer'), 1, 'untouched elements stay');

  page = createPage('home', { tiles: 4, rename: ['.ytLockupMetadataViewModelTitle'] });
  assert.equal(count(page.document, '.ytLockupMetadataViewModelTitle'), 0);
  assert.equal(count(page.document, '.ytLockupMetadataViewModelTitle-x'), 4);
  assert.equal(count(page.document, 'a.ytLockupMetadataViewModelTitle-x[href]'), 4);

  page = createPage('home', { tiles: 2, rename: ['#masthead-container', '#content'] });
  assert.equal(count(page.document, '#masthead-container'), 0);
  assert.equal(count(page.document, '[id="masthead-container-x"]'), 1);
  assert.equal(count(page.document, 'ytd-rich-item-renderer > #content'), 0);

  page = createPage('home', { tiles: 4, rename: ['[items-per-row]', ['ytd-app', 'yt-app-v2']] });
  assert.equal(count(page.document, '[items-per-row]'), 0);
  assert.equal(count(page.document, '[items-per-row-x]'), 4);
  assert.equal(count(page.document, 'ytd-app'), 0);
  assert.equal(count(page.document, 'yt-app-v2 ytd-page-manager'), 1);

  page = createPage('search', { tiles: 3, rename: [{ from: '.ytBadgeShapeText', to: 'badgeText' }, { from: 'ytd-video-renderer' }] });
  assert.equal(count(page.document, '.badgeText'), 4);
  assert.equal(count(page.document, 'ytd-video-renderer-x'), 3);
});

test('applyRename returns how many elements it touched, and 0 when the target does not exist', () => {
  const { document } = createPage('home', { tiles: 3 });
  assert.equal(applyRename(document, ['not-a-real-tag', '.nope', '#nope', '[nope]']), 0);
  assert.equal(applyRename(document, ['ytd-rich-item-renderer']), 3);
  assert.equal(applyRename(document, []), 0);
  assert.equal(applyRename(document, undefined), 0);
  assert.throws(() => applyRename(document, ['ytd-a > ytd-b']), /single tag/);
  assert.throws(() => applyRename(document, [42]), TypeError);
});

test('rename + ads/shorts/dark compose, and the health-check scenario "every tile selector broke" is expressible', () => {
  const page = createPage('home', { tiles: 6, ads: true, shorts: true, dark: false, rename: ['yt-lockup-view-model'] });
  assert.equal(count(page.document, 'yt-lockup-view-model'), 0);
  assert.equal(count(page.document, 'ytd-rich-item-renderer'), 6 + 1 + 3, 'items are still there: 6 tiles + 1 ad + 3 shorts items');
  assert.equal(count(page.document, 'ytd-ad-slot-renderer'), 1, 'ads untouched by an unrelated rename');
  assert.equal(count(page.document, 'html[dark]'), 0);
});

// ---- navigateTo ----------------------------------------------------------------------------------------------------

test('navigateTo swaps the page, updates the URL and fires the YouTube SPA events in order', () => {
  const page = createPage('home', { tiles: 4 });
  const { document, window } = page;
  const seen = [];
  for (const type of ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated']) {
    document.addEventListener(type, (e) => seen.push([type, window.location.href, e.detail.url, document.querySelector('ytd-page-manager > *').tagName.toLowerCase()]));
  }
  const el = navigateTo(page, 'watch', { tiles: 5 });
  assert.equal(el.tagName.toLowerCase(), 'ytd-watch-flexy');
  assert.equal(window.location.href, 'https://www.youtube.com/watch?v=BzpdP2APcIM');
  assert.deepEqual(seen.map((s) => s[0]), ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated']);
  assert.equal(seen[0][3], 'ytd-browse', 'start fires before the swap');
  assert.equal(seen[1][3], 'ytd-watch-flexy', 'finish fires after the swap');
  assert.equal(seen[1][1], seen[1][2], 'finish: location already updated');
  assert.equal(count(document, 'ytd-page-manager > *'), 1);
  assert.equal(count(document, 'ytd-app[is-watch-page]'), 1);
  assert.equal(count(document, TILE_SELECTOR.watch), 5);
  assert.equal(page.kind, 'watch');

  navigateTo(page, 'search', { tiles: 2, url: '/results?search_query=owls' });
  assert.equal(window.location.search, '?search_query=owls');
  assert.equal(count(document, 'ytd-app[is-watch-page]'), 0);
  assert.equal(count(document, 'ytd-app[guide-persistent-and-visible]'), 1);
  assert.equal(count(document, TILE_SELECTOR.search), 2);
  assert.equal(count(document, 'ytd-watch-flexy'), 0);
  assert.equal(window.history.length >= 3, true);
  assert.throws(() => navigateTo(page, 'nowhere'), /unknown kind/);
  assert.deepEqual(page.errors, []);
});
