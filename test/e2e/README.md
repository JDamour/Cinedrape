# Cinedrape e2e harness (real Chrome, live youtube.com)

Loads the built extension into the installed Google Chrome, signs nothing in, visits real logged-out YouTube pages with each
theme and writes screenshots plus a machine-readable report. It is **not** part of `npm test` (nothing here matches
`*.test.js`), needs the network, and never touches your real Chrome profile.

```
npm run build                      # produces dist/ (the harness never builds)
node test/e2e/run.mjs              # or: npm run e2e
node test/e2e/run.mjs --themes cinema,minimal --pages channel,watch --out test/e2e/out-quick
node test/e2e/run.mjs --pro --calm # dev Pro licence + every calm toggle on (stresses the hide rules)
# the readability matrix: all six themes, both YouTube modes, 1280x720, no perf measurements (about 6 minutes)
node test/e2e/run.mjs --pro --mode both --pages channel,search,watch --viewport 1280x720 --no-perf --shots none --out test/e2e/out/final
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `--extension <dir>` | `dist` | Unpacked extension. Validated first: manifest, and every file it references, must exist. |
| `--themes all\|a,b` | `all` | Theme ids (ids come from `src/shared/constants.js`). |
| `--pages a,b` | `home,watch,search,channel` | `home` (https://www.youtube.com/), `channel` (`/@NatGeo/videos`, the home-grid stand-in), `search` (`nature documentary`), `watch` (`BzpdP2APcIM`). |
| `--pro` | off | Mints a licence with `tools/dev-licence.mjs --plan pro --days 30` (needs `npm run keys` once) and seeds `cd.licence`. Without it, Pro themes fall back to `cinema` and are reported as `(locked)`. |
| `--calm` | off | Seeds all five `calm` toggles `true` (free users keep only the free two). |
| `--viewport WxH` | `1440x900` | Window / screenshot size. |
| `--mode <m>` (light, dark, both) | `light` | YouTube's own colour mode. Forced with the `PREF` cookie (`f6=400` dark, `f6=80000` light) set before navigation and verified through `html[dark]` (check `mode-forced`); `both` visits every (theme, page) twice. Every report row records the mode. |
| `--no-perf` | off | Skip the theme-switch / heap measurements (and their checks): a readability run is about 4 s faster per visit. |
| `--shots <s>` (all, view, none) | `all` | `view` = viewport screenshots only, `none` = no screenshots. Files are `<theme>-<page>-<mode>[-full].png`. |
| `--offenders N` | `15` | Worst readability offenders listed per row. |
| `--out <dir>` | `test/e2e/out` | Screenshots, `report.json`, `report.md` (overwritten each run). |
| `--headed` | off | Headed Chrome with the window parked at x=-2400 instead of headless new. |
| `--chrome <path>` | `CHROME_PATH`, else system Chrome | In Git Bash write the path with forward slashes (`C:/Program Files/...`). |
| `--chrome-arg <flag>` | - | Extra Chrome flag, repeatable (`--chrome-arg=--proxy-server=host:3128`). |
| `--settle <ms>` | `7000` | Max wait for the extension to settle per page (the health check needs about 6 s to declare a role missing). |
| `--page-timeout <ms>` / `--total-timeout <ms>` | `90000` / `1500000` | Per-page and whole-run budgets. |

## Exit codes

`0` all checks passed (warnings allowed) | `1` a check failed or a page visit errored | `2` bad arguments | `3` environment
(no `dist`/incomplete build, Chrome or puppeteer-core missing, cannot mint a licence, Chrome refused the extension) |
`4` YouTube unreachable, consent wall, CAPTCHA page, or HTTP >= 400 on navigation (aborts at once, partial report written) |
`5` global timeout | `6` internal error (browser crash, extension service worker not running) | `130` Ctrl-C / SIGTERM.
On every exit path Chrome is killed and the temporary profile (`%TEMP%/cinedrape-e2e-*`) is deleted; leftovers of a hard-killed
run older than 2 h are swept at the next start. The harness never accepts consent dialogs and never tries to pass bot checks.

## What is recorded per (theme, page, mode)

Screenshots `<theme>-<page>-<mode>.png` (viewport) and `-full.png` (home, channel; capped at 12000 px). In `report.json` / `report.md`:
`cd-*` attributes on `<html>`; `<style id=cinedrape-theme>` presence, bytes, rule count, copies, adopted sheets;
console errors/warnings split into *extension* (`chrome-extension://` origin, the word "cinedrape", or a style-src CSP violation) and *page*
(YouTube's own noise, listed but never failing); computed background/text of `html`, `body`, `ytd-app` and a main title, with the
title's contrast against its effective background; the `GET_STATUS` (`cd:getStatus`) reply, polled until stable;
time to first paint of the style (`styleFilledAt`, ms since navigation start, next to `first-paint` / `first-contentful-paint`,
and whether the first-paint cache existed); theme-switch latency (service worker `Date.now()` just before the `cd.settings` write to the
moment both `html[cd-theme]` and the style content changed, polled at 20 ms, so resolution is about 20 ms) for a switch to
another theme and back; JS heap (after a forced GC) and node count before/after the two switches plus script/task CPU during them;
and the ad check.

**Ad check.** Every node matching `protected.ads` + `protected.sponsor` from `src/data/selector-map.source.json` is classified.
A node that is not visible *with* the Cinedrape stylesheet but is visible *with it disabled* was hidden by the extension and fails the
`ads-visible` check (so empty containers like `#masthead-ad` and nodes YouTube itself hides never trigger it; verified against synthetic
`display:none`, `opacity:0` and hidden-parent cases). Logged out, most pages have no visible ad at all (`vis/found` is 0/58 on typical runs); the check
matters when a pre-roll or in-feed ad does appear.

**Readability audit** (`lib/audit.mjs`, runs in the page, once per visit; the numbers go to `report.json` and the matrix to `report.md`). It samples up to
~500 visible text-bearing elements (budgets: masthead 60, guide 120, main content 320; titles are always kept) plus up to ~135 icons (`svg`, scored at 3:1)
in the first three screens, computes each one's text colour against its effective background and records the share below 3:1 and below the WCAG
threshold of its size (4.5:1, or 3:1 for text >= 24px or >= 18.66px bold). The effective background is the alpha-composite of the background colours
from the element up to the first opaque one; when the element is on screen the layers are read from the paint-order stack (`elementsFromPoint`) instead,
because YouTube paints the masthead bar in a *sibling* layer. Text alpha and ancestor opacity are composited too. What is not measured is counted in
`skipped`, never guessed:

| Skipped as | Why |
|---|---|
| `hidden` | display:none, visibility:hidden, opacity:0, content-visibility skipped, zero size, clipped by an overflow ancestor, below the third screen |
| `media` | inside or geometrically over an `img`/`video`, the player, thumbnails (`ytd-thumbnail`, `yt-thumbnail-view-model`): the background is user content (duration and LIVE badges, Shorts captions). YouTube's own Lottie animations (`lottie-component`, the like-button burst: colours baked into the animation, invisible until played). The ambient-light `canvas` of the watch page is deliberately not counted as media |
| `bgImage` | a gradient or picture sits between the element and the first opaque colour, or the text is `background-clip:text` |
| `noRegion` | outside masthead / guide / page manager |

Ads and sponsorship disclosures get no exemption: if one is on screen it is measured like the rest. Residual YouTube content that cannot or should not be
restyled (user images, the player, ads) is excluded only through these documented rules, never by hiding it.

TITLE-like elements are `a#video-title`, `.ytLockupMetadataViewModelTitle`, `.ytLockupMetadataViewModelHeadingReset`, `h1` and `h3`.
The per-row record also holds whether `html`, `body`, `ytd-app` and `ytd-page-manager` have the theme background token (`--cd-bg`) as their effective
background (`surfaces`), the per-region figures, the sample size and the offenders (grouped by element path and colour pair, with a repeat count).

**The gate** (`gateChecks` in `lib/audit.mjs`): `readability-rate` fails when more than 3% of the sampled elements are below 3:1; `readability-titles`
fails when any title-like element is below 4.5:1; `readability-sample` fails when fewer than 25 elements could be measured (10 on `home`, the logged-out empty state; an audit that saw nothing
must not pass); `surfaces-bg` (warning) reports a page surface that is not the theme background.

Checks that fail the run: `storage-seeded`, `style-element`, `theme-attr` (locked Pro theme must read `cinema`), `status-reply`,
`status-theme`, `status-pro` (when `--pro`), `mode-forced`, `readability-sample`, `readability-rate`, `readability-titles`, `theme-switch`,
`theme-switch-back` (the last two unless `--no-perf`), `ads-visible`, `no-ext-console-errors`.
Warnings only: `status-page`, `features-healthy`, `theme-switch-fast` (> 1000 ms), `no-ext-console-warnings`, `page-ready`,
`style-before-first-paint`, `title-contrast` (< 4.5:1), `heap-growth`, `player-error`, `surfaces-bg`, `screenshot*`.

## How it works (and the quirks that matter)

Verified on Chrome 154.0.8037.100 (branded, Windows 11), puppeteer-core 25.12, Node 25.

- Branded Chrome 137+ ignores `--load-extension`. The supported route is `puppeteer.launch({enableExtensions: true, pipe: true})`
  followed by `browser.installExtension(dir)`; it works headless (new) and headed, with no consent or "developer mode" dialog. Do not
  pass the paths in `enableExtensions: [...]`: puppeteer 25 does not await those installs.
- Headless new is the default. Headed mode works too, but YouTube then answers with `/?themeRefresh=1`, so the harness never asserts the final URL.
- The MV3 service worker is not running for about 1 s after install, so `ext.workers()` is empty at first; the harness waits for the
  target. While a CDP session is attached to it the worker is **not** terminated by the 30 s idle timer (checked over 50 s idle), so one handle is held for the run
  (and re-acquired if it dies). It is used to seed `chrome.storage.local`, flip the theme and send `cd:getStatus` through
  `chrome.tabs.sendMessage`.
- The init script (`Page.addScriptToEvaluateOnNewDocument`) runs before the document_start content script, so the MutationObserver sees the style element at
  its true first appearance.
- Logged-out `youtube.com` is an empty state ("Try searching to get started"), not a feed: use `channel` for tile-heavy layout checks.
  The watch page may show a "confirm you're not a bot" player error (reported as the warning `player-error`).
- YouTube's theme lives in the `PREF` cookie, and YouTube's unload handler writes the *old* theme back into it, so the harness navigates to `about:blank`
  before it deletes and re-sets the cookie (otherwise the second mode of a `--mode both` run comes out as the first). `prefers-color-scheme` is
  emulated to the same value. A fresh profile without the cookie is light.
- Video is paused after the screenshots so playback does not distort the heap numbers. Chrome starts with `--mute-audio`.
- YouTube's own console noise (sandboxed `about:blank`, `migrate_from` manifest warning, WebGPU `powerPreference`) shows up under *page*.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| exit 3 `extension ... is incomplete: manifest references missing file(s)` | The build is unfinished or failed: `npm run build`. |
| exit 3 `Chrome not found` | Pass `--chrome "C:/Program Files/Google/Chrome/Application/chrome.exe"` or set `CHROME_PATH`. |
| exit 3 `--pro: could not mint a dev licence` | Run `npm run keys` once (creates `.keys/`). |
| exit 4 consent wall / CAPTCHA | Run from a network where logged-out YouTube loads directly. Accept consent once in a normal browser, never through this harness. |
| exit 4 `ERR_NAME_NOT_RESOLVED`, timeouts | No network, or a proxy is needed: `--chrome-arg=--proxy-server=...`. |
| exit 6 service worker not running | The worker crashed on load: open `chrome://extensions` in a normal Chrome, load `dist` unpacked and read the error. |
| `style-element` fails, no `cd-*` attributes | The content script did not run: check the manifest `matches`, and that `--extension` points at the built `dist`. |
| `features-healthy` warns | A selector role is missing on live YouTube (read `missingRoles` in the report), or `--settle` is too short on a slow connection. |
| `theme-switch` fails with only `attrMs` set | The attribute changed but the stylesheet text did not: two themes that produce identical CSS, or CSS applied through a constructable stylesheet. |
| Leftover `cinedrape-e2e-*` in `%TEMP%` | Only after a hard kill; the next run sweeps entries older than 2 h. Safe to delete by hand. |

## Popup, breakage detection, first paint, licence and trust (`features-popup-breakage.mjs`)

```
node build.mjs --strict --out dist-popup           # your own directory; never the shared dist/
node test/e2e/features-popup-breakage.mjs --extension dist-popup [--out test/e2e/out/popup] [--phases f4,f6,paint,sw,licence,trust]
```

One command, exit code 0 only when every check passed (warnings allowed), 1 on any failed check or harness error in a phase, 6 on an internal error.
Report: `<out>/report.md` and `report.json`. Needs the network (live logged-out youtube.com) and takes about 15 minutes (the service-worker phase waits
for Chrome's 30 s idle timeout). Everything runs in a temporary profile; pages never send data out.

| Phase | What it proves |
|---|---|
| `f4` | the popup in a real extension window: theme / accent / density / animations / calm each reach the open tab within 1 s, locked Pro controls explain themselves and write nothing, token activation (empty, garbage, tampered, expired, valid; the token is never echoed), keyboard order, focus rings, AX tree, 360 px layout, light and dark contrast |
| `f6` | a deliberately broken map (signed with the dev private key, higher `mapVersion` than the bundled one) pauses exactly the features whose `requires` roles are gone (expectation computed from the map data), shows one `div.cd-notice[role=status]`, keeps the page usable and YouTube's own look where a feature is off, popup status and `GET_STATUS` agree; a higher good map heals without a reload and the notice goes away; unsigned / tampered / older / equal / wrong-key / garbage maps are ignored; removing the cached map returns to the bundled one |
| `paint` | second and third load: stylesheet and every `cd-*` attribute it depends on exist when the page first exists (before first paint, < 50 ms after the document starts), and nothing is rewritten afterwards (no restyle) |
| `sw` | the MV3 worker is really stopped (all debugging sessions released, Chrome's idle timeout), the popup still shows the right licence and changes the theme with no worker running, the first message wakes it, settings / licence / alarms survive |
| `licence` | `cd.licence.checkedAt` aged 3, 8, 29, 31 days gives active, grace, grace, expired and Pro unlocked, unlocked, unlocked, locked in the live tab |
| `trust` | zero requests from the service worker, the popup and the content script (CDP initiator stacks), manifest permissions exactly `storage` + `alarms` and host `https://www.youtube.com/*`, no fetch / XHR / cookie / eval in the shipped files, page `localStorage` / `sessionStorage` / cookies compared with a no-extension control profile |

Harness notes: `popup-helpers.mjs` launches Chrome with `protocolTimeout` 300 s and wraps the service-worker bridge (`RobustBridge`: 30 s per call, up to four
attempts, an extension page is opened to wake a worker that is not running). Map versions in the F6 phase are derived from the bundled map, because a cached map is only
adopted when strictly newer. A worker only stops when no debugging session is attached, so the `sw` phase releases the bridge and the network recorder first.
