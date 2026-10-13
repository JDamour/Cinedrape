// Home layout: a hero banner and horizontal rows built from the tiles YouTube already drew (ARCHITECTURE.md sections 4 and 6).
//
// What it does, in order of importance:
//  1. Reads real tiles through tiles.js and puts them into Cinedrape's own cards: div.cd-home > div.cd-hero? + div.cd-row*.
//     Every card is a real <a href> carrying the tile's own URL, so middle-click and copy-link work, and a plain click is
//     handed to the original tile's own link, so YouTube navigates in-page and its history and recommendations see the click.
//  2. Collapses ONLY the source tiles it mirrored (attribute SRC_ATTR, one safeHide-guarded rule, see buildHomeLayoutCss).
//     It never touches the grid, ad items, shelves, or the continuation item, so infinite scroll keeps loading: the
//     continuation stays in layout under the mirrored rows and new tiles are appended as they arrive.
//  3. Is all-or-nothing. mount() builds every node in memory first and touches the page only if at least one card exists;
//     any exception rolls back and reports through onFail; unmount() restores the original DOM exactly.
//
// Live tiles: extractTile flags them from the badge (isLive), cards show a red LIVE pill instead of the duration pill, the
// viewer count carries a live dot, and hero-rows puts a live stream in the hero with a "Watch live" call to action.
//
// It never removes, moves, re-parents or clones YouTube nodes. The only writes to YouTube's DOM are the SRC_ATTR attribute on
// tiles that were mirrored, and one inserted element (div.cd-home) right before the grid's #contents, i.e. after the chip bar
// and the masthead ad slot and above YouTube's own list (where every ad item, which is never mirrored, stays visible).
//
// Thumbnails: YouTube only gives a tile its image URL when the tile is near the viewport (measured live, 27 of 29 tiles on a
// channel grid had an <img> with no src), and a collapsed tile is never near it. So a card whose tile has no src yet shows the
// public i.ytimg.com image for its video id, and swaps to the tile's own src if one ever appears (attribute observer).
import { SRC_ATTR, ATTR } from '../../shared/constants.js';
import { safeHide } from '../../shared/selector-map.js';
import { extractTile, readThumb } from './tiles.js';
import { normalizeDensity, rowVisibleForDensity, rowChunkForDensity, isFeatureDisabled, roleEntries, carriesAdGuard } from './density.js';

const FEATURE = 'layout-home';
const MODES = Object.freeze(['rows', 'hero-rows']);
const ROW_TITLE_FIRST = 'Recommended';
const ROW_TITLE_NEXT = 'More to watch';
const ROW_TITLE_LIVE = 'Live now';
const HERO_CTA = 'Watch';
const HERO_CTA_LIVE = 'Watch live';
const ROW_WRAPPER = 'ytd-rich-grid-row';
const DRAG_THRESHOLD = 6;
const HAND_OFF_FALLBACK_MS = 1200;
const GLYPH_PREV = String.fromCharCode(0x2039);
const GLYPH_NEXT = String.fromCharCode(0x203a);
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
let instances = 0;
// i.ytimg.com serves a 120px-wide grey placeholder (status 200) for sizes a video does not have.
const PLACEHOLDER_MAX_WIDTH = 120;

/** Public thumbnail URL for a video id (no query, no API), '' when the id is not a normal 11-character id. */
function derivedThumb(videoId, kind) {
  return VIDEO_ID.test(videoId) ? `https://i.ytimg.com/vi/${videoId}/${kind}.jpg` : '';
}

// ---- CSS -------------------------------------------------------------------------------------------------------------

const ads = (map) => (map && map.protected && Array.isArray(map.protected.ads) ? map.protected.ads.filter((s) => typeof s === 'string' && s.trim() !== '') : []);

/**
 * Stylesheet for the home layout. '' when the mode is `grid` or the feature is switched off.
 *
 * The only hiding rule collapses a mirrored source tile: `[cd-source]` below the grid contents, with the ad guard
 * (safeHide) AND an explicit "is not itself an ad" narrowing, since the guard only looks at descendants. Everything else is
 * the look of the cards, written against --cd-* variables with fallbacks and at zero specificity (`:where(html[cd-theme])`)
 * so a theme's own CSS, which is injected last, wins every tie. No visibility, opacity, clip, filter or zero-size declaration.
 * @param {object} map
 * @param {{home?:string, disabled?:string[]}} cfg  EffectiveConfig
 */
export function buildHomeLayoutCss(map, cfg) {
  if (isFeatureDisabled(cfg, FEATURE)) return '';
  if (!cfg || !MODES.includes(cfg.home)) return '';
  const out = [];

  const contents = roleEntries(map, 'homeGridContents');
  const adList = ads(map);
  if (contents.length && adList.length) {
    const scope = contents.length === 1 ? contents[0] : `:is(${contents.join(',')})`;
    const subject = `html[cd-theme]:not([${ATTR.offPrefix}${FEATURE}]) ${scope} [${SRC_ATTR}]:not(:is(${adList.join(',')}))`;
    let guarded = '';
    try { guarded = safeHide(map, subject); } catch { guarded = ''; }
    // Fail closed: only emit a hide rule that really carries the guard.
    if (carriesAdGuard(map, subject, guarded)) {
      out.push(`/* home: collapse tiles that were mirrored into cd-rows (never the grid, ads or the continuation) */\n${guarded}{display:none !important}`);
    }
  }

  const S = ':where(html[cd-theme])';
  const sp = 'var(--cd-space,6px)';
  const rule = (sel, decl) => out.push(`${sel.split(',').map((x) => `${S} ${x.trim()}`).join(',')}{${decl}}`);
  const ring = 'outline:2px solid var(--cd-accent,#3ea6ff);outline-offset:2px';

  rule('.cd-home', `display:block;box-sizing:border-box;align-self:stretch;width:100%;min-width:0;margin:0;padding:calc(${sp} * 3) 0 calc(${sp} * 2);`
    + 'color:var(--cd-text,inherit);font-family:var(--cd-font-family,inherit);font-size:var(--cd-font-size,14px);line-height:1.4');

  // Hero. The text sits on a panel painted with the theme's own scrim colour, so contrast never depends on the picture.
  rule('.cd-hero', 'position:relative;margin:0 0 var(--cd-row-gap,30px);overflow:hidden;border-radius:calc(var(--cd-radius,12px) * 1.4);background:var(--cd-surface,#212121)');
  rule('.cd-hero-link', 'display:block;position:relative;color:inherit;text-decoration:none;border-radius:inherit');
  rule('.cd-hero-link:focus-visible', ring);
  // width:100% is required: with width:auto, Chrome transfers max-height through aspect-ratio into a max-width, so on a short
  // viewport the media shrank to 21:9 of the capped height and left an empty band on the right of the hero.
  rule('.cd-hero-media', 'display:block;position:relative;box-sizing:border-box;width:100%;aspect-ratio:21 / 9;min-height:200px;max-height:min(62vh,600px);background:var(--cd-surface,#212121)');
  rule('.cd-hero-media img', 'position:absolute;left:0;top:0;width:100%;height:100%;object-fit:cover;display:block');
  rule('.cd-hero-body', `position:absolute;left:calc(${sp} * 3);bottom:calc(${sp} * 3);display:block;box-sizing:border-box;`
    + `max-width:min(38em,calc(100% - ${sp} * 6));padding:calc(${sp} * 3);border-radius:var(--cd-radius,12px);`
    + 'background:var(--cd-scrim,rgba(15,15,15,.8));color:var(--cd-text,#f1f1f1)');
  rule('.cd-hero-title', 'display:block;margin:0 0 .3em;font-size:1.9em;line-height:1.15;font-weight:var(--cd-heading-weight,700);color:var(--cd-text,inherit)');
  rule('.cd-hero-meta', 'display:block;margin:0 0 .9em;color:var(--cd-muted,#aaa)');
  rule('.cd-hero-cta', 'display:inline-block;padding:.5em 1.3em;border-radius:var(--cd-radius,12px);background:var(--cd-accent,#3ea6ff);color:var(--cd-accent-text,#000);font-weight:600');

  // Rows.
  rule('.cd-row', 'position:relative;margin:0 0 var(--cd-row-gap,30px)');
  rule('.cd-row-title', `margin:0 0 calc(${sp} * 2);padding-right:calc(${sp} * 14);font-size:1.45em;line-height:1.2;font-weight:var(--cd-heading-weight,700);color:var(--cd-text,inherit)`);
  rule('.cd-row-track', 'display:flex;flex-wrap:nowrap;gap:var(--cd-gap,16px);margin:0;padding:6px 4px 14px;overflow-x:auto;overflow-y:hidden;'
    + 'scroll-snap-type:x proximity;scroll-padding:0 4px;overscroll-behavior-x:contain;scrollbar-width:thin;scrollbar-color:var(--cd-border,#717171) transparent');
  rule('.cd-row-prev,.cd-row-next', 'position:absolute;top:-4px;box-sizing:border-box;width:34px;height:34px;margin:0;padding:0;'
    + 'border:1px solid var(--cd-border,#717171);border-radius:50%;background:var(--cd-surface,#212121);color:var(--cd-text,#f1f1f1);'
    + 'font:inherit;font-size:20px;line-height:30px;text-align:center;cursor:pointer');
  rule('.cd-row-prev', 'right:40px');
  rule('.cd-row-next', 'right:0');
  rule('.cd-row-prev:hover,.cd-row-next:hover', 'border-color:var(--cd-accent,#3ea6ff)');
  rule('.cd-row-prev:focus-visible,.cd-row-next:focus-visible', ring);
  rule('.cd-row-prev[aria-disabled="true"],.cd-row-next[aria-disabled="true"]', 'color:var(--cd-muted,#717171);cursor:default;border-color:var(--cd-border,#717171)');

  // Cards. Width = an even share of the row for the density's visible count, never below the density's minimum.
  rule('.cd-card', 'box-sizing:border-box;display:flex;flex-direction:column;'
    + 'flex:0 0 max(var(--cd-card-min,190px), calc((100% - (var(--cd-row-visible,6) - 1) * var(--cd-gap,16px)) / var(--cd-row-visible,6)));'
    + 'min-width:0;color:var(--cd-text,inherit);text-decoration:none;border-radius:var(--cd-radius,12px);scroll-snap-align:start');
  rule('.cd-card:focus-visible', ring);
  rule('.cd-card-thumb', 'position:relative;display:block;aspect-ratio:16 / 9;overflow:hidden;border-radius:var(--cd-radius,12px);background:var(--cd-surface,#212121);'
    + 'transition:box-shadow var(--cd-duration,160ms) ease');
  rule('.cd-card-thumb img', 'display:block;width:100%;height:100%;object-fit:cover');
  rule('.cd-card-duration', 'position:absolute;right:6px;bottom:6px;padding:1px 6px;border-radius:4px;background:rgba(0,0,0,.82);color:#fff;font-size:.85em;font-weight:600;line-height:1.5');
  // Live badge (a live tile's duration field holds the localized badge text): a red pill that reads on both YouTube modes.
  // #cc0000 with white text is 5.9:1; the pulsing dot scales instead of fading because this sheet contains no opacity at all.
  rule('.cd-live-badge', 'display:inline-flex;align-items:center;gap:.45em;padding:1px 7px;border-radius:4px;background:#cc0000;color:#fff;'
    + 'font-size:max(.85em,11px);font-weight:700;line-height:1.5;letter-spacing:.06em;text-transform:uppercase');
  rule('.cd-card-thumb .cd-live-badge', 'position:absolute;right:6px;bottom:6px');
  rule('.cd-live-dot', 'display:inline-block;flex:none;width:.45em;height:.45em;border-radius:50%;background:#ff5249');
  rule('.cd-live-badge .cd-live-dot', 'background:#fff');
  rule('.cd-card-watching', 'display:inline-flex;align-items:center;gap:.4em;font-weight:600');
  rule('.cd-hero-live', 'margin:0 0 .6em');
  rule('.cd-row[cd-live] .cd-row-title', 'display:flex;align-items:center;gap:.45em');
  // The dot pulses unless the user turned animations off (the reduced-motion media block below is the second gate).
  if (cfg.animations !== false) {
    rule('.cd-live-badge .cd-live-dot', 'animation:cd-live-pulse 1.6s ease-in-out infinite');
    rule('.cd-row[cd-live] .cd-live-dot', 'animation:cd-live-pulse 1.6s ease-in-out infinite');
    out.push('@keyframes cd-live-pulse{0%,100%{transform:scale(1)}50%{transform:scale(.55)}}');
  }
  rule('.cd-card-body', `display:block;padding:calc(${sp} * 1.5) ${sp}`);
  rule('.cd-card-title', 'display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;line-clamp:2;overflow:hidden;'
    + 'font-weight:600;line-height:1.3;overflow-wrap:anywhere;color:var(--cd-text,inherit)');
  // max() keeps the metadata legible on small-base themes (Classic is 13px) instead of scaling below a readable floor.
  rule('.cd-card-meta', 'display:block;margin-top:.3em;font-size:max(.9em,12px);color:var(--cd-muted,#aaa)');
  rule('.cd-card-meta > span:not(:first-child)::before,.cd-hero-meta > span:not(:first-child)::before', 'content:"\\2022";margin:0 .4em');
  rule('.cd-card:hover .cd-card-title', 'text-decoration:underline');

  out.push(`@media (max-width:700px){\n${S} .cd-hero-body{position:static;max-width:none;border-radius:0}\n${S} .cd-hero-title{font-size:1.5em}\n}`);
  out.push(`@media (prefers-reduced-motion:reduce){\n${S} .cd-card-thumb{transition:none}\n${S} .cd-live-badge .cd-live-dot{animation:none}\n${S} .cd-row[cd-live] .cd-live-dot{animation:none}\n}`);
  return `${out.join('\n')}\n`;
}

// ---- small helpers ---------------------------------------------------------------------------------------------------

const matches = (el, sel) => { try { return !!sel && el.matches(sel); } catch { return false; } };

/** Splits the metadata into the parts a card shows: channel, then the rest with the view count marked. On a live tile the
 *  last text is the viewer count ("591 watching", viewers last even on collab rows), marked so it can carry the live dot. */
function metaParts(tile) {
  const parts = [];
  const channel = tile.channel;
  const rest = channel && tile.meta[0] === channel ? tile.meta.slice(1) : tile.meta.slice();
  if (channel) parts.push({ cls: 'cd-card-channel', text: channel });
  // [views, age] -> views first; [x, views, age] (collab channels) -> second to last; a lone text is the view count / status.
  const viewsAt = rest.length >= 2 ? rest.length - 2 : 0;
  rest.forEach((text, i) => parts.push({ cls: i === viewsAt ? 'cd-card-views' : 'cd-card-info', text }));
  if (tile.isLive && parts.length && parts[parts.length - 1].cls !== 'cd-card-channel') {
    parts[parts.length - 1].cls = 'cd-card-watching';
  }
  return parts;
}

/**
 * @param {{doc:Document, win:Window, selectors:object, map?:object, getConfig?:()=>object, onFail?:(reason:string)=>void,
 *   navigate?:(url:string)=>void, handOffFallbackMs?:number}} deps  navigate / handOffFallbackMs are for tests
 * @returns {{mount():boolean, update():void, unmount():void, isMounted():boolean}}
 */
export function createHomeLayout(deps) {
  const { doc, win, selectors, getConfig, onFail } = deps || {};
  if (!doc || !win || !selectors || typeof selectors.find !== 'function') throw new TypeError('createHomeLayout({doc, win, selectors}) needs a document, a window and selectors');
  // The mark's value names the instance that set it, so a dead or replaced instance can never strip a live instance's marks.
  const token = `${Date.now().toString(36)}${(instances += 1).toString(36)}`;
  const navigate = typeof deps.navigate === 'function' ? deps.navigate : (url) => win.location.assign(url);
  const fallbackMs = Number.isFinite(deps.handOffFallbackMs) ? deps.handOffFallbackMs : HAND_OFF_FALLBACK_MS;

  const state = {
    mounted: false, root: null, contents: null, host: null,
    entries: [], byKey: new Map(), byWrapper: new Map(), byLink: new WeakMap(),
    mode: '', density: 0, uid: 0, liveRowKeys: '',
    mo: null, thumbMo: null, ro: null, raf: 0, navRaf: 0,
    drag: null, justDragged: false,
  };

  const cfg = () => {
    try { return (typeof getConfig === 'function' && getConfig()) || {}; } catch { return {}; }
  };
  const wantedMode = () => {
    const c = cfg();
    if (isFeatureDisabled(c, FEATURE)) return 'grid';
    return MODES.includes(c.home) ? c.home : 'grid';
  };

  const el = (tag, cls, text) => {
    const n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  };

  // ---- motion ----------------------------------------------------------------------------------------------------------

  function reducedMotion() {
    try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }
  const behavior = () => (reducedMotion() || cfg().animations === false ? 'auto' : 'smooth');
  function isRtl(node) {
    try { return win.getComputedStyle(node).direction === 'rtl'; } catch { return false; }
  }
  const frame = (fn) => (typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame(fn) : win.setTimeout(fn, 16));
  const unframe = (id) => (typeof win.cancelAnimationFrame === 'function' ? win.cancelAnimationFrame(id) : win.clearTimeout(id));

  // ---- building nodes (nothing here touches the page) ------------------------------------------------------------------

  function metaNode(tag, cls, tile) {
    const node = el(tag, cls);
    for (const p of metaParts(tile)) {
      const span = el('span', p.cls);
      if (p.cls === 'cd-card-watching') {
        span.append(liveDot(), el('span', null, p.text));
      } else {
        span.textContent = p.text;
      }
      node.append(span);
    }
    return node;
  }

  /** The red dot of a live badge. aria-hidden: the badge text already says it. */
  function liveDot() {
    const d = el('span', 'cd-live-dot');
    d.setAttribute('aria-hidden', 'true');
    return d;
  }

  /** The localized live badge text with its dot ('LIVE' in English UI). */
  function liveBadge(text) {
    const b = el('span', 'cd-live-badge');
    b.append(liveDot(), el('span', null, text || 'LIVE'));
    return b;
  }

  function imageNode(src, fallback) {
    const img = el('img');
    img.setAttribute('alt', '');
    img.setAttribute('decoding', 'async');
    img.setAttribute('draggable', 'false');
    if (src) img.setAttribute('src', src);
    if (fallback) img.setAttribute('cd-fallback', fallback);
    return img;
  }

  function buildCard(entry) {
    const t = entry.tile;
    const a = el('a', 'cd-card');
    a.setAttribute('href', t.href);
    if (t.videoId) a.setAttribute('cd-video', t.videoId);
    if (t.isLive) a.setAttribute('cd-live', '');
    const thumb = el('span', 'cd-card-thumb');
    const img = imageNode(t.thumb || derivedThumb(t.videoId, 'hqdefault'));
    img.setAttribute('loading', 'lazy');
    thumb.append(img);
    if (t.isLive) thumb.append(liveBadge(t.duration));
    else if (t.duration) thumb.append(el('span', 'cd-card-duration', t.duration));
    const body = el('span', 'cd-card-body');
    body.append(el('span', 'cd-card-title', t.title), metaNode('span', 'cd-card-meta', t));
    a.append(thumb, body);
    entry.card = a;
    state.byLink.set(a, entry);
    return a;
  }

  function buildHero(entry) {
    const t = entry.tile;
    const wrap = el('div', 'cd-hero');
    if (t.isLive) wrap.setAttribute('cd-live', '');
    const a = el('a', 'cd-hero-link');
    a.setAttribute('href', t.href);
    if (t.videoId) a.setAttribute('cd-video', t.videoId);
    const media = el('span', 'cd-hero-media');
    // The 720p image is missing for some older videos: the placeholder is detected on load and swapped for hqdefault.
    media.append(t.thumb ? imageNode(t.thumb) : imageNode(derivedThumb(t.videoId, 'hq720'), derivedThumb(t.videoId, 'hqdefault')));
    const body = el('span', 'cd-hero-body');
    if (t.isLive) body.append(liveBadge(t.duration));
    body.append(el('h2', 'cd-hero-title', t.title), metaNode('span', 'cd-hero-meta', t),
      el('span', 'cd-hero-cta', t.isLive ? HERO_CTA_LIVE : HERO_CTA));
    a.append(media, body);
    wrap.append(a);
    entry.heroEl = wrap;
    state.byLink.set(a, entry);
    return wrap;
  }

  function buildLiveRow() {
    state.uid += 1;
    const id = state.uid;
    const row = el('div', 'cd-row');
    row.id = 'cd-row-live';
    row.setAttribute('cd-live', '');
    row.setAttribute('role', 'group');
    const title = el('h2', 'cd-row-title');
    title.id = `cd-row-title-${id}`;
    row.setAttribute('aria-labelledby', title.id);
    title.append(liveDot(), doc.createTextNode(ROW_TITLE_LIVE));
    const track = el('div', 'cd-row-track');
    track.id = `cd-row-track-${id}`;
    const nav = (cls, label, glyph) => {
      const b = el('button', cls);
      b.setAttribute('type', 'button');
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-controls', track.id);
      const g = el('span', null, glyph);
      g.setAttribute('aria-hidden', 'true');
      b.append(g);
      return b;
    };
    row.append(title, nav('cd-row-prev', 'Scroll left', GLYPH_PREV), nav('cd-row-next', 'Scroll right', GLYPH_NEXT), track);
    return { row, track };
  }

  function buildRow(index) {
    state.uid += 1;
    const id = state.uid;
    const row = el('div', 'cd-row');
    row.setAttribute('role', 'group');
    const title = el('h2', 'cd-row-title', index === 0 ? ROW_TITLE_FIRST : ROW_TITLE_NEXT);
    title.id = `cd-row-title-${id}`;
    row.setAttribute('aria-labelledby', title.id);
    const track = el('div', 'cd-row-track');
    track.id = `cd-row-track-${id}`;
    const nav = (cls, label, glyph) => {
      const b = el('button', cls);
      b.setAttribute('type', 'button');
      b.setAttribute('aria-label', label);
      b.setAttribute('aria-controls', track.id);
      const g = el('span', null, glyph);
      g.setAttribute('aria-hidden', 'true');
      b.append(g);
      return b;
    };
    row.append(title, nav('cd-row-prev', 'Scroll left', GLYPH_PREV), nav('cd-row-next', 'Scroll right', GLYPH_NEXT), track);
    return { row, track };
  }

  const cardsOf = (track) => Array.from(track.children).filter((c) => c.classList && c.classList.contains('cd-card'));

  /** Roving tabindex: one tab stop per row, arrows move inside it. */
  function setActive(track, card) {
    for (const c of cardsOf(track)) c.setAttribute('tabindex', c === card ? '0' : '-1');
  }

  /** Gives a track exactly one tab stop (the first card) when moving cards left it without one. */
  function ensureTabStop(track) {
    const cards = cardsOf(track);
    if (cards.length && !cards.some((c) => c.getAttribute('tabindex') === '0')) cards[0].setAttribute('tabindex', '0');
  }

  /**
   * Puts `entries` into rows, always continuing the last row. A row only splits once it holds `chunk + visible` cards, and the
   * cards past `chunk` move to a new row, so every row but a lone first one shows at least a full screen (`visible`) of cards
   * and the page never ends on a 1- or 2-card stub with an empty band beside it. Returns how many cards were added.
   */
  function place(rootEl, entries, chunk, visible) {
    let added = 0;
    let rows = rootEl.querySelectorAll('.cd-row:not([cd-live])').length;
    const lastEl = rootEl.lastElementChild;
    let track = lastEl && lastEl.classList.contains('cd-row') && !lastEl.hasAttribute('cd-live') ? lastEl.querySelector('.cd-row-track') : null;
    const limit = chunk + Math.max(1, visible || 1) - 1;
    for (const entry of entries) {
      if (!track) {
        const r = buildRow(rows);
        rows += 1;
        rootEl.append(r.row);
        track = r.track;
      }
      const card = buildCard(entry);
      card.setAttribute('tabindex', cardsOf(track).length === 0 ? '0' : '-1');
      track.append(card);
      added += 1;
      const cards = cardsOf(track);
      if (cards.length > limit) {
        const r = buildRow(rows);
        rows += 1;
        rootEl.append(r.row);
        for (const moved of cards.slice(chunk)) { moved.setAttribute('tabindex', '-1'); r.track.append(moved); }
        ensureTabStop(track);
        ensureTabStop(r.track);
        track = r.track;
      }
    }
    return added;
  }

  const liveKey = (list) => list.map((e) => e.tile.videoId || e.key).join(',');

  function getLiveRowEntries(entries, mode) {
    if (!MODES.includes(mode)) return [];
    const live = entries.filter((e) => !e.dup);
    const allLive = live.filter((e) => e.tile.isLive);
    if (allLive.length < 2) return [];
    let rest = live;
    if (mode === 'hero-rows') {
      const usable = (e) => e.tile.thumb || VIDEO_ID.test(e.tile.videoId || '');
      const hero = live.find((e) => e.tile.isLive && usable(e))
        || live.find((e) => e.tile.thumb)
        || live.find((e) => VIDEO_ID.test(e.tile.videoId));
      if (hero) rest = live.filter((e) => e !== hero);
    }
    return rest.filter((e) => e.tile.isLive);
  }

  /** Fills `rootEl` for `entries`. The nodes stay detached; entries get their card / hero node. Returns the cards built. */
  function buildContent(rootEl, entries, mode, density) {
    for (const e of entries) { e.card = null; e.heroEl = null; }
    const live = entries.filter((e) => !e.dup);
    let rest = live;
    let heroBuilt = 0;
    if (mode === 'hero-rows') {
      // A live stream is the strongest hero (the badge and "watching" count make the page feel live); then the first tile
      // with the page's own thumbnail; if none has loaded one yet, the first tile we can derive an image for.
      const usable = (e) => e.tile.thumb || VIDEO_ID.test(e.tile.videoId || '');
      const hero = live.find((e) => e.tile.isLive && usable(e))
        || live.find((e) => e.tile.thumb)
        || live.find((e) => VIDEO_ID.test(e.tile.videoId));
      if (hero) {
        rootEl.append(buildHero(hero));
        rest = live.filter((e) => e !== hero);
        heroBuilt = 1;
      }
    }
    const liveRowEntries = getLiveRowEntries(entries, mode);
    state.liveRowKeys = liveKey(liveRowEntries);
    let liveCardsBuilt = 0;
    if (liveRowEntries.length > 0) {
      const lr = buildLiveRow();
      rootEl.append(lr.row);
      for (const entry of liveRowEntries) {
        const card = buildCard(entry);
        card.setAttribute('tabindex', cardsOf(lr.track).length === 0 ? '0' : '-1');
        lr.track.append(card);
        liveCardsBuilt += 1;
      }
      ensureTabStop(lr.track);
    }
    const nonLiveRest = liveRowEntries.length > 0 ? rest.filter((e) => !e.tile.isLive) : rest;
    return liveCardsBuilt + place(rootEl, nonLiveRest, rowChunkForDensity(density), rowVisibleForDensity(density)) + heroBuilt;
  }

  function newRoot(mode, density) {
    const r = el('div', 'cd-home');
    r.setAttribute('cd-mode', mode);
    r.style.setProperty('--cd-row-visible', String(rowVisibleForDensity(density)));
    return r;
  }

  // ---- discovering tiles -----------------------------------------------------------------------------------------------

  function locate() {
    const contents = selectors.find('homeGridContents');
    if (!contents || !contents.parentNode || contents.parentNode.nodeType !== 1) return null;
    const grid = selectors.find('homeGrid');
    if (!grid || !grid.contains(contents)) return null;
    return { contents, host: contents.parentNode };
  }

  /** Direct rich items of the grid (also inside the old ytd-rich-grid-row wrapper). Shelves, ad slots and the continuation are not candidates. */
  function candidates(contents) {
    const richCss = (typeof selectors.css === 'function' && selectors.css('richItem')) || 'ytd-rich-item-renderer';
    const out = [];
    for (const child of Array.from(contents.children)) {
      if (matches(child, ROW_WRAPPER)) {
        try { out.push(...child.querySelectorAll(richCss)); } catch { /* unparseable selector: no candidates */ }
      } else if (matches(child, richCss)) {
        out.push(child);
      }
    }
    return out;
  }

  const rawHref = (tile) => (tile.linkEl && typeof tile.linkEl.getAttribute === 'function' ? tile.linkEl.getAttribute('href') || '' : '');

  /**
   * True when YouTube recycled the wrapper: it re-renders the feed by giving the SAME ytd-rich-item-renderer another video's data
   * (measured on the real home feed after a watch page and back: every kept wrapper changed video), so the link we read from it
   * is gone from it or points elsewhere. A card built from the old data would show one video and open another.
   */
  const isStale = (e) => {
    const a = e.tile.linkEl;
    return !a || !e.wrapper.contains(a) || (a.getAttribute('href') || '') !== e.raw;
  };

  /** Marks every entry after the first one of its video as a repeat and rebuilds the key index. */
  function reassignRepeats() {
    const seen = new Set();
    state.byKey = new Map();
    for (const e of state.entries) {
      e.dup = seen.has(e.key);
      if (!e.dup) { seen.add(e.key); state.byKey.set(e.key, e); }
    }
  }

  /** New entries for wrappers not mirrored yet. A repeated video is an entry too: it is collapsed like the others but gets no card. */
  function scan(contents) {
    const fresh = [];
    const seen = new Set(state.byKey.keys());
    for (const wrapper of candidates(contents)) {
      if (state.byWrapper.has(wrapper)) continue;
      const tile = extractTile(wrapper, selectors);
      if (!tile) continue;
      const key = tile.videoId || tile.href;
      const dup = seen.has(key);
      seen.add(key);
      fresh.push({ key, tile, wrapper, card: null, heroEl: null, dup, watched: null, raw: rawHref(tile) });
    }
    return fresh;
  }

  function register(entries) {
    for (const e of entries) {
      state.entries.push(e);
      state.byWrapper.set(e.wrapper, e);
      if (!e.dup) state.byKey.set(e.key, e);
    }
  }

  function markSources(entries) {
    for (const e of entries) {
      e.wrapper.setAttribute(SRC_ATTR, token);
      if (e.tile && e.tile.isLive) e.wrapper.setAttribute('cd-live', '');
      else e.wrapper.removeAttribute('cd-live');
    }
  }

  // ---- thumbnails that arrive late -------------------------------------------------------------------------------------

  function applyThumb(entry, src) {
    entry.tile.thumb = src;
    for (const host of [entry.card, entry.heroEl]) {
      const img = host && host.querySelector('img');
      if (!img) continue;
      img.removeAttribute('cd-fallback');
      img.setAttribute('src', src);
    }
  }

  function refreshThumbs() {
    for (const e of state.entries) {
      if (e.dup || e.tile.thumb) continue;
      const src = readThumb(e.wrapper, selectors);
      if (src) {
        applyThumb(e, src);
      } else if (state.thumbMo) {
        const img = selectors.find('tileThumb', e.wrapper);
        if (img && img !== e.watched) {
          e.watched = img;
          try { state.thumbMo.observe(img, { attributes: true, attributeFilter: ['src'] }); } catch { /* detached or odd node */ }
        }
      }
    }
  }

  function onImgLoad(e) {
    const img = e.target;
    if (!img || img.tagName !== 'IMG' || !img.hasAttribute('cd-fallback')) return;
    const fb = img.getAttribute('cd-fallback');
    img.removeAttribute('cd-fallback');
    if (img.naturalWidth > 0 && img.naturalWidth <= PLACEHOLDER_MAX_WIDTH && fb) img.setAttribute('src', fb);
  }

  // ---- row controls ----------------------------------------------------------------------------------------------------

  function updateNav(track) {
    const row = track.parentNode;
    const prev = row && row.querySelector(':scope > .cd-row-prev');
    const next = row && row.querySelector(':scope > .cd-row-next');
    if (!prev || !next) return;
    const room = track.scrollWidth - track.clientWidth;
    if (!(track.clientWidth > 0 && track.scrollWidth > 0)) { // no layout information (detached, hidden, or a test): keep the buttons usable
      for (const b of [prev, next]) { b.removeAttribute('hidden'); b.removeAttribute('aria-disabled'); }
      return;
    }
    for (const b of [prev, next]) { if (room <= 1) b.setAttribute('hidden', ''); else b.removeAttribute('hidden'); }
    const x = Math.abs(track.scrollLeft);
    prev.setAttribute('aria-disabled', String(x <= 1));
    next.setAttribute('aria-disabled', String(x >= room - 1));
  }

  function updateAllNav() {
    if (!state.root) return;
    for (const t of state.root.querySelectorAll('.cd-row-track')) updateNav(t);
  }

  function scrollRow(track, dir) {
    const sign = (isRtl(track) ? -1 : 1) * dir;
    const amount = Math.max(60, Math.round(track.clientWidth * 0.9)) * sign;
    if (typeof track.scrollBy === 'function') track.scrollBy({ left: amount, behavior: behavior() });
    else track.scrollLeft += amount;
  }

  function focusCard(track, card) {
    if (!card) return;
    setActive(track, card);
    card.focus({ preventScroll: true });
    if (typeof card.scrollIntoView === 'function') card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: behavior() });
  }

  function onKeydown(e) {
    state.justDragged = false;
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    const card = e.target && e.target.closest ? e.target.closest('.cd-card') : null;
    if (!card || !state.root || !state.root.contains(card)) return;
    const track = card.parentNode;
    const cards = cardsOf(track);
    const at = cards.indexOf(card);
    const flip = isRtl(track) ? -1 : 1;
    let to;
    switch (e.key) {
      case 'ArrowRight': to = at + flip; break;
      case 'ArrowLeft': to = at - flip; break;
      case 'Home': to = 0; break;
      case 'End': to = cards.length - 1; break;
      default: return;
    }
    e.preventDefault();
    focusCard(track, cards[Math.min(cards.length - 1, Math.max(0, to))]);
  }

  /** Opens the tile's own link so YouTube navigates in-page; a hard navigation only if YouTube did not react. */
  function handOff(link) {
    const entry = state.byLink.get(link);
    const source = entry && entry.tile.linkEl;
    if (!source || !source.isConnected || typeof source.click !== 'function') return false;
    const before = win.location.href;
    let started = false;
    const onStart = () => { started = true; };
    doc.addEventListener('yt-navigate-start', onStart, { once: true });
    source.click();
    win.setTimeout(() => {
      doc.removeEventListener('yt-navigate-start', onStart);
      if (!started && win.location.href === before) navigate(link.href);
    }, fallbackMs);
    return true;
  }

  function onClick(e) {
    if (state.justDragged) { state.justDragged = false; e.preventDefault(); e.stopPropagation(); return; }
    const target = e.target && e.target.closest ? e.target : null;
    if (!target) return;
    const btn = target.closest('.cd-row-prev, .cd-row-next');
    if (btn && state.root.contains(btn)) {
      if (btn.getAttribute('aria-disabled') === 'true') return;
      const track = btn.parentNode.querySelector('.cd-row-track');
      if (track) scrollRow(track, btn.classList.contains('cd-row-prev') ? -1 : 1);
      return;
    }
    const link = target.closest('a.cd-card, a.cd-hero-link');
    if (!link || !state.root.contains(link)) return;
    // Only a plain left click is handed over; modified clicks keep the browser's own behaviour on the real href.
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    if (handOff(link)) e.preventDefault();
  }

  function onFocusIn(e) {
    const card = e.target && e.target.closest ? e.target.closest('.cd-card') : null;
    if (card && state.root.contains(card)) setActive(card.parentNode, card);
  }

  function onScroll(e) {
    const t = e.target;
    if (t && t.classList && t.classList.contains('cd-row-track')) updateNav(t);
  }

  // Mouse drag scrolls the row. Touch and trackpads scroll natively, so only the mouse needs this.
  function onPointerDown(e) {
    state.justDragged = false;
    const track = e.target && e.target.closest ? e.target.closest('.cd-row-track') : null;
    if (!track || e.pointerType !== 'mouse' || e.button !== 0) return;
    state.drag = { track, x: e.clientX, left: track.scrollLeft, id: e.pointerId, moved: false };
  }
  function onPointerMove(e) {
    const d = state.drag;
    if (!d || e.pointerId !== d.id) return;
    const dx = e.clientX - d.x;
    if (!d.moved) {
      if (Math.abs(dx) < DRAG_THRESHOLD) return;
      d.moved = true;
      try { d.track.setPointerCapture(e.pointerId); } catch { /* not capturable: the drag still works over the row */ }
    }
    d.track.scrollLeft = d.left - dx;
    e.preventDefault();
  }
  function endDrag(e) {
    const d = state.drag;
    if (!d || (e && e.pointerId !== undefined && e.pointerId !== d.id)) return;
    state.drag = null;
    if (d.moved) {
      state.justDragged = true; // swallow the click that follows a drag so it does not open a video
      try { d.track.releasePointerCapture(d.id); } catch { /* already released */ }
    }
  }
  const onDragStart = (e) => { e.preventDefault(); };

  function wire(root) {
    root.addEventListener('keydown', onKeydown);
    root.addEventListener('click', onClick, true);
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('scroll', onScroll, { capture: true, passive: true });
    root.addEventListener('load', onImgLoad, true);
    root.addEventListener('pointerdown', onPointerDown);
    root.addEventListener('pointermove', onPointerMove);
    root.addEventListener('pointerup', endDrag);
    root.addEventListener('pointercancel', endDrag);
    root.addEventListener('dragstart', onDragStart);
  }

  // ---- observers -------------------------------------------------------------------------------------------------------

  function schedule() {
    if (state.raf || !state.mounted) return;
    state.raf = frame(() => { state.raf = 0; sync(); });
  }

  function scheduleNav() {
    if (state.navRaf || !state.mounted) return;
    state.navRaf = frame(() => { state.navRaf = 0; updateAllNav(); });
  }

  function observeGrid() {
    if (!state.mo) return;
    // href: a recycled tile can change its link in place, without any node being added or removed.
    state.mo.observe(state.contents, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] });
    // Our root disappearing from the grid host (YouTube re-rendering it) is also a reason to look again.
    state.mo.observe(state.host, { childList: true });
  }

  function startObservers() {
    if (typeof win.MutationObserver === 'function') {
      state.mo = new win.MutationObserver(schedule);
      state.thumbMo = new win.MutationObserver(schedule);
      observeGrid();
    }
    if (typeof win.ResizeObserver === 'function') {
      state.ro = new win.ResizeObserver(scheduleNav);
      state.ro.observe(state.root);
    }
  }

  function stopObservers() {
    for (const o of [state.mo, state.thumbMo, state.ro]) if (o) o.disconnect();
    state.mo = null;
    state.thumbMo = null;
    state.ro = null;
    if (state.raf) { unframe(state.raf); state.raf = 0; }
    if (state.navRaf) { unframe(state.navRaf); state.navRaf = 0; }
  }

  // ---- mount / sync / update / unmount ---------------------------------------------------------------------------------

  const attached = () => !!(state.root && state.root.isConnected && state.contents && state.contents.isConnected && state.root.parentNode === state.contents.parentNode);

  const resetData = () => {
    state.entries = [];
    state.byKey = new Map();
    state.byWrapper = new Map();
    state.byLink = new WeakMap();
  };

  /** Puts every piece of state back and restores the page exactly. Safe to call twice. */
  function teardown() {
    stopObservers();
    for (const e of state.entries) {
      try {
        if (e.wrapper.getAttribute(SRC_ATTR) === token) {
          e.wrapper.removeAttribute(SRC_ATTR);
          e.wrapper.removeAttribute('cd-live');
        }
      } catch { /* wrapper gone */ }
    }
    if (state.root && state.root.parentNode) state.root.parentNode.removeChild(state.root);
    state.mounted = false;
    state.root = null;
    state.contents = null;
    state.host = null;
    state.mode = '';
    state.density = 0;
    state.liveRowKeys = '';
    state.drag = null;
    state.justDragged = false;
    resetData();
  }

  function fail(err) {
    const reason = `home-layout: ${err && err.message ? err.message : String(err)}`;
    try { teardown(); } catch { /* best effort */ }
    if (typeof onFail === 'function') { try { onFail(reason); } catch { /* the engine's problem */ } }
  }

  /** Leftovers of a dead instance of this script (the extension was reloaded): an orphan root and marks that hide tiles for nothing. */
  function removeStale(host, contents) {
    for (const old of Array.from(host.children)) {
      if (old !== state.root && old.classList && old.classList.contains('cd-home')) host.removeChild(old);
    }
    for (const n of Array.from(contents.querySelectorAll(`[${SRC_ATTR}], [cd-live]`))) {
      n.removeAttribute(SRC_ATTR);
      n.removeAttribute('cd-live');
    }
  }

  function mount() {
    if (state.mounted) {
      if (attached()) return true; // idempotent
      teardown(); // the grid was replaced under us: start over
    }
    try {
      const mode = wantedMode();
      if (mode === 'grid') return false;
      const where = locate();
      if (!where) return false;
      const { contents, host } = where;
      const density = normalizeDensity(cfg().density);

      // Phase 1: everything in memory. The page has not been touched yet.
      resetData();
      const fresh = scan(contents);
      if (!fresh.length) return false;
      const root = newRoot(mode, density);
      register(fresh);
      if (buildContent(root, fresh, mode, density) === 0) {
        resetData();
        return false;
      }

      // Phase 2: commit. From here on a failure rolls everything back.
      wire(root);
      removeStale(host, contents);
      state.root = root;
      state.contents = contents;
      state.host = host;
      state.mode = mode;
      state.density = density;
      state.mounted = true;
      host.insertBefore(root, contents);
      markSources(fresh);
      startObservers();
      refreshThumbs();
      updateAllNav();
      return true;
    } catch (err) {
      fail(err);
      return false;
    }
  }

  function rebuild() {
    const active = state.root.contains(doc.activeElement) ? doc.activeElement.getAttribute('cd-video') : null;
    state.byLink = new WeakMap();
    const root = newRoot(state.mode, state.density);
    if (buildContent(root, state.entries, state.mode, state.density) === 0) { // nothing left to show: give the grid back
      teardown();
      return;
    }
    wire(root);
    state.host.replaceChild(root, state.root);
    state.root = root;
    if (state.mo) { state.mo.disconnect(); observeGrid(); }
    if (state.ro) { state.ro.disconnect(); state.ro.observe(root); }
    updateAllNav();
    if (active) {
      const again = Array.from(root.querySelectorAll('[cd-video]')).find((n) => n.getAttribute('cd-video') === active && n.matches('a'));
      if (again) again.focus({ preventScroll: true });
    }
  }

  function sync() {
    if (!state.mounted) return;
    try {
      if (!attached()) { teardown(); return; }
      let removed = false;
      for (const e of state.entries.slice()) {
        const gone = !state.contents.contains(e.wrapper);
        if (!gone && !isStale(e)) continue;
        removed = true;
        state.entries.splice(state.entries.indexOf(e), 1);
        state.byWrapper.delete(e.wrapper);
        if (state.byKey.get(e.key) === e) state.byKey.delete(e.key);
        // A recycled wrapper is read again below; if it no longer holds a video it goes back to YouTube's grid.
        if (!gone) {
          try {
            if (e.wrapper.getAttribute(SRC_ATTR) === token) {
              e.wrapper.removeAttribute(SRC_ATTR);
              e.wrapper.removeAttribute('cd-live');
            }
          } catch { /* wrapper gone */ }
        }
      }
      let existingLiveChanged = false;
      for (const e of state.entries) {
        if (e.wrapper && !e.dup) {
          const tile = extractTile(e.wrapper, selectors);
          if (tile && tile.isLive !== e.tile.isLive) {
            e.tile.isLive = tile.isLive;
            e.tile.duration = tile.duration;
            if (e.tile.isLive) e.wrapper.setAttribute('cd-live', '');
            else e.wrapper.removeAttribute('cd-live');
            existingLiveChanged = true;
          }
        }
      }
      const fresh = scan(state.contents);
      register(fresh);
      refreshThumbs();
      if (removed || existingLiveChanged) {
        markSources(fresh);
        // Re-read wrappers are appended by register(); cards must follow the order of the grid, and "the repeat" is whichever tile
        // comes later: a wrapper that was a repeat of a tile that has since been recycled now owns the card (seen on the real feed).
        state.entries.sort((a, b) => (a.wrapper === b.wrapper ? 0 : a.wrapper.compareDocumentPosition(b.wrapper) & 4 ? -1 : 1));
        reassignRepeats();
        rebuild();
      } else if (fresh.length) {
        place(state.root, fresh.filter((e) => !e.dup), rowChunkForDensity(state.density), rowVisibleForDensity(state.density));
        markSources(fresh);
        updateAllNav();
      }
    } catch (err) {
      fail(err);
    }
  }

  function unmount() {
    if (!state.mounted && !state.root) return;
    teardown();
  }

  function update() {
    try {
      const mode = wantedMode();
      if (mode === 'grid') { unmount(); return; }
      if (!state.mounted) { mount(); return; }
      if (!attached()) { teardown(); mount(); return; }
      const density = normalizeDensity(cfg().density);
      if (mode === state.mode && density === state.density) return;
      state.mode = mode;
      state.density = density;
      rebuild();
    } catch (err) {
      fail(err);
    }
  }

  function isMounted() {
    if (state.mounted && !attached()) teardown();
    return state.mounted;
  }

  function getLiveCount() {
    if (!state.mounted) return 0;
    return state.entries.filter((e) => e.tile && e.tile.isLive && !e.dup).length;
  }

  return { mount, update, unmount, isMounted, getLiveCount };
}
