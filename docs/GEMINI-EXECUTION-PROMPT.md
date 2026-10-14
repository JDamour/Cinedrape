# Gemini execution prompt — Cinedrape integration

Paste the text below into Gemini with repository access to `E:\Cinedrape`.

---

You are implementing the next integration batch for **Cinedrape**, a plain-JavaScript Chrome Manifest V3 extension that themes desktop YouTube and adds layouts/calm controls. Work in `E:\Cinedrape` using PowerShell-compatible commands. Keep the existing architecture and improve the current working tree; do not restart the product.

First inspect `git status --short`. The repository already contains modified and untracked implementation files. Preserve unrelated user edits, do not reset or overwrite whole modules, and review the current source before assuming the audit snapshot still applies.

Read these files in order:

1. `docs/IMPLEMENTATION-AUDIT-2026-10-14.md` — source-backed findings, verified baseline and limits.
2. `docs/GEMINI-IMPLEMENTATION-SPECS.md` — full work packages WP1–WP6, target contracts and acceptance criteria.
3. `docs/ARCHITECTURE.md` — module contracts, signed selector maps, DOM facts, safety and product decisions.
4. `YouTube Skin Studio — Product Spec.md` — product intent and performance/accessibility targets.
5. Current source/tests for the work package, then README/STATUS/TASKS/ENHANCEMENT-SPECS/PRIVACY. Some historical documents are stale; confirm implementation against source.

The audit baseline on 14 October 2026, commit `104f00e` plus working-tree changes, passed 1,959 unit tests and the strict build. Content gzip was 75,951 bytes under a 153,600-byte budget. One logged-out Chrome 154 Cinema/watch/light smoke visit passed, with performance disabled. These results do not prove all browser flows or release readiness.

Your immediate objective is **reliable local F7–F9 integration**, preserving F1–F6, text scaling and live-video additions. Execute in batches:

- WP1: shared collection formats/migrations, stable custom-theme IDs, reserved IDs, worker-owned serialized mutations, revision conflicts and safe persistence results.
- WP2: fix scheduling of popup-created profiles; finish validation, references, lifecycle, local-time semantics, Pro suspension/restoration and manual override behavior.
- WP3: complete editor entitlement checks, loading saved themes, honest save states, shared CSS/schema validation, fixture-based isolated preview, drafts and accessible interaction.
- WP4: import/export roundtrip, collision choices, dependency-aware deletion, validation and accurate saved/selected/applied feedback.
- WP5: boundary integration tests, feature browser matrix, runtime/performance/ad-safety evidence.
- WP6: update storage/API contracts and stale documentation; clearly distinguish mechanical package checks from manual release gates.

Start by reproducing the scheduler mismatch: popup stores `cd.profiles` as an array; `resolveProfileSettings` currently looks up `profiles[id]`. Existing worker tests use bundled theme IDs and therefore miss it. Add a test that saves the exact popup record, fires the registered schedule alarm and verifies full settings plus engine application. Do not repair only the helper while leaving UI/worker/storage contracts inconsistent.

Also reproduce these existing defects before fixing them:

- Editor Save/Apply does not verify Pro, and unavailable storage falsely reports a successful local save.
- Name changes regenerate IDs; same-ID imports overwrite; reserved bundled IDs are accepted but bundled themes win lookup.
- Save/import omit the selector map from CSS validation even though runtime correctly rejects unsafe CSS. Preserve that runtime gate; do not claim a demonstrated injection vulnerability.
- New popup collection handlers bypass existing persistence/retry behavior and announce success even after failed application.
- Editor layout attributes have no corresponding preview CSS, calm/custom CSS preview is incomplete, and saved themes cannot be reopened through the current editor flow.

Hard constraints: no eval/new Function, remote code/fonts, new content-script network, telemetry, backend, accounts, framework migration or runtime dependencies. Do not hide/cover ads/disclosures, replace or move the YouTube player, disrupt infinite-scroll sentinels, or weaken CSS allow-lists. Preserve per-feature fail-open and stored Pro preferences. Do not publish, deploy, rotate keys, change API_BASE or activate connected services. Plain JavaScript/JSDoc and injected Chrome/DOM dependencies remain the standard.

Scheduling is an awake-browser one-minute target. Chrome can delay alarms and sleeping devices do not wake for them. Reconcile immediately on lifecycle/configuration events and use current local time after waking; avoid keepalive tricks or false exact-time promises. Refer to official Chrome alarms/lifecycle documentation linked in the spec when selecting APIs, and preserve the declared minimum browser compatibility or document an explicit supported-version change.

For each batch: write meaningful failing regressions, implement the coherent fix, run relevant tests, update the architecture contract, and inspect the resulting diff. Use existing `LIMITS` and shared validation instead of duplicated literals/policies. Track completion against acceptance criteria, not file counts.

Final checks:

```powershell
npm test
node build.mjs --strict --out dist-verification
node test/e2e/run.mjs --extension dist-verification --pro --mode both --pages channel,search,watch --viewport 1280x720 --no-perf --shots view --out test/e2e/out-integration
```

The Pro browser command requires existing matching test keys/licence support. If unavailable, report the missing setup without rotating production keys. Add/run focused editor, import and scheduling browser scenarios per WP5; the readability command alone is insufficient. Run the existing home/calm and popup/breakage harnesses after inspecting their current CLI/build behavior. Measure performance separately, since the command above deliberately skips it.

Finish with a concise report containing changed files, A01–A09 resolution, WP1–WP6 acceptance results, test/build/browser commands and evidence paths, unresolved risks, and accurate release status. Report unrun/blocked external gates explicitly. Never label logged-out synthetic ad tests as verified real-ad safety or a passing package command as approval to publish.

Proceed with the implementation; ordinary reversible changes within this scope are authorized by this prompt. Where the current source differs from the audit, explain the difference and adjust the smallest relevant work package while retaining its intended behavior and safety constraints.
