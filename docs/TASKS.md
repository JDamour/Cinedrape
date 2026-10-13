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

## Open — bugs / known gaps (from STATUS.md "Known gaps", still true)

| ID | Task | Priority | Owner | Notes |
|---|---|---|---|---|
| T3 | Persist the health verdict beside the first-paint entry and reconcile on first settle, so a broken feature stops flashing on for ~6 s after every load | P2 | engine + health | Spec'd in STATUS known-gaps; needs a storage shape decision (see S6's attrs precedent) |
| T4 | Replace dev keys before any store release (`npm run keys -- --force && npm run sign-map`); dev licences are test-only | P0 for release | owner | Blocking release, not development |
| T5 | Write the privacy-policy page the store listing requires (ARCHITECTURE §7.9 items a–e) | P0 for release | owner | Must state localStorage footprint + future API_BASE token POST |
| T6 | Grid-mode live tiles: S7's hideLive does not reach grid mode (no text matching in CSS); either accept + document or add engine-side marking for unmirrored wrappers | P3 | selectors + engine | Fail-closed decision recorded in S7 |
| T7 | The matrix readability-rate gate (3%) is marginal against icon-only YouTube decorations: one creator-heart comment flipped `classic/watch/dark` (3.2%), gone on re-run. Either exclude icon-only/aria-hidden SVG samples from the rate or raise the gate's headroom | P3 | e2e harness owner | Repro: `node test/e2e/run.mjs --pro --mode dark --pages watch --themes classic --shots none` (not reproducible deterministically — it depends on which comments YouTube serves) |

## Open — enhancements (all spec'd enhancements complete)

None (E1–E7 shipped).

## Recurring / every change

| ID | Rule |
|---|---|
| R1 | Any selector-map edit: bump `mapVersion`, `npm run sign-map`, run `test/data/selector-map-data.test.js`, record in `test/data/LIVE-VERIFICATION.md` |
| R2 | Any new `cd-` class or `<html>` attribute: update ARCHITECTURE §3.5, `sanitizePaintAttrs` if it must survive first paint, and the ad-safety scan if it hides |
| R3 | Every change ends with: `npm test`, `npm run build:strict`, and at least one e2e harness pass on real Chrome. The harness never builds: rebuild every variant you point it at first — `node build.mjs --strict --out dist-home` / `--out dist-popup` (stale variants silently test old code) |
| R4 | Ads/sponsorship/player controls remain untouched by every rule — `test/ad-safety.test.js` is the gate, e2e ad check is the confirmation |
