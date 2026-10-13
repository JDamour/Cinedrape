# Live verification of `src/data/selector-map.source.json`

- **Date:** 2026-10-07 (selectors verified live), map `mapVersion` 2026.10.13.4, `issuedAt` 2026-10-13T00:00:00Z. 2026.10.13.4 added `calm-hideLive` feature requirement on `homeBrowse` for E4 live stream calm hiding. 2026.10.13.3 generalized `viewCounts` selector #7 (`.ytLockupViewModelHost:not(:has(yt-collection-thumbnail-view-model)) .ytContentMetadataViewModelMetadataRow:nth-of-type(2) > .ytContentMetadataViewModelMetadataText:not(...)`) removing avatar-specific requirements so any 2-row lockup (including live tiles with custom avatar wrappers or no avatar) hides its viewer count under calm mode. 2026.10.13.2 added `yt-decorated-avatar-view-model` to `viewCounts` selectors #5, #6, #7 so avatar-bearing live/regular home tiles match regardless of wrapper class. 2026.10.13.1 added `homeGrid` and `homeGridContents` to `requires["layout-home"]` and `requires.density` (T1: ensures grid-only renames raise the breakage notice). 2026.10.12.2 added ten entries to `protected.ads` and nothing else (marker-INDEPENDENT ad evidence, found by the final ad-safety review, because real ads were never observed and every other entry is a hand-written marker): the link markers `a[href*="/pagead/"]`, `a[href*="/aclk"]`, `a[href*="googleadservices.com"]`, `a[href*="doubleclick.net"]`, `a[href*="googlesyndication.com"]`, `a[href*="adurl="]` the class-fragment markers `[class*="ytwAd"]`, `[class*="AdBadge"]`, `[class*="ad-badge"]` and the generic off-site link `a[href^="http"]:not([href*="youtube.com"]):not([href*="youtu.be"])` (a tile, shelf or wrapper that holds an anchor leaving YouTube is never hidden or collapsed). They are protective only (a match is never hidden, never mirrored), were checked against the real captures in `test/fixtures/real` (they match nothing there) and are NOT live-verified against real ads. 2026.10.09.2 added one `viewCounts` selector found by the real-Chrome calm run (`test/e2e/features-home-calm*.mjs`): a channel-grid collab tile (live on /@NatGeo/videos) is one row `[channel][and partner][views][age]` with no avatar, so neither the 2-text no-avatar rule nor the avatar rules matched and its view count stayed visible; the new rule hides the second to last text of a first row with three or more texts when there is no avatar. 2026.10.09.1 changed only `requires["calm-hideEndScreens"]` (now `["watchPlayer"]`: end-screen elements are legitimately absent on most healthy watch pages, so requiring them raised a false alarm on real YouTube); every selector below is unchanged from the 2026.10.07.1 verification.
- **Where:** www.youtube.com in the built-in browser pane, desktop layout (viewport emulated at 1440x900; one extra pass at 1000x800 for the
  collapsed guide), dark mode (`html[dark]`), `en-GB`, **logged out**, no extension loaded.
- **How:** for every selector of every role (and every `protected.*` selector and `vars` name) the page was asked
  `document.querySelectorAll(selector).length` (variables: `getComputedStyle(documentElement).getPropertyValue(name)`). The page-side copy
  of the map was checked against the file with FNV-1a hashes of the sorted lists (roles `97a2a16d`, ads `66e9846d`, sponsor `72335e46`,
  playerControls `de27f127`, containers `fcef796f`, vars `82c11823`), so the numbers below belong to the final map, not a draft. Nothing was
  sent out of the page; results came back through the tool result. A scratch key in `sessionStorage` held the map during the pass and was
  deleted afterwards.
- **Counts are written per selector, in map order:** `3/0/2` means the primary matched 3 elements, the second selector 0, the third 2.
  `0` everywhere = the role does not exist on that page in that state. A role is **verified** when its primary (or, for roles that are
  several parallel shapes such as `chips`, `continuation`, `shortsNavEntry`, every shape that exists today) matched on at least one live page.

## Pages

| Column | URL | State when counted |
| --- | --- | --- |
| Home | https://www.youtube.com/ | Populated feed (31 `ytd-rich-item-renderer`: 20 videos, 1 Mix, 10 Shorts-shelf cells), after earlier watching in the same session. A fresh logged-out home can be an empty state and was not observable. |
| Channel | https://www.youtube.com/@NatGeo/videos | 3 tiles loaded, no continuation (the pane did not load more) |
| Chan. Shorts | https://www.youtube.com/@NatGeo/shorts | 6 Shorts cells |
| Search | https://www.youtube.com/results?search_query=nature+documentary | 3 video rows, 1 playlist lockup, 1 channel row, 1 shelf, continuation |
| Watch | https://www.youtube.com/watch?v=BzpdP2APcIM | Paused (the pane does not autoplay), no ad running, 4 related lockups |
| Playlist | https://www.youtube.com/playlist?list=PLeCPQtbuJaPtLugP7UijMU-ozdNmkdNFO | 100 rows |
| Subs | https://www.youtube.com/feed/subscriptions | Signed-out empty state ("Don't miss new videos / Sign in") |
| History | https://www.youtube.com/feed/history | Signed-out empty state ("Keep track of what you watch") |

Also visited: https://www.youtube.com/shorts/U-LrN7yix6I (shell roles only, see below), https://www.youtube.com/results?search_query=best+vpn+2026
(two `grid-shelf-view-model` Shorts shelves on the first load, none on the next; no ads either), https://www.youtube.com/watch?v=dQw4w9WgXcQ (tried to
get a pre-roll ad: the pane never started playback), and Home at 1000x800.

## Role x page

`*` = matched an element of the **hidden `ytd-watch-flexy` skeleton** that YouTube keeps inside `ytd-page-manager` on every non-watch page
(it was there on the very first page load too). Watch-only roles therefore "exist" on other pages; the engine must decide the page from
`detectPageType`, never from role presence. The third `playlistPanel` selector (`ytd-playlist-panel-renderer`) lives in the same skeleton.
`channelHeader`'s `ytd-tabbed-page-header` on Playlist is a leftover inside the reused `ytd-browse`.

| Role | Home | Channel | Chan. Shorts | Search | Watch | Playlist | Subs | History | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `app` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | verified; single selector by design |
| `pageManager` | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | 1/1/1 | verified |
| `masthead` | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | verified; the bar is painted by `#background`, so skin rules append ` #background` |
| `guide` | 1/1 | 1/1 | 1/1 | 1/1 | 1/0 | 1/1 | 1/1 | 1/1 | verified; on Watch the drawer exists but `ytd-guide-renderer` is not rendered |
| `miniGuide` | 1 | 1 | 1 | 1 | 1 | 1 | 1 | 1 | verified; single selector; the renderer is `hidden` and EMPTY at 1440px |
| `homeBrowse` | 1/1 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | verified |
| `homeGrid` | 1/1 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | verified |
| `homeGridContents` | 1/1 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | verified |
| `richItem` | 31/21 | 3/3 | 6/6 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | verified; entry 2 excludes the 10 Shorts-shelf cells (they have no `rendered-from-rich-grid`) |
| `videoTile` | 21/0/0/0 | 3/0/0/0 | 0/0/0/0 | 1/0/3/0 | 4/0/0/0 | 100/0/0/0 | 0/0/0/0 | 0/0/0/0 | verified; Home's 21 include 1 Mix (collection) lockup; Search: only the playlist lockup is new-style, the 3 rows are `ytd-video-renderer` |
| `tileLink` | 21/21/0 | 3/3/0 | 0/0/0 | 1/1/3 | 4/4/0 | 100/100/1 | 0/0/0 | 0/0/0 | verified; Search rows use the legacy third selector |
| `tileTitle` | 21/0/21 | 3/0/3 | 0/0/0 | 1/3/1 | 4/0/4 | 100/0/100 | 0/0/0 | 0/0/0 | verified |
| `tileThumb` | 31/31/0 | 3/3/0 | 6/6/0 | 1/1/3 | 4/4/0 | 100/100/0 | 0/0/0 | 0/0/0 | verified; also matches Shorts thumbnails (31 = 21 + 10) |
| `tileDuration` | 21/0/0 | 3/0/0 | 0/0/0 | 0/3/3 | 4/0/0 | 100/0/0 | 0/0/0 | 0/0/0 | verified; live streams carry `LIVE` plus an empty second badge in the bottom overlay |
| `tileChannel` | 20/0 | 0/0 | 0/0 | 0/6 | 4/1 | 100/1 | 0/0 | 0/0 | verified; the channel-grid shape has no channel by design; Watch/Playlist second hit is the owner row (outside tiles) |
| `tileMeta` | 61/0 | 9/0 | 3/0 | 6/6 | 12/0 | 306/0 | 0/0 | 0/0 | verified; document-level counts include channel-header metadata (Chan. Shorts: 3). Use it scoped to a tile |
| `continuation` | 1/0 | 0/0 | 0/0 | 1/0 | 2/0 | 0/2 | 0/0 | 0/0 | verified (both shapes); absent whenever the list is short |
| `chips` | 1/0/0 | 0/1/0 | 0/1/0 | 0/0/1 | 0/1/0 | 0/0/0 | 0/0/0 | 0/0/0 | verified (all three renderers) |
| `watchFlexy` | 1/0* | 1/0* | 1/0* | 1/0* | 1/1 | 1/0* | 1/0* | 1/0* | verified |
| `watchPlayer` | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1 | 1/1/1* | 1/1/1* | 1/1/1* | verified |
| `watchPlayerContainer` | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1 | 1/1/1* | 1/1/1* | 1/1/1* | verified |
| `watchPrimary` | 1/1* | 1/1* | 1/1* | 1/1* | 1/1 | 1/1* | 1/1* | 1/1* | verified |
| `watchSecondary` | 1/1* | 1/1* | 1/1* | 1/1* | 1/1 | 1/1* | 1/1* | 1/1* | verified |
| `watchRelated` | 1/1* | 1/1* | 1/1* | 1/1* | 1/1 | 1/1* | 1/1* | 1/1* | verified; `ytd-watch-flexy #related` alone matches 2 (a skeleton `div#related` sits inside `#related-skeleton`), hence `#secondary-inner > #related` |
| `watchMetadata` | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1 | 1/1/1* | 1/1/1* | 1/1/1* | verified |
| `watchTitle` | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1* | 1/1/1 | 1/1/1* | 1/1/1* | 1/1/1* | verified |
| `comments` | 1/1/1/1* | 1/1/1/1* | 1/1/1/1* | 1/1/1/1* | 1/2/1/1 | 1/1/1/1* | 1/1/1/1* | 1/1/1/1* | verified; Watch has a second `ytd-comments` (engagement-panel copy) |
| `endScreens` | 0/0/0 | 0/0/0 | 0/0/0 | 0/0/0 | 2/1/1 | 0/0/0 | 0/0/0 | 0/0/0 | verified on Watch (a video with end cards; the videowall and shadow exist for every video) |
| `viewCounts` | 0/0/0/0/2/18/0/0 | 0/0/0/3/0/0/0/0 | 0/0/0/0/0/0/0/0 | 0/0/0/0/0/0/0/3 | 1/1/1/0/0/0/4/0 | 0/0/0/0/0/0/100/0 | 0/0/0/0/0/0/0/0 | 0/0/0/0/0/0/0/0 | verified: every Home tile that is not a Mix is hit exactly once (2 live rows + 18), see "Tile metadata" |
| `shortsShelf` | 0/2/0/2/0 | 0/0/0/0/0 | 0/0/0/0/1 | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 | 0/0/0/0/0 | verified: Home shelf (#2, #4), Shorts-tab grid (#5); `grid-shelf-view-model` (#1) had 2 hits on the first load of search "best vpn 2026" and 0 later; `ytd-reel-shelf-renderer` (#3) never seen |
| `shortsNavEntry` | 0/1/1/0 | 0/1/1/0 | 0/1/1/0 | 0/1/1/0 | 0/0/0/0 | 0/1/1/0 | 0/1/1/0 | 0/1/1/0 | verified; at 1000px the mini-guide shapes match instead: 1/1/0/1. On Watch neither guide is rendered |
| `shortsTiles` | 10/10/0/20 | 0/0/0/0 | 6/6/0/12 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | 0/0/0/0 | verified; entry #4 also matches the mini-guide Shorts link at 1000px (1) |
| `searchResults` | 0/0 | 0/0 | 0/0 | 1/0 | 0/0 | 0/0 | 0/0 | 0/0 | verified |
| `channelHeader` | 0/0/0 | 1/0/1 | 1/0/1 | 0/0/0 | 0/0/0 | 1/0/0* | 0/0/0 | 0/0/0 | verified; `ytd-c4-tabbed-header-renderer` (legacy) never seen |
| `subscriptionsGrid` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/1 | 0/0 | UNVERIFIED: logged out only the sign-in empty state exists; the second selector matches that state's `ytd-section-list-renderer`, the primary (`ytd-rich-grid-renderer`) is the expected logged-in shape |
| `historyList` | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 0/0 | 1/0 | UNVERIFIED: logged out shows the sign-in empty state; the container matches, the rows (`ytd-video-renderer[is-history]` or lockups) cannot be seen |
| `playlistPanel` | 0/0/1* | 0/0/1* | 0/0/1* | 0/0/1* | 0/0/1 | 1/0/1 | 0/0/1* | 0/0/1* | verified |

Shell roles on a Shorts player page (https://www.youtube.com/shorts/U-LrN7yix6I): `app` 1, `pageManager` 1/1/1, `masthead` 1/1, `guide` 1/1, `miniGuide` 1,
`shortsNavEntry` 0/1/1/0. The Shorts page element is `ytd-shorts`.

## What the live pass changed (live differs from the trimmed fixtures or from section 1 of the contract)

1. **Metadata rows carry icons the fixtures stripped.** Live rows are `[eye icon][views][|][age]` (channel grid), `[channel][Verified icon][|][eye icon][views][|][age]`
   (home) and `[eye icon][views][|][age]` as row 2 (watch related, playlist). `:first-child` / `:nth-child` positions break on this. Every position selector
   in the map counts only `.ytContentMetadataViewModelMetadataText` siblings (`T:not(T ~ T)` = first text, `T ~ T:not(T ~ T ~ T)` = second).
   `test/data/selector-map-data.test.js` injects the same icons into the fixtures to pin it.
2. **Home rows are not always "channel, views, age".** Seen on 2026-10-07: a collab upload `[Ayra Starr][|][and zayn][|][views][|][age]` (four texts), live streams
   `[channel][|][591 watching]` (two texts), a trailing icon-only second row on auto-dubbed videos. `viewCounts` therefore has two home selectors: exactly two
   texts, hide the last; three or more texts, hide the second to last; the row must have no later row containing text. A collab that is also live (three texts,
   viewers last) would hide the second channel name instead; not seen, noted in the report.
   Channel pages have the same collab shape without an avatar (seen 2026-10-09 on /@NatGeo/videos: `[National Geographic][and ROLEX][629K][7d ago]`, one row, four texts), so a
   third no-avatar selector hides the second to last text of a first row with three or more texts (the two-text channel-grid row keeps hiding its first text).
3. **`ytd-mini-guide-renderer` is empty at 1440px** (`hidden`, `disable-upgrade`). The only Shorts entry is then the full-guide `a[title="Shorts"]` (no href).
   At 1000px the mini guide is populated (`a[href="/shorts/"]`) and the full guide is not rendered. On Watch neither exists. `shortsNavEntry` carries both shapes
   and is not expected on Watch.
4. **A hidden `ytd-watch-flexy` always sits in `ytd-page-manager`** (see the `*` footnote). One `ytd-browse` is reused for home, channel, playlist, subscriptions and
   history with only `page-subtype` swapped, so `ytd-tabbed-page-header` can linger after leaving a channel.
5. **The home Shorts shelf is real** and matches the synthetic fixture except for the cell attribute: `ytd-rich-section-renderer > #content > ytd-rich-shelf-renderer[is-shorts]`,
   cells are `ytd-rich-item-renderer[is-shelf-item]` (not `is-shorts-grid`) wrapping `ytm-shorts-lockup-view-model-v2`. `shortsTiles` finds cells by `:has(a[href^="/shorts/"])`.
   These cells are also `ytd-rich-item-renderer`, so `richItem` (31) is larger than the grid's own tiles (21).
6. **Home has Mix tiles** (`ytLockupViewModelCollectionStack2`, "Mix" badge in the top overlay, one row `channel | Playlist`): excluded from `viewCounts`/`tileChannel`.
7. **Thumbnail badges:** duration lives in `yt-thumbnail-bottom-overlay-view-model`; "New" / "Auto-dubbed" are separate overlay badges (top). The role is scoped to the bottom overlay.
8. `ytd-video-view-count-renderer` still exists on Watch (section 1 said it was gone), next to the empty `#view-count`. Both kept as fallbacks.
9. The tile selectors are anchored on `.ytLockupViewModelHost` (a child of `yt-lockup-view-model`), not on the tag: in jsdom a selector whose first compound is the element
   passed to `querySelector` returns nothing when it also uses `:has`/`:first-of-type`.

## Protected groups, live

No ad was ever served to this logged-out automation session (home, channel, search incl. a commercial query, watch, playlist, subscriptions, history, Shorts), so
`protected.ads` / `protected.sponsor` are **verified only against the empty containers YouTube ships on every page** and against the synthetic fixtures.
The ad element names (`ytd-ad-slot-renderer`, `ytd-in-feed-ad-layout-renderer`, `ytd-display-ad-renderer`, `ytd-promoted-*`, `ytd-banner-promo-renderer`,
`ytd-companion-slot-renderer`, `.ytp-ad-*`, ...) come from YouTube's known markup, not from observation; unobservable names are protective and harmless if they never match.

| Group | Live matches (distinct elements) | What they are |
| --- | --- | --- |
| `ads` | 4 on Home/Channel/Chan. Shorts/Watch, 3 on Playlist/Subs, 2 on Search | `#masthead-ad` (x2 on grids), `#player-ads`, `.ytp-ad-progress-list`; on Watch also `ytd-ads-engagement-panel-content-renderer` and `ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]`. All empty. |
| `sponsor` | 54 on every page | The player skeleton: `.ytp-paid-content-overlay` family (empty), `.ytp-suggested-action*`, `.ytp-featured-product-*` (affiliate disclaimer text nodes exist but are not populated). |
| `playerControls` | 30 (31 on Watch) on every page | The player skeleton's chrome. |
| `containers` | 48 to 251, depending on the page | Wrappers. After adding `#panels`, `#contents-container`, `ytd-vertical-list-renderer`, `#dismissible`, `.ytSectionListRendererContents`, `#contents > div`, the seek-bar chain and the Shorts-player wrappers, **no ancestor between any real tile, empty ad slot or disclosure and `ytd-app` was uncovered** on any visited page. |

Consequence worth knowing: `#masthead-ad` lives inside `ytd-rich-grid-renderer`/`ytd-browse` and `#player-ads` inside `#related`, always. A `safeHide` on those wrappers
can therefore never match; hide the leaf items instead.

## Variables (`vars`)

Defined at `html` today (dark): `--yt-sys-color-baseline--` `base-background #0f0f0f`, `raised-background #212121`, `surface-container #181818`, `menu-background #282828`,
`text-primary #f1f1f1`, `text-secondary #aaa`, `call-to-action #3ea6ff`, `call-to-action-hover #65b8ff`, `outline rgba(255,255,255,0.2)`, `outline-opaque #3f3f3f`,
`frosted-glass-desktop rgba(15,15,15,0.8)`, `scrim-background-gradient-5 #0f0f0f`, plus `--yt-deprecated-general-background-a|b|c #0f0f0f`.
**Not defined in this cohort** (kept for older cohorts, harmless when unused): every `--yt-spec-*` in the lists (`base-background`, `general-background-a|b|c`, `brand-background-solid`,
`raised-background`, `menu-background`, `text-primary`, `text-secondary`, `call-to-action`, `20-percent-layer`). Deliberately **not** bridged: `scrim-background-gradient-1..4`
(background with alpha 0 to 0.9, a single colour would break the fade), `overlay-*`, `static-ad-yellow`, `icon-warning`, `static-brand-red` and the names that resolve empty
(`brand-background-solid`, `static-white`, `badge-background`, `themed-blue`). Light mode was not measured.

## Not verifiable logged out (summary)

- `subscriptionsGrid`, `historyList`: marked in `_unverified`.
- Any populated ad or paid-promotion disclosure; `ytd-reel-shelf-renderer`, `ytd-reel-item-renderer`, `ytd-c4-tabbed-header-renderer`, `ytd-rich-grid-media`, `ytd-compact-video-renderer`
  (legacy fallbacks, no live page uses them today).
- A fresh logged-out empty-state home (so `homeGrid`/`homeGridContents` are not in any feature's `requires`).
- Light theme values, the miniplayer, theatre/fullscreen DOM, signed-in-only pages.

## Re-verifying

Open each page, then run in the page (replace `MAP` with `JSON.parse(...)` of the map file, or paste the relevant roles):

```js
const MAP = /* contents of src/data/selector-map.source.json */;
Object.fromEntries(Object.entries(MAP.roles).map(([role, sels]) =>
  [role, sels.map((s) => { try { return document.querySelectorAll(s).length; } catch { return 'ERR'; } }).join('/')]));
```

Refresh this table, `issuedAt` and `mapVersion` together; `test/data/selector-map-data.test.js` checks that every role has a row here and that
the `_unverified` roles are the ones marked UNVERIFIED.
