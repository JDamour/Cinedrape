# Prompt for Gemini: continue developing Cinedrape

Paste everything below the line into Gemini (Antigravity or Gemini CLI opened on `E:\Cinedrape`). It is self-contained; deeper detail is in the files it names.

---

You are taking over development of **Cinedrape**, a Chrome Manifest V3 extension that re-themes and re-lays-out desktop YouTube. The repository is `E:\Cinedrape` (Windows 11; use Git Bash or PowerShell; Node 25, npm 11; Chrome 154 is installed). Another AI agent built the MVP; you finish the hardening, then build what is next. Work like a careful senior engineer: verify before you believe, measure before you claim, and keep the safety rules below as hard constraints.

## 0. Read these first (in this order)

1. `YouTube Skin Studio — Product Spec.md`: product intent, features F1-F12, pricing, non-goals, risks. The title inside says Cinedrape.
2. `docs/ARCHITECTURE.md`: THE build contract (module APIs, shared names, selector-map format, verified real-YouTube DOM facts in section 1, ad-safety rules in section 6, product decisions in section 7). Treat it as the source of truth; if you change behaviour, update it in the same change.
3. `docs/STATUS.md` (module status, known gaps; partly stale, see below), `README.md`, `test/e2e/README.md`, `test/data/LIVE-VERIFICATION.md`.
4. `docs/MARKET-AND-MONETIZATION-ANALYSIS.md`: written by the owner, not by the previous agent; read it for commercial context before planning backend or pricing work.

## 1. What exists

MVP features F1-F6 are implemented:

- **F1 theme engine:** a theme is JSON data (tokens, layout choices, optional validated CSS), never code. `src/shared/theme-schema.js`, `tokens.js`, `src/content/stylesheet.js`, `engine.js`, `style-injector.js`.
- **F2 six launch themes:** `src/themes/*.json` (Cinema, Minimal, Classic free; Prime Time, Studio, Arcade Pro).
- **F3 layout modes:** home hero/rows (`src/content/layouts/home.js`), watch cinema/focus (`watch.js`), density (`density.js`).
- **F4 popup:** `src/popup/*`, vanilla JS, accessible.
- **F5 calm mode:** `src/content/calm.js`, five independent toggles driven by `html[cd-calm-*]` attributes.
- **F6 breakage detection:** `src/content/health.js`, `notice.js`; YouTube's markup lives in a signed selector map `src/data/selector-map.source.json` (signed into `selector-map.signed.json` with `npm run sign-map`).
- Trust path: ECDSA P-256 signed selector map and signed licence tokens (`src/shared/signing.js`, `licence.js`, `tools/`).
- Not built: backend, sign-in, payments, sync, AI generator, marketplace, theme editor, profiles/schedule, import/export, landing/waitlist page.

Measured on the last fully verified run (before the final fixes below): 1709/1709 unit tests; strict build green with `content.js` 56.6 KB gzipped (budget 150 KB); three real-Chrome suites against live logged-out youtube.com all green: readability audit (6 themes x light/dark YouTube x channel/search/watch: 0% text below 3:1), home layout + calm (109 checks), popup + breakage + trust (231 checks). Theme switch 8-36 ms (budget 150), popup change to page effect 4-25 ms (budget 1 s).

## 2. State of the working tree: verify first

The previous agent was cut off mid-way through applying a hostile review's findings. Code for all of them is present but the final test/e2e re-runs did NOT complete, and `docs/STATUS.md` was not fully updated. Your first task is to re-establish a verified baseline:

1. `git init` and make a baseline commit (the project is not under version control yet; `.gitignore` already excludes `node_modules`, `dist*`, `.keys`, `test/e2e/out`).
2. `npm install`, then `npm run build:strict`, then `npm test` (about 1700+ tests, uses `--test-concurrency=6`). Fix anything red. If a timing test flakes under CPU load, the fix is "best of N", never a looser product budget.
   **Known: the suite is now slow.** The rewritten `test/ad-safety.test.js` is no longer vacuous (it validates every rule of every theme x config stylesheet), so it passes 18/18 but took 136 s on a CPU-saturated machine (2.5 s before, when it silently skipped most rules). A single `node --test` run therefore looks stalled for minutes. Speed it up without weakening it: cache per-rule verdicts by rule text across configs (most rules are identical between configs and themes), keep the "bad rule at the END of the longest sheet is caught" meta-test, and re-check the whole suite finishes in roughly 2 minutes.
3. Run the real-browser suites once each (about 10 minutes each; they use a temporary headless Chrome with a fresh profile and never touch your own):
   - `npm run build:strict -- --out dist-home` then `npm run e2e:home`
   - `npm run build:strict -- --out dist-popup` then `npm run e2e:popup`
   - readability: `node test/e2e/run.mjs --themes all --pages channel,search,watch --mode both --pro --viewport 1280x720 --out test/e2e/out/recheck`
   They must pass: 0 failed checks.
4. Update `docs/STATUS.md` with the real numbers.

The fixes that should be present and need confirming by those runs (review findings, in the previous agent's words):

- Pro licence silently lapsed 30 days after activation when `API_BASE` is empty; now re-verified locally. Claims must come from the verified token, not hand-edited stored claims.
- Marker-independent ad evidence: tiles linking off youtube.com or through `/pagead/`, googleadservices, doubleclick are never mirrored or hidden; `safeHide` must fail closed.
- CSS validator moved from a magnitude-threshold deny-list (25+ rules hid an ad in real Chrome) to an allow-list of cosmetic properties on non-Cinedrape subjects; theme custom properties only in a `--cd-t-*` namespace; geometry caps on Cinedrape's own containers; `validateTheme` enforces colour contrast (text/bg 4.5:1, border/accent 3:1, opaque bg/text). Permanent regression tests: `test/shared/css-validator-hostile.test.js`, `test/e2e/ad-bypass-corpus.mjs`.
- `test/ad-safety.test.js` was vacuous (validator stopped at 50 errors, so most of each stylesheet was never scanned); it must evaluate every rule and include a meta-test that a bad rule at the END of a long stylesheet is caught.
- Readability sentinel in health: if sampled text contrast falls below 3:1 with the theme applied, the `theme` feature is marked broken and the page fails open to YouTube's own look; the health verdict is persisted so a broken feature does not flash on for 6 s after every load.
- Notice avoid-list (never over `.ytp-chrome-bottom`, ad or sponsor UI); first-paint cache entries with backslashes / `image-set(` / foreign at-rules are rejected; `tools/package.mjs` tests an explicit `KEY_STATUS` sentinel.

If any of these are missing or red, finish them before anything else.

## 3. Hard rules (non-negotiable)

1. **Never hide, collapse, cover, fade, move off-screen or make unclickable any ad, sponsorship disclosure or player control.** No ad blocking, no ad skipping, no downloading. Every engine-generated hide goes through `safeHide` with an ad guard; the CSS validator and `test/ad-safety.test.js` enforce it. Never weaken an ad-safety assertion to get green.
2. **Themes are data, never code.** No remote code, no `eval`/`new Function`, no remote fonts, no network calls from content scripts. The build fails on these.
3. **Privacy:** nothing leaves the browser in the MVP; no telemetry network path; permissions exactly `storage`, `alarms` and `https://www.youtube.com/*`. Do not add permissions without a written justification.
4. **Fail open:** any error leaves YouTube in its default look; a YouTube change must never leave a blank or unusable page. Layout renderers build off-DOM first and restore the original DOM exactly on unmount.
5. **Trust:** the selector map and licence tokens are signature-verified; reject unsigned, tampered, older or equal-version maps. The current signing keys are DEV keys: never ship them (`npm run package` refuses).
6. **No other company's names, logos or exact layouts** in themes, screenshots or listings; refer to YouTube only to say what the extension works with, and state it is not affiliated with Google.

## 4. Work to do, in priority order

**P0: finish and verify** (section 2 above), then fix any defect the runs expose at the root cause.

**P1: close known gaps**
- Real ads have never been observed: logged-out YouTube served none to the automation, so ad selectors in `protected.ads/sponsor/containers` are recalled markup plus synthetic fixtures. With a real logged-in session (ask the owner to do or supervise this), capture the actual in-feed ad and in-player ad/sponsor markup, add them to the map and fixtures, and re-verify nothing hides them.
- Subscriptions, history and playlist pages were only seen as logged-out empty states (`_unverified` in the map); verify them logged in.
- Theme-brief omissions to implement or consciously drop in `docs/ARCHITECTURE.md` section 7: Minimal "no hover previews"; Prime Time "large continue-watching strip"; Classic "original artwork"; Studio serif headings on YouTube's own titles (currently only on Cinedrape-built titles).
- Performance: one 633 ms frame / 500 ms long task when the first infinite-scroll batch lands on a mounted Cinema home (mount cards in chunks across frames); calm toggle latency reached 559 ms p95 on a 2,500-cell Shorts page (cheaper guard).
- Product decision to confirm with the owner: density is Pro-only here (spec F3) although F4 lists it as "All".
- Consider dropping the `alarms` permission until a backend uses it (store reviewers dislike unused permissions); the package guard currently requires exactly `alarms,storage`, so change both together.

**P2: v1.1 per the spec** (each needs its own design note in `docs/` first): F7 theme editor with live preview (WCAG warnings), F8 profiles and schedule (`chrome.alarms`, within 1 minute), F9 import/export/share codes (validated through the same theme validator, so it depends on the hardened allow-list), F10 sync (needs the backend).

**P3: backend and release** (needs the owner's decisions and accounts): serverless API + Postgres/SQLite, email magic-link sign-in, a merchant-of-record provider webhook that mints licences, hosting of the signed selector map with a refresh and an alert when error counts jump, set `API_BASE`, rotate production keys (`npm run keys -- --production`, private keys in a KMS/HSM or offline, never in the repo), privacy policy matching the store disclosures, trademark search (USPTO/EUIPO/WIPO for "Cinedrape" and "Prime Time"), landing page + waitlist (the spec's Phase 0), store listing "Cinedrape - themes for YouTube(TM)" with the not-affiliated line.

## 5. How to work

- Commands: `npm test`; `npm run build:strict`; `node build.mjs --strict --out dist-<name>` to build into a private folder (never run two builds into the same `dist/`); `npm run e2e`, `e2e:home`, `e2e:popup`; `npm run sign-map` after editing the map (bump `mapVersion` and update the version pins in `test/data/selector-map-data.test.js` and `test/data/LIVE-VERIFICATION.md`); `npm run licence:dev -- --plan pro --days 30` mints a dev Pro token; `npm run package` builds the store zip (refuses dev keys).
- Tests: `node:test` + jsdom. Build DOM tests with `createPage()` from `test/helpers/dom.js` (it works around jsdom's duplicate-id bug and uses real captured YouTube markup in `test/fixtures/real`). jsdom has no layout, does not apply `@media`, and does not resolve `var()` in ordinary properties: assert on generated CSS text there, and use the real-Chrome harness for geometry, paint and timing.
- The real-browser harness is `test/e2e/` (puppeteer-core drives installed Chrome with `enableExtensions` + `browser.installExtension`; dark mode is forced with the `PREF` cookie `f6=400` set on `about:blank` first; a populated logged-out home needs a watch page played first, then SPA-navigate home; shipping `dist/` must never be modified by it).
- Do not POST data from a page to localhost or anywhere else when capturing fixtures; return it through the tool result and write the file yourself.
- Unit tests that assert wall-clock budgets must use best-of-N (CPU contention flakes otherwise).
- Keep modules small and the content script under 150 KB gzipped; no runtime dependencies in `src/`.
- Update `docs/ARCHITECTURE.md` and `docs/STATUS.md` with every behavioural change. Commit in small, reviewed steps.

## 6. Report back

After each work package, report: what you changed (files), the exact test and e2e results (counts, not adjectives), defects found vs fixed vs deferred (with reasons), and anything that needs an owner decision. Say plainly when something could not be verified.
