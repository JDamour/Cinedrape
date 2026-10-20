# Cinedrape: free app with optional support

Prepared: 14 October 2026
Status: implementation plan; app behavior has not been changed by this document.

## Objective and promise

Launch Cinedrape with all existing features available free, and invite satisfied users to fund development voluntarily. Validate support revenue during the first 30 days after public launch.

Public promise: "All current Cinedrape features are free. Support is optional and helps fund maintenance, fixes, and new themes."

Do not claim the product is open source unless its licensing and publication support that claim. Do not promise permanent availability, unlimited support, or future services.

The first revenue milestone is 10 supporters. This is a target, not a forecast. A free support model removes purchase friction but does not establish willingness to contribute.

## Phase 1: make existing features free

Estimated effort: 2–3 working days, subject to the licence dependency audit.

1. Audit entitlement checks across shared configuration, popup, editor, background messages, profile persistence, scheduling, and theme import/export. The checks are distributed; removing visual locks alone is insufficient.
2. Change feature availability centrally so all six bundled themes, density, all calm controls, visual editing and saving, profiles, scheduling, and import/export work without a licence. Keep theme validation, contrast validation, unknown-feature rejection, and health-based disabling intact.
3. Remove Pro badges, upgrade prompts, activation fields, expired-licence warnings, and development unlock controls from the user interface.
4. Retire licence-dependent access checks and refresh work. Preserve signed selector-map verification: free access does not remove the need to verify compatibility data.
5. Preserve installed users' settings, custom themes, profiles, and schedules. Existing licence records must neither block access nor reset choices; handle them as legacy data.
6. Update README, architecture documentation, status, onboarding, and release notes to match free availability.

Primary areas: `src/shared/entitlements.js`, shared constants and theme data, popup app/model/HTML, editor modules, background handlers and managers, content configuration, and relevant tests. Audit references before deciding which licence modules can be removed.

Acceptance: a clean installation with no licence can use every existing feature. Upgrading with an expired or malformed legacy licence does not lose data or restrict features. No feature depends on supporter status.

## Phase 2: set up optional support

Estimated effort: 1 working day after a receiving account and public support URL are available.

Proposed amounts to test:

- One-time: $5, $10, $20, or a custom amount.
- Recurring: optional $3/month, managed and cancelled through the payment platform.

Choose a hosted support platform after checking account eligibility, ability to receive and withdraw funds, fees, and supported currencies. Ko-fi is a candidate, not a committed provider. Its current Free mode charges 0% platform fees on one-time tips and 5% on monthly tips, with processor fees additional. New accounts default to a mode charging 5% on one-time tips too; check the selected setting.

The account owner supplies the verified public support URL. Test a real small payment and withdrawal before release. Keep all payment entry and recurring billing on the provider's page. Cinedrape does not collect card details or need a payment backend, webhook, or licence server for this model.

Sources checked during planning:

- https://help.ko-fi.com/hc/en-us/articles/360002506494-Does-Ko-fi-take-a-fee
- https://help.ko-fi.com/hc/en-us/articles/115003980153-I-don-t-have-a-PayPal-account

Acceptance: the support link opens a verified HTTPS destination, a payment reaches the receiving account, and the app stays fully usable when the user never visits the link.

## Phase 3: add a respectful support invitation

Estimated effort: 1–2 working days; can overlap with payment account setup.

- Add a permanent, unobtrusive "Support Cinedrape" link in the popup footer and editor.
- Add the same link to the welcome page, project site if available, and release notes.
- Show one dismissible invitation after the user has opened the popup or editor on three distinct local dates. This is a simple engagement proxy, not a measure of YouTube viewing time.
- Store distinct dates and dismissal locally. Never transmit viewing history or engagement records. Do not show the invitation in the YouTube player.
- Dismissal suppresses further automatic invitations. The permanent support link remains available.
- Do not infer payment success from clicking the link. Payment records stay with the provider; public supporter recognition requires opt-in consent.

Suggested copy:

"Enjoying Cinedrape? Help keep it free. Your support helps me maintain compatibility with YouTube, fix bugs, and create new themes. Every feature is available whether you contribute or not."

Acceptance: the invitation is keyboard accessible, readable in both color schemes, dismissible, shown only once at the threshold, and independent of feature access.

## Phase 4: verify and prepare release

Estimated effort: 1–2 working days plus external review time.

Update existing tests for universal feature access rather than deleting coverage for configuration validation and safe fallback behavior. Verify clean installs and migration from free, active, expired, and malformed legacy licence states. Test theme save/load, profiles, scheduling, and import/export end to end without activation.

Run the unit suite, strict build, and relevant popup/editor and YouTube browser checks. Check the support link and dismissal behavior. Complete the repository's documented release requirements, including production selector-map signing, privacy documentation, and live ad/disclosure verification. Record unresolved requirements as release blockers.

Prepare Chrome Web Store screenshots using the new icon and actual app views. Explain that support is optional and all existing features are free. Publish the package when ready and authorized; store review time is outside the development estimate.

Acceptance: required checks pass, real-site behavior is verified, the support payment path works, and the store description matches the app.

## Phase 5: first 30 days after launch

Before launch: create three 15–30 second before/after demos using the same videos and pages. Demonstrate Cinema, Study, and Everyday configurations using existing features. Prepare a concise support page explaining who maintains the project and what funding supports.

Days 1–7: share demos through available personal channels and relevant communities where promotion is allowed. Aim to reach the first 10 supporters. Ask testers what they value and what makes them hesitate to recommend the app.

Days 8–14: fix the most frequent issues. Contact a small set of relevant desktop-customization or study creators with a useful demo and a free copy. These are future launch tasks; no outreach is authorized or sent by this plan. Avoid donation-funded affiliate commitments until revenue supports them.

Days 15–30: publish improvements and a truthful funding update. Make one targeted change to the support message or placement if needed, and compare successive periods cautiously; small samples do not establish an A/B-test result.

Review weekly:

- Store installs and any available store aggregate activity data; report what each metric actually measures.
- Completed one-time tips, average tip, recurring supporters, cancellations, refunds, fees, and net receipts from provider reports.
- Optional support-page aggregate visits only if the page already provides them and disclosures cover them; do not add extension telemetry for launch.
- Support requests and maintenance hours, tracked manually.

Do not calculate a donation conversion rate without a matching denominator. Store installs and support-page visits are different populations. A support-link click is not a completed contribution.

Illustrative arithmetic, not expected results: 20 tips of $5 = $100 once; 100 tips of $10 = $1,000 once; 100 recurring supporters at $3 = $300/month gross, before fees and other costs.

At day 30, compare net support revenue with actual maintenance effort and a personal funding target chosen before launch. Continue if user adoption and funding justify the work. If users value the app but support is insufficient, keep released features free and test separately priced custom theme design or other clearly separate services. If adoption itself is weak, improve positioning and distribution before expanding monetization.

## Execution order and outstanding inputs

Start with entitlement audit and free-feature migration. In parallel as independent work, the account owner sets up a receiving account and provides a verified support URL. Then add support links and the local invitation, complete checks, package the release, and launch demos.

Required external inputs: payment-account country and receiving eligibility, chosen provider and public URL, store-publisher access/status, and the monthly funding target. These do not block the entitlement audit or preparation of support UI.

Total development estimate: 5–8 working days, with overlapping phases where practical. Payment onboarding, unresolved release requirements, and store review can extend the public launch date.

Deferred: paid feature gates, theme marketplace, AI generation, app accounts, payment backend, extension telemetry, and paid acquisition.
