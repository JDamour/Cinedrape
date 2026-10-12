# Cinedrape

Themes for YouTube™. A Manifest V3 browser extension that restyles and re-lays-out desktop YouTube: pick a complete look in one click, tweak it, no code. Not affiliated with Google.

This repository is the **MVP (features F1–F6)** from `YouTube Skin Studio — Product Spec.md`: theme engine, six launch themes, layout modes, quick-settings popup, calm mode, and breakage detection. There is no backend, sign-in, payments, sync, AI generator or marketplace yet.

## Try it

```bash
npm install
npm run build          # production build into dist/
```

1. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked**, and select the `dist/` folder.
2. Open youtube.com and click the Cinedrape toolbar icon.

Free themes (Cinema, Minimal, Classic) work immediately. To try Pro (the other three themes, density, all calm toggles) with the dev keys:

```bash
npm run keys                                   # once; writes .keys/ (never commit it)
npm run licence:dev -- --plan pro --days 30    # prints a signed token
```

Paste the token into **Activate Pro** in the popup. For a dev-only unlock strip in the popup use `npm run build:dev`.

## Checks

```bash
npm test               # ~1700 unit tests (jsdom, real YouTube DOM fixtures)
npm run build:strict   # budgets: content script < 150 KB gzipped, no eval/new Function, manifest files present
npm run e2e            # real Chrome + live youtube.com: readability audit of every theme in light and dark YouTube
npm run e2e:home       # home hero/rows layout on a real feed, watch layouts, all five calm toggles
npm run e2e:popup      # popup, live updates, breakage path, trust, privacy, licence ageing, first paint
```

The e2e scripts drive a throwaway headless Chrome (fresh temporary profile, your own is never touched) against logged-out youtube.com and write screenshots and reports under `test/e2e/out/`. They build into `dist-home` / `dist-popup` so they never disturb `dist/`.

## How it works

- **Themes are data.** A theme is JSON (colour tokens, layout choices, optional validated CSS), never code. The CSS validator refuses anything that could hide or cover ads, sponsorship disclosures or player controls.
- **YouTube's markup lives in a signed selector map** (`src/data/selector-map.source.json`, signed into `selector-map.signed.json`). Element names, the colour-variable bridge and the health-check requirements are data, so a YouTube change is a map update, not a store release. A health check turns off only the broken feature and shows a notice.
- **Fail-open.** Any error leaves YouTube in its default look. The layout renderers mirror tiles into their own cards and restore the original DOM exactly on unmount.
- **Private.** No network access from the extension, no accounts for free use, no telemetry. Permissions are exactly `storage`, `alarms` and `https://www.youtube.com/*`.

Details: `docs/ARCHITECTURE.md` (the build contract: module APIs, shared names, verified YouTube DOM facts), `docs/STATUS.md` (per-module status, decisions and known gaps).

## Before a store release

`npm run package` refuses to build a release zip until these are done:

1. **Replace the dev signing keys:** `npm run keys -- --force`, keep `.keys/` safe and backed up, then `npm run sign-map`. Anyone holding the dev keys can mint Pro licences.
2. Build the licence server and set `API_BASE` in `src/background/service-worker.js` (the weekly licence re-check and the 6-hourly map refresh are wired but inert without it).
3. Run a trademark search (USPTO, EUIPO, WIPO), write the privacy policy, and match the store disclosures to it.
4. Re-verify the ad and sponsorship selectors against a real **logged-in** session; the automated runs never see an ad (logged-out YouTube served none), so ad safety there rests on structural guards and synthetic fixtures.
