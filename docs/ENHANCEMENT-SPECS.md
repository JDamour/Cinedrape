# Cinedrape — Enhancement Specs (post-audit, 13 Oct 2026)

Source of truth for *how the pieces fit*: `ARCHITECTURE.md`. Source of truth for *what the product is*: `../YouTube Skin Studio — Product Spec.md`.
This file specs the enhancements that follow the 13 Oct 2026 full audit (live UI, text clarity, extension health). Each spec
names its owner modules, the exact data/DOM shapes, the acceptance tests, and the ads/trust constraints it must respect.
Anything that changes a shared shape must also edit `ARCHITECTURE.md` in the same change.

Audit verdict that motivates these: the extension core is healthy (1 874 unit tests, e2e:home 109 checks, e2e:popup 234 checks,
36-visit theme matrix — all 0 fail on 13 Oct), but the UI treated **live streams** (the dominant content of the audited feeds)
exactly like VODs, and two text-clarity floors were missing. S1–S3 are **done** in this change; S4+ are open work.

---

## Done in this change (recorded so the decisions are not re-litigated)

### S1 — Live tile presentation (home layout) — DONE

**Finding.** A live tile's duration field holds the localized live badge (`LIVE`, `EN DIRECT`, …), not a time. The home mirror
rendered that text inside the grey duration pill, gave the viewer count no emphasis, never picked a live tile as the hero, and
the hero CTA said "Watch" for a stream that is already running.

**Implementation.**
- `tiles.js`: `extractTile` returns `isLive: boolean` — true iff the `tileDuration` badge text is non-empty and does not match
  `/^\d{1,3}(?::\d{2}){1,2}$/`. Text-based, language-independent, no new selectors, no map change.
- `home.js` CSS: `.cd-live-badge` (fixed `#cc0000` pill, white text — 5.9:1 on red, uppercase, `letter-spacing:.06em`,
  `font-size:max(.85em,11px)`), `.cd-live-dot` (white, `aria-hidden`), `.cd-card-watching` (viewer count with a leading dot).
  Positioning `.cd-card-thumb .cd-live-badge{position:absolute;right:6px;bottom:6px}` mirrors the duration pill.
- The pulse is `@keyframes cd-live-pulse{0%,100%{transform:scale(1)}50%{transform:scale(.55)}}` — **transform only**: this
  sheet and its tests ban `opacity`/`visibility`/`filter` outright, and the first-paint cache refuses hide-shaped rules.
  Emitted only when `cfg.animations !== false`; disabled again inside the `prefers-reduced-motion` media block.
- `metaParts`: on a live tile the LAST meta text gets `cd-card-watching` (never the channel text), so hideViewCounts can
  target it.
- Hero selection in `hero-rows` mode: first live tile that is usable (own thumb or derivable id) beats the first tile with a
  thumb, which beats the first derivable tile. Live hero CTA text is `Watch live`.
- `calm.js`: `EXTRA.mirrorViews` now also hides `.cd-card-watching` — YouTube's own hideViewCounts rule hides a live row's
  watching text (map rule "exactly two texts, hide the last"), so the mirror must agree.

**Constraints honoured.** The badge is added content (never hides anything); no rule touches `protected.*`; every class stays
inside the §3.5 `cd-` list (updated there); no `opacity` anywhere in the emitted sheet; `@keyframes` is on the first-paint
cache's allow-list of at-rules and its name starts `cd-` (css-validator requirement for theme CSS, kept for our own sheet too).

**Tests.** `tiles.test.js` ("isLive: a bottom-overlay badge…"), `home.test.js` (new `live tiles` blocks + `live CSS` block:
badge, dot, watching span, hero preference, "Watch live", no-badge case, pulse gating), `calm.test.js` (watching span hides
with hideViewCounts). e2e:home + e2e:popup + theme matrix green after the change.

### S2 — Text clarity floors (home layout) — DONE

**Finding.** `.cd-card-meta` was `font-size:.9em`; on Classic (13 px base) metadata rendered at 11.7 px, and any future theme
with a smaller base scaled it further down. The screenshots' serif custom theme showed metadata near illegibility.

**Implementation.** `.cd-card-meta{font-size:max(.9em,12px)}` — an absolute 12 px floor regardless of theme base size; the
live badge carries the same `max(.85em,11px)` floor. Card titles already clamp at 2 lines with `overflow-wrap:anywhere`.

**Tests.** Covered by the CSS text assertions in `home.test.js` (`max(` present in the emitted sheet).

### S3 — Row-splitting and hero geometry (pre-existing working-tree fix, verified and kept) — DONE

**Finding (pre-audit).** Rows split at exactly `chunk` cards, so the page could end on a 1–2-card stub with an empty band; on
short viewports the hero media shrank to 21:9 of its capped height and left an empty band on the right.

**Implementation.** `place()` lets the last row grow to `chunk + visible - 1` before splitting, so no stub rows; hero media
gets `box-sizing:border-box;width:100%` (Chrome otherwise transfers `max-height` through `aspect-ratio` into a `max-width`).
Tab stops are re-established after every split (`ensureTabStop`).

**Tests.** The density and late-arrival tests in `home.test.js` now assert last-row size bounds and one-tab-stop-per-row after
splits.

---

## Open enhancements, in priority order

### S4 — Live row on the home layout ("Live now") — P1, owner: layouts

A dedicated first row that collects every live tile the mirror has, so a live-heavy feed answers "what is on right now" without
scrolling. Hero stays the strongest single live tile (S1); the row gathers the rest.

- Behaviour: in `rows` and `hero-rows`, when ≥ 2 mirrored entries are `isLive`, insert a row titled `Live now` (id
  `cd-row-live`, `aria-labelledby` like the other rows) before the other rows; its cards are the live entries in feed order.
  Re-evaluated in the same rAF-batched `sync()` (a tile going offline simply re-sorts on the next scan — YouTube updates
  badges in place and the href-attribute observer already catches wrapper changes).
- Config: follows `layout-home` (no new feature id, no new entitlement — it is presentation of data we already mirror).
  Opt-out later can ride a `settings.homeLiveRow` boolean if wanted; default **on**.
- CSS: `.cd-row[cd-live] .cd-row-title` carries the live dot glyph in the accent-red family of `.cd-live-badge`; reuse all
  card rules unchanged.
- Ads/trust: no new hiding; live ad items are still never mirrored (`isAdTile` runs before `isLive` matters).
- Tests: `home.test.js` — live-heavy feed produces the row first; no live tiles → no row; a feed with 1 live tile → no row
  (hero covers it); row participates in roving tabindex; row scrolls with the same handlers.
- Risks: row churn if YouTube flips badges often — mitigate by only rebuilding the live row when its membership actually
  changed (compare the joined video-id list).

### S5 — Watch-page live presentation — P1, owner: layouts (watch.js) + selectors

The watch page of a live stream shows `ytd-watch-info-text` with a watching count; Cinedrape themes it like any text.

- Add a `watchLiveBadge`-style presentation: when the watch page's info text matches the map's `viewCounts` selectors AND the
  video is live (evidence: `ytd-watch-flexy[video-id]` page is `/watch` while the info text reads "watching"/localized —
  **text matching is not possible in CSS**; the engine must decide), set `html[cd-watch-live]` next to `cd-watch`.
- CSS (watch.js builder): `html[cd-watch-live]` restyles the info container with the live dot + `#cc0000` accents, keeps
  YouTube's own layout (the player is never moved).
- Selector-map work (selectors owner): no new role strictly required — reuse `watchMetadata`/`viewCounts`. If a dedicated
  role proves cleaner, add `watchInfoText` to `roles` + `pageRoles.watch` (NOT to `requires`: the text node legitimately
  varies).
- Ads/trust: presentation only; nothing hidden; `protected.playerControls` untouched.
- Tests: unit — engine sets the attribute only on watch pages with the evidence (inject a fixture watch page + a fixture live
  info text); CSS builder emits the block under `html[cd-watch-live]` and nothing otherwise. e2e: matrix still 0 fail (the
  attribute must be absent on VOD watch pages — assert in the watch phase).

### S6 — Text size control (popup) — P2, owner: popup + tokens + entitlements

The screenshots' complaint "check the text to be clear" goes beyond floors: users need a control.

- `settings.textScale: null | 0.9 | 1 | 1.1 | 1.25 | 1.5` (null = theme default 1). **Free** (it is an accessibility
  control; gating accessibility behind Pro is hostile and store-review risky).
- `tokens.js`: `buildTokenCss` multiplies `--cd-font-size` by the scale (`calc(var(--cd-font-size) * …)` is not possible —
  write the multiplied value directly; clamp the final px into `[11, 22]`).
- Popup: a five-step segmented control labelled "Text size" with live preview; writes `cd.settings.textScale`.
- Engine: nothing new — settings already flow through storage.onChanged → recompute → stylesheet.
- First-paint cache: `attrs` must grow `cd-textscale` (`sanitizePaintAttrs` gets the closed value set) or the first frame
  uses the unscaled size and restyles — follow decision 14's pattern exactly.
- Tests: tokens (scale multiplies, clamps, null = 1), popup model (valid values, invalid refused), engine first-paint attrs.
- Spec ambiguity to flag: whether textScale also scales `.cd-row-title`/hero (it should — they are em-based already).

### S7 — "Hide live streams" calm toggle — P3, owner: calm + selectors + engine + popup

A new `CALM_KEY` `hideLive` (Pro), hiding live tiles from the feed. **The hard part is YouTube-side hiding: CSS cannot match
text**, and the live badge text is localized.

- Mechanism: the home layout already knows which wrappers are live (S1 evidence). The engine marks them:
  `wrapper.setAttribute('cd-live', '')` on mirrored wrappers — but hiding a wrapper YouTube drew requires the same
  safeHide-guarded collapse used for mirrored tiles, and **only for wrappers that were mirrored** (ads are never mirrored, so
  the existing `:not(:is(adList))` narrowing covers the ad case). Non-mirrored live tiles (grid mode, or layout off) stay —
  documented limitation, same class as hide-view-counts' position reliance.
- Map work: none required (evidence is marker-independent). If grid-mode support is wanted, the selectors owner adds a
  `liveBadge` role (`yt-thumbnail-bottom-overlay-view-model` badge whose text is not a duration cannot be expressed — a
  `:has()` on badge-shape aria-label is locale-dependent; ship it as a best-effort fallback list per locale? NO — fail
  closed, grid-mode stays unsupported and the popup copy says "works with rows layouts").
- Constants: add to `CALM_KEYS` + `FEATURES` (`calm-hideLive`); Pro-gated (`FREE_CALM_KEYS` unchanged). Storage shape grows a
  boolean — `DEFAULT_SETTINGS.calm` gains `hideLive:false`; the seed fix in TASKS T2 must land first or installs never see a
  theme default (they do not need one here, but the same bug bites).
- Popup: a sixth toggle, locked for free users.
- Tests: calm (rule emitted, guarded, gated on the new attr), engine (attribute flows), popup model, ad-safety full pass
  (a live in-feed ad must survive — the mirroring gate already refuses ads, assert it).

### S8 — Channel-page live rows — P3, owner: selectors + layouts

Channel pages with a live tab (`/@handle/streams`) reuse the home grid; the mirror already works there (e2e covers
`channel`). What is missing is only the live badge propagation — `extractTile` is shape-agnostic, so S1 already applies.
Verify on the real `/streams` tab and record DOM facts in `test/data/LIVE-VERIFICATION.md`; fix any shape drift (likely:
`ytd-rich-item-renderer[is-shorts-grid]`-style attributes on the streams grid).

### S9 — Popup "what changed" line — P4, owner: popup

The popup status line says "Working" with theme and page. Extend `GET_STATUS` rendering with the live count of the current
feed when the home layout is mounted (`status.liveCount`), e.g. "Working — 4 live now". Engine: count from the home layout's
entries (`isLive && !dup`); expose via getStatus; popup renders it when present. Purely additive; no storage.

### S10 — Theme store candidates (post-MVP, owner: product)

From the audited usage (news + live-heavy viewer): the `Broadcast` theme (high-contrast dark, 16 px base, live-first hero,
balanced density) is the primary store candidate. It passes `validateTheme`, all six WCAG AA contrast pairs, and the
css-validator allow-list.

- **Theme Metadata & Tier**:
  - `id`: `"broadcast"`, `name`: `"Broadcast"`, `author`: `"Cinedrape"`, `version`: `"1.0.0"`, `tier`: `"pro"`.
- **Tokens**:
  - `type`: `family: "System"`, `baseSize: 16` (large high-legibility base type), `headingWeight: 700`.
  - `shape`: `radius: 4` (crisp television monitor / studio console aesthetic), `shadow: true`, `spacing: 3`.
  - `color`:
    - `bg`: `#08080a` (near-black broadcast backdrop)
    - `surface`: `#121217` (monitor frame / console surface)
    - `text`: `#ffffff` (20.01:1 on bg, 18.67:1 on surface — AAA)
    - `muted`: `#b0b0bc` (9.32:1 on bg, 8.69:1 on surface — AAA)
    - `accent`: `#ff3b30` (studio live / breaking news red — 5.64:1 on bg, passes 3:1)
    - `border`: `#686878` (steel bezel — 3.65:1 on bg, passes 3:1)
- **Layout & Calm Defaults**:
  - `layout`: `{ home: "hero-rows", watch: "cinema", density: 3 }` (hero-rows prioritizes live feed streams per S1).
  - `calm`: `{}`.
- **CSS**:
  - Scoped strictly to `.cd-*` classes (`.cd-hero`, `.cd-hero-title`, `.cd-hero-meta`, `.cd-hero-cta`, `.cd-row-title`, `.cd-card`, `.cd-card-thumb`, `.cd-card-title`, `.cd-card-meta`, `.cd-card-duration`). Zero external URLs, zero comments, zero at-rules, zero hiding of YouTube elements.
- **Verification**: Verified by `test/themes/broadcast-candidate.test.js` against the full theme and validator gates.

---

## Non-goals / explicitly rejected

- **Opacity-based pulses or fades anywhere in layout CSS** — the module contract and the first-paint cache filter forbid the
  shape; transform/`scale` only.
- **Hiding live tiles via CSS text matching** (`:has(*:contains)`-style) — impossible in CSS and locale-fragile; S7 goes
  through engine-side evidence instead.
- **Mirroring the live chat on watch pages** — the player and its DOM are never touched (contract §4 watch.js); live chat
  restyle would fight YouTube's own inline styles for zero product value in the MVP.
