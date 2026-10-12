// Video tile extraction (ARCHITECTURE.md sections 1, 4 and 6).
//
// The home layout never calls YouTube's APIs: it reads titles, thumbnails and links from tiles YouTube already drew and puts
// them into its own cards. This file is the reader. It is deliberately forgiving about shapes (the metadata layout differs on
// the channel grid, the home feed and watch-related rows, section 1) and deliberately strict about what counts as a video:
// an ad, a Shorts cell, a playlist or Mix lockup, a skeleton placeholder, or anything without a /watch link AND a title is
// not a tile and yields null / is skipped. A skipped tile is simply left alone in YouTube's own grid.
//
// Reading is done through the selector map (roles tileLink/tileTitle/tileThumb/tileDuration/tileChannel/tileMeta, which are the
// map's tileFields lists), then through a short list of built-in fallbacks for the shapes section 1 documents, so a map that
// lost a field degrades instead of blanking the home page.
//
// Ads: every marker in the selector map is a hand-written guess (real ads were never captured), so a tile is ALSO refused on
// evidence that does not depend on any marker: an anchor that leaves youtube.com or goes through an ad path (/pagead/, /aclk,
// googleadservices, doubleclick...), ad-shaped tag or class names, or a primary link that is not a plain /watch?v=<11 chars> on
// youtube.com. A refused tile stays where YouTube put it, untouched, and is never mirrored or collapsed (section 6).
//
// Nothing here writes to the DOM or throws: junk input (null, detached nodes, a hostile map) is "not a tile".

const NOT_A_VIDEO = [
  'yt-collection-thumbnail-view-model',      // playlist / collection / Mix lockups (they link to /watch?v=..&list=..)
  '.ytLockupViewModelCollectionStack2',
  'ytd-playlist-renderer', 'ytd-compact-playlist-renderer', 'ytd-grid-playlist-renderer',
  'ytd-radio-renderer', 'ytd-compact-radio-renderer', 'ytd-channel-renderer',
].join(',');

const SHORTS = [
  'ytm-shorts-lockup-view-model-v2', 'ytm-shorts-lockup-view-model', 'ytd-reel-item-renderer',
  'a[href^="/shorts/"]', 'a[href*="youtube.com/shorts/"]',
].join(',');

// Used only when the map has no usable entry for a field (a hot-swapped older map). The map always wins.
const FALLBACK = Object.freeze({
  tileLink: ['a.ytLockupViewModelContentImage[href^="/watch"]', 'a.ytLockupMetadataViewModelTitle[href^="/watch"]', 'a#thumbnail[href^="/watch"]', 'a#video-title[href^="/watch"]'],
  tileTitle: ['a.ytLockupMetadataViewModelTitle', 'a#video-title', 'h3.ytLockupMetadataViewModelHeadingReset'],
  tileThumb: ['.ytThumbnailViewModelImage img', 'yt-thumbnail-view-model img', 'ytd-thumbnail img'],
  tileDuration: ['yt-thumbnail-bottom-overlay-view-model .ytBadgeShapeText', 'ytd-thumbnail-overlay-time-status-renderer .ytBadgeShapeText'],
  tileMeta: ['.ytContentMetadataViewModelMetadataText', '#metadata-line .inline-metadata-item'],
  videoTile: ['yt-lockup-view-model', 'ytd-rich-grid-media', 'ytd-video-renderer', 'ytd-compact-video-renderer'],
});

const YOUTUBE_HOST = /(?:^|\.)youtube\.com$/i;
const OWN_HOST = /^(?:www\.)?youtube\.com$/i;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const AD_PATH = /\/(?:pagead|aclk|ptracking|api\/stats\/ads)(?:[/?#]|$)/i;
const AD_PARAMS = ['adurl', 'ad_type', 'ad_cpn', 'ad_query', 'aclk_sa'];
// Ad-shaped names, language independent: ad / ads as a whole word of a tag or class (ytd-ad-slot-renderer, ytp-ad-text, video-ads,
// ad-badge-view-model), sponsor/promoted/pagead/advert anywhere, and camel-case AdBadge/AdSlot/AdCta... (ytwAdBadge). A paid-promotion
// disclosure is not an ad: protected.sponsor and holdsSponsor() deal with it.
// Nothing here is a word of an ordinary tile (the real captures in test/fixtures/real are the regression corpus).
const AD_WORD = /(?:^|[-_])ads?(?:[-_]|$)/;
const AD_FRAGMENT = /sponsor|promoted|pagead|advert/;
const AD_CAMEL = /(?:^ad|[a-z0-9]Ad)(?:Badge|Slot|Cta|Text|Label|Info|Choices?|Lockup|Renderer|Layout|Impression)/;
const MAX_DESCENDANTS = 400;
const MAX_ANCHORS = 80;
const MAX_ANCESTORS = 8;

// ---- small helpers ---------------------------------------------------------------------------------------------------

const isElement = (n) => n != null && typeof n === 'object' && n.nodeType === 1 && typeof n.querySelector === 'function';
const clean = (s) => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');
const textOf = (el) => (el ? clean(el.textContent) : '');
const attr = (el, name) => (el && typeof el.getAttribute === 'function' ? el.getAttribute(name) || '' : '');

/** matches() that treats an unparseable selector as "no". */
function safeMatches(el, sel) {
  try { return el.matches(sel); } catch { return false; }
}
function safeQuery(el, sel) {
  try { return el.querySelector(sel); } catch { return null; }
}
function safeClosest(el, sel) {
  try { return el.closest(sel); } catch { return null; }
}
function safeQueryAll(el, sel) {
  try { return Array.from(el.querySelectorAll(sel)); } catch { return []; }
}

/** True when `el` is, contains, or sits inside something matching `css`. */
const touches = (el, css) => safeMatches(el, css) || safeQuery(el, css) !== null || safeClosest(el, css) !== null;

// ---- ads -------------------------------------------------------------------------------------------------------------

/** (map, group) -> { combined, list, combinedOk } of the map's protected selectors. Cached per map object (maps are immutable data). */
const groupCache = new WeakMap();

function groupSelectors(map, group) {
  if (map === null || typeof map !== 'object') return { combined: '', list: [], combinedOk: null };
  let byGroup = groupCache.get(map);
  if (!byGroup) { byGroup = new Map(); groupCache.set(map, byGroup); }
  let entry = byGroup.get(group);
  if (!entry) {
    const raw = map.protected && Array.isArray(map.protected[group]) ? map.protected[group] : [];
    const list = raw.filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim());
    entry = { combined: list.join(','), list, combinedOk: null };
    byGroup.set(group, entry);
  }
  return entry;
}

/** True when `el` is, contains, or sits inside something matching one of the entries. */
function touchesGroup(el, entry) {
  // One combined query is far cheaper than ~50; if this engine rejects the combined list (one bad entry), go one by one.
  if (entry.combinedOk !== false) {
    try {
      const hit = el.matches(entry.combined) || el.querySelector(entry.combined) !== null || el.closest(entry.combined) !== null;
      entry.combinedOk = true;
      return hit;
    } catch {
      entry.combinedOk = false;
    }
  }
  return entry.list.some((sel) => touches(el, sel));
}

const adishToken = (token) => {
  if (!token) return false;
  const lower = token.toLowerCase();
  return AD_WORD.test(lower) || AD_FRAGMENT.test(lower) || AD_CAMEL.test(token);
};

/** Tag name or any class token of one element looks like an ad's. */
function adishNode(n) {
  if (adishToken(n.localName || '')) return true;
  const list = n.classList;
  if (list && typeof list[Symbol.iterator] === 'function') for (const c of list) if (adishToken(c)) return true;
  return false;
}

/** An anchor that leaves youtube.com, goes through an ad redirect path, or carries an ad click parameter. */
function advertisingLink(a, el) {
  const abs = absolute(attr(a, 'href'), el);
  if (!abs) return false;           // javascript:, mailto:, empty: not a destination
  try {
    const u = new URL(abs);
    if (!YOUTUBE_HOST.test(u.hostname) && u.hostname !== 'youtu.be') return true;
    if (AD_PATH.test(u.pathname)) return true;
    return AD_PARAMS.some((p) => u.searchParams.has(p));
  } catch {
    return true;
  }
}

/**
 * Evidence that a tile is an ad that does not depend on any selector-map marker: an off-site or ad-redirect link anywhere in it,
 * or an ad-shaped tag/class on it, below it or on one of its nearest ancestors.
 */
function adEvidence(el) {
  try {
    if (adishNode(el)) return true;
    let up = el.parentElement;
    for (let i = 0; up && i < MAX_ANCESTORS; i++, up = up.parentElement) if (adishNode(up)) return true;
    for (const n of safeQueryAll(el, '*').slice(0, MAX_DESCENDANTS)) if (adishNode(n)) return true;
    const anchors = safeQueryAll(el, 'a[href]').slice(0, MAX_ANCHORS);
    if (el.localName === 'a' && el.hasAttribute('href')) anchors.push(el);
    return anchors.some((a) => advertisingLink(a, el));
  } catch {
    return true;                    // cannot judge: not mirrorable
  }
}

/**
 * True when the element is an ad, holds an ad, or sits inside one: a `protected.ads` marker, or marker-independent evidence (an
 * off-site or ad-redirect link, ad-shaped names; see the top of this file).
 * Fails CLOSED: a map without a usable ad list makes every element an "ad", so nothing is mirrored or collapsed on a map we
 * cannot protect (section 6).
 * @param {Element} el
 * @param {object} map  selector map (reads `protected.ads` only)
 */
export function isAdTile(el, map) {
  if (!isElement(el)) return false;
  const ads = groupSelectors(map, 'ads');
  if (ads.list.length === 0) return true;
  return touchesGroup(el, ads) || adEvidence(el);
}

/** A sponsorship disclosure (`protected.sponsor`) in, on or around the element. Not an ad, but a card could not show it. */
function holdsSponsor(el, map) {
  const sponsor = groupSelectors(map, 'sponsor');
  return sponsor.list.length > 0 && touchesGroup(el, sponsor);
}

// ---- field lookup ----------------------------------------------------------------------------------------------------

/** map lists for a role: the map's own tileFields entry (or role), else the built-in fallback. */
function fieldSelectors(selectors, role) {
  const m = selectors && typeof selectors.map === 'function' ? selectors.map() : null;
  const fieldName = role.replace(/^tile/, '').toLowerCase();
  const fromFields = m && m.tileFields && Array.isArray(m.tileFields[fieldName]) ? m.tileFields[fieldName] : [];
  return fromFields.filter((s) => typeof s === 'string' && s.trim() !== '');
}

/** First element for a field: the role via selectors.find, then the map's tileFields lists, then the built-in fallback. */
function findField(selectors, role, root) {
  let hit = null;
  try { hit = selectors.find(role, root); } catch { hit = null; }
  if (hit) return hit;
  for (const sel of [...fieldSelectors(selectors, role), ...(FALLBACK[role] || [])]) {
    hit = safeQuery(root, sel);
    if (hit) return hit;
  }
  return null;
}

/** All matches for a field: first non-empty selector wins, same rule as selectors.findAll. */
function findFieldAll(selectors, role, root) {
  let hits = [];
  try { hits = selectors.findAll(role, root); } catch { hits = []; }
  if (hits.length) return hits;
  for (const sel of [...fieldSelectors(selectors, role), ...(FALLBACK[role] || [])]) {
    hits = safeQueryAll(root, sel);
    if (hits.length) return hits;
  }
  return [];
}

/** Absolute http(s) URL of a raw href, or ''. Query string and fragment are kept exactly. */
function absolute(raw, el) {
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const doc = el.ownerDocument;
  const base = (doc && doc.baseURI) || 'https://www.youtube.com/';
  try {
    const u = new URL(raw.trim(), base);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : '';
  } catch {
    return '';
  }
}

/**
 * A plain watch link on this origin: `/watch` with a v parameter of exactly 11 id characters. Anything else (another host, a
 * playlist-only link, a redirect, an odd id) is not what an organic feed tile's main link looks like, so it is not mirrored.
 */
function isOrganicWatchLink(url, el) {
  try {
    const doc = el.ownerDocument;
    let own = '';
    try { own = new URL((doc && doc.baseURI) || 'https://www.youtube.com/').origin; } catch { own = ''; }
    const sameOrigin = own && own !== 'null' ? url.origin === own : OWN_HOST.test(url.hostname);
    return sameOrigin && url.pathname === '/watch' && VIDEO_ID.test(url.searchParams.get('v') || '');
  } catch {
    return false;
  }
}

/** The watch URL a tile links to, or null. Must be a /watch page on YouTube (Shorts, channels and off-site ads are not). */
function watchUrl(raw, el) {
  const href = absolute(raw, el);
  if (!href) return null;
  try {
    const u = new URL(href);
    const doc = el.ownerDocument;
    let own = '';
    try { own = new URL((doc && doc.baseURI) || 'https://www.youtube.com/').origin; } catch { own = ''; }
    const onYoutube = u.origin === own || YOUTUBE_HOST.test(u.hostname);
    if (!onYoutube || !/^\/watch(?:\/|$)/.test(u.pathname)) return null;
    return u;
  } catch {
    return null;
  }
}

function findLink(selectors, el) {
  const candidates = [findField(selectors, 'tileLink', el)];
  // Last resorts: the title anchor, then any anchor that resolves to a /watch URL (covers absolute hrefs).
  const title = findField(selectors, 'tileTitle', el);
  if (title) candidates.push(title.tagName === 'A' ? title : safeQuery(title, 'a[href]'));
  candidates.push(...safeQueryAll(el, 'a[href]').slice(0, 12));
  for (const a of candidates) {
    if (!a) continue;
    const url = watchUrl(attr(a, 'href'), el);
    if (url) return { a, url };
  }
  return null;
}

function titleOf(selectors, el) {
  const node = findField(selectors, 'tileTitle', el);
  if (!node) return '';
  // Visible text first (the h3[title] attribute can be shortened by the page), then the attributes YouTube mirrors it into.
  return textOf(node) || clean(attr(node, 'title')) || clean(attr(node, 'aria-label')) || clean(attr(safeClosest(node, 'h3[title]') || node, 'title'));
}

function thumbOf(selectors, el) {
  const img = findField(selectors, 'tileThumb', el);
  if (!img) return '';
  const src = attr(img, 'src').trim();
  // A data: URI is a lazy-load placeholder, not the thumbnail.
  return src && !/^data:/i.test(src) ? absolute(src, el) : '';
}

/**
 * Current thumbnail URL of a tile, '' while the page has not lazy-loaded it. Cheap enough to call again when a mutation says
 * the image changed (the home layout uses it to fill in thumbnails late).
 */
export function readThumb(el, selectors) {
  try {
    return isElement(el) && selectors ? thumbOf(selectors, el) : '';
  } catch {
    return '';
  }
}

/**
 * Reads one tile.
 * @param {Element} el  a tile root: ytd-rich-item-renderer, yt-lockup-view-model, ytd-video-renderer, ytd-rich-grid-media...
 * @param {{find:Function, findAll:Function, map:Function}} selectors  from createSelectors()
 * @returns {{href:string,title:string,thumb:string,duration:string,channel:string,meta:string[],videoId:string}|null}
 *   `href` is absolute and keeps the original query string (history and recommendations depend on it). `thumb` is '' until the
 *   page lazy-loads the image. `meta` is every metadata text in order; `channel` is the channel text when the shape has one
 *   (home, watch-related, playlist rows, legacy renderers), else ''. A non-enumerable `el` property is the element passed in.
 */
export function extractTile(el, selectors) {
  try {
    if (!isElement(el) || !selectors || typeof selectors.find !== 'function') return null;
    const map = typeof selectors.map === 'function' ? selectors.map() : null;
    // The cell that holds the lockup is judged too: an ad's extra link or label may sit beside the lockup, not inside it.
    const richCss = typeof selectors.css === 'function' ? selectors.css('richItem') : '';
    const cell = (richCss && safeClosest(el, richCss)) || el;
    if (isAdTile(el, map) || (cell !== el && isAdTile(cell, map)) || holdsSponsor(el, map)) return null;
    if (touches(el, NOT_A_VIDEO)) return null;
    if (touches(el, SHORTS)) return null;
    // A tile nested inside a Shorts shelf or reel shelf is not a feed video either.
    const shelf = selectors.css ? selectors.css('shortsShelf') : '';
    if (shelf && safeClosest(el, shelf)) return null;

    const link = findLink(selectors, el);
    if (!link || !isOrganicWatchLink(link.url, el)) return null;
    const title = titleOf(selectors, el);
    if (!title) return null;

    const meta = findFieldAll(selectors, 'tileMeta', el).map(textOf).filter(Boolean);
    const channelEl = findField(selectors, 'tileChannel', el);
    const tile = {
      href: link.url.href,
      title,
      thumb: thumbOf(selectors, el),
      duration: textOf(findField(selectors, 'tileDuration', el)),
      channel: textOf(channelEl),
      meta,
      videoId: link.url.searchParams.get('v'),
    };
    // Non-enumerable: the element the data came from and its watch anchor (home.js needs both; deepEqual on a tile ignores them).
    Object.defineProperty(tile, 'el', { value: el, enumerable: false });
    Object.defineProperty(tile, 'linkEl', { value: link.a, enumerable: false });
    return tile;
  } catch {
    return null;
  }
}

/**
 * Every real video tile under `container`, in document order. Skips ads, playlist/collection lockups, Shorts items and anything
 * without a /watch link and a title. All tile shapes of the map are searched together (a search page mixes
 * ytd-video-renderer with yt-lockup-view-model), and a tile nested in another counts once.
 * @param {Element|Document|DocumentFragment} container
 * @param {{find:Function, findAll:Function, css:Function, map:Function}} selectors
 */
export function collectTiles(container, selectors) {
  const out = [];
  try {
    if (!container || typeof container.querySelectorAll !== 'function' || !selectors) return out;
    let css = '';
    try { css = selectors.css('videoTile'); } catch { css = ''; }
    if (!css) css = FALLBACK.videoTile.join(',');
    let last = null;
    for (const el of safeQueryAll(container, css)) {
      if (last && last.contains(el)) continue;
      const tile = extractTile(el, selectors);
      if (!tile) continue;
      last = el;
      out.push(tile);
    }
  } catch {
    return out;
  }
  return out;
}
