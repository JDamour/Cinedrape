// Cinedrape popup: render + wiring (ARCHITECTURE.md section 4, popup).
//
//   const popup = createPopup({ doc: document, chrome, themes: THEMES });
//   await popup.ready;
//
// Everything that touches the outside world is injected (`doc`, `chrome`, `themes`, `now`), so test/popup drives it with
// jsdom and test/helpers/chrome-mock.js. The popup reads and writes only chrome.storage.local[cd.settings]; the open tab
// notices through storage.onChanged. Licence and health come over messages (MSG.GET_LICENCE, MSG.ACTIVATE_LICENCE,
// MSG.GET_STATUS). Controls are updated in place (never rebuilt), so focus and a half-typed hex value survive every update.
import { CALM_KEYS, CHECKOUT_URL, DEFAULT_SCHEDULE, FREE_THEME_IDS, LIMITS, MSG, PACK_1_THEME_IDS, STORAGE_KEYS, SUPPORT_URL } from '../shared/constants.js';
import { LICENCE_PUBLIC_KEY } from '../shared/public-keys.js';
import { exportTheme, importTheme } from '../shared/theme-schema.js';
import { validateProfile, validateSchedule } from '../shared/profiles.js';
import { canStartTrial, isTrialActive } from '../shared/entitlements.js';
import { isReservedThemeId, normalizeCustomThemes, normalizeProfiles, slugifyThemeId } from '../shared/collections.js';
import { describeFailure, isWorkerReply, messages } from '../shared/messages.js';
import {
  ACCENT_SWATCHES, CALM_PRESETS, DENSITY_LABELS, LICENCE_COPY,
  accentWarning, activationErrorCopy, applyCalmPreset, checkEntitlement, createBackupBundle, createDiagnostics,
  deriveView, formatCountdown, isDensity, licenceFromRecordVerified, lockedCopy, mergeSettings,
  normalizeToken, parseActivateResponse, parseHex, parseLicence, safeCssColor, sanitizePatch, sheetFeatureInfo, statusCopy,
  summarizeStatus, usableThemes, validateBackupBundle, withDefaults,
} from './model.js';
import { MESSAGE_ICONS, h, icon, setMessage } from './ui.js';
import { mountDevStrip } from './dev-strip.js';

const YOUTUBE_URL = /^https:\/\/(?:www\.)?youtube\.com(?:[/?#]|$)/;
const FREE_STATE = Object.freeze({ plan: 'free', status: 'none' });
const STATUS_ICONS = { ok: 'ok', paused: 'warn', checking: 'info', idle: 'info', unreachable: 'warn' };
const SETTINGS_KEY = STORAGE_KEYS.settings;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
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
  const optById = (id) => doc.getElementById(id) || null;
  const els = {
    noticeWrap: byId('notice-wrap'), notice: byId('notice'), noticeAction: byId('notice-action'), noticeDismiss: byId('notice-dismiss'),
    status: byId('status'), statusIcon: byId('status-icon'), statusText: byId('status-text'), statusDetail: byId('status-detail'),
    themeGroup: byId('theme-group'), themeGrid: byId('theme-grid'), themeNote: byId('theme-note'),
    themeEditorBtn: byId('theme-editor-btn'),
    themeExport: byId('theme-export'), themeImportBtn: byId('theme-import-btn'),
    themeImportPanel: byId('theme-import-panel'), themeImportClose: byId('theme-import-close'),
    themeImportFile: byId('theme-import-file'), themeImportJson: byId('theme-import-json'),
    themeImportSubmit: byId('theme-import-submit'), themeImportError: byId('theme-import-error'),
    themeImportConflict: byId('theme-import-conflict'),
    themeImportConflictMsg: byId('theme-import-conflict-msg'),
    themeImportReplaceBtn: byId('theme-import-replace-btn'),
    themeImportCopyBtn: byId('theme-import-copy-btn'),
    themeImportCancelBtn: byId('theme-import-cancel-btn'),
    profileManageBtn: byId('profile-manage-btn'), profileSchedulePanel: byId('profile-schedule-panel'),
    profilePanelClose: byId('profile-panel-close'), profileNameInput: byId('profile-name-input'),
    profileSaveBtn: byId('profile-save-btn'), profileList: byId('profile-list'),
    scheduleToggleBtn: byId('schedule-toggle-btn'), scheduleDayTime: byId('schedule-day-time'),
    scheduleDayProfile: byId('schedule-day-profile'), scheduleNightTime: byId('schedule-night-time'),
    scheduleNightProfile: byId('schedule-night-profile'), profileError: byId('profile-error'),
    scheduleOverrideBanner: byId('schedule-override-banner'),
    scheduleOverrideText: byId('schedule-override-text'),
    scheduleResumeBtn: byId('schedule-resume-btn'),
    backupManageBtn: byId('backup-manage-btn'), backupPanel: byId('backup-panel'),
    backupPanelClose: byId('backup-panel-close'), backupExportBtn: byId('backup-export-btn'),
    backupImportFile: byId('backup-import-file'), backupImportJson: byId('backup-import-json'),
    backupImportSubmit: byId('backup-import-submit'), backupError: byId('backup-error'),
    layoutGroup: byId('layout-group'), layoutLegend: byId('layout-legend'), layoutPro: optById('layout-pro'),
    layoutHome: byId('layout-home'), layoutWatch: byId('layout-watch'),
    layoutReset: byId('layout-reset'), layoutNote: byId('layout-note'), layoutUnlock: optById('layout-unlock'),
    swatches: byId('accent-swatches'), hex: byId('accent-hex'), hexPreview: byId('accent-preview'), accentReset: byId('accent-reset'),
    accentHelp: byId('accent-help'), accentError: byId('accent-error'), accentWarning: byId('accent-warning'),
    density: byId('density'), densityValue: byId('density-value'), densityPro: optById('density-pro'), densityNote: byId('density-note'),
    densityUnlock: optById('density-unlock'), densityReset: byId('density-reset'),
    textScale: byId('textscale'),
    animations: byId('animations'),
    calmPresets: byId('calm-presets'),
    calmList: byId('calm-list'),
    supportLink: optById('support-link'),
    footerCoffeeLink: optById('footer-coffee-link'),
    proState: optById('pro-state'), proStateIcon: optById('pro-state-icon'), proStateText: optById('pro-state-text'),
    founderBadge: optById('founder-badge'), proDetail: optById('pro-detail'), proThankYou: optById('pro-thank-you'),
    proActivatedBanner: optById('pro-activated-banner'), proActivatedDismiss: optById('pro-activated-dismiss'),
    proSaved: optById('pro-saved'), proUpgradeCard: optById('pro-upgrade-card'), proBuyLink: optById('pro-buy-link'), proRecover: optById('pro-recover'),
    activate: optById('activate'), activateSummary: optById('activate-summary'),
    activateForm: optById('activate-form'), token: optById('token'), activateBtn: optById('activate-btn'), activateResult: optById('activate-result'),
    trialBanner: optById('trial-banner'), trialTimer: optById('trial-timer'), trialBuyBtn: optById('trial-buy-btn'), trialBannerDismiss: optById('trial-banner-dismiss'),
    proSheet: optById('pro-sheet'), sheetBackdrop: optById('sheet-backdrop'), sheetCloseBtn: optById('sheet-close-btn'),
    sheetTitle: optById('sheet-title'), sheetDesc: optById('sheet-desc'), sheetPreview: optById('sheet-preview'),
    sheetLimitNote: optById('sheet-limit-note'), sheetTrialBtn: optById('sheet-trial-btn'), sheetBuyBtn: optById('sheet-buy-btn'),
    day7Card: optById('day7-card'), day7DismissBtn: optById('day7-dismiss-btn'), day7DismissLink: optById('day7-dismiss-link'), day7BuyLink: optById('day7-buy-link'),
    copyDiagnosticsBtn: byId('copy-diagnostics-btn'),
    version: byId('version'), siteLink: byId('site-link'), devSlot: byId('dev-slot'),
  };

  const state = {
    settings: null,                       // the stored cd.settings object as read (null = nothing stored yet)
    customThemes: {},
    customThemesRevision: 1,
    profiles: [],
    profilesRevision: 1,
    schedule: null,
    licence: FREE_STATE,
    licenceKnown: false,
    status: { kind: 'checking', summary: null },
    statusAt: 0,
    activating: false,
    trial: null,
    trialEnded: false,
    trialLog: null,
    install: null,
  };
  let view = null;
  let pending = 0;                        // settings writes in flight or queued
  let queue = Promise.resolve();          // serialises read-modify-write of cd.settings
  let statusSeq = 0;
  let statusTabId = null;
  const recoveryAttempts = new Set();
  let destroyed = false;
  let activateOpened = false;
  let countdownTimer = null;
  const tasks = new Set();
  const cleanups = [];

  function stopCountdown() {
    if (countdownTimer) {
      win.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }
  cleanups.push(stopCountdown);

  function ensureCountdown() {
    if (isTrialActive(state.trial, now())) {
      if (!countdownTimer) {
        countdownTimer = win.setInterval(() => {
          if (!isTrialActive(state.trial, now())) {
            stopCountdown();
            state.trialEnded = true;
            render();
          } else {
            render();
          }
        }, 1000);
      }
    } else {
      stopCountdown();
    }
  }

  const track = (promise) => {
    tasks.add(promise);
    const done = () => tasks.delete(promise);
    promise.then(done, done);
    return promise;
  };
  const listen = (target, type, fn, options) => {
    if (!target) return;
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

  const compute = () => deriveView({
    settings: state.settings,
    licence: state.licence,
    licenceKnown: state.licenceKnown,
    themes: themeList,
    customThemes: state.customThemes,
    profiles: state.profiles,
    schedule: state.schedule,
    trial: state.trial,
    trialEnded: state.trialEnded,
    install: state.install,
    nowMs: now(),
  });

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
    view = compute();
    const groups = [
      { id: 'free', label: 'Themes', themes: [] },
      { id: 'custom', label: 'Custom', themes: [] },
    ];

    for (const tv of view.themes) {
      if (tv.isCustom) {
        groups[1].themes.push(tv);
      } else {
        groups[0].themes.push(tv);
      }
    }

    const elements = [];
    for (const group of groups) {
      if (group.themes.length === 0) continue;
      elements.push(h(doc, 'h3', { class: 'theme-group-header' }, group.label));
      for (const tv of group.themes) {
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
        const tag = tv.isCustom
          ? h(doc, 'span', { class: 'tag-custom' }, 'Custom')
          : (tv.pro
            ? h(doc, 'span', { class: 'tag-pro' },
              h(doc, 'span', { class: 'tag-lock', hidden: true }, icon(doc, 'lock')),
              'Pro',
              h(doc, 'span', { class: 'sr-only', hidden: true }, ', locked'))
            : null);
        const delBtn = tv.isCustom
          ? h(doc, 'button', {
            type: 'button', class: 'theme-delete', 'data-delete-theme': tv.id, 'aria-label': `Delete ${tv.name} theme`,
          }, icon(doc, 'close'))
          : null;
        elements.push(h(doc, 'button', {
          type: 'button', role: 'radio', class: 'theme-card', 'data-theme-id': tv.id, 'aria-checked': 'false', tabindex: '-1',
        },
        delBtn,
        preview,
        h(doc, 'span', { class: 'theme-meta' }, h(doc, 'span', { class: 'theme-name' }, tv.name), tag),
        h(doc, 'span', { class: 'theme-check', 'aria-hidden': 'true' }, icon(doc, 'check'))));
      }
    }
    els.themeGrid.replaceChildren(...elements);
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

  function syncLayout() {
    const l = view.layout;
    for (const btn of radios(els.layoutHome)) {
      const active = btn.dataset.home === l.home.value;
      btn.setAttribute('aria-checked', String(active));
      if (l.locked) {
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('aria-disabled');
      }
    }
    setRovingTabStop(els.layoutHome);

    for (const btn of radios(els.layoutWatch)) {
      const active = btn.dataset.watch === l.watch.value;
      btn.setAttribute('aria-checked', String(active));
      if (l.locked) {
        btn.setAttribute('aria-disabled', 'true');
      } else {
        btn.removeAttribute('aria-disabled');
      }
    }
    setRovingTabStop(els.layoutWatch);

    if (els.layoutPro) els.layoutPro.hidden = true;
    if (els.layoutUnlock) els.layoutUnlock.hidden = true;
    els.layoutReset.hidden = !l.custom;
    els.layoutNote.textContent = l.custom ? 'Your own layout settings.' : 'Using the theme’s layout.';
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
    els.density.disabled = false;
    els.density.value = String(d.value);
    els.density.setAttribute('aria-valuetext', `${d.value} of 5, ${d.label}`);
    els.densityValue.textContent = d.label;
    if (els.densityPro) els.densityPro.hidden = true;
    if (els.densityUnlock) els.densityUnlock.hidden = true;
    els.densityReset.hidden = !d.custom;
    const themeName = view.theme ? view.theme.name : 'the theme';
    els.densityNote.textContent = d.custom ? 'Your own setting.' : `Using ${themeName}’s own spacing.`;
  }

  function syncTextScale() {
    const current = view.textScale.value;
    for (const btn of radios(els.textScale)) {
      const scale = Number(btn.dataset.scale);
      btn.setAttribute('aria-checked', String(scale === current));
    }
    setRovingTabStop(els.textScale);
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
    if (els.supportLink) els.supportLink.href = SUPPORT_URL;
    if (els.footerCoffeeLink) els.footerCoffeeLink.href = SUPPORT_URL;
    if (!els.proState) return;
    const copy = LICENCE_COPY[view.licenceKey] || LICENCE_COPY.free;
    els.proState.dataset.state = view.licenceKey;
    if (els.proStateText) els.proStateText.textContent = copy.label;
    if (els.proStateIcon) {
      els.proStateIcon.querySelector('use')?.setAttribute('href',
        view.licenceKey === 'active' ? '#i-ok' : (view.licenceKey === 'free' ? '#i-info' : '#i-warn'));
    }
    if (els.founderBadge) els.founderBadge.hidden = !(view.pro && view.tier === 'founder');
    if (view.pro && view.licenceKey === 'active') {
      if (els.proThankYou) {
        els.proThankYou.hidden = false;
        els.proThankYou.textContent = view.tier === 'founder'
          ? 'Founder · thank you for supporting Cinedrape'
          : 'Pro · thank you';
      }
    } else {
      if (els.proThankYou) els.proThankYou.hidden = true;
    }
    if (els.proDetail) els.proDetail.textContent = copy.detail;
    if (els.proSaved) els.proSaved.textContent = '';
    if (els.activateSummary) els.activateSummary.textContent = view.pro ? 'Use a different licence token' : 'I have a licence';
    if (els.proUpgradeCard) els.proUpgradeCard.hidden = true;
    if (els.proRecover) els.proRecover.hidden = true;
    if (els.proBuyLink) els.proBuyLink.href = SUPPORT_URL;
    if (els.activate) els.activate.open = false;
  }

  function syncStatus() {
    const { kind, summary } = state.status;
    const copy = statusCopy(kind, { summary, themes: themeList });
    els.status.dataset.state = kind;
    els.statusText.textContent = copy.text;
    els.statusDetail.textContent = copy.detail;
    const reload = optById('status-reload');
    if (reload) reload.hidden = kind !== 'unreachable';
    els.statusIcon.querySelector('use').setAttribute('href', `#i-${STATUS_ICONS[kind] || 'info'}`);
  }

  function syncProfilesAndSchedule() {
    const items = (view.profiles || []).map((p) => {
      const applyBtn = h(doc, 'button', {
        type: 'button', class: 'btn btn-secondary btn-small', 'data-apply-profile': p.id,
      }, 'Apply');
      const delBtn = h(doc, 'button', {
        type: 'button', class: 'btn btn-ghost btn-small', 'data-delete-profile': p.id,
      }, 'Delete');
      return h(doc, 'div', { class: 'profile-item', 'data-profile-id': p.id },
        h(doc, 'span', { class: 'profile-item-name' }, p.name),
        h(doc, 'div', { class: 'profile-item-actions' }, applyBtn, delBtn));
    });
    if (items.length === 0) {
      els.profileList.replaceChildren(h(doc, 'p', { class: 'hint' }, 'No saved profiles yet.'));
    } else {
      els.profileList.replaceChildren(...items);
    }

    const optionsDay = [h(doc, 'option', { value: '' }, '-- Select Profile or Look --')];
    const optionsNight = [h(doc, 'option', { value: '' }, '-- Select Profile or Look --')];
    for (const t of themeList) {
      optionsDay.push(h(doc, 'option', { value: t.id }, `${t.name} (bundled)`));
      optionsNight.push(h(doc, 'option', { value: t.id }, `${t.name} (bundled)`));
    }
    for (const p of view.profiles || []) {
      optionsDay.push(h(doc, 'option', { value: p.id }, p.name));
      optionsNight.push(h(doc, 'option', { value: p.id }, p.name));
    }
    const curDay = (view.schedule ? view.schedule.dayProfileId : '') || '';
    const curNight = (view.schedule ? view.schedule.nightProfileId : '') || '';
    els.scheduleDayProfile.replaceChildren(...optionsDay);
    els.scheduleNightProfile.replaceChildren(...optionsNight);
    els.scheduleDayProfile.value = curDay;
    els.scheduleNightProfile.value = curNight;

    const sched = view.schedule || {};
    els.scheduleToggleBtn.textContent = sched.enabled ? 'Schedule: On' : 'Schedule: Off';
    els.scheduleToggleBtn.classList.toggle('btn-primary', Boolean(sched.enabled));
    els.scheduleToggleBtn.classList.toggle('btn-secondary', !sched.enabled);
    if (sched.dayTime && doc.activeElement !== els.scheduleDayTime) els.scheduleDayTime.value = sched.dayTime;
    if (sched.nightTime && doc.activeElement !== els.scheduleNightTime) els.scheduleNightTime.value = sched.nightTime;

    const nowMs = now();
    if (sched.enabled && sched.manualOverrideUntil && nowMs < sched.manualOverrideUntil) {
      if (els.scheduleOverrideBanner) {
        els.scheduleOverrideBanner.hidden = false;
        const d = new Date(sched.manualOverrideUntil);
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        if (els.scheduleOverrideText) els.scheduleOverrideText.textContent = `Manual override active until ${hh}:${mm}.`;
      }
    } else if (els.scheduleOverrideBanner) {
      els.scheduleOverrideBanner.hidden = true;
    }

    if (sched.lastError === 'missing-profile') {
      els.profileError.textContent = 'Scheduled profile was not found. Schedule was paused.';
    }
  }

  function syncTrial() {
    if (els.trialBanner) els.trialBanner.hidden = true;
  }

  function syncDay7Card() {
    if (!els.day7Card) return;
    if (view && view.day7Card && view.day7Card.show) {
      els.day7Card.hidden = false;
      if (els.day7BuyLink) {
        els.day7BuyLink.href = SUPPORT_URL;
      }
    } else {
      els.day7Card.hidden = true;
    }
  }

  async function dismissDay7Card() {
    const currentInstall = state.install || { installedAt: now(), day7Dismissed: false };
    const updated = { ...currentInstall, day7Dismissed: true };
    state.install = updated;
    render();
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.set === 'function') {
      try {
        await chrome.storage.local.set({ [STORAGE_KEYS.install]: updated });
      } catch (err) {
        debug('failed to persist day7 dismissal', err);
      }
    }
  }

  function render() {
    if (destroyed) return;
    view = compute();
    syncTrial();
    syncDay7Card();
    syncThemes();
    syncLayout();
    syncAccent();
    syncDensity();
    syncTextScale();
    syncAnimations();
    syncCalm();
    syncLicence();
    syncStatus();
    syncProfilesAndSchedule();
  }

  // ---- settings: read, write ---------------------------------------------------------------------------------------------

  async function loadSettings() {
    const got = await attempt(() => chrome.storage.local.get([
      SETTINGS_KEY,
      STORAGE_KEYS.customThemes,
      STORAGE_KEYS.profiles,
      STORAGE_KEYS.schedule,
      STORAGE_KEYS.selectorMap,
      STORAGE_KEYS.install,
    ]));
    if (!got.ok) {
      notify('Cinedrape could not read your saved settings. Showing the defaults.', { kind: 'error' });
      return;
    }
    state.settings = got.value ? got.value[SETTINGS_KEY] ?? null : null;
    const rawThemes = got.value ? got.value[STORAGE_KEYS.customThemes] : undefined;
    const normThemes = normalizeCustomThemes(rawThemes);
    state.customThemes = normThemes.record ? normThemes.record.items : (normThemes.items || {});
    state.customThemesRevision = normThemes.record ? normThemes.record.revision : (normThemes.revision || 1);

    const rawProfiles = got.value ? got.value[STORAGE_KEYS.profiles] : undefined;
    const normProfiles = normalizeProfiles(rawProfiles);
    state.profiles = normProfiles.record ? normProfiles.record.items : (normProfiles.items || []);
    state.profilesRevision = normProfiles.record ? normProfiles.record.revision : (normProfiles.revision || 1);

    state.selectorMap = got.value ? got.value[STORAGE_KEYS.selectorMap] : null;
    state.schedule = got.value && typeof got.value[STORAGE_KEYS.schedule] === 'object' && got.value[STORAGE_KEYS.schedule] !== null ? got.value[STORAGE_KEYS.schedule] : null;
    state.install = got.value && typeof got.value[STORAGE_KEYS.install] === 'object' && got.value[STORAGE_KEYS.install] !== null ? got.value[STORAGE_KEYS.install] : null;
  }

  async function loadTrial() {
    let sessionData = {};
    if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.get === 'function') {
      const res = await attempt(() => chrome.storage.session.get([STORAGE_KEYS.trial, 'cd_trialEnded']));
      if (res.ok && res.value) sessionData = res.value;
    }
    let localData = {};
    if (chrome.storage && chrome.storage.local && typeof chrome.storage.local.get === 'function') {
      const res = await attempt(() => chrome.storage.local.get([STORAGE_KEYS.trialLog]));
      if (res.ok && res.value) localData = res.value;
    }
    state.trial = sessionData[STORAGE_KEYS.trial] || null;
    state.trialEnded = Boolean(sessionData.cd_trialEnded);
    state.trialLog = localData[STORAGE_KEYS.trialLog] || null;
    ensureCountdown();
  }

  async function persist(patch) {
    const got = await chrome.storage.local.get([SETTINGS_KEY, STORAGE_KEYS.schedule]);
    const merged = mergeSettings(got ? got[SETTINGS_KEY] : undefined, patch);
    const writes = { [SETTINGS_KEY]: merged };
    const sched = got ? got[STORAGE_KEYS.schedule] : null;
    if (sched && sched.enabled) {
      const d = new Date();
      const [dHH, dMM] = (sched.dayTime || '08:00').split(':').map(Number);
      const [nHH, nMM] = (sched.nightTime || '20:00').split(':').map(Number);
      const y = d.getFullYear(), m = d.getMonth(), dt = d.getDate();
      const cand = [
        new Date(y, m, dt, dHH, dMM).getTime(),
        new Date(y, m, dt, nHH, nMM).getTime(),
        new Date(y, m, dt + 1, dHH, dMM).getTime(),
        new Date(y, m, dt + 1, nHH, nMM).getTime(),
      ].filter((t) => t > Date.now()).sort((a, b) => a - b);
      writes[STORAGE_KEYS.schedule] = {
        ...sched,
        manualOverrideUntil: cand[0] || (Date.now() + 12 * 3600 * 1000),
      };
    }
    await chrome.storage.local.set(writes);
  }

  /** True when `patch` would not change anything that is stored. */
  function isNoop(patch) {
    const cur = withDefaults(state.settings);
    return Object.keys(patch).every((key) => {
      if (key === 'calm') return Object.keys(patch.calm).every((k) => cur.calm[k] === patch.calm[k]);
      if (key === 'layout') return Object.keys(patch.layout).every((k) => cur.layout[k] === patch.layout[k]);
      return cur[key] === patch[key];
    });
  }

  function openSupportUrl() {
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url: SUPPORT_URL });
    } else if (win.open) {
      win.open(SUPPORT_URL, '_blank');
    }
  }

  function openCheckout(src = 'popup') {
    const url = `${CHECKOUT_URL}?checkout[custom][src]=${encodeURIComponent(src)}`;
    if (chrome.tabs && chrome.tabs.create) {
      chrome.tabs.create({ url });
    } else if (win.open) {
      win.open(url, '_blank');
    }
  }

  function openProSheet(kind, key, theme = null) {
    if (!els.proSheet) return;
    if (view && view.pro) return;
    const info = sheetFeatureInfo(kind, key, theme);
    els.sheetTitle.textContent = info.title;
    els.sheetDesc.textContent = info.desc;
    if (info.previewBg) els.sheetPreview.style.setProperty('--sheet-bg', info.previewBg);
    if (info.previewAccent) els.sheetPreview.style.setProperty('--sheet-accent', info.previewAccent);

    const check = canStartTrial(state.trialLog, now(), LIMITS.maxDailyTrials);
    if (!check.ok) {
      els.sheetTrialBtn.disabled = true;
      els.sheetTrialBtn.setAttribute('aria-disabled', 'true');
      els.sheetLimitNote.hidden = false;
      els.sheetLimitNote.textContent = check.message || check.reason;
    } else {
      els.sheetTrialBtn.disabled = false;
      els.sheetTrialBtn.removeAttribute('aria-disabled');
      els.sheetLimitNote.hidden = true;
      els.sheetLimitNote.textContent = '';
    }

    els.proSheet.hidden = false;
    els.sheetTrialBtn.focus();
  }

  function closeProSheet() {
    if (els.proSheet) els.proSheet.hidden = true;
  }

  /**
   * Validates, checks the tier, shows the change at once and writes it. Resolves true when the change was stored.
   * Locked or invalid changes never reach storage (the UI is put back as it was and the reason is shown).
   */
  async function commit(rawPatch, { isTap = true } = {}) {
    const customIds = Object.keys(state.customThemes || {});
    const clean = sanitizePatch(rawPatch, customIds);
    if (!clean.ok) {
      notify(clean.error, { kind: 'error' });
      render();
      return false;
    }
    const entitlement = checkEntitlement(clean.patch, {
      licence: state.licence,
      trial: state.trial,
      trialActive: isTrialActive(state.trial, now()),
      themes: themeList,
      customThemes: state.customThemes,
    });
    if (!entitlement.ok) {
      if (entitlement.kind === 'unknown-theme') notify('That theme is not available.', { kind: 'error' });
      else {
        notify(lockedCopy(entitlement, view.licenceKey), { kind: 'pro', action: true });
        if (isTap) {
          const themeObj = entitlement.kind === 'theme' ? themeList.find((t) => t.id === clean.patch.themeId) : null;
          openProSheet(entitlement.kind, entitlement.key, themeObj);
        }
      }
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
      if (els.proActivatedBanner && view.pro) els.proActivatedBanner.hidden = false;
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
    let found = await attempt(() => chrome.tabs.query({ active: true, currentWindow: true }));
    if (seq !== statusSeq || destroyed) return;
    let tab = found.ok && Array.isArray(found.value) ? found.value[0] : undefined;
    if (!tab && chrome.tabs && chrome.tabs.query) {
      found = await attempt(() => chrome.tabs.query({ active: true, lastFocusedWindow: true }));
      if (seq !== statusSeq || destroyed) return;
      tab = found.ok && Array.isArray(found.value) ? found.value[0] : undefined;
    }
    if (!tab || !Number.isInteger(tab.id) || typeof tab.url !== 'string' || !YOUTUBE_URL.test(tab.url)) {
      statusTabId = null;
      setStatus('idle');
      return;
    }
    statusTabId = tab.id;
    let reply = await attempt(() => chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS }), 1500);
    if (!reply.ok && seq === statusSeq && !destroyed) {
      await new Promise((r) => win.setTimeout(r, WORKER_RETRY_PAUSE_MS));
      if (seq === statusSeq && !destroyed) {
        reply = await attempt(() => chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS }), 2000);
      }
    }
    if (seq !== statusSeq || destroyed) return;
    // Tabs open before an install/reload may have no content script. Restore the
    // packaged script in the main frame only; its guard prevents duplicate engines.
    let accessBlocked = false;
    if (!reply.ok && chrome.scripting?.executeScript && !recoveryAttempts.has(tab.id)) {
      recoveryAttempts.add(tab.id);
      const injected = await attempt(() => chrome.scripting.executeScript({
        target: { tabId: tab.id }, files: ['content.js'],
      }), 3000);
      if (seq !== statusSeq || destroyed) return;
      if (injected.ok) {
        reply = await attempt(() => chrome.tabs.sendMessage(tab.id, { type: MSG.GET_STATUS }), 3000);
      } else if (injected.error) {
        const errMsg = String(injected.error.message || injected.error || '');
        if (/blocked|cannot access|site access|permission/i.test(errMsg)) {
          accessBlocked = true;
        }
      }
    }
    if (seq !== statusSeq || destroyed) return;
    const summary = reply.ok ? summarizeStatus(reply.value) : null;
    if (!summary) {
      setStatus('unreachable');
      if (accessBlocked) {
        notify('Extensions are blocked on YouTube in this browser. Allow extensions on youtube.com in your browser’s extension settings, then reload.', { kind: 'warn' });
      }
    } else setStatus(summary.broken.length ? 'paused' : 'ok', summary);
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
    const reload = optById('status-reload');
    if (reload) listen(reload, 'click', () => track((async () => {
      if (!Number.isInteger(statusTabId)) return;
      const tabId = statusTabId;
      if (chrome.permissions && typeof chrome.permissions.request === 'function') {
        await attempt(() => chrome.permissions.request({
          origins: ['https://www.youtube.com/*', 'https://youtube.com/*'],
        }), 3000);
      }
      // Re-check the URL: the tab may have navigated while the popup was open.
      const current = await attempt(() => chrome.tabs.get(tabId));
      if (!current.ok || !YOUTUBE_URL.test(current.value?.url || '')) return;
      reload.disabled = true;
      const result = await attempt(() => chrome.tabs.reload(tabId));
      reload.disabled = false;
      if (result.ok) {
        recoveryAttempts.delete(tabId);
        setStatus('checking');
        await pause(750);
        if (!destroyed) await loadStatus();
        if (!destroyed && state.status.kind === 'unreachable') {
          notify('Could not connect to YouTube. Check Cinedrape’s site access in your browser’s extension settings.', { kind: 'error' });
        }
      } else notify('Could not reload YouTube. Check Cinedrape’s site access in your browser’s extension settings.', { kind: 'error' });
    })()));
    const chooseTheme = (card, isTap = true) => commit({ themeId: card.dataset.themeId }, { isTap });
    async function callWorkerOrDirect(workerMsg, directFn) {
      if (chrome.runtime && chrome.runtime.sendMessage) {
        const res = await attempt(() => chrome.runtime.sendMessage(workerMsg), 3000);
        if (res.ok && isWorkerReply(res.value)) {
          return res.value;
        }
      }
      return directFn();
    }

    listen(els.themeGrid, 'click', async (event) => {
      const delBtn = event.target.closest('.theme-delete');
      if (delBtn) {
        event.stopPropagation();
        const themeId = delBtn.dataset.deleteTheme;
        if (!themeId) return;
        const res = await callWorkerOrDirect(
          messages.deleteTheme(themeId, { expectedRevision: state.customThemesRevision, resetReferences: true }),
          async () => {
            const updated = { ...(state.customThemes || {}) };
            delete updated[themeId];
            state.customThemes = updated;
            state.customThemesRevision = (state.customThemesRevision || 1) + 1;
            const envelope = { schema: 1, revision: state.customThemesRevision, items: updated };
            await chrome.storage.local.set({ [STORAGE_KEYS.customThemes]: envelope });
            if (state.settings && state.settings.themeId === themeId) {
              await commit({ themeId: 'cinema' });
            }
            return { ok: true, revision: state.customThemesRevision };
          }
        );
        if (res.ok) {
          notify('Theme deleted.', { kind: 'info' });
          buildThemeCards();
          await reloadSettings();
        } else {
          notify(describeFailure(res, 'Could not delete theme.'), { kind: 'error' });
          if (res.reason === 'conflict' || res.reason === 'not-found') {
            await reloadSettings();
            buildThemeCards();
          }
        }
        return;
      }
      const card = event.target.closest('[role="radio"]');
      if (card && els.themeGrid.contains(card)) chooseTheme(card, event.detail > 0);
    });
    // Arrow keys move focus and select, like a native radio group; a locked card only takes focus.
    listen(els.themeGrid, 'keydown', onRadioKeydown(els.themeGrid, (card) => {
      if (card.getAttribute('aria-disabled') !== 'true') chooseTheme(card, false);
    }));

    if (els.themeEditorBtn) {
      listen(els.themeEditorBtn, 'click', () => {
        if (chrome.tabs && chrome.tabs.create) {
          chrome.tabs.create({ url: chrome.runtime.getURL('editor/editor.html') });
        } else if (win.open) {
          win.open('editor/editor.html', '_blank');
        }
      });
    }

    listen(els.themeExport, 'click', () => {
      try {
        const curTheme = usableThemes(themes, state.customThemes).find((t) => t.id === (view.theme ? view.theme.id : 'cinema')) || themes[0];
        const calmOverrides = {};
        for (const c of view.calm) calmOverrides[c.key] = c.on;
        const exported = exportTheme(curTheme, {
          accent: view.accent,
          density: view.density.custom ? view.density.value : null,
          calm: calmOverrides,
        });
        if (win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
          win.navigator.clipboard.writeText(exported);
          notify(`Theme "${curTheme.name}" copied to clipboard!`, { kind: 'info' });
        } else {
          notify(`Theme "${curTheme.name}" exported!`, { kind: 'info' });
        }
      } catch (err) {
        notify('Could not export theme: ' + err.message, { kind: 'error' });
      }
    });

    listen(els.themeImportBtn, 'click', () => {
      els.themeImportPanel.hidden = !els.themeImportPanel.hidden;
      els.themeImportError.textContent = '';
      if (els.themeImportConflict) els.themeImportConflict.hidden = true;
      if (!els.themeImportPanel.hidden) els.themeImportJson.focus();
    });
    listen(els.themeImportClose, 'click', () => {
      els.themeImportPanel.hidden = true;
      els.themeImportError.textContent = '';
      if (els.themeImportConflict) els.themeImportConflict.hidden = true;
    });

    listen(els.themeImportFile, 'change', () => {
      const file = els.themeImportFile.files && els.themeImportFile.files[0];
      if (!file) return;
      const reader = new win.FileReader();
      reader.onload = () => {
        els.themeImportJson.value = String(reader.result || '');
      };
      reader.readAsText(file);
    });

    async function applyImportedTheme(theme, { replace = false } = {}) {
      const customCount = Object.keys(state.customThemes || {}).length;
      if (!state.customThemes[theme.id] && customCount >= LIMITS.maxCustomThemes) {
        els.themeImportError.textContent = `Maximum ${LIMITS.maxCustomThemes} custom themes allowed. Delete one first.`;
        return;
      }
      const saved = await callWorkerOrDirect(
        messages.saveTheme(theme, { mode: replace ? 'update' : 'create', expectedRevision: state.customThemesRevision }),
        async () => {
          const updated = { ...(state.customThemes || {}), [theme.id]: theme };
          state.customThemes = updated;
          state.customThemesRevision = (state.customThemesRevision || 1) + 1;
          const envelope = { schema: 1, revision: state.customThemesRevision, items: updated };
          await chrome.storage.local.set({ [STORAGE_KEYS.customThemes]: envelope });
          return { ok: true, theme, revision: state.customThemesRevision };
        }
      );
      if (!saved.ok) {
        els.themeImportError.textContent = describeFailure(saved, 'Could not save imported theme.');
        if (saved.reason === 'conflict') await reloadSettings();
        return;
      }
      if (saved.record && saved.record.items && typeof saved.record.items === 'object') {
        state.customThemes = saved.record.items;
        state.customThemesRevision = saved.record.revision;
      }
      buildThemeCards();
      const committed = await commit({ themeId: theme.id });
      els.themeImportPanel.hidden = true;
      if (els.themeImportConflict) els.themeImportConflict.hidden = true;
      els.themeImportJson.value = '';
      if (els.themeImportFile) els.themeImportFile.value = '';
      if (committed) {
        notify(`Imported and activated theme "${theme.name}"!`, { kind: 'info' });
      } else {
        notify(`Theme "${theme.name}" imported, but could not be applied.`, { kind: 'warn' });
      }
      await reloadSettings();
    }

    listen(els.themeImportSubmit, 'click', async () => {
      els.themeImportError.textContent = '';
      if (els.themeImportConflict) els.themeImportConflict.hidden = true;
      const text = els.themeImportJson.value.trim();
      if (!text) {
        els.themeImportError.textContent = 'Paste JSON or choose a file first.';
        return;
      }
      const selectorMap = state.selectorMap || null;
      const res = importTheme(text, { selectorMap });
      if (!res.ok || !res.theme) {
        const firstErr = res.errors && res.errors[0];
        const lineCol = (firstErr && firstErr.line) ? ` (line ${firstErr.line}, col ${firstErr.column})` : '';
        els.themeImportError.textContent = firstErr ? `${firstErr.message}${lineCol}` : 'Invalid theme.';
        return;
      }
      if (isReservedThemeId(res.theme.id)) {
        res.theme.id = slugifyThemeId(res.theme.name, { existingIds: Object.keys(state.customThemes || {}) });
      }
      if (state.customThemes && state.customThemes[res.theme.id]) {
        state.pendingImportTheme = res.theme;
        if (els.themeImportConflict && els.themeImportConflictMsg) {
          els.themeImportConflictMsg.textContent = `A custom theme with ID "${res.theme.id}" already exists.`;
          els.themeImportConflict.hidden = false;
        }
        return;
      }
      await applyImportedTheme(res.theme);
    });

    if (els.themeImportReplaceBtn) {
      listen(els.themeImportReplaceBtn, 'click', async () => {
        if (state.pendingImportTheme) {
          const t = state.pendingImportTheme;
          state.pendingImportTheme = null;
          await applyImportedTheme(t, { replace: true });
        }
      });
    }

    if (els.themeImportCopyBtn) {
      listen(els.themeImportCopyBtn, 'click', async () => {
        if (state.pendingImportTheme) {
          const t = state.pendingImportTheme;
          state.pendingImportTheme = null;
          t.id = slugifyThemeId(t.name + '-copy', { existingIds: Object.keys(state.customThemes || {}) });
          t.name = `${t.name} (Copy)`;
          await applyImportedTheme(t);
        }
      });
    }

    if (els.themeImportCancelBtn) {
      listen(els.themeImportCancelBtn, 'click', () => {
        state.pendingImportTheme = null;
        if (els.themeImportConflict) els.themeImportConflict.hidden = true;
      });
    }

    listen(els.profileManageBtn, 'click', () => {
      els.profileSchedulePanel.hidden = !els.profileSchedulePanel.hidden;
      els.profileError.textContent = '';
      if (!els.profileSchedulePanel.hidden) els.profileNameInput.focus();
    });

    listen(els.profilePanelClose, 'click', () => {
      els.profileSchedulePanel.hidden = true;
      els.profileError.textContent = '';
    });

    listen(els.profileSaveBtn, 'click', async () => {
      els.profileError.textContent = '';
      const name = els.profileNameInput.value.trim();
      if (!name) {
        els.profileError.textContent = 'Enter a profile name.';
        return;
      }
      if (state.profiles.length >= LIMITS.maxProfiles) {
        els.profileError.textContent = `Maximum ${LIMITS.maxProfiles} profiles allowed. Delete one first.`;
        return;
      }
      const id = 'prof-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const curSettings = withDefaults(state.settings);
      const res = validateProfile({
        id,
        name,
        settings: {
          themeId: curSettings.themeId,
          accent: curSettings.accent,
          density: curSettings.density,
          animations: curSettings.animations,
          textScale: curSettings.textScale,
          calm: curSettings.calm,
        },
      });
      if (!res.ok) {
        els.profileError.textContent = res.error;
        return;
      }
      const saved = await callWorkerOrDirect(
        messages.saveProfile(res.profile, state.profilesRevision),
        async () => {
          const updated = [...state.profiles, res.profile];
          state.profiles = updated;
          state.profilesRevision = (state.profilesRevision || 1) + 1;
          const envelope = { schema: 1, revision: state.profilesRevision, items: updated };
          await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: envelope });
          return { ok: true, profile: res.profile, revision: state.profilesRevision };
        }
      );
      if (!saved.ok) {
        els.profileError.textContent = describeFailure(saved, 'Could not save profile.');
        if (saved.reason === 'conflict') await reloadSettings();
        return;
      }
      els.profileNameInput.value = '';
      notify(`Saved profile "${name}"!`, { kind: 'info' });
      await reloadSettings();
    });

    listen(els.profileList, 'click', async (event) => {
      const applyBtn = event.target.closest('[data-apply-profile]');
      if (applyBtn) {
        const id = applyBtn.dataset.applyProfile;
        const prof = state.profiles.find((p) => p.id === id);
        if (!prof) return;
        const applied = await callWorkerOrDirect(
          messages.applyProfile(id),
          async () => {
            if (prof.settings) {
              const { schema, ...patch } = prof.settings;
              const ok = await commit(patch);
              return { ok, settings: state.settings };
            }
            return { ok: false, error: 'profile-settings-empty' };
          }
        );
        if (applied.ok) {
          notify(`Applied profile "${prof.name}".`, { kind: 'info' });
          await reloadSettings();
        } else {
          notify(describeFailure(applied, 'Could not apply profile.'), { kind: 'error' });
          if (applied.reason === 'not-found') await reloadSettings();
        }
        return;
      }
      const delBtn = event.target.closest('[data-delete-profile]');
      if (delBtn) {
        const id = delBtn.dataset.deleteProfile;
        const deleted = await callWorkerOrDirect(
          messages.deleteProfile(id, state.profilesRevision),
          async () => {
            const updated = state.profiles.filter((p) => p.id !== id);
            state.profiles = updated;
            state.profilesRevision = (state.profilesRevision || 1) + 1;
            const envelope = { schema: 1, revision: state.profilesRevision, items: updated };
            await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: envelope });
            return { ok: true, revision: state.profilesRevision };
          }
        );
        if (deleted.ok) {
          notify('Profile deleted.', { kind: 'info' });
          await reloadSettings();
        } else {
          notify(describeFailure(deleted, 'Could not delete profile.'), { kind: 'error' });
          if (deleted.reason === 'conflict' || deleted.reason === 'not-found') await reloadSettings();
        }
        return;
      }
    });

    listen(els.scheduleToggleBtn, 'click', async () => {
      const cur = state.schedule || { ...DEFAULT_SCHEDULE };
      const nextEnabled = !cur.enabled;
      const nextSched = {
        schema: 1,
        enabled: nextEnabled,
        dayProfileId: els.scheduleDayProfile.value || cur.dayProfileId || null,
        nightProfileId: els.scheduleNightProfile.value || cur.nightProfileId || null,
        dayTime: els.scheduleDayTime.value || cur.dayTime || DEFAULT_SCHEDULE.dayTime,
        nightTime: els.scheduleNightTime.value || cur.nightTime || DEFAULT_SCHEDULE.nightTime,
        manualOverrideUntil: null,
        lastError: null,
      };
      const val = validateSchedule(nextSched);
      if (!val.ok) {
        els.profileError.textContent = val.error;
        return;
      }
      const updated = await callWorkerOrDirect(
        messages.updateSchedule(val.schedule),
        async () => {
          await chrome.storage.local.set({ [STORAGE_KEYS.schedule]: val.schedule });
          return { ok: true, schedule: val.schedule };
        }
      );
      if (updated.ok) {
        state.schedule = updated.schedule;
        render();
      } else {
        els.profileError.textContent = describeFailure(updated, 'Could not update schedule.');
      }
    });

    if (els.scheduleResumeBtn) {
      listen(els.scheduleResumeBtn, 'click', async () => {
        if (!state.schedule) return;
        const nextSched = { ...state.schedule, manualOverrideUntil: null, lastError: null };
        const updated = await callWorkerOrDirect(
          messages.updateSchedule(nextSched),
          async () => {
            await chrome.storage.local.set({ [STORAGE_KEYS.schedule]: nextSched });
            return { ok: true, schedule: nextSched };
          }
        );
        if (updated.ok) {
          state.schedule = updated.schedule;
          render();
        } else {
          els.profileError.textContent = describeFailure(updated, 'Could not update schedule.');
        }
      });
    }

    const updateScheduleTimes = async () => {
      const cur = state.schedule || { ...DEFAULT_SCHEDULE };
      const nextSched = {
        schema: 1,
        enabled: cur.enabled,
        dayProfileId: els.scheduleDayProfile.value || null,
        nightProfileId: els.scheduleNightProfile.value || null,
        dayTime: els.scheduleDayTime.value || DEFAULT_SCHEDULE.dayTime,
        nightTime: els.scheduleNightTime.value || DEFAULT_SCHEDULE.nightTime,
        manualOverrideUntil: cur.manualOverrideUntil,
        lastError: cur.lastError,
      };
      const val = validateSchedule(nextSched);
      if (val.ok) {
        const updated = await callWorkerOrDirect(
          messages.updateSchedule(val.schedule),
          async () => {
            await chrome.storage.local.set({ [STORAGE_KEYS.schedule]: val.schedule });
            return { ok: true, schedule: val.schedule };
          }
        );
        if (updated.ok) {
          state.schedule = updated.schedule;
        } else {
          els.profileError.textContent = describeFailure(updated, 'Could not update schedule.');
        }
      }
    };
    listen(els.scheduleDayTime, 'change', updateScheduleTimes);
    listen(els.scheduleNightTime, 'change', updateScheduleTimes);
    listen(els.scheduleDayProfile, 'change', updateScheduleTimes);
    listen(els.scheduleNightProfile, 'change', updateScheduleTimes);

    if (els.backupManageBtn) {
      listen(els.backupManageBtn, 'click', () => {
        els.backupPanel.hidden = !els.backupPanel.hidden;
        els.backupError.textContent = '';
        if (!els.backupPanel.hidden) els.backupExportBtn.focus();
      });
    }

    if (els.backupPanelClose) {
      listen(els.backupPanelClose, 'click', () => {
        els.backupPanel.hidden = true;
        els.backupError.textContent = '';
      });
    }

    if (els.backupExportBtn) {
      listen(els.backupExportBtn, 'click', async () => {
        try {
          const rawCustom = (await chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
          const customThemes = rawCustom?.items || (isPlainObject(rawCustom) ? rawCustom : {});
          const rawProfiles = (await chrome.storage.local.get(STORAGE_KEYS.profiles))[STORAGE_KEYS.profiles];
          const profiles = Array.isArray(rawProfiles) ? rawProfiles : (rawProfiles?.items || []);
          const rawSchedule = (await chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];

          const bundle = createBackupBundle({
            settings: state.settings,
            customThemes,
            profiles,
            schedule: rawSchedule || state.schedule,
          });
          const text = JSON.stringify(bundle, null, 2);

          if (win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
            await win.navigator.clipboard.writeText(text);
            notify('Backup copied to clipboard!', { kind: 'info' });
          } else {
            notify('Backup created!', { kind: 'info' });
          }
        } catch (err) {
          notify('Could not export backup: ' + err.message, { kind: 'error' });
        }
      });
    }

    if (els.backupImportFile) {
      listen(els.backupImportFile, 'change', () => {
        const file = els.backupImportFile.files && els.backupImportFile.files[0];
        if (!file) return;
        const reader = new win.FileReader();
        reader.onload = () => {
          els.backupImportJson.value = String(reader.result || '');
        };
        reader.readAsText(file);
      });
    }

    if (els.backupImportSubmit) {
      listen(els.backupImportSubmit, 'click', async () => {
        els.backupError.textContent = '';
        const text = (els.backupImportJson.value || '').trim();
        if (!text) {
          els.backupError.textContent = 'Paste backup JSON or choose a file first.';
          return;
        }
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          els.backupError.textContent = 'Enter valid JSON.';
          return;
        }
        const val = validateBackupBundle(parsed);
        if (!val.ok) {
          els.backupError.textContent = val.error;
          return;
        }
        try {
          const toStore = {};
          if (val.bundle.settings) toStore[STORAGE_KEYS.settings] = val.bundle.settings;
          if (val.bundle.customThemes && Object.keys(val.bundle.customThemes).length) {
            const envelope = { schema: 1, revision: (state.customThemesRevision || 1) + 1, items: val.bundle.customThemes };
            toStore[STORAGE_KEYS.customThemes] = envelope;
          }
          if (val.bundle.profiles && val.bundle.profiles.length) {
            const envelope = { schema: 1, revision: (state.profilesRevision || 1) + 1, items: val.bundle.profiles };
            toStore[STORAGE_KEYS.profiles] = envelope;
          }
          if (val.bundle.schedule) {
            toStore[STORAGE_KEYS.schedule] = val.bundle.schedule;
          }
          await chrome.storage.local.set(toStore);
          await reloadSettings();
          buildThemeCards();
          els.backupPanel.hidden = true;
          els.backupImportJson.value = '';
          notify('Backup restored successfully.', { kind: 'info' });
        } catch (err) {
          els.backupError.textContent = 'Could not restore backup: ' + err.message;
        }
      });
    }

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
    listen(els.densityUnlock, 'click', () => openProSheet('density', 'density'));

    const chooseHomeLayout = (btn, isTap = true) => commit({ layout: { home: btn.dataset.home } }, { isTap });
    listen(els.layoutHome, 'click', (event) => {
      const btn = event.target.closest('[role="radio"]');
      if (btn && els.layoutHome.contains(btn)) chooseHomeLayout(btn, event.detail > 0);
    });
    listen(els.layoutHome, 'keydown', onRadioKeydown(els.layoutHome, (btn) => {
      if (btn.getAttribute('aria-disabled') !== 'true') chooseHomeLayout(btn, false);
    }));

    const chooseWatchLayout = (btn, isTap = true) => commit({ layout: { watch: btn.dataset.watch } }, { isTap });
    listen(els.layoutWatch, 'click', (event) => {
      const btn = event.target.closest('[role="radio"]');
      if (btn && els.layoutWatch.contains(btn)) chooseWatchLayout(btn, event.detail > 0);
    });
    listen(els.layoutWatch, 'keydown', onRadioKeydown(els.layoutWatch, (btn) => {
      if (btn.getAttribute('aria-disabled') !== 'true') chooseWatchLayout(btn, false);
    }));

    listen(els.layoutReset, 'click', async () => {
      await commit({ layout: { home: null, watch: null } });
      els.layoutReset.focus();
    });
    listen(els.layoutUnlock, 'click', () => openProSheet('layout', 'layout'));

    const chooseScale = (btn) => commit({ textScale: Number(btn.dataset.scale) });
    listen(els.textScale, 'click', (event) => {
      const btn = event.target.closest('[role="radio"]');
      if (btn && els.textScale.contains(btn)) chooseScale(btn);
    });
    listen(els.textScale, 'keydown', onRadioKeydown(els.textScale, chooseScale));

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
      commit({ calm: { [key]: !(current && current.on) } }, { isTap: event.detail > 0 });
    });

    if (els.calmPresets) {
      listen(els.calmPresets, 'click', async (event) => {
        const btn = event.target.closest('[data-calm-preset]');
        if (!btn || !els.calmPresets.contains(btn)) return;
        const presetId = btn.dataset.calmPreset;
        const res = applyCalmPreset(presetId, state.settings?.calm || {}, state.licence);
        if (!res.ok) {
          notify(res.error, { kind: 'error' });
          return;
        }
        await commit({ calm: res.calm });
        notify(res.notice, { kind: res.proBlockedCount > 0 ? 'pro' : 'info', action: res.proBlockedCount > 0 });
      });
    }

    if (els.copyDiagnosticsBtn) {
      listen(els.copyDiagnosticsBtn, 'click', async () => {
        const diag = createDiagnostics({
          manifestVersion: (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '0.1.0',
          userAgent: (win.navigator && win.navigator.userAgent) || 'unknown',
          pageType: state.status?.summary?.pageType || 'unknown',
          settings: state.settings,
          schedule: state.schedule,
          licence: state.licence,
          selectorMapVersion: state.selectorMap?.version || 'bundled',
        });
        const text = JSON.stringify(diag, null, 2);
        try {
          if (win.navigator && win.navigator.clipboard && typeof win.navigator.clipboard.writeText === 'function') {
            await win.navigator.clipboard.writeText(text);
            notify('Diagnostics copied to clipboard.', { kind: 'info' });
          } else {
            notify('Could not copy diagnostics.', { kind: 'error' });
          }
        } catch {
          notify('Could not copy diagnostics.', { kind: 'error' });
        }
      });
    }

    listen(els.noticeAction, 'click', goToActivate);
    listen(els.noticeDismiss, 'click', clearNotice);

    listen(els.sheetCloseBtn, 'click', closeProSheet);
    listen(els.sheetBackdrop, 'click', closeProSheet);
    listen(els.sheetBuyBtn, 'click', () => openCheckout('sheet'));
    listen(els.trialBuyBtn, 'click', () => openCheckout('trial-banner'));
    if (els.proBuyLink) {
      listen(els.proBuyLink, 'click', (e) => {
        e.preventDefault();
        openCheckout('pro-card');
      });
    }
    if (els.day7DismissBtn) listen(els.day7DismissBtn, 'click', dismissDay7Card);
    if (els.day7DismissLink) listen(els.day7DismissLink, 'click', dismissDay7Card);
    if (els.day7BuyLink) {
      listen(els.day7BuyLink, 'click', (e) => {
        e.preventDefault();
        dismissDay7Card();
        openSupportUrl();
      });
    }
    if (els.supportLink) {
      listen(els.supportLink, 'click', (e) => {
        e.preventDefault();
        openSupportUrl();
      });
    }
    if (els.footerCoffeeLink) {
      listen(els.footerCoffeeLink, 'click', (e) => {
        e.preventDefault();
        openSupportUrl();
      });
    }
    listen(els.trialBannerDismiss, 'click', async () => {
      state.trialEnded = false;
      if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.remove === 'function') {
        try { await chrome.storage.session.remove('cd_trialEnded'); } catch {}
      }
      render();
    });
    listen(els.sheetTrialBtn, 'click', async () => {
      if (els.sheetTrialBtn.getAttribute('aria-disabled') === 'true') return;
      const res = await callWorkerOrDirect(
        { type: MSG.START_TRIAL },
        async () => {
          const nowMs = now();
          const check = canStartTrial(state.trialLog, nowMs, LIMITS.maxDailyTrials);
          if (!check.ok) return check;
          const trial = { until: nowMs + LIMITS.trialDurationMs, used: 1 };
          if (chrome.storage && chrome.storage.session && typeof chrome.storage.session.set === 'function') {
            await chrome.storage.session.set({ [STORAGE_KEYS.trial]: trial });
          }
          return { ok: true, trial };
        }
      );
      if (res && res.ok) {
        state.trial = res.trial;
        state.trialEnded = false;
        closeProSheet();
        ensureCountdown();
        render();
        notify('Pro preview active for 10 minutes!', { kind: 'info' });
      } else {
        const msg = res?.message || res?.reason || 'Could not start preview.';
        els.sheetLimitNote.hidden = false;
        els.sheetLimitNote.textContent = msg;
      }
    });

    listen(els.activateForm, 'submit', (event) => {
      event.preventDefault();
      if (els.activateBtn.getAttribute('aria-disabled') === 'true') return;
      track(activate(els.token.value, activateReport));
    });

    if (els.proActivatedDismiss) {
      listen(els.proActivatedDismiss, 'click', () => {
        if (els.proActivatedBanner) els.proActivatedBanner.hidden = true;
      });
    }

    // Changes made elsewhere (another popup, the editor, the background) show up here too.
    const onStorage = (changes, area) => {
      if (area === 'session') {
        if (changes[STORAGE_KEYS.trial]) {
          state.trial = changes[STORAGE_KEYS.trial].newValue ?? null;
          ensureCountdown();
          render();
        }
        if (changes.cd_trialEnded) {
          state.trialEnded = Boolean(changes.cd_trialEnded.newValue);
          render();
        }
        return;
      }
      if (area && area !== 'local') return;
      if (changes[STORAGE_KEYS.trialLog]) {
        state.trialLog = changes[STORAGE_KEYS.trialLog].newValue ?? null;
      }
      if (changes[SETTINGS_KEY]) {
        if (pending > 0) return;                       // our own writes: reloadSettings() settles when the queue drains
        state.settings = changes[SETTINGS_KEY].newValue ?? null;
        render();
      }
      if (changes[STORAGE_KEYS.licence]) track(loadLicence().then(render));
      if (changes[STORAGE_KEYS.customThemes]) {
        const norm = normalizeCustomThemes(changes[STORAGE_KEYS.customThemes].newValue);
        state.customThemes = norm.record ? norm.record.items : {};
        state.customThemesRevision = norm.record ? norm.record.revision : 1;
        buildThemeCards();
        render();
      }
      if (changes[STORAGE_KEYS.profiles]) {
        const norm = normalizeProfiles(changes[STORAGE_KEYS.profiles].newValue);
        state.profiles = norm.record ? norm.record.items : [];
        state.profilesRevision = norm.record ? norm.record.revision : 1;
        render();
      }
      if (changes[STORAGE_KEYS.schedule]) {
        state.schedule = changes[STORAGE_KEYS.schedule].newValue ?? null;
        render();
      }
      if (changes[STORAGE_KEYS.install]) {
        state.install = changes[STORAGE_KEYS.install].newValue ?? null;
        render();
      }
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
    // Reconnect the page independently of a sleeping background worker.
    const statusReady = loadStatus();
    await Promise.all([loadSettings(), loadLicence(), loadTrial()]);
    buildThemeCards();
    render();
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      mountDevStrip({ doc, host: els.devSlot, activate: (token, report) => track(activate(token, report)) });
    }
    await statusReady;
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
      return track(Promise.all([loadLicence(), loadStatus(), reloadSettings(), loadTrial()]).then(() => undefined));
    },
    destroy() {
      destroyed = true;
      stopCountdown();
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
