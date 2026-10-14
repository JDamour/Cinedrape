# Cinedrape implementation audit — 14 October 2026

## Decision

Keep the existing extension architecture and finish the integration of the new local features before expanding into sync, payments, AI generation, or a marketplace. The MVP has substantial automated coverage and a passing strict build. The newer editor/profile/import paths contain cross-module defects that their current component tests do not expose.

This audit describes the **working tree**, including modified and untracked source, at baseline commit `104f00e`. It is not a review limited to committed changes. Existing edits were preserved. No application behavior was changed during this audit.

Execution package:

- [Implementation specifications](GEMINI-IMPLEMENTATION-SPECS.md): ordered work packages, contracts, tests, and acceptance criteria.
- [Gemini execution prompt](GEMINI-EXECUTION-PROMPT.md): copy/paste handoff and completion requirements.

## Evidence and limits

| Check | Result on 14 October 2026 | What it establishes |
| --- | --- | --- |
| `npm test` | 1,959 tests, 82 suites; 1,959 passed, zero failed/skipped; 61.85 seconds | Existing automated assertions pass on this working tree |
| `node build.mjs --strict --out dist-audit` | Passed; four JavaScript bundles scanned; zero forbidden-construct matches | Current sources bundle and satisfy existing strict-build checks |
| Content bundle | 75,951 bytes gzip / 153,600-byte budget | Size budget passes; does not establish latency or memory budgets |
| Live Chrome smoke | Chrome 154.0.8037.100, Cinema/watch/light, logged out; one visit, zero failed checks/warnings | A limited live rendering/readability check passes |
| Saved-profile reproduction | `resolveProfileSettings('prof-day', [profile])` returns `null`; ID-keyed object resolves | Popup array and scheduler lookup contracts disagree |
| Runtime | Node 25.2.1; npm 11.6.2 | Audit execution environment |

The live report is [report.md](../test/e2e/out-audit/report.md), with machine-readable output alongside it. That run used `--no-perf`; it establishes neither first-paint overhead, switching speed, nor memory overhead. It did not validate populated logged-in home feeds, real ads, all themes, editor geometry, or accessibility with assistive technology. Historical live DOM observations in repository documents were read as historical evidence, not re-certified by this single run.

## Implementation inventory

| Area | Implementation observed | Audit assessment |
| --- | --- | --- |
| F1 theme engine | Data-driven tokens, stylesheet composition, navigation/storage updates, first-paint cache, teardown | Preserve; integration and browser validation remain essential |
| F2 themes | Six bundled themes; Broadcast candidate outside launch roster | Preserve six-theme launch roster; candidate promotion is separate work |
| F3 layouts | Home mirrored hero/rows; watch cinema/focus; density | Preserve player ownership, original tiles, continuations, ad guards |
| F4 popup | Theme/accent/density/motion/text scale, licence/status, extra feature panels | Mature settings flow; newer collection mutations bypass its error handling |
| F5 calm | Six toggles, including new live-stream hiding | Preserve signed selector map and protected-element behavior |
| F6 health | Feature-specific selector requirements and notices | Existing known grid-requirement gap is already fixed in source |
| F7 editor | Controls, token preview, contrast display, templates, JSON export, save/apply | Partial: entitlement, identity, preview fidelity, loading and recovery need work |
| F8 profiles/schedule | Popup CRUD, pure helpers, worker alarm and time selection | Cross-module defect prevents scheduling popup-created profiles |
| F9 transfer | Theme JSON import/export and engine storage updates | Partial: ID collisions, trust feedback, persistence failures, portability validation |
| F10–F12 | No account sync, AI generation service, marketplace | Future roadmap, not defects in the current local extension |
| Release | Strict build and package guards, signed maps/licences, privacy document | Dev key sentinel and disclosure/documentation gaps remain |

## Findings

Priorities: P0 = block release of affected behavior; P1 = complete before the next public feature release; P2 = usability/maintenance work after integration is reliable. These findings are not claims that every feature is broken.

### A01 — P0: scheduler cannot resolve popup-created profiles

**Evidence:** `src/popup/app.js` saves `cd.profiles` as `[...state.profiles, res.profile]` and loads it only as an array. `src/shared/profiles.js::resolveProfileSettings` reads `profiles[profileId]`. `src/background/service-worker.js::checkSchedule` passes the stored collection directly to that helper.

**Impact:** a user can create/select a profile and enable scheduling, but the alarm returns `profile-not-found`. Bundled theme-ID schedules still work, which is what the existing worker test exercises. Popup tests confirm stored configuration without completing the worker application path.

**Fix:** WP1 and WP2. Add the exact popup-storage → worker-alarm regression before changing the representation.

### A02 — P1: schedule validation, lifecycle and reference integrity are incomplete

**Evidence:** `validateSchedule` substitutes invalid/missing IDs with default theme IDs and accepts equal times. Popup selectors list only saved profiles. Deleting a profile does not repair schedule references. Worker `initialise` ensures alarms but does not call `checkSchedule`; the `cd:updateSchedule` branch has no extension-page sender check. `updateScheduleAlarm` claims Pro awareness in its comment but checks only `schedule.enabled`. Worker scheduling reads persisted configuration without using the shared validators.

**Impact:** the UI can display empty choices while storage silently targets Cinema; deleted profiles leave ineffective schedules; startup application waits for an alarm; scheduling wakes the worker while free; manual changes are overwritten every minute without an explicit override policy.

**Fix:** WP2 specifies local-time semantics, missing references, entitlement transitions, startup reconciliation, sender checks, and manual override behavior. A one-minute alarm is a target, not an unconditional timing guarantee: Chrome can delay alarms, does not wake a sleeping device, and older Chrome versions need alarm reconciliation. See [Chrome alarms documentation](https://developer.chrome.com/docs/extensions/reference/api/alarms) and [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

### A03 — P1: editor save/apply has no verified Pro check and can report success without storage

**Evidence:** `src/editor/editor.js::saveTheme` validates schema and writes storage without requesting/verifying licence state. Its unavailable-storage branch returns `true` and says the theme was saved locally, although no persistence occurs. Template copying preserves the source theme tier; free templates can produce free-tier custom themes.

**Impact:** F7's Pro restriction is inconsistent across entry points. A free user can reach the editor directly and save/apply a free-tier template copy. Pro-tier custom selections can be written even when the engine later suppresses them. Missing storage produces false success feedback.

**Fix:** WP3. Centralize feature entitlement policy; allow preview/export for free users as a deliberate policy, but require verified Pro for editor save/apply. This is local product enforcement, not a tamper-proof DRM claim.

### A04 — P1: theme identity can collide with bundled or existing custom themes

**Evidence:** `editor-model.js::updateThemeProperty` regenerates ID whenever name changes. Editor save and popup import overwrite entries by ID without confirmation. Popup `usableThemes` keeps bundled IDs first; the engine lists bundled themes before custom themes. Import and save do not reject reserved bundled IDs.

**Impact:** importing a modified theme named/identified as Cinema can report activation while the bundled Cinema wins resolution. Renaming a saved draft can create a second entry; same-ID import can destroy an earlier custom theme.

**Fix:** WP1 and WP4: stable local identity, reserved IDs, explicit replacement, copy behavior, dependency checks, and migration without data loss.

### A05 — P1: save/import validation feedback differs from runtime CSS validation

**Evidence:** editor calls `validateEditorTheme(currentTheme)` and popup calls `importTheme(text)` without a selector map. `theme-schema.js::checkCss` deliberately skips CSS checking without a map. Editor collects `cssErrorBox` but does not populate it. Runtime `stylesheet.js::themeCssVerdict` correctly revalidates against the active map and skips rejected CSS.

**Impact:** unsafe/unsupported CSS can be stored as a supposedly valid theme and then be omitted at runtime; user sees a different result from what save/import claimed. **This audit did not find a CSS injection bypass:** the runtime gate remains present.

**Fix:** WP3/WP4: same verified-map validation at preview, save, import, and runtime; distinguish schema validity, CSS validity, contrast, persistence, and actual application.

### A06 — P1: new popup collection writes lack persistence/race handling

**Evidence:** import, custom-theme delete, profile save/delete and schedule handlers call `chrome.storage.local.set` directly, frequently mutating in-memory state first. Import ignores the Boolean result from `commit` then announces activation. Profile application also announces success after `commit` regardless of its result. The older settings flow has a serialized queue, error notice, and reload.

**Impact:** storage rejection can leave optimistic state and unhandled event-handler rejections; import may say activated after application failed. Popup and editor can overwrite each other's collection updates through separate read/modify/write cycles.

**Fix:** WP1/WP4: worker-owned serialized mutation handlers, expected-revision checks, accurate result states, reload after failure, pending UI, and concurrent-client tests.

### A07 — P1: editor preview does not implement every advertised control

**Evidence:** `syncPreviewTokens` applies tokens and three layout attributes. Editor CSS contains no `cd-home`, `cd-watch`, or `cd-density` selectors. Calm changes do not set preview attributes; custom CSS is not applied. The preview is custom sample markup rather than the runtime stylesheet/fixture pipeline. Editor opens a fresh starter theme and has no saved-theme loading path.

**Impact:** layout/density/calm/custom CSS controls can change the model without showing their effect. F7's live-preview/save/edit loop is incomplete. This is a code-path finding; complete visual fidelity was not measured in this audit.

**Fix:** WP3: isolated fixture-based preview, runtime builders, editing existing themes, drafts, reset/undo, and browser screenshot tests. Label preview limitations visibly.

### A08 — P2: editor input and accessibility behavior needs hardening

**Evidence:** hex text inputs are adjacent to labels targeting only their color pickers; invalid hex changes are silently ignored. View buttons use radio roles/checked state but lack the popup's established arrow-key/roving-tab-stop pattern. No general inline schema-error rendering exists.

**Impact:** a typed invalid value can disagree with the saved model; keyboard and screen-reader workflows are incomplete. The existing polite notice and CSS alert elements are useful foundations.

**Fix:** WP3/WP5: explicit field labels, inline errors and descriptions, correct radio-group keyboard behavior, focus handling, zoom/overflow checks.

### A09 — P1: current documentation and release assurances overstate or misdescribe implementation

**Evidence:** README says MVP F1–F6 only and about 1,700 tests. STATUS lists grid-health requirements and install calm defaults as open, although source has fixed both. HANDOFF and ENHANCEMENT-SPECS include work that now exists. Privacy policy uses `cd.map`, while the code uses `cd.selectorMap`, and omits custom themes, profiles, and schedules. README says packaging blocks until backend/trademark/privacy/ad review tasks are done; `tools/package.mjs` mechanically checks build, manifest permissions and key sentinel, not all those tasks. `KEY_STATUS` is currently `dev`.

**Impact:** Gemini can rebuild completed work, users get inaccurate storage disclosures, and a passing package command can be mistaken for full release clearance. Configuring API hosts also conflicts with the package script's fixed YouTube-only host check.

**Fix:** WP6: documentation reconciliation, explicit manual release evidence, deliberate local-beta release mode, and separate future connected-service configuration. Do not rotate keys as part of this audit/spec work.

## What to preserve

- Plain JavaScript modules, injected dependencies, no runtime framework requirement.
- Pure schema/token/licence/signing helpers and the runtime CSS gate.
- Feature-specific fail-open behavior and original YouTube DOM restoration.
- Protected ads, sponsorship disclosures, player controls, and infinite-scroll continuations.
- Minimal current permissions; no content-script network calls or telemetry additions.
- Separate production/dev builds and release refusal for development keys.
- Extensive existing tests; add boundary regressions instead of replacing tests to match an implementation.

## Recommended implementation order

1. WP1: shared persistence contracts and serialized writes; reproduce A01/A04/A06.
2. WP2: scheduler integration and lifecycle; prove popup-created profile application.
3. WP3/WP4: editor and transfer correctness using the same store and validation boundary.
4. WP5: feature browser matrix, accessibility, ad safety and performance evidence.
5. WP6: reconciled documentation and release readiness.

Sync, AI generation, marketplace, payment flows, new theme promotion, and speculative broad refactors remain outside this execution package. Their absence is recorded, not silently scheduled for implementation.
