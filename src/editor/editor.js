// Cinedrape Visual Theme Editor (Spec F7).
// Runs in the editor extension tab (chrome-extension://<id>/editor/editor.html).
// Zero network calls, zero eval, zero remote scripts.

import {
  createDefaultTheme,
  updateThemeProperty,
  evaluateContrast,
  validateEditorTheme,
  computePreviewTokens,
  exportThemeToJson,
  slugifyThemeName,
  cloneTheme,
} from './editor-model.js';
import { STORAGE_KEYS, LIMITS, MSG, RESERVED_THEME_IDS, SUPPORT_URL } from '../shared/constants.js';
import { isReservedThemeId, normalizeCustomThemes } from '../shared/collections.js';
import { isPro } from '../shared/entitlements.js';
import { parseEnvelopePayload } from '../shared/selector-map.js';
import { SELECTOR_MAP_PUBLIC_KEY, LICENCE_PUBLIC_KEY } from '../shared/public-keys.js';
import { verifyEnvelope } from '../shared/signing.js';
import { validateCss, buildAllowList } from '../shared/css-validator.js';
import { licenceFromRecordVerified } from '../popup/model.js';
import { describeFailure, isWorkerReply, messages } from '../shared/messages.js';

import { THEMES } from '../themes/index.js';
import broadcastTheme from '../themes/broadcast.json' with { type: 'json' };
import bundledEnvelope from '../data/selector-map.signed.json' with { type: 'json' };

const TEMPLATES = Object.freeze({
  ...Object.fromEntries(THEMES.map((t) => [t.id, t])),
  broadcast: broadcastTheme,
});

export function initEditor(documentRef = document, windowRef = window) {
  const doc = documentRef;
  const win = windowRef;
  const chromeApi = win.chrome || (typeof chrome !== 'undefined' ? chrome : null);

  // DOM Elements
  const els = {
    nameInput: doc.getElementById('theme-name-input'),
    authorInput: doc.getElementById('theme-author-input'),
    templateSelect: doc.getElementById('template-select'),
    supportLink: doc.getElementById('editor-support-link'),
    btnExport: doc.getElementById('btn-export'),
    btnSave: doc.getElementById('btn-save'),
    btnApply: doc.getElementById('btn-apply'),
    notice: doc.getElementById('editor-notice'),

    // Colors
    bgPicker: doc.getElementById('color-bg-picker'),
    bgHex: doc.getElementById('color-bg-hex'),
    surfacePicker: doc.getElementById('color-surface-picker'),
    surfaceHex: doc.getElementById('color-surface-hex'),
    textPicker: doc.getElementById('color-text-picker'),
    textHex: doc.getElementById('color-text-hex'),
    mutedPicker: doc.getElementById('color-muted-picker'),
    mutedHex: doc.getElementById('color-muted-hex'),
    accentPicker: doc.getElementById('color-accent-picker'),
    accentHex: doc.getElementById('color-accent-hex'),
    borderPicker: doc.getElementById('color-border-picker'),
    borderHex: doc.getElementById('color-border-hex'),

    // Contrast
    contrastPill: doc.getElementById('contrast-pill'),
    contrastList: doc.getElementById('contrast-list'),

    // Typography & Shapes
    typeFamilySelect: doc.getElementById('type-family-select'),
    typeSizeSlider: doc.getElementById('type-size-slider'),
    typeSizeVal: doc.getElementById('type-size-val'),
    typeWeightSelect: doc.getElementById('type-weight-select'),
    shapeRadiusSlider: doc.getElementById('shape-radius-slider'),
    shapeRadiusVal: doc.getElementById('shape-radius-val'),
    shapeShadowToggle: doc.getElementById('shape-shadow-toggle'),
    shapeSpacingSlider: doc.getElementById('shape-spacing-slider'),
    shapeSpacingVal: doc.getElementById('shape-spacing-val'),

    // Layout & Calm
    layoutHomeSelect: doc.getElementById('layout-home-select'),
    layoutWatchSelect: doc.getElementById('layout-watch-select'),
    layoutDensitySlider: doc.getElementById('layout-density-slider'),
    layoutDensityVal: doc.getElementById('layout-density-val'),

    calmShorts: doc.getElementById('calm-hideshorts'),
    calmHomeRecs: doc.getElementById('calm-hidehomerecs'),
    calmComments: doc.getElementById('calm-hidecomments'),
    calmEndScreens: doc.getElementById('calm-hideendscreens'),
    calmViewCounts: doc.getElementById('calm-hideviewcounts'),
    calmLive: doc.getElementById('calm-hidelive'),

    // CSS
    cssInput: doc.getElementById('custom-css-input'),
    cssErrorBox: doc.getElementById('css-error-box'),

    // Preview
    stage: doc.getElementById('preview-stage'),
    canvas: doc.getElementById('preview-canvas'),
    viewHomeBtn: doc.getElementById('view-home-btn'),
    viewWatchBtn: doc.getElementById('view-watch-btn'),
    viewChannelBtn: doc.getElementById('view-channel-btn'),
    homeView: doc.getElementById('preview-home-view'),
    watchView: doc.getElementById('preview-watch-view'),
    channelView: doc.getElementById('preview-channel-view'),

    widthFullBtn: doc.getElementById('width-full-btn'),
    widthLaptopBtn: doc.getElementById('width-laptop-btn'),
    widthCompactBtn: doc.getElementById('width-compact-btn'),
  };

  if (els.supportLink) els.supportLink.href = SUPPORT_URL;

  let currentTheme = createDefaultTheme();
  let originalTheme = JSON.parse(JSON.stringify(currentTheme));
  let isDirty = false;
  let draftSaveTimer = null;
  let savedCustomThemes = {};

  // Undo / Redo stacks
  const undoStack = [];
  const redoStack = [];
  const MAX_HISTORY = 50;

  function pushHistory(themeSnapshot) {
    if (undoStack.length >= MAX_HISTORY) undoStack.shift();
    undoStack.push(JSON.parse(JSON.stringify(themeSnapshot)));
    redoStack.length = 0;
  }

  // Active verified selector map
  let activeSelectorMap = parseEnvelopePayload(bundledEnvelope);

  async function loadVerifiedMap() {
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return;
    try {
      const stored = await chromeApi.storage.local.get(STORAGE_KEYS.selectorMap);
      const cachedEnv = stored && stored[STORAGE_KEYS.selectorMap];
      if (cachedEnv) {
        const v = await verifyEnvelope(cachedEnv, SELECTOR_MAP_PUBLIC_KEY);
        if (v.ok) {
          const map = parseEnvelopePayload(cachedEnv);
          if (map) activeSelectorMap = map;
        }
      }
    } catch { /* use bundled map */ }
  }

  async function getLicenceState() {
    if (!chromeApi) return { plan: 'free', status: 'none' };
    if (chromeApi.runtime && chromeApi.runtime.sendMessage) {
      try {
        const resp = await chromeApi.runtime.sendMessage({ type: MSG.GET_LICENCE });
        if (resp && resp.ok) {
          return resp.licence || resp.state || { plan: 'free', status: 'none' };
        }
      } catch { /* worker not running */ }
    }
    if (chromeApi.storage && chromeApi.storage.local) {
      try {
        const stored = await chromeApi.storage.local.get(STORAGE_KEYS.licence);
        const record = stored && stored[STORAGE_KEYS.licence];
        if (record) {
          const state = await licenceFromRecordVerified(record, Date.now(), LICENCE_PUBLIC_KEY);
          return state;
        }
      } catch { /* ignore */ }
    }
    return { plan: 'free', status: 'none' };
  }

  async function checkProEntitlement() {
    // In Cinedrape free-with-support, custom themes are 100% free to create and save for everyone.
    return true;
  }

  function showNotice(message, kind = 'info') {
    if (!els.notice) return;
    els.notice.textContent = message;
    els.notice.className = `editor-notice ${kind}`;
    els.notice.classList.remove('hidden');
    win.clearTimeout(els.notice._timer);
    els.notice._timer = win.setTimeout(() => {
      els.notice.classList.add('hidden');
    }, 5000);
  }

  function syncPreviewTokens() {
    if (!els.canvas) return;
    const tokens = computePreviewTokens(currentTheme);
    for (const [key, value] of Object.entries(tokens)) {
      els.canvas.style.setProperty(key, value);
    }
    // Update theme attributes on canvas
    els.canvas.setAttribute('cd-home', currentTheme.layout?.home || 'hero-rows');
    els.canvas.setAttribute('cd-watch', currentTheme.layout?.watch || 'cinema');
    els.canvas.setAttribute('cd-density', String(currentTheme.layout?.density || 3));

    // Update calm attributes on canvas
    els.canvas.setAttribute('cd-calm-hideshorts', currentTheme.calm?.hideShorts ? 'true' : 'false');
    els.canvas.setAttribute('cd-calm-hidehomerecs', currentTheme.calm?.hideHomeRecs ? 'true' : 'false');
    els.canvas.setAttribute('cd-calm-hidecomments', currentTheme.calm?.hideComments ? 'true' : 'false');
    els.canvas.setAttribute('cd-calm-hideendscreens', currentTheme.calm?.hideEndScreens ? 'true' : 'false');
    els.canvas.setAttribute('cd-calm-hideviewcounts', currentTheme.calm?.hideViewCounts ? 'true' : 'false');
    els.canvas.setAttribute('cd-calm-hidelive', currentTheme.calm?.hideLive ? 'true' : 'false');

    // Custom CSS preview
    let styleEl = doc.getElementById('preview-custom-css');
    if (!styleEl) {
      styleEl = doc.createElement('style');
      styleEl.id = 'preview-custom-css';
      if (els.canvas.parentNode) {
        els.canvas.parentNode.insertBefore(styleEl, els.canvas);
      } else if (doc.head) {
        doc.head.appendChild(styleEl);
      }
    }

    if (currentTheme.css && currentTheme.css.trim()) {
      if (activeSelectorMap) {
        const allowList = buildAllowList(activeSelectorMap);
        const protectedSelectors = [
          ...(activeSelectorMap.protected?.ads || []),
          ...(activeSelectorMap.protected?.sponsor || []),
          ...(activeSelectorMap.protected?.playerControls || []),
        ];
        const v = validateCss(currentTheme.css, { allowList, protectedSelectors });
        if (v.ok) {
          styleEl.textContent = currentTheme.css;
          if (els.cssErrorBox) els.cssErrorBox.classList.add('hidden');
        } else {
          styleEl.textContent = '';
        }
      } else {
        styleEl.textContent = '';
      }
    } else {
      styleEl.textContent = '';
    }
  }

  function syncContrast() {
    if (!els.contrastList || !els.contrastPill) return;
    const evalRes = evaluateContrast(currentTheme);
    els.contrastPill.textContent = `${evalRes.passCount}/${evalRes.totalCount} AA`;
    els.contrastPill.className = `badge ${evalRes.passed ? 'badge-success' : 'badge-danger'}`;

    const items = evalRes.pairs.map((p) => {
      const li = doc.createElement('li');
      li.className = 'contrast-item';
      const label = doc.createElement('span');
      label.textContent = p.pair.replace('/', ' on ');
      const badge = doc.createElement('span');
      badge.className = `contrast-badge ${p.pass ? 'pass' : 'fail'}`;
      badge.textContent = `${p.ratio ? p.ratio.toFixed(2) : 'fail'}:1 (min ${p.required}:1)`;
      li.appendChild(label);
      li.appendChild(badge);
      return li;
    });
    els.contrastList.replaceChildren(...items);
  }

  function syncControlsFromModel() {
    if (els.nameInput) els.nameInput.value = currentTheme.name || '';
    if (els.authorInput) els.authorInput.value = currentTheme.author || '';

    // Colors
    const col = currentTheme.tokens?.color || {};
    const syncColor = (picker, hexInput, val, fallback) => {
      const c = val || fallback;
      if (picker) picker.value = c;
      if (hexInput) {
        hexInput.value = c;
        hexInput.classList.remove('invalid');
        hexInput.removeAttribute('aria-invalid');
      }
    };
    syncColor(els.bgPicker, els.bgHex, col.bg, '#111216');
    syncColor(els.surfacePicker, els.surfaceHex, col.surface, '#1b1d22');
    syncColor(els.textPicker, els.textHex, col.text, '#f2f2f5');
    syncColor(els.mutedPicker, els.mutedHex, col.muted, '#a3a3b2');
    syncColor(els.accentPicker, els.accentHex, col.accent, '#e8b04a');
    syncColor(els.borderPicker, els.borderHex, col.border, '#656572');

    // Type & Shape
    const typ = currentTheme.tokens?.type || {};
    if (els.typeFamilySelect) els.typeFamilySelect.value = typ.family || 'System';
    if (els.typeSizeSlider) els.typeSizeSlider.value = String(typ.baseSize || 14);
    if (els.typeSizeVal) els.typeSizeVal.textContent = `${typ.baseSize || 14} px`;
    if (els.typeWeightSelect) els.typeWeightSelect.value = String(typ.headingWeight || 700);

    const shp = currentTheme.tokens?.shape || {};
    if (els.shapeRadiusSlider) els.shapeRadiusSlider.value = String(shp.radius ?? 10);
    if (els.shapeRadiusVal) els.shapeRadiusVal.textContent = `${shp.radius ?? 10} px`;
    if (els.shapeShadowToggle) els.shapeShadowToggle.checked = Boolean(shp.shadow);
    if (els.shapeSpacingSlider) els.shapeSpacingSlider.value = String(shp.spacing || 3);
    if (els.shapeSpacingVal) els.shapeSpacingVal.textContent = `Level ${shp.spacing || 3}`;

    // Layout
    const lay = currentTheme.layout || {};
    if (els.layoutHomeSelect) els.layoutHomeSelect.value = lay.home || 'hero-rows';
    if (els.layoutWatchSelect) els.layoutWatchSelect.value = lay.watch || 'cinema';
    if (els.layoutDensitySlider) els.layoutDensitySlider.value = String(lay.density || 3);
    if (els.layoutDensityVal) els.layoutDensityVal.textContent = `Balanced (${lay.density || 3})`;

    // Calm
    const clm = currentTheme.calm || {};
    if (els.calmShorts) els.calmShorts.checked = Boolean(clm.hideShorts);
    if (els.calmHomeRecs) els.calmHomeRecs.checked = Boolean(clm.hideHomeRecs);
    if (els.calmComments) els.calmComments.checked = Boolean(clm.hideComments);
    if (els.calmEndScreens) els.calmEndScreens.checked = Boolean(clm.hideEndScreens);
    if (els.calmViewCounts) els.calmViewCounts.checked = Boolean(clm.hideViewCounts);
    if (els.calmLive) els.calmLive.checked = Boolean(clm.hideLive);

    // CSS
    if (els.cssInput) els.cssInput.value = currentTheme.css || '';
  }

  function queueDraftSave() {
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return;
    win.clearTimeout(draftSaveTimer);
    draftSaveTimer = win.setTimeout(async () => {
      try {
        await chromeApi.storage.local.set({
          [STORAGE_KEYS.draft]: {
            theme: currentTheme,
            savedAt: Date.now(),
          },
        });
      } catch { /* ignore draft write failure */ }
    }, 500);
  }

  function handleFieldChange(path, value) {
    pushHistory(currentTheme);
    isDirty = true;
    currentTheme = updateThemeProperty(currentTheme, path, value);
    syncPreviewTokens();
    syncContrast();
    queueDraftSave();
  }

  // Bind Color Inputs
  function bindColorPair(picker, hexInput, path) {
    if (!picker || !hexInput) return;
    picker.addEventListener('input', () => {
      hexInput.value = picker.value;
      hexInput.classList.remove('invalid');
      hexInput.removeAttribute('aria-invalid');
      handleFieldChange(path, picker.value);
    });
    const onHexChange = () => {
      let val = hexInput.value.trim();
      if (!val.startsWith('#')) val = `#${val}`;
      if (/^#[0-9a-fA-F]{6}$/.test(val)) {
        hexInput.classList.remove('invalid');
        hexInput.removeAttribute('aria-invalid');
        picker.value = val;
        handleFieldChange(path, val);
      } else {
        hexInput.classList.add('invalid');
        hexInput.setAttribute('aria-invalid', 'true');
      }
    };
    hexInput.addEventListener('input', onHexChange);
    hexInput.addEventListener('change', onHexChange);
  }

  bindColorPair(els.bgPicker, els.bgHex, 'tokens.color.bg');
  bindColorPair(els.surfacePicker, els.surfaceHex, 'tokens.color.surface');
  bindColorPair(els.textPicker, els.textHex, 'tokens.color.text');
  bindColorPair(els.mutedPicker, els.mutedHex, 'tokens.color.muted');
  bindColorPair(els.accentPicker, els.accentHex, 'tokens.color.accent');
  bindColorPair(els.borderPicker, els.borderHex, 'tokens.color.border');

  // Bind Metadata
  if (els.nameInput) {
    els.nameInput.addEventListener('input', () => {
      handleFieldChange('name', els.nameInput.value);
    });
  }
  if (els.authorInput) {
    els.authorInput.addEventListener('input', () => {
      handleFieldChange('author', els.authorInput.value);
    });
  }

  // Bind Typography & Shapes
  if (els.typeFamilySelect) {
    els.typeFamilySelect.addEventListener('change', () => {
      handleFieldChange('tokens.type.family', els.typeFamilySelect.value);
    });
  }
  if (els.typeSizeSlider) {
    els.typeSizeSlider.addEventListener('input', () => {
      const val = Number(els.typeSizeSlider.value);
      if (els.typeSizeVal) els.typeSizeVal.textContent = `${val} px`;
      handleFieldChange('tokens.type.baseSize', val);
    });
  }
  if (els.typeWeightSelect) {
    els.typeWeightSelect.addEventListener('change', () => {
      handleFieldChange('tokens.type.headingWeight', Number(els.typeWeightSelect.value));
    });
  }
  if (els.shapeRadiusSlider) {
    els.shapeRadiusSlider.addEventListener('input', () => {
      const val = Number(els.shapeRadiusSlider.value);
      if (els.shapeRadiusVal) els.shapeRadiusVal.textContent = `${val} px`;
      handleFieldChange('tokens.shape.radius', val);
    });
  }
  if (els.shapeShadowToggle) {
    els.shapeShadowToggle.addEventListener('change', () => {
      handleFieldChange('tokens.shape.shadow', els.shapeShadowToggle.checked);
    });
  }
  if (els.shapeSpacingSlider) {
    els.shapeSpacingSlider.addEventListener('input', () => {
      const val = Number(els.shapeSpacingSlider.value);
      if (els.shapeSpacingVal) els.shapeSpacingVal.textContent = `Level ${val}`;
      handleFieldChange('tokens.shape.spacing', val);
    });
  }

  // Bind Layout & Calm
  if (els.layoutHomeSelect) {
    els.layoutHomeSelect.addEventListener('change', () => {
      handleFieldChange('layout.home', els.layoutHomeSelect.value);
    });
  }
  if (els.layoutWatchSelect) {
    els.layoutWatchSelect.addEventListener('change', () => {
      handleFieldChange('layout.watch', els.layoutWatchSelect.value);
    });
  }
  if (els.layoutDensitySlider) {
    els.layoutDensitySlider.addEventListener('input', () => {
      const val = Number(els.layoutDensitySlider.value);
      const labels = ['Extra Compact (1)', 'Compact (2)', 'Balanced (3)', 'Roomy (4)', 'Spacious (5)'];
      if (els.layoutDensityVal) els.layoutDensityVal.textContent = labels[val - 1] || String(val);
      handleFieldChange('layout.density', val);
    });
  }

  const bindCalmCheck = (chk, key) => {
    if (!chk) return;
    chk.addEventListener('change', () => {
      handleFieldChange(`calm.${key}`, chk.checked);
    });
  };
  bindCalmCheck(els.calmShorts, 'hideShorts');
  bindCalmCheck(els.calmHomeRecs, 'hideHomeRecs');
  bindCalmCheck(els.calmComments, 'hideComments');
  bindCalmCheck(els.calmEndScreens, 'hideEndScreens');
  bindCalmCheck(els.calmViewCounts, 'hideViewCounts');
  bindCalmCheck(els.calmLive, 'hideLive');

  // Bind Custom CSS
  if (els.cssInput) {
    els.cssInput.addEventListener('input', () => {
      const cssVal = els.cssInput.value;
      if (cssVal.trim() && activeSelectorMap) {
        const allowList = buildAllowList(activeSelectorMap);
        const protectedSelectors = [
          ...(activeSelectorMap.protected?.ads || []),
          ...(activeSelectorMap.protected?.sponsor || []),
          ...(activeSelectorMap.protected?.playerControls || []),
        ];
        const v = validateCss(cssVal, { allowList, protectedSelectors });
        if (!v.ok && els.cssErrorBox) {
          const firstErr = v.errors && v.errors[0];
          const lineCol = (firstErr && firstErr.line) ? ` (line ${firstErr.line}, col ${firstErr.column})` : '';
          els.cssErrorBox.textContent = firstErr ? `${firstErr.message}${lineCol}` : 'CSS syntax error.';
          els.cssErrorBox.classList.remove('hidden');
        } else if (els.cssErrorBox) {
          els.cssErrorBox.classList.add('hidden');
          els.cssErrorBox.textContent = '';
        }
      } else if (els.cssErrorBox) {
        els.cssErrorBox.classList.add('hidden');
        els.cssErrorBox.textContent = '';
      }
      handleFieldChange('css', cssVal);
    });
  }

  // Saved Themes & Templates Loader
  async function loadSavedThemes() {
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) return;
    try {
      const stored = await chromeApi.storage.local.get(STORAGE_KEYS.customThemes);
      const raw = stored && stored[STORAGE_KEYS.customThemes];
      const norm = normalizeCustomThemes(raw);
      savedCustomThemes = norm.record ? norm.record.items : {};

      if (!els.templateSelect) return;
      const existingOptGroup = els.templateSelect.querySelector('optgroup[data-custom="true"]');
      if (existingOptGroup) existingOptGroup.remove();

      const themeKeys = Object.keys(savedCustomThemes);
      if (themeKeys.length > 0) {
        const optgroup = doc.createElement('optgroup');
        optgroup.label = 'Saved Custom Themes';
        optgroup.setAttribute('data-custom', 'true');
        for (const tid of themeKeys) {
          const opt = doc.createElement('option');
          opt.value = `custom:${tid}`;
          opt.textContent = `${savedCustomThemes[tid].name || tid} (Saved)`;
          optgroup.appendChild(opt);
        }
        els.templateSelect.appendChild(optgroup);
      }
    } catch { /* ignore */ }
  }

  if (els.templateSelect) {
    els.templateSelect.addEventListener('change', () => {
      const val = els.templateSelect.value;
      if (!val) return;
      if (val.startsWith('custom:')) {
        const tid = val.slice(7);
        const saved = savedCustomThemes[tid];
        if (saved) {
          pushHistory(currentTheme);
          currentTheme = JSON.parse(JSON.stringify(saved));
          currentTheme._isExisting = true;
          originalTheme = JSON.parse(JSON.stringify(currentTheme));
          isDirty = false;
          syncControlsFromModel();
          syncPreviewTokens();
          syncContrast();
          showNotice(`Loaded saved theme "${currentTheme.name}".`, 'info');
        }
      } else if (TEMPLATES[val]) {
        pushHistory(currentTheme);
        currentTheme = JSON.parse(JSON.stringify(TEMPLATES[val]));
        currentTheme.id = slugifyThemeName(`${val}-copy`);
        currentTheme.name = `${TEMPLATES[val].name} (Custom)`;
        currentTheme._isExisting = false;
        originalTheme = JSON.parse(JSON.stringify(currentTheme));
        isDirty = false;
        syncControlsFromModel();
        syncPreviewTokens();
        syncContrast();
        showNotice(`Loaded "${TEMPLATES[val].name}" template.`, 'info');
      }
    });
  }

  // View Switchers (Home Feed, Watch Page, Channel New UI)
  function switchView(viewName) {
    const isHome = viewName === 'home';
    const isWatch = viewName === 'watch';
    const isChannel = viewName === 'channel';

    if (els.homeView) els.homeView.classList.toggle('hidden', !isHome);
    if (els.watchView) els.watchView.classList.toggle('hidden', !isWatch);
    if (els.channelView) els.channelView.classList.toggle('hidden', !isChannel);

    if (els.viewHomeBtn) {
      els.viewHomeBtn.classList.toggle('active', isHome);
      els.viewHomeBtn.setAttribute('aria-checked', String(isHome));
      els.viewHomeBtn.setAttribute('tabindex', isHome ? '0' : '-1');
    }
    if (els.viewWatchBtn) {
      els.viewWatchBtn.classList.toggle('active', isWatch);
      els.viewWatchBtn.setAttribute('aria-checked', String(isWatch));
      els.viewWatchBtn.setAttribute('tabindex', isWatch ? '0' : '-1');
    }
    if (els.viewChannelBtn) {
      els.viewChannelBtn.classList.toggle('active', isChannel);
      els.viewChannelBtn.setAttribute('aria-checked', String(isChannel));
      els.viewChannelBtn.setAttribute('tabindex', isChannel ? '0' : '-1');
    }
  }

  if (els.viewHomeBtn) els.viewHomeBtn.addEventListener('click', () => switchView('home'));
  if (els.viewWatchBtn) els.viewWatchBtn.addEventListener('click', () => switchView('watch'));
  if (els.viewChannelBtn) els.viewChannelBtn.addEventListener('click', () => switchView('channel'));

  // Roving tab stop for view switchers
  const viewBtns = [els.viewHomeBtn, els.viewWatchBtn, els.viewChannelBtn].filter(Boolean);
  const viewNames = ['home', 'watch', 'channel'];
  viewBtns.forEach((btn, idx) => {
    btn.addEventListener('keydown', (e) => {
      let targetIdx = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        targetIdx = (idx + 1) % viewBtns.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        targetIdx = (idx - 1 + viewBtns.length) % viewBtns.length;
      } else if (e.key === 'Home') {
        targetIdx = 0;
      } else if (e.key === 'End') {
        targetIdx = viewBtns.length - 1;
      }
      if (targetIdx !== -1) {
        e.preventDefault();
        viewBtns[targetIdx].focus();
        switchView(viewNames[targetIdx]);
      }
    });
  });

  // Width Switchers (Desktop, Laptop, Compact)
  function switchWidth(widthClass) {
    if (!els.stage) return;
    els.stage.classList.remove('width-laptop', 'width-compact');
    if (widthClass) els.stage.classList.add(widthClass);

    const isFull = !widthClass;
    const isLaptop = widthClass === 'width-laptop';
    const isCompact = widthClass === 'width-compact';

    if (els.widthFullBtn) {
      els.widthFullBtn.classList.toggle('active', isFull);
      els.widthFullBtn.setAttribute('aria-checked', String(isFull));
      els.widthFullBtn.setAttribute('tabindex', isFull ? '0' : '-1');
    }
    if (els.widthLaptopBtn) {
      els.widthLaptopBtn.classList.toggle('active', isLaptop);
      els.widthLaptopBtn.setAttribute('aria-checked', String(isLaptop));
      els.widthLaptopBtn.setAttribute('tabindex', isLaptop ? '0' : '-1');
    }
    if (els.widthCompactBtn) {
      els.widthCompactBtn.classList.toggle('active', isCompact);
      els.widthCompactBtn.setAttribute('aria-checked', String(isCompact));
      els.widthCompactBtn.setAttribute('tabindex', isCompact ? '0' : '-1');
    }
  }

  if (els.widthFullBtn) els.widthFullBtn.addEventListener('click', () => switchWidth(null));
  if (els.widthLaptopBtn) els.widthLaptopBtn.addEventListener('click', () => switchWidth('width-laptop'));
  if (els.widthCompactBtn) els.widthCompactBtn.addEventListener('click', () => switchWidth('width-compact'));

  // Roving tab stop for width buttons
  const widthBtns = [els.widthFullBtn, els.widthLaptopBtn, els.widthCompactBtn].filter(Boolean);
  const widthVals = [null, 'width-laptop', 'width-compact'];
  widthBtns.forEach((btn, idx) => {
    btn.addEventListener('keydown', (e) => {
      let targetIdx = -1;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
        targetIdx = (idx + 1) % widthBtns.length;
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
        targetIdx = (idx - 1 + widthBtns.length) % widthBtns.length;
      } else if (e.key === 'Home') {
        targetIdx = 0;
      } else if (e.key === 'End') {
        targetIdx = widthBtns.length - 1;
      }
      if (targetIdx !== -1) {
        e.preventDefault();
        widthBtns[targetIdx].focus();
        switchWidth(widthVals[targetIdx]);
      }
    });
  });

  // Undo / Redo keyboard shortcuts
  doc.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
      if (undoStack.length > 0) {
        e.preventDefault();
        redoStack.push(JSON.parse(JSON.stringify(currentTheme)));
        currentTheme = undoStack.pop();
        syncControlsFromModel();
        syncPreviewTokens();
        syncContrast();
      }
    } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || (e.key === 'z' && e.shiftKey))) {
      if (redoStack.length > 0) {
        e.preventDefault();
        undoStack.push(JSON.parse(JSON.stringify(currentTheme)));
        currentTheme = redoStack.pop();
        syncControlsFromModel();
        syncPreviewTokens();
        syncContrast();
      }
    }
  });

  // Export JSON Action
  if (els.btnExport) {
    els.btnExport.addEventListener('click', () => {
      const json = exportThemeToJson(currentTheme);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = doc.createElement('a');
      a.href = url;
      a.download = `${currentTheme.id || 'theme'}.json`;
      doc.body.appendChild(a);
      a.click();
      doc.body.removeChild(a);
      URL.revokeObjectURL(url);
      showNotice(`Exported ${currentTheme.name} as JSON.`, 'success');
    });
  }

  // Save Theme Action
  async function saveTheme(andApply = false) {
    // 1. Check for invalid hex inputs
    const hexInputs = [els.bgHex, els.surfaceHex, els.textHex, els.mutedHex, els.accentHex, els.borderHex].filter(Boolean);
    const invalidHex = hexInputs.find((el) => el.classList.contains('invalid') || el.getAttribute('aria-invalid') === 'true');
    if (invalidHex) {
      showNotice('Cannot save: Please fix invalid hex color codes.', 'error');
      invalidHex.focus();
      return false;
    }

    // 2. Check storage availability (Defect B / A03)
    if (!chromeApi || !chromeApi.storage || !chromeApi.storage.local) {
      showNotice('Cannot save: Storage is unavailable in this environment.', 'error');
      return false;
    }

    // 3. Check Pro entitlement (Defect B / A03)
    const pro = await checkProEntitlement();
    if (!pro) {
      showNotice('Custom themes can be saved with Cinedrape Pro. You can still preview and export as JSON.', 'error');
      return false;
    }

    // 4. Check reserved theme ID (Defect C / A04)
    if (isReservedThemeId(currentTheme.id)) {
      showNotice('Cannot save: Theme ID is reserved for bundled themes.', 'error');
      return false;
    }

    // 5. Check size limit
    if (JSON.stringify(currentTheme).length > LIMITS.maxCustomThemeBytes) {
      showNotice('Cannot save: Theme exceeds maximum allowed size (64 KiB).', 'error');
      return false;
    }

    // 6. Validation with selector map (Defect D / A05)
    const val = validateEditorTheme(currentTheme, { selectorMap: activeSelectorMap });
    if (!val.ok) {
      const cssErrors = val.errors.filter((e) => e.path === 'css');
      if (cssErrors.length > 0 && els.cssErrorBox) {
        els.cssErrorBox.textContent = cssErrors.map((e) => e.message).join('\n');
        els.cssErrorBox.classList.remove('hidden');
        if (els.cssInput) els.cssInput.focus();
      }
      const firstErr = val.errors[0]?.message || 'Validation error';
      showNotice(`Cannot save: ${firstErr}`, 'error');
      return false;
    }

    if (els.cssErrorBox) {
      els.cssErrorBox.classList.add('hidden');
      els.cssErrorBox.textContent = '';
    }

    try {
      const stored = await chromeApi.storage.local.get([
        STORAGE_KEYS.customThemes,
        STORAGE_KEYS.settings,
      ]);
      const norm = normalizeCustomThemes(stored && stored[STORAGE_KEYS.customThemes]);
      const customThemes = norm.record ? norm.record.items : {};
      const count = Object.keys(customThemes).length;
      if (!customThemes[val.theme.id] && count >= LIMITS.maxCustomThemes) {
        showNotice(`Custom themes limit reached (${LIMITS.maxCustomThemes} themes max). Delete one before saving.`, 'error');
        return false;
      }

      // Try worker mutation handler first
      let workerSaved = false;
      const isExisting = Boolean(currentTheme._isExisting || customThemes[val.theme.id]);
      if (chromeApi.runtime && chromeApi.runtime.sendMessage) {
        try {
          const resp = await chromeApi.runtime.sendMessage(
            messages.saveTheme(val.theme, {
              mode: isExisting ? 'update' : 'create',
              expectedRevision: norm.record ? norm.record.revision : undefined,
              apply: andApply,
            })
          );
          if (isWorkerReply(resp)) {
            if (resp.ok) {
              workerSaved = true;
            } else {
              showNotice(`Cannot save: ${describeFailure(resp)}`, 'error');
              return false;
            }
          }
        } catch { /* worker offline or busy */ }
      }

      if (!workerSaved) {
        // Direct storage write with canonical envelope (fallback when worker is offline)
        customThemes[val.theme.id] = val.theme;
        const env = {
          schema: 1,
          revision: (norm.record ? norm.record.revision || 0 : 0) + 1,
          items: customThemes,
        };
        await chromeApi.storage.local.set({ [STORAGE_KEYS.customThemes]: env });
        if (andApply) {
          const settings = (stored && stored[STORAGE_KEYS.settings]) || {};
          await chromeApi.storage.local.set({
            [STORAGE_KEYS.settings]: { ...settings, themeId: val.theme.id },
          });
        }
      }

      // Clear draft on successful save
      try {
        await chromeApi.storage.local.remove(STORAGE_KEYS.draft);
      } catch { /* ignore */ }

      currentTheme._isExisting = true;
      originalTheme = JSON.parse(JSON.stringify(currentTheme));
      isDirty = false;
      await loadSavedThemes();

      showNotice(
        andApply
          ? 'Saved and selected; open/reload YouTube to see it.'
          : `Theme "${val.theme.name}" saved successfully.`,
        'success'
      );
      return true;
    } catch (err) {
      showNotice(`Failed to save: ${err && err.message}`, 'error');
      return false;
    }
  }

  if (els.btnSave) {
    els.btnSave.addEventListener('click', () => saveTheme(false));
  }
  if (els.btnApply) {
    els.btnApply.addEventListener('click', () => saveTheme(true));
  }

  // Restore initial theme (URL query param or draft)
  async function loadInitialTheme() {
    await loadVerifiedMap();
    await loadSavedThemes();

    let loaded = false;
    if (win.location && win.location.search) {
      try {
        const params = new URLSearchParams(win.location.search);
        const themeId = params.get('themeId');
        if (themeId && savedCustomThemes[themeId]) {
          currentTheme = JSON.parse(JSON.stringify(savedCustomThemes[themeId]));
          currentTheme._isExisting = true;
          originalTheme = JSON.parse(JSON.stringify(currentTheme));
          isDirty = false;
          loaded = true;
        }
      } catch { /* ignore search param error */ }
    }

    if (!loaded && chromeApi && chromeApi.storage && chromeApi.storage.local) {
      try {
        const stored = await chromeApi.storage.local.get(STORAGE_KEYS.draft);
        const draft = stored && stored[STORAGE_KEYS.draft];
        if (draft && draft.theme && typeof draft.theme === 'object') {
          currentTheme = draft.theme;
          originalTheme = JSON.parse(JSON.stringify(currentTheme));
          isDirty = true;
          showNotice('Restored unsaved draft.', 'info');
        }
      } catch { /* ignore draft restore error */ }
    }

    syncControlsFromModel();
    syncPreviewTokens();
    syncContrast();
  }

  // Initial Sync & Async Load
  syncControlsFromModel();
  syncPreviewTokens();
  syncContrast();
  loadInitialTheme();

  return {
    getCurrentTheme: () => currentTheme,
    setTheme: (t) => {
      currentTheme = t;
      syncControlsFromModel();
      syncPreviewTokens();
      syncContrast();
    },
    saveTheme,
    loadInitialTheme,
  };
}

// Auto-run when executed in browser
if (typeof document !== 'undefined') {
  initEditor();
}
