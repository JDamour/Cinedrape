# Cinedrape Pro — Product & Build Spec

14 Oct 2026. Companion to `../YouTube Skin Studio — Product Spec.md` (what the product is), `ARCHITECTURE.md` (how pieces
fit), `MARKET-AND-MONETIZATION-ANALYSIS.md` (why). Anything here that changes a shared shape must also edit `ARCHITECTURE.md`
in the same change, and every change still ends with `npm test`, `npm run build:strict` and an e2e pass (TASKS R3).

## 1. Goal and offer

**Goal:** a Pro unlock that a free user *wants* after one week of use, sold for a one-time price, delivered without a heavy
backend, launched within ~2 weeks.

| | |
|---|---|
| Model | Freemium. Generous free core; one Pro unlock |
| Price | **Founder \$9 one-time** (first 200 buyers or first 30 days, whichever first), then **\$15 one-time**. "Pay more if you want" enabled |
| Includes | Everything in §3 + **every future Pro feature** (profiles, editor, new theme packs) |
| Devices | Up to 3 browsers per licence (honour system; claim `devices: 3`) |
| Refund | 14 days, no questions |
| Payments | Lemon Squeezy (merchant of record: handles VAT/sales tax). Confirm payout support for the business's country before build |
| Never | Ads, data selling, ad hiding, nagging inside YouTube pages |

**Positioning line:** *"Free forever. Pro turns YouTube into your own space — and keeps an indie developer building it."*

## 2. Why the current Pro is not enough (baseline)

Layouts ride on themes (`entitlements.js` `isFeatureAllowed`), and the free **Cinema** theme already ships `hero-rows` +
`cinema` watch. Today Pro = 3 colour themes + density + 4 calm toggles. Unhook gives the calm toggles away free. Pro must gain
real, visible value — §3 below.

## 3. Free vs Pro (target state at launch)

| Capability | Free | Pro | Change from today |
|---|---|---|---|
| Themes Cinema, Minimal, Classic | ✅ | ✅ | — |
| Themes Prime Time, Studio, Arcade | 👁 preview | ✅ | — |
| **Theme Pack 1: 10 new looks** (PRO-2) | 👁 preview | ✅ | new |
| Theme's own layout (e.g. Cinema hero rows) | ✅ | ✅ | — (keep: it is the free "wow") |
| **Mix & match layout** with any theme (PRO-1) | 🔒 | ✅ | new |
| Density slider | 🔒 | ✅ | — |
| Accent colour, text size, animations | ✅ | ✅ | — |
| Calm: hide Shorts, home recs, **comments, end screens** | ✅ | ✅ | comments + end screens become free |
| Calm: hide view counts, hide live | 🔒 | ✅ | — |
| **Try Pro for 10 minutes** (PRO-0) | ✅ | n/a | new |
| **Founder badge + thank-you** (PRO-7) | — | ✅ | new |
| Profiles & schedule (PRO-5) | — | ✅ | v1.1 |
| Theme editor + export (PRO-6) | import only | ✅ | v1.2 |

## 4. Feature specs

Each feature: what it does, data shape, owner modules, acceptance. IDs are stable; track them in `TASKS.md`.

### PRO-0 — Try Pro for 10 minutes (launch, P0)

The single biggest conversion lever: let free users *see* Pro on their own YouTube.

- Locked theme / layout / density tap → sheet: preview image + **"Try it for 10 minutes"** + **"Get Pro — \$9"**.
- Trial state lives in `chrome.storage.session` (cleared on browser restart) as `cd.trial = { until: <ms>, used: <count> }`.
  Max **3 trials per day**, counted in `chrome.storage.local` `cd.trialLog = { day: 'YYYY-MM-DD', count }`.
- `computeEffectiveConfig` gains input `trial: boolean`; when true, Pro gates open exactly as if `pro` (but `cfg.pro` stays
  false and `cfg.trial` is true so UI can show a countdown).
- On expiry the service worker (alarm `cd-trial-end`) clears the trial; the tab falls back with no reload, user's stored
  choices are kept (same fail-soft path as a lapsed licence).
- Popup shows a slim banner: *"Previewing Pro · 7:42 left · Keep it — \$9"*.

**Acceptance:** trial applies within 1 s; expiry reverts within 5 s of the alarm; 4th trial in a day is refused with a
message; stored settings are identical before and after a trial; unit tests on entitlements with `trial`.

### PRO-1 — Mix & match layouts (launch, P0)

- New settings fields: `settings.layout = { home: 'grid'|'rows'|'hero-rows'|null, watch: 'default'|'cinema'|'focus'|null }`
  (`null` = use the theme's). Added to `DEFAULT_SETTINGS` as `{home:null, watch:null}`; settings `schema` stays 1 (additive,
  absent = null).
- `entitlements.js`: `home`/`watch` = `(pro || trial) && override !== null ? override : themeLayout`. Health-check
  disables (`layout-home`, `layout-watch`) still win.
- Popup: new **Layout** fieldset under Theme — two segmented controls (Home: Grid / Rows / Hero + rows; Watch: Standard /
  Cinema / Focus) and a "Use the theme's layout" link. Free users see the controls with a lock tag; tap opens the PRO-0 sheet.
- First-paint cache must carry the override (see `sanitizePaintAttrs`) so there is no flash of the theme layout.

**Acceptance:** every theme × every home layout × every watch layout renders without failed readability checks (extend the
e2e theme matrix with a `--layouts` flag, at least logged-out home + watch); switch < 150 ms; free licence ignores stored
overrides; unit tests for all gate combinations.

### PRO-2 — Theme Pack 1: ten new looks (launch, P0)

Themes are JSON (data, no code) in `src/themes/`, `tier: "pro"`. Original names only (product spec compliance rule: no
third-party brand names). Each brief below gives the target mood; final colours must pass the contrast gate (WCAG AA text,
the 3 % readability-rate gate) in light and dark YouTube.

| id | Name | Brief | Default layout |
|---|---|---|---|
| `oled` | True Black | Pure #000 surfaces for OLED screens, white text, single cool accent | hero-rows / cinema |
| `frost` | Frost | Arctic slate blues, soft cyan accent, calm developer look | grid / default |
| `mocha` | Mocha | Warm dark pastel (lavender, peach accents), cosy | rows / cinema |
| `midnight-city` | Midnight City | Deep navy with neon violet/blue accents | hero-rows / cinema |
| `ember` | Ember | Retro warm dark (olive, rust, cream text) | grid / default |
| `paper` | Paper Study | Warm off-white, serif headings, roomy, calm defaults (`hideHomeRecs`, `hideShorts`) | grid / focus |
| `matcha` | Matcha | Light sage greens, soft and quiet | rows / focus |
| `sunset` | Sunset | Light pastel peach → pink accents, playful | hero-rows / default |
| `terminal` | Retro Terminal | Black + phosphor green, monospace-feel system font, dense | grid / default |
| `imax` | Big Screen | Near-black, oversized hero, density 5, minimal chrome | hero-rows / cinema |

- Update `ALL_THEME_IDS` / `RESERVED_THEME_IDS`; `FREE_THEME_IDS` unchanged.
- Popup theme grid: group into **Free**, **Pro**, **Pack 1** headings; Pro tiles show a lock and open PRO-0 on tap.
- Budget: `content.js` stays < 150 KB gz (`build:strict`); each theme JSON < 3 KB.

**Acceptance:** each theme passes `theme-schema` validation and covers home, watch, search, channel, subscriptions;
full e2e matrix (16 themes × 3 pages × 2 modes) with 0 failures; screenshot of every theme saved for the store/website.

### PRO-3 — Calm split (launch, P0)

- `FREE_CALM_KEYS = ['hideShorts','hideHomeRecs','hideComments','hideEndScreens']`; Pro adds `hideViewCounts`, `hideLive`.
- Update the popup gating tests (e2e:popup "7-switch gating") and `entitlements` tests.
- Ads/sponsorship/player-controls rules unchanged (TASKS R4; `ad-safety.test.js` is the gate).

### PRO-4 — Density (exists)

No change. Keep in the Pro list and the comparison table.

### PRO-7 — Founder badge and thank-you (launch, P1)

- Licence claims gain optional `tier: 'founder'|'standard'` (additive; `parseClaims` keeps unknown-field drop behaviour, so
  add it to the known fields with validation).
- Popup Pro card when active: *"Founder · thank you for supporting Cinedrape"* with a small badge; standard buyers see
  *"Pro · thank you"*.
- On successful activation: a one-time confetti-free success state (respect reduced motion) + "What's included" list.

### PRO-5 — Profiles & schedule (v1.1, P1)

Uses reserved keys `cd.profiles`, `cd.schedule` and `DEFAULT_SCHEDULE`, messages `SAVE_PROFILE`, `DELETE_PROFILE`,
`APPLY_PROFILE`, `UPDATE_SCHEDULE`, permission `alarms` (already granted).

- Profile = `{ id, name, themeId, accent, layout, density, textScale, calm }`, max `LIMITS.maxProfiles` (10).
- Popup: profile chips row above Theme ("Study", "Cinema", "+ Save current").
- Schedule: day profile at `dayTime`, night profile at `nightTime`; manual change sets `manualOverrideUntil` = next switch.
- **Acceptance:** switch within 1 minute of the set time (spec F8); survives browser restart; lapsed licence keeps profiles
  stored but applies only free-allowed values.

### PRO-6 — Theme editor (v1.2, P1)

Spec F7, files `src/editor/{editor.html,editor.css,editor.js,editor-model.js}` (already listed in the `ARCHITECTURE.md` file map).

- Controls: 6 colour tokens, font (bundled `FONT_STACKS` only — nothing downloaded), base size, heading weight, radius,
  shadow, spacing, layout home/watch, density, calm defaults. No raw CSS in v1.2.
- Live preview on the open YouTube tab (via the existing settings path) plus a static preview pane.
- Contrast warnings inline (`shared/contrast.js`); saving a failing theme requires explicit confirmation.
- Storage `cd.customThemes`, max 10 themes, 64 KB each; draft autosave in `cd.editorDraft`.
- Export: share code (base64url of the theme JSON) + `.json` file. Import works for everyone (spec F9), but applying an
  imported theme that uses Pro-only options needs Pro.

## 5. Payment and activation

The extension already verifies signed tokens offline (`shared/licence.js`, `background/licence-manager.js`). Payment only
has to **produce a signed token and get it to the buyer**.

### 5.1 Lemon Squeezy setup

- Store: *Cinedrape*. Product: *Cinedrape Pro (lifetime)*. Variants: **Founder** (\$9, pay-what-you-want, min \$9, suggested
  \$12) and **Standard** (\$15). Founder variant switched off manually at 200 sales / day 30.
- Refund policy, privacy policy and contact URLs point at cinedrape.com (§7).
- Checkout link opened from the popup with `?checkout[custom][src]=popup` for attribution. No data about the user's YouTube
  use is ever passed.

### 5.2 Phase A — manual delivery (launch week; fine for the first ~50 sales)

1. Replace the dev keys first: `npm run keys -- --force && npm run sign-map` (TASKS T4). Back up `.keys/` offline.
2. New tool `tools/mint-licence.mjs` (production twin of `dev-licence.mjs`): requires `--order <id>`, `--tier
   founder|standard`, mints `{ v:1, sub:'ls_<orderId>', plan:'pro', iat, devices:3, tier }` with **no `exp`**, appends
   `orderId, sub, tier, iat` to `.keys/sales.csv`. `sub` is the order id, not the email — the token is readable base64, so
   it must not carry personal data.
3. On each Lemon Squeezy sale email: run the tool, email the token to the buyer with the activation steps (template in §5.5).
   Target: token delivered within 12 hours.

### 5.3 Phase B — automatic delivery (v1.1)

Cloudflare Worker (free tier) + KV + an email API (Resend/Postmark free tier):

| Route | Does |
|---|---|
| `POST /ls/webhook` | Verifies the `X-Signature` HMAC with the webhook secret. On `order_created`: idempotent by order id, mints the token (private key in a Worker secret), stores `order → {sub, tier, status:'active'}` in KV, emails the token. On `order_refunded`: sets `status:'revoked'` |
| `POST /licence/refresh` | Contract already defined in `licence-manager.js`: body `{token}` → `{"status":"active"}` or `{"status":"revoked"}` |
| `POST /licence/resend` | Body `{email}` → re-emails tokens for that email's orders (rate-limited, always answers 200 to avoid email probing) |

Then set `API_BASE` in `src/background/service-worker.js`. This also turns on the 6-hourly selector-map refresh.
Privacy policy must disclose the weekly `{token}` POST (ARCHITECTURE §7.9).

### 5.4 Activation UX (popup)

- Pro card (free state): headline *"Unlock Cinedrape Pro"*, 4 bullets (16 themes, mix & match layouts, full calm, every
  future update), price line *"\$9 once · Founder price"*, primary button **Get Pro** (opens checkout), secondary
  **I have a licence** (expands the existing token form — collapsed by default instead of `open`).
- Paste field accepts the token with line breaks/spaces (already normalised).
- Errors in plain words: *"That token isn't valid — check you copied all of it"*, *"This token was refunded"*.
- After activation: Pro state, Founder/standard thank-you (PRO-7), "Lost your licence? cinedrape.com/recover".

### 5.5 Buyer email template

> Subject: Your Cinedrape Pro licence
> Thanks for supporting Cinedrape! 1) Open YouTube and click the Cinedrape icon. 2) Choose **I have a licence**. 3) Paste
> the token below and press **Activate Pro**. Works on up to 3 browsers. Refunds within 14 days: just reply to this email.
> `<token>`

## 6. Upgrade moments (where users meet the offer)

Respect users: the offer appears **only inside Cinedrape's own UI**, never injected into YouTube pages.

| Moment | What appears |
|---|---|
| Tap a locked theme, layout, density or calm toggle | PRO-0 sheet (preview + Try 10 min + Get Pro) |
| Trial ends | Popup banner: *"Liked it? Keep it for \$9."* (once per trial) |
| Day 7 after install, popup opened | One dismissible card: *"Enjoying Cinedrape? Pro adds…"*; never shown again after dismissal |
| Install | `chrome.runtime.onInstalled` opens `cinedrape.com/welcome` (no new permission): 30-second tour, Free vs Pro table |
| Uninstall | `chrome.runtime.setUninstallURL('https://cinedrape.com/bye')`: one-question survey (why did you leave?) |

## 7. Website (one page + legal, launch, P0)

Static site on Cloudflare Pages or GitHub Pages, domain cinedrape.com.

- `/` — before/after video, Add to Chrome, three looks carousel, Free vs Pro table (from §3), price, FAQ (privacy, ads are
  never hidden, refunds, devices, "not affiliated with Google").
- `/welcome`, `/bye`, `/recover` (Phase B form; Phase A: "email us").
- `/privacy` — no browsing data collected; storage keys used; licence token POST (Phase B); Lemon Squeezy processes payment.
- `/terms` + `/refunds` — 14 days; lifetime = life of the product; one licence = 3 browsers.
- `/contact` — support email.

## 8. Store listing

- Title: *Cinedrape — Themes for YouTube™*. First line states the offer honestly: *"Free themes, layouts and calm mode.
  Optional one-time Pro unlock."*
- Screenshots: before/after, Cinema hero rows, mix-and-match, Theme Pack grid, calm mode, Pro popup.
- Disclosures match `/privacy` exactly (TASKS T5). Single purpose: restyle YouTube.

## 9. Metrics and decision rules

Counted without telemetry on users' browsing: Lemon Squeezy dashboard (sales, refunds, source param), store installs/active
users, uninstall survey, and opt-in local counts only if the user enabled telemetry.

| Metric | Target | If missed |
|---|---|---|
| Install → first theme applied | ≥ 70 % | Fix onboarding / welcome page |
| Paid / weekly active users (6-week cohort) | ≥ 2 % | < 0.5 %: change what Pro contains before cutting price |
| Refund rate | < 5 % | Read refund reasons; fix the claim or the bug |
| Week-4 retention | ≥ 30 % | Calm/learning angle before more themes |
| Token delivery time (Phase A) | < 12 h | Move to Phase B early |

## 10. Release plan

| Release | Contents | Gate to ship |
|---|---|---|
| **Launch (≈ 2 weeks)** | T4 keys, PRO-0, PRO-1, PRO-2, PRO-3, PRO-7, Pro card UX (§5.4), Phase A delivery, website + privacy (T5), store listing | All tests + e2e matrix green; 3 real test purchases end-to-end (buy → token → activate → refund) |
| **v1.1 (+2 weeks)** | Phase B Worker + `API_BASE`, PRO-5 profiles & schedule, `/recover` | Webhook idempotency + refund revoke tested |
| **v1.2 (+4 weeks)** | PRO-6 editor + share codes, Theme Pack 2 if Pack 1 sells | Editor passes contrast + CSS validator tests |
| Later (only with demand) | AI theme generation (credits), marketplace (needs marketplace-eligible payments, see analysis doc) | Repeat-purchase evidence |

## 11. Out of scope

Subscriptions, accounts/sign-in, sync, AI, marketplace, mobile, Firefox (until Chrome sells), strong copy protection
(accepted: a determined user can bypass local checks — spec "Licence checks").

## 12. Open decisions for the owner

1. Business country and Lemon Squeezy payout eligibility (blocks payments).
2. Founder cap: 200 buyers vs 30 days.
3. Final theme colours for Pack 1 (briefs above; screenshots before commit).
4. Support email address and refund handling owner.
