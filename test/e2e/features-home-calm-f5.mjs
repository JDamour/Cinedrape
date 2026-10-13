// F5 (calm mode) on real logged-out youtube.com: every toggle alone, all together, survival across SPA navigation, apply latency,
// free-vs-Pro gating and protected nodes. Imported by features-home-calm-phases.mjs (runAll) after F3.
//
// Method: "what did the toggle hide" is read from the page as a diff of rendered state (an element is rendered when it has client
// rects, or is display:contents under a rendered parent) between a snapshot taken with all toggles off and the page with the toggle
// on. Elements that change state on their own are measured first (noise) and ignored. The roots of the diff are then judged by an
// oracle written independently of the extension's selectors (see features-home-calm-page.mjs): intended, or over-reach.
import { CALM_KEYS, clickFirstTileToWatch, clickLogo, gotoPopulatedHome, gotoWatch, sleep, swRemove, wallGuard } from './features-home-calm-lib.mjs';
import { swSeed } from './lib/browser.mjs';
import { H, MAP, PROTECTED, check, info, prepPage, protectedDiff, step, until } from './features-home-calm-phases.mjs';

const P = 'F5';
const ALL_OFF = Object.fromEntries(CALM_KEYS.map((k) => [k, false]));
const ALL_ON = Object.fromEntries(CALM_KEYS.map((k) => [k, true]));
const attrOf = (k) => `cd-calm-${k}`;

async function goto(ctx, url, readySel) {
  const { page } = ctx;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await wallGuard(page, url);
  await until(page, (sel) => document.querySelectorAll(sel).length > 2, readySel, 25000);
}

async function visit(ctx, name) {
  const { page } = ctx;
  if (name === 'home') {
    await gotoPopulatedHome(ctx);
  } else if (name === 'search') {
    await goto(ctx, 'https://www.youtube.com/results?search_query=nature+documentary', 'ytd-video-renderer, yt-lockup-view-model');
  } else if (name === 'channel') {
    await goto(ctx, 'https://www.youtube.com/@NatGeo/videos', 'yt-lockup-view-model');
  } else if (name === 'channel-shorts') {
    await goto(ctx, 'https://www.youtube.com/@NatGeo/shorts', 'ytm-shorts-lockup-view-model-v2, a[href^="/shorts/"]');
  } else if (name === 'watch') {
    await gotoWatch(ctx);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await until(page, () => { const c = document.querySelector('ytd-comments#comments'); return !!c && c.getClientRects().length > 0; }, null, 15000);
    await sleep(1500);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await prepPage(ctx);
  await sleep(1800);
  await settle(page);
}

/** Tries to reach the real end screen (seek near the end); otherwise puts two clearly-labelled synthetic end-card nodes in the player. */
async function endScreenSetup(ctx) {
  const { page } = ctx;
  const real = await page.evaluate(async () => {
    const v = document.querySelector('#movie_player video');
    if (!v || !Number.isFinite(v.duration) || v.duration < 15) return { seeked: false, duration: v ? v.duration : null };
    v.muted = true;
    v.currentTime = v.duration - 8;
    try { await v.play(); } catch { /* autoplay refused */ }
    await new Promise((r) => setTimeout(r, 6000));
    const n = document.querySelectorAll('.ytp-ce-element, .ytp-endscreen-content').length;
    const shown = Array.from(document.querySelectorAll('.ytp-ce-element, .ytp-endscreen-content')).filter((e) => e.getClientRects().length > 0).length;
    v.pause(); // stay near the end: letting it finish would autoplay the next video and navigate away
    return { seeked: true, duration: v.duration, t: v.currentTime, found: n, shown };
  });
  info(P, 'end-screen-real-attempt', real);
  if (real.seeked && real.shown > 0) return { source: 'real', ...real };
  await page.evaluate(() => {
    const host = document.querySelector('#movie_player');
    for (const [cls, left] of [['ytp-ce-element ytp-ce-video cd-e2e-synthetic', 20], ['ytp-ce-element ytp-ce-channel cd-e2e-synthetic', 180]]) {
      const d = document.createElement('div');
      d.className = cls;
      d.style.cssText = `position:absolute;left:${left}px;top:20px;width:140px;height:80px;z-index:40;background:#333`;
      d.textContent = 'synthetic end card';
      host.appendChild(d);
    }
  });
  return { source: 'synthetic' };
}

/** Waits until the page stops changing (node count and rendered count equal for three samples 450 ms apart, at most 14 s). */
async function settle(page) {
  await freezeVideo(page);
  let prev = '';
  let same = 0;
  const t0 = Date.now();
  while (same < 3 && Date.now() - t0 < 14000) {
    const cur = JSON.stringify(await H(page, 'counts').catch(() => null));
    same = cur === prev ? same + 1 : 0;
    prev = cur;
    await sleep(450);
  }
  return Date.now() - t0;
}

async function freezeVideo(page) {
  await page.evaluate(() => { const v = document.querySelector('#movie_player video'); if (v) { v.muted = true; if (!v.paused) v.pause(); } }).catch(() => {});
}

const LAT = [];

async function allOff(ctx) {
  const { page } = ctx;
  await ctx.set({ calm: ALL_OFF });
  await until(page, (keys) => keys.every((k) => !document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS, 4000);
  await sleep(350);
}

async function runToggle(ctx, pageName, key, label = pageName) {
  const { page } = ctx;
  await allOff(ctx);
  await freezeVideo(page);
  await H(page, 'snap', 'base');
  await sleep(700);
  const noise = await H(page, 'learnNoise', 'base');
  const present = (await H(page, 'missed', key)).length;
  const dv0 = await H(page, 'datesAndViews');
  const target = await H(page, 'target', key);
  const attr = attrOf(key);
  await page.evaluate(() => { window.__cdWantOn = true; });
  const watcher = page.evaluate((a) => window.__cdh.effectWatch(a, 4000), attr);
  await sleep(350);
  const t = await ctx.set({ calm: { [key]: true } });
  const w = await watcher;
  await sleep(450);
  const m = await H(page, 'measure', key, 'base');
  const dv1 = await H(page, 'datesAndViews');
  const extras = {};
  if (key === 'hideHomeRecs' && pageName === 'home') {
    extras.frame = await page.evaluate(() => {
      const r = (sel) => { const e = document.querySelector(sel); return e ? e.getClientRects().length > 0 : null; };
      const c = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents');
      const ph = c ? getComputedStyle(c, '::before') : null;
      const pm = document.querySelector('ytd-page-manager');
      return { masthead: r('ytd-masthead'), guide: r('tp-yt-app-drawer#guide, ytd-guide-renderer, ytd-mini-guide-renderer'), chips: r('ytd-feed-filter-chip-bar-renderer'), browse: r('ytd-browse[page-subtype="home"]'), grid: r('ytd-rich-grid-renderer'), pageManagerH: pm ? Math.round(pm.getBoundingClientRect().height) : 0, contentsH: c ? Math.round(c.getBoundingClientRect().height) : 0, placeholder: ph ? ph.content.slice(0, 40) : null, placeholderDisplay: ph ? ph.display : null };
    });
  }
  await page.evaluate(() => { window.__cdWantOn = false; });
  await ctx.set({ calm: { [key]: false } });
  await until(page, (a) => !document.documentElement.hasAttribute(a), attr, 4000);
  await sleep(450);
  const back = await H(page, 'measure', key, 'base');
  const applies = present > 0;
  let attrMs = w.tAttr ? w.tAttr - t : null;
  let effectMs = w.tEffect ? w.tEffect - t : null;
  let quick = attrMs !== null && attrMs < 1000 && (effectMs === null ? !applies : effectMs < 1000);

  // Best-of-3 for latency: a real regression slows every switch; cold-start or background CPU contention only some.
  for (let rep = 0; !quick && rep < 2 && applies; rep++) {
    await sleep(400);
    await page.evaluate(() => { window.__cdWantOn = true; });
    const watcher2 = page.evaluate((a) => window.__cdh.effectWatch(a, 4000), attr);
    await sleep(350);
    const t2 = await ctx.set({ calm: { [key]: true } });
    const w2 = await watcher2;
    await sleep(450);
    await page.evaluate(() => { window.__cdWantOn = false; });
    await ctx.set({ calm: { [key]: false } });
    await until(page, (a) => !document.documentElement.hasAttribute(a), attr, 4000);
    await sleep(450);
    const aMs2 = w2.tAttr ? w2.tAttr - t2 : null;
    const eMs2 = w2.tEffect ? w2.tEffect - t2 : null;
    if (aMs2 !== null && (attrMs === null || aMs2 < attrMs)) attrMs = aMs2;
    if (eMs2 !== null && (effectMs === null || eMs2 < effectMs)) effectMs = eMs2;
    quick = attrMs !== null && attrMs < 1000 && (effectMs === null ? !applies : effectMs < 1000);
  }
  const exact = applies ? m.extraCount === 0 && m.missedCount === 0 && m.hiddenRoots > 0 : m.hiddenRoots === 0;
  // Elements that merely became rendered meanwhile (lazy rendering) are reported as `gained`; restoring means nothing the toggle hid stays hidden.
  const restored = back.hiddenRoots === 0;
  const row = { present, hiddenRoots: m.hiddenRoots, hiddenElements: m.hiddenElements, intended: m.intended, overreach: m.extra, missed: m.missed, gained: m.gainedCount, noise, sample: m.sample, gainedSample: m.gained, attrMs, effectMs, restoredAfterOff: restored, target, ...extras };
  if (key === 'hideViewCounts') { row.views = [dv0.viewsShown, dv1.viewsShown]; row.agesShown = [dv0.agesShown, dv1.agesShown]; }
  const datesOk = key !== 'hideViewCounts' || dv1.agesShown === dv0.agesShown;
  const viewsOk = key !== 'hideViewCounts' || !applies || dv1.viewsShown === 0;
  // The frame stays: masthead, guide, chips and the grid are still laid out, and the grid holds the notice (its ::before is one block of >= 40 px).
  const fr = extras.frame;
  const frameOk = !fr || (fr.masthead !== false && fr.guide !== false && fr.browse !== false && fr.grid !== false && fr.chips !== false && fr.contentsH >= 40 && fr.pageManagerH >= fr.contentsH && /hidden/.test(fr.placeholder || ''));
  const why = [];
  if (applies ? m.extraCount !== 0 : m.hiddenRoots !== 0) why.push(applies ? 'overreach' : 'hid-something-that-is-not-there');
  if (applies && m.missedCount !== 0) why.push('intended-still-shown');
  if (applies && m.hiddenRoots === 0) why.push('nothing-hidden');
  if (!datesOk) why.push('ages-changed');
  if (!viewsOk) why.push('views-still-shown');
  if (!frameOk) why.push('frame-broken');
  row.why = why;
  check(P, `${label}:${key}:${applies ? 'hides-exactly-the-intended' : 'does-not-apply-nothing-hidden'}`, exact && datesOk && viewsOk && frameOk, row);
  LAT.push({ page: label, key, applies, attrMs, effectMs });
  check(P, `${label}:${key}:applies-within-1s-and-restores`, quick && restored, { attrMs, effectMs, restored, backGained: back.gainedCount });
  return { ...row, applies };
}

async function allTogether(ctx, pageName, keys, label = pageName) {
  const { page } = ctx;
  await H(page, 'clearLost');
  const results = {};
  for (const k of keys) results[k] = await runToggle(ctx, pageName, k, `${label}`);
  // All on at once; hidden set must be the union of the singles.
  await allOff(ctx);
  await freezeVideo(page);
  await H(page, 'snap', 'base');
  await sleep(700);
  await H(page, 'learnNoise', 'base');
  // re-measure each alone into LOST against this fresh baseline so the union is exact
  await H(page, 'clearLost');
  for (const k of keys) {
    await ctx.set({ calm: { [k]: true } });
    await until(page, (a) => document.documentElement.hasAttribute(a), attrOf(k), 3000);
    await sleep(350);
    await H(page, 'measure', k, 'base');
    await ctx.set({ calm: { [k]: false } });
    await until(page, (a) => !document.documentElement.hasAttribute(a), attrOf(k), 3000);
    await sleep(300);
  }
  const t = await ctx.set({ calm: ALL_ON });
  const lat = await until(page, (ks) => ks.every((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS, 3000);
  await sleep(600);
  const uni = await H(page, 'unionCheck', keys, 'base');
  check(P, `${label}:all-on-equals-union-of-singles`, !!lat && uni.onlyAllOnCount === 0 && uni.onlyAloneCount === 0, uni);
  return { results, t };
}

/** Real logged-out YouTube serves no ads, so an in-feed ad shell is placed in the home grid (clearly labelled, removed afterwards). */
async function addSyntheticAd(page) {
  return page.evaluate(() => {
    const c = document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents');
    if (!c) return false;
    const item = document.createElement('ytd-rich-item-renderer');
    item.setAttribute('cd-e2e-synthetic', '');
    const ad = document.createElement('ytd-ad-slot-renderer');
    ad.style.cssText = 'display:block;min-height:48px;min-width:200px';
    ad.textContent = 'Sponsored (synthetic e2e ad shell)';
    c.insertBefore(item, c.firstChild); // connected first: the upgrade of ytd-rich-item-renderer rebuilds its children
    item.appendChild(ad);
    return true;
  });
}
const readSyntheticAd = (page) => page.evaluate(() => {
  const ad = document.querySelector('[cd-e2e-synthetic] ytd-ad-slot-renderer');
  if (!ad) return null;
  const item = ad.parentElement;
  const out = [];
  for (let e = ad; e && e !== document.body; e = e.parentElement) { const cs = getComputedStyle(e); if (cs.display === 'none' || cs.visibility !== 'visible' || cs.opacity !== '1') out.push(e.tagName.toLowerCase() + ':' + cs.display + '/' + cs.visibility + '/' + cs.opacity); }
  const r = ad.getBoundingClientRect();
  return { rendered: ad.getClientRects().length > 0 && r.height >= 40 && r.width >= 100, itemRendered: item.getClientRects().length > 0, bad: out.slice(0, 4), h: Math.round(r.height), w: Math.round(r.width) };
});

async function protectedAllOn(ctx, label) {
  const { page } = ctx;
  const isHome = label.startsWith('home');
  if (isHome) await allOff(ctx);
  if (isHome) await sleep(800);
  const synth = isHome ? await addSyntheticAd(page) : false;
  const synthBefore = synth ? await readSyntheticAd(page) : null;
  await ctx.set({ calm: ALL_ON });
  await until(page, (ks) => ks.every((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS, 3000);
  await sleep(600);
  await page.mouse.move(500, 300);
  await sleep(300);
  await page.mouse.move(520, 320);
  await sleep(400);
  await page.mouse.move(10, 10);
  await sleep(300);
  const extra = ['#masthead-ad', 'ytd-ad-slot-renderer', 'ytd-in-feed-ad-layout-renderer', '.ytp-chrome-bottom', '.ytp-progress-bar-container', '.ytp-play-button', '.ytp-paid-content-overlay', '.ytp-ad-progress-list', '#player-ads', 'ytd-ads-engagement-panel-content-renderer', '.ytp-suggested-action'];
  const d = await protectedDiff(ctx, [...extra, ...PROTECTED]);
  const present = await page.evaluate((sels) => sels.map((s) => { try { return [s, document.querySelectorAll(s).length]; } catch { return [s, -1]; } }).filter((x) => x[1] > 0), extra);
  check(P, `${label}:all-toggles-on-protected-nodes-keep-their-styles`, d.hiddenByUs.length === 0 && d.fadedOrChanged.length === 0, { checked: d.checked, shownWith: d.shownWith, shownWithout: d.shownWithout, hiddenByUs: d.hiddenByUs, changed: d.fadedOrChanged, found: present.map((x) => x.join('=')).join(' ') });
  if (synth) {
    let synthAfter = await readSyntheticAd(page);
    let reinserted = false;
    if (!synthAfter) {
      // YouTube re-rendered its grid and dropped the foreign node: insert it again, now with every toggle already on.
      reinserted = true;
      await addSyntheticAd(page);
      await sleep(500);
      synthAfter = await readSyntheticAd(page);
    }
    check(P, `${label}:synthetic-in-feed-ad-stays-visible-with-all-toggles`, !!synthBefore && synthBefore.rendered && !!synthAfter && synthAfter.rendered && synthAfter.itemRendered && synthAfter.bad.length === 0, { before: synthBefore, after: synthAfter, reinsertedWithTogglesOn: reinserted }, 'real logged-out YouTube serves no ads: a labelled ad shell is injected into the grid');
    await page.evaluate(() => { for (const e of document.querySelectorAll('[cd-e2e-synthetic]')) e.remove(); });
  }
  return d;
}

async function matrixFor(ctx, pageName, keys) {
  await visit(ctx, pageName);
  if (pageName === 'watch') {
    const es = await endScreenSetup(ctx);
    info(P, 'end-screen-source', es);
  }
  const out = await allTogether(ctx, pageName, keys);
  await protectedAllOn(ctx, pageName);
  return out;
}

async function spaSurvival(ctx) {
  const { page } = ctx;
  await ctx.set({ themeId: 'classic', calm: ALL_ON });
  await visit(ctx, 'home');
  await until(page, (ks) => ks.every((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS, 3000);
  await sleep(800);
  const home1 = await page.evaluate((ks) => ({ attrs: ks.filter((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)).length, rec: window.__cdh.rendered('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer'), page: document.documentElement.getAttribute('cd-page') }), CALM_KEYS);
  // navigate to a watch page through the tile list is impossible (tiles are hidden): use the logo-less route, a real in-page link
  await page.evaluate(() => { window.__spa = 'alive'; });
  await page.evaluate(() => { const a = document.querySelector('a[href^="/watch"]'); if (a) a.click(); });
  const hasLink = await until(page, () => location.pathname === '/watch', null, 8000);
  let watch1 = null;
  if (hasLink) {
    await until(page, () => document.querySelector('ytd-watch-flexy:not([hidden]) #movie_player'), null, 20000);
    await sleep(2500);
    await page.evaluate(() => window.scrollTo(0, 1000));
    await sleep(2500);
    watch1 = await page.evaluate((ks) => ({ spa: window.__spa, attrs: ks.filter((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)).length, comments: window.__cdh.rendered('ytd-comments'), views: window.__cdh.datesAndViews(), page: document.documentElement.getAttribute('cd-page') }), CALM_KEYS);
    await page.evaluate(() => window.scrollTo(0, 0));
  }
  await page.evaluate(() => history.back());
  await until(page, () => location.pathname === '/', null, 10000);
  await sleep(3500);
  const home2 = await page.evaluate((ks) => ({ spa: window.__spa, attrs: ks.filter((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)).length, rec: window.__cdh.rendered('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer'), missedRecs: window.__cdh.missed('hideHomeRecs').length, shorts: window.__cdh.missed('hideShorts').length, views: window.__cdh.datesAndViews(), page: document.documentElement.getAttribute('cd-page') }), CALM_KEYS);
  info(P, 'spa-survival-readings', { home1, watch1, home2 });
  check(P, 'spa-survival:home-to-watch-to-back', home1.attrs === 6 && home1.rec === 0 && !!watch1 && watch1.spa === 'alive' && watch1.attrs === 6 && watch1.comments === 0 && watch1.views.viewsShown === 0 && home2.attrs === 6 && home2.missedRecs === 0 && home2.shorts === 0 && home2.views.viewsShown === 0, { home1, watch1, home2 });
}

async function gating(ctx) {
  const { page } = ctx;
  const P2 = 'F5';
  await ctx.set({ themeId: 'classic', calm: ALL_ON });
  await visit(ctx, 'watch');
  const readAttrs = () => page.evaluate((ks) => ks.filter((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS);
  await until(page, (ks) => ks.every((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), CALM_KEYS, 3000);
  const pro = await readAttrs();
  const proState = await page.evaluate(() => ({ comments: window.__cdh.rendered('ytd-comments'), views: window.__cdh.datesAndViews().viewsShown }));
  await ctx.bridge.run(swRemove, ['cd.licence']);
  await until(page, () => !document.documentElement.hasAttribute('cd-calm-hideComments'), null, 6000);
  await sleep(1200);
  const free = await readAttrs();
  const freeState = await page.evaluate(() => ({ comments: window.__cdh.rendered('ytd-comments'), views: window.__cdh.datesAndViews().viewsShown }));
  check(P2, 'gating:free-honours-only-shorts-and-home-recs-on-watch', free.length === 2 && free.includes('hideShorts') && free.includes('hideHomeRecs') && freeState.comments > 0 && freeState.views > 0 && pro.length === 6 && proState.comments === 0, { pro, proState, free, freeState });
  // free on home: the two free toggles still do their job
  await visit(ctx, 'home');
  await sleep(1500);
  const freeHome = await page.evaluate((ks) => ({ attrs: ks.filter((k) => document.documentElement.hasAttribute(`cd-calm-${k}`)), recs: window.__cdh.missed('hideHomeRecs').length, shorts: window.__cdh.missed('hideShorts').length, views: window.__cdh.datesAndViews().viewsShown }), CALM_KEYS);
  info(P2, 'gating:free-home-readings', freeHome, 'view counts stay visible for free users (hideViewCounts is Pro)');
  check(P2, 'gating:free-home-recs-and-shorts-hidden-view-counts-shown', freeHome.attrs.length === 2 && freeHome.recs === 0 && freeHome.shorts === 0, freeHome);
  await ctx.bridge.run(swSeed, { 'cd.licence': ctx.licence });
  const back = await until(page, () => document.documentElement.hasAttribute('cd-calm-hideViewCounts'), null, 8000);
  check(P2, 'gating:pro-restored-when-licence-returns', !!back, { hideViewCounts: !!back });
}

export async function runF5(ctx, { pages = null } = {}) {
  const want = (n) => !pages || pages.includes(n);
  await ctx.set({ themeId: 'classic', density: null, calm: ALL_OFF });
  const KEYS = CALM_KEYS;
  if (want('home')) await step(P, 'home-classic', () => matrixFor(ctx, 'home', KEYS));
  if (want('home') && want('cinema')) await step(P, 'home-cinema', async () => {
    // same page, the Cinedrape rows mounted: the mirror root and the mirrored view counts must follow the toggles too
    await ctx.set({ themeId: 'cinema', calm: ALL_OFF });
    await until(ctx.page, () => document.querySelectorAll('.cd-card').length > 0, null, 8000);
    await sleep(1000);
    await H(ctx.page, 'clearLost');
    const cards = () => ctx.page.evaluate(() => ({ cards: window.__cdh.rendered('.cd-card'), heroes: window.__cdh.rendered('.cd-hero'), root: window.__cdh.rendered('.cd-home'), grid: window.__cdh.rendered('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer') }));
    const c0 = await cards();
    await ctx.set({ calm: { hideHomeRecs: true } });
    await until(ctx.page, () => document.documentElement.hasAttribute('cd-calm-hidehomerecs'), null, 3000);
    await sleep(500);
    const c1 = await cards();
    await ctx.set({ calm: { hideHomeRecs: false } });
    await until(ctx.page, () => !document.documentElement.hasAttribute('cd-calm-hidehomerecs'), null, 3000);
    await sleep(500);
    const c2 = await cards();
    check(P, 'home-cinema:hideHomeRecs:mirrored-cards-and-hero-hidden-then-restored', c0.cards > 0 && c0.heroes > 0 && c1.cards === 0 && c1.heroes === 0 && c1.root === 0 && c1.grid === 0 && c2.cards === c0.cards && c2.heroes === c0.heroes && c2.root === c0.root, { before: c0, hidden: c1, restored: c2 });
    for (const k of ['hideHomeRecs', 'hideViewCounts', 'hideShorts', 'hideLive']) await runToggle(ctx, 'home', k, 'home-cinema');
    await protectedAllOn(ctx, 'home-cinema');
    await ctx.set({ themeId: 'classic', calm: ALL_OFF });
  });
  if (want('search')) await step(P, 'search', () => matrixFor(ctx, 'search', KEYS));
  if (want('channel')) await step(P, 'channel', () => matrixFor(ctx, 'channel', KEYS));
  if (want('channel-shorts')) await step(P, 'channel-shorts', () => matrixFor(ctx, 'channel-shorts', ['hideShorts', 'hideViewCounts']));
  if (want('watch')) await step(P, 'watch', () => matrixFor(ctx, 'watch', KEYS));
  if (want('spa')) await step(P, 'spa-survival', () => spaSurvival(ctx));
  if (want('gating')) await step(P, 'gating', () => gating(ctx));
  const att = LAT.filter((x) => x.applies && x.attrMs !== null).map((x) => x.attrMs).sort((a, b) => a - b);
  const eff = LAT.filter((x) => x.applies && x.effectMs !== null).map((x) => x.effectMs).sort((a, b) => a - b);
  const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.ceil((p / 100) * a.length) - 1)] : null);
  info(P, 'latency-summary', { toggles: LAT.length, attrMs: { n: att.length, p50: q(att, 50), p95: q(att, 95), max: att[att.length - 1] ?? null }, effectMs: { n: eff.length, p50: q(eff, 50), p95: q(eff, 95), max: eff[eff.length - 1] ?? null } });
  void MAP;
}
