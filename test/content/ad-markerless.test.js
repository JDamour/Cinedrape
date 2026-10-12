// Ads that carry NO selector-map marker (final review, ad-safety finding 7).
//
// Every ad guard in the engine is a marker test against hand-written selectors, and real ads were never captured. These tests
// build in-feed ads out of things that are not in protected.ads of the ORIGINAL map (the 51 entries before 2026.10.12.1):
// a thumbnail that goes through googleadservices, an extra /pagead/ anchor, an advertiser link, an ad-shaped class on a node.
// They must never be mirrored into a Cinedrape card, never collapsed, and never be hidden by a calm toggle. Two layers are tested
// separately: the JS evidence (tiles.js, run against the OLD map so no marker can help) and the CSS guards (the new map entries).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage } from '../helpers/dom.js';
import { createSelectors } from '../../src/content/selectors.js';
import { createHomeLayout } from '../../src/content/layouts/home.js';
import { extractTile, collectTiles, isAdTile } from '../../src/content/layouts/tiles.js';
import { composeStylesheet } from '../../src/content/stylesheet.js';
import { applyCalmAttributes } from '../../src/content/calm.js';
import { computeEffectiveConfig } from '../../src/shared/entitlements.js';
import { safeHide } from '../../src/shared/selector-map.js';
import { THEMES } from '../../src/themes/index.js';
import { SRC_ATTR } from '../../src/shared/constants.js';

const MAP = JSON.parse(JSON.parse(readFileSync(new URL('../../src/data/selector-map.signed.json', import.meta.url), 'utf8')).payload);
const NEW_ENTRIES = 10;
const OLD_MAP = structuredClone(MAP);
OLD_MAP.protected.ads = MAP.protected.ads.slice(0, MAP.protected.ads.length - NEW_ENTRIES);
const PRO = { plan: 'pro', status: 'active' };
const GOOGLE = 'https://www.googleadservices.com/pagead/aclk?sa=L&adurl=https%3A%2F%2Fadvertiser.example%2Foffer';

test('test setup: the old map really lacks every marker used below', () => {
  const old = OLD_MAP.protected.ads.join(',');
  for (const s of ['googleadservices', '/pagead/', 'doubleclick', 'googlesyndication', 'adurl', 'ytwAd"', '"ad-badge"', 'youtube.com"']) assert.ok(!old.includes(s), s);
  assert.equal(OLD_MAP.protected.ads.length + NEW_ENTRIES, MAP.protected.ads.length);
  for (const entry of MAP.protected.ads.slice(-NEW_ENTRIES)) assert.ok(/pagead|aclk|googleadservices|doubleclick|googlesyndication|adurl|ytwAd|AdBadge|ad-badge|href\^="http"/.test(entry), entry);
});

/** A home page whose feed has 6 organic tiles plus the given marker-less ads, which are NOT the synthetic ad slot. */
function feed() {
  const page = createPage('home', { tiles: 8, ads: false, tileStyle: 'home' });
  const { document: doc } = page;
  const contents = doc.querySelector('ytd-rich-grid-renderer #contents');
  const items = [...contents.children].filter((c) => c.matches('ytd-rich-item-renderer'));
  const make = {
    // (a) the thumbnail and the title both go through an ad redirect, nothing on the tile says "ad"
    redirect(item) { item.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', GOOGLE)); },
    // (b) ordinary-looking /watch tile with one extra anchor to the ad path on youtube.com
    pagead(item) {
      const a = doc.createElement('a');
      a.setAttribute('href', 'https://www.youtube.com/pagead/aclk?ai=1&sig=2');
      a.textContent = 'Learn more';
      item.querySelector('#content, ytd-rich-grid-media, yt-lockup-view-model').append(a);
    },
    // (c) an advertiser link that leaves youtube.com
    advertiser(item) {
      const a = doc.createElement('a');
      a.setAttribute('href', 'https://shop.advertiser.example/product');
      a.textContent = 'shop.advertiser.example';
      item.querySelector('#content, ytd-rich-grid-media, yt-lockup-view-model').append(a);
    },
    // (d) a node with an ad-shaped class (renamed after the map was cut), links all organic
    badge(item) {
      const s = doc.createElement('span');
      s.className = 'ytwAdBadgeViewModelHost';
      s.textContent = 'x';
      item.querySelector('#content, ytd-rich-grid-media, yt-lockup-view-model').append(s);
    },
    // (e) the whole cell is wrapped in an ad-shaped custom element
    wrapped(item) {
      const w = doc.createElement('ytd-promoted-lockup-renderer');
      while (item.firstChild) w.append(item.firstChild);
      item.append(w);
    },
  };
  const adItems = {};
  const names = Object.keys(make);
  names.forEach((name, i) => { adItems[name] = items[i + 1]; make[name](items[i + 1]); });
  return { page, doc, items, adItems, organic: items.filter((it) => !Object.values(adItems).includes(it)) };
}

test('tiles.js: marker-less ads are not tiles and isAdTile says so, even against a map that lists none of their markers', () => {
  const { page, doc, adItems, organic } = feed();
  const selectors = createSelectors(OLD_MAP, doc);
  for (const [name, item] of Object.entries(adItems)) {
    assert.equal(extractTile(item, selectors), null, name);
    assert.equal(isAdTile(item, OLD_MAP), true, name);
  }
  for (const item of organic) {
    assert.ok(extractTile(item, selectors), 'an ordinary tile is still a tile');
    assert.equal(isAdTile(item, OLD_MAP), false);
  }
  assert.equal(collectTiles(doc, selectors).length, organic.length);
  page.window.close();
});

test('home layout: marker-less ads are never mirrored and never collapsed; the ordinary tiles still are', () => {
  const { page, doc, window, adItems, organic } = (() => { const f = feed(); return { ...f, window: f.page.window }; })();
  const selectors = createSelectors(OLD_MAP, doc);
  const cfg = { home: 'rows', watch: 'default', density: 3, disabled: [] };
  const layout = createHomeLayout({ doc, win: window, selectors, map: OLD_MAP, getConfig: () => cfg });
  assert.equal(layout.mount(), true);
  for (const [name, item] of Object.entries(adItems)) {
    assert.equal(item.hasAttribute(SRC_ATTR), false, `${name}: not marked as a mirrored source`);
  }
  for (const item of organic) assert.equal(item.hasAttribute(SRC_ATTR), true);
  const cards = [...doc.querySelectorAll('.cd-card, .cd-hero-link')];
  for (const card of cards) {
    const href = card.getAttribute('href') || '';
    assert.ok(!/googleadservices|pagead|advertiser/.test(href), href);
  }
  assert.ok(cards.length >= organic.length - 1);
  layout.unmount();
  for (const item of Object.values(adItems)) assert.equal(item.hasAttribute(SRC_ATTR), false);
  page.window.close();
});

test('home layout, real stylesheet and the new map entries: a marker-less ad whose links go through an ad redirect is shown even if a tile were marked', () => {
  const { page, doc, window, adItems } = (() => { const f = feed(); return { ...f, window: f.page.window }; })();
  const cfg0 = computeEffectiveConfig({ settings: { themeId: 'cinema' }, licenceState: PRO, themes: THEMES });
  const cfg = { ...cfg0, home: 'rows', watch: 'default', density: 3, calm: {} };
  const { css } = composeStylesheet({ map: MAP, cfg });
  const style = doc.createElement('style');
  style.textContent = css;
  doc.head.append(style);
  const html = doc.documentElement;
  html.setAttribute('cd-theme', 'cinema'); html.setAttribute('cd-page', 'home'); html.setAttribute('cd-home', 'rows');
  // Worst case for the CSS: pretend a past pass marked the ad wrappers as mirrored sources (a tile that turned into an ad later).
  for (const item of [adItems.redirect, adItems.pagead, adItems.advertiser]) item.setAttribute(SRC_ATTR, 'x');
  for (const name of ['redirect', 'pagead', 'advertiser']) {
    assert.notEqual(window.getComputedStyle(adItems[name]).display, 'none', `${name}: the collapse rule carries the ad-link guard`);
  }
  page.window.close();
});

test('calm toggles never hide a marker-less ad that links through an ad redirect: hideHomeRecs and hideViewCounts', () => {
  for (const key of ['hideHomeRecs', 'hideViewCounts', 'hideShorts']) {
    const { page, doc, window, adItems, organic } = (() => { const f = feed(); return { ...f, window: f.page.window }; })();
    const calm = { hideShorts: false, hideHomeRecs: false, hideComments: false, hideEndScreens: false, hideViewCounts: false, [key]: true };
    const cfg0 = computeEffectiveConfig({ settings: { themeId: 'cinema' }, licenceState: PRO, themes: THEMES });
    const { css } = composeStylesheet({ map: MAP, cfg: { ...cfg0, home: 'grid', watch: 'default', density: 3, calm } });
    const style = doc.createElement('style');
    style.textContent = css;
    doc.head.append(style);
    doc.documentElement.setAttribute('cd-theme', 'cinema');
    doc.documentElement.setAttribute('cd-page', 'home');
    applyCalmAttributes(doc, calm, []);
    for (const name of ['redirect', 'pagead', 'advertiser']) {
      const item = adItems[name];
      assert.notEqual(window.getComputedStyle(item).display, 'none', `${key}/${name}: wrapper`);
      for (const span of item.querySelectorAll('.ytContentMetadataViewModelMetadataText, a')) {
        assert.notEqual(window.getComputedStyle(span).display, 'none', `${key}/${name}: ${span.textContent.slice(0, 20)}`);
      }
    }
    if (key === 'hideHomeRecs') {
      assert.equal(window.getComputedStyle(organic[0]).display, 'none', 'the toggle does work on ordinary tiles');
    }
    page.window.close();
  }
});

test('known limit, stated honestly: an ad with no marker, no ad-shaped name and only ordinary /watch links cannot be told from a tile', () => {
  const page = createPage('home', { tiles: 4, ads: false, tileStyle: 'home' });
  const item = page.document.querySelector('ytd-rich-item-renderer');
  const texts = item.querySelectorAll('.ytContentMetadataViewModelMetadataText');
  texts[texts.length - 1].textContent = 'Sponsored';       // a plain-text label: nothing language independent to key on
  const selectors = createSelectors(OLD_MAP, page.document);
  assert.ok(extractTile(item, selectors), 'structurally an ordinary tile (the guards above are what protect real ad markup)');
  page.window.close();
});

test('safeHide stays attached to every guard entry: the new href entries are in the guard of the engine\'s own hide rules', () => {
  const guarded = safeHide(MAP, 'ytd-rich-item-renderer');
  for (const entry of ['a[href*="/pagead/"]', 'a[href*="googleadservices.com"]', 'a[href*="doubleclick.net"]']) assert.ok(guarded.includes(entry), entry);
});
