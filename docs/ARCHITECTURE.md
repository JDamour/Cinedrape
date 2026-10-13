# Cinedrape — Build Contract (MVP: F1–F6)

Source of truth for *what* to build: `../YouTube Skin Studio — Product Spec.md`.
This file is the source of truth for *how the pieces fit*: file ownership, exact APIs, shared names,
and the DOM facts verified against live YouTube. Every module agent works to this contract so the
pieces plug together without negotiation. If the contract is wrong or impossible, make the smallest
change that fixes it, **edit this file in the same change**, and say so in your final report.

## 0. Conventions

- Plain JavaScript ES modules + JSDoc types. **No TypeScript, no runtime dependencies** in `src/`.
  Dev deps only: `esbuild`, `jsdom`, `puppeteer-core` (e2e).
- Style: 2 spaces, semicolons, single quotes, `const` first. Comments only for non-obvious *why*.
- `src/shared/**` is pure (runs in Node tests, service worker, content script, popup): no `chrome.*`,
  no DOM globals except where a function takes `doc`/`win` as a parameter.
- Anything touching `chrome.*`, `document` or `window` receives them as injected parameters
  (`deps`) so tests can pass `test/helpers/chrome-mock.js` and a jsdom window.
- No `eval`, `new Function`, remote code, remote fonts, or network calls from content scripts.
- Tests: `node:test` + `node:assert/strict`, files `test/**/*.test.js`, run with `npm test`.
  DOM tests use jsdom through `test/helpers/dom.js`. Tests must run without a network.
- Never hide, move out of view, cover or restyle-to-invisible any ad or sponsorship disclosure
  (see §6). This is a hard rule, not a preference, and it is tested.
- **`__DEV__`**: esbuild defines it (`false` unless `--dev` / `CINEDRAPE_DEV=1`). Always read it as
  `typeof __DEV__ !== 'undefined' && __DEV__`, otherwise importing the module under `node:test` throws a ReferenceError.
- **Test environment = jsdom 29.1.1 (verified, pinned by `test/helpers/selectors-in-jsdom.test.js`).** `:has()`, `:is()`,
  `:where()`, `:not(:has(…))` and relative `:has(> a)` work in `querySelector`, `matches`, `closest` and in `getComputedStyle`
  for top-level rules, so no `:has()` fallback is needed in code or tests. Limits that shape how tests are written:
  (1) rules inside `@media`/`@supports` are parsed (`cssRules`) but never applied by `getComputedStyle`, so check at-rule CSS by
  scanning the generated string; (2) `getComputedStyle` does not resolve `var()` inside ordinary properties (custom properties
  themselves do resolve), so assert on the CSS text or on `--cd-*` values; (3) no layout (every rect is 0), no
  `adoptedStyleSheets`, and no `matchMedia`/`IntersectionObserver`/`ResizeObserver`/`CSS.supports` (the last four are shimmed by
  `installShims`), so geometry, scrolling and the constructable-stylesheet CSP fallback are e2e-only; (4) duplicate-id bug:
  `el.querySelector('#x')` returns null when an earlier element *outside* `el` has the same id. YouTube reuses ids everywhere
  (`#content` in every tile), so build pages with `createPage()` (installs a `[id="x"]` rewrite) or write `[id="x"]` yourself.
- **Test helpers.** `test/helpers/dom.js`: `createPage(kind, {tiles, ads, shorts, dark, rename, tileStyle, …})` for
  `home|watch|search|channel|subscriptions|history|playlist`, `createTile`, `navigateTo` (fires the three `yt-*` events),
  `applyRename` (simulate a YouTube markup change). `createPage('home')` produces channel-grid tiles unless you pass
  `tileStyle:'home'` (the real home tile shape, see §1), so tile tests must exercise both. `test/helpers/chrome-mock.js`:
  `chrome.storage` (callback and promise forms, `onChanged`; `sync` enforces quotas; values are JSON-cloned), `runtime.sendMessage`
  rejects / sets `lastError` when nobody answers, `alarms.fire(name)`, `tabs`. Fixture provenance: `test/fixtures/README.md`.
- **Working in parallel.** Unit tests are exactly `test/**/*.test.js`; helpers and `test/e2e/run.mjs` must not match that glob.
  While several agents share the tree, run only your own files (`node --test test/<yours>.test.js`). `npm run build` empties and
  rewrites the shared `dist/`, so concurrent builds corrupt each other; full `npm test` and `npm run build` belong to the
  integration step. To bundle-check a module in isolation use esbuild from a scratch script.

## 1. Verified YouTube DOM facts (live, desktop, logged-out, 7 Oct 2026)

These come from probing real pages, not guesses. Re-verify before relying on anything not listed.

**Theming variables.** `--yt-spec-*` no longer exists at `:root`. YouTube's colours now come from
`--yt-sys-color-baseline--*` (set on `html`, dark mode = `html[dark]` attribute) and
`--yt-deprecated-general-background-{a,b,c}`. Measured dark values: `base-background #0f0f0f`,
`raised-background #212121`, `menu-background #282828`, `surface-container #181818`,
`text-primary #f1f1f1`, `text-secondary #aaa`, `text-disabled #717171`,
`outline rgba(255,255,255,.2)`, `outline-opaque #3f3f3f`, `call-to-action #3ea6ff`,
`call-to-action-hover #65b8ff`, `additive-background rgba(255,255,255,.1)`.
`body` is transparent; `ytd-masthead` is transparent.
Older cohorts may still use `--yt-spec-*`, so the colour bridge lists both (see `vars` in §3.1).
**Corrections verified with the real-Chrome harness (2026-10-08, Chrome 154, logged out; `test/e2e/out/BASELINE.md`).** A fresh profile gets
YouTube in LIGHT mode (no `html[dark]`); dark is the `PREF` cookie `f6=400` (light `f6=80000`). (1) `<html>` is painted by an inline
`<style>` in BOTH modes, with `!important`: `html{background-color:#fff!important}` and `html[dark]{background-color:#0f0f0f!important}`;
the base-background variable does not reach it, and `ytd-app` paints with `background:var(--t…)`. (2) Most colour tokens exist twice: the readable
`--yt-sys-color-baseline--*` and an obfuscated twin `--t<16 hex>` with the identical light and dark values (matched by value pair), and the
stylesheet reads ONLY the twin (`.title.ytd-mini-guide-entry-renderer{color:var(--tffc2fd3a644f6275)}`, `.ytSpecButtonShapeNextMono.ytSpecButtonShapeNextFilled{color:var(--t6216186c28b3834b)}`),
so a bridge that knows only the readable names recolours half of the page; `tokens.js` carries the twins it found as a fallback beside `map.vars`.
(3) In dark mode `ytd-masthead` carries its own `dark` attribute and YouTube's `[dark]` block redefines the whole palette on it. (4) Attributed
strings (channel header, descriptions) carry an inline `style="color: rgb(…)"` resolved for the current mode, and `[use-custom-colors]` components
(search summary card, chapters) carry an inline `--yt-lightsource-*` palette: only `!important` beats an inline style. (5) The wordmark's text paths
inherit `yt-icon.ytd-logo{color:var(--t…)}` (black in light mode). (6) `body` has `overflow:scroll` and a 0 px height, so its overflow is the viewport's.

**Home / channel grid.** `ytd-browse[page-subtype=home|channels|…]` →
`ytd-two-column-browse-results-renderer > #primary > ytd-rich-grid-renderer` →
`#contents` (display:flex) → `ytd-rich-item-renderer > #content > yt-lockup-view-model`.
Grid carries `elements-per-row`, `is-slim-grid` and an inline `style` with `--ytd-rich-grid-items-per-row`
etc. A `ytd-continuation-item-renderer` sits at the end of `#contents` and triggers infinite scroll —
**it must stay on screen/in layout or loading stops.** `#header` precedes `#contents` (channel: `chip-bar-view-model`;
home: `ytd-feed-filter-chip-bar-renderer` > `yt-chip-cloud-chip-renderer`; search: `yt-chip-cloud-renderer`: the `chips`
role needs all three). Empty `#masthead-ad` containers sit above the grid on home/channel/playlist pages.
Logged-out home is usually an empty state (after watching a video in the same session it showed a small populated feed), so
the real home grid is hard to observe: home fixtures are derived from the channel grid (same renderer) and marked as such.
Live home wrapper facts: `ytd-browse[page-subtype=home]`, `ytd-two-column-browse-results-renderer.grid.grid-disabled`,
grid attributes `elements-per-row` + `is-default-grid` (no `is-slim-grid`; channel pages do have it).

**Tile anatomy (2026).** Inside `yt-lockup-view-model`:
`a.ytLockupViewModelContentImage[href^="/watch"]` (thumbnail link; text = duration; `aria-hidden`),
`.ytThumbnailViewModelImage img` (thumbnail; `src` may be absent until lazy-loaded),
`.ytBadgeShapeText` (duration, e.g. `1:34:31`; `badge-shape[aria-label]` has the spoken form),
`h3.ytLockupMetadataViewModelHeadingReset[title]` containing `a.ytLockupMetadataViewModelTitle[href]` →
`span.ytAttributedStringHost` (title text),
`.ytContentMetadataViewModelMetadataRow`s containing `span.ytContentMetadataViewModelMetadataText`s separated by
`.ytContentMetadataViewModelDelimiter`. **The metadata shape differs by page, so never assume "first text = view count":**
channel grid = one row `views, age` (no channel, no avatar, `ytLockupViewModelVertical`); home = `.ytLockupMetadataViewModelAvatar` +
ONE row `channel, views, age` (three texts; seen live, not captured); watch-related and playlist rows (`ytLockupViewModelHorizontal`,
avatar present) = row 1 `channel` (can hold several names), row 2 `views, age` (age may read "Streamed 1 day ago").
`extractTile` and the `viewCounts` hider must handle all three. **Live 2026-10-07 (home feed, correcting the above):** rows also hold
icon spans between the texts (`span.ytIconWrapperHost.ytContentMetadataViewModelLeadingIcon` before the views, a Verified
`span.ytIconWrapperHost.ytContentMetadataViewModelIcon` after the channel) that the trimmed fixtures stripped, so never index children:
count only `.ytContentMetadataViewModelMetadataText` siblings. A home row is `channel, views, age` (three texts), `channel, 591 watching`
for a live stream (two texts), `channel, and other channel, views, age` for a collab (four texts), and may be followed by an icon-only
row. Home also shows Mix tiles (`ytLockupViewModelCollectionStack2`, one row `channel, Playlist`) and Shorts-shelf cells. Live tiles carry a
`LIVE` badge plus an empty second badge in `yt-thumbnail-bottom-overlay-view-model`; "New"/"Auto-dubbed" badges are separate top overlays.
The selector map's `viewCounts`/`tileChannel` encode this (see `test/data/LIVE-VERIFICATION.md`). Thumbnail corner radius is on `yt-thumbnail-view-model`
(12px, `overflow:hidden`), not on the `img`. Class names are the new `yt…ViewModel…` camelCase style;
legacy `ytd-rich-grid-media`, `ytd-video-renderer`, `ytd-compact-video-renderer`, `a#video-title`, `a#thumbnail`
still exist on search results and must stay as fallbacks. A **playlist/collection lockup** (`yt-lockup-view-model` with
`ytLockupViewModelCollectionStack2`, `yt-collection-thumbnail-view-model`; search results) also has
`a.ytLockupViewModelContentImage[href^="/watch"]` (to `/watch?v=…&list=…`) and a "753 videos" badge, so tile collection must
exclude it explicitly or it looks like a video tile.

**Search.** `ytd-search > ytd-two-column-search-results-renderer > … ytd-section-list-renderer >
ytd-item-section-renderer > #contents` holds `ytd-video-renderer` (with `a#thumbnail`, `a#video-title`,
`ytd-thumbnail`), and `yt-lockup-view-model` for playlists/collections (see the caution above). Chips: `yt-chip-cloud-renderer`.

**Playlist.** `ytd-browse[page-subtype=playlist]` holds a sidebar `yt-page-header-renderer` and
`ytd-two-column-browse-results-renderer > #primary > yt-section-list-renderer` (new view-model family, not
`ytd-section-list-renderer`) > `.ytSectionListRendererContents > yt-item-section-renderer > #contents > div >
yt-lockup-view-model` (`div.ytLockupViewModelHorizontal` inside). Infinite scroll uses **`yt-continuation-item-view-model`**,
not `ytd-continuation-item-renderer`: the `continuation` role needs both.

**Shell.** `ytd-app > #content > (#masthead-container > ytd-masthead, tp-yt-app-drawer#guide, ytd-mini-guide-renderer,
ytd-page-manager#page-manager)`: `ytd-masthead` is not a direct child of `ytd-app`, and the bar is painted by
`ytd-masthead #background`, so masthead skin rules must target `#background`.

**Watch.** `ytd-watch-flexy` (attrs seen: `video-id`, `is-two-columns_`/`is-single-column`, `theater`,
`fullscreen`, `full-bleed-player`, `hide-watch-next`, `cinematics-active`) contains `#columns`,
`#primary` (`#primary-inner`, `#player` → `#player-container-outer/inner` → `ytd-player#ytd-player` →
`#movie_player.html5-video-player` with `.html5-video-container video.html5-main-video`, `.ytp-chrome-bottom`),
`ytd-watch-metadata` (`#title h1`, `#above-the-fold`, `#info-container`; the view count is
`ytd-watch-info-text #info-container #info > span:first-child`: `ytd-video-view-count-renderer` is gone and `#view-count` is empty),
`ytd-comments#comments` (`ytd-comments-header-renderer`, count in `#count`), and `#secondary` (`#related`,
`ytd-watch-next-secondary-results-renderer` whose items are now `yt-lockup-view-model`).
End screens: `.ytp-ce-element`, `.ytp-ce-covering-overlay`, `.ytp-endscreen-content`.
`ytd-app` gets `is-watch-page`. Mini player: `ytd-miniplayer`.
**Ad/sponsor containers exist, empty, on every watch page** (so the guard selectors can be tested against real markup):
`.ytp-paid-content-overlay` (children `-indicator/-icon/-text/-chevron`), `.ytp-ad-progress-list`, `#related > #player-ads`,
`ytd-ads-engagement-panel-content-renderer`, `.ytp-suggested-action`; `#masthead-ad` on grids. List them under `protected.ads`
/ `protected.sponsor` together with the in-player `.ytp-ad-module` and `ytd-ad-slot-renderer`.

**Navigation.** YouTube is an SPA. It fires `yt-navigate-start`, `yt-navigate-finish`, `yt-page-data-updated`
on `document`/`window`. `ytd-page-manager` holds the current page element as its child, plus a **hidden `ytd-watch-flexy` skeleton on
every non-watch page** (seen on first load too), so watch roles "exist" off the watch page: decide the page from `detectPageType`,
never from role presence. One `ytd-browse` is reused for home/channel/playlist/subscriptions/history with only `page-subtype` swapped.
Layout renderers must react to these events and to targeted MutationObservers; **no polling.**

**Shorts.** Shapes seen live (logged out): search results use `grid-shelf-view-model` >
`ytm-shorts-lockup-view-model-v2 > ytm-shorts-lockup-view-model`; a channel's Shorts tab is
`ytd-rich-grid-renderer[is-shorts-grid]` > `ytd-rich-item-renderer[is-shorts-grid]` > `ytm-shorts-lockup-view-model-v2` (it has no
`yt-lockup-view-model`). `ytd-reel-shelf-renderer` did **not** appear on any reachable page (kept as a fallback, *synthetic* fixture
only). `ytd-rich-shelf-renderer[is-shorts]` (inside `ytd-rich-section-renderer > #content`) **did** appear on a populated logged-out
home (2026-10-07): its cells are `ytd-rich-item-renderer[is-shelf-item]` (no `is-shorts-grid`), they are counted by `ytd-rich-item-renderer`
but not by `[rendered-from-rich-grid]`, and the `#contents-container` wrapper sits between shelf and cells.
`a[href^="/shorts/"]` is the stable cross-shape handle. Nav entry: only `ytd-mini-guide-renderer a[href="/shorts/"]` has an href;
the full-guide `ytd-guide-entry-renderer` Shorts entry has **no href** (just `title="Shorts"`), so `shortsNavEntry` must use the
mini-guide link or `a[title="Shorts"]`, never `ytd-guide-entry-renderer a[href^="/shorts"]`. Which one exists depends on the viewport:
at 1440px the mini guide is `hidden` and empty and only the full-guide `a[title="Shorts"]` exists; at 1000px the mini guide is
populated and the full guide is not rendered; on `/watch` neither is rendered (so `shortsNavEntry` is not expected on watch pages).

**CSP.** Cross-origin requests from a YouTube page to localhost are blocked by tooling policy, so fixtures
are captured through the browser tool's return value, never by POSTing out of the page.

## 2. Directory layout and ownership

```
docs/ARCHITECTURE.md                this file
manifest.json                       MV3 source (copied to dist/)         [scaffold]
build.mjs  package.json             esbuild build, budgets, scripts      [scaffold]
tools/                              gen-keys, sign-map, dev-licence       [trust]
src/shared/constants.js             names & defaults (verbatim §3.2)     [scaffold]
src/shared/theme-schema.js          theme format validation/normalise    [theme-core]
src/shared/contrast.js              WCAG maths                           [theme-core]
src/shared/entitlements.js          tier gating + EffectiveConfig        [theme-core]
src/shared/css-validator.js         theme CSS validator                  [css-validator]
src/shared/selector-map.js          map helpers, allow-list, safeHide    [css-validator]
src/shared/signing.js licence.js    verify envelopes / licence tokens    [trust]
src/shared/public-keys.js           generated public JWKs                [trust]
src/shared/tokens.js                theme tokens → CSS variables         [skin]
src/data/selector-map.source.json   role → selectors, protected, vars    [selectors]
src/data/selector-map.signed.json   signed envelope (generated)          [trust tool]
src/content/selectors.js health.js page.js notice.js                     [selectors]
src/content/skin.js                 base skin CSS per page               [skin]
src/content/layouts/{tiles,home,watch,density}.js                        [layouts]
src/content/calm.js                                                      [calm]
src/content/{stylesheet,engine,style-injector,index}.js                  [engine — phase 2]
src/background/{service-worker,licence-manager,map-updater}.js           [background]
src/popup/{popup.html,popup.css,popup.js,…}                              [popup]
src/themes/{cinema,minimal,classic,primetime,studio,arcade}.json,index.js [skin]
test/helpers/{chrome-mock,dom}.js   test/fixtures/real/*.html            [scaffold, fixtures]
test/**                             one test file per module, next to its owner's work
```

An agent edits only files it owns. If it needs a change in another module, it records that in its final
report (as a `needs:` line) instead of editing — except trivial contract-conformance fixes.

## 3. Shared data shapes

### 3.1 Selector map (data file the server can update without a store release)

Source `src/data/selector-map.source.json`, shipped as a signed envelope
`{ "payload": "<canonical JSON string>", "sig": "<base64url ECDSA-P256-SHA256>", "kid": "selector-map-1" }`.
`payload` parses to:

```jsonc
{
  "schema": 1,
  "mapVersion": "2026.10.07.1",          // monotonically increasing; downgrade rejected
  "issuedAt": "2026-10-07T00:00:00Z",
  "roles":     { "<role>": ["selector 1", "fallback 2", "fallback 3"] },   // 2–3 selectors each
  "pageRoles": { "home": ["homeGrid","videoTile"], "watch": ["watchPlayer", …], … },   // roles expected per page type
  "requires":  { "<featureId>": ["<role>", …] },   // roles a feature needs on the pages it runs on
  "protected": { "ads": ["<sel>"], "sponsor": ["<sel>"], "playerControls": ["<sel>"],
                 "containers": ["<sel>"] },   // elements that may CONTAIN an ad (ytd-rich-item-renderer, ytd-rich-section-renderer,
                                              // ytd-item-section-renderer, #player, #movie_player, ytd-watch-flexy, #contents …):
                                              // a hide rule whose subject is one of these must carry the :not(:has(ads)) guard
  "vars":      { "bg": ["--yt-sys-color-baseline--base-background", "--yt-deprecated-general-background-a", "--yt-spec-base-background"],
                 "surface": […], "menu": […], "text": […], "muted": […], "accent": […], "accentHover": […],
                 "border": […], "borderOpaque": […], "overlay": […] },   // colour bridge: token → every YouTube var to set
  "tileFields": { "link": […], "title": […], "thumb": […], "duration": […], "channel": […], "meta": […] }
}
```

Map data rules (checked by `test/data/selector-map-data.test.js`): each entry of a role/protected list is ONE complex selector with no
top-level comma (callers split, suffix and wrap on that); `roleCss` unions all entries while `selectors.find/findAll` use the first
non-empty one, so a page that mixes shapes (search: a playlist lockup next to `ytd-video-renderer`) returns only the first shape
from `find`; the optional top-level `_unverified: string[]` lists roles that cannot be verified logged out (ignored by the engine).
**Health semantics:** a feature `F` is evaluated on page type `P` only for the roles in `requires[F]` ∩ `pageRoles[P]` (that is what
`pageType` is passed for), so `requires` lists roles that exist on every healthy page of that kind (including an empty-state page) and
`pageRoles` may be broader (expected roles, used for counters). `continuation`, tile roles and Shorts roles are never required: they
vanish legitimately.

Required role names (agents reference these; **selectors** may add more):
`app pageManager masthead guide miniGuide homeBrowse homeGrid homeGridContents richItem videoTile
tileLink tileTitle tileThumb tileDuration tileChannel tileMeta continuation chips
watchFlexy watchPlayer watchPlayerContainer watchPrimary watchSecondary watchRelated watchMetadata watchTitle
comments endScreens viewCounts shortsShelf shortsNavEntry shortsTiles
searchResults channelHeader subscriptionsGrid historyList playlistPanel`.
Protected groups are matched by selector, never by role name: `ads`, `sponsor`, `playerControls`.
Roles must cover every live shape listed in §1, with the older shapes kept as fallbacks (2–3 selectors per role is a guide, not a
cap where §1 lists more shapes): `chips` (3 chip renderers), `continuation` (`ytd-continuation-item-renderer` and
`yt-continuation-item-view-model`), `shortsShelf` / `shortsTiles` (`grid-shelf-view-model`, `ytm-shorts-lockup-view-model-v2`,
`ytd-rich-grid-renderer[is-shorts-grid]`, then `ytd-reel-shelf-renderer`, `ytd-rich-shelf-renderer[is-shorts]`, and
`a[href^="/shorts/"]`), `shortsNavEntry` (mini-guide link, `a[title="Shorts"]`), `viewCounts` (watch info text, tile metadata
position per shape), `playlistPanel` (the playlist lockup list), `masthead` skinning (`#background`).

### 3.2 `src/shared/constants.js` (scaffold writes this verbatim; others import, never redefine)

```js
export const STYLE_ID = 'cinedrape-theme';
export const CD_PREFIX = 'cd-';
export const ATTR = {            // attributes set on <html> by the engine
  theme: 'cd-theme', page: 'cd-page', home: 'cd-home', watch: 'cd-watch', watchLive: 'cd-watch-live',
  density: 'cd-density', motion: 'cd-motion', textScale: 'cd-textscale', calmPrefix: 'cd-calm-', offPrefix: 'cd-off-',
};
export const SRC_ATTR = 'cd-source';      // on a YouTube tile Cinedrape has mirrored into its own card
export const PAGE_TYPES = ['home','watch','search','channel','subscriptions','history','playlist','shorts','other'];
export const CALM_KEYS = ['hideShorts','hideHomeRecs','hideComments','hideEndScreens','hideViewCounts','hideLive'];
export const FREE_CALM_KEYS = ['hideShorts','hideHomeRecs'];
export const FEATURES = ['theme','layout-home','layout-watch','density',
  'calm-hideShorts','calm-hideHomeRecs','calm-hideComments','calm-hideEndScreens','calm-hideViewCounts','calm-hideLive'];
export const ALL_THEME_IDS = ['cinema','minimal','classic','primetime','studio','arcade'];
export const FREE_THEME_IDS = ['cinema','minimal','classic'];
export const LAYOUT_HOME = ['grid','rows','hero-rows'];
export const LAYOUT_WATCH = ['default','cinema','focus'];
export const STORAGE_KEYS = { settings:'cd.settings', licence:'cd.licence', selectorMap:'cd.selectorMap',
  health:'cd.health', telemetry:'cd.telemetry', firstPaint:'cd.firstPaint' };
export const DEFAULT_SETTINGS = { schema:1, themeId:'cinema', accent:null, density:null, animations:true,
  textScale:null, calm:{ hideShorts:false, hideHomeRecs:false, hideComments:false, hideEndScreens:false, hideViewCounts:false, hideLive:false },
  telemetryOptIn:false };
export const LIMITS = { cssMaxBytes:20480, contentMaxChars:100, offlineGraceMs:30*864e5,
  licenceRecheckMs:7*864e5, mapRefreshMs:6*36e5, maxBrowsersPerLicence:3 };
export const MSG = { GET_STATUS:'cd:getStatus', ACTIVATE_LICENCE:'cd:activateLicence',
  GET_LICENCE:'cd:getLicence', REFRESH_MAP:'cd:refreshMap', STATUS_CHANGED:'cd:statusChanged' };
export const FIRST_PAINT_LS_KEY = 'cd:v1:firstPaint';   // localStorage key used by the engine (§5)
```

### 3.3 Theme file — exactly the spec's "Theme format" section. Normalised form fills defaults:
`tokens.shape = {radius:12, shadow:false, spacing:3}`, `layout = {home:'grid', watch:'default', density:3}`,
`calm = {}`, `css = ''`. Fonts are **keys** into `FONT_STACKS` (all system fallbacks, nothing downloaded):
`Inter` (`Inter, system-ui, …`), `System`, `Serif` (`Georgia, 'Times New Roman', serif`),
`Mono`, `Rounded`, `Condensed`. Unknown font → error.

### 3.4 EffectiveConfig (single object every CSS builder receives)

```js
{
  theme: NormalizedTheme,                // already tier-checked: if the stored theme is Pro and the user is free → fall back to 'cinema'
  accent: '#rrggbb' | null,
  animations: boolean,                   // also forced false when prefers-reduced-motion (engine decides)
  textScale: 0.9 | 1 | 1.1 | 1.25 | 1.5 | null, // free accessibility scale (null = theme default 1)
  home: 'grid'|'rows'|'hero-rows',
  watch: 'default'|'cinema'|'focus',
  density: 1|2|3|4|5,                    // settings.density ?? theme.layout.density; free users get the theme's own value
  calm: { hideShorts, hideHomeRecs, hideComments, hideEndScreens, hideViewCounts },   // effective: free users only keep FREE_CALM_KEYS
  disabled: string[],                    // FEATURES turned off by the health check
  pro: boolean
}
```
`computeEffectiveConfig({settings, licenceState, themes}) → EffectiveConfig` lives in `entitlements.js`.
Licence state: `{ plan:'free'|'pro', status:'none'|'active'|'grace'|'expired' }` (from `licence.js`); only `plan:'pro'` with status `active|grace` is Pro.

### 3.5 Page-level contract on `<html>`

Engine sets attributes `cd-theme=<id>`, `cd-page`, `cd-home`, `cd-watch`, `cd-watch-live` (present on live stream watch pages), `cd-density`, `cd-motion=on|off`,
`cd-textscale` (present when textScale is set: 0.9, 1, 1.1, 1.25, 1.5), `cd-calm-<key>` (present = on), `cd-off-<feature>` (present = health-disabled).
CSS variables written on `html[cd-theme]` (names fixed): `--cd-bg --cd-surface --cd-text --cd-muted --cd-accent
--cd-accent-text --cd-border --cd-radius --cd-shadow --cd-space --cd-font-family --cd-font-size
--cd-heading-weight --cd-gap --cd-card-min --cd-row-gap --cd-duration`.
Own DOM classes (all `cd-` prefixed): `cd-home cd-hero cd-hero-media cd-hero-body cd-hero-title cd-hero-meta
cd-hero-cta cd-hero-live cd-row cd-row-title cd-row-track cd-row-prev cd-row-next cd-card cd-card-thumb cd-card-title
cd-card-meta cd-card-duration cd-card-channel cd-card-views cd-card-info cd-card-watching cd-live-badge cd-live-dot cd-notice`.
A live tile (`extractTile`'s `isLive`: the bottom-overlay badge text is not a duration, language-independent) shows a
`cd-live-badge` (fixed `#cc0000` pill, white text 5.9:1, decorative `cd-live-dot` that pulses via the `cd-live-pulse`
`@keyframes` — transform only, never opacity) instead of the duration pill, marks its viewer count `cd-card-watching`
(hidden by calm's hideViewCounts like `.cd-card-views`), and hero-rows prefers a live tile for the hero with a
"Watch live" call to action. Dedicated `#cd-row-live` gathers live tiles at the top of the feed rows.
The Pro calm toggle `hideLive` (`html[cd-calm-hidelive]`) hides mirrored live cards, the live hero, the `#cd-row-live` row, and mirrored YouTube wrappers marked `cd-live`.
On watch pages (`ytd-watch-flexy`), when the viewer count matches live watching patterns (`isWatchLive`), the engine sets
`html[cd-watch-live]`. `buildWatchLiveCss` restyles the info container / view count with `#cc0000` accents and a decorative
pulsing live dot (`::before` with `cd-live-pulse`), leaving the player completely untouched.
The pulse is emitted only when `cfg.animations !== false` and is disabled in the `prefers-reduced-motion` block.

## 4. Module contracts

All builders are pure `(map, cfg) → string` unless noted. The final stylesheet the engine injects is
`[tokenCss, skinCss, densityCss, homeLayoutCss, watchLayoutCss, calmCss, themeCss].join('\n')`, where
`themeCss` is the theme's own validated `css` (skipped if validation fails — never inject unvalidated CSS).

**shared/theme-schema.js** — `validateTheme(input, opts?: {selectorMap?}) → {ok, errors:[{path,message}],
warnings:[…], theme|null}` (normalised, defaults filled; CSS validated when `selectorMap` given and errors
carry `line`); `migrateTheme(input)`; `LATEST_SCHEMA`; `FONT_STACKS`. Colours: `#rgb #rrggbb #rrggbbaa`,
`rgb()/rgba()/hsl()/hsla()`. `id` must be a slug `^[a-z0-9-]{2,40}$`. `css` max `LIMITS.cssMaxBytes`.

**shared/contrast.js** — `parseColor`, `relativeLuminance`, `contrastRatio(a,b)`, `pickReadableText(bg)`,
`checkThemeContrast(theme) → [{pair, ratio, required, pass}]` covering text/bg, text/surface, muted/bg,
muted/surface (4.5:1) and accent/bg, border/bg (3:1). Every launch theme must pass.

**shared/entitlements.js** — `isThemeAllowed(theme, licenceState)`, `canSetDensity(licenceState)`,
`allowedCalmKeys(licenceState)`, `computeEffectiveConfig(...)` (§3.4). Pure; stored preferences are never mutated, so
a lapsed licence silently falls back and restores when renewed.

**shared/css-validator.js** — `validateCss(css, ctx:{allowList, protectedSelectors}) → {ok, errors:[{line,column,message}]}`
and `buildAllowList(map)`. Own tokenizer (comments, strings, nested `@media`/`@supports`). Rules from the spec:
selectors may target only `cd-` classes/ids/attributes or simple selectors present in the selector map (plus
structural: `html body :root *` is **not** allowed bare, but `html[cd-…]` is; pseudo-classes/elements are allowed);
block `@import @font-face @namespace @charset`, `expression()`, `behavior`, `-moz-binding`, `url()` other than
`data:image/(png|jpeg|webp|svg+xml)` (svg must contain no `http`/`href` to outside) or `chrome-extension://`;
`content` values over 100 chars; `@keyframes` names must start `cd-`; and **refuse any rule that hides, collapses,
covers or fades (display:none, visibility, opacity<1, height/width/max-*:0, clip, position+z-index overlays,
transform scale(0), filter, pointer-events over…) an element matching `protected.*`**, or a bare/universal
selector carrying those properties. Errors name the 1-based line.

**shared/selector-map.js** — `validateMapShape(map)`, `roleCss(map, role) → string` (comma-joined selector list),
`safeHide(map, selector) → string` (= `selector:not(:has(<ads css>))` — **every engine-generated hide rule must go
through this**), `protectedCss(map, group?)`, `parseEnvelopePayload(envelope)`.

**shared/signing.js** — `base64urlEncode/Decode`, `verifyEnvelope(envelope, publicKeyJwk) → Promise<{ok, payload?, reason?}>`
(WebCrypto ECDSA P-256 SHA-256 over the UTF-8 bytes of `payload`).
**shared/licence.js** — token = `base64url(JSON claims).base64url(sig)`, claims `{v:1, sub, plan, iat, exp?, devices?}`;
`verifyLicenceToken(token, nowMs, publicKeyJwk) → Promise<{valid, reason, claims}>`;
`licenceState({token, claims, checkedAt}, nowMs) → {plan, status}` (grace = within `offlineGraceMs` of `checkedAt`).
**Claims are bound to the signed token.** The stored record's `claims` are a hand-editable copy, so every decision that can grant
something uses the claims of the VERIFIED token: `claimsMatch(stored, verified)` (plan, sub, iat, exp must agree; a mismatch is
lapsed), `verifiedLicenceState(record, nowMs, publicKeyJwk) → Promise<{plan, status, reason?}>` (the worker's and the popup's
answer; `reason` on an expired state is one of `LAPSE_REASONS`: `token-expired` = the signed exp passed, `not-rechecked` = older
than the grace period, `invalid` = signature/key/time failed or the stored claims disagree) and `lapseReason(record, nowMs)`. The
engine does the same with the result of its own `verifyLicenceToken` call. A token with no `exp` is never "expired".
**public-keys.js** — `SELECTOR_MAP_PUBLIC_KEY`, `LICENCE_PUBLIC_KEY` (JWKs), generated by `npm run keys`; private keys live in
`.keys/` (gitignored, never bundled). Dev keys only: the owner replaces them before any store release.
**tools/** — `gen-keys.mjs` (writes `export const KEY_STATUS = 'dev' | 'production'` into public-keys.js: `dev` by default and after
`--force`, `production` only for `--production`, which makes fresh pairs; production private keys belong in a KMS/HSM or an offline store,
not in `.keys/`), `sign-map.mjs` (`source.json → signed.json`, bumps nothing silently), `dev-licence.mjs`
(`npm run licence:dev -- --plan pro --days 30` prints a token), `package.mjs` (builds and zips; refuses unless `KEY_STATUS === 'production'`,
tested through `readKeyStatus`, never by the header prose; `--allow-dev-keys` for private test builds).

**shared/tokens.js** — `deriveTokens(theme, user:{accent,animations}, map) → Record<string,string>` and
`buildTokenCss(theme, user, map) → string`: writes the `--cd-*` variables on `html[cd-theme]` **and** bridges the
colours onto every YouTube variable listed in `map.vars[...]` (and, beside it, the `LOCAL_VARS` twins of the current build) using selector
`html[cd-theme], html[cd-theme][dark], html[cd-theme]:not([dark]), html[cd-theme] [dark]` (specificity beats YouTube's `html[dark]`; the last part
covers `ytd-masthead[dark]`, which YouTube gives its own palette in dark mode),
sets `color-scheme` from the background's luminance, derives `--cd-accent-text` readable on the accent, and honours the
user accent override (rejecting values that fail 3:1 against bg by falling back to the theme accent).

**content/selectors.js** — `createSelectors(map, doc) → {find(role,root?), findAll(role,root?), has(role,root?),
css(role), setMap(map), map()}`; each role tries its selectors in order and returns the first non-empty match.
Never throws after construction: an explicit `null`/detached/non-node `root` is "nothing" (never "the whole document"), a selector
the engine cannot parse is skipped (and left out of `css(role)`), `setMap` refuses a map without `roles` (returns `false`, old map stays).
**content/page.js** — `detectPageType(doc, loc) → PAGE_TYPES entry`, `detectWatchMode(doc) → 'default'|'theatre'|'fullscreen'`,
`observeNavigation(win, doc, cb) → dispose` (events listed in §1; also a `ytd-page-manager` childList observer; no timers).
`detectPageType` reads the URL only (the hidden watch skeleton makes DOM presence meaningless): hosts other than
`www.youtube.com`/`youtube.com` are `other`, `/shorts/<id>` is `shorts`, `/@handle/shorts` is a `channel` tab, `/live/<id>` and
`/clip/<id>` are `watch`. `detectWatchMode` ignores a `hidden` `ytd-watch-flexy`. `cb` receives `{type, url}` with `type` one of
`yt-navigate-start|yt-navigate-finish|yt-page-data-updated|popstate|page-manager`; one navigation produces several calls, so the
engine coalesces them (same-tick or next frame) instead of re-rendering per call.
**content/health.js** — `createHealth({doc, selectors, map, onChange, onSettled?, readability?}) → {evaluate(pageType, activeFeatures) →
{ok, broken:[{feature, missingRoles}]}, watch(pageType, activeFeatures, {timeoutMs=6000}) → dispose, record(feature,
missingRoles) → boolean, counters(), seedUnreadable(verdict|null), isUnreadable()}`; also exports `measureReadability` and
`READABLE_MIN_RATIO` (3). A feature is broken only when a role it `requires` is still missing after `timeoutMs`
of the page being settled (roles legitimately appear late). `evaluate` is the instant snapshot (it also lists features a
layout reported through `record`); `watch` is the settled check and calls `onChange(result)` only when the picture changes (a
healed page is announced with `{ok:true}`); it re-judges nothing while the tab is hidden. `onSettled(result)` is the other
callback: it fires every time a page finishes settling (the deadline passed, every role appeared in time, or nothing was missing to
begin with) and after a readability verdict, whether or not the picture changed (never from `record()`); the engine persists the
verdict and announces what is paused from it. **Readability sentinel (F6).** A page can have every role and still be unreadable
(YouTube renamed a colour variable: titles at 1.1:1 in the real browser). `watch()` therefore also arms a sentinel that, after the
settle time and only while the theme is applied (`cd-theme` set, no `cd-off-theme`), runs `measureReadability`: it samples up to
five stable text nodes (the masthead search input, two tile titles, Cinedrape's own card/hero title, the watch title on a watch page),
takes the computed text colour and the EFFECTIVE background (ancestors walked, translucent layers composited, the page canvas as the
last fallback) and computes the WCAG contrast. Nodes that are hidden, over a `background-image`, or whose colour cannot be read
(an unresolved `var()`, a colour space it does not parse) are skipped, never counted. Fewer than two samples judge nothing (retried
three times, 3 s apart); a sample below 3:1 must be seen twice, 2.5 s apart. Then `theme` is reported broken (`{feature:'theme',
missingRoles:[]}`), the engine fails open to YouTube's own look and raises the usual notice. The verdict is sticky while the theme is
off (nothing can be measured then), applies only to that theme under that `mapVersion`, and a passing measurement removes it.
`seedUnreadable` restores it from the persisted verdict. Counters are anonymous
`{roles:{<role>:count}, themeId}` — only map role names and a built-in theme id (else `null`) can ever enter them — flushed
only when `telemetryOptIn`; **in the MVP there is no network flush at all.**
**content/notice.js** — `showNotice(doc, {features, onDismiss}) → HTMLElement|null` (`div.cd-notice[role=status]`, dismiss
button, keyboard operable, shown once per feature per session, never covers the player or its controls). `features` takes feature ids or
`health.evaluate().broken` entries directly; the result is `null` when every feature was already announced. "Session" = the
document plus `sessionStorage['cd:v1:noticeShown']` (feature ids only), so a reload of a still-broken page does not nag. A notice must not outlive the problem:
`retireNotice(doc, features)` (the engine calls it when a paused feature comes back healthy) takes those features out of the sentence and removes the
notice when none are left; it is not a dismissal (`onDismiss` is not called) and the features stay announced for the session, so a flapping feature does not
bring the notice back. The notice is
the first child of `<body>` (never inside the player, app shell or an ad container), takes no focus, and styles itself through the
CSSOM so it works with no stylesheet. **Placement:** the first viewport corner that overlaps none of `DEFAULT_AVOID` (the player and
its `.ytp-chrome-bottom` control bar, in-player ad UI `.ytp-ad-module`/`[class*="ytp-ad-"]`, sponsorship UI
`[class*="ytp-paid-content"]`, `ytd-ad-slot-renderer`, `#masthead-ad`); when no corner is free (theatre mode, a narrow window) it is
placed IN THE FLOW under the masthead (`position:relative`, `data-cd-anchor="flow"`) and pushes content down; it is never floated
over the player's controls.

**content/skin.js** — `buildSkinCss(map, cfg) → string`: masthead, guide, chips, buttons, menus, cards (radius, shadow
from tokens), watch-page surfaces, comments, search results, channel, subscriptions, history, playlists. Everything is
expressed in `--cd-*` variables so the six themes differ by data. Honour `cfg.disabled`. Unstyled pages fall back to
YouTube's look (no rule may blank a page).
The skin does not rely on the variable bridge alone (the theme must win in BOTH YouTube modes, so a light theme works under `html[dark]` and a dark
one without it): it sets the page surface explicitly (`html[cd-theme][cd-theme]{background-color:var(--cd-bg)!important}`: YouTube's own `html`
rule is `!important` and ties with a single attribute, our `<style>` sits before `<head>` at `document_start`; then the app shell and page manager),
takes the colour of attributed-string runs that carry an inline colour (`color:inherit!important`; call-to-action links get the accent),
maps the inline `--yt-lightsource-*` palette of `[use-custom-colors]` components onto the theme (`!important`), and colours the wordmark.
`!important` appears only where YouTube forces it (inline styles, its own `!important`), and the e2e readability audit (`test/e2e/README.md`) is
the gate for all of it.
**themes/*.json** — the six launch themes per the spec's briefs; each must pass `validateTheme`, contrast checks and
`validateCss`. `themes/index.js` exports `THEMES` (array, order = ALL_THEME_IDS) and `getTheme(id)`.

**content/layouts/tiles.js** — `extractTile(el, selectors) → {href,title,thumb,duration,isLive,channel,meta,videoId}|null`,
`collectTiles(container, selectors) → Tile[]` (skips ads, playlist/collection lockups, Shorts items and anything without an
`href`+`title`); `isAdTile(el, map)`. **A tile is mirrorable only on positive, marker-independent evidence** (every marker in the map
is a hand-written guess): its primary link is a plain `/watch?v=<11 id characters>` on this origin, and neither it nor the cell
(`richItem`) that holds it, nor its nearest ancestors, carries an anchor that leaves youtube.com or goes through an ad path
(`/pagead/`, `/aclk`, `googleadservices`, `doubleclick`…) or an ad click parameter (`adurl`…), or an ad-shaped tag/class
(`ad`/`ads` as a whole word, `sponsor`, `promoted`, `AdBadge`/`AdSlot`/`AdCta` camel-case parts). `isAdTile` is that evidence OR a
`protected.ads` marker; it fails closed on a map without an ad list. A refused tile stays in YouTube's grid, untouched and never
collapsed. Known limit: an ad with no marker, no ad-shaped name and only ordinary `/watch` links is structurally an ordinary tile. `extractTile` handles the three metadata shapes of §1 (`meta` = all metadata texts in
order, `channel` = the channel text when the shape has one, else `''`).
**content/layouts/home.js** — `createHomeLayout({doc, win, selectors, map, getConfig, onFail}) →
{mount(): boolean, update(), unmount(), isMounted(), getLiveCount(): number}` and `buildHomeLayoutCss(map, cfg)`. Mirrors tiles into
`cd-hero`/`cd-row`s inside a `div.cd-home` placed before the YouTube grid; collapses *mirrored, non-ad* source tiles
via `SRC_ATTR` rules (never `display:none` on the grid itself, never on ad items); keeps `continuation` in layout so
infinite scroll works; appends new tiles as they arrive (MutationObserver on `homeGridContents`, rAF-batched);
rows scroll with mouse (buttons, wheel/drag) and keyboard (←/→, Home/End, visible focus; cards are real `<a href>`s so
history/recs keep working); respects reduced motion; **mounts only after ≥1 card is built, and `unmount()` restores
the original DOM exactly**.
**content/layouts/watch.js** — `buildWatchLayoutCss(map, cfg) → string` (CSS only, `cinema` and `focus`; the player
element is never moved or re-parented); `buildWatchLiveCss(map, cfg) → string` (live presentation under `html[cd-watch-live]`);
`isWatchLive(doc, selectors) → boolean`. **content/layouts/density.js** — `buildDensityCss(map, cfg)` (1 = compact … 5 = roomy;
sets `--cd-gap --cd-card-min --cd-row-gap`, and overrides `--ytd-rich-grid-items-per-row` with `!important` for the home grid).

**content/calm.js** — `buildCalmCss(map, cfg) → string` (static CSS gated on `html[cd-calm-<key>]`, every hide rule via
`safeHide`), `applyCalmAttributes(doc, calm, disabled)`. Home recommendations: hide recommendation tiles but leave ad
items and the page frame intact. Each toggle independent; attributes live on `<html>` so they survive SPA navigation.

**content/stylesheet.js** — `composeStylesheet({map, cfg}) → {css, warnings}`: the builders above in contract order; the theme's
own css only if `validateTheme(theme, {selectorMap: map})` passes (verdict cached per theme id + `mapVersion`); a builder that
throws costs its own part and leaves a warning. `cfg.disabled` reaches every builder; a disabled `theme` drops tokens, skin and
theme css.
**content/style-injector.js** — `createStyleInjector({doc, win})` (the first-paint cache uses `win.localStorage`):
`apply(css) → 'style'|'adopted'|'none'` (text replaced in place, one write; `<style id=STYLE_ID>` in `documentElement`;
verify `sheet.cssRules.length`, fall back to a constructable stylesheet if CSP blocks), `remove()`, `readFirstPaint()`,
`writeFirstPaint(key, css, attrs?)`, `clearFirstPaint()`. The first-paint cache is `localStorage[FIRST_PAINT_LS_KEY] = {v:1,key,css,attrs?}`
(try/catch everywhere; max 64 KB; `isUnsafeCachedCss` refuses entries with imports, remote `url()`, script hooks, any backslash outside
a quoted string, `image-set(`, any at-rule other than @media/@keyframes/@supports and any rule that hides or collapses without the
`:not(:has(<ads>))` guard). This is a filter, **not authentication**: the entry lives in the page's localStorage, any script on
youtube.com can write it, and at `document_start` the extension has no secret to check it against. The structural defences are that
the engine replaces it with its own composed css as soon as `chrome.storage` answers, that the page's scripts already have the
power of an inline style, and that it carries no entitlement). `attrs` is the set of `<html>` attributes the css is keyed on (`cd-home cd-watch cd-density cd-motion cd-calm-*`, names lower case); the engine
applies them in the same synchronous step as the css, so the first frame is already the final look and nothing restyles when storage answers. They are
validated strictly (`sanitizePaintAttrs`: known names, closed value sets, one bad member rejects the whole set; `cd-theme` comes from the key, `cd-page` from the
URL). In addition, the health verdict `{mapVersion, themeId, broken:[feature], pages:{<pageType>:[feature]}, unreadable, at}` is stored beside `{key, css, attrs}` (`sanitizePaintVerdict`),
so broken features are marked `cd-off-*` synchronously at `document_start` before any style or layout mounts and never flash on after full reloads. The engine's `key` is `<themeId>:<fnv1a(css + attrs)>`, read synchronously at `document_start`.
**content/engine.js** — `createEngine({doc, win, chrome, loc, now, themes, bundledEnvelope, publicKeys}) →
{start(), stop(), getStatus(), recompute()}` (test seams: `compose`, `createHealth`, `healthTimeoutMs`); orchestrates state,
navigation, health, feature mount/unmount, `chrome.storage.onChanged` (one pass per animation frame), `MSG.GET_STATUS` replies,
fail-open (any exception removes everything the engine added and logs one `console.warn`), `stop()` (leaves the DOM byte-identical).
Settings live in `chrome.storage.local`; `settings.calm` keeps only what the user stored, so a theme's calm default applies until then.
**Health verdict persistence.** At every settle the engine stores `STORAGE_KEYS.health` in `chrome.storage.local` AND beside the first-paint entry in `localStorage`
(removed from both when every page type is healthy). The next page load starts from it synchronously at `document_start`: the
disabled set of the page type being loaded (else the union) is applied BEFORE the first paint, so a persistently broken feature does
not flash on even for a single frame after a load, and the first settled health result reconciles it (`onSettled` also announces what is
paused: the notice is still shown once per feature per tab session). A verdict for another `mapVersion` is ignored; a readability
verdict is also ignored for another theme and after 24 h (a theme that is off cannot re-test itself: it is retried once a day); a
healthy settle of a page type removes that page type's entry, and the verdict never survives a healthy settle. Plan/sub/exp/iat
come from the verified licence token's claims, never from `record.claims`.
`getStatus() → {themeId, pageType, pro, features:{id:'on'|'off'|'broken'|'locked'}, missingRoles:string[], mapVersion, liveCount: number|null}`.
**content/index.js** — wires real `chrome`, `document`, `window`; the only file with side effects at import time.

**background/** — `service-worker.js` (registers alarms `cd-licence` weekly and `cd-map` every 6 h on install/startup,
routes `MSG.*`; also re-verifies the stored licence locally on install and browser start-up when no `API_BASE` is set),
`licence-manager.js` (`activate(token)`, `getState()` = `verifiedLicenceState` (signature + claims bound to the token, with a
`reason` when lapsed), `recheck()` — with no `API_BASE` it never touches the network but re-verifies the stored token locally
(signature + exp) and on success rewrites `claims` from the signed token and sets `checkedAt = now`, so the token's own `exp` is the
only expiry until a server exists; with an `API_BASE` only a server answer moves `checkedAt`, and the licence keeps working offline for
30 days), `map-updater.js`
(`refreshSelectorMap({fetch, apiBase, now, publicKey, store})` — verifies the envelope, rejects unsigned, tampered or
older `mapVersion`, stores only verified maps; no-op without `apiBase`). No data leaves the browser in the MVP.

**popup/** — accessible vanilla JS: theme switcher (cards with colour swatches, Pro badge + lock), accent colour
(swatches + custom hex, contrast warning), density 1–5 (Pro; shows lock), animations toggle, calm toggles (Pro ones
locked for free), health status ("Home layout is paused — YouTube changed") from `GET_STATUS`, "Activate Pro" token field,
version + not-affiliated line. Writes `cd.settings`; the open tab updates through `storage.onChanged`. It must not depend on the MV3 worker being awake: `GET_LICENCE`
is asked twice (a sleeping or restarting worker may refuse or hang the first message), and if the background still does not answer, the state is computed from the
stored `cd.licence` record with the same function (`licenceFromRecordVerified` = `verifiedLicenceState`: the signature is checked against
`LICENCE_PUBLIC_KEY` and the claims are the signed ones); only when storage itself cannot be read is the licence "unavailable" (Pro
stays locked). Licence wording follows the lapse reason: "Pro expired" only when the token's own expiry passed, "Pro paused"
for a licence that was not re-checked or does not verify (each says "paste your token again"). `ACTIVATE_LICENCE` is repeated once after a refused connection.
Semantic controls only (`button`, `input`, `fieldset`), labelled, focus-visible, reduced-motion, 4.5:1 contrast.

## 5. Build, budgets, scripts

`npm run build` → `dist/` (`manifest.json`, `content.js` IIFE, `service-worker.js` ESM, `popup/*`, `icons/*.png`,
`data/selector-map.json`); fails if `gzip(content.js) > 150 KB` or any file contains `eval(`/`new Function`.
`npm test`, `npm run keys`, `npm run sign-map`, `npm run licence:dev`, `npm run e2e` (phase 3).
`CINEDRAPE_DEV=1 npm run build` defines `__DEV__ = true` (dev-only Pro unlock helper in the popup; stripped otherwise).
Manifest: MV3, `permissions:["storage","alarms"]`, `host_permissions:["https://www.youtube.com/*"]`, content script
`matches:["https://www.youtube.com/*"]`, `run_at:"document_start"`, no `web_accessible_resources`,
`minimum_chrome_version:"105"` (`:has`), name `Cinedrape`, description states it is not affiliated with Google.

Performance budgets from the spec apply: first-paint overhead < 50 ms, theme switch < 150 ms, content script < 150 KB
gzipped, < 30 MB extra memory per tab, no dropped frames scrolling rows.

## 6. Ads, sponsorship and trust rules (non-negotiable, all tested)

1. No rule — theme CSS, skin, layout, calm — may hide, collapse, cover or fade anything matching `protected.ads`,
   `protected.sponsor` or `protected.playerControls`, and no hide rule may target a `protected.containers` subject without the
   `:not(:has(<ads>))` guard (the guard is what keeps an in-feed ad visible when its wrapper tile is hidden). Consequence: the empty
   `#masthead-ad` (inside `ytd-rich-grid-renderer` and `ytd-browse`), `#player-ads` (inside `#related`), `.ytp-ad-progress-list`
   (inside the player) always exist, so a guarded hide of those wrappers (`#secondary`, `#related`, `ytd-rich-grid-renderer`,
   `#movie_player`, `ytd-watch-flexy`) can never match; hide leaf items (tiles, shelves, comments) instead.
2. Every engine-generated hide goes through `safeHide(map, …)`. A test scans all built CSS for hide declarations whose
   selector lacks the `:not(:has(…ads…))` guard and fails the build.
3. Layout renderers never remove, move, clone-and-hide or reparent YouTube nodes; ad items stay visible in YouTube's
   container, which is repositioned *below* the mirrored rows, not hidden.
4. Themes are data. No remote code, ever.
5. **Markers are guesses; evidence is not.** Real ads were never captured, so `protected.ads` also carries marker-independent entries
   (links through `/pagead/`, `/aclk`, `googleadservices`, `doubleclick`, `googlesyndication`, `adurl=`, any anchor that leaves
   youtube.com, ad-shaped class fragments) and tiles.js refuses to mirror anything that is not positively an ordinary `/watch?v=<id>`
   tile (see tiles.js above). `safeHide` fails closed: when any `protected.ads` entry cannot be placed in the guard it returns no rule
   rather than a weaker guard (calm.js already did).

## 7. Decisions on spec ambiguities (flagged to the owner in the final report)

1. **Free vs Pro layouts.** The free Cinema theme's brief needs a hero banner, yet "Layout modes" is Pro. Resolution: a theme's
   own bundled layout applies whenever the *theme* is allowed; the *layout/density controls* that change layout independently
   of a theme are Pro. Free users therefore get Cinema's hero rows but cannot change density.
2. **Roadmap embed missing.** The spec's roadmap figure did not come through; Phase-0 (free theme + waitlist) is out of scope here.
   This build is the MVP extension (F1–F6). No backend, sign-in, payments, sync, AI, marketplace or waitlist page.
3. **Licence activation** is by pasted signed token in the MVP; the weekly re-check is wired but inert without an `API_BASE`.
4. **Colour bridge lives in the signed selector map** (`vars`), because YouTube renamed its variables once already.
5. **Chrome ≥ 105** is required (`:has()`); older Chromium gets no Cinedrape rather than a broken page.
6. **Hide view counts** relies on tile position and `viewCounts` selectors, so it is language-neutral but weaker than the
   others; the position differs per tile shape (§1: first text on the channel grid, second of three on home, first text of
   row 2 on watch-related and playlist rows), and the health check reports it independently.
7. **Licence with no server.** Without an `API_BASE` nothing can refresh `checkedAt`, so the 7/30-day machinery would have lapsed every
   licence a month after activation. The worker re-verifies the stored token locally (signature + `exp`) on every start-up and weekly
   alarm and moves `checkedAt`; the token's own `exp` is the only expiry until a server exists. A lifetime token (no `exp`) is never
   "expired". Decision for the owner: when the backend exists, the same `recheck()` takes the server's word instead.
8. **Theme-brief items deliberately omitted from the MVP** (the spec's launch-theme briefs ask for them; none is implemented, none is
   needed for F1–F6): Minimal "no hover previews on thumbnails" (suppressing `ytd-video-preview` is possible with a guarded rule but is
   not done), Prime Time "large continue watching strip" (YouTube exposes no resume data to a content script without its API; the theme
   only enlarges the first row's title), Classic "using original artwork" (the theme ships gradients and borders, no artwork files),
   and Studio "premium serif headings" apply only to Cinedrape-built titles (hero and row titles), not to YouTube's own watch, search
   and channel headings.
9. **Privacy notes the store listing must state.** (a) Everything Cinedrape writes into the page is readable by YouTube's own scripts:
   the `cd-*` attributes on `<html>` (theme id, density, calm flags), `<style id="cinedrape-theme">`, and the localStorage entry
   `cd:v1:firstPaint` (it reveals the theme id and therefore Pro status); the extension sends nothing, but the origin can fingerprint the
   installation. (b) Uninstalling leaves `cd:v1:firstPaint` (at most 64 KB) in youtube.com's localStorage and the sessionStorage key
   `cd:v1:noticeShown`; chrome.storage.local (settings, licence, map, health verdict) is removed with the extension. (c) The licence
   token, including `claims.sub` (an email by the dev tool's convention), is read by every YouTube tab's content script. (d) Once an
   `API_BASE` exists the weekly re-check POSTs the token, which embeds `sub`; the privacy policy must say so. (e) No privacy-policy
   page exists in the repository yet; the spec requires one.
