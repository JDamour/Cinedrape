// Page and navigation detection (ARCHITECTURE.md sections 1 and 4).
//
// The page type comes from the URL and only the URL: YouTube keeps a hidden `ytd-watch-flexy` skeleton in the DOM on every
// page and reuses one `ytd-browse` for home, channel, playlist, subscriptions and history, so role presence proves nothing.
// This file has no timers and no polling on purpose: navigation is event driven.

const YT_HOSTS = new Set(['www.youtube.com', 'youtube.com']);
const FALLBACK_BASE = 'https://www.youtube.com';
const CHANNEL_PREFIXES = new Set(['channel', 'c', 'user']);
const NAV_EVENTS = ['yt-navigate-start', 'yt-navigate-finish', 'yt-page-data-updated'];

function safeDecode(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Reduces whatever the caller has (Location, URL, {pathname}, {href}, a string, or nothing) to {hostname, pathname}. */
function normaliseLocation(doc, loc) {
  let source = loc;
  if (source == null) {
    try {
      source = (doc && (doc.location || (doc.defaultView && doc.defaultView.location))) || null;
    } catch {
      source = null;
    }
  }
  if (source == null) return null;
  try {
    if (typeof source === 'string') {
      if (source.trim() === '') return null; // an empty string is "no location", not "the home page"
      const url = new URL(source, FALLBACK_BASE);
      return { hostname: url.hostname, pathname: url.pathname };
    }
    if (typeof source.pathname === 'string') {
      return { hostname: typeof source.hostname === 'string' ? source.hostname : '', pathname: source.pathname };
    }
    if (typeof source.href === 'string') {
      const url = new URL(source.href, FALLBACK_BASE);
      return { hostname: url.hostname, pathname: url.pathname };
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * @param {Document|null} doc  only used when `loc` is omitted (then `doc.location` is read)
 * @param {Location|URL|{pathname:string,hostname?:string}|string} [loc]
 * @returns {'home'|'watch'|'search'|'channel'|'subscriptions'|'history'|'playlist'|'shorts'|'other'}
 */
export function detectPageType(doc, loc) {
  const place = normaliseLocation(doc, loc);
  if (!place) return 'other';
  // Selector maps describe www.youtube.com only; music., studio., m. and nocookie hosts have different markup.
  if (place.hostname && !YT_HOSTS.has(place.hostname.toLowerCase())) return 'other';

  const path = String(place.pathname).split(/[?#]/, 1)[0].replace(/\/+$/, '');
  if (path === '') return 'home';
  if (path[0] !== '/') return 'other';

  const segs = path.slice(1).split('/');
  const first = segs[0].toLowerCase(); // route names are fixed lower-case words; handles keep their case
  const second = segs.length > 1 ? segs[1] : '';

  if (first === 'watch') return segs.length === 1 ? 'watch' : 'other';
  if ((first === 'live' || first === 'clip') && segs.length === 2 && second) return 'watch';
  if (first === 'results') return segs.length === 1 ? 'search' : 'other';
  if (first === 'playlist') return segs.length === 1 ? 'playlist' : 'other';
  if (first === 'shorts') return segs.length <= 2 ? 'shorts' : 'other';
  if (first === 'feed' && second) {
    const feed = second.toLowerCase();
    if (feed === 'subscriptions') return 'subscriptions';
    if (feed === 'history') return 'history';
    return 'other';
  }
  const decoded = safeDecode(segs[0]);
  if (decoded.length > 1 && decoded[0] === '@') return 'channel'; // includes /@handle/shorts, which is a channel tab
  if (CHANNEL_PREFIXES.has(first) && segs.length >= 2 && second) return 'channel';
  return 'other';
}

/**
 * Theatre and fullscreen are attributes of the watch element (`theater`, `fullscreen`); the platform fullscreen element and
 * the player's `ytp-fullscreen` class are accepted as well. A hidden `ytd-watch-flexy` is the off-page skeleton: default.
 * @param {Document|null} doc
 * @returns {'default'|'theatre'|'fullscreen'}
 */
export function detectWatchMode(doc) {
  try {
    if (!doc || typeof doc.querySelector !== 'function') return 'default';
    const flexy = doc.querySelector('ytd-watch-flexy');
    if (!flexy || flexy.hasAttribute('hidden')) return 'default';
    if (flexy.hasAttribute('fullscreen') || doc.fullscreenElement || flexy.querySelector('.html5-video-player.ytp-fullscreen')) {
      return 'fullscreen';
    }
    if (flexy.hasAttribute('theater')) return 'theatre';
  } catch {
    // A page script that broke querySelector must not take the content script down with it.
  }
  return 'default';
}

/**
 * Calls `cb({type, url})` for every YouTube SPA navigation signal: `yt-navigate-start`, `yt-navigate-finish` and
 * `yt-page-data-updated` (any target, bubbling or not), `popstate`, and `page-manager` when the children of
 * `ytd-page-manager` change. No timers, no polling: the only DOM observers are a childList observer on the page manager and,
 * while the document is still parsing and the page manager does not exist yet, a short-lived one that waits for it.
 * @param {Window} win
 * @param {Document} doc
 * @param {(info:{type:string,url:string}) => void} cb
 * @returns {() => void} dispose
 */
export function observeNavigation(win, doc, cb) {
  if (typeof cb !== 'function') throw new TypeError('observeNavigation(win, doc, cb): cb must be a function');
  const events = win && typeof win.addEventListener === 'function' ? win : doc && typeof doc.addEventListener === 'function' ? doc : null;
  const Observer = (win && win.MutationObserver) || (doc && doc.defaultView && doc.defaultView.MutationObserver) || globalThis.MutationObserver;

  let disposed = false;
  let pageManager = null;
  let pmObserver = null;
  let bootObserver = null;
  let onReady = null;

  const currentUrl = () => {
    try {
      return String(win.location.href);
    } catch {
      return '';
    }
  };
  const notify = (type) => {
    if (!disposed) cb({ type, url: currentUrl() });
  };

  function stopBootstrap() {
    if (bootObserver) { bootObserver.disconnect(); bootObserver = null; }
    if (onReady) { doc.removeEventListener('DOMContentLoaded', onReady); onReady = null; }
  }

  function ensureObserved() {
    if (disposed || !Observer || !doc || typeof doc.querySelector !== 'function') return;
    let found = null;
    try {
      found = doc.querySelector('ytd-page-manager');
    } catch {
      return;
    }
    if (!found || found === pageManager) return;
    if (!pmObserver) pmObserver = new Observer(() => notify('page-manager'));
    pmObserver.disconnect(); // YouTube replaced the node: follow it
    pmObserver.observe(found, { childList: true });
    pageManager = found;
    stopBootstrap();
  }

  const handlers = NAV_EVENTS.map((type) => [type, () => { ensureObserved(); notify(type); }]);
  const popstate = () => { ensureObserved(); notify('popstate'); };

  if (events) {
    // Capture on the window sees the event once whether it was dispatched on window, on document or deeper, bubbling or not.
    for (const [type, handler] of handlers) events.addEventListener(type, handler, true);
    if (win && typeof win.addEventListener === 'function') win.addEventListener('popstate', popstate);
  }

  ensureObserved();
  if (!pageManager && Observer && doc && doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
    // document_start: the app shell is not parsed yet. Wait for it with a cheap observer that stops at the first hit
    // or at DOMContentLoaded, whichever comes first.
    onReady = () => { ensureObserved(); stopBootstrap(); };
    doc.addEventListener('DOMContentLoaded', onReady);
    bootObserver = new Observer(() => ensureObserved());
    bootObserver.observe(doc.documentElement || doc, { childList: true, subtree: true });
  }

  return function dispose() {
    if (disposed) return;
    disposed = true;
    if (events) {
      for (const [type, handler] of handlers) events.removeEventListener(type, handler, true);
      if (win && typeof win.removeEventListener === 'function') win.removeEventListener('popstate', popstate);
    }
    if (pmObserver) { pmObserver.disconnect(); pmObserver = null; }
    stopBootstrap();
    pageManager = null;
  };
}
