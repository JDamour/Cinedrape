// Helpers for test/e2e/features-popup-breakage.mjs (F4 popup, F6 breakage detection, trust audit). Not a unit test (the name does not
// match *.test.js). Imports the shared harness in ./lib read-only. Everything here runs against a temporary Chrome profile and the
// extension directory passed in; nothing is sent anywhere by the pages under test.
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { Bridge, createSession, findChrome, installExtension, launchChrome, sleep, validateExtension, withTimeout } from './lib/browser.mjs';
import { REPO_ROOT } from './lib/cli.mjs';

export { sleep, REPO_ROOT };
const execFileP = promisify(execFile);

export const WATCH_URL = 'https://www.youtube.com/watch?v=BzpdP2APcIM';
export const CHANNEL_URL = 'https://www.youtube.com/@NatGeo/videos';
export const HOME_URL = 'https://www.youtube.com/';
export const DAY = 86400000;

// ---- service-worker functions (serialised into the worker: self-contained, never throw) -------------------------------------

export async function swSet(entries) {
  try { await chrome.storage.local.set(entries); return { ok: true, t: Date.now() }; } catch (err) { return { error: String(err && err.message) }; }
}
export async function swGet(keys) {
  try { return { value: await chrome.storage.local.get(keys) }; } catch (err) { return { error: String(err && err.message) }; }
}
export async function swRemove(keys) {
  try { await chrome.storage.local.remove(keys); return { ok: true, t: Date.now() }; } catch (err) { return { error: String(err && err.message) }; }
}
export async function swClear() {
  try { await chrome.storage.local.clear(); return { ok: true }; } catch (err) { return { error: String(err && err.message) }; }
}
export async function swStatus() {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    const out = [];
    for (const tab of tabs) {
      try { out.push({ tabId: tab.id, url: tab.url, active: tab.active, reply: await chrome.tabs.sendMessage(tab.id, { type: 'cd:getStatus' }) }); } catch (err) { out.push({ tabId: tab.id, url: tab.url, error: String(err && err.message) }); }
    }
    return { tabs: out };
  } catch (err) { return { error: String(err && err.message) }; }
}
export async function swManifest() {
  try {
    const perms = await chrome.permissions.getAll();
    return { manifest: chrome.runtime.getManifest(), granted: perms, id: chrome.runtime.id };
  } catch (err) { return { error: String(err && err.message) }; }
}
export async function swFetchControl(url) {
  try { const r = await fetch(url, { cache: 'no-store' }); return { status: r.status }; } catch (err) { return { error: String(err && err.message) }; }
}

// ---- licence + signing (Node side) ------------------------------------------------------------------------------------------

export async function mintLicence({ plan = 'pro', days = 30 } = {}) {
  const { stdout } = await execFileP(process.execPath, [join(REPO_ROOT, 'tools', 'dev-licence.mjs'), '--plan', plan, '--days', String(days)], { cwd: REPO_ROOT, timeout: 20000, windowsHide: true });
  const token = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('could not mint a dev licence (run npm run keys once)');
  const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  return { token, claims };
}

/** A token signed with the real dev licence key but with the given claims (used for an expired one). */
export async function signCustomLicence(claims) {
  const { loadKeyPair } = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'gen-keys.mjs')).href);
  const { signLicenceToken } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'licence.js')).href);
  const { privateJwk } = await loadKeyPair(REPO_ROOT, 'licence');
  return signLicenceToken(claims, privateJwk);
}

/** Flips one character of the signature part so the token no longer verifies. */
export function tamperToken(token) {
  const [claims, sig] = token.split('.');
  const flipped = (sig[10] === 'A' ? 'B' : 'A');
  return `${claims}.${sig.slice(0, 10)}${flipped}${sig.slice(11)}`;
}

export function loadSourceMap() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
}

/** Signs a map object with the dev selector-map key; `mutate(map)` may change a deep copy first. */
export async function signMap(map, { keyName = 'selector-map' } = {}) {
  const { loadKeyPair } = await import(pathToFileURL(join(REPO_ROOT, 'tools', 'gen-keys.mjs')).href);
  const { signEnvelope } = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'signing.js')).href);
  const { privateJwk, publicJwk } = await loadKeyPair(REPO_ROOT, keyName);
  return signEnvelope(JSON.stringify(map), privateJwk, publicJwk.kid);
}

export function variantMap({ version, breakRoles = [] }) {
  const map = JSON.parse(JSON.stringify(loadSourceMap()));
  map.mapVersion = version;
  map.issuedAt = '2026-10-09T00:00:00Z';
  for (const role of breakRoles) map.roles[role] = [`cd-e2e-missing-${role.toLowerCase()}`, `.cd-e2e-missing-${role.toLowerCase()}`];
  return map;
}

// ---- in-page instruments ------------------------------------------------------------------------------------------------------

/** evaluateOnNewDocument for youtube.com pages: timestamps of every cd-* attribute change and every write to the style element. */
export function ytInit() {
  try {
    if (window.__cdProbe) return;
    const P = { ev: [], p0: performance.now(), d0: Date.now(), paint: {}, styleFirst: null, attrFirst: null, rootFirst: null };
    window.__cdProbe = P;
    P.es = [];
    let esLast = null;
    const esCheck = () => {
      const n = document.querySelectorAll('.ytp-ce-element, .ytp-endscreen-content, .ytp-ce-shadow').length;
      if (n !== esLast) { esLast = n; const v = document.querySelector('video'); const pl = document.querySelector('#movie_player'); P.es.push({ n, vs: v ? [Math.round(v.currentTime), v.paused, v.ended, v.readyState].join('/') : null, pc: pl ? pl.className.replace(/html5-video-player|ytp-/g, '').slice(0, 160) : null, focus: document.hasFocus(), t: Date.now(), p: Math.round(performance.now()), vis: document.visibilityState, off: document.documentElement ? [...document.documentElement.attributes].filter((x) => x.name.startsWith('cd-off')).map((x) => x.name).join(' ') : '' }); }
    };
    try { new MutationObserver(esCheck).observe(document, { childList: true, subtree: true }); } catch (e) { /* ignore */ }
    const log = (k, d) => P.ev.push({ k, d, t: Date.now(), p: performance.now() });
    try {
      new PerformanceObserver((list) => { for (const e of list.getEntries()) P.paint[e.name] = e.startTime; }).observe({ type: 'paint', buffered: true });
    } catch (e) { /* no paint timing */ }
    let styleObserver = null;
    const watchStyle = (el) => {
      if (styleObserver) styleObserver.disconnect();
      styleObserver = new MutationObserver(() => log('style-text', { len: el.textContent.length }));
      styleObserver.observe(el, { childList: true, characterData: true, subtree: true });
    };
    const hook = (root) => {
      if (P.rootFirst === null) P.rootFirst = performance.now();
      new MutationObserver((recs) => {
        for (const r of recs) {
          if (r.type === 'attributes' && r.attributeName && r.attributeName.startsWith('cd-')) {
            if (P.attrFirst === null && r.attributeName === 'cd-theme') P.attrFirst = performance.now();
            log('attr', { n: r.attributeName, v: root.getAttribute(r.attributeName), old: r.oldValue });
          } else if (r.type === 'childList') {
            for (const n of r.addedNodes) {
              if (n.nodeType === 1 && n.id === 'cinedrape-theme') {
                if (P.styleFirst === null) P.styleFirst = performance.now();
                log('style-added', { len: n.textContent.length });
                watchStyle(n);
              }
            }
            for (const n of r.removedNodes) if (n.nodeType === 1 && n.id === 'cinedrape-theme') log('style-removed', {});
          }
        }
      }).observe(root, { attributes: true, attributeOldValue: true, childList: true });
      if (root.hasAttribute('cd-theme') && P.attrFirst === null) P.attrFirst = performance.now();
      const existing = document.getElementById('cinedrape-theme');
      if (existing) { if (P.styleFirst === null) P.styleFirst = performance.now(); watchStyle(existing); }
      // What was already on the page when the probe first looked (the content script runs at document_start, before this observer's
      // first callback): compared with the final state it shows whether anything changed afterwards (a restyle).
      P.snap0 = { t: performance.now(), styleLen: existing ? existing.textContent.length : null, attrs: Object.fromEntries([...root.attributes].filter((a) => a.name.startsWith('cd-')).map((a) => [a.name, a.value])) };
    };
    if (document.documentElement) hook(document.documentElement);
    else {
      const o = new MutationObserver(() => { if (document.documentElement) { o.disconnect(); hook(document.documentElement); } });
      o.observe(document, { childList: true });
    }
  } catch (e) { /* never break the page */ }
}

/** evaluateOnNewDocument for the popup page: click / key / change timestamps and every chrome.storage.local.set call. */
export function popupInit(opts) {
  try {
    const T = { click: 0, key: 0, change: 0, sets: [], msgs: [] };
    if (opts && opts.failWorkerMessages) {
      // The MV3 worker is asleep or restarting: Chrome rejects the message with this exact error while the new worker boots.
      const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function patched(...args) {
        const type = args[0] && args[0].type;
        T.msgs.push({ type, t: Date.now() });
        if (type === 'cd:getLicence') return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        return orig(...args);
      };
    }
    window.__pt = T;
    addEventListener('click', () => { T.click = Date.now(); }, true);
    addEventListener('keydown', () => { T.key = Date.now(); }, true);
    addEventListener('change', () => { T.change = Date.now(); }, true);
    const area = chrome.storage.local;
    const orig = area.set;
    area.set = function patched(...args) { T.sets.push({ t: Date.now(), keys: Object.keys(args[0] || {}) }); return orig.apply(this, args); };
  } catch (e) { /* the popup still works unobserved */ }
}

/** Page-side: is the page usable? Visible tiles, main region size, player size, text length. */
export function usabilityProbe() {
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const cs = getComputedStyle(el);
    return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05;
  };
  const tiles = [...document.querySelectorAll('ytd-rich-item-renderer, ytd-grid-video-renderer, ytd-video-renderer, yt-lockup-view-model, ytd-compact-video-renderer')].filter(vis);
  const pm = document.querySelector('ytd-page-manager');
  const pr = pm ? pm.getBoundingClientRect() : null;
  const player = document.querySelector('#movie_player');
  const prr = player ? player.getBoundingClientRect() : null;
  const mast = document.querySelector('ytd-masthead');
  const comments = document.querySelector('ytd-comments');
  const root = document.documentElement;
  const rootCs = getComputedStyle(root);
  return {
    visibleTiles: tiles.length,
    pageManager: pr ? { w: Math.round(pr.width), h: Math.round(pr.height), visible: vis(pm) } : null,
    player: prr ? { w: Math.round(prr.width), h: Math.round(prr.height), visible: vis(player) } : null,
    mastheadVisible: vis(mast),
    commentsDisplay: comments ? getComputedStyle(comments).display : null,
    esLog: window.__cdProbe ? window.__cdProbe.es : null,
    endScreenNodes: document.querySelectorAll('.ytp-ce-element, .ytp-endscreen-content, .ytp-ce-shadow').length,
    bodyTextChars: (document.body ? document.body.innerText : '').length,
    rootBg: rootCs.backgroundColor,
    attrs: Object.fromEntries([...root.attributes].filter((a) => a.name.startsWith('cd-')).map((a) => [a.name, a.value])),
    styleBytes: (document.getElementById('cinedrape-theme') || { textContent: '' }).textContent.length,
    styleHasTokens: /--cd-bg\s*:/.test((document.getElementById('cinedrape-theme') || { textContent: '' }).textContent),
    notices: [...document.querySelectorAll('div.cd-notice[role="status"]')].map((n) => (n.textContent || '').slice(0, 200)),
  };
}

// ---- session ------------------------------------------------------------------------------------------------------------------

export const calmOff = () => ({ hideShorts: false, hideHomeRecs: false, hideComments: false, hideEndScreens: false, hideViewCounts: false, hideLive: false });
export const baseSettings = (patch = {}) => ({ schema: 1, themeId: 'cinema', accent: null, density: null, animations: true, calm: {}, telemetryOptIn: false, ...patch });

/** Collects every request the extension could make: the service worker (CDP Network), the popup pages, and youtube pages (initiator). */
export function createRecorder(extId) {
  const rec = { extId, sw: [], popup: [], ytTotal: 0, ytFromExt: [], ytHosts: {}, ws: [], controls: {} };
  const isNet = (u) => /^(https?|wss?|ftp):/i.test(u);
  const frames = (initiator) => {
    const out = [];
    let st = initiator && initiator.stack;
    for (let depth = 0; st && depth < 20; depth++) { out.push(...(st.callFrames || [])); st = st.parent; }
    return out;
  };
  const fromExt = (e) => {
    const init = e.initiator || {};
    if (String(init.url || '').includes(extId)) return true;
    return frames(init).some((f) => String(f.url || '').includes(extId));
  };
  rec.attachYouTube = async (page, label) => {
    const s = await page.createCDPSession();
    await s.send('Network.enable');
    s.on('Network.requestWillBeSent', (e) => {
      const url = e.request.url;
      if (!isNet(url)) return;
      rec.ytTotal += 1;
      try { const h = new URL(url).host; rec.ytHosts[h] = (rec.ytHosts[h] || 0) + 1; } catch { /* ignore */ }
      if (fromExt(e)) rec.ytFromExt.push({ label, url: url.slice(0, 200), method: e.request.method, type: e.type });
    });
    s.on('Network.webSocketCreated', (e) => { if (fromExt(e)) rec.ws.push({ label, url: e.url }); });
    return s;
  };
  rec.attachPopup = async (page, label) => {
    const s = await page.createCDPSession();
    await s.send('Network.enable');
    s.on('Network.requestWillBeSent', (e) => { if (isNet(e.request.url)) rec.popup.push({ label, url: e.request.url.slice(0, 200), method: e.request.method }); });
    return s;
  };
  rec.swSessions = [];
  rec.detachSw = async () => {
    for (const s of rec.swSessions.splice(0)) await s.detach().catch(() => {});
  };
  rec.attachSw = async (browser) => {
    const done = new Set();
    const attach = async (t) => {
      try {
        if (t.type() !== 'service_worker' || !t.url().startsWith(`chrome-extension://${extId}/`) || done.has(t)) return;
        done.add(t);
        const s = await t.createCDPSession();
        rec.swSessions.push(s);
        await s.send('Network.enable');
        s.on('Network.requestWillBeSent', (e) => { if (isNet(e.request.url)) rec.sw.push({ url: e.request.url.slice(0, 200), method: e.request.method, type: e.type, control: Boolean(rec.swControl) }); });
      } catch { /* the worker went away */ }
    };
    browser.on('targetcreated', attach);
    for (const t of browser.targets()) await attach(t);
  };
  return rec;
}

/**
 * Like Bridge, but for a run that stops and restarts the MV3 worker on purpose: longer timeout, up to four attempts, and an
 * extension page is opened to wake a worker that is not running before the next try.
 */
export class RobustBridge extends Bridge {
  async wake() {
    let page = null;
    try {
      page = await this.browser.newPage();
      await page.goto(`chrome-extension://${this.ext.id}/popup/popup.html`, { waitUntil: 'load', timeout: 20000 });
      await sleep(600);
    } catch { /* the next attempt reports the real problem */ } finally {
      if (page) await page.close().catch(() => {});
    }
  }

  async run(fn, ...args) {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const w = this.worker || (await this.acquire(attempt === 0 ? 15000 : 25000));
        return await withTimeout(w.evaluate(fn, ...args), 30000, 'service worker call');
      } catch (err) {
        last = err;
        this.worker = null;
        if (attempt < 3) { await this.wake(); await sleep(250 * (attempt + 1)); }
      }
    }
    throw last;
  }

  /** Drops our debugging session so the worker may go idle (an attached session keeps an MV3 worker alive). */
  async release() {
    const w = this.worker;
    this.worker = null;
    if (w && w.client && typeof w.client.detach === 'function') await w.client.detach().catch(() => {});
  }
}

/**
 * Starts Chrome with a fresh profile and the extension. `settings`/`licence` are seeded through the service worker before any page opens.
 * @returns ctx {browser, bridge, ext, extId, session, rec, newYouTube(url), openPopup(opts), sw(fn,...args), close()}
 */
export async function startRun({ extension, viewport = { width: 1280, height: 800 }, settings = baseSettings(), licence = null, chromeArgs = [] } = {}) {
  const extDir = resolve(REPO_ROOT, extension);
  const manifest = validateExtension(extDir);
  const { default: puppeteer } = await import('puppeteer-core');
  const session = createSession();
  process.on('exit', () => session.disposeSync());
  // protocolTimeout: a busy YouTube tab can hold Runtime.callFunctionOn for longer than puppeteer's 180 s default on a loaded machine
  const patched = { launch: (opts) => puppeteer.launch({ ...opts, protocolTimeout: 300000 }) };
  const browser = await launchChrome(patched, { chromePath: findChrome(process.env.CHROME_PATH), headed: false, viewport, profile: session.profile, extraArgs: chromeArgs });
  session.attach(browser);
  const ext = await installExtension(browser, extDir);
  const bridge = new RobustBridge(browser, ext);
  await bridge.acquire();
  await sleep(1200);
  const rec = createRecorder(ext.id);
  await rec.attachSw(browser);
  const seed = {};
  if (settings) seed['cd.settings'] = settings;
  if (licence) seed['cd.licence'] = licence;
  if (Object.keys(seed).length) {
    const r = await bridge.run(swSet, seed);
    if (!r || r.error) throw new Error(`could not seed storage: ${r && r.error}`);
  }
  const consoleLog = [];
  const ctx = {
    browser, bridge, ext, extId: ext.id, session, rec, manifest, consoleLog, viewport,
    sw: (fn, ...args) => bridge.run(fn, ...args),
    async newYouTube(url, { width = viewport.width, height = viewport.height, label = 'yt' } = {}) {
      const page = await browser.newPage();
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      page.on('console', (m) => {
        if (['error', 'warn', 'warning'].includes(m.type())) consoleLog.push({ label, type: m.type(), text: m.text().slice(0, 240), url: String((m.location() || {}).url || '').slice(0, 100) });
      });
      page.on('pageerror', (e) => consoleLog.push({ label, type: 'pageerror', text: String(e && e.message).slice(0, 240), url: '' }));
      await rec.attachYouTube(page, label);
      await page.evaluateOnNewDocument(ytInit);
      if (url) await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
      return page;
    },
    /** Opens popup.html as an extension page. `window:true` = its own window (so the YouTube tab stays visible), `background:true` = a hidden tab in the main window. */
    async openPopup({ width = 360, height = 900, window: own = true, background = false, colorScheme = null, reducedMotion = null, label = 'popup', failWorkerMessages = false } = {}) {
      const page = await browser.newPage(own ? { type: 'window' } : { background });
      await page.setViewport({ width, height, deviceScaleFactor: 1 });
      const feats = [];
      if (colorScheme) feats.push({ name: 'prefers-color-scheme', value: colorScheme });
      if (reducedMotion !== null) feats.push({ name: 'prefers-reduced-motion', value: reducedMotion ? 'reduce' : 'no-preference' });
      if (feats.length) await page.emulateMediaFeatures(feats);
      page.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) consoleLog.push({ label, type: m.type(), text: m.text().slice(0, 240), url: String((m.location() || {}).url || '').slice(0, 100) }); });
      page.on('pageerror', (e) => consoleLog.push({ label, type: 'pageerror', text: String(e && e.message).slice(0, 240), url: '' }));
      await rec.attachPopup(page, label);
      await page.evaluateOnNewDocument(popupInit, { failWorkerMessages });
      await page.goto(`chrome-extension://${ext.id}/popup/popup.html`, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => document.getElementById('status-text') && document.getElementById('status-text').textContent !== 'Checking this tab…', { timeout: 15000 }).catch(() => {});
      return page;
    },
    async close() { await session.dispose(); },
  };
  return ctx;
}

// ---- measurement helpers --------------------------------------------------------------------------------------------------------

export const resetProbe = (page) => page.evaluate(() => { if (window.__cdProbe) window.__cdProbe.ev.length = 0; });
export const probeEvents = (page) => page.evaluate(() => (window.__cdProbe ? window.__cdProbe.ev.slice() : []));

/**
 * Waits until a probe event matching `want` shows up; returns it or null. `want` = {k, n?, v?}: event kind ('attr', 'style-text', ...),
 * attribute name and the value the attribute must have after the change (use v:'' for a flag attribute that appears, v:null for one that
 * is removed).
 */
export async function waitForEvent(page, want, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const ev = await page.evaluate((w) => (window.__cdProbe ? window.__cdProbe.ev : []).find((e) => e.k === w.k
      && (w.n === undefined || (e.d && e.d.n === w.n.toLowerCase()))
      && (w.v === undefined || (e.d && e.d.v === w.v))) || null, want);
    if (ev) return ev;
    await sleep(15);
  }
  return null;
}

/** Page-side readability audit of the popup: text colour against the effective background for every element with its own text. */
export function popupContrastAudit() {
  const parse = (s) => { const m = /rgba?\(([^)]+)\)/.exec(s || ''); if (!m) return null; const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const over = (top, bot) => { const a = top.a + bot.a * (1 - top.a); if (a === 0) return { r: 0, g: 0, b: 0, a: 0 }; return { r: (top.r * top.a + bot.r * bot.a * (1 - top.a)) / a, g: (top.g * top.a + bot.g * bot.a * (1 - top.a)) / a, b: (top.b * top.a + bot.b * bot.a * (1 - top.a)) / a, a }; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); };
  const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const effBg = (el) => {
    const stack = [];
    for (let n = el; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c && c.a > 0) { stack.push(c); if (c.a >= 1) break; } }
    let acc = { r: 255, g: 255, b: 255, a: 1 };
    const canvas = parse(getComputedStyle(document.documentElement).backgroundColor);
    if (canvas && canvas.a > 0) acc = over(canvas, acc);
    for (const c of stack.reverse()) acc = over(c, acc);
    return acc;
  };
  const rows = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const seen = new Set();
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim()) continue;
    seen.add(el);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    if (cs.display === 'none' || cs.visibility === 'hidden' || r.width < 1 || r.height < 1 || el.closest('.sr-only, [hidden]')) continue;
    if (el.closest('[aria-disabled="true"]:not(.row), :disabled') && el.closest('button, input')) continue; // inactive controls are exempt (WCAG 1.4.3)
    const fg0 = parse(cs.color);
    const bg = effBg(el);
    const fg = over({ ...fg0, a: fg0.a * (Number(cs.opacity) || 1) }, bg);
    const size = parseFloat(cs.fontSize);
    const large = size >= 24 || (size >= 18.66 && Number(cs.fontWeight) >= 700);
    rows.push({ text: t.textContent.trim().slice(0, 40), ratio: Number(ratio(fg, bg).toFixed(2)), need: large ? 3 : 4.5, size, cls: el.className && el.className.baseVal === undefined ? String(el.className).slice(0, 40) : el.tagName });
  }
  const bad = rows.filter((x) => x.ratio < x.need);
  return { measured: rows.length, below: bad.length, worst: rows.slice().sort((a, b) => a.ratio - b.ratio).slice(0, 5), bad: bad.slice(0, 8) };
}

/** Page-side: layout overflow and clipping at the current viewport. */
export function popupLayoutProbe() {
  const vw = document.documentElement.clientWidth;
  const offenders = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('svg.sprite') || el.closest('.sr-only')) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (r.right > vw + 0.5 || r.left < -0.5) offenders.push({ el: (el.id ? `#${el.id}` : `${el.tagName.toLowerCase()}.${String(el.className.baseVal === undefined ? el.className : '').split(' ')[0]}`), left: Math.round(r.left), right: Math.round(r.right) });
  }
  const clipped = [];
  for (const el of document.querySelectorAll('button, .hint, .row-title, .theme-name, legend, summary, label, p, h1, h2')) {
    if (el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el);
    if (cs.overflow !== 'visible' && el.scrollWidth > el.clientWidth + 1 && cs.display !== 'inline') clipped.push({ el: el.id || el.className || el.tagName, sw: el.scrollWidth, cw: el.clientWidth });
  }
  return { viewport: vw, scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, horizontalScroll: document.documentElement.scrollWidth > vw, offenders: offenders.slice(0, 10), clipped: clipped.slice(0, 10), height: document.documentElement.scrollHeight };
}
