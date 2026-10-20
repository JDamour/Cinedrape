// Shared setup for the popup tests (not a test file: the name does not match *.test.js).
//
//   const t = await mount({ settings: {...}, licence: {plan:'pro', status:'active'}, tab: {...} });
//   t.click(t.$('theme-grid').querySelector('[data-theme-id="minimal"]'));
//   await t.popup.idle();
//   assert.equal((await t.stored()).themeId, 'minimal');
//
// The real popup.html is loaded into jsdom (scripts and stylesheets are not fetched), the chrome object is
// test/helpers/chrome-mock.js, and the background / content script are small fakes registered on it.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { createChromeMock } from '../helpers/chrome-mock.js';
import { createPopup } from '../../src/popup/app.js';
import { MSG, STORAGE_KEYS } from '../../src/shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const POPUP_DIR = path.resolve(HERE, '..', '..', 'src', 'popup');
export const POPUP_HTML = readFileSync(path.join(POPUP_DIR, 'popup.html'), 'utf8');
export const POPUP_CSS = readFileSync(path.join(POPUP_DIR, 'popup.css'), 'utf8');
export const SETTINGS_KEY = STORAGE_KEYS.settings;
export const YT_URL = 'https://www.youtube.com/watch?v=BzpdP2APcIM';

const theme = (id, name, tier, color, density = 3) => ({
  schema: 1, id, name, author: 'Cinedrape', version: '1.0.0', tier,
  tokens: { color, type: { family: 'Inter', baseSize: 14, headingWeight: 700 }, shape: { radius: 10, shadow: true, spacing: 3 } },
  layout: { home: 'hero-rows', watch: 'cinema', density },
  calm: {},
  css: '',
});

/** Stand-ins shaped like the real themes (ids and tiers per the contract, colours chosen to pass 4.5:1 / 3:1). */
export const FAKE_THEMES = Object.freeze([
  theme('cinema', 'Cinema', 'free', { bg: '#0b0b0f', surface: '#16161d', text: '#f2f2f5', muted: '#9a9aa8', accent: '#e8b04a', border: '#26262f' }),
  theme('minimal', 'Minimal', 'free', { bg: '#f6f6f4', surface: '#ffffff', text: '#1c1c1f', muted: '#5d5d66', accent: '#0b57d0', border: '#8c8c94' }, 4),
  theme('classic', 'Classic', 'free', { bg: '#1c2230', surface: '#262e40', text: '#eef1f7', muted: '#a9b2c6', accent: '#ff9d2e', border: '#5b6784' }, 2),
  theme('primetime', 'Prime Time', 'pro', { bg: '#0a1330', surface: '#111d45', text: '#eef2ff', muted: '#a9b4dc', accent: '#4da3ff', border: '#4a5d9a' }),
  theme('studio', 'Studio', 'pro', { bg: '#fbf8f2', surface: '#ffffff', text: '#221f1a', muted: '#5f5a50', accent: '#8a4b00', border: '#8f8778' }, 5),
  theme('arcade', 'Arcade', 'pro', { bg: '#0a0a12', surface: '#14141f', text: '#f4f4ff', muted: '#a8a8c4', accent: '#39ff88', border: '#4b4b72' }, 1),
  theme('oled', 'True Black', 'pro', { bg: '#000000', surface: '#0d0d0d', text: '#f5f5f7', muted: '#a0a0a8', accent: '#38bdf8', border: '#52525c' }, 3),
  theme('frost', 'Frost', 'pro', { bg: '#0f172a', surface: '#1e293b', text: '#f1f5f9', muted: '#94a3b8', accent: '#22d3ee', border: '#64748b' }, 3),
  theme('mocha', 'Mocha', 'pro', { bg: '#1e181b', surface: '#2a2226', text: '#f5eff2', muted: '#b0a2a8', accent: '#f5a97f', border: '#66565f' }, 3),
  theme('midnight-city', 'Midnight City', 'pro', { bg: '#060814', surface: '#0f1224', text: '#f0f2ff', muted: '#989ebd', accent: '#a855f7', border: '#545a82' }, 3),
  theme('ember', 'Ember', 'pro', { bg: '#151811', surface: '#21261b', text: '#f4f5ee', muted: '#a4ab97', accent: '#e06b3a', border: '#626b55' }, 2),
  theme('paper', 'Paper Study', 'pro', { bg: '#f6f3eb', surface: '#ffffff', text: '#211d1a', muted: '#6e6761', accent: '#8c3822', border: '#8c847b' }, 4),
  theme('matcha', 'Matcha', 'pro', { bg: '#edf3eb', surface: '#f7faf5', text: '#1b241c', muted: '#5b695c', accent: '#2c6e3b', border: '#7b8c7c' }, 3),
  theme('sunset', 'Sunset', 'pro', { bg: '#fff2eb', surface: '#ffffff', text: '#261b1e', muted: '#735f65', accent: '#c93b66', border: '#948086' }, 3),
  theme('terminal', 'Retro Terminal', 'pro', { bg: '#050905', surface: '#0d140d', text: '#e6ffe6', muted: '#82ba82', accent: '#00ff41', border: '#427542' }, 1),
  theme('imax', 'Big Screen', 'pro', { bg: '#07070a', surface: '#111116', text: '#f7f7fa', muted: '#a2a2ad', accent: '#ff9f1c', border: '#585869' }, 5),
]);

export const FREE = Object.freeze({ plan: 'free', status: 'none' });
export const PRO = Object.freeze({ plan: 'pro', status: 'active' });
export const GRACE = Object.freeze({ plan: 'pro', status: 'grace' });
export const EXPIRED = Object.freeze({ plan: 'free', status: 'expired' });

export const STATUS_OK = Object.freeze({
  themeId: 'cinema', pageType: 'home', pro: false, mapVersion: '2026.10.07.1', missingRoles: [],
  features: { theme: 'on', 'layout-home': 'on', 'layout-watch': 'off', density: 'locked', 'calm-hideShorts': 'off' },
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {object} [o]
 * @param {object|null} [o.settings]    seeded into chrome.storage.local[cd.settings]
 * @param {object} [o.licence]          what the fake background answers to GET_LICENCE
 * @param {'silent'|'hang'|'junk'|'flaky'} [o.licenceMode]   no listener answer, never answers, non-licence junk, or fails once and then answers
 * @param {object|null} [o.storedLicence]   the cd.licence record in chrome.storage.local (what the popup falls back to)
 * @param {object} [o.licenceKey]           public key the fallback verifies the stored token with (default: the shipped LICENCE_PUBLIC_KEY)
 * @param {(t:object)=>void|Promise<void>} [o.prepare]   runs after the fakes are wired and before the popup starts
 * @param {object[]} [o.themes]
 * @param {string|null} [o.tabUrl]      the active tab (null = no tab); the fake content script answers GET_STATUS
 * @param {object|Function|null|'hang'} [o.status]   reply to GET_STATUS (null = the tab has no content script)
 * @param {(token:string)=>object} [o.activate]      reply to ACTIVATE_LICENCE
 * @param {string} [o.version]
 * @param {boolean|undefined} [o.dev]   sets globalThis.__DEV__ for this mount
 */
export async function mount(o = {}) {
  const dom = new JSDOM(POPUP_HTML, { url: 'chrome-extension://test-id/popup/popup.html', pretendToBeVisual: true });
  const { window: win } = dom;
  const doc = win.document;
  const mock = createChromeMock({ manifest: { version: o.version ?? '1.2.3' } });
  const { chrome } = mock;

  const had = Object.prototype.hasOwnProperty.call(globalThis, '__DEV__');
  const prevDev = globalThis.__DEV__;
  if (o.dev === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = o.dev;

  const t = {
    dom, win, doc, mock, chrome,
    licence: o.licence ?? FREE,
    status: o.status === undefined ? STATUS_OK : o.status,
    activateImpl: o.activate ?? (() => ({ ok: false, reason: 'invalid' })),
    licenceMode: o.licenceMode ?? 'normal',
    messages: [],                                 // every message the fake background received
    tabMessages: [],
  };

  // Fake background: answers GET_LICENCE and ACTIVATE_LICENCE like src/background/service-worker.js is meant to.
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    t.messages.push(message);
    if (message.type === MSG.GET_LICENCE) {
      if (t.licenceMode === 'flaky' && t.messages.filter((m) => m.type === MSG.GET_LICENCE).length === 1) return undefined;
      if (t.licenceMode === 'silent') return undefined;
      if (t.licenceMode === 'hang') return true;
      sendResponse(t.licenceMode === 'junk' ? { hello: 'world' } : t.licence);
      return undefined;
    }
    if (message.type === MSG.ACTIVATE_LICENCE) {
      Promise.resolve(t.activateImpl(message.token)).then((reply) => {
        if (reply && reply.state) t.licence = reply.state;
        sendResponse(reply);
      });
      return true;
    }
    if (message.type === MSG.START_TRIAL) {
      if (t.startTrialImpl) {
        Promise.resolve(t.startTrialImpl()).then(sendResponse);
        return true;
      }
      const nowMs = Date.now();
      const trial = { until: nowMs + 10 * 60 * 1000, used: 1 };
      chrome.storage.session.set({ [STORAGE_KEYS.trial]: trial }).then(() => {
        sendResponse({ ok: true, trial });
      });
      return true;
    }
    if (message.type === MSG.GET_TRIAL) {
      chrome.storage.session.get([STORAGE_KEYS.trial, 'cd_trialEnded']).then((sess) => {
        chrome.storage.local.get([STORAGE_KEYS.trialLog]).then((loc) => {
          sendResponse({
            ok: true,
            trial: sess?.[STORAGE_KEYS.trial] || null,
            trialEnded: Boolean(sess?.cd_trialEnded),
            trialLog: loc?.[STORAGE_KEYS.trialLog] || null,
          });
        });
      });
      return true;
    }
    return undefined;
  });

  // Fake content script in the active tab.
  const tabUrl = o.tabUrl === undefined ? YT_URL : o.tabUrl;
  if (tabUrl !== null) {
    const handler = o.status === null ? undefined : (message, sender, sendResponse) => {
      t.tabMessages.push(message);
      if (!message || message.type !== MSG.GET_STATUS) return undefined;
      if (t.status === 'hang') return true;
      sendResponse(typeof t.status === 'function' ? t.status() : t.status);
      return undefined;
    };
    t.tab = mock.addTab({ id: 7, active: true, url: tabUrl }, handler);
  }

  if (o.settings !== undefined && o.settings !== null) await chrome.storage.local.set({ [SETTINGS_KEY]: o.settings });
  if (o.storedLicence) await chrome.storage.local.set({ [STORAGE_KEYS.licence]: o.storedLicence });
  if (o.trial) await chrome.storage.session.set({ [STORAGE_KEYS.trial]: o.trial });
  if (o.trialEnded) await chrome.storage.session.set({ cd_trialEnded: true });
  if (o.trialLog) await chrome.storage.local.set({ [STORAGE_KEYS.trialLog]: o.trialLog });
  if (o.install) await chrome.storage.local.set({ [STORAGE_KEYS.install]: o.install });
  mock.spies['storage.local.set'].calls.length = 0;
  if (o.prepare) await o.prepare(t);

  t.popup = createPopup({ doc, chrome, themes: o.themes ?? FAKE_THEMES, requestTimeoutMs: o.requestTimeoutMs ?? 400, licenceKey: o.licenceKey });
  await t.popup.ready;
  await t.popup.idle();

  // ---- helpers ----
  t.$ = (id) => {
    const el = doc.getElementById(id);
    if (!el) throw new Error(`no #${id}`);
    return el;
  };
  t.card = (id) => doc.querySelector(`[data-theme-id="${id}"]`);
  t.swatch = (hex) => doc.querySelector(`.swatch[data-hex="${hex}"]`);
  t.calm = (key) => doc.getElementById(`calm-${key}`);
  t.click = (el) => el.dispatchEvent(new win.MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  t.fire = (el, type) => el.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true }));
  t.key = (el, key, init = {}) => {
    const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(ev);
    return ev;
  };
  t.type = (el, value) => { el.value = value; t.fire(el, 'input'); };
  t.settle = async () => { await t.popup.idle(); await sleep(0); await t.popup.idle(); };
  t.stored = async () => (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  t.writes = () => mock.spies['storage.local.set'].calls.length;
  t.sleep = sleep;
  t.close = () => {
    t.popup.destroy();
    win.close();
    if (had) globalThis.__DEV__ = prevDev; else delete globalThis.__DEV__;
  };
  return t;
}

// ---- accessibility walk ----------------------------------------------------------------------------------------------

const textOf = (el, exclude) => {
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === 3) out += node.textContent;
    else if (node.nodeType === 1) {
      if (node.getAttribute('aria-hidden') === 'true' || node.hidden) continue;
      if (node === exclude) continue;
      out += ` ${textOf(node, exclude)} `;
    }
  }
  return out.replace(/\s+/g, ' ').trim();
};

/** A small accname computation: aria-labelledby > aria-label > native label > content (buttons) > title. */
export function accessibleName(el) {
  const doc = el.ownerDocument;
  const labelledby = el.getAttribute('aria-labelledby');
  if (labelledby) {
    const name = labelledby.split(/\s+/).map((id) => {
      const target = doc.getElementById(id);
      return target ? textOf(target) : '';
    }).join(' ').replace(/\s+/g, ' ').trim();
    if (name) return name;
  }
  const label = (el.getAttribute('aria-label') || '').trim();
  if (label) return label;
  if (el.id) {
    const forLabel = [...doc.querySelectorAll('label')].find((l) => l.getAttribute('for') === el.id);
    if (forLabel) return textOf(forLabel);
  }
  const wrapping = el.closest('label');
  if (wrapping) return textOf(wrapping, el);
  const tag = el.localName;
  const role = el.getAttribute('role');
  if (tag === 'button' || tag === 'a' || tag === 'summary' || tag === 'legend' || role === 'radio' || role === 'switch' || role === 'button') {
    const content = textOf(el);
    if (content) return content;
  }
  return (el.getAttribute('title') || '').trim();
}

export const INTERACTIVE = 'button, input:not([type="hidden"]), select, textarea, a[href], summary, [role="radio"], [role="switch"], [role="button"], [tabindex]';

/** Every interactive element that is not `hidden`, with its accessible name. */
export function interactiveElements(doc) {
  return [...doc.querySelectorAll(INTERACTIVE)].filter((el) => !el.closest('[hidden]'));
}
