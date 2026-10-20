# Cinedrape — Task Tracker

Companion to `docs/ENHANCEMENT-SPECS.md` (specs S1–S10) and `docs/STATUS.md` (verification state).
One row per task; IDs are stable; "Spec" points at the spec section that details it. Update this file in the same change
that completes a task. Last full audit: **13 Oct 2026**.

## Done — 13 Oct 2026 audit pass

| ID | Task | Spec | Verified by |
|---|---|---|---|
| D1 | Live badge (`cd-live-badge` + pulsing `cd-live-dot`, transform-only keyframes) on mirrored cards; localized-badge detection (`isLive`) in `extractTile` | S1 | unit 1874/1874; e2e:home 109 PASS |
| D2 | Live viewer count marked `.cd-card-watching`, live dot inside it; hides with calm hideViewCounts like `.cd-card-views` | S1 | unit + calm tests |
| D3 | Hero prefers a live tile; hero shows the badge; CTA "Watch live" | S1 | home.test.js live blocks |
| D4 | Text floors: `.cd-card-meta` ≥ 12 px, live badge ≥ 11 px regardless of theme base size | S2 | home.test.js CSS assertions |
| D5 | Last row never ends on a stub (splits only past `chunk + visible − 1`); one tab stop per row after every split | S3 | home.test.js density/late blocks |
| D6 | Hero media `width:100%` — no empty band on short viewports | S3 | code comment + e2e cinema/home screenshot run |
| D8 | T1: Add `homeGrid` + `homeGridContents` to `requires["layout-home"]` and `requires.density` (mapVersion 2026.10.13.1) | — | unit 1874/1874; signed map; e2e:popup 234 PASS |
| D9 | T2: Seed `calm: {}` in `ensureDefaults` (`service-worker.js`) so theme calm defaults apply until user sets one | — | service-worker.test.js (`SEEDED`); e2e:popup PASS |
| D10 | E1: "Live now" dedicated row on home layout (≥ 2 live tiles, live dot, flex title, live tile exclusion from main feed rows) | S4 | unit 1886/1886; e2e:home 109 PASS; e2e:popup 234 PASS |
| D11 | E2: Watch-page live presentation (html[cd-watch-live], watching-count restyle with pulsing dot, selector-map 2026.10.13.3) | S5 | unit 1890/1890; e2e:home 109 PASS; e2e:popup 234 PASS |
| D12 | E3: Free text-size control in popup (0.9–1.5 segmented control, baseSize scale clamped [11, 22], first-paint cd-textscale, keyboard navigation) | S6 | unit 1895/1895; e2e:popup 234 PASS; e2e:home 109 PASS |
| D13 | E4: Pro "Hide live streams" calm toggle (calm-hideLive, cd-live attributes on cards/hero/wrappers, selector-map 2026.10.13.4, calm.js safeHide) | S7 | unit 1898/1898; e2e:home 119 PASS; e2e:popup 235 PASS |
| D14 | E5: Channel /streams tab live verification pass + YouTube New UI DOM facts recorded (LIVE-VERIFICATION.md, tiles.test.js stream locks verification) | S8 | unit 1899/1899; live probe on @LofiGirl, @NASA, @SkyNews /streams |
| D15 | E6: Popup status line shows feed live count (`liveCount` on home layout via engine `getStatus()`, popup renders "Working — N live now") | S9 | unit 1903/1903; e2e:home 119 PASS; e2e:popup 235 PASS |
| D16 | E7: `Broadcast` theme candidate authored and verified (broadcast.json, high-contrast dark, 16 px base, live-first hero, full theme gates) | S10 | broadcast-candidate.test.js 5/5 PASS; css-validator PASS |
| D17 | T3: Health verdict persisted beside first-paint entry ({v:1,key,css,attrs,verdict}), applied synchronously at start(), reconciled on first settle | — | unit 1912/1912; e2e:popup 235 PASS |
| D18 | T6: Grid-mode live tiles documented as fail-closed limitation (popup copy "works with rows layouts", ARCHITECTURE §3.5) | S7 | model.js, ARCHITECTURE.md §3.5 |
| D19 | T7: Readability-rate gate headroom (3.5%) & creator-heart comments excluded in e2e audit harness (accommodates YouTube New UI comments) | — | test/e2e-harness.test.js 14/14 PASS; audit.mjs |
| D20 | T5: Write store privacy-policy page (ARCHITECTURE §7.9 items a–e) | — | docs/PRIVACY.md |
| D21 | Custom Theme Import/Export (Spec F9): theme JSON export/import with validation, quota limits, Pro custom CSS gating, popup modal | S11 | unit 1939/1939; theme-schema.test.js; popup/model.test.js; popup/render.test.js |
| D22 | YouTube New UI Forward Compatibility: support for modern Web Component view models in skin fallbacks & selector maps | S12 | content/skin.test.js; e2e:home 119 PASS |
| D23 | Saved Profiles & Time-Based Scheduling (Spec F8): profiles storage, schedule alarm, background checking, popup management UI | S13 | unit 1942/1942; e2e:popup 235 PASS; e2e:home 119 PASS |
| D24 | Visual Theme Editor (Spec F7): visual appearance controls, live YouTube preview (Home/Watch/New UI), contrast auditor, theme save & apply | S14 | unit 1957/1957; editor-model.test.js; editor-dom.test.js; e2e:popup 235 PASS |
| D25 | Watch Page New UI Compatibility (Spec S15): support ytd-watch-grid container in watchMode detection, cinema & focus layouts, live presentation, and selector map 2026.10.14.1 | S15 | unit 1959/1959; watch.test.js; page.test.js; selector-map-data.test.js; ad-safety.test.js |
| D26 | F7–F9 Integration Hardening (WP1–WP6, Audit A01–A09): Versioned storage envelopes (schema 1), serialized worker mutations, stable theme IDs, local-time profile scheduling, Pro gating on editor save/apply, selector-map CSS validation, draft recovery, and import conflict resolution | WP1–WP6 | unit 2007/2007; strict build 74.3 KB gz; e2e matrix PASS |
| D27 | Worker-Popup-Editor Message Contract Hardening (Audit F1–F5): Centralized message builders and readers (`src/shared/messages.js`), bundled fallback for custom CSS validation in local-beta mode, safe worker error propagation in editor, serialized queue schedule integration with slot-boundary override protection | Audit F1–F5 | unit 1995/1995; contract-integration.test.js 4/4; strict build 74.5 KB gz |
| D28 | PRO-3: Calm split (hideComments and hideEndScreens added to FREE_CALM_KEYS; popup and engine gating updated) | PRO-SPEC §4 PRO-3 | unit 2004/2004 PASS; strict build 74.5 KB gz; e2e:popup 235/235 PASS; e2e:home 119/119 PASS |
| D29 | PRO-1: Mix & match layouts (settings.layout {home, watch} overrides gated in computeEffectiveConfig, first-paint cache, new Layout fieldset in popup with lock tags) | PRO-SPEC §4 PRO-1 | unit 2009/2009 PASS; strict build 74.6 KB gz; e2e:popup 235/235 PASS; e2e:home 119/119 PASS |
| D30 | PRO-0: Try Pro for 10 minutes (cd.trial in chrome.storage.session, cd.trialLog daily cap of 3 in local, alarm cd-trial-end, trial in computeEffectiveConfig, popup countdown banner, locked-feature preview sheet) | PRO-SPEC §4 PRO-0 | unit 2009/2009 PASS; strict build 74.8 KB gz; e2e:popup 235/235 PASS; e2e:home 119/119 PASS |
| D31 | Popup Pro card UX (§5.4): "Unlock Cinedrape Pro" card with bullets and founder price, Get Pro buy link pointing to CHECKOUT_URL, "I have a licence" details element collapsed by default, plain-language activation errors, recovery link for Pro | PRO-SPEC §5.4 | unit 2009/2009 PASS; strict build 74.8 KB gz; e2e:popup 235/235 PASS; e2e:home 119/119 PASS |
| D32 | PRO-7: Founder badge and thank-you state (optional tier: 'founder'|'standard' licence claim validation, #founder-badge pill with light/dark AAA contrast, #pro-thank-you copy, #pro-activated-banner on activation) | PRO-SPEC §4 PRO-7 | unit 2025/2025 PASS; strict build 74.8 KB gz; e2e:popup 238/238 PASS |
| D33 | Production licence minting tool (`tools/mint-licence.mjs`, §5.2): requires --order and --tier, sub='ls_<orderId>', plan 'pro', 3 devices, lifetime (no exp), privacy guard against email in token, appends to .keys/sales.csv, npm script licence:mint | PRO-SPEC §5.2 | unit 2031/2031 PASS; test/tools/mint-licence.test.js 6/6 PASS; strict build 74.8 KB gz; e2e:popup 238/238 PASS |
| D34 | PRO-2: Theme Pack 1 (10 pro themes in src/themes/: oled, frost, mocha, midnight-city, ember, paper, matcha, sunset, terminal, imax; contrast & readability compliant, popup grid grouped into Free / Pro / Pack 1) | PRO-SPEC §4 PRO-2 | unit 2061/2061 PASS; strict build 75.8 KB gz; e2e:popup 238/238 PASS; e2e:home 119/119 PASS |
| D35 | Onboarding hooks (§6): chrome.runtime.onInstalled opens https://cinedrape.com/welcome on first install only; setUninstallURL to https://cinedrape.com/bye; no new permissions | PRO-SPEC §6 | unit 2062/2062 PASS; strict build 75.8 KB gz; e2e:popup 238/238 PASS; e2e:home 119/119 PASS |
| D36 | Day 7 Upgrade Card (§6): install tracking via STORAGE_KEYS.install ({installedAt, day7Dismissed}), popup dismissible #day7-card ("Enjoying Cinedrape? Pro adds…"), checkout link with ?checkout[custom][src]=popup_day7, permanent dismissal persistence | PRO-SPEC §6 | unit 2067/2067 PASS; strict build 75.9 KB gz; e2e:popup 238/238 PASS; e2e:home 119/119 PASS |
| D37 | Free-with-Support Migration: universal free access to all 16 bundled themes, mix & match layouts, custom density (1..5), all 6 Calm filters, Profiles & Scheduling, and Theme Studio; replaced Pro unlock card with voluntary "Support Cinedrape" (Buy me a coffee) card & links; updated Day 7 prompt to support invitation | FREE-SUPPORT-LAUNCH-PLAN | unit 2055/2055 PASS; ad-safety 38/38 PASS; strict build 75.8 KB gz |

## Open — bugs / known gaps (from STATUS.md "Known gaps", still true)

| ID | Task | Priority | Owner | Notes |
|---|---|---|---|---|
| T4 | Replace dev keys before any store release (`npm run keys -- --force && npm run sign-map`); dev licences are test-only | P0 for release | owner | Blocking release, not development |

## Open — enhancements (all spec'd enhancements complete)

None (E1–E7 shipped).

## Recurring / every change

| ID | Rule |
|---|---|
| R1 | Any selector-map edit: bump `mapVersion`, `npm run sign-map`, run `test/data/selector-map-data.test.js`, record in `test/data/LIVE-VERIFICATION.md` |
| R2 | Any new `cd-` class or `<html>` attribute: update ARCHITECTURE §3.5, `sanitizePaintAttrs` if it must survive first paint, and the ad-safety scan if it hides |
| R3 | Every change ends with: `npm test`, `npm run build:strict`, and at least one e2e harness pass on real Chrome. The harness never builds: rebuild every variant you point it at first — `node build.mjs --strict --out dist-home` / `--out dist-popup` (stale variants silently test old code) |
| R4 | Ads/sponsorship/player controls remain untouched by every rule — `test/ad-safety.test.js` is the gate, e2e ad check is the confirmation |
