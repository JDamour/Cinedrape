import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';

import { initEditor } from '../../src/editor/editor.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const HTML_SOURCE = readFileSync(join(process.cwd(), 'src/editor/editor.html'), 'utf8');

function setupDom(options = {}) {
  const dom = new JSDOM(HTML_SOURCE, {
    url: options.url || 'chrome-extension://cinedrape-test/editor/editor.html',
    runScripts: 'outside-only',
  });
  const doc = dom.window.document;
  const win = dom.window;

  // Mock chrome storage and runtime
  const storageData = { ...options.initialStorage };
  if (!options.noStorage) {
    win.chrome = {
      runtime: {
        sendMessage: async (msg) => {
          if (options.sendMessage) return options.sendMessage(msg);
          if (msg && msg.type === 'cd:getLicence') {
            return {
              ok: true,
              licence: {
                plan: options.isPro === false ? 'free' : 'pro',
                status: options.isPro === false ? 'none' : 'active',
              },
            };
          }
          return { ok: false };
        },
      },
      storage: {
        local: {
          get: async (keys) => {
            if (Array.isArray(keys)) {
              const res = {};
              for (const k of keys) res[k] = storageData[k];
              return res;
            }
            if (typeof keys === 'string') return { [keys]: storageData[keys] };
            return { ...storageData };
          },
          set: async (items) => {
            Object.assign(storageData, items);
          },
          remove: async (keys) => {
            const arr = Array.isArray(keys) ? keys : [keys];
            for (const k of arr) delete storageData[k];
          },
        },
      },
    };
  } else {
    win.chrome = undefined;
  }

  const editor = initEditor(doc, win);
  return { dom, doc, win, editor, storageData };
}

test('editor DOM initializes with starter theme and preview variables', () => {
  const { doc, editor } = setupDom();
  const theme = editor.getCurrentTheme();

  assert.equal(doc.getElementById('theme-name-input').value, 'My Custom Theme');
  assert.equal(doc.getElementById('color-bg-hex').value, '#111216');
  assert.equal(doc.getElementById('type-size-slider').value, '14');

  const canvas = doc.getElementById('preview-canvas');
  assert.equal(canvas.style.getPropertyValue('--cd-bg'), '#111216');
  assert.equal(canvas.style.getPropertyValue('--cd-accent'), '#e8b04a');
  assert.equal(canvas.style.getPropertyValue('--cd-radius'), '10px');

  const contrastPill = doc.getElementById('contrast-pill');
  assert.equal(contrastPill.textContent, '6/6 AA');
  assert.ok(contrastPill.classList.contains('badge-success'));
});

test('changing color inputs reacts live on preview canvas and contrast matrix', () => {
  const { doc } = setupDom();
  const canvas = doc.getElementById('preview-canvas');
  const bgPicker = doc.getElementById('color-bg-picker');
  const bgHex = doc.getElementById('color-bg-hex');

  // Change bg
  bgPicker.value = '#0a0a0f';
  bgPicker.dispatchEvent(new doc.defaultView.Event('input'));

  assert.equal(bgHex.value, '#0a0a0f');
  assert.equal(canvas.style.getPropertyValue('--cd-bg'), '#0a0a0f');

  // Change accent via hex input
  const accentHex = doc.getElementById('color-accent-hex');
  accentHex.value = '#3ea6ff';
  accentHex.dispatchEvent(new doc.defaultView.Event('change'));

  assert.equal(canvas.style.getPropertyValue('--cd-accent'), '#3ea6ff');
});

test('typography and shape slider changes update preview styles', () => {
  const { doc } = setupDom();
  const canvas = doc.getElementById('preview-canvas');
  const radiusSlider = doc.getElementById('shape-radius-slider');
  const radiusVal = doc.getElementById('shape-radius-val');

  radiusSlider.value = '18';
  radiusSlider.dispatchEvent(new doc.defaultView.Event('input'));

  assert.equal(radiusVal.textContent, '18 px');
  assert.equal(canvas.style.getPropertyValue('--cd-radius'), '18px');

  const familySelect = doc.getElementById('type-family-select');
  familySelect.value = 'Serif';
  familySelect.dispatchEvent(new doc.defaultView.Event('change'));

  assert.ok(canvas.style.getPropertyValue('--cd-font-family').includes('Georgia'));
});

test('loading bundled templates replaces current theme and updates preview', () => {
  const { doc, editor } = setupDom();
  const canvas = doc.getElementById('preview-canvas');
  const templateSelect = doc.getElementById('template-select');

  templateSelect.value = 'minimal';
  templateSelect.dispatchEvent(new doc.defaultView.Event('change'));

  const current = editor.getCurrentTheme();
  assert.equal(current.id, 'minimal-copy');
  assert.equal(doc.getElementById('theme-name-input').value, 'Minimal (Custom)');
  assert.equal(canvas.style.getPropertyValue('--cd-bg'), '#ffffff');
});

test('view switcher toggles Home, Watch, and Channel (New UI) views', () => {
  const { doc } = setupDom();
  const homeView = doc.getElementById('preview-home-view');
  const watchView = doc.getElementById('preview-watch-view');
  const channelView = doc.getElementById('preview-channel-view');

  const viewWatchBtn = doc.getElementById('view-watch-btn');
  const viewChannelBtn = doc.getElementById('view-channel-btn');
  const viewHomeBtn = doc.getElementById('view-home-btn');

  // Switch to Watch
  viewWatchBtn.click();
  assert.equal(homeView.classList.contains('hidden'), true);
  assert.equal(watchView.classList.contains('hidden'), false);
  assert.equal(channelView.classList.contains('hidden'), true);
  assert.equal(viewWatchBtn.classList.contains('active'), true);

  // Switch to Channel (New UI)
  viewChannelBtn.click();
  assert.equal(homeView.classList.contains('hidden'), true);
  assert.equal(watchView.classList.contains('hidden'), true);
  assert.equal(channelView.classList.contains('hidden'), false);
  assert.equal(viewChannelBtn.classList.contains('active'), true);

  // Switch back to Home
  viewHomeBtn.click();
  assert.equal(homeView.classList.contains('hidden'), false);
  assert.equal(watchView.classList.contains('hidden'), true);
  assert.equal(channelView.classList.contains('hidden'), true);
});

test('viewport width switcher toggles stage classes', () => {
  const { doc } = setupDom();
  const stage = doc.getElementById('preview-stage');
  const widthLaptopBtn = doc.getElementById('width-laptop-btn');
  const widthCompactBtn = doc.getElementById('width-compact-btn');
  const widthFullBtn = doc.getElementById('width-full-btn');

  widthLaptopBtn.click();
  assert.ok(stage.classList.contains('width-laptop'));

  widthCompactBtn.click();
  assert.ok(stage.classList.contains('width-compact'));
  assert.ok(!stage.classList.contains('width-laptop'));

  widthFullBtn.click();
  assert.ok(!stage.classList.contains('width-compact'));
  assert.ok(!stage.classList.contains('width-laptop'));
});

test('saveTheme writes valid theme to storage and can apply to settings', async () => {
  const { doc, editor, storageData } = setupDom();

  // Save only
  const saveOk = await editor.saveTheme(false);
  assert.equal(saveOk, true);

  const customThemes = storageData[STORAGE_KEYS.customThemes];
  const items = customThemes.items || customThemes;
  assert.ok(items['my-custom-theme']);
  assert.equal(items['my-custom-theme'].name, 'My Custom Theme');
  assert.equal(storageData[STORAGE_KEYS.settings], undefined);

  // Save and apply
  const applyOk = await editor.saveTheme(true);
  assert.equal(applyOk, true);
  assert.ok(storageData[STORAGE_KEYS.settings]);
  assert.equal(storageData[STORAGE_KEYS.settings].themeId, 'my-custom-theme');

  assert.match(doc.getElementById('editor-notice').textContent, /selected/);
});

test('saveTheme allows free users to save custom themes without paywall', async () => {
  const { doc, editor } = setupDom({ isPro: false });
  const ok = await editor.saveTheme(false);
  assert.equal(ok, true);
  assert.match(doc.getElementById('editor-notice').textContent, /saved/i);
});

test('saveTheme fails safely when storage is unavailable', async () => {
  const { doc, editor } = setupDom({ noStorage: true });
  const ok = await editor.saveTheme(false);
  assert.equal(ok, false);
  assert.match(doc.getElementById('editor-notice').textContent, /unavailable/);
});

test('saveTheme rejects reserved theme IDs', async () => {
  const { doc, editor } = setupDom();
  const theme = editor.getCurrentTheme();
  theme.id = 'cinema';
  const ok = await editor.saveTheme(false);
  assert.equal(ok, false);
  assert.match(doc.getElementById('editor-notice').textContent, /reserved/);
});

test('invalid hex input marks input invalid and blocks save', async () => {
  const { doc, editor } = setupDom();
  const hexInput = doc.getElementById('color-bg-hex');
  hexInput.value = 'invalid-hex';
  hexInput.dispatchEvent(new doc.defaultView.Event('input'));

  assert.ok(hexInput.classList.contains('invalid'));
  assert.equal(hexInput.getAttribute('aria-invalid'), 'true');

  const ok = await editor.saveTheme(false);
  assert.equal(ok, false);
  assert.match(doc.getElementById('editor-notice').textContent, /invalid hex/i);
});

test('CSS validation error displays in error box and blocks save', async () => {
  const { doc, editor } = setupDom();
  const cssInput = doc.getElementById('custom-css-input');
  cssInput.value = 'body { display: none !important; }'; // not allowed, un-scoped
  cssInput.dispatchEvent(new doc.defaultView.Event('input'));

  const errorBox = doc.getElementById('css-error-box');
  assert.equal(errorBox.classList.contains('hidden'), false);

  const ok = await editor.saveTheme(false);
  assert.equal(ok, false);
  assert.match(doc.getElementById('editor-notice').textContent, /Cannot save/);
});

test('editor restores draft from storage if present', async () => {
  const draftTheme = {
    schema: 1,
    id: 'draft-theme',
    name: 'Draft Theme',
    author: 'Drafter',
    version: '1.0.0',
    tier: 'pro',
    tokens: {
      color: { bg: '#222233', surface: '#2a2a3c', text: '#ffffff', muted: '#888899', accent: '#ffaa00', border: '#444455' },
      type: { family: 'System', baseSize: 16, headingWeight: 700 },
      shape: { radius: 8, shadow: true, spacing: 3 },
    },
    layout: { home: 'grid', watch: 'cinema', density: 2 },
    calm: { hideShorts: true, hideHomeRecs: false, hideComments: false, hideEndScreens: false, hideViewCounts: false, hideLive: false },
    css: '',
  };
  const { doc, editor } = setupDom({
    initialStorage: {
      [STORAGE_KEYS.draft]: { theme: draftTheme, savedAt: Date.now() },
    },
  });
  await editor.loadInitialTheme();
  assert.equal(doc.getElementById('theme-name-input').value, 'Draft Theme');
  assert.equal(doc.getElementById('color-bg-hex').value, '#222233');
  assert.match(doc.getElementById('editor-notice').textContent, /draft/i);
});

test('preview sets calm attributes on preview canvas', () => {
  const { doc } = setupDom();
  const canvas = doc.getElementById('preview-canvas');
  const calmShorts = doc.getElementById('calm-hideshorts');
  calmShorts.checked = true;
  calmShorts.dispatchEvent(new doc.defaultView.Event('change'));

  assert.equal(canvas.getAttribute('cd-calm-hideshorts'), 'true');
});

test('roving tab stops on view buttons navigate with arrow keys', () => {
  const { doc } = setupDom();
  const homeBtn = doc.getElementById('view-home-btn');
  const watchBtn = doc.getElementById('view-watch-btn');

  assert.equal(homeBtn.getAttribute('tabindex'), '0');
  assert.equal(watchBtn.getAttribute('tabindex'), '-1');

  homeBtn.dispatchEvent(new doc.defaultView.KeyboardEvent('keydown', { key: 'ArrowRight' }));
  assert.equal(homeBtn.getAttribute('tabindex'), '-1');
  assert.equal(watchBtn.getAttribute('tabindex'), '0');
  assert.equal(watchBtn.classList.contains('active'), true);
});
