// Shared helpers for the F3/F5 real-Chrome run (features-home-calm.mjs, features-home-calm-phases.mjs): service-worker helpers, session start,
// navigation to a populated home. Reads the harness in ./lib read-only; builds nothing.
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { promisify } from 'node:util';
import { Bridge, createSession, findChrome, installExtension, launchChrome, sleep, swSeed, validateExtension, withTimeout } from './lib/browser.mjs';
import { REPO_ROOT } from './lib/cli.mjs';
import { detectWall } from './lib/probes.mjs';

const execFileP = promisify(execFile);
export { sleep };
export const WATCH_ID = 'BzpdP2APcIM';
export const WATCH_URL = `https://www.youtube.com/watch?v=${WATCH_ID}`;
export const CALM_KEYS = ['hideShorts', 'hideHomeRecs', 'hideComments', 'hideEndScreens', 'hideViewCounts', 'hideLive'];

// ---- service worker helpers (serialised into the worker: self-contained, never throw) ---------------------------------------

/** Replaces cd.settings with `next` (full object) and returns the worker's Date.now() just before the write. */
export async function swWriteSettings(next) {
  try {
    const t = Date.now();
    await chrome.storage.local.set({ 'cd.settings': next });
    return { ok: true, t };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

export async function swRemove(keys) {
  try { await chrome.storage.local.remove(keys); return { ok: true }; } catch (err) { return { error: String(err && err.message) }; }
}

export async function swStatusOf(prefix) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    const tab = tabs.find((x) => x.url && x.url.startsWith(prefix)) || tabs[0];
    if (!tab) return { error: 'no youtube tab found' };
    return { reply: await chrome.tabs.sendMessage(tab.id, { type: 'cd:getStatus' }) };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

// ---- session ----------------------------------------------------------------------------------------------------------------

async function mintLicence() {
  const { stdout } = await execFileP(process.execPath, [join(REPO_ROOT, 'tools', 'dev-licence.mjs'), '--plan', 'pro', '--days', '30'], { cwd: REPO_ROOT, timeout: 20000, windowsHide: true });
  const token = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const parts = token.split('.');
  if (parts.length !== 2) throw new Error('could not mint a dev licence (run npm run keys once)');
  const claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
  return { token, claims, checkedAt: Date.now() };
}

export const baseSettings = (patch = {}) => ({
  schema: 1, themeId: 'cinema', accent: null, density: null, animations: true,
  calm: Object.fromEntries(CALM_KEYS.map((k) => [k, false])), telemetryOptIn: false, ...patch,
});

/**
 * Starts Chrome with a fresh profile and the built extension. `pro` seeds a dev Pro licence.
 * @returns ctx {browser, bridge, page, session, licence, consoleLog, close(), set(patch), reload(url)}
 */
export async function startSession({ extension = 'dist-home', pro = true, viewport = { width: 1440, height: 900 }, settings = baseSettings() } = {}) {
  const extDir = resolve(REPO_ROOT, extension);
  validateExtension(extDir);
  const chromePath = findChrome();
  const { default: puppeteer } = await import('puppeteer-core');
  const licence = pro ? await mintLicence() : null;
  const session = createSession();
  process.on('exit', () => session.disposeSync());
  const browser = await launchChrome(puppeteer, { chromePath, headed: false, viewport, profile: session.profile, extraArgs: [] });
  session.attach(browser);
  const ext = await installExtension(browser, extDir);
  const bridge = new Bridge(browser, ext);
  await bridge.acquire();
  await sleep(1000);
  const initial = { 'cd.settings': settings };
  if (licence) initial['cd.licence'] = licence;
  const seeded = await bridge.run(swSeed, initial);
  if (!seeded || seeded.error) throw new Error(`could not seed storage: ${seeded && seeded.error}`);
  const page = await browser.newPage();
  for (const p of await browser.pages()) if (p !== page) await p.close().catch(() => {});
  const consoleLog = [];
  page.on('console', (m) => {
    if (['error', 'warn', 'warning'].includes(m.type())) {
      const loc = m.location();
      consoleLog.push({ type: m.type(), text: m.text().slice(0, 300), url: String((loc && loc.url) || '').slice(0, 120) });
    }
  });
  page.on('pageerror', (e) => consoleLog.push({ type: 'pageerror', text: String(e && e.message).slice(0, 300), url: '' }));
  const ctx = {
    browser, bridge, page, session, licence, consoleLog, ext, viewport,
    settings: { ...settings },
    /** Merges `patch` (calm is merged key by key) into the stored settings through the worker; resolves when the write is done. */
    async set(patch) {
      const next = { ...ctx.settings, ...patch, calm: { ...ctx.settings.calm, ...(patch.calm || {}) } };
      ctx.settings = next;
      const r = await bridge.run(swWriteSettings, next);
      if (!r || r.error) throw new Error(`settings write failed: ${r && r.error}`);
      return r.t;
    },
    async close() {
      await session.dispose();
    },
  };
  return ctx;
}

export async function wallGuard(page, label) {
  const wall = await page.evaluate(detectWall).catch(() => null);
  if (wall) throw new Error(`YouTube served a ${wall.kind} wall at ${label}: ${wall.detail}`);
}

export async function gotoWatch(ctx, id = WATCH_ID) {
  const { page } = ctx;
  await page.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await wallGuard(page, 'watch');
  await page.waitForSelector('ytd-watch-flexy:not([hidden]) #movie_player', { timeout: 25000 });
  await sleep(2500);
}

/** Watch page first, then the YouTube logo (SPA navigation, fires the real yt-navigate-* events), then wait for home tiles. */
export async function gotoPopulatedHome(ctx, { minTiles = 8, timeout = 22000 } = {}) {
  const { page } = ctx;
  // Logged-out home is only populated after a watch page in the same session, and not every time: retry with another video.
  const ids = [WATCH_ID, 'jNQXAC9IVRw', 'aqz-KE-bpKQ'];
  let lastErr = null;
  for (let i = 0; i < ids.length; i++) {
    try {
      await gotoWatch(ctx, ids[i]);
      await clickLogo(ctx);
      await page.waitForFunction((n) => document.querySelectorAll('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer #contents > ytd-rich-item-renderer').length >= n, { timeout }, minTiles);
      await sleep(1500);
      return;
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`home feed did not populate after ${ids.length} attempts: ${String(lastErr && lastErr.message).slice(0, 120)}`);
}

export async function clickLogo(ctx) {
  const { page } = ctx;
  const sel = await page.evaluate(() => {
    const cands = ['ytd-masthead a#logo', 'ytd-topbar-logo-renderer a', 'a#logo'];
    for (const s of cands) {
      const el = document.querySelector(s);
      if (el) { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) return s; }
    }
    return null;
  });
  if (!sel) throw new Error('YouTube logo link not found');
  await page.click(sel);
}

/** SPA-navigates to a watch page by clicking the first tile link on the home feed (real user path). */
export async function clickFirstTileToWatch(ctx) {
  const { page } = ctx;
  const href = await page.evaluate(() => {
    const a = document.querySelector('.cd-card, .cd-hero-link') || document.querySelector('ytd-rich-item-renderer a.ytLockupViewModelContentImage[href^="/watch"]');
    return a ? a.getAttribute('href') : null;
  });
  if (!href) throw new Error('no tile to click');
  await page.evaluate(() => { const a = document.querySelector('.cd-card, .cd-hero-link') || document.querySelector('ytd-rich-item-renderer a.ytLockupViewModelContentImage[href^="/watch"]'); a.click(); });
  await page.waitForFunction(() => location.pathname === '/watch', { timeout: 20000 });
  await page.waitForSelector('ytd-watch-flexy:not([hidden]) #movie_player', { timeout: 25000 });
  return href;
}

export const pct = (sorted, p) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))] : null);
