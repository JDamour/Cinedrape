// The "YouTube changed, part of the look is paused" notice (ARCHITECTURE.md section 4, spec feature F6).
//
// Design rules, in order of importance:
//  1. It never covers or hides anything of YouTube's: it lives directly in <body> (never inside the player, an ad slot or any
//     page container), is small, and takes a viewport corner that overlaps neither the player, its controls, an in-player ad or
//     sponsorship UI nor an ad slot. When no corner is free (theatre mode, a narrow window) it is NOT floated over them: it
//     drops into the flow under the masthead and pushes the page down instead. It is a plain status message, not a modal: it
//     takes no focus when it appears and can always be dismissed.
//  2. It works with no stylesheet at all (the theme feature itself may be the broken one), so it styles itself through the
//     CSSOM, which page CSP does not block, and falls back to a fixed dark pair when no --cd-* variables exist.
//  3. Each feature is announced at most once per browser-tab session: the document remembers it, and so does sessionStorage
//     (feature ids only, nothing else), so a reload of a still-broken page does not nag. Asking again is a no-op. The popup
//     keeps showing the paused features, so the notice is a courtesy, not the only place the user can find out.
//  4. It tells the truth: when a paused feature comes back (YouTube changed back, or a newer selector map fixed it) retireNotice()
//     takes that feature out of the sentence and removes the notice once nothing is left. The feature stays announced for the
//     session, so a feature that flaps does not bring the notice back each time.

import { FEATURES } from '../shared/constants.js';

export const FEATURE_LABELS = Object.freeze({
  theme: 'Theme',
  'layout-home': 'Home layout',
  'layout-watch': 'Watch layout',
  density: 'Density',
  'calm-hideShorts': 'Hide Shorts',
  'calm-hideHomeRecs': 'Hide home recommendations',
  'calm-hideComments': 'Hide comments',
  'calm-hideEndScreens': 'Hide end screens',
  'calm-hideViewCounts': 'Hide view counts',
  'calm-hideLive': 'Hide live streams',
});

const KNOWN = new Set(FEATURES);
// The player, its control bar, everything ad- or sponsorship-shaped in the player, and the ad slots of the pages.
export const DEFAULT_AVOID = [
  '#movie_player', 'ytd-player', 'ytd-miniplayer', '.html5-video-player', '.ytp-chrome-bottom', '.ytp-ad-module',
  '[class*="ytp-ad-"]', '[class*="ytp-paid-content"]', 'ytd-ad-slot-renderer', '#masthead-ad',
].join(', ');
const ANCHORS = ['bottom-left', 'bottom-right', 'top-right', 'top-left'];
const FLOW = 'flow';
const MASTHEAD_HEIGHT = 56; // YouTube's fixed masthead: the in-flow notice starts below it
const FALLBACK_SIZE = { w: 360, h: 64 }; // used when the browser reports no size yet
const EDGE = 16;
const MASTHEAD = 72; // top anchors sit under YouTube's 56px masthead

const STORE_KEY = 'cd:v1:noticeShown';

function storageOf(doc) {
  try {
    const win = doc.defaultView;
    return (win && win.sessionStorage) || null;
  } catch {
    return null; // sandboxed frames and blocked site data throw on access
  }
}

function readShown(doc) {
  try {
    const store = storageOf(doc);
    const raw = store && store.getItem(STORE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((f) => typeof f === 'string' && KNOWN.has(f)) : [];
  } catch {
    return [];
  }
}

function writeShown(doc, shown) {
  try {
    const store = storageOf(doc);
    if (store) store.setItem(STORE_KEY, JSON.stringify([...shown]));
  } catch {
    // Quota or blocked storage: the in-memory set still holds for this document.
  }
}

/** Per-document memory: which features were announced, and the notice that is currently on screen. */
const sessions = new WeakMap();
function sessionOf(doc) {
  let s = sessions.get(doc);
  if (!s) { s = { shown: new Set(readShown(doc)), live: null }; sessions.set(doc, s); }
  return s;
}

const listText = (labels) => (labels.length <= 1 ? labels.join('') : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`);

function style(el, props) {
  for (const [name, value] of Object.entries(props)) el.style.setProperty(name, value);
}

function overlapArea(a, b) {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function rectFor(anchor, size, view) {
  const left = anchor.endsWith('left') ? EDGE : Math.max(EDGE, view.w - size.w - EDGE);
  const top = anchor.startsWith('top') ? MASTHEAD : Math.max(MASTHEAD, view.h - size.h - EDGE);
  return { left, top, right: left + size.w, bottom: top + size.h };
}

function placeAt(el, anchor) {
  if (anchor === FLOW) {
    // Part of the document, under the fixed masthead: it takes room rather than covering any.
    style(el, { position: 'relative', top: 'auto', bottom: 'auto', left: 'auto', right: 'auto', margin: `${MASTHEAD_HEIGHT}px ${EDGE}px 8px` });
    el.setAttribute('data-cd-anchor', FLOW);
    return;
  }
  style(el, {
    position: 'fixed',
    margin: '0',
    top: anchor.startsWith('top') ? `${MASTHEAD}px` : 'auto',
    bottom: anchor.startsWith('bottom') ? `${EDGE}px` : 'auto',
    left: anchor.endsWith('left') ? `${EDGE}px` : 'auto',
    right: anchor.endsWith('right') ? `${EDGE}px` : 'auto',
  });
  el.setAttribute('data-cd-anchor', anchor);
}

/**
 * The first corner that overlaps none of the obstacles (so jsdom / no player = bottom-left), else 'flow': under the masthead, in the
 * document. A corner that merely overlaps the obstacles a little is not good enough: the player's controls and ad UI stay uncovered.
 */
function bestAnchor(doc, el, avoid) {
  const win = doc.defaultView;
  let obstacles = [];
  try {
    obstacles = [...doc.querySelectorAll(avoid)].map((n) => n.getBoundingClientRect()).filter((r) => r && r.width > 0 && r.height > 0);
  } catch {
    obstacles = [];
  }
  if (!obstacles.length || !win) return ANCHORS[0];
  const own = el.getBoundingClientRect();
  const size = own && own.width > 0 && own.height > 0 ? { w: own.width, h: own.height } : FALLBACK_SIZE;
  const view = { w: win.innerWidth || doc.documentElement.clientWidth, h: win.innerHeight || doc.documentElement.clientHeight };
  for (const anchor of ANCHORS) {
    const rect = rectFor(anchor, size, view);
    const area = obstacles.reduce((sum, r) => sum + overlapArea(rect, { left: r.left, top: r.top, right: r.right, bottom: r.bottom }), 0);
    if (area === 0) return anchor;
  }
  return FLOW;
}

function build(doc) {
  const root = doc.createElement('div');
  root.className = 'cd-notice';
  root.setAttribute('role', 'status');
  root.setAttribute('aria-live', 'polite');
  root.setAttribute('aria-atomic', 'true');
  style(root, {
    position: 'fixed',
    'z-index': '1000', // above page content, below YouTube's masthead, menus and dialogs
    'box-sizing': 'border-box',
    display: 'flex',
    'align-items': 'center',
    gap: '12px',
    'max-width': 'min(380px, calc(100vw - 32px))',
    margin: '0',
    padding: '10px 12px',
    background: 'var(--cd-surface, #212121)',
    color: 'var(--cd-text, #f1f1f1)',
    border: '1px solid var(--cd-border, #6b6b6b)',
    'border-radius': 'var(--cd-radius, 12px)',
    'box-shadow': '0 4px 16px rgba(0, 0, 0, 0.4)',
    font: '14px/20px Roboto, Arial, sans-serif',
  });
  const text = doc.createElement('span');
  text.className = 'cd-notice-text';
  style(text, { flex: '1 1 auto', margin: '0' });
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'cd-notice-dismiss';
  button.textContent = 'Dismiss';
  style(button, {
    flex: 'none',
    'min-width': '28px',
    'min-height': '28px',
    padding: '4px 10px',
    background: 'transparent',
    color: 'inherit',
    border: '1px solid currentColor',
    'border-radius': '8px',
    font: 'inherit',
    cursor: 'pointer',
    outline: 'none',
  });
  // :focus-visible cannot be written through the CSSOM, so the ring is applied on focus/blur (contrast of #3ea6ff on #212121 is above 3:1).
  button.addEventListener('focus', () => style(button, { outline: '2px solid var(--cd-accent, #3ea6ff)', 'outline-offset': '2px' }));
  button.addEventListener('blur', () => style(button, { outline: 'none' }));
  root.append(text, button);
  return { root, text, button };
}

/**
 * Shows the notice for the given paused features, once per feature per document.
 * @param {Document} doc
 * @param {{features: (string|{feature:string})[], onDismiss?: (features:string[]) => void, avoid?: string}} options
 *   `avoid`: CSS selector for what the notice must keep clear of (default: the player and its ad UI)
 * @returns {HTMLElement|null} the notice (a new one, or the one already on screen, extended), or null when there is nothing new to say
 */
export function showNotice(doc, options) {
  if (!doc || typeof doc.createElement !== 'function') return null;
  const { features, onDismiss, avoid } = options || {};
  const asked = Array.isArray(features)
    ? [...new Set(features.map((f) => (typeof f === 'string' ? f : f && f.feature)).filter((f) => typeof f === 'string' && KNOWN.has(f)))]
    : [];
  const session = sessionOf(doc);
  const fresh = asked.filter((f) => !session.shown.has(f));
  if (!fresh.length) return null;
  const host = doc.body || doc.documentElement;
  if (!host) return null;
  fresh.forEach((f) => session.shown.add(f));
  writeShown(doc, session.shown);

  const handler = typeof onDismiss === 'function' ? onDismiss : null;
  const live = session.live;
  if (live && !live.dismissed && live.root.isConnected) {
    live.features.push(...fresh);
    if (handler) live.handlers.add(handler);
    live.render();
    return live.root;
  }

  const { root, text, button } = build(doc);
  const win = doc.defaultView;
  const notice = {
    root,
    features: [...fresh],
    handlers: new Set(handler ? [handler] : []),
    dismissed: false,
    returnTo: null,
    render() {
      const labels = notice.features.map((f) => FEATURE_LABELS[f]);
      text.textContent = `Cinedrape turned off ${listText(labels)} because YouTube changed. Everything else still works.`;
    },
  };
  const selectorToAvoid = typeof avoid === 'string' && avoid.trim() ? avoid : DEFAULT_AVOID;
  const place = () => placeAt(root, bestAnchor(doc, root, selectorToAvoid));
  // The player moves when the window is resized and when YouTube swaps the page (home -> watch), so look for a free corner again.
  const onMove = () => {
    if (!root.isConnected) { unlisten(); return; }
    place();
  };
  function listen() {
    if (!win) return;
    win.addEventListener('resize', onMove);
    win.addEventListener('yt-navigate-finish', onMove, true);
  }
  function unlisten() {
    if (!win) return;
    win.removeEventListener('resize', onMove);
    win.removeEventListener('yt-navigate-finish', onMove, true);
  }

  function dismiss(quiet = false) {
    if (notice.dismissed) return;
    notice.dismissed = true;
    const hadFocus = root.contains(doc.activeElement);
    const dismissed = [...notice.features];
    root.remove();
    unlisten();
    if (session.live === notice) session.live = null;
    if (hadFocus) {
      const back = notice.returnTo;
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
      else if (doc.activeElement && typeof doc.activeElement.blur === 'function') doc.activeElement.blur();
    }
    if (quiet) return; // retired because the features healed: nobody dismissed anything
    for (const fn of notice.handlers) {
      try {
        fn(dismissed);
      } catch (err) {
        // One faulty listener must not stop the others, and the notice is already gone. Surface it the way the page would.
        if (win && typeof win.reportError === 'function') win.reportError(err);
      }
    }
  }

  notice.retire = (healed) => {
    if (notice.dismissed) return false;
    const before = notice.features.length;
    notice.features = notice.features.filter((f) => !healed.includes(f));
    if (notice.features.length === before) return false;
    if (notice.features.length === 0) dismiss(true);
    else notice.render();
    return true;
  };

  button.addEventListener('click', () => dismiss());
  root.addEventListener('focusin', (e) => {
    const from = e.relatedTarget;
    if (from && !root.contains(from) && typeof from.focus === 'function') notice.returnTo = from;
  });
  // Keys handled inside the notice stay inside it: YouTube binds Space, Enter and Escape to the player and its dialogs.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); dismiss(); }
    else if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
  });
  root.addEventListener('keyup', (e) => {
    if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') e.stopPropagation();
  });

  notice.render();
  // First child of <body>: first stop for keyboard users, and never inside ytd-app, the player or any ad container.
  host.insertBefore(root, host.firstChild);
  place();
  listen();
  session.live = notice;
  return root;
}

/**
 * Features that were paused work again: remove them from the visible notice, and the notice itself when nothing is left. Not a
 * dismissal (onDismiss handlers are not called), and the features stay "announced" for the session (see rule 4 at the top).
 * @param {Document} doc
 * @param {(string|{feature:string})[]} features
 * @returns {boolean} whether the notice on screen changed
 */
export function retireNotice(doc, features) {
  if (!doc || !Array.isArray(features)) return false;
  const session = sessions.get(doc);
  const live = session && session.live;
  if (!live || live.dismissed || !live.root.isConnected) return false;
  const healed = features.map((f) => (typeof f === 'string' ? f : f && f.feature)).filter((f) => typeof f === 'string' && KNOWN.has(f));
  return healed.length ? live.retire(healed) : false;
}
