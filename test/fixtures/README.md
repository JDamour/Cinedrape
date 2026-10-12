# Cinedrape test fixtures

Markup used by `test/helpers/dom.js` to build jsdom YouTube pages. Captured **2026-10-07**, logged-out, desktop
(viewport emulated at 1440x900, dark mode), through the built-in browser pane. Nothing was sent out of the page: each
capture was cloned and trimmed in-page, returned as a tool result and written to disk by hand (a policy blocks any
fetch/beacon from youtube.com). No cookies, tokens, account data or user comments were captured.

Legend: **REAL** = trimmed capture, tag/attribute/class names verbatim. **DISTILLED** = a REAL page whose boring subtree was
hand-reduced, same tags. **DERIVED** = built by `dom.js` from REAL pieces because the real page is not reachable
logged-out (named below). **SYNTHETIC** = hand-written, never seen on youtube.com; every root carries `data-cd-synthetic`.

## Files

| File | Source / status | Notes |
| --- | --- | --- |
| `real/shell.html` | REAL, `https://www.youtube.com/@NatGeo/videos` | `ytd-app > #content > (#frosted-glass, #masthead-container > ytd-masthead, tp-yt-app-drawer#guide, ytd-mini-guide-renderer, ytd-page-manager#page-manager, #persistent-panel-container)`. Guide trimmed to 5 entries; guide-button re-added as a bare stub. Contains one `PAGE` marker comment inside `ytd-page-manager`. |
| `real/channel-grid.html` | REAL, `/@NatGeo/videos` | `ytd-browse[page-subtype=channels] > ytd-two-column-browse-results-renderer > #primary > ytd-rich-grid-renderer` with `chip-bar-view-model` chips, 4 of 29 tiles, and the real `ytd-continuation-item-renderer`. The channel header (`ytd-tabbed-page-header`) is DISTILLED (avatar, banner, subscribe/links removed). Thumbnails keep `src` (never fetched by jsdom). |
| `real/search-results.html` | REAL, `/results?search_query=nature+documentary` | 3 `ytd-video-renderer` + 1 playlist `yt-lockup-view-model`, 4 of 15 chips, `ytd-continuation-item-renderer`. AI-summary block, menus, `aria-label`s dropped. |
| `real/watch.html` | REAL, `/watch?v=BzpdP2APcIM` (paused, no ad) | Composite of 5 captures: player SKELETON (real class lists; video element; title; overlays; endscreen; 2 real `.ytp-ce-element` cards; `.ytp-chrome-bottom` progress bar + controls), `ytd-watch-metadata`, `ytd-comments#comments` (header + ghost placeholders only), `#secondary` with 4 real related `yt-lockup-view-model`s. About 27 KB because it is five pieces, each under 14 KB. |
| `real/playlist.html` | REAL, `/playlist?list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO` | 3 of 100 loaded rows, sidebar `yt-page-header-renderer` (avatar internals stripped). |
| `real/shorts-shelf.html` | REAL, search results | The 2026 search Shorts shelf: `grid-shelf-view-model`, 3 of 10 items. |
| `real/shorts-grid.html` | REAL, `/@NatGeo/shorts` | `ytd-rich-grid-renderer[is-shorts-grid]`, 2 of 48 items. |
| `real/computed-colors.json` | MEASURED, 4 pages | `getComputedStyle` values and the full set of 12 `--yt-sys-color-baseline--*` values from ARCHITECTURE.md section 1, plus about 20 more. |
| `synthetic/ad-slot.html` | SYNTHETIC | 6 `<template>`s: in-feed ad item, home masthead ad, search ad, in-player `.ytp-ad-module`, populated `.ytp-paid-content-overlay`, related-rail ad. All links go to `ads.example.invalid`. Used to prove Cinedrape never hides ads or sponsorship disclosures. |
| `synthetic/shorts-shelf.html` | SYNTHETIC (items reuse real Shorts markup) | `ytd-rich-shelf-renderer[is-shorts]` (inside `ytd-rich-section-renderer`) and `ytd-reel-shelf-renderer`. Neither tag appeared on any logged-out page on 2026-10-07; they are reconstructed so the selector map's two named Shorts shelf shapes stay testable. |

## What every REAL fixture had stripped

`<svg>`, `<style>`, `<script>`, `<link>`, HTML comments, inline `style`, tooltips (`tp-yt-paper-tooltip`), icons
(`yt-icon`, `yt-icon-button`, `.ytIconWrapperHost`), menu buttons (`ytd-menu-renderer`, `button-view-model`,
`.ytLockupMetadataViewModelMenuButton`), `yt-touch-feedback-shape`, `yt-interaction`, `jslog`/`data-*`tracking and `tabindex`
attributes, `dir`, uninformative `role`s. `style-scope ytd-*` scoping classes were removed; every other class list is intact.
Attributes longer than 90 characters were truncated (this clipped a few `aria-label`s, `sqp=` thumbnail tokens and one
`h3[title]`); whitespace was collapsed; at most 3-4 items were kept per `#contents`. Spinners were emptied. Whole blocks were
dropped where noted in the table.

## DERIVED pages (built in `dom.js`, marked here because they are not captures)

| Page | Derived from | What is real and what is a guess |
| --- | --- | --- |
| `home` | `real/channel-grid.html` | Verified live on 2026-10-07: `ytd-browse[page-subtype=home]`, `ytd-two-column-browse-results-renderer.grid.grid-disabled[disable-grid-state-aware]`, grid attrs `elements-per-row="3" is-default-grid` (no `is-slim-grid`), chip bar is `ytd-feed-filter-chip-bar-renderer > #chips-wrapper > ... iron-selector#chips > yt-chip-cloud-chip-renderer`. Guessed: chip labels, no sections/shelves in the grid. Tiles are the channel-grid shape unless `tileStyle:'home'` (avatar + one row "channel, views, age", which IS the live home shape). |
| `subscriptions` | `real/channel-grid.html` | Verified: `ytd-browse[page-subtype=subscriptions]`, `ytd-two-column-browse-results-renderer.grid.grid-5-columns`. Guessed: a logged-in subscriptions feed is a `ytd-rich-grid-renderer` of lockups with chips (logged-out it is only a "Don't miss new videos / Sign in" empty state). |
| `history` | `real/search-results.html` rows | Verified: `ytd-browse[page-subtype=history]`, `ytd-two-column-browse-results-renderer[has-secondary-column-data]`, secondary column holds "Clear all watch history" / "Pause watch history" buttons. Guessed: logged-in rows are `ytd-video-renderer[is-history]` in `ytd-section-list-renderer > #contents > ytd-item-section-renderer`. |

## Facts discovered while capturing (differences from, or additions to, ARCHITECTURE.md section 1)

1. **Masthead nesting.** `ytd-masthead` is inside `div#masthead-container` inside `ytd-app > #content`, not a direct child of `ytd-app`. The bar is painted by `ytd-masthead #background` (`rgb(15,15,15)`); the host and `#container` are transparent.
2. **Full-guide Shorts entry has no `href`** (only `title="Shorts"`); the **mini-guide** entry is `a[href="/shorts/"]`. A `shortsNavEntry` selector must not rely on `ytd-guide-entry-renderer a[href^="/shorts"]`.
3. **Playlist pages** use the new view-model family: `yt-section-list-renderer > .ytSectionListRendererContents > yt-item-section-renderer > #contents > div > yt-lockup-view-model.ytLockupViewModelWrapper > div.ytLockupViewModelHost.ytLockupViewModelHorizontal` (the `Horizontal` class is on the inner `div`, not on the `yt-lockup-view-model` element), and infinite scroll uses **`yt-continuation-item-view-model`**, not `ytd-continuation-item-renderer`.
4. **Shorts shapes seen live:** search results use `grid-shelf-view-model` with `ytm-shorts-lockup-view-model-v2 > ytm-shorts-lockup-view-model`; a channel's Shorts tab is `ytd-rich-grid-renderer[is-shorts-grid]` whose `ytd-rich-item-renderer[is-shorts-grid]` hold `ytm-shorts-lockup-view-model-v2` (no `yt-lockup-view-model`). `ytd-reel-shelf-renderer` and `ytd-rich-shelf-renderer[is-shorts]` did NOT appear logged-out.
5. **Tile metadata differs by page.** Channel grid: row = `views, age` (no channel). **Home: avatar + one row `channel, views, age`** (three texts). Watch related and playlist rows: first row = channel name, second row = `views, age`. A tile extractor cannot assume "first metadata text = view count".
6. **Search playlist lockup** (`ytLockupViewModelCollectionStack2`, `yt-collection-thumbnail-view-model`) has `a.ytLockupViewModelContentImage[href^="/watch"]` (it links to `/watch?v=..&list=..`), so it looks like a video tile to a naive extractor. Its duration badge reads "753 videos".
7. **Thumbnail corner radius** is on `yt-thumbnail-view-model` (12px, `overflow:hidden`), not on `.ytThumbnailViewModelImage` or the `img` (0px).
8. **Watch view count** lives in `ytd-watch-info-text #info-container yt-formatted-string#info > span:first-child` ("84k views"); `#view-count` is empty in this cohort. Comment count is `ytd-comments-header-renderer #count`.
9. **Real, empty ad/sponsor containers exist on every watch page** and are kept in `real/watch.html`: `.ytp-paid-content-overlay` (with `-indicator/-icon/-text/-chevron` children), `.ytp-ad-progress-list` inside the seek bar, `#related > #player-ads`, `ytd-ads-engagement-panel-content-renderer`, `.ytp-suggested-action`. Home/channel grids carry empty `#masthead-ad` containers. `--yt-sys-color-baseline--static-ad-yellow` is `#fbc02d`.
10. **Logged-out home is not always empty.** After watching a video in the same browser session `/` showed a populated `ytd-rich-grid-renderer` (3 tiles, session-influenced), so it was NOT captured as personal; only attribute names and class names were read.
11. **Viewport matters.** At the pane's default 586px width the channel grid reports `elements-per-row="1"`; the fixtures were captured at 1440px (`elements-per-row="3"`, `is-slim-grid` present on channel pages). Light mode was not measured.
12. **Only 12 of 208 colour variables are asserted** by tests; `--yt-spec-*` is essentially absent from `:root` in this cohort.

## jsdom caveats (pinned by `test/helpers/selectors-in-jsdom.test.js`)

- `:has()`, `:is()`, `:where()`, `:not(:has(...))`, `:has(> a > b)`, `:has(+ x)` and attribute selectors on custom elements all work (jsdom 29.1.1), in `querySelector`, `matches`, `closest` and in `getComputedStyle` for top-level rules. No `:has` fallback is needed.
- **Duplicate-id bug:** raw jsdom `el.querySelector('#content')` returns `null` when an earlier same-id element lies outside `el`. YouTube reuses ids everywhere, so `createPage` installs `installIdFix` (rewrites `#x` to `[id="x"]`) by default; pass `duplicateIdFix:false` to see raw behaviour.
- Rules inside `@media` / `@supports` are parsed (`cssRules`) but not applied by `getComputedStyle`; ad-safety tests must scan generated CSS statically for those.
- No layout (all rects 0), no `document.adoptedStyleSheets`, no `matchMedia` / `IntersectionObserver` / `ResizeObserver` / `CSS.supports` / `scrollIntoView` (the last five are shimmed by `installShims`).

## Refreshing

Capture again through the browser pane at 1440px, logged out, on the same URLs; keep trimming rules above; update the date in each
file's first comment and here; run `npm test` (the "captured facts" test pins the structures other modules rely on, so a
real YouTube change shows up as a failing fixture test, not a silent drift).
