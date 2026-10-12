// Cinedrape popup: render + wiring (ARCHITECTURE.md section 4, popup).
//
//   const popup = createPopup({ doc: document, chrome, themes: THEMES });
//   await popup.ready;
//
// Everything that touches the outside world is injected (`doc`, `chrome`, `themes`, `now`), so test/popup drives it with
// jsdom and test/helpers/chrome-mock.js. The popup reads and writes only chrome.storage.local[cd.settings]; the open tab
// notices through storage.onChanged. Licence and health come over messages (MSG.GET_LICENCE, MSG.ACTIVATE_LICENCE,
// MSG.GET_STATUS). Controls are updated in place (never rebuilt), so focus and a half-typed hex value survive every update.
import { CALM_KEYS, MSG, STORAGE_KEYS } from '../shared/constants.js';
import { LICENCE_PUBLIC_KEY } from '../shared/public-keys.js';
import {
  ACCENT_SWATCHES, DENSITY_LABELS, LICENCE_COPY,
  accentWarning, activationErrorCopy, checkEntitlement, deriveView, isDensity, licenceFromRecordVerified, lockedCopy, mergeSettings,
  normalizeToken, parseActivateResponse, parseHex, parseLicence, safeCssColor, sanitizePatch, statusCopy,
  summarizeStatus, usableThemes, withDefaults,
} from './model.js';
import { MESSAGE_ICONS, h, icon, setMessage } from './ui.js';
import { mountDevStrip } from './dev-strip.js';

const YOUTUBE_URL = /^https:\/\/www\.youtube\.com(?:[/?#]|$)/;
const FREE_STATE = Object.freeze({ plan: 'free', status: 'none' });
const STATUS_ICONS = { ok: 'ok', paused: 'warn', checking: 'info', idle: 'info', unreachable: 'warn' };
const SETTINGS_KEY = STORAGE_KEYS.settings;
// An MV3 service worker sleeps and restarts: the first message after a pause can fail ("Receiving end does not exist") or hang.
const WORKER_TRY_MS = 3000;       // one attempt at the background
const WORKER_RETRY_PAUSE_MS = 250;

/**
 * @param {object} deps
 * @param {Document} deps.doc            the loaded popup.html
 * @param {object} deps.chrome           chrome (storage.local, runtime, tabs)
 * @param {object[]} [deps.themes]       THEMES (normalised theme objects)
 * @param {() => number} [deps.now]      clock, stamps the last status check
 * @param {number} [deps.requestTimeoutMs]  how long to wait for the background / the tab before giving up
 * @param {object} [deps.licenceKey]     public key the stored licence is verified against when the background cannot answer (default LICENCE_PUBLIC_KEY)
 */
export function createPopup({ doc, chrome, themes = [], now = Date.now, requestTimeoutMs = 15000, licenceKey = LICENCE_PUBLIC_KEY } = {}) {
  if (!doc || !chrome) throw new TypeError('createPopup({ doc, chrome }) needs both');
  const win = doc.defaultView;
  const themeList = usableThemes(themes);

  const byId = (id) => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`popup.html is missing #${id}`);
    return el;
  };
  const els = {
    noticeWrap: byId('notice-wrap'), notice: byId('notice'), noticeAction: byId('notice-action'), noticeDismiss: byId('notice-dismiss'),
    status: byId('status'), statusIcon: byId('status-icon'), statusText: byId('status-text'), statusDetail: byId('status-detail'),
    themeGroup: byId('theme-group'), themeGrid: byId('theme-grid'), themeNote: byId('theme-note'),
    swatches: byId('accent-swatches'), hex: byId('accent-hex'), hexPreview: byId('accent-preview'), accentReset: byId('accent-reset'),
    accentHelp: byId('accent-help'), accentError: byId('accent-error'), accentWarning: byId('accent-warning'),
    density: byId('density'), densityValue: byId('density-value'), densityPro: byId('density-pro'), densityNote: byId('density-note'),
    densityUnlock: byId('density-unlock'), densityReset: byId('density-reset'),
    animations: byId('animations'),
    calmList: byId('calm-list'),
    proState: byId('pro-state'), proStateIcon: byId('pro-state-icon'), proStateText: byId('pro-state-text'), proDetail: byId('pro-detail'),
    proSaved: byId('pro-saved'), activate: byId('activate'), activateSummary: byId('activate-summary'),
    activateForm: byId('activate-form'), token: byId('token'), activateBtn: byId('activate-btn'), activateResult: byId('activate-result'),
    version: byId('version'), siteLink: byId('site-link'), devSlot: byId('dev-slot'),
  };

  const state = {
    settings: null,                       // the stored cd.settings object as read (null = nothing stored yet)
    licence: FREE_STATE,
    licenceKnown: false,
    status: { kind: 'checking', summary: null },
    statusAt: 0,
    activating: false,
  };
  let view = null;
  let pending = 0;                        // settings writes in flight or queued
  let queue = Promise.resolve();          // serialises read-modify-write of cd.settings
  let statusSeq = 0;
  let destroyed = false;
  let activateOpened = false;
  const tasks = new Set();
  const cleanups = [];

  const track = (promise) => {
    tasks.add(promise);
    const done = () => tasks.delete(promise);
    promise.then(done, done);
    return promise;
  };
  const listen = (target, type, fn, options) => {
    target.addEventListener(type, fn, options);
    cleanups.push(() => target.removeEventListener(type, fn, options));
  };

  /** Runs a chrome.* call; resolves {ok, value} / {ok:false, error, timeout?} and never rejects or hangs. */
  function attempt(fn, limitMs = requestTimeoutMs) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = win.setTimeout(() => resolve({ ok: false, timeout: true }), limitMs);
    });
    const run = Promise.resolve().then(fn).then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));
    return Promise.race([run, timeout]).finally(() => win.clearTimeout(timer));
  }

  const compute = () => deriveView({ settings: state.settings, licence: state.licence, licenceKnown: state.licenceKnown, themes: themeList });

  // ---- messages --------------------------------------------------------------------------------------------------------

  function notify(text, { kind = 'info', action = false } = {}) {
    els.noticeWrap.dataset.open = 'true';
    els.noticeWrap.dataset.kind = kind;
    setMessage(doc, els.notice, text, MESSAGE_ICONS[kind]);
    els.noticeAction.hidden = !action;
    els.noticeDismiss.hidden = false;
  }
  function clearNotice() {
    els.noticeWrap.dataset.open = 'false';
    els.notice.replaceChildren();
    els.noticeAction.hidden = true;
    els.noticeDismiss.hidden = true;
  }
  function goToActivate() {
    els.activate.open = true;
    els.token.focus();
    if (typeof els.token.scrollIntoView === 'function') els.token.scrollIntoView({ block: 'center' });
  }

  // ---- static controls built from data ----------------------------------------------------------------------------------

  function makeSwitchState(button, { on, locked }) {
    button.setAttribute('aria-checked', String(on));
    if (locked) button.setAttribute('aria-disabled', 'true'); else button.removeAttribute('aria-disabled');
    button.classList.toggle('is-locked', locked);
    button.querySelector('.switch-state').textContent = on ? 'On' : 'Off';
  }

  function buildThemeCards() {
    const cards = view.themes.map((tv) => {
      const preview = h(doc, 'span', { class: 'theme-preview', 'aria-hidden': 'true' },
        h(doc, 'span', { class: 'tp-card' }, h(doc, 'span', { class: 'tp-line' }), h(doc, 'span', { class: 'tp-line tp-muted' })),
        h(doc, 'span', { class: 'tp-accent' }));
      const vars = {
        '--tp-bg': tv.colors.bg, '--tp-surface': tv.colors.surface, '--tp-text': tv.colors.text,
        '--tp-muted': tv.colors.muted, '--tp-accent': tv.colors.accent, '--tp-border': tv.colors.border,
      };
      for (const [name, value] of Object.entries(vars)) {
        const safe = safeCssColor(value);
        if (safe) preview.style.setProperty(name, safe);
      }
      const tag = tv.pro
        ? h(doc, 'span', { class: 'tag-pro' },
          h(doc, 'span', { class: 'tag-lock', hidden: true }, icon(doc, 'lock')),
          'Pro',
          h(doc, 'span', { class: 'sr-only', hidden: true }, ', locked'))
        : null;
      return h(doc, 'button', {
        type: 'button', role: 'radio', class: 'theme-card', 'data-theme-id': tv.id, 'aria-checked': 'false', tabindex: '-1',
      },
      preview,
      h(doc, 'span', { class: 'theme-meta' }, h(doc, 'span', { class: 'theme-name' }, tv.name), tag),
      h(doc, 'span', { class: 'theme-check', 'aria-hidden': 'true' }, icon(doc, 'check')));
    });
    els.themeGrid.replaceChildren(...cards);
  }

  function buildSwatches() {
    const swatches = ACCENT_SWATCHES.map(({ name, hex }) => {
      const button = h(doc, 'button', {
        type: 'button', role: 'radio', class: 'swatch', 'data-hex': hex, 'aria-checked': 'false', tabindex: '-1',
        'aria-label': `${name}, ${hex}`,
      }, h(doc, 'span', { class: 'swatch-chip', 'aria-hidden': 'true' }, icon(doc, 'check')));
      button.style.setProperty('--sw', hex);
      return button;
    });
    els.swatches.replaceChildren(...swatches);
  }

  function buildCalm() {
    const rows = view.calm.map((c) => {
      const labelId = `calm-${c.key}-label`;
      const hintId = `calm-${c.key}-hint`;
      const proId = `calm-${c.key}-pro`;
      const toggle = h(doc, 'button', {
        type: 'button', id: `calm-${c.key}`, class: 'switch', role: 'switch', 'data-calm': c.key, 'aria-checked': 'false',
        'aria-labelledby': labelId, 'aria-describedby': hintId,
      },
      h(doc, 'span', { class: 'switch-track', 'aria-hidden': 'true' }, h(doc, 'span', { class: 'switch-thumb' })),
      h(doc, 'span', { class: 'switch-state', 'aria-hidden': 'true' }, 'Off'));
      return h(doc, 'div', { class: 'row', 'data-calm-row': c.key },
        h(doc, 'div', { class: 'row-text' },
          h(doc, 'span', { id: labelId, class: 'row-title' }, c.label),
          h(doc, 'span', { id: hintId, class: 'hint' }, c.hint),
          h(doc, 'span', { id: proId, class: 'tag-pro', hidden: true }, icon(doc, 'lock'), 'Pro',
            h(doc, 'span', { class: 'sr-only' }, ' setting, locked'))),
        toggle);
    });
    els.calmList.replaceChildren(...rows);
  }

  // ---- sync: state -> DOM (in place) -------------------------------------------------------------------------------------

  const radios = (container) => [...container.querySelectorAll('[role="radio"]')];

  function setRovingTabStop(container) {
    const items = radios(container);
    const stop = items.find((i) => i.getAttribute('aria-checked') === 'true')
      || items.find((i) => i.getAttribute('aria-disabled') !== 'true') || items[0];
    for (const item of items) item.tabIndex = item === stop ? 0 : -1;
  }

  function syncThemes() {
    for (const card of radios(els.themeGrid)) {
      const tv = view.themes.find((t) => t.id === card.dataset.themeId);
      if (!tv) continue;
      card.setAttribute('aria-checked', String(tv.checked));
      if (tv.locked) {
        card.setAttribute('aria-disabled', 'true');
        card.setAttribute('aria-describedby', 'theme-locked-desc');
      } else {
        card.removeAttribute('aria-disabled');
        card.removeAttribute('aria-describedby');
      }
      card.classList.toggle('is-locked', tv.locked);
      const lock = card.querySelector('.tag-lock');
      const sr = card.querySelector('.tag-pro .sr-only');
      if (lock) lock.hidden = !tv.locked;
      if (sr) sr.hidden = !tv.locked;
    }
    setRovingTabStop(els.themeGrid);
    const stored = view.suppressed.find((s) => s.endsWith(' theme'));
    els.themeNote.textContent = stored ? `${stored.charAt(0).toUpperCase()}${stored.slice(1)} is saved and returns when Pro is active.` : '';
    if (!view.themes.length) els.themeNote.textContent = 'No themes are available.';
  }

  function syncAccent() {
    for (const sw of radios(els.swatches)) sw.setAttribute('aria-checked', String(sw.dataset.hex === view.accent));
    setRovingTabStop(els.swatches);
    if (doc.activeElement !== els.hex) {
      els.hex.value = view.accent || '';
      els.hex.removeAttribute('aria-invalid');
      els.accentError.textContent = '';
    }
    els.hexPreview.style.setProperty('--hex', safeCssColor(view.accent) || safeCssColor(view.themeAccent) || 'transparent');
    if (view.accent) els.accentReset.removeAttribute('aria-disabled'); else els.accentReset.setAttribute('aria-disabled', 'true');
    const themeName = view.theme ? view.theme.name : 'theme';
    els.accentHelp.textContent = view.accent
      ? `Using your accent ${view.accent}.`
      : `Using the ${themeName} theme’s own accent${view.themeAccent ? ` (${view.themeAccent})` : ''}.`;
    els.accentWarning.textContent = accentWarning(view) || '';
  }

  function syncDensity() {
    const d = view.density;
    els.density.disabled = d.locked;
    els.density.value = String(d.value);
    els.density.setAttribute('aria-valuetext', `${d.value} of 5, ${d.label}`);
    els.densityValue.textContent = d.label;
    els.densityPro.hidden = !d.locked;
    els.densityUnlock.hidden = !d.locked;
    els.densityReset.hidden = !d.custom;
    const themeName = view.theme ? view.theme.name : 'the theme';
    if (d.locked) {
      els.densityNote.textContent = d.suppressed
        ? 'Pro feature. Your saved density returns when Pro is active.'
        : `Pro feature. Free users get ${themeName}’s own spacing.`;
    } else {
      els.densityNote.textContent = d.custom ? 'Your own setting.' : `Using ${themeName}’s own spacing.`;
    }
  }

  function syncAnimations() {
    makeSwitchState(els.animations, { on: view.animations, locked: false });
  }

  function syncCalm() {
    for (const c of view.calm) {
      const toggle = byId(`calm-${c.key}`);
      makeSwitchState(toggle, { on: c.on, locked: c.locked });
      const tag = byId(`calm-${c.key}-pro`);
      tag.hidden = !c.locked;
      toggle.setAttribute('aria-describedby', c.locked ? `calm-${c.key}-hint calm-${c.key}-pro` : `calm-${c.key}-hint`);
    }
  }

  function syncLicence() {
    const copy = LICENCE_COPY[view.licenceKey];
    els.proState.dataset.state = view.licenceKey;
    els.proStateText.textContent = copy.label;
    els.proStateIcon.querySelector('use').setAttribute('href',
      view.licenceKey === 'active' ? '#i-ok' : (view.licenceKey === 'free' ? '#i-info' : '#i-warn'));
    els.proDetail.textContent = copy.detail;
    els.proSaved.textContent = !view.pro && view.suppressed.length
      ? `Saved and waiting for Pro: ${view.suppressed.join(', ')}.` : '';
    els.activateSummary.textContent = view.pro ? 'Use a different licence token' : 'Activate Pro';
    if (!activateOpened) { els.activate.open = !view.pro; activateOpened = true; }
  }

  function syncStatus() {
    const { kind, summary } = state.status;
    const copy = statusCopy(kind, { summary, themes: themeList });
    els.status.dataset.state = kind;
    els.statusText.textContent = copy.text;
    els.statusDetail.textContent = copy.detail;
    els.statusIcon.querySelector('use').setAttribute('href', `#i-${STATUS_ICONS[kind] || 'info'}`);
  }

  function render() {
    if (destroyed) return;
    view = compute();
    syncThemes();
    syncAccent();
    syncDensity();
    syncAnimations();
    syncCalm();
    syncLicence();
    syncStatus();
  }

  // ---- settings: read, write ---------------------------------------------------------------------------------------------

  async function loadSettings() {
    const got = await attempt(() => chrome.storage.local.get(SETTINGS_KEY));
    if (!got.ok) {
      notify('Cinedrape could not read your saved settings. Showing the defaults.', { kind: 'error' });
      return;
    }
    state.settings = got.value ? got.value[SETTINGS_KEY] ?? null : null;
  }

  async function persist(patch) {
    const got = await chrome.storage.local.get(SETTINGS_KEY);
    const merged = mergeSettings(got ? got[SETTINGS_KEY] : undefined, patch);
    await chrome.storage.local.set({ [SETTINGS_KEY]: merged });
  }

  /** True when `patch` would not change anything that is stored. */
  function isNoop(patch) {
    const cur = withDefaults(state.settings);
    return Object.keys(patch).every((key) => {
      if (key === 'calm') return Object.keys(patch.calm).every((k) => cur.calm[k] === patch.calm[k]);
      return cur[key] === patch[key];
    });
  }

  /**
   * Validates, checks the tier, shows the change at once and writes it. Resolves true when the change was stored.
   * Locked or invalid changes never reach storage (the UI is put back as it was and the reason is shown).
   */
  async function commit(rawPatch) {
    const clean = sanitizePatch(rawPatch);
    if (!clean.ok) {
      notify(clean.error, { kind: 'error' });
      render();
      return false;
    }
    const entitlement = checkEntitlement(clean.patch, { licence: state.licence, themes: themeList });
    if (!entitlement.ok) {
      if (entitlement.kind === 'unknown-theme') notify('That theme is not available.', { kind: 'error' });
      else notify(lockedCopy(entitlement, view.licenceKey), { kind: 'pro', action: true });
      render();
      return false;
    }
    if (isNoop(clean.patch)) return true;

    clearNotice();
    state.settings = mergeSettings(state.settings, clean.patch);
    render();
    pending += 1;
    const job = queue.then(() => persist(clean.patch));
    queue = job.catch(() => {});
    let ok = true;
    try {
      await track(job);
    } catch {
      ok = false;
      notify('Could not save that change. Try again.', { kind: 'error' });
    }
    pending -= 1;
    if (pending === 0) await track(reloadSettings());      // settle on what storage really holds
    return ok;
  }

  async function reloadSettings() {
    await loadSettings();
    render();
  }

  // ---- licence ---------------------------------------------------------------------------------------------------------

  const pause = (ms) => new Promise((resolve) => { win.setTimeout(resolve, ms); });

  /** One message to the background that survives a sleeping or restarting worker: an answer that is missing or unusable is asked for once more. */
  async function askBackground(message, parse) {
    const limit = Math.min(requestTimeoutMs, WORKER_TRY_MS);
    for (let i = 0; i < 2 && !destroyed; i++) {
      if (i > 0) await pause(Math.min(WORKER_RETRY_PAUSE_MS, Math.ceil(requestTimeoutMs / 4)));
      const r = await attempt(() => chrome.runtime.sendMessage(message), limit);
      const parsed = r.ok ? parse(r.value) : null;
      if (parsed) return parsed;
    }
    return null;
  }

  /**
   * The licence state: the background's answer (it reads the same record), asked twice; if it still cannot answer, computed here from
   * the stored record with the same pure function, so the popup never depends on the worker being awake. Only when storage itself
   * cannot be read is the state "unknown" (shown as such, Pro stays locked).
   */
  async function loadLicence() {
    let parsed = await askBackground({ type: MSG.GET_LICENCE }, parseLicence);
    if (!parsed && !destroyed) {
      const stored = await attempt(() => chrome.storage.local.get(STORAGE_KEYS.licence));
      if (stored.ok && stored.value !== null && typeof stored.value === 'object') parsed = await licenceFromRecordVerified(stored.value[STORAGE_KEYS.licence], now(), licenceKey);
    }
    if (destroyed) return;
    state.licence = parsed || FREE_STATE;
    state.licenceKnown = parsed !== null;
  }

  /**
   * Sends the token to the background (which verifies it) and reports. The token only ever travels in that message:
   * it is never written to the DOM as text, to storage, to a URL or to the console.
   * @param {string} rawToken
   * @param {{busy:(on:boolean)=>void, result:(text:string, kind:string)=>void, success:()=>void}} report
   */
  async function activate(rawToken, report) {
    if (state.activating) return { ok: false, reason: 'busy' };
    const norm = normalizeToken(rawToken);
    if (!norm.ok) {
      report.result(norm.message, 'error');
      return { ok: false, reason: norm.code };
    }
    state.activating = true;
    report.busy(true);
    report.result('Checking your token…', 'info');
    try {
      // A refusal to connect (worker restarting) is repeated once; a timeout is not (the worker may be busy verifying).
      let sent = await attempt(() => chrome.runtime.sendMessage({ type: MSG.ACTIVATE_LICENCE, token: norm.token }));
      if (!sent.ok && !sent.timeout && !destroyed) {
        await pause(Math.min(WORKER_RETRY_PAUSE_MS, Math.ceil(requestTimeoutMs / 4)));
        sent = await attempt(() => chrome.runtime.sendMessage({ type: MSG.ACTIVATE_LICENCE, token: norm.token }));
      }
      if (!sent.ok) {
        report.result(activationErrorCopy(sent.timeout ? 'timeout' : 'no-response'), 'error');
        return { ok: false, reason: sent.timeout ? 'timeout' : 'no-response' };
      }
      const reply = parseActivateResponse(sent.value);
      if (!reply.ok) {
        report.result(activationErrorCopy(reply.reason), 'error');
        return { ok: false, reason: reply.reason };
      }
      if (reply.state) { state.licence = reply.state; state.licenceKnown = true; } else await loadLicence();
      report.success();
      render();
      report.result(view.pro ? 'Pro is now active on this browser.' : 'Token accepted, but it does not include Pro.', view.pro ? 'ok' : 'info');
      return { ok: true };
    } finally {
      state.activating = false;
      report.busy(false);
    }
  }

  const activateReport = {
    busy(on) {
      if (on) { els.activateBtn.setAttribute('aria-disabled', 'true'); els.activateForm.setAttribute('aria-busy', 'true'); }
      else { els.activateBtn.removeAttribute('aria-disabled'); els.activateForm.removeAttribute('aria-busy'); }
    },
    result(text, kind) { els.activateResult.dataset.kind = kind; setMessage(doc, els.activateResult, text, MESSAGE_ICONS[kind]); },
    success() { els.token.value = ''; },
  };

  // ---- health ----------------------------------------------------------------------------------------------------------

  function setStatus(kind, summary = null) {
    state.status = { kind, summary };
    state.statusAt = now();
    syncStatus();
  }

  async function loadStatus() {
    const seq = ++statusSeq;
    const found = await attempt(() => chrome.tabs.query({ active: true, currentWindow: true }));
    if (seq !== statusSeq || destroyed) return;
    const tab = found.ok && Array.isArray(found.value) ? found.value[0] : undefined;
    if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== 'string' || !YOUTUBE_URL.test(tab.url)) {
      setStatus('idle');
      return;
    }
    const reply = await attempt(() => chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS }));
    if (seq !== statusSeq || destroyed) return;
    const summary = reply.ok ? summarizeStatus(reply.value) : null;
    if (!summary) setStatus('unreachable');
    else setStatus(summary.broken.length ? 'paused' : 'ok', summary);
  }

  // ---- keyboard: roving radio groups -------------------------------------------------------------------------------------

  /** Arrow keys / Home / End move focus around a radio group (wrapping); `select` is told which item got focus. */
  function onRadioKeydown(container, select) {
    return (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const current = event.target && event.target.closest ? event.target.closest('[role="radio"]') : null;
      if (!current || !container.contains(current)) return;
      const items = radios(container);
      const i = items.indexOf(current);
      let next;
      switch (event.key) {
        case 'ArrowRight': case 'ArrowDown': next = (i + 1) % items.length; break;
        case 'ArrowLeft': case 'ArrowUp': next = (i - 1 + items.length) % items.length; break;
        case 'Home': next = 0; break;
        case 'End': next = items.length - 1; break;
        default: return;
      }
      event.preventDefault();
      items[next].focus();
      select(items[next]);
    };
  }

  // ---- event wiring ------------------------------------------------------------------------------------------------------

  function wire() {
    const chooseTheme = (card) => commit({ themeId: card.dataset.themeId });
    listen(els.themeGrid, 'click', (event) => {
      const card = event.target.closest('[role="radio"]');
      if (card && els.themeGrid.contains(card)) chooseTheme(card);
    });
    // Arrow keys move focus and select, like a native radio group; a locked card only takes focus.
    listen(els.themeGrid, 'keydown', onRadioKeydown(els.themeGrid, (card) => {
      if (card.getAttribute('aria-disabled') !== 'true') chooseTheme(card);
    }));

    const chooseAccent = (swatch) => commit({ accent: swatch.dataset.hex });
    listen(els.swatches, 'click', (event) => {
      const swatch = event.target.closest('[role="radio"]');
      if (swatch && els.swatches.contains(swatch)) chooseAccent(swatch);
    });
    listen(els.swatches, 'keydown', onRadioKeydown(els.swatches, chooseAccent));

    // A complete 6-digit value applies as soon as it is typed or pasted; shorthand and everything else waits for Enter / blur.
    listen(els.hex, 'input', () => {
      els.hex.removeAttribute('aria-invalid');
      els.accentError.textContent = '';
      if (/^#?[0-9a-f]{6}$/i.test(els.hex.value.trim())) commit({ accent: parseHex(els.hex.value) });
    });
    const commitHex = () => {
      const raw = els.hex.value.trim();
      if (raw === '') { render(); return; }
      const hex = parseHex(raw);
      if (!hex) {
        els.hex.setAttribute('aria-invalid', 'true');
        els.accentError.textContent = 'Enter a colour like #e8b04a (3 or 6 hex digits).';
        return;
      }
      els.hex.value = hex;
      commit({ accent: hex });
    };
    listen(els.hex, 'change', commitHex);
    listen(els.hex, 'keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commitHex(); } });
    listen(els.accentReset, 'click', () => {
      if (els.accentReset.getAttribute('aria-disabled') === 'true') return;
      els.hex.removeAttribute('aria-invalid');
      els.accentError.textContent = '';
      commit({ accent: null });
    });

    listen(els.density, 'input', () => {
      const n = Number(els.density.value);
      if (isDensity(n)) {
        els.densityValue.textContent = DENSITY_LABELS[n - 1];
        els.density.setAttribute('aria-valuetext', `${n} of 5, ${DENSITY_LABELS[n - 1]}`);
      }
    });
    listen(els.density, 'change', () => commit({ density: Number(els.density.value) }));
    listen(els.densityReset, 'click', async () => {
      await commit({ density: null });
      els.density.focus();
    });
    listen(els.densityUnlock, 'click', goToActivate);

    listen(els.animations, 'click', () => {
      if (els.animations.getAttribute('aria-disabled') === 'true') return;
      commit({ animations: !view.animations });
    });

    listen(els.calmList, 'click', (event) => {
      const toggle = event.target.closest('[data-calm]');
      if (!toggle || !els.calmList.contains(toggle)) return;
      const key = toggle.dataset.calm;
      if (!CALM_KEYS.includes(key)) return;
      const current = view.calm.find((c) => c.key === key);
      commit({ calm: { [key]: !(current && current.on) } });
    });

    listen(els.noticeAction, 'click', goToActivate);
    listen(els.noticeDismiss, 'click', clearNotice);

    listen(els.activateForm, 'submit', (event) => {
      event.preventDefault();
      if (els.activateBtn.getAttribute('aria-disabled') === 'true') return;
      track(activate(els.token.value, activateReport));
    });

    // Changes made elsewhere (another popup, the editor, the background) show up here too.
    const onStorage = (changes, area) => {
      if (area && area !== 'local') return;
      if (changes[SETTINGS_KEY]) {
        if (pending > 0) return;                       // our own writes: reloadSettings() settles when the queue drains
        state.settings = changes[SETTINGS_KEY].newValue ?? null;
        render();
      }
      if (changes[STORAGE_KEYS.licence]) track(loadLicence().then(render));
    };
    if (chrome.storage && chrome.storage.onChanged) {
      chrome.storage.onChanged.addListener(onStorage);
      cleanups.push(() => chrome.storage.onChanged.removeListener(onStorage));
    }
    // The content script announces health changes; re-ask rather than trusting a payload. Never answers (returns undefined).
    const onMessage = (message) => {
      if (message && message.type === MSG.STATUS_CHANGED && !destroyed) track(loadStatus());
    };
    if (chrome.runtime && chrome.runtime.onMessage) {
      chrome.runtime.onMessage.addListener(onMessage);
      cleanups.push(() => chrome.runtime.onMessage.removeListener(onMessage));
    }
  }

  function fillFooter() {
    let version = '';
    try { version = chrome.runtime.getManifest().version; } catch { version = ''; }
    els.version.textContent = typeof version === 'string' && /^\d[\w.+-]{0,31}$/.test(version) ? `Cinedrape v${version}` : 'Cinedrape';
  }

  async function init() {
    view = compute();
    buildThemeCards();
    buildSwatches();
    buildCalm();
    wire();
    fillFooter();
    await Promise.all([loadSettings(), loadLicence()]);
    render();
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      mountDevStrip({ doc, host: els.devSlot, activate: (token, report) => track(activate(token, report)) });
    }
    await loadStatus();
  }

  const ready = track(init());

  return {
    ready,
    /** Resolves once every save, check and message the popup started has finished. */
    async idle() {
      while (tasks.size) await Promise.allSettled([...tasks]);
    },
    /** Asks the tab and the background again. */
    refresh() {
      return track(Promise.all([loadLicence(), loadStatus(), reloadSettings()]).then(() => undefined));
    },
    destroy() {
      destroyed = true;
      for (const undo of cleanups.splice(0)) undo();
    },
    getState() {
      return {
        settings: state.settings, licence: state.licence, licenceKnown: state.licenceKnown,
        status: state.status, statusAt: state.statusAt, view,
      };
    },
  };
}
