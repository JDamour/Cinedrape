# Cinedrape — Privacy Policy

Last updated: 13 October 2026  
Applies to: **Cinedrape** (Chrome Web Store extension)  
Architecture Reference: `docs/ARCHITECTURE.md` (§7.9 items a–e)

---

## 1. Summary

Cinedrape is designed with a strict **local-first, privacy-by-default architecture**:
- **Zero tracking or analytics:** Cinedrape contains no telemetry, tracking beacons, analytics scripts, or third-party trackers.
- **Zero data collection or monetization:** We never collect, log, sell, or share your browsing history, search terms, video watching habits, account credentials, or personal information.
- **On-device execution:** All themes, calm filters, layouts, and cryptographic licence verifications run entirely locally in your browser.

---

## 2. Information Handled Locally

### 2.1 Extension Storage (`chrome.storage.local`)
Cinedrape stores configuration settings locally in Chrome's sandboxed extension storage under `cd.*` keys:
- `cd.settings`: Your chosen theme ID, layout density, text scale, accent color, and Calm mode toggle preferences.
- `cd.licence`: If you activate Cinedrape Pro, your pasted cryptographic licence token is stored here. The token contains standard entitlement claims, including an expiration timestamp (`exp`) and a subscriber identifier (`sub`, typically your purchase email address).
- `cd.selectorMap`: Cached signed selector map (cryptographically signed via ECDSA P-256) for layout and selector compatibility.
- `cd.customThemes`: Your saved custom theme configurations (colors, typography, shapes, layouts, calm defaults, and validated scoped CSS). Stored purely locally on your device.
- `cd.profiles`: Your saved named setting snapshots (configurations of themes, layouts, and calm toggles).
- `cd.schedule`: Local time-based scheduling preferences (day and night profile selections with device-local boundary times).
- `cd.editorDraft`: Transient local draft in progress within the visual theme editor.
- `cd.backup`: Safety snapshot created before schema migrations of profile and theme collections.
- `cd.health`: Transient selector health status tracking whether YouTube DOM elements match expected roles.

This storage is private to the extension and cannot be read by any website (including YouTube).

### 2.2 Page-Level State on `youtube.com`
To eliminate styling flicker and ensure instant first paint when navigating YouTube, Cinedrape writes presentation state directly to the active YouTube DOM and the `youtube.com` origin:
- **HTML root attributes:** Attributes added to the `<html>` root element (`cd-theme`, `cd-page`, `cd-home`, `cd-watch`, `cd-density`, `cd-motion`, `cd-textscale`, `cd-calm-*`, and temporary `cd-off-*` health flags).
- **Style element:** One `<style id="cinedrape-theme">` tag injected into the document root.
- **First-paint cache (`localStorage`):** A single key `cd:v1:firstPaint` stored in `youtube.com`'s local storage (strictly capped at 64 KB). It caches the generated theme CSS, visual attributes, and selector health verdict so the next page paint occurs instantly without flashing default styles.
- **Notice suppression (`sessionStorage`):** A transient key `cd:v1:noticeShown` in the active browser tab's session storage preventing duplicate breakage notices.

> **Privacy Disclosure (Item 7.9.a):** Because these entries live in the `youtube.com` page DOM and origin storage, scripts running on `youtube.com` (such as YouTube's own player and application scripts) have the technical capability to inspect DOM attributes and `localStorage['cd:v1:firstPaint']`. While Cinedrape transmits no data externally, the presence of these attributes could theoretically be observed by YouTube scripts to infer that Cinedrape is installed and active.

---

## 3. Data Retention and Uninstallation

- **When you uninstall Cinedrape:**
  - All extension storage in `chrome.storage.local` (including `cd.settings`, `cd.licence`, `cd.selectorMap`, `cd.customThemes`, `cd.profiles`, `cd.schedule`, `cd.editorDraft`, `cd.backup`, and `cd.health`) is **immediately and permanently removed by Chrome**.
- **Origin-level remnants (Item 7.9.b):**
  - Because browser extensions do not control persistent website cookies or storage upon removal, `localStorage['cd:v1:firstPaint']` (maximum 64 KB) and `sessionStorage['cd:v1:noticeShown']` remain in your browser's site cache for `youtube.com` until cleared by your browser's standard site data cleanup or via `Clear browsing data`.

---

## 4. Licence Tokens & Identity (Item 7.9.c)

- Pro licence tokens are cryptographically signed offline tokens.
- When you paste an activation token into the popup, Cinedrape validates its ECDSA P-256 cryptographic signature locally against bundled public keys.
- The licence token includes the subscriber claim (`sub`, representing your purchase email address or identifier).
- Active YouTube tabs read this licence record locally to unlock Pro features (e.g. Pro themes, density control, advanced calm toggles).

---

## 5. Network Activity & Future Services (Item 7.9.d)

### Current Release
- **No external network requests:** The extension content script and popup make zero outbound network requests (`fetch` and `XMLHttpRequest` are completely absent from `content.js`).
- The background service worker contains no configured `API_BASE` endpoint and conducts no telemetry, phone-home, or update requests. All selector map updates and licensing tokens in this release operate entirely locally and through extension package updates.

### Future Licence Sync & Selector Map Updates
- If a licensing server endpoint (`API_BASE`) is configured in future versions:
  - Cinedrape may perform a periodic HTTPS POST request containing your licence token to re-check licence validity and download updated signed selector maps.
  - This request will transmit the token (including the `sub` subscriber claim) to verify your licence state against our payment records.
  - Notice will be provided in release notes prior to enabling any remote licensing server.

---

## 6. Permissions Justification

Cinedrape requests only the minimal permissions required for its functionality:
- `storage`: Required to store your theme preferences, profiles, local schedules, custom themes, and Pro licence locally.
- `alarms`: Required for local time-based profile scheduling and periodic selector map verification.
- Host permissions (`https://www.youtube.com/*`): Required to inject presentation styles, calm filters, and theme layouts onto YouTube.

---

## 7. Contact & Open Source

Cinedrape is dedicated to transparency.  
For questions, bug reports, or privacy concerns, contact the project maintainers via the website or GitHub repository:  
- Website: https://jdamour.github.io/Cinedrape/  
- Issue Tracker: https://github.com/JDamour/Cinedrape/issues
