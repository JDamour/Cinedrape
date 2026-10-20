// Base skin: the stylesheet that makes the six launch themes differ by data only (ARCHITECTURE.md section 4).
//
// Everything here is expressed in the --cd-* variables written by shared/tokens.js, so a theme changes nothing in
// this file. Every rule starts with html[cd-theme] (page-specific ones with html[cd-theme][cd-page="..."]).
//
// Selectors come from the selector map through roleCss(): a YouTube markup change is fixed by a map update. Roles
// the map does not define fall back to FALLBACK (lists) or DERIVED (built from another role, e.g. "the masthead role +
// #background") and are picked up from the map automatically once a map defines them. A role that is missing and has no
// fallback produces no rule. A role's selectors are wrapped in :is() so one selector this browser cannot parse costs
// that selector, not the whole rule.
//
// This file contains no hide rule of any kind: no display:none, visibility, opacity, zero sizes, clip, filter or
// pointer-events. Hiding belongs to calm.js and always goes through safeHide(). The player and its controls are never
// restyled here (rules that could reach into them carry :not(player):not(player *)); ads are never given a geometry or
// visibility declaration, only the same colours and type as the rest of the page.
import { roleCss } from '../shared/selector-map.js';

const S = 'html[cd-theme]';
const PLAYER_ROLE = 'watchPlayer';
const MAX_SELECTOR_CHARS = 600;
// A single selector must not be able to end its rule or comment early.
const UNSAFE_SELECTOR = /[{};<@\\\n\r]|\/\*/;
// Elements Cinedrape built itself (cd-hero, cd-row, ...): their look belongs to the theme, never to the forced page rules.
const OWN = ['[class^="cd-"]', '[class*=" cd-"]'];
// The tint palette YouTube sets inline on components that use the video's colours, mapped onto the theme (section 1-4 = surfaces).
const LIGHTSOURCE = [
  ['section1-color', '--cd-surface'], ['section2-color', '--cd-surface'], ['section3-color', '--cd-surface'], ['section4-color', '--cd-surface'],
  ['primary-title-color', '--cd-text'], ['secondary-title-color', '--cd-muted'],
  ['icon-activated-color', '--cd-accent'], ['icon-inactive-color', '--cd-muted'], ['icon-disabled-color', '--cd-muted'],
];

/**
 * Selectors used when the selector map has no entry for a role. The first block repeats roles the map normally
 * defines (so a stripped-down map still skins the page); the second block are roles only this file knows.
 * Keep each list short and conservative: the map is the real source.
 */
export const FALLBACK = Object.freeze({
  // ---- roles the selector map defines ----
  app: ['ytd-app'],
  pageManager: ['ytd-page-manager'],
  masthead: ['ytd-masthead'],
  guide: ['tp-yt-app-drawer#guide', 'ytd-guide-renderer'],
  miniGuide: ['ytd-mini-guide-renderer'],
  chips: ['ytd-feed-filter-chip-bar-renderer', 'chip-bar-view-model', 'yt-chip-cloud-renderer'],
  tileTitle: ['a.ytLockupMetadataViewModelTitle', 'a#video-title'],
  tileMeta: ['.ytContentMetadataViewModelMetadataText', '#metadata-line .inline-metadata-item'],
  watchPlayer: ['#movie_player'],
  watchTitle: ['ytd-watch-metadata #title h1'],
  watchMetadata: ['ytd-watch-metadata'],
  watchRelated: ['ytd-watch-next-secondary-results-renderer'],
  comments: ['ytd-comments#comments', 'ytd-comments'],
  searchResults: ['ytd-search ytd-item-section-renderer > #contents'],
  channelHeader: ['ytd-tabbed-page-header'],
  subscriptionsGrid: ['ytd-browse[page-subtype="subscriptions"] ytd-rich-grid-renderer'],
  historyList: ['ytd-browse[page-subtype="history"] ytd-section-list-renderer'],
  playlistPanel: ['ytd-browse[page-subtype="playlist"] yt-item-section-renderer > #contents'],
  // ---- roles only the skin knows (candidates for the map) ----
  searchInputBox: ['yt-searchbox .ytSearchboxComponentInputBox', 'ytd-searchbox #container'],
  searchInput: ['yt-searchbox .ytSearchboxComponentInput'],
  searchButton: ['yt-searchbox .ytSearchboxComponentSearchButton'],
  searchSuggest: ['yt-searchbox .ytSearchboxComponentSuggestionsContainer'],
  watchPlayerBackground: ['#player-theater-container', '.player-container-background'],
  guideItem: ['ytd-guide-entry-renderer tp-yt-paper-item'],
  guideItemActive: ['ytd-guide-entry-renderer[active] tp-yt-paper-item', 'ytd-guide-entry-renderer[is-active] tp-yt-paper-item'],
  chip: ['.ytChipShapeChip', 'yt-chip-cloud-chip-renderer #chip-container'],
  chipActive: ['.ytChipShapeActive', 'yt-chip-cloud-chip-renderer[selected] #chip-container'],
  chipInactive: ['.ytChipShapeInactive', 'yt-chip-cloud-chip-renderer:not([selected]) #chip-container'],
  button: [
    '.yt-spec-button-shape-next:not(.yt-spec-button-shape-next--icon-button)',
    'yt-button-view-model button',
    'yt-button-shape button',
  ],
  buttonTonal: [
    '.yt-spec-button-shape-next--tonal',
    'yt-button-view-model[tonal] button',
    'yt-button-shape[tonal] button',
  ],
  buttonOutline: [
    '.yt-spec-button-shape-next--outline',
    'yt-button-view-model[outline] button',
  ],
  buttonCta: ['.yt-spec-button-shape-next--call-to-action.yt-spec-button-shape-next--outline'],
  buttonText: [
    '.yt-spec-button-shape-next--text',
    '.yt-spec-button-shape-next--icon-button',
    'yt-icon-button',
  ],
  icon: [
    'yt-icon',
    'tp-yt-iron-icon',
  ],
  buttonPrimary: [
    '.yt-spec-button-shape-next--filled.yt-spec-button-shape-next--mono',
    '.yt-spec-button-shape-next--filled.yt-spec-button-shape-next--call-to-action',
  ],
  menu: ['ytd-menu-popup-renderer', 'ytd-multi-page-menu-renderer', 'tp-yt-paper-dialog', 'yt-contextual-sheet-layout'],
  menuItem: ['ytd-menu-service-item-renderer', 'ytd-menu-navigation-item-renderer'],
  thumb: ['yt-thumbnail-view-model', 'ytd-thumbnail'],
  lockupHost: ['.ytLockupViewModelHost'],
  descriptionBox: ['ytd-watch-metadata #description'],
  descriptionPreview: ['yt-description-preview-view-model', '#description-inline-expander'],
  commentTeaser: ['ytd-watch-metadata #comment-teaser'],
  commentsHeader: ['ytd-comments-header-renderer', 'yt-comments-header-view-model'],
  sectionTitle: ['ytd-shelf-renderer #title', 'ytd-item-section-header-renderer #title', 'ytd-rich-shelf-renderer #title'],
  resultSnippet: ['.metadata-snippet-text'],
  tab: ['.ytTabShapeTab', 'tp-yt-paper-tab'],
  tabSelected: ['.ytTabShapeTabSelected', 'tp-yt-paper-tab.iron-selected'],
  tabBarSelected: ['.ytTabShapeTabBarSelected'],
  banner: ['yt-image-banner-view-model'],
  pageHeaderCard: ['yt-page-header-renderer', 'yt-page-header-view-model'],
  navProgress: ['yt-page-navigation-progress #progress'],
  // The YouTube wordmark is black in light mode and white in dark mode (its text paths inherit the icon's colour); the red play button keeps its own fill.
  wordmark: ['ytd-logo yt-icon'],
  // Attributed strings (channel header, descriptions, comments) carry the colour YouTube resolved for ITS mode as an inline style.
  attributedRun: ['.ytAttributedStringHost[style*="color:"]:not([style*="background"])', '.ytAttributedStringHost [style*="color:"]:not([style*="background"])', '.ytAttributedStringLinkInheritColor[style*="color:"]:not([style*="background"])'],
  attributedLink: ['.ytAttributedStringLinkCallToActionColor'],
  // Components tinted from the video's own colours (search summary card, chapters) get a --yt-lightsource-* palette inline.
  customColors: ['[use-custom-colors]'],
});

/**
 * Roles that are a part of another role. They follow the parent when a map update renames it, and a map that defines
 * the derived role itself wins. `get(role)` returns a role's selector list.
 */
export const DERIVED = Object.freeze({
  mastheadBar: (get) => get('masthead').map((s) => `${s} #background`), // the host is transparent, #background paints the bar
  frostedGlass: (get) => get('app').map((s) => `${s} #frosted-glass`),
  guideContent: (get) => get('guide').map((s) => `${s} #contentContainer`),
  channelTitle: (get) => get('channelHeader').map((s) => `${s} h1`),
});

/** Every role skin.js reads. */
export const SKIN_ROLES = Object.freeze([...Object.keys(FALLBACK), ...Object.keys(DERIVED)]);

/**
 * Splits a selector list on its top-level commas. Returns [] when the text is structurally broken (an unclosed
 * bracket, parenthesis or quote would swallow the rest of the stylesheet), and drops unsafe or empty entries.
 */
export function splitSelectorList(text) {
  if (typeof text !== 'string') return [];
  const parts = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') i++; // an escaped character is never structure (the entry is dropped below anyway)
    else if (quote) {
      if (c === quote) quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') {
      depth--;
      if (depth < 0) return [];
    } else if (c === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (depth !== 0 || quote) return [];
  parts.push(text.slice(start));
  const seen = new Set();
  for (const p of parts) {
    const s = p.trim();
    if (s && s.length <= MAX_SELECTOR_CHARS && !UNSAFE_SELECTOR.test(s)) seen.add(s);
  }
  return [...seen];
}

const uniq = (list) => [...new Set(list)];
/** A selector list as one selector: :is() is forgiving, so an entry this browser cannot parse is skipped alone. */
const any = (list) => (list.length > 1 ? `:is(${list.join(',')})` : list[0] || '');

/**
 * @param {object|null|undefined} map  selector map (only read through roleCss)
 * @param {{theme?:object|null, disabled?:string[]}} [cfg]  EffectiveConfig
 * @returns {string} compact stylesheet, one rule per line; '' when the theme feature is disabled
 */
export function buildSkinCss(map, cfg) {
  const conf = cfg && typeof cfg === 'object' ? cfg : {};
  if (conf.theme === null) return '';                      // no theme to skin with: leave YouTube alone
  if (Array.isArray(conf.disabled) && conf.disabled.includes('theme')) return '';

  const cache = new Map();
  /** Selector list of a role: the map's if it has one, else derived from another role, else the local fallback. */
  const list = (role) => {
    if (!cache.has(role)) {
      cache.set(role, []); // a derived role that (wrongly) refers back to itself terminates here
      let css = '';
      try {
        css = roleCss(map, role);
      } catch {
        css = '';
      }
      let found = typeof css === 'string' && css.trim() !== '' ? splitSelectorList(css) : [];
      if (!found.length && Object.hasOwn(DERIVED, role)) found = uniq(DERIVED[role](list).filter((s) => !UNSAFE_SELECTOR.test(s)));
      if (!found.length && Object.hasOwn(FALLBACK, role)) found = [...FALLBACK[role]];
      cache.set(role, found);
    }
    return cache.get(role);
  };
  /** A role as one selector ('' when it has none). */
  const $ = (role) => any(list(role));

  const rules = [];
  const seen = new Set();
  const rule = (selector, decl) => {
    if (!selector || !decl) return;
    const line = `${selector}{${decl}}`;
    if (!seen.has(line)) {
      seen.add(line);
      rules.push(line);
    }
  };
  /** Global scope: html[cd-theme] <selector><suffix>. */
  const G = (sel, suffix = '') => (sel ? `${S} ${sel}${suffix}` : '');
  /** Page scope. */
  const P = (page, sel, suffix = '') => (sel ? `${S}[cd-page="${page}"] ${sel}${suffix}` : '');
  /** A inside B. */
  const X = (a, b) => (a && b ? `${a} ${b}` : '');
  const T = (...props) => `transition:${props.map((p) => `${p} var(--cd-duration) ease`).join(',')}`;

  const HEADING = 'font-family:var(--cd-heading-font,var(--cd-font-family))!important;font-weight:var(--cd-heading-weight);color:var(--cd-text)';
  const TINT = 'background-image:linear-gradient(var(--cd-hover),var(--cd-hover))';

  // The player, its controls and everything inside are never restyled by the broad rules below.
  const player = list(PLAYER_ROLE);
  const outside = (extra = []) => {
    const skip = [...player, ...extra].flatMap((p) => [p, `${p} *`]);
    return skip.length ? `:not(:is(${skip.join(',')}))` : '';
  };

  // ---- foundation: page, selection, scrollbars, type ----------------------------------------------------------
  // YouTube paints <html> itself with !important in BOTH modes (html{background-color:#fff!important}, the dark twin under html[dark]),
  // so the page colour needs !important here too; the app shell and the page manager then repeat it without needing to.
  // The doubled attribute (0,2,1) also wins the tie against html[dark]{...!important}: at document_start our <style> sits before <head>.
  rule(`${S}[cd-theme]`, 'background-color:var(--cd-bg)!important');
  rule(S, [
    'color:var(--cd-text)', 'scrollbar-color:var(--cd-border) var(--cd-bg)',
    'accent-color:var(--cd-accent)',
    'font-family:var(--cd-font-family)!important',
    // YouTube sizes text in rem on a 62.5% root set inline, so one !important root size scales all of it.
    'font-size:calc(62.5% * clamp(0.8,var(--cd-font-scale,1),1.5))!important',   // clamped: no stylesheet can zero the root font size
  ].join(';'));
  rule(`${S} ::selection`, 'background-color:var(--cd-accent);color:var(--cd-accent-text)');
  // Page text, except the player and Cinedrape's own elements (those take their font from the theme's CSS).
  rule(G($('app'), ` :where(*${outside(OWN)})`), 'font-family:var(--cd-font-family)!important');
  rule(
    G($('app'), ` :where(a,button,input,textarea,select,[tabindex],[role="button"],[role="tab"],[role="link"],[role="menuitem"])${outside()}:focus-visible`),
    'outline:2px solid var(--cd-accent);outline-offset:2px',
  );
  rule(G($('navProgress')), 'background-color:var(--cd-accent)');
  rule(G($('app')), 'background-color:var(--cd-bg);color:var(--cd-text)');
  rule(G($('pageManager')), 'background-color:var(--cd-bg)');

  // Inline colours can only be beaten by !important: the run takes the colour of its surroundings, and the call-to-action links the accent.
  rule(G($('attributedRun')), 'color:inherit!important');
  rule(G($('attributedLink')), 'color:var(--cd-accent)!important');

  rule(G($('customColors')), LIGHTSOURCE.map(([name, token]) => `--yt-lightsource-${name}:var(${token})!important`).join(';'));

  // ---- masthead and search box (the bar is painted by #background, the host is transparent) -------------------
  rule(G($('wordmark')), 'color:var(--cd-text)');
  rule(G($('mastheadBar')), 'background-color:var(--cd-bg);box-shadow:0 1px 0 var(--cd-hover)');
  rule(G($('frostedGlass')), 'background-color:var(--cd-scrim)');
  rule(G($('searchInputBox')), 'background-color:var(--cd-surface);border-color:var(--cd-border);color:var(--cd-text);'
    + 'border-radius:min(var(--cd-radius),20px) 0 0 min(var(--cd-radius),20px)');
  rule(G($('searchInputBox'), ':focus-within'), 'border-color:var(--cd-accent)');
  rule(G($('searchInput')), 'color:var(--cd-text);caret-color:var(--cd-accent)');
  rule(G($('searchInput'), '::placeholder'), 'color:var(--cd-muted)');
  rule(G($('searchButton')), 'background-color:var(--cd-hover);border-color:var(--cd-border);color:var(--cd-text);'
    + `border-radius:0 min(var(--cd-radius),20px) min(var(--cd-radius),20px) 0;${T('background-color')}`);
  rule(G($('searchButton'), ':hover'), 'background-color:var(--cd-active)');
  rule(G($('searchSuggest')), 'background-color:var(--cd-menu);color:var(--cd-text);border-radius:var(--cd-radius);box-shadow:var(--cd-shadow)');

  // ---- guide and mini guide -----------------------------------------------------------------------------------
  rule(G($('guideContent')), 'background-color:var(--cd-bg)');
  rule(G($('miniGuide')), 'background-color:var(--cd-bg)');
  rule(G($('guideItem')), `border-radius:var(--cd-radius);color:var(--cd-text);${T('background-color')}`);
  rule(G($('guideItem'), ':hover'), 'background-color:var(--cd-hover)');
  rule(G($('guideItemActive')), 'background-color:var(--cd-active)');

  // ---- chips and chip bars ------------------------------------------------------------------------------------
  rule(G($('chips')), 'background-color:var(--cd-bg)');
  rule(G($('chip')), `border-radius:var(--cd-radius);${T('background-color', 'color')}`);
  rule(G($('chipInactive')), 'background-color:var(--cd-hover);color:var(--cd-text)');
  rule(G($('chipInactive'), ':hover'), 'background-color:var(--cd-active)');
  rule(G($('chipActive')), 'background-color:var(--cd-accent);color:var(--cd-accent-text)');

  // ---- buttons (YouTube's shared button shape) ----------------------------------------------------------------
  rule(G($('button')), `border-radius:min(calc(var(--cd-radius) * 2),18px);${T('background-color', 'color', 'border-color')}`);
  rule(G($('buttonTonal')), 'background-color:var(--cd-hover);color:var(--cd-text)');
  rule(G($('buttonTonal'), ':hover'), 'background-color:var(--cd-active)');
  rule(G($('buttonText')), 'color:var(--cd-text)');
  rule(G($('buttonText'), ':hover'), 'background-color:var(--cd-hover)');
  rule(G($('icon')), 'color:inherit');
  rule(G($('buttonOutline')), 'border-color:var(--cd-border);color:var(--cd-text)');
  rule(G($('buttonCta')), 'border-color:var(--cd-accent)');
  rule(G($('buttonPrimary')), 'background-color:var(--cd-accent);color:var(--cd-accent-text)');
  rule(G($('buttonPrimary'), ':hover'), 'background-color:var(--cd-accent-hover);color:var(--cd-accent-text)');

  // ---- menus, popups, dialogs ---------------------------------------------------------------------------------
  rule(G($('menu')), 'background-color:var(--cd-menu);color:var(--cd-text);border:1px solid var(--cd-hover);'
    + 'border-radius:var(--cd-radius);box-shadow:var(--cd-shadow)');
  rule(G($('menuItem'), ':hover'), 'background-color:var(--cd-hover)');

  // ---- cards: thumbnails, titles, metadata --------------------------------------------------------------------
  // overflow:hidden is deliberately absent: every thumb selector ends in img, a replaced element whose content is
  // already clipped to its border box (border-radius rounds it), and the ad-safety validator refuses overflow
  // clipping on anything that is not a Cinedrape element.
  rule(G($('thumb')), 'border-radius:var(--cd-radius);box-shadow:var(--cd-shadow);'
    + `outline:1px solid var(--cd-hover);outline-offset:-1px;${T('box-shadow')}`);
  rule(G($('tileTitle')), 'color:var(--cd-text);font-weight:min(var(--cd-heading-weight),600)');
  rule(G($('tileMeta')), 'color:var(--cd-muted)');
  rule(G($('sectionTitle')), HEADING);
  rule(G(X($('watchRelated'), $('lockupHost')), ':hover'), `border-radius:var(--cd-radius);${TINT}`);

  // ---- watch page ---------------------------------------------------------------------------------------------
  rule(G($('watchTitle')), HEADING);
  rule(G($('watchMetadata')), 'color:var(--cd-text)');
  rule(G($('watchPlayerBackground')), 'background-color:var(--cd-bg)');
  rule(G($('descriptionBox')), 'background-color:var(--cd-surface);border-radius:var(--cd-radius);color:var(--cd-text)');
  rule(G($('descriptionBox'), ':hover'), TINT);
  rule(G($('descriptionPreview')), 'background-color:var(--cd-surface);border-radius:var(--cd-radius);color:var(--cd-text)');
  rule(G($('descriptionPreview'), ':hover'), TINT);
  rule(G($('commentTeaser')), 'background-color:var(--cd-surface);border-radius:var(--cd-radius);color:var(--cd-text)');
  rule(G($('comments')), 'color:var(--cd-text)');
  rule(G($('commentsHeader')), HEADING);

  // ---- search results -----------------------------------------------------------------------------------------
  rule(P('search', $('searchResults')), 'color:var(--cd-text)');
  rule(P('search', $('resultSnippet')), 'color:var(--cd-muted)');

  // ---- channel header and tabs --------------------------------------------------------------------------------
  rule(P('channel', $('channelHeader')), 'color:var(--cd-text)');
  rule(P('channel', $('channelTitle')), HEADING);
  rule(G($('tab')), `color:var(--cd-muted);${T('color')}`);
  rule(G($('tab'), ':hover'), 'color:var(--cd-text)');
  rule(G($('tabSelected')), 'color:var(--cd-text)');
  rule(G($('tabBarSelected')), 'background-color:var(--cd-accent)');
  rule(G($('banner')), 'border-radius:calc(var(--cd-radius) * 1.5)');

  // ---- subscriptions, history, playlists ----------------------------------------------------------------------
  rule(P('subscriptions', $('subscriptionsGrid')), 'color:var(--cd-text)');
  rule(P('history', $('historyList')), 'color:var(--cd-text)');
  rule(P('playlist', $('playlistPanel')), 'color:var(--cd-text)');
  rule(P('playlist', X($('playlistPanel'), $('lockupHost')), ':hover'), `border-radius:var(--cd-radius);${TINT}`);
  rule(P('playlist', $('pageHeaderCard')), 'border-radius:calc(var(--cd-radius) * 1.5);color:var(--cd-text)');

  // ---- motion: every transition above runs on --cd-duration; own (cd-) elements stop when motion is off ---------
  const STILL = 'transition-duration:0s!important;animation:none!important;scroll-behavior:auto!important';
  rules.push(`@media (prefers-reduced-motion:reduce){${S}{--cd-duration:0ms!important}${S} :is(${OWN.join(',')}){${STILL}}}`);
  rule(`${S}[cd-motion="off"] :is(${OWN.join(',')})`, STILL);

  return rules.join('\n');
}
