// Chrome discovery, extension validation, launching with a throwaway profile, the service-worker bridge, and cleanup.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { EXIT, HarnessError } from './cli.mjs';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Rejects with a TIMEOUT HarnessError if `promise` has not settled after `ms`. */
export function withTimeout(promise, ms, label) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HarnessError(EXIT.TIMEOUT, `${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

export function findChrome(override) {
  const candidates = [];
  if (override) candidates.push(override);
  if (process.platform === 'win32') {
    for (const base of [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA]) {
      if (base) candidates.push(join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    }
    candidates.push('C:/Program Files/Google/Chrome/Application/chrome.exe');
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  } else {
    candidates.push('/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser');
  }
  const found = candidates.find((p) => existsSync(p));
  if (!found) throw new HarnessError(EXIT.ENVIRONMENT, `Chrome not found (tried ${candidates.join(', ')}). Pass --chrome <path> or set CHROME_PATH.`);
  return found;
}

/** Checks the unpacked extension directory before Chrome is started, so a missing or half-built dist fails fast and clearly. */
export function validateExtension(dir) {
  const hint = 'run `npm run build` first (or pass --extension <dir>)';
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new HarnessError(EXIT.ENVIRONMENT, `extension directory not found: ${dir}; ${hint}.`);
  const manifestPath = join(dir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new HarnessError(EXIT.ENVIRONMENT, `no manifest.json in ${dir}; ${hint}.`);
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new HarnessError(EXIT.ENVIRONMENT, `${manifestPath} is not valid JSON: ${err.message}`);
  }
  if (manifest.manifest_version !== 3) throw new HarnessError(EXIT.ENVIRONMENT, `${manifestPath}: manifest_version must be 3.`);
  const referenced = [];
  for (const cs of manifest.content_scripts || []) referenced.push(...(cs.js || []), ...(cs.css || []));
  if (manifest.background && manifest.background.service_worker) referenced.push(manifest.background.service_worker);
  if (manifest.action && manifest.action.default_popup) referenced.push(manifest.action.default_popup);
  const missing = [...new Set(referenced)].filter((f) => !existsSync(resolve(dir, f)));
  if (missing.length) throw new HarnessError(EXIT.ENVIRONMENT, `extension in ${dir} is incomplete: manifest references missing file(s) ${missing.join(', ')}; the build may be unfinished, ${hint}.`);
  if (!manifest.background || !manifest.background.service_worker) {
    throw new HarnessError(EXIT.ENVIRONMENT, 'the harness seeds chrome.storage through the extension service worker, but the manifest declares none.');
  }
  return manifest;
}

export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    else process.kill(pid, 'SIGKILL');
  } catch { /* already gone */ }
}

/**
 * Owns the Chrome process and the throwaway profile. `dispose()` is idempotent, safe from signal handlers, and never throws;
 * `disposeSync()` is the last-resort `process.on('exit')` variant.
 */
export function createSession() {
  // A run killed hard (TerminateProcess, power loss) cannot clean up after itself; remove such leftovers older than 2 hours.
  try {
    for (const name of readdirSync(tmpdir())) {
      const dir = join(tmpdir(), name);
      if (name.startsWith('cinedrape-e2e-') && Date.now() - statSync(dir).mtimeMs > 7200000) rmSync(dir, { recursive: true, force: true, maxRetries: 2 });
    }
  } catch { /* best effort */ }
  const state = { browser: null, proc: null, profile: mkdtempSync(join(tmpdir(), 'cinedrape-e2e-')), started: false };
  // Only kill a process we know is still ours: a recycled PID must never be hit by taskkill /T /F.
  const killIfAlive = () => { if (state.proc && state.proc.exitCode === null && state.proc.signalCode === null) killTree(state.proc.pid); };
  async function dispose() {
    if (state.started) return;
    state.started = true;
    if (state.browser) {
      try { await withTimeout(state.browser.close(), 8000, 'browser.close'); } catch { /* fall through to the kill */ }
    }
    killIfAlive();
    for (let i = 0; i < 3 && existsSync(state.profile); i++) {
      try { await rm(state.profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch { await sleep(500); }
    }
    if (existsSync(state.profile)) process.stderr.write(`warning: could not remove the temporary profile ${state.profile}\n`);
  }
  // process.on('exit') fallback; runs even when dispose() was cut short by process.exit(), so it ignores `started`.
  function disposeSync() {
    killIfAlive();
    if (existsSync(state.profile)) {
      try { rmSync(state.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
    }
  }
  return {
    state,
    get profile() { return state.profile; },
    attach(browser) { state.browser = browser; state.proc = browser.process(); },
    dispose, disposeSync,
  };
}

export async function launchChrome(puppeteer, { chromePath, headed, viewport, profile, extraArgs = [] }) {
  const args = ['--no-first-run', '--no-default-browser-check', '--lang=en-US', '--mute-audio', `--window-size=${viewport.width},${viewport.height}`];
  if (headed) args.push('--window-position=-2400,0');
  args.push(...extraArgs);
  try {
    return await puppeteer.launch({
      executablePath: chromePath,
      headless: !headed,
      pipe: true, // browser.installExtension needs the pipe transport
      enableExtensions: true, // drops --disable-extensions; --load-extension is ignored by branded Chrome 137+
      userDataDir: profile,
      defaultViewport: { width: viewport.width, height: viewport.height, deviceScaleFactor: 1 },
      args,
      timeout: 30000,
    });
  } catch (err) {
    throw new HarnessError(EXIT.ENVIRONMENT, `could not launch Chrome (${chromePath}): ${err.message}`);
  }
}

/** Installs the unpacked extension and returns puppeteer's Extension handle. */
export async function installExtension(browser, dir) {
  let id;
  try {
    id = await withTimeout(browser.installExtension(dir, { enabledInIncognito: false }), 20000, 'installExtension');
  } catch (err) {
    throw new HarnessError(EXIT.ENVIRONMENT, `Chrome refused to load the extension from ${dir}: ${err.message}`);
  }
  const ext = (await browser.extensions()).get(id);
  if (!ext) throw new HarnessError(EXIT.INTERNAL, `installExtension returned id ${id} but browser.extensions() does not list it.`);
  return ext;
}

/**
 * Runs code inside the extension's service worker. Functions passed to `run` are serialised, so they must be
 * self-contained and should catch their own errors and return `{error}`: a throw is treated as a dead worker.
 * An attached CDP session keeps an MV3 worker alive, so one handle is held for the whole run (re-acquired if it dies).
 */
export class Bridge {
  constructor(browser, ext) {
    this.browser = browser;
    this.ext = ext;
    this.worker = null;
    this.errors = [];
  }

  async acquire(timeout = 15000) {
    let w = (await this.ext.workers())[0];
    if (!w) {
      const prefix = `chrome-extension://${this.ext.id}/`;
      const target = await this.browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().startsWith(prefix), { timeout }).catch(() => null);
      w = target ? await target.worker() : null;
    }
    if (!w) throw new HarnessError(EXIT.INTERNAL, 'the extension service worker is not running (open chrome://extensions in a normal Chrome and check the extension for load errors).');
    if (w !== this.worker) {
      this.worker = w;
      w.on('console', (m) => { if (['error', 'warn', 'warning'].includes(m.type())) this.errors.push(`${m.type()}: ${m.text().slice(0, 300)}`); });
      w.on('error', (e) => this.errors.push(`uncaught: ${String(e && e.message).slice(0, 300)}`));
    }
    return w;
  }

  async run(fn, ...args) {
    for (let attempt = 0; ; attempt++) {
      const w = this.worker || (await this.acquire());
      try {
        return await withTimeout(w.evaluate(fn, ...args), 15000, 'service worker call');
      } catch (err) {
        if (err instanceof HarnessError || attempt >= 1) throw err;
        this.worker = null;
      }
    }
  }
}

// --- functions that run inside the service worker -------------------------------------------------------------------

export async function swSeed(entries) {
  try {
    await chrome.storage.local.set(entries);
    return { ok: true, stored: await chrome.storage.local.get(Object.keys(entries)) };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

/** Sets cd.settings.themeId; `t` is Date.now() taken right before the write (same clock as the page). */
export async function swSetTheme(themeId) {
  try {
    const cur = (await chrome.storage.local.get('cd.settings'))['cd.settings'] || {};
    const t = Date.now();
    await chrome.storage.local.set({ 'cd.settings': { ...cur, themeId } });
    return { ok: true, t };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

export async function swStatus(prefix) {
  try {
    const tabs = await chrome.tabs.query({ url: 'https://www.youtube.com/*' });
    const tab = tabs.find((x) => x.url && x.url.startsWith(prefix)) || tabs[0];
    if (!tab) return { error: 'no youtube tab found' };
    return { reply: await chrome.tabs.sendMessage(tab.id, { type: 'cd:getStatus' }) };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

/**
 * Forces YouTube's own colour mode for the next navigations of `page`. YouTube keeps the theme in the PREF cookie
 * (f6=400 = dark, f6=80000 = light; verified on Chrome 154: html[dark] appears/disappears accordingly). The cookie is set before
 * navigation; prefers-color-scheme is emulated to the same value so a "device theme" fallback cannot disagree with it.
 * The page's real mode is still read back from html[dark] afterwards (the `mode-forced` check).
 */
export async function setYouTubeMode(browser, page, mode) {
  // Leave youtube.com first: its unload handler writes the OLD theme back into PREF, which would undo the cookie set below.
  await page.goto('about:blank').catch(() => {});
  // YouTube rewrites PREF itself (host-only copy next to ours): drop every existing copy first so only one value is sent.
  const jar = typeof browser.cookies === 'function' ? await browser.cookies() : await page.cookies('https://www.youtube.com/');
  const stale = jar.filter((c) => c.name === 'PREF' && /(^|\.)youtube\.com$/.test(c.domain));
  if (stale.length) {
    if (typeof browser.deleteCookie === 'function') await browser.deleteCookie(...stale);
    else await page.deleteCookie(...stale);
  }
  const cookie = { name: 'PREF', value: `f6=${mode === 'dark' ? '400' : '80000'}&tz=UTC`, domain: '.youtube.com', path: '/', secure: true };
  if (typeof browser.setCookie === 'function') await browser.setCookie(cookie);
  else await page.setCookie(cookie);
  await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: mode }]);
}
