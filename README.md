# Cinedrape

Themes for YouTube™. A Manifest V3 browser extension that restyles and re-lays-out desktop YouTube: pick a complete look in one click, tweak it, no code. Not affiliated with Google.

This repository includes **features F1–F9** from `YouTube Skin Studio — Product Spec.md`: theme engine (F1), six bundled themes (F2), layout modes (F3), quick-settings popup (F4), calm mode (F5), breakage detection (F6), visual theme studio/editor (F7), saved profiles and local time scheduling (F8), and theme JSON import/export (F9). There is no external account requirement, payments sync, AI generator, or telemetry.

## Website & Live Demo

The project landing page is ready for GitHub Pages hosting:
- Live Demo & Features: [https://jdamour.github.io/Cinedrape/](https://jdamour.github.io/Cinedrape/)
- Local preview: Open `index.html` in any modern web browser.
- Automated deployment: Handled via `.github/workflows/deploy-pages.yml` (or via GitHub Pages branch deploy from root `/`).


## Try it

```bash
npm install
npm run build          # production build into dist/
```

1. Open `chrome://extensions`, switch on **Developer mode**, choose **Load unpacked**, and select the `dist/` folder.
2. Open youtube.com and click the Cinedrape toolbar icon.

For **Microsoft Edge**, run `npm run build:edge`, open `edge://extensions`, enable **Developer mode**, and choose **Load unpacked** → `E:\Cinedrape\dist-edge`. After updating, click **Reload** on the extension card. The popup reconnects existing YouTube tabs automatically; if access is blocked, allow Cinedrape on YouTube in Edge’s extension settings and use **Reload YouTube tab** in the popup.

Free themes (Cinema, Minimal, Classic) work immediately. To try Pro (the other three themes, density, all calm toggles, custom theme saving, profiles, and scheduling) with the dev keys:

```bash
npm run keys                                   # once; writes .keys/ (never commit it)
npm run licence:dev -- --plan pro --days 30    # prints a signed token
```

Paste the token into **Activate Pro** in the popup. For a dev-only unlock strip in the popup use `npm run build:dev`.

## Checks

```bash
npm test               # ~2000 unit tests (jsdom, real YouTube DOM fixtures)
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
- **Private.** No network access from the extension content script or popup, no accounts for free use, no telemetry. Permissions are exactly `storage`, `alarms`, `scripting` and access to `https://www.youtube.com/*` / `https://youtube.com/*`. The scripting permission reconnects an already open YouTube tab when its content script is missing.

Details: `docs/ARCHITECTURE.md` (the build contract: module APIs, shared names, verified YouTube DOM facts), `docs/STATUS.md` (per-module status, decisions and known gaps).

## Before a store release

`npm run package` performs mechanical checks (strict build, manifest permissions, forbidden constructs, and signing key status sentinel). Release readiness requires:

1. **Replace the dev signing keys:** `npm run keys -- --production` (keep private keys in a secure offline store or KMS, not in `.keys/`), re-sign the selector map with `npm run sign-map`, and verify `KEY_STATUS === 'production'`.
2. **Deliberate Local-Beta Mode:** In local-beta mode, `API_BASE=''` is retained; map updates arrive through extension package updates and licence tokens are cryptographically verified locally. Any future connected backend services require a separate specification covering endpoint security, manifests, licensing/device policies, and backend verification.
3. **Trademark & Store Disclosures:** Complete trademark clearance (USPTO, EUIPO, WIPO), ensure `docs/PRIVACY.md` matches store disclosures, and verify storage keys.
4. **Live-Ad Verification:** Verify ad and sponsorship protection against real logged-in sessions with active ad impressions before public release.
