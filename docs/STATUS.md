# Cinedrape — Status (MVP F1–F6)

Last verified: 8 Oct 2026, Windows, Node 25, jsdom 29.1.1, esbuild 0.28.2. Contract: `docs/ARCHITECTURE.md`. Spec: `YouTube Skin Studio — Product Spec.md`.

## Build and tests

```
npm test            node --test "test/**/*.test.js"
npm run keys        idempotent; dev key pairs in .keys/ (gitignored)
npm run sign-map    src/data/selector-map.source.json -> selector-map.signed.json
npm run build:strict
```

`npm test` (full run, after the engine landed):

```
ℹ tests 1663
ℹ suites 65
ℹ pass 1663
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 85732
```

(1609 before the engine work; +54 = stylesheet 6, style-injector 9, engine 30, ad-safety 9.)

`npm run build:strict`: `content.js` 165.9 KB raw, **56,585 bytes gzipped (55.3 KB)** against the 150 KB budget; service-worker 11.8 KB gz, popup 12.6 KB gz.
No `eval` / `new Function` in any shipped file; `content.js` has no `fetch` / `XMLHttpRequest`. `dist/` ends as the production build.
`CINEDRAPE_DEV=1 node build.mjs --dev --strict` also passes (writes the same `dist/`, adds `version_name 0.1.0-dev` and the popup's dev strip); the production build was rebuilt last.

`dist/` is a loadable MV3 extension: every file `manifest.json` points at exists, no `web_accessible_resources`, permissions `storage` + `alarms`, host `https://www.youtube.com/*`.
The built `dist/content.js` was also run in jsdom from a bare `<html>` (document_start): it applies the theme, caches the first paint, answers `cd:getStatus`, no errors.

## Modules

| Module | State | Tests |
|---|---|---|
| shared: constants, theme-schema, contrast, entitlements, tokens, css-validator, selector-map, signing, licence, public-keys | done | `test/shared/*` |
| content: selectors, health, page, notice | done | `test/content/{selectors,health,page,notice}.test.js` |
| content: skin, calm, layouts (tiles, home, watch, density) | done | `test/content/**` |
| content: **stylesheet** (compose, theme-css gating) | done | `test/content/stylesheet.test.js` |
| content: **style-injector** (one `<style>`, CSP fallback, first-paint cache) | done | `test/content/style-injector.test.js` |
| content: **engine** (state, storage, licence, map, navigation, health, layout, status, fail-open, stop) | done | `test/content/engine.test.js` |
| content: **index** (the only import-time side effects, double-injection guard) | done | covered in `engine.test.js` (`index.js` block) and by running the built bundle |
| ad safety (contract section 6.2, static + jsdom + whole engine) | done | `test/ad-safety.test.js` (about 2.5 s) |
| background: service-worker, licence-manager, map-updater | done | `test/background/*` |
| popup | done | `test/popup/*` |
| themes (6) | done | `test/themes/themes.test.js` |
| tools: gen-keys, sign-map, dev-licence | done | `test/tools/trust-tools.test.js` |
| e2e (real Chrome) | separate agent, not part of this run | `test/e2e/` |

## Decisions (ARCHITECTURE.md section 7)

1. **Free vs Pro layouts.** A theme's own bundled layout applies whenever the theme is allowed (Cinema's hero rows are free); the controls that change layout independently of a theme (density) are Pro.
2. **Roadmap embed missing.** Phase 0 (free theme + waitlist) is out of scope; this is the MVP extension (F1–F6). No backend, sign-in, payments, sync, AI, marketplace or waitlist page.
3. **Licence activation** is by pasted signed token; the weekly re-check is wired but inert without an `API_BASE`.
4. **Colour bridge lives in the signed selector map** (`vars`), because YouTube renamed its variables once already.
5. **Chrome >= 105** (`:has()`); older Chromium gets no Cinedrape rather than a broken page.
6. **Hide view counts** relies on tile position and `viewCounts` selectors: language-neutral but weaker; reported by the health check independently.

Engine decisions (new, recorded in ARCHITECTURE.md section 4):

7. Fail-open is sticky: after one exception the engine removes everything it added, warns once and stays off (GET_STATUS still answers, all features `off`). No retry loop.
8. A Pro licence is trusted from the stored record at once (fast first pass) and `verifyLicenceToken` runs once per token in the background; a token that fails is downgraded to free and the page recomputes.
9. `settings.calm` keeps only booleans the user stored, so a theme's calm default (Minimal and Studio hide Shorts) applies until the user decides.
10. The first-paint key is `<themeId>:<fnv1a(css)>`. The cache is a localStorage value any script on youtube.com can write, so entries containing `@import`, `@font-face`, remote `url()`, `expression()` or `</style` are ignored.
11. `health.watch` runs again on every navigation and whenever the set of wanted features changes; the health picture is the single source of the disabled set (features that come back healthy are re-enabled). The home layout is mounted only on the home page, retried once per frame while the grid has no tiles yet, and unmounted when the page changes or the feature breaks.
12. A cached selector map replaces the bundled one only if its envelope verifies against the selector-map key AND its `mapVersion` is strictly newer; anything else (tampered, older, equal, unsigned, wrong key) is ignored, and removing the cache falls back to the bundled map.
13. **A notice must not outlive the problem.** When a paused feature comes back healthy (a newer map, or YouTube changed back) the engine calls `retireNotice()`: the feature leaves the sentence and the notice goes with the last one. The feature stays announced for the session, so a flapping feature does not bring the notice back (found by the real-browser run: the notice said "turned off" for a feature that worked).
14. **The first-paint cache carries the `cd-*` attributes.** `{v:1,key,css,attrs}`: `cd-home cd-watch cd-density cd-motion cd-calm-*` are applied in the same synchronous step as the cached css (validated strictly), so the first frame is the final look and nothing restyles when `chrome.storage` answers. Before, the css arrived at `document_start` and the attributes only after the async load (a half-styled page, then a restyle).
15. **The popup does not depend on the MV3 worker being awake.** `GET_LICENCE` is asked twice, then the state is computed from the stored `cd.licence` record with the same pure function the worker uses; only an unreadable storage shows "Licence status unavailable". `ACTIVATE_LICENCE` is repeated once after a refused connection.

## Known gaps

- **Grid-only renames are not detected.** `requires["layout-home"]` and `requires.density` list only `homeBrowse`. If YouTube renames just `ytd-rich-grid-renderer` or its `#contents`, the layout silently does not mount (YouTube's own grid stays, so nothing breaks) and no notice is shown. Fix is map data: add `homeGrid` and `homeGridContents` to those `requires` lists (selectors owner).
- **Installed users never get a theme's calm default.** `service-worker.js` seeds `DEFAULT_SETTINGS` on install, whose `calm` has five explicit `false` values, which beat the theme default (Minimal/Studio `hideShorts`). Fix: seed `calm: {}` (background owner).
- **Real-browser only, not covered by unit tests:** the CSP fallback to `adoptedStyleSheets`, first-paint timing (< 50 ms), memory (< 30 MB), smooth row scrolling, rAF behaviour in background tabs (a settings change in a hidden tab is applied when the tab is shown), geometry. That is the e2e run.
- **A persistently broken feature is re-enabled for the health settle time after every full page load.** The health verdict is not persisted across loads, so with a broken `app` role the theme shows for about 6 s and then pauses again (within a session the verdict is kept across navigations). Fix would store the last verdict beside the first-paint entry and reconcile on the first settled health result (engine and health owner).
- **Timing-sensitive unit tests under CPU load.** At the default `node --test` concurrency on a busy 20-core machine `engine.test.js` ("a theme switch ... under 150 ms") and `css-validator` ("20 KB validates in well under 20 ms") can fail; both pass alone and with `--test-concurrency=6` (1709/1709).
- **Dev keys.** `.keys/` holds throw-away pairs; the owner must replace them (`npm run keys -- --force`, then `npm run sign-map`) before any store release, and licences minted with `licence:dev` are for testing only.
- The selector map refresh is inert without an `API_BASE`; there is no network flush of anonymous health counters in the MVP.
- Home-layout cards whose tile has no image yet use `https://i.ytimg.com/vi/<id>/…jpg` as an `<img src>` (the page loads it; the extension makes no request).

## MANUAL TEST CHECKLIST

Setup (once)

1. `npm run keys`, `npm run sign-map`, `npm run build:strict` (production), or `CINEDRAPE_DEV=1 node build.mjs --dev --strict` if you want the popup's dev strip.
2. Chrome 105+: `chrome://extensions` -> Developer mode -> **Load unpacked** -> select `E:\Cinedrape\dist`. Reload the extension after every rebuild and reload the YouTube tab.
3. Open https://www.youtube.com/ logged out, dark and light appearance at least once. Keep DevTools open on the Console: there must be no red errors and no `[Cinedrape]` warning.
4. Mint a dev Pro token: `npm run licence:dev -s -- --plan pro --days 30` (prints the token on stdout; `-- --plan free` mints a free one). Paste it into the popup's **Activate Pro** field. To go back to free, run `chrome.storage.local.remove('cd.licence')` in the service-worker console (`chrome://extensions` -> Cinedrape -> service worker).

F1 Theme engine

- Open the popup, pick Minimal: the open tab changes in well under a second with no reload. Switch Cinema -> Minimal -> Classic repeatedly: no flash of YouTube's default look in between.
- Hard-reload the tab: the chosen theme is there from the first paint (no white/grey flash).
- DevTools Elements: `<html>` has `cd-theme`, `cd-page`, `cd-home`, `cd-watch`, `cd-density`, `cd-motion`; one `<style id="cinedrape-theme">` is a child of `<html>`.
- Navigate home -> a video -> search -> a channel -> Subscriptions (sign-in not needed to see the empty state): `cd-page` follows each, nothing blank or unreadable.

F2 Launch themes

- Free (no licence): Cinema, Minimal, Classic apply; Prime Time, Studio, Arcade show a lock and Pro badge in the popup. To see the fallback, store a Pro theme while free (service-worker console: `chrome.storage.local.set({'cd.settings':{themeId:'studio'}})`): the page shows Cinema and the stored choice is kept.
- With the dev Pro token: all six apply. Remove the licence and the page falls back to Cinema; add it back and the stored theme returns.
- For each theme check home, watch, search, channel and subscriptions for readable text and visible focus rings.

F3 Layout modes

- Cinema / Studio / Prime Time on the home page: hero banner + horizontal rows; rows scroll with the wheel/drag, the arrow buttons and Left/Right/Home/End; cards open the video (middle click opens a new tab). Scroll to the end of the page: more tiles keep arriving (infinite scroll still works).
- Watch page with a cinema/focus theme: the player is YouTube's own and not moved; theatre and fullscreen behave normally.
- Pro: density 1..5 in the popup changes tile size/gaps within a second; free users see density locked.

F4 Quick settings popup

- Change theme, accent colour (a low-contrast custom colour shows a warning and the theme accent is used), density (Pro), animations off: each shows in the open tab within 1 s.
- Animations off (or OS "reduce motion"): `cd-motion="off"`, no transitions or smooth row scrolling.
- The status line says "Working" with the theme and page.

F5 Calm mode

- Free: Hide Shorts and Hide home recommendations work; the other three show a lock. With Pro: Hide comments, end screens (end of a video) and view counts too.
- Each toggle works on its own and survives navigation (home -> watch -> back).
- With every toggle on, ads still show: pre-roll/skippable controls, "Sponsored" results, the in-feed ad card on home (if any), and the "Paid promotion" overlay on a sponsored video.

F6 Breakage detection

- Home with a rows theme: in DevTools Elements remove the `page-subtype` attribute from `ytd-browse` (or rename it). After about 6 seconds Cinedrape shows one notice ("Cinedrape turned off ... because YouTube changed"), the rows disappear and YouTube's own grid returns, the theme stays, `<html>` gets `cd-off-layout-home`, and the popup says the home layout is paused. Navigating to a healthy page re-enables it and the notice goes away. No second notice for the same feature in the same session.
- Same idea for Hide comments on a watch page (rename `ytd-comments`).
- A YouTube change must never leave a blank or unusable page: if in doubt, disable the extension and compare.

Ads and trust (every theme, every toggle)

- Ads, "Sponsored" labels, the sponsorship disclosure and the player's bottom bar are always visible and clickable. `npm test` runs `test/ad-safety.test.js` for this; the manual pass is the real-site confirmation.
- No requests to anything but youtube.com / ytimg.com in the Network tab from the extension (the service worker only fetches when an `API_BASE` is configured, which it is not).
