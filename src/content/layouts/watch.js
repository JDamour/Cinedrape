// Watch layouts: CSS only (ARCHITECTURE.md sections 4 and 6). `cinema` and `focus`; `default` is no CSS at all.
//
// The player is YouTube's own and is never moved, re-parented, cloned or restyled: no rule here mentions .ytp-*, #movie_player,
// the <video> element, ytd-player or the player's controls. Cinema changes where the player's page-level boxes sit by
// re-flowing the columns around them; focus hides the comments and the related list.
//
// Scope of every rule:
//   html[cd-theme][cd-page="watch"]        the engine says this is a watch page (a hidden watch skeleton exists on every page)
//   :not([cd-off-layout-watch])            the health check has not paused the feature
//   ytd-watch-flexy:not([fullscreen])      fullscreen is left completely alone; theatre ([theater]) keeps YouTube's own layout
//                                          (it already is the "wide player on top, columns below" arrangement cinema builds)
//
// Ad safety (hard rule, section 6): focus hides LEAF items only (individual comments, related tiles, shelves, chips), never
// #secondary / #related / #columns, because those always hold an empty ad container (#player-ads) and must stay visible.
// Every hide goes through safeHide(); on top of its guard the subject must not sit inside an ad or a sponsorship disclosure and
// must not contain a disclosure. What remains in the right column after the hide (YouTube's panels, an ad) is moved below the
// video, not removed.
import { ATTR } from '../../shared/constants.js';
import { safeHide } from '../../shared/selector-map.js';
import { isFeatureDisabled, roleEntries, carriesAdGuard } from './density.js';

const FEATURE = 'layout-watch';
const FLEXY = 'ytd-watch-flexy';
const GATE = `html[cd-theme][cd-page="watch"]:not([${ATTR.offPrefix}${FEATURE}])`;
const SCOPE = `${GATE} ${FLEXY}:not([fullscreen])`;
// YouTube's own page-margin variables are read by the cinema layout; a stylesheet that sets them must not be able to squeeze the
// player (and the in-player ad) to nothing, so both reads are clamped (ad-safety review, finding 2).
const MARGIN = 'clamp(0px,var(--ytd-watch-flexy-horizontal-page-margin,16px),96px)';
const TOP_PAD = 'clamp(0px,var(--ytd-watch-flexy-top-padding,12px),48px)';

// What the map does not name: the leaves of the related list (current and older renderers). Roles of the same purpose join them.
const RELATED_LEAVES = [
  'yt-lockup-view-model', 'ytd-compact-video-renderer', 'ytd-compact-playlist-renderer', 'ytd-compact-radio-renderer',
  'ytd-compact-movie-renderer', 'ytd-compact-autoplay-renderer', 'ytd-reel-shelf-renderer', 'grid-shelf-view-model',
  'ytd-shelf-renderer', 'yt-related-chip-cloud-renderer', 'ytd-continuation-item-renderer',
];
const FALLBACK = Object.freeze({
  comments: ['ytd-comments#comments', 'ytd-comments'],
  watchRelated: ['ytd-watch-next-secondary-results-renderer'],
});

const dedupe = (list) => [...new Set(list)];
const group = (map, name) => (map && map.protected && Array.isArray(map.protected[name])
  ? map.protected[name].filter((s) => typeof s === 'string' && s.trim() !== '').map((s) => s.trim()) : []);
const union = (list) => (list.length === 1 ? list[0] : `:is(${list.join(',')})`);

/**
 * Role entries as selectors relative to <ytd-watch-flexy> (the scope already names it). Entries rooted somewhere else (the
 * ytd-app[is-watch-page] fallback of watchFlexy) are not relative to it and are dropped.
 */
function inFlexy(map, role) {
  let entries = roleEntries(map, role);
  if (!entries.length && FALLBACK[role]) entries = [...FALLBACK[role]];
  const out = [];
  for (const e of entries) {
    if (e === FLEXY) continue;
    if (e.startsWith(`${FLEXY} `)) out.push(e.slice(FLEXY.length + 1).trim());
    else if (!/^ytd-app\b/.test(e)) out.push(e);
  }
  return dedupe(out.filter(Boolean));
}

/**
 * One guarded hide rule for leaf selectors below the flexy scope. '' when the guard cannot be built (fail closed: a rule that
 * is not provably guarded is not emitted).
 */
function hideRule(map, leaves) {
  const list = dedupe(leaves.filter(Boolean));
  const ads = group(map, 'ads');
  if (!list.length || !ads.length) return '';
  const sponsors = group(map, 'sponsor');
  const marked = [...ads, ...sponsors];
  const inside = `:not(:is(${marked.join(',')}) *)`;
  const holds = sponsors.length ? `:not(:has(${sponsors.join(',')}))` : '';
  const subject = `${SCOPE} ${union(list)}${inside}${holds}`;
  let guarded = '';
  try { guarded = safeHide(map, subject); } catch { guarded = ''; }
  if (!carriesAdGuard(map, subject, guarded)) return '';
  return `${guarded}{display:none !important}`;
}

// ---- focus -----------------------------------------------------------------------------------------------------------

function focusCss(map) {
  const out = ['/* watch: focus. Comments and related items are hidden one by one; columns, panels and ads stay. */'];

  const leaves = dedupe([...RELATED_LEAVES, ...inFlexy(map, 'videoTile'), ...inFlexy(map, 'chips'),
    ...inFlexy(map, 'shortsShelf').filter((s) => !/^ytd-rich-/.test(s))]);
  const related = inFlexy(map, 'watchRelated');
  const inRelated = `${union(related.length ? related : ['#related'])} :is(${leaves.join(',')})`;
  out.push(hideRule(map, [...inFlexy(map, 'comments'), inRelated]));

  // With the list gone the right column is (nearly) empty: stack it under the video instead of reserving a blank gutter, and
  // centre the video column. Nothing in it is hidden, so an ad that lives there is shown in full, below the content.
  const two = `${SCOPE}[is-two-columns_]`;
  out.push(`${two} #columns{flex-wrap:wrap;justify-content:center}`);
  out.push(`${two} #primary{flex:1 0 100%;max-width:min(100%,1280px)}`);
  out.push(`${two} #secondary{flex:1 0 100%;width:auto;min-width:0;max-width:min(100%,1280px)}`);
  return out.filter(Boolean).join('\n');
}

// ---- cinema ----------------------------------------------------------------------------------------------------------

function cinemaCss() {
  const wide = `${GATE} ${FLEXY}[is-two-columns_]:not([theater]):not([fullscreen])`;
  const out = ['/* watch: cinema. The player row spans the full width at the top; the page boxes sit below it in two columns. */'];

  // #primary and #primary-inner stop being boxes of their own (display:contents), so the player box and the metadata box become
  // grid items of #columns beside #secondary. Nothing moves in the DOM; only where the boxes are laid out changes.
  out.push(`${wide} #columns{display:grid;grid-template-columns:minmax(0,1fr) auto;grid-auto-flow:row;padding:0 0 0 ${MARGIN}}`);
  out.push(`${wide} #primary,${wide} #primary-inner{display:contents}`);
  out.push(`${wide} #primary-inner > *,${wide} #primary > :where(:not(#primary-inner)){grid-column:1;min-width:0}`);
  out.push(`${wide} #player{grid-column:1 / -1;grid-row:1;margin:${TOP_PAD} ${MARGIN} 0 0}`);
  out.push(`${wide} #below{grid-column:1;grid-row:2}`);
  out.push(`${wide} #secondary{grid-column:2;grid-row:2;min-width:0}`);

  // Darkened surround: a full-bleed band behind the player's row, the theme background pushed toward black.
  out.push(`${wide} #columns::before{content:"";grid-column:1 / -1;grid-row:1;display:block;margin:0 0 0 calc(${MARGIN} * -1);`
    + 'background:#000;background:color-mix(in srgb,var(--cd-bg,#0f0f0f) 45%,#000)}');
  return out.join('\n');
}

/**
 * Stylesheet for the watch page arrangement.
 * @param {object} map  selector map
 * @param {{watch?:string, disabled?:string[]}} cfg  EffectiveConfig
 * @returns {string} CSS; '' for `default`, an unknown mode, or when the feature is switched off
 */
export function buildWatchLayoutCss(map, cfg) {
  if (isFeatureDisabled(cfg, FEATURE)) return '';
  const mode = cfg && cfg.watch;
  if (mode === 'cinema') return `${cinemaCss()}\n`;
  if (mode === 'focus') return `${focusCss(map)}\n`;
  return '';
}
