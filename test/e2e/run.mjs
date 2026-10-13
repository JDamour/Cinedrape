// Real-browser e2e harness: loads the built extension into the installed Google Chrome and exercises live youtube.com
// (logged out). Not a unit test (the file name does not match *.test.js). See test/e2e/README.md.
//
//   node test/e2e/run.mjs [--extension dist] [--themes all|cinema,minimal,...] [--pages home,watch,search,channel]
//                         [--mode light|dark|both] [--pro] [--calm] [--viewport 1440x900] [--out test/e2e/out] [--headed]
//                         [--no-perf] [--shots all|view|none] [--offenders 15]
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { Bridge, createSession, findChrome, installExtension, launchChrome, setYouTubeMode, sleep, swSeed, swSetTheme, swStatus, validateExtension, withTimeout } from './lib/browser.mjs';
import { AUDIT_DEFAULTS, auditPage, gateChecks } from './lib/audit.mjs';
import { EXIT, FALLBACK, HarnessError, PAGES, REPO_ROOT, parseCli } from './lib/cli.mjs';
import { adCheck, armSwitch, detectWall, initScript, pauseMedia, probePage } from './lib/probes.mjs';
import { buildReport, summarise, writeReports } from './lib/report.mjs';

const execFileP = promisify(execFile);
let forcedExit = null; // set by the signal / global-timeout path so the interrupted main flow cannot override its exit code
const FALLBACK_ADS = ['ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', 'ytd-display-ad-renderer', 'ytd-promoted-sparkles-web-renderer', 'ytd-promoted-video-renderer',
  'ytd-banner-promo-renderer', 'ytd-statement-banner-renderer', '.video-ads', '.ytp-ad-module', '.ytp-paid-content-overlay', '.ytp-suggested-action'];

/** Theme ids and calm keys come from the contract (src/shared/constants.js) so the harness cannot drift; literals are the fallback. */
async function loadCatalogue() {
  const out = { ...FALLBACK, calmKeys: ['hideShorts', 'hideHomeRecs', 'hideComments', 'hideEndScreens', 'hideViewCounts', 'hideLive'] };
  try {
    const c = await import(pathToFileURL(join(REPO_ROOT, 'src', 'shared', 'constants.js')).href);
    if (Array.isArray(c.ALL_THEME_IDS)) out.allThemes = c.ALL_THEME_IDS;
    if (Array.isArray(c.FREE_THEME_IDS)) out.freeThemes = c.FREE_THEME_IDS;
    if (Array.isArray(c.CALM_KEYS)) out.calmKeys = c.CALM_KEYS;
  } catch { /* use fallbacks */ }
  return out;
}

function loadAdSelectors() {
  try {
    const m = JSON.parse(readFileSync(join(REPO_ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
    const list = [...(m.protected.ads || []), ...(m.protected.sponsor || [])];
    if (list.length) return list;
  } catch { /* use fallback */ }
  return FALLBACK_ADS;
}

/** Mints a dev Pro licence by running tools/dev-licence.mjs (token on stdout, banner on stderr). */
async function mintLicence() {
  let stdout;
  try {
    ({ stdout } = await execFileP(process.execPath, [join(REPO_ROOT, 'tools', 'dev-licence.mjs'), '--plan', 'pro', '--days', '30'], { cwd: REPO_ROOT, timeout: 20000, windowsHide: true }));
  } catch (err) {
    const why = String((err && err.stderr) || (err && err.message) || err).trim().split(/\r?\n/).pop();
    throw new HarnessError(EXIT.ENVIRONMENT, `--pro: could not mint a dev licence (${why}). Generate the dev keys first: npm run keys`);
  }
  const token = String(stdout).trim().split(/\r?\n/).filter(Boolean).pop() || '';
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p))) throw new HarnessError(EXIT.ENVIRONMENT, '--pro: tools/dev-licence.mjs did not print a licence token on stdout.');
  let claims;
  try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { throw new HarnessError(EXIT.ENVIRONMENT, '--pro: the dev licence token has unreadable claims.'); }
  return { token, claims, checkedAt: Date.now() };
}

const settingsFor = (themeId, calmKeys, calmOn) => ({
  schema: 1, themeId, accent: null, density: null, animations: true,
  calm: Object.fromEntries(calmKeys.map((k) => [k, calmOn])), telemetryOptIn: false,
});

function recordConsole(sink, kind, text, url, stack) {
  if (!sink.current) return;
  const extension = String(url || '').startsWith('chrome-extension://') || String(stack || '').includes('chrome-extension://')
    || /cinedrape/i.test(text) || (/Content Security Policy/i.test(text) && /style-src|inline style|stylesheet/i.test(text));
  const bucket = extension ? sink.current.extension : sink.current.page;
  const hit = bucket.find((e) => e.kind === kind && e.text === text);
  if (hit) hit.count += 1;
  else if (bucket.length < 30) bucket.push({ kind, text: text.slice(0, 300), url: String(url || '').slice(0, 160), count: 1 });
}

async function makePage(ctx) {
  const page = await ctx.browser.newPage();
  await page.evaluateOnNewDocument(initScript);
  const sink = { current: null };
  page.on('console', (m) => {
    if (['error', 'warn', 'warning'].includes(m.type())) {
      const loc = m.location();
      recordConsole(sink, m.type() === 'error' ? 'error' : 'warning', m.text(), loc && loc.url, '');
    }
  });
  page.on('pageerror', (e) => recordConsole(sink, 'error', `uncaught: ${e && e.message}`, '', e && e.stack));
  page.on('error', (e) => recordConsole(sink, 'error', `page crashed: ${e && e.message}`, '', ''));
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  await cdp.send('HeapProfiler.enable').catch(() => {});
  ctx.page = page; ctx.cdp = cdp; ctx.sink = sink;
}

async function replacePage(ctx) {
  const old = ctx.page;
  await makePage(ctx);
  if (old) await old.close().catch(() => {});
}

async function heapSnapshot(cdp) {
  await cdp.send('HeapProfiler.collectGarbage').catch(() => {});
  const { metrics } = await withTimeout(cdp.send('Performance.getMetrics'), 10000, 'Performance.getMetrics');
  const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
  return { usedMB: m.JSHeapUsedSize / 1048576, nodes: m.Nodes, scriptSec: m.ScriptDuration, taskSec: m.TaskDuration };
}

async function navigate(page, url, timeoutMs) {
  let last;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
      const status = resp ? resp.status() : null;
      if (status !== null && status >= 400) throw new Error(`HTTP ${status}`);
      return status;
    } catch (err) {
      last = err;
      await sleep(2000);
    }
  }
  throw new HarnessError(EXIT.NETWORK, `network failure: could not load ${url} (${last && last.message}). Check the connection, then retry.`);
}

async function wallGuard(page, url) {
  const wall = await page.evaluate(detectWall).catch(() => null);
  if (!wall) return;
  const what = {
    consent: 'a cookie/consent wall (the harness never accepts consent dialogs; run from a network where logged-out YouTube loads directly, or accept it once manually in a separate profile)',
    captcha: 'a CAPTCHA / unusual-traffic page (the harness does not attempt to pass bot checks; wait and retry, or use another network)',
    redirect: 'a redirect away from youtube.com',
  }[wall.kind];
  throw new HarnessError(EXIT.NETWORK, `YouTube served ${what} for ${url}: ${wall.detail}`);
}

async function waitSettled(ctx, minMs, maxMs, prefix) {
  const t0 = Date.now();
  await sleep(1000);
  let status = null;
  let last = null;
  let stable = 0;
  for (;;) {
    status = await ctx.bridge.run(swStatus, prefix);
    const key = JSON.stringify(status);
    stable = key === last ? stable + 1 : 0;
    last = key;
    const elapsed = Date.now() - t0;
    if ((stable >= 2 && elapsed >= minMs) || elapsed >= maxMs) return status;
    await sleep(500);
  }
}

/** Triggers a theme change through the service worker and measures how long the page takes to follow. */
async function measureSwitch(ctx, page, setTo, expectAttr) {
  await page.evaluate(armSwitch, expectAttr, 5000);
  const wrote = await ctx.bridge.run(swSetTheme, setTo);
  if (!wrote || wrote.error) return { ok: false, setTo, error: wrote && wrote.error };
  const r = await withTimeout(page.evaluate(() => window.__cdSwitch), 9000, 'theme-switch watcher');
  const done = r.tAttr !== null && r.tStyle !== null;
  return {
    ok: done && !r.timedOut, setTo, expectAttr, finalAttr: r.attr,
    attrMs: r.tAttr === null ? null : r.tAttr - wrote.t, styleMs: r.tStyle === null ? null : r.tStyle - wrote.t,
    ms: done ? Math.max(r.tAttr, r.tStyle) - wrote.t : null,
  };
}

async function visit(ctx, res) {
  const { opts, page, cdp, sink } = ctx;
  const def = PAGES[res.page];
  const add = (name, ok, detail, level = 'fail') => res.checks.push({ name, ok: Boolean(ok), level, detail: ok ? undefined : detail });
  const base = `${res.theme}-${res.page}-${res.mode}`;
  sink.current = { extension: [], page: [] };
  const t0 = Date.now();

  const seeded = await ctx.bridge.run(swSeed, { 'cd.settings': settingsFor(res.theme, ctx.catalogue.calmKeys, opts.calm) });
  const stored = seeded && seeded.stored && seeded.stored['cd.settings'];
  add('storage-seeded', stored && stored.themeId === res.theme, `seed failed: ${seeded && seeded.error}`);

  await setYouTubeMode(ctx.browser, page, res.mode);
  res.httpStatus = await navigate(page, def.url, Math.min(45000, Math.floor(opts.pageTimeoutMs / 2)));
  await wallGuard(page, def.url);
  res.ready = await page.waitForSelector(def.ready.join(', '), { timeout: 20000 }).then(() => true, () => false);
  await wallGuard(page, def.url);
  res.status = await waitSettled(ctx, Math.min(opts.settleMs, 6500), opts.settleMs, 'https://www.youtube.com/');

  const snap = await page.evaluate(probePage, def.title);
  Object.assign(res, { finalUrl: snap.url, attrs: snap.attrs, style: snap.style, colors: snap.colors, paint: snap.paint, timings: snap.timings, playerError: snap.playerError });
  res.modeActual = Object.hasOwn(snap.attrs, 'dark') ? 'dark' : 'light';

  await page.evaluate(pauseMedia).catch(() => {});
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  res.audit = await withTimeout(page.evaluate(auditPage, { ...AUDIT_DEFAULTS, offenders: opts.offenders }), 30000, 'readability audit');

  const shot = async (suffix, full) => {
    const file = `${base}${suffix}.png`;
    try {
      const opt = { path: join(opts.out, file), type: 'png' };
      if (full) {
        opt.clip = { x: 0, y: 0, width: opts.viewport.width, height: Math.max(opts.viewport.height, Math.min(snap.scrollHeight, 12000)) };
        opt.captureBeyondViewport = true;
      }
      await withTimeout(page.screenshot(opt), 30000, `screenshot ${file}`);
      res.screenshots.push(file);
    } catch (err) {
      add(`screenshot${suffix}`, false, err.message, 'warn');
    }
  };
  if (opts.shots !== 'none') await shot('', false);
  if (def.full && opts.shots === 'all') {
    await shot('-full', true);
    await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  }

  const applied = ctx.pro || ctx.catalogue.freeThemes.includes(res.theme) ? res.theme : 'cinema';
  res.locked = applied !== res.theme;
  const pool = ctx.pro ? ctx.catalogue.allThemes : ctx.catalogue.freeThemes;
  const other = pool.find((id) => id !== applied);
  res.ads = await page.evaluate(adCheck, ctx.adSelectors);
  if (opts.perf) {
    const heapBefore = await heapSnapshot(cdp);
    res.switch = await measureSwitch(ctx, page, other, other);
    res.switchBack = await measureSwitch(ctx, page, res.theme, applied);
    await sleep(300);
    const heapAfter = await heapSnapshot(cdp);
    res.heap = {
      beforeMB: heapBefore.usedMB, afterMB: heapAfter.usedMB, deltaMB: heapAfter.usedMB - heapBefore.usedMB,
      nodesBefore: heapBefore.nodes, nodesAfter: heapAfter.nodes,
      scriptSecDuringSwitch: heapAfter.scriptSec - heapBefore.scriptSec, taskSecDuringSwitch: heapAfter.taskSec - heapBefore.taskSec,
    };
  }
  res.console = sink.current;
  sink.current = null;
  res.durationMs = Date.now() - t0;

  // --- checks (level 'fail' decides the exit code; 'warn' is reported only) ---
  const st = res.status && res.status.reply;
  add('style-element', res.style.exists ? res.style.bytes > 0 && res.style.copies === 1 : res.style.adoptedSheets > 0,
    `#cinedrape-theme ${res.style.exists ? `has ${res.style.bytes} bytes and ${res.style.copies} copies` : 'is missing and no adopted stylesheet exists'}`);
  add('theme-attr', res.attrs['cd-theme'] === applied, `html[cd-theme] is ${JSON.stringify(res.attrs['cd-theme'])}, expected ${JSON.stringify(applied)}${res.locked ? ' (Pro theme on a free licence falls back to cinema)' : ''}`);
  add('status-reply', st && typeof st === 'object' && typeof st.themeId === 'string', `GET_STATUS gave no usable reply: ${JSON.stringify(res.status).slice(0, 200)}`);
  if (st && typeof st === 'object') {
    add('status-theme', st.themeId === applied, `GET_STATUS themeId ${JSON.stringify(st.themeId)}, expected ${JSON.stringify(applied)}`);
    add('status-pro', opts.pro ? st.pro === true : st.pro !== true, `GET_STATUS pro=${st.pro} but the run is ${opts.pro ? 'Pro' : 'free'}`, opts.pro ? 'fail' : 'warn');
    add('status-page', st.pageType === res.page, `GET_STATUS pageType ${JSON.stringify(st.pageType)}, expected ${JSON.stringify(res.page)}`, 'warn');
    const broken = Object.entries(st.features || {}).filter(([, v]) => v === 'broken').map(([k]) => k);
    add('features-healthy', broken.length === 0, `features reported broken: ${broken.join(', ')}; missing roles: ${(st.missingRoles || []).join(', ')}`, 'warn');
  }
  if (opts.perf) {
    add('theme-switch', res.switch.ok, `switching to ${other} did not complete in 5 s: ${JSON.stringify(res.switch)}`);
    add('theme-switch-back', res.switchBack.ok, `switching back to ${res.theme} did not complete in 5 s: ${JSON.stringify(res.switchBack)}`);
    add('theme-switch-fast', !res.switch.ok || res.switch.ms <= 1000, `theme switch took ${res.switch.ms} ms (contract: within 1000 ms)`, 'warn');
  }
  // --- readability gate (README.md): fails the run when more than GATE.maxFail3Pct of the sampled elements are below 3:1, or any title is below 4.5:1 ---
  const a = res.audit;
  add('mode-forced', res.modeActual === res.mode, `asked for YouTube ${res.mode} mode but html${res.modeActual === 'dark' ? '' : ' has no'}[dark] says ${res.modeActual} (PREF cookie f6 not honoured)`);
  for (const c of gateChecks(a, { minSampled: def.minSampled })) add(c.name, c.ok, c.detail, c.level);
  add('ads-visible', res.ads.violationCount === 0, `ad/sponsor nodes hidden by the extension stylesheet: ${JSON.stringify(res.ads.violations)}`);
  add('no-ext-console-errors', !res.console.extension.some((e) => e.kind === 'error'), res.console.extension.filter((e) => e.kind === 'error').map((e) => e.text).join(' || '));
  add('no-ext-console-warnings', !res.console.extension.some((e) => e.kind === 'warning'), res.console.extension.filter((e) => e.kind === 'warning').map((e) => e.text).join(' || '), 'warn');
  add('page-ready', res.ready, `none of ${def.ready.join(' | ')} appeared within 20 s (logged-out YouTube may have served a different page)`, 'warn');
  const fpOk = res.timings.styleFilledAt !== null && typeof res.paint.fp === 'number' ? res.timings.styleFilledAt <= res.paint.fp : true;
  add('style-before-first-paint', fpOk, `style first filled at ${res.timings.styleFilledAt} ms, first paint at ${res.paint.fp} ms (first-paint cache ${res.timings.firstPaintCache ? 'present' : 'absent'})`, 'warn');
  if (res.colors.title && res.colors.title.contrast !== null) add('title-contrast', res.colors.title.contrast >= 4.5, `title contrast ${res.colors.title.contrast}:1 (${res.colors.title.text} on ${res.colors.title.effectiveBg})`, 'warn');
  if (opts.perf) add('heap-growth', res.heap.afterMB <= res.heap.beforeMB * 1.5 + 16, `JS heap grew from ${res.heap.beforeMB.toFixed(1)} to ${res.heap.afterMB.toFixed(1)} MB across two theme switches`, 'warn');
  if (res.playerError) add('player-error', false, `player shows: ${res.playerError}`, 'warn');
}

async function main() {
  const startedAt = new Date();
  const catalogue = await loadCatalogue();
  const opts = parseCli(process.argv.slice(2), catalogue);
  if (opts.help) { console.log(opts.help); return EXIT.OK; }

  const manifest = validateExtension(opts.extension);
  const chromePath = findChrome(opts.chrome);
  let puppeteer;
  try { ({ default: puppeteer } = await import('puppeteer-core')); } catch (err) { throw new HarnessError(EXIT.ENVIRONMENT, `puppeteer-core is not installed (npm install): ${err.message}`); }
  const licence = opts.pro ? await mintLicence() : null;
  mkdirSync(opts.out, { recursive: true });

  const session = createSession();
  process.on('exit', () => session.disposeSync());
  const results = [];
  const meta = {
    startedAt: startedAt.toISOString(), durationMs: 0, node: process.version, chromePath, chromeVersion: null, headed: opts.headed, viewport: opts.viewport,
    pro: opts.pro, calm: opts.calm, licence: licence ? { plan: licence.claims.plan, sub: licence.claims.sub, exp: licence.claims.exp || null } : null, themes: opts.themes, pages: opts.pages, modes: opts.modes, perf: opts.perf, extension: { path: opts.extension, name: manifest.name, version: manifest.version, id: null },
    serviceWorkerErrors: [],
  };
  let abort = null;
  let ending = false;
  const finish = async (code, message) => {
    if (ending) return code;
    ending = true;
    meta.durationMs = Date.now() - startedAt.getTime();
    if (code !== EXIT.OK && code !== EXIT.CHECKS_FAILED) abort = { exitCode: code, message };
    try { writeReports(opts.out, buildReport(meta, results, abort)); } catch (err) { process.stderr.write(`could not write the report: ${err.message}\n`); }
    await session.dispose();
    return code;
  };
  const hard = (code, message) => {
    forcedExit = code;
    process.stderr.write(`${message}\n`);
    setTimeout(() => process.exit(code), 20000).unref();
    finish(code, message).then(() => process.exit(code));
  };
  const globalTimer = setTimeout(() => hard(EXIT.TIMEOUT, `global timeout: the run exceeded ${opts.totalTimeoutMs} ms`), opts.totalTimeoutMs);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => hard(130, `interrupted by ${sig}`));
  process.on('unhandledRejection', (err) => hard(EXIT.INTERNAL, `unhandled rejection: ${err && err.stack ? err.stack : err}`));

  const ctx = { opts, catalogue, pro: opts.pro, adSelectors: loadAdSelectors(), browser: null, bridge: null, page: null, cdp: null, sink: null };
  try {
    ctx.browser = await launchChrome(puppeteer, { chromePath, headed: opts.headed, viewport: opts.viewport, profile: session.profile, extraArgs: opts.chromeArgs });
    session.attach(ctx.browser);
    meta.chromeVersion = await ctx.browser.version();
    const ext = await installExtension(ctx.browser, opts.extension);
    meta.extension.id = ext.id;
    ctx.bridge = new Bridge(ctx.browser, ext);
    await ctx.bridge.acquire();
    await sleep(1000); // let onInstalled handlers finish before seeding over them
    const initial = { 'cd.settings': settingsFor(opts.themes[0], catalogue.calmKeys, opts.calm) };
    if (licence) initial['cd.licence'] = licence;
    const seeded = await ctx.bridge.run(swSeed, initial);
    if (!seeded || seeded.error) throw new HarnessError(EXIT.INTERNAL, `could not seed chrome.storage.local through the service worker: ${seeded && seeded.error}`);
    await makePage(ctx); // open ours before closing the initial blank tab: closing the last tab closes a headed browser
    for (const p of await ctx.browser.pages()) if (p !== ctx.page) await p.close().catch(() => {});
    console.log(`Chrome ${meta.chromeVersion} (${opts.headed ? 'headed' : 'headless'}), extension ${manifest.name} ${manifest.version} [${ext.id}], ${opts.themes.length} theme(s) x ${opts.pages.length} page(s) x ${opts.modes.length} mode(s) [${opts.modes.join(',')}], ${opts.pro ? 'Pro' : 'free'} licence`);

    const total = opts.themes.length * opts.pages.length * opts.modes.length;
    for (const theme of opts.themes) {
      for (const pageName of opts.pages) {
       for (const mode of opts.modes) {
        const res = { theme, page: pageName, mode, url: PAGES[pageName].url, screenshots: [], checks: [] };
        results.push(res);
        process.stdout.write(`[${results.length}/${total}] ${theme}/${pageName}/${mode} ... `);
        try {
          await withTimeout(visit(ctx, res), opts.pageTimeoutMs, `${theme}/${pageName}/${mode}`);
        } catch (err) {
          if (err instanceof HarnessError && err.exitCode !== EXIT.TIMEOUT) { res.error = { message: err.message }; console.log('ABORT'); throw err; }
          res.error = { message: err && err.message ? err.message : String(err) };
          await replacePage(ctx).catch(() => {});
        }
        const failed = res.error || res.checks.some((c) => !c.ok && c.level !== 'warn');
        const warned = res.checks.filter((c) => !c.ok && c.level === 'warn').length;
        const au = res.audit ? ` n=${res.audit.sampled} <3:1 ${res.audit.pct3}% titles ${res.audit.titles.fail45}/${res.audit.titles.count}` : '';
        console.log(`${failed ? 'FAIL' : 'ok'}${warned ? ` (${warned} warn)` : ''}${au} ${res.durationMs ? `${(res.durationMs / 1000).toFixed(1)}s` : ''}${res.error ? ` ${res.error.message}` : ''}`);
       }
      }
    }
    meta.serviceWorkerErrors = ctx.bridge.errors.slice(0, 20);
    const summary = summarise(results);
    clearTimeout(globalTimer);
    const code = summary.failures.length ? EXIT.CHECKS_FAILED : EXIT.OK;
    await finish(code, '');
    console.log(`\n${summary.visits} visit(s), ${summary.failures.length} failed check(s), ${summary.warnings.length} warning(s). Report: ${join(opts.out, 'report.md')}`);
    for (const f of summary.failures.slice(0, 15)) console.log(`  FAIL ${f.theme}/${f.page}/${f.mode} ${f.check}: ${String(f.detail).slice(0, 200)}`);
    return code;
  } catch (err) {
    clearTimeout(globalTimer);
    if (ctx.bridge) meta.serviceWorkerErrors = ctx.bridge.errors.slice(0, 20);
    const code = err instanceof HarnessError ? err.exitCode : EXIT.INTERNAL;
    const message = err instanceof HarnessError ? err.message : `internal error: ${err && err.stack ? err.stack : err}`;
    await finish(code, message);
    throw err instanceof HarnessError ? err : new HarnessError(code, message);
  }
}

main().then(
  (code) => process.exit(forcedExit ?? code),
  (err) => {
    if (forcedExit === null) process.stderr.write(`e2e: ${err && err.message ? err.message : err}\n`);
    process.exit(forcedExit ?? (err instanceof HarnessError ? err.exitCode : EXIT.INTERNAL));
  },
);
