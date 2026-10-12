// jsdom page builder for Cinedrape tests.
//
//   import { loadFixture, createTile, createPage, navigateTo } from '../helpers/dom.js';
//   const { dom, window, document, meta } = createPage('home', { tiles: 12, ads: true, shorts: true });
//
// Pages are assembled from the captured markup in test/fixtures/real/ (shell + one page fixture), cloned with unique
// video ids/titles to reach `tiles`, and loaded into jsdom at a real youtube.com URL so `location`, `localStorage` and
// relative links behave. Everything that is NOT a verbatim capture is listed in test/fixtures/README.md
// (home / subscriptions / history are derived; ads and two Shorts shelf shapes are synthetic).
//
// jsdom facts (verified in test/helpers/selectors-in-jsdom.test.js): :has(), :is(), :where(), :not(:has()) work in
// querySelector/matches/closest AND in getComputedStyle for top-level rules; rules inside @media/@supports are parsed
// but NOT applied by getComputedStyle; there is no layout (all rects are 0). Missing browser APIs are shimmed by
// installShims(): matchMedia, IntersectionObserver, ResizeObserver, CSS.supports, scrollIntoView.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { JSDOM, VirtualConsole } from 'jsdom';

const FIXTURES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export const PAGE_KINDS = ['home', 'watch', 'search', 'channel', 'subscriptions', 'history', 'playlist'];

const KIND_PATHS = {
  home: '/',
  watch: '/watch?v=BzpdP2APcIM',
  search: '/results?search_query=nature+documentary',
  channel: '/@NatGeo/videos',
  subscriptions: '/feed/subscriptions',
  history: '/feed/history',
  playlist: '/playlist?list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO',
};
const KIND_TITLES = {
  home: 'YouTube', watch: 'Destination Wild: Rwanda - YouTube', search: 'nature documentary - YouTube',
  channel: 'National Geographic - YouTube', subscriptions: 'Subscriptions - YouTube', history: 'YouTube',
  playlist: 'Best Nature Documentaries - YouTube',
};
const PLAYLIST_ID = 'PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO';
const ORIGIN = 'https://www.youtube.com';

// ---- fixtures -----------------------------------------------------------------------------------------------------

const fixtureCache = new Map();

/**
 * Raw text of a fixture. `name` may be 'channel-grid', 'real/channel-grid', 'synthetic/ad-slot.html', 'computed-colors.json'.
 * A bare name is looked up in real/, then synthetic/, then the fixtures root. NOTE 'shorts-shelf' exists in both real/ and
 * synthetic/: the bare name returns the real one; ask for 'synthetic/shorts-shelf' explicitly.
 */
export function loadFixture(name) {
  if (typeof name !== 'string' || !name) throw new TypeError('loadFixture(name): name must be a non-empty string');
  const file = /\.[a-z0-9]+$/i.test(name) ? name : `${name}.html`;
  const dirs = file.includes('/') ? [''] : ['real', 'synthetic', ''];
  for (const dir of dirs) {
    const full = path.resolve(FIXTURES_DIR, dir, file);
    if (full !== FIXTURES_DIR && !full.startsWith(FIXTURES_DIR + path.sep)) throw new RangeError(`fixture path escapes fixtures dir: ${name}`);
    if (!existsSync(full)) continue;
    if (!fixtureCache.has(full)) fixtureCache.set(full, readFileSync(full, 'utf8'));
    return fixtureCache.get(full);
  }
  throw new Error(`fixture not found: ${name} (looked in real/, synthetic/, root of ${FIXTURES_DIR})`);
}

const templateCache = new Map();

/** `<template id="x">...</template>` blocks of a synthetic fixture as { x: html }. */
export function loadTemplates(name) {
  if (!templateCache.has(name)) {
    const out = {};
    const re = /<template id="([^"]+)">([\s\S]*?)<\/template>/g;
    let m;
    const text = loadFixture(name);
    while ((m = re.exec(text))) out[m[1]] = m[2].trim();
    templateCache.set(name, out);
  }
  return templateCache.get(name);
}

const stripLeadingComments = (html) => html.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '');

// ---- duplicate-id selector fix ------------------------------------------------------------------------------------
//
// jsdom 29.1.1 BUG (verified in selectors-in-jsdom.test.js): element.querySelector('#x'), 'div#x' and ':scope > #x'
// return null when a DIFFERENT element with the same id appears earlier in the document and is outside `element`,
// even though `element` contains one. YouTube reuses ids everywhere (#content in every tile, #contents, #header, #items,
// #thumbnail ...), so tile.querySelector('#content') breaks for every tile but the first. Browsers are not affected.
// '[id="x"]' is not affected, so installIdFix() makes querySelector/querySelectorAll rewrite '#x' to '[id="x"]'.

/** Rewrites `#id` tokens (outside strings/attribute brackets) to `[id="id"]`. Anything it does not understand is left alone. */
export function rewriteIdSelectors(sel) {
  if (typeof sel !== 'string' || !sel.includes('#')) return sel;
  let out = '';
  let quote = null;
  let bracket = 0;
  for (let i = 0; i < sel.length;) {
    const ch = sel[i];
    if (ch === '\\') { out += ch + (sel[i + 1] ?? ''); i += 2; continue; }
    if (quote) { out += ch; if (ch === quote) quote = null; i++; continue; }
    if (ch === '"' || ch === "'") { quote = ch; out += ch; i++; continue; }
    if (ch === '[') bracket++;
    else if (ch === ']') bracket = Math.max(0, bracket - 1);
    if (ch === '#' && bracket === 0) {
      let j = i + 1;
      while (j < sel.length && /[\w\-\u00a0-\uffff]/.test(sel[j])) j++;
      const id = sel.slice(i + 1, j);
      if (id && !/^\d/.test(id) && sel[j] !== '\\') { out += `[id="${id}"]`; i = j; continue; }
    }
    out += ch;
    i++;
  }
  return out;
}

/** Patches querySelector/querySelectorAll on Element, Document and DocumentFragment of `win`. Idempotent. */
export function installIdFix(win) {
  for (const proto of [win.Element.prototype, win.Document.prototype, win.DocumentFragment.prototype]) {
    for (const name of ['querySelector', 'querySelectorAll']) {
      const orig = proto[name];
      if (typeof orig !== 'function' || orig.__cdIdFix) continue;
      const wrapped = function patched(selectors) { return orig.call(this, rewriteIdSelectors(selectors)); };
      Object.defineProperty(wrapped, '__cdIdFix', { value: true });
      proto[name] = wrapped;
    }
  }
  return win;
}

// ---- scratch document used to build fragments ---------------------------------------------------------------------

const scratch = new JSDOM('<!doctype html><html><body></body></html>');
installIdFix(scratch.window);
const sdoc = scratch.window.document;

function parseEl(html) {
  const t = sdoc.createElement('template');
  t.innerHTML = html;
  const el = t.content.firstElementChild;
  if (!el) throw new Error('fixture produced no element');
  return el;
}

const realFixtureEl = (name) => parseEl(stripLeadingComments(loadFixture(name)));
const tpl = (fixture, id) => {
  const html = loadTemplates(fixture)[id];
  if (!html) throw new Error(`template #${id} missing from ${fixture}`);
  return parseEl(html);
};
const kids = (el, sel) => [...el.children].filter((c) => c.matches(sel));
const setText = (el, text) => { if (el) el.textContent = text; };
const slug = (n, w = 5) => String(n).padStart(w, '0');

// ---- number-ish speech helpers -----------------------------------------------------------------------------------

function spokenDuration(text) {
  const parts = String(text).split(':').map((n) => Number(n));
  const units = parts.length === 3 ? ['hour', 'minute', 'second'] : parts.length === 2 ? ['minute', 'second'] : ['second'];
  return parts.map((n, i) => `${n} ${units[i]}${n === 1 ? '' : 's'}`).join(', ');
}
function spokenAge(text) {
  return String(text).replace(/\b(\d+) (hr|mo|yr|min|sec|wk)\b/g, (_, n, u) => {
    const word = { hr: 'hour', mo: 'month', yr: 'year', min: 'minute', sec: 'second', wk: 'week' }[u];
    return `${n} ${word}${n === '1' ? '' : 's'}`;
  });
}
function spokenViews(text) {
  const m = /^([\d.,]+)\s*([kKmMbB])?$/.exec(String(text).trim());
  if (!m) return `${text} views`;
  const word = { k: ' thousand', m: ' million', b: ' billion' }[(m[2] || '').toLowerCase()] || '';
  return `${m[1]}${word} views`;
}

/** Swaps the content-id-<id> token of a lockup host in place (class order stays as captured). */
function setContentId(host, id) {
  host.setAttribute('class', host.getAttribute('class').split(/\s+/).map((c) => (c.startsWith('content-id-') ? `content-id-${id}` : c)).join(' '));
}

// ---- tiles --------------------------------------------------------------------------------------------------------

const TOPICS = ['Savanna at dawn', 'Deep ocean mysteries', 'Arctic survival', 'Rainforest canopy', 'Desert nights', 'Mountain rivers',
  'Coral reef cities', 'Night hunters', 'Migration season', 'Volcano islands'];
const DURATIONS = ['3:21', '12:05', '1:02:44', '45:10', '8:48', '27:33', '1:34:31', '5:59'];
const VIEWS = ['1.2k', '45k', '310k', '2.3m', '870', '15k', '1.1m', '64k'];
const AGES = ['2 hours ago', '1 day ago', '3 days ago', '2 weeks ago', '1 month ago', '5 months ago', '1 year ago', '4 days ago'];
const CHANNELS = ['National Geographic', 'Nature Lab', 'Wild Frames', 'Earth Atlas'];

/** Deterministic, unique, 11-char "video id": CDtile00001, CDtile00002, ... */
export const tileId = (i) => `CDtile${slug(i + 1)}`;

function syntheticData(i) {
  return {
    id: tileId(i), title: `Synthetic tile ${i + 1}: ${TOPICS[i % TOPICS.length]}`, duration: DURATIONS[i % DURATIONS.length],
    views: VIEWS[i % VIEWS.length], age: AGES[i % AGES.length], channel: CHANNELS[i % CHANNELS.length],
  };
}

let tileTemplateHtml;
function tileTemplateEl() {
  if (!tileTemplateHtml) {
    const grid = realFixtureEl('real/channel-grid');
    const first = grid.querySelector('ytd-rich-item-renderer');
    first.removeAttribute('is-in-first-column');
    tileTemplateHtml = first.outerHTML;
  }
  return parseEl(tileTemplateHtml);
}

/** Reads {id,title,duration,views,age} back out of a ytd-rich-item-renderer tile. */
export function readTile(el) {
  const host = el.querySelector('.ytLockupViewModelHost');
  const idClass = host && [...host.classList].find((c) => c.startsWith('content-id-'));
  const meta = [...el.querySelectorAll('.ytContentMetadataViewModelMetadataText')];
  return {
    id: idClass ? idClass.slice('content-id-'.length) : null,
    title: (el.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost') || {}).textContent || null,
    duration: (el.querySelector('.ytBadgeShapeText') || {}).textContent || null,
    views: meta.length ? meta[meta.length === 3 ? 1 : 0].textContent : null,
    age: meta.length ? meta[meta.length - 1].textContent : null,
  };
}

function buildTileEl(opts = {}) {
  const d = syntheticData(0);
  const { id = d.id, title = d.title, duration = d.duration, views = d.views, age = d.age, href, channel } = opts;
  const el = tileTemplateEl();
  const host = el.querySelector('.ytLockupViewModelHost');
  setContentId(host, id);
  const link = href ?? `/watch?v=${id}`;
  el.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', link));
  const img = el.querySelector('.ytThumbnailViewModelImage img');
  if (img) img.setAttribute('src', `https://i.ytimg.com/vi/${id}/hq720.jpg`);
  const h3 = el.querySelector('h3[title]');
  h3.setAttribute('title', title);
  setText(el.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost'), title);
  setText(el.querySelector('.ytBadgeShapeText'), duration);
  el.querySelector('badge-shape')?.setAttribute('aria-label', spokenDuration(duration));
  const metas = el.querySelectorAll('.ytContentMetadataViewModelMetadataText');
  setText(metas[0], views);
  metas[0].setAttribute('aria-label', spokenViews(views));
  setText(metas[metas.length - 1], age);
  metas[metas.length - 1].setAttribute('aria-label', spokenAge(age));
  if (channel) {
    // Real logged-out home tile (2026-10-07): avatar + ONE metadata row "channel - views - age" (three texts).
    const metaHost = el.querySelector('yt-lockup-metadata-view-model');
    const avatar = sdoc.createElement('div');
    avatar.className = 'ytLockupMetadataViewModelAvatar';
    avatar.innerHTML = '<yt-decorated-avatar-view-model class="ytDecoratedAvatarViewModelHost"></yt-decorated-avatar-view-model>';
    metaHost.insertBefore(avatar, metaHost.querySelector('.ytLockupMetadataViewModelTextContainer'));
    const ch = metas[0].cloneNode(true);
    ch.textContent = channel;
    ch.removeAttribute('aria-label');
    const delim = el.querySelector('.ytContentMetadataViewModelDelimiter').cloneNode(true);
    metas[0].parentNode.insertBefore(ch, metas[0]);
    metas[0].parentNode.insertBefore(delim, metas[0]);
  }
  return el;
}

/**
 * One faithful ytd-rich-item-renderer tile (HTML string), derived from the captured NatGeo channel-grid tile.
 * Without `channel` it is the channel-grid shape (metadata row = views, age). With `channel` it is the home shape
 * (avatar + one row "channel, views, age").
 * @param {{id?:string,title?:string,duration?:string,views?:string,age?:string,href?:string,channel?:string}} [opts]
 */
export function createTile(opts = {}) {
  return buildTileEl(opts).outerHTML;
}

// ---- other renderers cloned from captures ------------------------------------------------------------------------

function buildVideoRenderer(template, data, { history = false } = {}) {
  const el = template.cloneNode(true);
  const link = `/watch?v=${data.id}`;
  const thumb = el.querySelector('a#thumbnail');
  thumb.setAttribute('href', link);
  const img = el.querySelector('img');
  if (img) img.setAttribute('src', `https://i.ytimg.com/vi/${data.id}/hq720.jpg`);
  setText(el.querySelector('.ytBadgeShapeText'), data.duration);
  const vt = el.querySelector('a#video-title');
  vt.setAttribute('href', link);
  vt.setAttribute('title', data.title);
  setText(vt.querySelector('yt-formatted-string'), data.title);
  const items = el.querySelectorAll('#metadata-line .inline-metadata-item');
  setText(items[0], data.views);
  setText(items[1], data.age);
  const ch = el.querySelector('#channel-info ytd-channel-name a');
  if (ch) { setText(ch, data.channel); ch.setAttribute('href', `/@${data.channel.replace(/\W+/g, '')}`); }
  if (history) {
    el.removeAttribute('use-search-ui');
    el.removeAttribute('is-search');
    el.setAttribute('is-history', '');
  }
  return el;
}

function buildRelatedLockup(template, data) {
  const el = template.cloneNode(true);
  const host = el.querySelector('.ytLockupViewModelHost');
  setContentId(host, data.id);
  const link = `/watch?v=${data.id}&pp=0gcJCTUMAYcqIYzv`;
  el.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', link));
  el.querySelector('.ytThumbnailViewModelImage img')?.setAttribute('src', `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`);
  setText(el.querySelector('.ytBadgeShapeText'), data.duration);
  el.querySelector('h3[title]').setAttribute('title', data.title);
  setText(el.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost'), data.title);
  const rows = el.querySelectorAll('.ytContentMetadataViewModelMetadataRow');
  setText(rows[0].querySelector('.ytContentMetadataViewModelMetadataText'), data.channel);
  const spans = rows[1].querySelectorAll('.ytContentMetadataViewModelMetadataText');
  setText(spans[0], data.views);
  setText(spans[1], data.age);
  return el;
}

function buildPlaylistRow(template, data, index) {
  const row = template.cloneNode(true);
  const host = row.querySelector('.ytLockupViewModelHost');
  setContentId(host, data.id);
  const link = `/watch?v=${data.id}&list=${PLAYLIST_ID}&index=${index + 1}&pp=iAQB`;
  row.querySelectorAll('a[href^="/watch"]').forEach((a) => a.setAttribute('href', link));
  row.querySelector('.ytThumbnailViewModelImage img')?.setAttribute('src', `https://i.ytimg.com/vi/${data.id}/hqdefault.jpg`);
  setText(row.querySelector('.ytBadgeShapeText'), data.duration);
  row.querySelector('h3[title]').setAttribute('title', data.title);
  setText(row.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost'), data.title);
  const rows = row.querySelectorAll('.ytContentMetadataViewModelMetadataRow');
  const spans = rows[1].querySelectorAll('.ytContentMetadataViewModelMetadataText');
  setText(spans[0], data.views);
  setText(spans[1], data.age);
  return row;
}

// ---- insertion helpers ------------------------------------------------------------------------------------------

/** Evenly spaced insertion indexes for `count` extras among `total` items. */
const spread = (count, total) => Array.from({ length: count }, (_, k) => Math.floor(((k + 1) * total) / (count + 1)));

const adCount = (ads) => (ads === true ? 1 : Number.isFinite(Number(ads)) ? Math.max(0, Math.floor(Number(ads))) : 0);

// ---- page builders -----------------------------------------------------------------------------------------------

const FEED_CHIPS = (labels) => `<div id="header"><ytd-feed-filter-chip-bar-renderer at-start="" is-dark-theme="" fluid-width="" component-style="FEED_FILTER_CHIP_BAR_STYLE_TYPE_DEFAULT"><div id="chips-wrapper"><div id="chips-content"><div id="scroll-container"><iron-selector id="chips" activate-event="" role="tablist" selected-attribute="selected">${labels.map((l, i) => `<yt-chip-cloud-chip-renderer${i === 0 ? ' class="iron-selected" selected=""' : ''} chip-style="STYLE_HOME_FILTER"><div id="chip-shape-container"><chip-shape class="ytChipShapeHost"><button class="ytChipShapeButtonReset" role="tab" aria-selected="${i === 0}"><div class="ytChipShapeChip ${i === 0 ? 'ytChipShapeActive' : 'ytChipShapeInactive'} ytChipShapeOnlyTextPadding"><div>${l}</div></div></button></chip-shape></div></yt-chip-cloud-chip-renderer>`).join('')}</iron-selector></div></div></div></ytd-feed-filter-chip-bar-renderer></div>`;

function gridPage(kind, o, meta) {
  const root = realFixtureEl('real/channel-grid'); // ytd-browse[page-subtype=channels]
  const tc = root.querySelector('ytd-two-column-browse-results-renderer');
  const grid = root.querySelector('ytd-rich-grid-renderer');
  const contents = grid.querySelector(':scope > #contents');
  const realTiles = kids(contents, 'ytd-rich-item-renderer');
  const realData = realTiles.map(readTile);
  const perRow = Number(grid.getAttribute('elements-per-row')) || 3;
  const continuation = kids(contents, 'ytd-continuation-item-renderer')[0];
  realTiles.forEach((t) => t.remove());

  const channelStyle = o.tileStyle === 'home';
  for (let i = 0; i < o.tiles; i++) {
    const data = i < realData.length ? realData[i] : syntheticData(i);
    const tile = buildTileEl({ ...data, channel: channelStyle ? CHANNELS[i % CHANNELS.length] : undefined });
    tile.setAttribute('items-per-row', String(perRow));
    if (i % perRow === 0) tile.setAttribute('is-in-first-column', '');
    contents.insertBefore(tile, continuation);
  }

  if (kind !== 'channel') {
    root.setAttribute('page-subtype', kind);
    tc.setAttribute('page-subtype', kind);
    // The channel header (ytd-tabbed-page-header) only exists on channel pages.
    root.querySelector(':scope > #header')?.replaceChildren();
    if (kind === 'home') {
      tc.setAttribute('class', 'grid grid-disabled');
      tc.setAttribute('disable-grid-state-aware', '');
      grid.removeAttribute('is-slim-grid');
      grid.setAttribute('is-default-grid', '');
      grid.querySelector(':scope > #header').outerHTML = FEED_CHIPS(['All', 'Podcasts', 'Live', 'Gaming']);
    } else { // subscriptions: wrapper attributes verified live (grid grid-5-columns); the rest is derived
      tc.setAttribute('class', 'grid grid-5-columns');
      grid.querySelector(':scope > #header').outerHTML = FEED_CHIPS(['All', 'Today', 'Continue watching']);
    }
  }

  const adsN = adCount(o.ads);
  meta.ads = 0;
  if (adsN) {
    const feedAd = loadTemplates('synthetic/ad-slot')['feed-ad'];
    const placed = kids(contents, 'ytd-rich-item-renderer');
    spread(adsN, placed.length).reverse().forEach((idx) => {
      const ad = parseEl(feedAd);
      contents.insertBefore(ad, placed[idx] || continuation);
      meta.ads++;
    });
    if (kind === 'home' || kind === 'subscriptions') {
      const slot = grid.querySelector(':scope > #masthead-ad');
      if (slot) { slot.appendChild(tpl('synthetic/ad-slot', 'masthead-ad')); meta.ads++; }
    }
  }

  meta.shorts = null;
  if (o.shorts) {
    const variant = o.shorts === true ? 'rich' : String(o.shorts);
    const shelf = shelfNode(variant);
    const anchors = kids(contents, 'ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))');
    contents.insertBefore(shelf, anchors[Math.min(4, anchors.length)] || continuation);
    meta.shorts = variant;
  }
  return root;
}

function shelfNode(variant) {
  if (variant === 'rich') return tpl('synthetic/shorts-shelf', 'rich-shelf');
  if (variant === 'reel') return tpl('synthetic/shorts-shelf', 'reel-shelf');
  if (variant === 'grid') return realFixtureEl('real/shorts-shelf');
  throw new RangeError(`unknown shorts variant "${variant}" (use true | 'rich' | 'reel' | 'grid')`);
}

function searchPage(o, meta) {
  const root = realFixtureEl('real/search-results');
  const contents = root.querySelector('ytd-item-section-renderer > #contents');
  const lockup = contents.querySelector(':scope > yt-lockup-view-model'); // the playlist lockup
  const vids = kids(contents, 'ytd-video-renderer');
  const template = vids[0].cloneNode(true);
  const keep = vids.slice(0, o.tiles);
  for (let i = keep.length; i < o.tiles; i++) keep.push(buildVideoRenderer(template, syntheticData(i)));
  // Order like the real page: video, playlist lockup, then the rest of the videos.
  [...contents.children].forEach((c) => c.remove());
  keep.forEach((v, i) => { contents.appendChild(v); if (i === 0) contents.appendChild(lockup); });
  if (!keep.length) contents.appendChild(lockup);

  meta.ads = 0;
  const adsN = adCount(o.ads);
  if (adsN) {
    const feedItems = [...contents.children];
    // Like the live page: the first sponsored result leads, any others are spread through the list.
    const slots = adsN === 1 ? [0] : [0, ...spread(adsN - 1, feedItems.length)];
    slots.reverse().forEach((idx) => {
      contents.insertBefore(tpl('synthetic/ad-slot', 'search-ad'), feedItems[idx] || null);
      meta.ads++;
    });
  }
  meta.shorts = null;
  if (o.shorts) {
    const variant = o.shorts === true ? 'grid' : String(o.shorts);
    const items = [...contents.children].filter((c) => !c.matches('ytd-ad-slot-renderer'));
    contents.insertBefore(shelfNode(variant), items[Math.min(1, items.length)] || null);
    meta.shorts = variant;
  }
  return root;
}

function watchPage(o, meta) {
  const root = realFixtureEl('real/watch');
  const rel = root.querySelector('#related ytd-item-section-renderer > #contents');
  const lockups = kids(rel, 'yt-lockup-view-model');
  const template = lockups[0].cloneNode(true);
  lockups.slice(o.tiles).forEach((l) => l.remove());
  const have = Math.min(lockups.length, o.tiles);
  for (let i = have; i < o.tiles; i++) rel.appendChild(buildRelatedLockup(template, syntheticData(i)));

  meta.ads = 0;
  const n = adCount(o.ads);
  if (n) {
    const player = root.querySelector('#movie_player');
    player.insertBefore(tpl('synthetic/ad-slot', 'player-ad'), player.querySelector('.ytp-chrome-top'));
    meta.ads++;
    const old = root.querySelector('.ytp-paid-content-overlay');
    old.replaceWith(tpl('synthetic/ad-slot', 'sponsor'));
    meta.sponsor = true;
    root.querySelector('#player-ads').appendChild(tpl('synthetic/ad-slot', 'related-ad'));
    meta.ads++;
    spread(n, kids(rel, 'yt-lockup-view-model').length).reverse().forEach((idx) => {
      rel.insertBefore(tpl('synthetic/ad-slot', 'related-ad'), kids(rel, 'yt-lockup-view-model')[idx] || null);
      meta.ads++;
    });
  }
  meta.shorts = null;
  if (o.shorts) {
    const variant = o.shorts === true ? 'reel' : String(o.shorts);
    rel.insertBefore(shelfNode(variant), kids(rel, 'yt-lockup-view-model')[Math.min(2, kids(rel, 'yt-lockup-view-model').length)] || null);
    meta.shorts = variant;
  }
  return root;
}

function historyPage(o, meta) {
  // DERIVED: logged-out history is a sign-in empty state, so the logged-in list is built from the captured search
  // ytd-video-renderer (history rows are ytd-video-renderer[is-history] in ytd-item-section-renderer).
  const search = realFixtureEl('real/search-results');
  const template = search.querySelector('ytd-video-renderer');
  const root = parseEl(`<ytd-browse rounded-container="" page-subtype="history" responsive-sizing="COMPACT" role="main" guide-persistent-and-visible=""><div id="alert-banner"></div><div id="personal-greeting"></div><div id="masthead-ad"></div><div id="header"></div><ytd-two-column-browse-results-renderer class="grid grid-5-columns" page-subtype="history" has-secondary-column-data=""><div id="primary"><ytd-section-list-renderer><div id="header-container"></div><div id="contents"><ytd-item-section-renderer><div id="header"><ytd-item-section-header-renderer><div id="title">Today</div></ytd-item-section-header-renderer></div><div id="contents"></div></ytd-item-section-renderer><ytd-continuation-item-renderer engagement-panel=""><tp-yt-paper-spinner id="spinner" aria-hidden="true"></tp-yt-paper-spinner></ytd-continuation-item-renderer></div><div id="continuations"></div></ytd-section-list-renderer></div><div id="secondary"><ytd-button-renderer button-renderer=""><button aria-label="Clear all watch history">Clear all watch history</button></ytd-button-renderer><ytd-button-renderer button-renderer=""><button aria-label="Pause watch history">Pause watch history</button></ytd-button-renderer></div></ytd-two-column-browse-results-renderer></ytd-browse>`);
  const list = root.querySelector('ytd-item-section-renderer > #contents');
  for (let i = 0; i < o.tiles; i++) list.appendChild(buildVideoRenderer(template, syntheticData(i), { history: true }));
  meta.ads = 0;
  meta.shorts = null;
  return root;
}

function playlistPage(o, meta) {
  const root = realFixtureEl('real/playlist');
  const contents = root.querySelector('yt-item-section-renderer > #contents');
  const rows = kids(contents, 'div');
  const template = rows[0].cloneNode(true);
  rows.slice(o.tiles).forEach((r) => r.remove());
  for (let i = Math.min(rows.length, o.tiles); i < o.tiles; i++) contents.appendChild(buildPlaylistRow(template, syntheticData(i), i));
  meta.ads = 0;
  meta.shorts = null;
  return root;
}

const BUILDERS = {
  home: (o, m) => gridPage('home', o, m),
  channel: (o, m) => gridPage('channel', o, m),
  subscriptions: (o, m) => gridPage('subscriptions', o, m),
  search: searchPage,
  watch: watchPage,
  history: historyPage,
  playlist: playlistPage,
};

// ---- rename (simulate a YouTube markup change) --------------------------------------------------------------------

/**
 * Renames markup in a live document so selector-map fallbacks and the health check can be exercised.
 * Each entry: 'ytd-rich-item-renderer' (tag) | '.className' | '#id' | '[attr]' => renamed with a "-x" suffix,
 * or [from, to] / { from, to } with an explicit new name (same kind, no prefix on the new name).
 * Returns how many elements were touched; a rename that matches nothing returns 0 so tests can assert the fixture really had it.
 */
export function applyRename(document, rename) {
  let touched = 0;
  for (const entry of rename || []) {
    const [from, to] = Array.isArray(entry) ? entry : typeof entry === 'object' && entry ? [entry.from, entry.to] : [entry, undefined];
    if (typeof from !== 'string' || !from) throw new TypeError('rename entries must be strings, [from,to] or {from,to}');
    const bare = from.replace(/^[.#[]/, '').replace(/\]$/, '');
    if (!/^[A-Za-z_][\w-]*$/.test(bare)) throw new TypeError(`rename supports a single tag, .class, #id or [attr] (got "${from}")`);
    const next = (to ?? `${bare}-x`).replace(/^[.#[]/, '').replace(/\]$/, '');
    let hits;
    if (from[0] === '.') {
      hits = [...document.querySelectorAll(from)];
      hits.forEach((el) => { el.classList.remove(bare); el.classList.add(next); });
    } else if (from[0] === '#') {
      hits = [...document.querySelectorAll(from)];
      hits.forEach((el) => el.setAttribute('id', next));
    } else if (from[0] === '[') {
      hits = [...document.querySelectorAll(from)];
      hits.forEach((el) => { const v = el.getAttribute(bare); el.removeAttribute(bare); el.setAttribute(next, v); });
    } else {
      hits = [...document.getElementsByTagName(bare)];
      hits.forEach((el) => {
        const copy = document.createElement(next);
        for (const attr of el.attributes) copy.setAttribute(attr.name, attr.value);
        while (el.firstChild) copy.appendChild(el.firstChild);
        el.replaceWith(copy);
      });
    }
    touched += hits.length;
  }
  return touched;
}

// ---- jsdom shims ---------------------------------------------------------------------------------------------------

/**
 * Adds the browser APIs jsdom lacks that Cinedrape code uses (and the duplicate-id selector fix, see installIdFix).
 * Idempotent. Exposes win.__cd.setReducedMotion(bool) which flips prefers-reduced-motion and fires 'change' on live
 * MediaQueryList objects.
 */
export function installShims(win, { reducedMotion = false, dark = true, idFix = true } = {}) {
  if (idFix) installIdFix(win);
  const state = { reducedMotion, dark, lists: new Set() };
  const evalQuery = (q) => {
    const s = String(q).toLowerCase();
    if (/prefers-reduced-motion:\s*reduce/.test(s)) return state.reducedMotion;
    if (/prefers-color-scheme:\s*dark/.test(s)) return state.dark;
    let m = /\(min-width:\s*(\d+)px\)/.exec(s);
    if (m) return win.innerWidth >= Number(m[1]);
    m = /\(max-width:\s*(\d+)px\)/.exec(s);
    if (m) return win.innerWidth <= Number(m[1]);
    return false;
  };
  if (typeof win.matchMedia !== 'function') {
    win.matchMedia = (media) => {
      const listeners = new Set();
      const mql = {
        media: String(media), onchange: null,
        get matches() { return evalQuery(media); },
        addEventListener: (t, fn) => { if (t === 'change') listeners.add(fn); },
        removeEventListener: (t, fn) => { listeners.delete(fn); },
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
        dispatchEvent: () => true,
        _fire() { const ev = { matches: mql.matches, media: mql.media }; listeners.forEach((fn) => fn(ev)); if (typeof mql.onchange === 'function') mql.onchange(ev); },
      };
      state.lists.add(mql);
      return mql;
    };
  }
  const NoopObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  if (!win.IntersectionObserver) win.IntersectionObserver = NoopObserver;
  if (!win.ResizeObserver) win.ResizeObserver = NoopObserver;
  if (!win.CSS) win.CSS = {};
  if (typeof win.CSS.supports !== 'function') win.CSS.supports = () => true;
  if (typeof win.CSS.escape !== 'function') win.CSS.escape = (s) => String(s).replace(/[^\w-]/g, (c) => `\\${c}`);
  const proto = win.HTMLElement.prototype;
  for (const name of ['scrollIntoView', 'scrollTo', 'scrollBy']) if (typeof proto[name] !== 'function') proto[name] = function noop() {};
  win.__cd = {
    setReducedMotion(v) { state.reducedMotion = !!v; state.lists.forEach((l) => l._fire()); },
  };
  return win;
}

// ---- document assembly --------------------------------------------------------------------------------------------

function htmlAttrs(dark) {
  return `lang="en-GB" ${dark ? 'darker-dark-theme="" darker-dark-theme-deprecate="" dark="" ' : ''}system-icons="" color-version="v2_0" typography="" typography-spacing=""`;
}

function normaliseUrl(kind, url) {
  if (!url) return ORIGIN + KIND_PATHS[kind];
  if (url.startsWith('/')) return ORIGIN + url;
  return url;
}

const GUIDE_HOSTS = 'ytd-app, ytd-masthead, ytd-mini-guide-renderer, ytd-guide-section-renderer, ytd-browse, ytd-search, ytd-two-column-search-results-renderer';

/** On /watch the guide is an overlay: YouTube drops guide-persistent-and-visible from the shell and adds is-watch-page. */
function setWatchMode(document, watch) {
  const app = document.querySelector('ytd-app');
  if (watch) {
    app.setAttribute('is-watch-page', '');
    document.querySelectorAll('[guide-persistent-and-visible]').forEach((e) => e.removeAttribute('guide-persistent-and-visible'));
  } else {
    app.removeAttribute('is-watch-page');
    document.querySelectorAll(GUIDE_HOSTS).forEach((e) => e.setAttribute('guide-persistent-and-visible', ''));
  }
}

function finishDocument(document, kind, o) {
  if (kind === 'watch') setWatchMode(document, true);
  if (!o.dark) document.querySelectorAll('[is-dark-theme],[page-dark-theme]').forEach((e) => { e.removeAttribute('is-dark-theme'); e.removeAttribute('page-dark-theme'); });
  return o.rename?.length ? applyRename(document, o.rename) : 0;
}

/**
 * Builds a jsdom YouTube page.
 * @param {'home'|'watch'|'search'|'channel'|'subscriptions'|'history'|'playlist'} kind
 * @param {object} [opts]
 * @param {number} [opts.tiles=8]    video tiles/rows/related items (ads, shelves, the search playlist lockup are extra)
 * @param {boolean|number} [opts.ads=false]  true = 1 ad; N = N feed/result ads (watch also gets .ytp-ad-module, a populated
 *                                   .ytp-paid-content-overlay and an ad in #player-ads). No-op on history/playlist.
 * @param {boolean|'rich'|'reel'|'grid'} [opts.shorts=false]  Shorts shelf; true picks the natural shape per page. No-op on history/playlist.
 * @param {boolean} [opts.dark=true]   html[dark] (YouTube dark mode)
 * @param {Array<string|[string,string]|{from:string,to?:string}>} [opts.rename=[]]  simulate a YouTube change (see applyRename)
 * @param {string} [opts.url]          override the page URL (absolute, or a path on www.youtube.com)
 * @param {'grid'|'home'} [opts.tileStyle='grid']  'home' = tiles carry an avatar and "channel, views, age" (real home shape)
 * @param {boolean} [opts.reducedMotion=false]  initial prefers-reduced-motion for the matchMedia shim
 * @param {boolean} [opts.duplicateIdFix=true]  false = leave jsdom's raw duplicate-id querySelector bug in place (see installIdFix)
 * @returns {{dom:JSDOM, window:Window, document:Document, kind:string, url:string, errors:Error[], renamed:number,
 *            meta:{ads:number,shorts:string|null,tiles:number,sponsor?:boolean}}}  errors = jsdom errors (should stay empty);
 *            renamed = elements touched by opts.rename; meta.ads counts every inserted ad container (feed, masthead, search,
 *            player, #player-ads, related).
 */
export function createPage(kind, opts = {}) {
  if (!PAGE_KINDS.includes(kind)) throw new RangeError(`createPage: unknown kind "${kind}" (expected one of ${PAGE_KINDS.join(', ')})`);
  const o = { tiles: 8, ads: false, shorts: false, dark: true, rename: [], tileStyle: 'grid', reducedMotion: false, ...opts };
  if (!Number.isInteger(o.tiles) || o.tiles < 0) throw new RangeError('createPage: tiles must be a non-negative integer');
  const meta = { ads: 0, shorts: null, tiles: o.tiles };
  const pageHtml = BUILDERS[kind](o, meta).outerHTML;
  const shell = stripLeadingComments(loadFixture('real/shell'));
  if (!shell.includes('<!--PAGE-->')) throw new Error('shell.html lost its <!--PAGE--> marker');
  const html = `<!doctype html><html ${htmlAttrs(o.dark)}><head><meta charset="utf-8"><title>${KIND_TITLES[kind]}</title></head><body>${shell.replace('<!--PAGE-->', () => pageHtml)}</body></html>`;
  const errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => errors.push(e));
  const url = normaliseUrl(kind, o.url);
  const dom = new JSDOM(html, { url, pretendToBeVisual: true, virtualConsole });
  installShims(dom.window, { reducedMotion: o.reducedMotion, dark: o.dark, idFix: o.duplicateIdFix !== false });
  const renamed = finishDocument(dom.window.document, kind, o);
  return { dom, window: dom.window, document: dom.window.document, kind, url, errors, meta, renamed };
}

/**
 * Simulates a YouTube SPA navigation inside an existing page: swaps the ytd-page-manager child, pushState()s the new
 * URL and fires yt-navigate-start, yt-navigate-finish and yt-page-data-updated on document (all bubbling, like YouTube).
 * Returns the new page element.
 */
export function navigateTo(page, kind, opts = {}) {
  if (!PAGE_KINDS.includes(kind)) throw new RangeError(`navigateTo: unknown kind "${kind}"`);
  const { window, document } = page;
  const o = { tiles: 8, ads: false, shorts: false, dark: true, rename: [], tileStyle: 'grid', ...opts };
  const url = normaliseUrl(kind, o.url);
  const fire = (type, detail) => document.dispatchEvent(new window.CustomEvent(type, { bubbles: true, detail }));
  fire('yt-navigate-start', { url });
  const meta = { ads: 0, shorts: null, tiles: o.tiles };
  const pm = document.querySelector('ytd-page-manager');
  const html = BUILDERS[kind](o, meta).outerHTML;
  const holder = document.createElement('template');
  holder.innerHTML = html;
  pm.replaceChildren(holder.content);
  window.history.pushState({}, '', url);
  setWatchMode(document, kind === 'watch');
  if (o.rename?.length) applyRename(document, o.rename);
  page.kind = kind;
  page.url = url;
  page.meta = meta;
  fire('yt-navigate-finish', { url });
  fire('yt-page-data-updated', { url });
  return pm.firstElementChild;
}

/** True when `selector` is accepted by this window's selector engine (use it as a loud canary in tests). */
export function selectorSupported(window, selector) {
  try { window.document.querySelector(selector); return true; } catch { return false; }
}
