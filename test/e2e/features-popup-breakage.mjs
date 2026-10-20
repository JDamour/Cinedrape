// Real-Chrome e2e for F4 (quick-settings popup), F6 (breakage detection), first paint, service-worker restart, licence ageing and the
// trust/privacy audit, on live logged-out youtube.com. Not a unit test (the name does not match *.test.js). Reads the shared harness in
// ./lib read-only; builds nothing: pass the extension directory built with
//   node build.mjs --strict --out dist-popup
// Usage: node test/e2e/features-popup-breakage.mjs [--extension dist-popup] [--out test/e2e/out/popup] [--phases f4,f6,paint,sw,licence,trust]
// The pages never send data out: everything is read through page.evaluate and the extension's service worker, in a temporary Chrome profile.
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import {
  CHANNEL_URL, DAY, REPO_ROOT, WATCH_URL, baseSettings, mintLicence, popupContrastAudit, popupLayoutProbe, probeEvents, resetProbe, signCustomLicence,
  loadSourceMap, signMap, sleep, startRun, swClear, swFetchControl, swGet, swManifest, swRemove, swSet, swStatus, tamperToken, usabilityProbe, variantMap, waitForEvent,
} from './popup-helpers.mjs';
import { detectWall } from './lib/probes.mjs';

const { values: argv } = parseArgs({ options: { extension: { type: 'string', default: 'dist-popup' }, out: { type: 'string', default: 'test/e2e/out/popup' }, phases: { type: 'string', default: 'f4,f6,paint,sw,licence,trust' } }, strict: false });
const OUT = resolve(REPO_ROOT, argv.out);
const PHASES = new Set(argv.phases.split(','));
mkdirSync(OUT, { recursive: true });

const R = { startedAt: new Date().toISOString(), extension: argv.extension, checks: [], metrics: {}, notes: [], shots: [], chrome: null };
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > 220 ? `${s.slice(0, 217)}...` : s; };
function check(phase, id, ok, detail = '') {
  R.checks.push({ phase, id, ok, detail: typeof detail === 'string' ? detail : JSON.stringify(detail) });
  console.log(`${ok === true ? 'PASS' : ok === 'warn' ? 'WARN' : 'FAIL'} [${phase}] ${id}${detail === '' ? '' : ` :: ${short(detail)}`}`);
}
const metric = (name, value) => { R.metrics[name] = value; console.log(`  . ${name} = ${short(value)}`); };
const note = (text) => { R.notes.push(text); console.log(`  note: ${text}`); };
const save = () => {
  writeFileSync(join(OUT, 'report.json'), JSON.stringify(R, null, 2));
  writeFileSync(join(OUT, 'report.md'), renderReport());
};

function renderReport() {
  const lines = [];
  const count = (f) => R.checks.filter(f).length;
  lines.push('# Popup, breakage detection and trust: real Chrome + live YouTube', '');
  lines.push(`Run ${R.startedAt}; extension \`${R.extension}\`; ${R.chrome || 'Chrome'}; logged-out youtube.com; temporary profile.`);
  lines.push(`Checks: ${count((c) => c.ok === true)} pass, ${count((c) => c.ok === 'warn')} warn, ${count((c) => c.ok === false)} fail.`, '');
  const phases = [...new Set(R.checks.map((c) => c.phase))];
  for (const p of phases) {
    lines.push(`## ${p}`, '', '| result | check | measured |', '|---|---|---|');
    for (const c of R.checks.filter((x) => x.phase === p)) lines.push(`| ${c.ok === true ? 'pass' : c.ok === 'warn' ? 'WARN' : '**FAIL**'} | ${c.id} | ${String(c.detail).replace(/\|/g, '/').replace(/\n/g, ' ').slice(0, 400)} |`);
    lines.push('');
  }
  lines.push('## Metrics', '', '| metric | value |', '|---|---|');
  for (const [k, v] of Object.entries(R.metrics)) lines.push(`| ${k} | ${String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\|/g, '/').slice(0, 600)} |`);
  lines.push('', '## Notes', '', ...R.notes.map((n) => `- ${n}`), '', '## Screenshots', '', ...R.shots.map((s) => `- ${s}`), '');
  return lines.join('\n');
}

// ---- generic helpers -----------------------------------------------------------------------------------------------------------

const stats = (xs) => {
  const a = xs.filter((x) => typeof x === 'number').sort((p, q) => p - q);
  if (!a.length) return { n: 0 };
  return { n: a.length, min: a[0], median: a[Math.floor(a.length / 2)], max: a[a.length - 1] };
};
async function waitTiles(page, timeout = 45000) {
  await page.waitForSelector('ytd-rich-item-renderer, yt-lockup-view-model', { timeout }).catch(() => {});
  await sleep(1500);
}
async function wallCheck(page, label) {
  const wall = await page.evaluate(detectWall).catch(() => null);
  if (wall) { note(`YouTube served a ${wall.kind} wall at ${label}: ${wall.detail}`); return wall; }
  return null;
}
const ytAttr = (yt, name) => yt.evaluate((n) => document.documentElement.getAttribute(n), name);
const ytAccent = (yt) => yt.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--cd-accent').trim());
const settingsOf = async (ctx) => ((await ctx.sw(swGet, 'cd.settings')).value || {})['cd.settings'];
const popText = (pop, sel) => pop.evaluate((s) => (document.querySelector(s) || {}).textContent || '', sel);

/** Clicks/keys in the popup and measures click -> visible effect in the YouTube tab (event timestamps from the page's own observers). */
async function actAndMeasure(pop, yt, act, want, { timeout = 5000 } = {}) {
  await resetProbe(yt);
  await pop.evaluate(() => { const t = window.__pt; t.click = 0; t.key = 0; t.change = 0; t.sets.length = 0; });
  await act();
  const ev = await waitForEvent(yt, want, timeout);
  await sleep(40);
  const pt = await pop.evaluate(() => window.__pt);
  const t0 = Math.max(pt.click, pt.key, pt.change) || null;
  const firstSet = pt.sets.length ? pt.sets[0].t : null;
  return {
    ok: Boolean(ev), effectMs: ev && t0 ? ev.t - t0 : null,
    popupToStoreMs: firstSet && t0 ? firstSet - t0 : null, storeToPageMs: ev && firstSet ? ev.t - firstSet : null, sets: pt.sets.length,
  };
}

async function activeNoWrite(pop, fn) {
  await pop.evaluate(() => { window.__pt.sets.length = 0; });
  await fn();
  await sleep(500);
  return (await pop.evaluate(() => window.__pt.sets.length)) === 0;
}

// ---- in-popup describers (serialised into the popup page) ----------------------------------------------------------------------

async function typeHex(pop, text) {
  await pop.focus('#accent-hex');
  await pop.evaluate(() => document.getElementById('accent-hex').select());
  await pop.keyboard.type(text);
  await sleep(700);
}

function popupState() {
  const $ = (id) => document.getElementById(id);
  const mapRadio = (b) => ({ id: b.dataset.themeId || b.dataset.hex, checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled'), tab: b.tabIndex, label: (b.getAttribute('aria-label') || b.textContent).trim().replace(/\s+/g, ' ') });
  return {
    proLabel: $('pro-state-text').textContent,
    founderBadge: !$('founder-badge').hidden,
    proDetail: $('pro-detail').textContent,
    proThankYou: $('pro-thank-you').textContent,
    proThankYouHidden: $('pro-thank-you').hidden,
    proSaved: $('pro-saved').textContent,
    themes: [...document.querySelectorAll('#theme-grid [role=radio]')].map(mapRadio),
    themeNote: $('theme-note').textContent,
    swatches: [...document.querySelectorAll('#accent-swatches [role=radio]')].map(mapRadio),
    hex: $('accent-hex').value, hexInvalid: $('accent-hex').getAttribute('aria-invalid'), accentError: $('accent-error').textContent, accentWarning: $('accent-warning').textContent, accentHelp: $('accent-help').textContent,
    resetDisabled: $('accent-reset').getAttribute('aria-disabled'),
    density: { value: $('density').value, disabled: $('density').disabled, valuetext: $('density').getAttribute('aria-valuetext'), label: $('density-value').textContent, proTag: !$('density-pro').hidden, note: $('density-note').textContent, resetShown: !$('density-reset').hidden },
    animations: { checked: $('animations').getAttribute('aria-checked'), state: $('animations').querySelector('.switch-state').textContent },
    calm: [...document.querySelectorAll('[data-calm]')].map((b) => ({ k: b.dataset.calm, checked: b.getAttribute('aria-checked'), disabled: b.getAttribute('aria-disabled'), tag: !document.getElementById(`calm-${b.dataset.calm}-pro`).hidden })),
    notice: { open: $('notice-wrap').dataset.open, kind: $('notice-wrap').dataset.kind, text: $('notice').textContent, action: !$('notice-action').hidden },
    status: { state: $('status').dataset.state, text: $('status-text').textContent, detail: $('status-detail').textContent },
    activate: { open: $('activate').open, summary: $('activate-summary').textContent, result: $('activate-result').textContent, resultKind: $('activate-result').dataset.kind || '', tokenValueLength: $('token').value.length },
    version: $('version').textContent,
  };
}

function describeFocus() {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  const cs = getComputedStyle(el);
  const labelled = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean).map((id) => (document.getElementById(id) || {}).textContent || '').join(' ');
  const name = (el.getAttribute('aria-label') || labelled || (el.labels && el.labels[0] && el.labels[0].textContent) || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 50);
  const ringW = parseFloat(cs.outlineWidth) || 0;
  return {
    key: `${el.tagName}#${el.id}|${el.dataset.themeId || el.dataset.hex || el.dataset.calm || ''}`, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', name,
    focusVisible: el.matches(':focus-visible'), outline: `${cs.outlineStyle} ${ringW}px ${cs.outlineColor}`, ring: cs.outlineStyle !== 'none' && ringW >= 2,
    boxShadow: cs.boxShadow === 'none' ? '' : cs.boxShadow.slice(0, 60), inView: (() => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight + 1; })(),
  };
}

function interactiveInventory() {
  const sel = 'button, input:not([type=hidden]), summary, a[href], textarea, select, [role=radio], [role=switch]';
  return [...new Set(document.querySelectorAll(sel))].filter((el) => !el.closest('svg.sprite')).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return { key: `${el.tagName}#${el.id}|${el.dataset.themeId || el.dataset.hex || el.dataset.calm || ''}`, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || '', disabledAttr: el.disabled === true, hiddenEl: el.hidden || Boolean(el.tagName.toLowerCase() !== 'summary' && el.closest('details:not([open])')) || r.width === 0 || r.height === 0 || cs.visibility === 'hidden' || cs.display === 'none', tabindex: el.tabIndex };
  });
}

function flattenAx(node, out = []) {
  out.push(node);
  for (const c of node.children || []) flattenAx(c, out);
  return out;
}

async function tabWalk(pop, max = 70) {
  // move the sequential-focus starting point to the top of the document, so the first Tab lands on the first control
  await pop.evaluate(() => { const s = document.createElement('div'); s.tabIndex = -1; document.body.prepend(s); s.focus(); s.remove(); window.scrollTo(0, 0); });
  const seq = [];
  for (let i = 0; i < max; i++) {
    await pop.keyboard.press('Tab');
    const info = await pop.evaluate(describeFocus);
    if (!info) break;
    if (seq.length && info.key === seq[0].key) break;
    seq.push(info);
  }
  return seq;
}

// ---- phase F4 ------------------------------------------------------------------------------------------------------------------

async function phaseF4(ctx, S) {
  const P = 'F4 popup';
  const yt = S.yt = await ctx.newYouTube(CHANNEL_URL, { label: 'yt-channel' });
  await waitTiles(yt);
  await wallCheck(yt, 'channel');
  check(P, 'yt-tab-themed', (await ytAttr(yt, 'cd-theme')) === 'cinema', { theme: await ytAttr(yt, 'cd-theme'), page: await ytAttr(yt, 'cd-page') });
  const pop = S.pop = await ctx.openPopup({ width: 360, height: 900, colorScheme: 'dark' });
  const seeded = await settingsOf(ctx);
  check(P, 'fresh install: service worker seeded defaults (calm empty so theme calm defaults apply)', Boolean(seeded) && seeded.schema === 1 && seeded.themeId === 'cinema' && JSON.stringify(seeded.calm) === '{}' && seeded.animations === true, seeded);

  // -- free render
  let st = await pop.evaluate(popupState);
  check(P, 'free-render-licence', st.proLabel === 'Free' && /Free themes/.test(st.proDetail), { label: st.proLabel });
  const lockedThemes = st.themes.filter((t) => t.disabled === 'true').map((t) => t.id).sort();
  const expectedLocked = ['arcade', 'ember', 'frost', 'imax', 'matcha', 'midnight-city', 'mocha', 'oled', 'paper', 'primetime', 'studio', 'sunset', 'terminal'];
  check(P, 'free-render-themes', st.themes.length === 16 && st.themes.find((t) => t.id === 'cinema').checked === 'true' && JSON.stringify(lockedThemes) === JSON.stringify(expectedLocked), { checked: st.themes.filter((t) => t.checked === 'true').map((t) => t.id), locked: lockedThemes });
  check(P, 'free-render-density-locked', st.density.disabled === true && st.density.proTag, st.density);
  const calmLocked = st.calm.filter((c) => c.disabled === 'true').map((c) => c.k).sort();
  check(P, 'free-render-calm-locked', JSON.stringify(calmLocked) === JSON.stringify(['hideLive', 'hideViewCounts']) && st.calm.every((c) => c.tag === (c.disabled === 'true')), { locked: calmLocked });
  check(P, 'free-render-activate-collapsed', st.activate.open === false && /I have a licence/.test(st.activate.summary), st.activate);
  check(P, 'free-status-idle-in-own-window', /Open a YouTube tab/.test(st.status.text), st.status);
  check(P, 'free-footer', /Not affiliated with Google or YouTube/.test(await pop.evaluate(() => document.querySelector('.footer').textContent)) && /^Cinedrape v\d/.test(st.version), st.version);
  const lay = await pop.evaluate(popupLayoutProbe);
  check(P, 'layout-360-no-overflow', !lay.horizontalScroll && lay.offenders.length === 0 && lay.clipped.length === 0, lay);
  const cdark = await pop.evaluate(popupContrastAudit);
  check(P, 'contrast-dark-all-text', cdark.below === 0 && cdark.measured > 30, { measured: cdark.measured, below: cdark.below, worst: cdark.worst.slice(0, 2), bad: cdark.bad.slice(0, 3) });
  await shot(pop, 'popup-free-dark.png', 'free state, dark popup, 360 px wide');

  // -- keyboard + accessibility (free state, before anything changes)
  await keyboardAndAx(ctx, pop, yt, P, 'free');

  // -- free themes (click)
  const lat = [];
  for (const id of ['minimal', 'classic', 'cinema']) {
    const m = await actAndMeasure(pop, yt, () => pop.click(`[data-theme-id="${id}"]`), { k: 'attr', n: 'cd-theme', v: id });
    lat.push(m);
    check(P, `theme-switch-${id}`, m.ok && (await ytAttr(yt, 'cd-theme')) === id && m.effectMs < 1000, m);
  }
  metric('free theme switch click->effect ms', stats(lat.map((m) => m.effectMs)));
  metric('free theme switch store->page ms', stats(lat.map((m) => m.storeToPageMs)));
  check(P, 'theme-switch-in-page-under-150ms', lat.every((m) => m.storeToPageMs !== null && m.storeToPageMs < 150) ? true : 'warn', lat.map((m) => m.storeToPageMs));
  st = await pop.evaluate(popupState);
  check(P, 'theme-popup-reflects', st.themes.find((t) => t.id === 'cinema').checked === 'true', st.themes.filter((t) => t.checked === 'true').map((t) => t.id));

  // -- locked Pro theme as a free user: explained, nothing written, nothing changes in the tab
  const before = await settingsOf(ctx);
  let noWrite = await activeNoWrite(pop, () => pop.click('[data-theme-id="primetime"]'));
  st = await pop.evaluate(popupState);
  const after = await settingsOf(ctx);
  check(P, 'locked-theme-explained', st.notice.open === 'true' && /Prime Time is a Pro theme/.test(st.notice.text) && st.notice.action, st.notice);
  check(P, 'locked-theme-nothing-written', noWrite && JSON.stringify(before) === JSON.stringify(after) && (await ytAttr(yt, 'cd-theme')) === 'cinema', { noWrite, themeStored: after.themeId, themeInTab: await ytAttr(yt, 'cd-theme') });
  check(P, 'locked-theme-checked-unchanged', st.themes.find((t) => t.id === 'cinema').checked === 'true' && st.themes.find((t) => t.id === 'primetime').checked === 'false', '');
  await pop.click('#sheet-close-btn').catch(() => {});
  noWrite = await activeNoWrite(pop, () => pop.click('[data-calm="hideViewCounts"]'));
  st = await pop.evaluate(popupState);
  check(P, 'locked-calm-explained-not-written', noWrite && /Hide view counts is a Pro setting/.test(st.notice.text) && (await settingsOf(ctx)).calm.hideViewCounts === undefined, { noWrite, notice: st.notice.text });
  await pop.click('#sheet-close-btn').catch(() => {});
  noWrite = await activeNoWrite(pop, async () => { await pop.focus('#density').catch(() => {}); await pop.keyboard.press('ArrowRight'); });
  check(P, 'locked-density-slider-inert', noWrite && (await pop.evaluate(() => document.getElementById('density').disabled)), '');
  await pop.click('#notice-dismiss');
  check(P, 'notice-dismissible', (await pop.evaluate(popupState)).notice.open === 'false', '');

  // -- accent
  let m = await actAndMeasure(pop, yt, () => pop.click('.swatch[data-hex="#ff7a45"]'), { k: 'style-text' });
  await sleep(60);
  check(P, 'accent-swatch-applies', m.ok && (await ytAccent(yt)) === '#ff7a45' && m.effectMs < 1000, { ...m, accent: await ytAccent(yt) });
  metric('accent swatch click->effect ms', m.effectMs);
  const themeAccent = (await ytAccent(yt));
  await typeHex(pop, '#222222');
  await sleep(700);
  st = await pop.evaluate(popupState);
  const stored = await settingsOf(ctx);
  check(P, 'accent-low-contrast-warning', /Low contrast on Cinema/.test(st.accentWarning) && st.accentWarning.includes('3:1'), st.accentWarning);
  check(P, 'accent-low-contrast-theme-accent-kept', (await ytAccent(yt)) !== '#222222' && stored.accent === '#222222', { inTab: await ytAccent(yt), stored: stored.accent });
  await typeHex(pop, 'zzz');
  await pop.keyboard.press('Enter');
  st = await pop.evaluate(popupState);
  check(P, 'accent-invalid-hex-rejected', st.hexInvalid === 'true' && /Enter a colour like/.test(st.accentError) && (await settingsOf(ctx)).accent === '#222222', { error: st.accentError });
  await pop.focus('#accent-hex');
  await pop.evaluate(() => document.getElementById('accent-hex').select());
  m = await actAndMeasure(pop, yt, () => pop.keyboard.type('#33ccff'), { k: 'style-text' });
  await sleep(60);
  check(P, 'accent-custom-hex-applies', m.ok && (await ytAccent(yt)) === '#33ccff' && m.effectMs < 1000, { ...m, accent: await ytAccent(yt) });
  metric('accent custom hex last key->effect ms', m.effectMs);
  check(P, 'accent-warning-clears', (await pop.evaluate(popupState)).accentWarning === '', '');
  m = await actAndMeasure(pop, yt, () => pop.click('#accent-reset'), { k: 'style-text' });
  await sleep(60);
  check(P, 'accent-reset-to-theme', m.ok && (await settingsOf(ctx)).accent === null && (await ytAccent(yt)) !== '#33ccff', { ...m, accent: await ytAccent(yt), themeAccentWas: themeAccent });
  metric('accent reset click->effect ms', m.effectMs);

  // -- animations
  m = await actAndMeasure(pop, yt, () => pop.click('#animations'), { k: 'attr', n: 'cd-motion', v: 'off' });
  check(P, 'animations-off', m.ok && m.effectMs < 1000 && (await pop.evaluate(popupState)).animations.checked === 'false', m);
  metric('animations off click->effect ms', m.effectMs);
  m = await actAndMeasure(pop, yt, () => pop.click('#animations'), { k: 'attr', n: 'cd-motion', v: 'on' });
  check(P, 'animations-on', m.ok && m.effectMs < 1000, m);

  // -- free calm toggles
  for (const key of ['hideShorts', 'hideHomeRecs']) {
    m = await actAndMeasure(pop, yt, () => pop.click(`[data-calm="${key}"]`), { k: 'attr', n: `cd-calm-${key}`, v: '' });
    check(P, `calm-${key}-on`, m.ok && m.effectMs < 1000 && (await settingsOf(ctx)).calm[key] === true, m);
    metric(`calm ${key} click->effect ms`, m.effectMs);
    m = await actAndMeasure(pop, yt, () => pop.click(`[data-calm="${key}"]`), { k: 'attr', n: `cd-calm-${key}`, v: null });
    check(P, `calm-${key}-off`, m.ok && m.effectMs < 1000, m);
  }

  // -- invalid tokens
  const good = await mintLicence({ plan: 'pro', days: 30 });
  const expiredToken = await signCustomLicence({ v: 1, sub: 'dev@cinedrape.local', plan: 'pro', iat: Math.floor(Date.now() / 1000) - 7200, exp: Math.floor(Date.now() / 1000) - 3600 });
  const cases = [
    ['empty', '', /Paste your licence token first/],
    ['garbage', 'hello world', /doesn.t look like a Cinedrape licence token/],
    ['tampered', tamperToken(good.token), /isn.t valid|could not be verified/],
    ['expired', expiredToken, /has expired/],
  ];
  const frags = (tok) => tok.split('.').flatMap((p) => [p.slice(0, 18), p.slice(-18)]);
  st = await pop.evaluate(popupState);
  if (!st.activate.open) {
    await pop.click('#activate-summary');
    await sleep(200);
  }
  for (const [name, token, re] of cases) {
    await pop.evaluate(() => { const t = document.getElementById('token'); t.value = ''; });
    await pop.click('#token');
    if (token) await pop.keyboard.sendCharacter(token);
    await pop.click('#activate-btn');
    await pop.waitForFunction(() => { const r = document.getElementById('activate-result').textContent; return r && !/Checking/.test(r); }, { timeout: 8000 }).catch(() => {});
    st = await pop.evaluate(popupState);
    const leak = await pop.evaluate((fr) => {
      const texts = document.body.innerText + '\n' + document.body.textContent;
      const attrs = [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value)).join('\n');
      return fr.filter((f) => f && (texts.includes(f) || attrs.includes(f)));
    }, token ? frags(token) : []);
    check(P, `token-${name}-rejected-clearly`, re.test(st.activate.result) && st.activate.resultKind === 'error' && st.proLabel === 'Free', { message: st.activate.result });
    check(P, `token-${name}-never-echoed`, leak.length === 0, { leakedFragments: leak.length });
    check(P, `token-${name}-no-licence-stored`, !(await ctx.sw(swGet, 'cd.licence')).value['cd.licence'], '');
  }

  // -- a stored Pro choice while free, then activate through the real UI and time the unlock in the tab
  await ctx.sw(swSet, { 'cd.settings': { ...(await settingsOf(ctx)), themeId: 'studio', density: 4, calm: { ...(await settingsOf(ctx)).calm, hideComments: true } } });
  await sleep(700);
  st = await pop.evaluate(popupState);
  check(P, 'free-with-stored-pro-choice-shows-fallback', (await ytAttr(yt, 'cd-theme')) === 'cinema' && /Studio theme is saved and returns when Pro is active/.test(st.themeNote) && /Saved and waiting for Pro/.test(st.proSaved), { tab: await ytAttr(yt, 'cd-theme'), note: st.themeNote, saved: st.proSaved });
  if (!st.activate.open) {
    await pop.click('#activate-summary');
    await sleep(200);
  }
  await pop.evaluate(() => { document.getElementById('token').value = ''; });
  await pop.click('#token');
  await pop.keyboard.sendCharacter(good.token);
  await resetProbe(yt);
  await pop.evaluate(() => { window.__pt.click = 0; });
  await pop.click('#activate-btn');
  const ev = await waitForEvent(yt, { k: 'attr', n: 'cd-theme', v: 'studio' }, 6000);
  const pt = await pop.evaluate(() => window.__pt.click);
  await pop.waitForFunction(() => /Pro is now active/.test(document.getElementById('activate-result').textContent), { timeout: 6000 }).catch(() => {});
  st = await pop.evaluate(popupState);
  const lic = (await ctx.sw(swGet, 'cd.licence')).value['cd.licence'];
  check(P, 'activate-valid-token-via-ui', st.proLabel === 'Pro active' && /Pro is now active/.test(st.activate.result) && st.activate.tokenValueLength === 0 && Boolean(lic && lic.token === good.token), { label: st.proLabel, result: st.activate.result, inputCleared: st.activate.tokenValueLength === 0 });
  const proExtras = await pop.evaluate(() => ({
    founderHidden: document.getElementById('founder-badge').hidden,
    thankYou: document.getElementById('pro-thank-you').textContent,
    thankYouHidden: document.getElementById('pro-thank-you').hidden,
    bannerHidden: document.getElementById('pro-activated-banner').hidden,
  }));
  check(P, 'activate-shows-thank-you-and-banner', proExtras.founderHidden === true && proExtras.thankYouHidden === false && proExtras.thankYou === 'Pro · thank you' && proExtras.bannerHidden === false, proExtras);
  await pop.click('#pro-activated-dismiss');
  const bannerDismissed = await pop.evaluate(() => document.getElementById('pro-activated-banner').hidden);
  check(P, 'activate-banner-dismisses-on-click', bannerDismissed === true, { bannerDismissed });
  metric('activate click -> stored Pro theme visible in tab ms', ev ? ev.t - pt : null);
  check(P, 'activate-unlocks-tab-within-1s', Boolean(ev) && ev.t - pt < 1000, ev ? ev.t - pt : 'no event');
  const leak2 = await pop.evaluate((fr) => {
    const texts = document.body.innerText + document.body.textContent + document.title + location.href;
    const attrs = [...document.querySelectorAll('*')].flatMap((e) => [...e.attributes].map((a) => a.value)).join('\n');
    const inputs = [...document.querySelectorAll('input')].map((i) => i.value).join('\n');
    return fr.filter((f) => texts.includes(f) || attrs.includes(f) || inputs.includes(f));
  }, frags(good.token));
  check(P, 'activate-token-never-echoed-in-popup', leak2.length === 0, { leaked: leak2.length });
  const settingsJson = JSON.stringify(await settingsOf(ctx));
  check(P, 'activate-token-not-in-settings', !frags(good.token).some((f) => settingsJson.includes(f)), '');
  S.licence = good;
  S.tokenFrags = frags(good.token);
  const consoleLeak = ctx.consoleLog.filter((l) => S.tokenFrags.some((f) => l.text.includes(f)));
  check(P, 'token-not-in-console', consoleLeak.length === 0, { consoleEntries: ctx.consoleLog.length });

  const founderLic = await mintLicence({ plan: 'pro', tier: 'founder', days: 30 });
  await ctx.sw(swSet, { 'cd.licence': { token: founderLic.token, claims: founderLic.claims, checkedAt: Date.now() } });
  await pop.waitForFunction(() => !document.getElementById('founder-badge').hidden, { timeout: 4000 }).catch(() => {});
  const founderState = await pop.evaluate(() => ({
    badge: !document.getElementById('founder-badge').hidden,
    thankYou: document.getElementById('pro-thank-you').textContent,
  }));
  check(P, 'pro-founder-badge-and-thank-you', founderState.badge === true && founderState.thankYou === 'Founder · thank you for supporting Cinedrape', founderState);
  await ctx.sw(swSet, { 'cd.licence': { token: good.token, claims: good.claims, checkedAt: Date.now() } });
  await pop.waitForFunction(() => document.getElementById('founder-badge').hidden, { timeout: 4000 }).catch(() => {});

  await phaseF4Pro(ctx, S);
}

async function phaseF4Pro(ctx, S) {
  const P = 'F4 popup (Pro)';
  const { yt, pop } = S;
  let st = await pop.evaluate(popupState);
  check(P, 'pro-render-unlocked', st.themes.every((t) => t.disabled === null) && st.calm.every((c) => c.disabled === null && !c.tag) && st.density.disabled === false && !st.density.proTag && st.proLabel === 'Pro active', { label: st.proLabel, locked: st.themes.filter((t) => t.disabled).map((t) => t.id) });
  check(P, 'pro-activate-collapsed-or-labelled', /different licence token/.test(st.activate.summary), st.activate.summary);
  check(P, 'pro-stored-choices-restored', (await ytAttr(yt, 'cd-theme')) === 'studio' && st.themes.find((t) => t.id === 'studio').checked === 'true' && st.density.value === '4', { tab: await ytAttr(yt, 'cd-theme'), density: st.density.value, densityAttr: await ytAttr(yt, 'cd-density') });

  const lat = [];
  for (const id of ['primetime', 'arcade', 'classic', 'minimal', 'cinema', 'studio']) {
    const m = await actAndMeasure(pop, yt, () => pop.click(`[data-theme-id="${id}"]`), { k: 'attr', n: 'cd-theme', v: id });
    lat.push(m);
    check(P, `theme-switch-${id}`, m.ok && m.effectMs < 1000, m);
  }
  metric('pro theme switch click->effect ms (6 switches)', stats(lat.map((x) => x.effectMs)));
  metric('pro theme switch store->page ms (6 switches)', stats(lat.map((x) => x.storeToPageMs)));
  check(P, 'theme-switch-in-page-under-150ms', lat.every((x) => x.storeToPageMs !== null && x.storeToPageMs < 150) ? true : 'warn', lat.map((x) => x.storeToPageMs));

  // density: keyboard on the slider, then the reset link
  await pop.focus('#density');
  let m = await actAndMeasure(pop, yt, () => pop.keyboard.press('ArrowRight'), { k: 'attr', n: 'cd-density', v: '5' });
  check(P, 'density-slider-works', m.ok && m.effectMs < 1000 && (await settingsOf(ctx)).density === 5, m);
  metric('density keyboard->effect ms', m.effectMs);
  m = await actAndMeasure(pop, yt, () => pop.keyboard.press('Home'), { k: 'attr', n: 'cd-density', v: '1' });
  check(P, 'density-slider-home-key', m.ok && m.effectMs < 1000, m);
  st = await pop.evaluate(popupState);
  check(P, 'density-readout', st.density.label === 'Compact' && /1 of 5, Compact/.test(st.density.valuetext) && st.density.resetShown, st.density);
  const themeDensity = await (async () => { await pop.click('#density-reset'); await sleep(500); return ytAttr(yt, 'cd-density'); })();
  check(P, 'density-reset-uses-theme-density', (await settingsOf(ctx)).density === null && themeDensity === '4', { attr: themeDensity, note: 'Studio theme density is 4' });

  // calm toggles (six), measured
  const calmLat = [];
  for (const key of ['hideShorts', 'hideHomeRecs', 'hideComments', 'hideEndScreens', 'hideViewCounts', 'hideLive']) {
    const isOn = (await pop.evaluate(popupState)).calm.find((c) => c.k === key).checked === 'true';
    const m1 = await actAndMeasure(pop, yt, () => pop.click(`[data-calm="${key}"]`), { k: 'attr', n: `cd-calm-${key}`, v: isOn ? null : '' });
    calmLat.push(m1.effectMs);
    check(P, `calm-${key}-toggle`, m1.ok && m1.effectMs < 1000, m1);
  }
  metric('calm toggle click->effect ms (6)', stats(calmLat));
  // turn them all off again except none; leave a clean state
  for (const key of ['hideShorts', 'hideHomeRecs', 'hideComments', 'hideEndScreens', 'hideViewCounts', 'hideLive']) {
    const on = (await ytAttr(yt, `cd-calm-${key}`)) !== null;
    if (on) await pop.click(`[data-calm="${key}"]`);
  }
  await sleep(400);

  // keyboard on Pro state: Space on a switch; arrow into a (now unlocked) Pro theme
  await pop.focus('#animations');
  m = await actAndMeasure(pop, yt, () => pop.keyboard.press('Space'), { k: 'attr', n: 'cd-motion', v: 'off' });
  check(P, 'keyboard-space-toggles-animations', m.ok && m.effectMs < 1000, m);
  m = await actAndMeasure(pop, yt, () => pop.keyboard.press('Enter'), { k: 'attr', n: 'cd-motion', v: 'on' });
  check(P, 'keyboard-enter-toggles-animations', m.ok && m.effectMs < 1000, m);
  await keyboardAndAx(ctx, pop, yt, P, 'pro');
  await shotWithScheme(ctx, 'popup-pro-light.png', 'pro state, light popup (prefers-color-scheme: light), after the keyboard pass');
  await mediaVariants(ctx, S);
}

async function keyboardAndAx(ctx, pop, yt, P, mode) {
  const inv = await pop.evaluate(interactiveInventory);
  const seq = await tabWalk(pop);
  const visited = new Set(seq.map((s) => s.key));
  const mustReach = inv.filter((i) => !i.hiddenEl && !i.disabledAttr && i.tabindex !== -1 || (i.role === 'radio' && !i.hiddenEl));
  // roving groups legitimately expose one stop
  const rovingKeys = new Set(inv.filter((i) => i.role === 'radio').map((i) => i.key));
  const groupsReached = {
    theme: seq.some((s) => s.role === 'radio' && ['cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade'].some((id) => s.key.endsWith(`|${id}`))),
    swatch: seq.some((s) => s.role === 'radio' && s.key.includes('|#')),
  };
  const unreachable = mustReach.filter((i) => !visited.has(i.key) && !rovingKeys.has(i.key));
  check(P, `${mode}: keyboard tab order reaches every control`, unreachable.length === 0 && groupsReached.theme && groupsReached.swatch, { stops: seq.length, unreachable: unreachable.map((u) => u.key), groups: groupsReached });
  const noRing = seq.filter((s) => !s.ring && !s.boxShadow);
  check(P, `${mode}: visible focus ring on every stop (outline >= 2px)`, noRing.length === 0, { stops: seq.length, without: noRing.map((s) => s.key), sample: seq[1] && seq[1].outline });
  const notFv = seq.filter((s) => !s.focusVisible);
  check(P, `${mode}: keyboard focus matches :focus-visible`, notFv.length === 0, notFv.map((s) => s.key));
  const unnamed = seq.filter((s) => !s.name);
  check(P, `${mode}: every stop has a name`, unnamed.length === 0, unnamed.map((s) => s.key));
  metric(`${mode}: tab stops (in order)`, seq.map((s) => `${s.tag}${s.role ? `[${s.role}]` : ''}:${s.name.slice(0, 22)}`));

  // arrow keys inside the theme group
  await pop.focus('#theme-grid [aria-checked="true"]');
  const cur = await pop.evaluate(() => document.querySelector('#theme-grid [aria-checked="true"]').dataset.themeId);
  const order = [
    'cinema', 'minimal', 'classic', 'primetime', 'studio', 'arcade',
    'oled', 'frost', 'mocha', 'midnight-city', 'ember', 'paper', 'matcha', 'sunset', 'terminal', 'imax',
  ];
  const idx = order.indexOf(cur);
  if (mode === 'free') {
    await pop.keyboard.press('Home');
    await sleep(300);
    let now = await pop.evaluate(() => ({ focus: document.activeElement.dataset.themeId, checked: document.querySelector('#theme-grid [aria-checked="true"]').dataset.themeId }));
    check(P, 'free: Home key selects first theme', now.focus === 'cinema' && now.checked === 'cinema', now);
    const m = await actAndMeasure(pop, yt, () => pop.keyboard.press('ArrowRight'), { k: 'attr', n: 'cd-theme', v: 'minimal' });
    check(P, 'free: ArrowRight selects next free theme', m.ok && m.effectMs < 1000, m);
    await pop.keyboard.press('ArrowRight');
    await sleep(300);
    await pop.keyboard.press('ArrowRight');
    await sleep(300);
    now = await pop.evaluate(() => ({ focus: document.activeElement.dataset.themeId, checked: document.querySelector('#theme-grid [aria-checked="true"]').dataset.themeId, rovingStops: [...document.querySelectorAll('#theme-grid [role=radio]')].filter((r) => r.tabIndex === 0).map((r) => r.dataset.themeId) }));
    check(P, 'free: ArrowRight onto a locked theme moves focus, does not select', now.focus === 'primetime' && now.checked === 'classic', now);
    const written = await activeNoWrite(pop, () => pop.keyboard.press('Enter'));
    const ns = await pop.evaluate(popupState);
    check(P, 'free: Enter on a locked theme explains and writes nothing', written && /Prime Time is a Pro theme/.test(ns.notice.text), ns.notice.text);
    const ring = await pop.evaluate(describeFocus);
    check(P, 'free: focus ring visible on the focused locked theme', ring && ring.ring && ring.focusVisible, ring && ring.outline);
    await shot(pop, 'popup-free-locked-focus.png', 'free state: locked Pro theme focused by keyboard, explanation notice open');
    await pop.keyboard.press('End');
    await sleep(200);
    const endFocus = await pop.evaluate(() => document.activeElement.dataset.themeId);
    check(P, 'free: End moves focus to the last theme (locked), selection stays', endFocus === 'imax' && (await pop.evaluate(() => document.querySelector('#theme-grid [aria-checked="true"]').dataset.themeId)) === 'classic', endFocus);
    await pop.click('[data-theme-id="cinema"]');
    await pop.click('#notice-dismiss').catch(() => {});
  } else {
    void idx;
    await pop.keyboard.press('Home');
    await sleep(300);
    const m = await actAndMeasure(pop, yt, () => pop.keyboard.press('End'), { k: 'attr', n: 'cd-theme', v: 'imax' });
    check(P, 'pro: End key selects the last (Pro) theme', m.ok && m.effectMs < 1000, m);
    const m2 = await actAndMeasure(pop, yt, () => pop.keyboard.press('ArrowLeft'), { k: 'attr', n: 'cd-theme', v: 'terminal' });
    check(P, 'pro: ArrowLeft selects the previous Pro theme', m2.ok && m2.effectMs < 1000, m2);
    await pop.click('[data-theme-id="cinema"]');
  }

  // accessibility tree: every interactive element has a name and a state
  const tree = await pop.accessibility.snapshot({ interestingOnly: false });
  const nodes = flattenAx(tree);
  const wanted = new Set(['button', 'radio', 'switch', 'slider', 'textbox', 'link', 'DisclosureTriangle', 'checkbox', 'combobox']);
  const ctl = nodes.filter((n) => wanted.has(n.role));
  const noName = ctl.filter((n) => !n.name || !String(n.name).trim());
  const domCount = (await pop.evaluate(interactiveInventory)).filter((i) => !i.hiddenEl).length;
  check(P, `${mode}: AX tree names every interactive element`, noName.length === 0 && ctl.length >= domCount, { axControls: ctl.length, domVisible: domCount, unnamed: noName.map((n) => n.role) });
  const radios = ctl.filter((n) => n.role === 'radio');
  const switches = ctl.filter((n) => n.role === 'switch');
  const slider = ctl.find((n) => n.role === 'slider');
  check(P, `${mode}: AX radios expose checked state`, radios.length === 35 && radios.every((n) => typeof n.checked === 'boolean' || n.checked === 'mixed'), radios.map((n) => `${n.name}=${n.checked}`).join('; ').slice(0, 300));
  check(P, `${mode}: AX switches expose checked state (7)`, switches.length === 7 && switches.every((n) => typeof n.checked === 'boolean'), switches.map((n) => `${n.name}=${n.checked}${n.disabled ? ' disabled' : ''}`).join('; ').slice(0, 400));
  const lockedAx = ctl.filter((n) => n.disabled);
  check(P, `${mode}: locked controls are exposed as disabled`, mode === 'free' ? lockedAx.filter((n) => n.role === 'radio').length === 19 && lockedAx.filter((n) => n.role === 'switch').length === 2 : lockedAx.filter((n) => ['radio', 'switch', 'slider'].includes(n.role)).length === 0, lockedAx.map((n) => `${n.role}:${n.name}`).join('; ').slice(0, 300));
  check(P, `${mode}: AX slider has a name and a value text`, Boolean(slider && slider.name && (slider.valuetext || slider.value !== undefined)), slider && { name: slider.name, value: slider.value, valuetext: slider.valuetext, disabled: slider.disabled });
  const groups = nodes.filter((n) => n.role === 'radiogroup' || n.role === 'group');
  check(P, `${mode}: AX radiogroups are named`, groups.filter((n) => n.role === 'radiogroup').every((n) => n.name), groups.map((n) => `${n.role}:${n.name}`).slice(0, 8));
  const summary = nodes.find((n) => n.role === 'DisclosureTriangle');
  check(P, `${mode}: AX details summary has expanded state`, Boolean(summary && typeof summary.expanded === 'boolean'), summary && { name: summary.name, expanded: summary.expanded });
  const live = await pop.evaluate(() => ({ notice: document.getElementById('notice').getAttribute('role'), status: document.getElementById('status-text').getAttribute('role'), act: document.getElementById('activate-result').getAttribute('role'), accentErr: document.getElementById('accent-error').getAttribute('role') }));
  check(P, `${mode}: live regions for messages`, live.notice === 'status' && live.status === 'status' && live.act === 'status' && live.accentErr === 'alert', live);
}

async function shot(page, file, what) {
  const path = join(OUT, file);
  await page.screenshot({ path, fullPage: true });
  R.shots.push(`${file}: ${what}`);
}

async function shotWithScheme(ctx, file, what) {
  const p = await ctx.openPopup({ width: 360, height: 900, colorScheme: 'light', label: 'popup-light' });
  await shot(p, file, what);
  const cl = await p.evaluate(popupContrastAudit);
  check('F4 popup (Pro)', 'contrast-light-all-text', cl.below === 0 && cl.measured > 30, { measured: cl.measured, below: cl.below, worst: cl.worst.slice(0, 2), bad: cl.bad.slice(0, 3) });
  const lay = await p.evaluate(popupLayoutProbe);
  check('F4 popup (Pro)', 'layout-360-light-no-overflow', !lay.horizontalScroll && lay.offenders.length === 0 && lay.clipped.length === 0, lay);
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  const st = await p.evaluate(popupState);
  check('F4 popup (Pro)', 'light-variant-differs-and-pro-state-renders', bg !== 'rgb(13, 13, 17)' && st.proLabel === 'Pro active', { bodyBg: bg, label: st.proLabel });
  await p.close();
}

async function mediaVariants(ctx, S) {
  const P = 'F4 popup (Pro)';
  const { yt } = S;
  const rm = await ctx.openPopup({ width: 360, height: 900, colorScheme: 'dark', reducedMotion: true, label: 'popup-rm' });
  const motion = await rm.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    const secs = (v) => v.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 0.001 : 1));
    let maxT = 0;
    let maxA = 0;
    for (const el of all) { const cs = getComputedStyle(el); maxT = Math.max(maxT, ...secs(cs.transitionDuration)); maxA = Math.max(maxA, ...secs(cs.animationDuration)); }
    return { maxTransitionS: maxT, maxAnimationS: maxA };
  });
  const normal = await ctx.openPopup({ width: 360, height: 900, colorScheme: 'dark', reducedMotion: false, label: 'popup-motion' });
  const motionNormal = await normal.evaluate(() => {
    const all = [...document.querySelectorAll('*')];
    const secs = (v) => v.split(',').map((x) => parseFloat(x) * (x.trim().endsWith('ms') ? 0.001 : 1));
    let maxT = 0;
    for (const el of all) maxT = Math.max(maxT, ...secs(getComputedStyle(el).transitionDuration));
    return { maxTransitionS: maxT };
  });
  check(P, 'popup-reduced-motion-kills-transitions', motion.maxTransitionS <= 0.001 && motion.maxAnimationS <= 0.001 && motionNormal.maxTransitionS > 0.05, { reduced: motion, normal: motionNormal });
  await rm.close();
  await normal.close();
  // the engine in the tab obeys the OS reduced-motion setting
  await resetProbe(yt);
  await yt.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  const on = await waitForEvent(yt, { k: 'attr', n: 'cd-motion', v: 'off' }, 4000);
  check(P, 'tab-obeys-prefers-reduced-motion', Boolean(on), { motion: await ytAttr(yt, 'cd-motion') });
  await yt.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);
  const off = await waitForEvent(yt, { k: 'attr', n: 'cd-motion', v: 'on' }, 4000);
  check(P, 'tab-motion-returns-when-os-setting-clears', Boolean(off), { motion: await ytAttr(yt, 'cd-motion') });
}

// ---- status panel (popup as a background tab in the YouTube window) ---------------------------------------------------------------

async function phaseStatus(ctx, S) {
  const P = 'F4 status';
  const yt = S.yt;
  if (S.pop) { await S.pop.close().catch(() => {}); S.pop = null; }
  await yt.bringToFront();
  const bg = await ctx.openPopup({ window: false, background: true, label: 'popup-bg', width: 360, height: 900 });
  let st = await bg.evaluate(popupState);
  check(P, 'status-working-with-youtube-tab-and-reply', st.status.state === 'ok' && st.status.text === 'Working' && /theme on a channel page/.test(st.status.detail), st.status);
  S.bg = bg;
}

// ---- phase F6 --------------------------------------------------------------------------------------------------------------------

/** The mapVersion of the signed map inside the built extension under test. */
function bundledMapVersion() {
  const env = JSON.parse(readFileSync(join(resolve(REPO_ROOT, argv.extension), 'data', 'selector-map.json'), 'utf8'));
  return JSON.parse(env.payload).mapVersion;
}
/** '2026.10.09.1' + 3 -> '2026.10.09.4' (the last segment grows, so the result compares newer than the input). */
function bumpVersion(version, n) {
  const parts = version.split('.');
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + n);
  return parts.join('.');
}

/**
 * Oracle for "which features does breaking these roles pause": read from the map DATA (requires x pageRoles), not from the engine or
 * the health module under test. `wanted` = what the F6 settings switch on (Cinema theme: home + watch layouts; every calm toggle; no density).
 */
function expectedBroken(brokenRoles, pageType = 'watch') {
  const map = loadSourceMap();
  const wanted = ['theme', 'layout-home', 'layout-watch', 'calm-hideShorts', 'calm-hideHomeRecs', 'calm-hideComments', 'calm-hideEndScreens', 'calm-hideViewCounts', 'calm-hideLive'];
  const onPage = new Set(map.pageRoles[pageType] || []);
  return wanted.filter((f) => (map.requires[f] || []).some((r) => onPage.has(r) && brokenRoles.includes(r))).sort();
}

const STATUS_BROKEN = (reply) => Object.entries((reply && reply.features) || {}).filter(([, v]) => v === 'broken').map(([k]) => k).sort();

async function statusOf(ctx, urlPart) {
  const r = await ctx.sw(swStatus);
  const t = (r.tabs || []).find((x) => x.url.includes(urlPart)) || (r.tabs || [])[0];
  return t ? t.reply || { error: t.error } : { error: r.error || 'no tab' };
}

async function waitFor(fn, timeout, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeout) return { value: null, ms: Date.now() - t0 };
    await sleep(step);
  }
}

async function phaseF6(ctx, S) {
  const P = 'F6 breakage';
  // Map versions are relative to the map the extension under test ships: a cached map is adopted only when strictly newer.
  const V = (n) => bumpVersion(bundledMapVersion(), n);
  // a clean slate on a watch page
  if (S.yt) await S.yt.close().catch(() => {});
  if (S.bg) await S.bg.close().catch(() => {});
  await ctx.sw(swRemove, ['cd.selectorMap']);
  await ctx.sw(swSet, { 'cd.settings': baseSettings({ themeId: 'cinema', calm: { hideShorts: true, hideHomeRecs: true, hideComments: true, hideEndScreens: true, hideViewCounts: true, hideLive: true } }) });
  if (!S.licence) { S.licence = await mintLicence({}); }
  await ctx.sw(swSet, { 'cd.licence': { ...S.licence, checkedAt: Date.now() } });
  const yt = S.yt = await ctx.newYouTube(WATCH_URL, { label: 'yt-watch' });
  await yt.waitForSelector('ytd-watch-flexy #movie_player', { timeout: 45000 }).catch(() => {});
  await sleep(2500);
  const wall = await wallCheck(yt, 'watch');
  await yt.bringToFront();
  const bg = S.bg = await ctx.openPopup({ window: false, background: true, label: 'popup-f6', width: 360, height: 900 });
  const popStatus = async () => (await bg.evaluate(popupState)).status;

  // baseline: the bundled map on the real watch page with everything on
  await sleep(7500); // health needs ~6 s to settle
  let rep = await statusOf(ctx, 'watch');
  let use = await yt.evaluate(usabilityProbe);
  metric('F6 baseline GET_STATUS (watch, all calm on, Pro)', { mapVersion: rep.mapVersion, features: rep.features, missing: rep.missingRoles });
  check(P, 'baseline-no-broken-feature-on-real-watch-page', STATUS_BROKEN(rep).length === 0 && use.notices.length === 0, { broken: STATUS_BROKEN(rep), missing: rep.missingRoles, notices: use.notices });
  check(P, 'baseline-page-usable', use.pageManager && use.pageManager.visible && use.mastheadVisible && (use.player ? use.player.visible && use.player.w > 300 : false), { pm: use.pageManager, player: use.player, masthead: use.mastheadVisible, wall: Boolean(wall) });
  S.bundledVersion = rep.mapVersion;
  S.baselineRootBg = use.rootBg;
  check(P, 'baseline: the themed page carries the theme colour tokens', use.styleHasTokens === true, { rootBg: use.rootBg });

  const caseRun = async (name, { map, roles, expectBroken, expectMissing, keepNotice = false }) => {
    const env = await signMap(map);
    await resetProbe(yt);
    const w = await ctx.sw(swSet, { 'cd.selectorMap': env });
    const t0 = w.t;
    const adopted = await waitFor(async () => (await statusOf(ctx, 'watch')).mapVersion === map.mapVersion, 5000, 100);
    const noticeSeen = await waitFor(async () => (await yt.evaluate(() => document.querySelectorAll('div.cd-notice[role="status"]').length)) > 0, 14000, 200);
    await sleep(800);
    rep = await statusOf(ctx, 'watch');
    use = await yt.evaluate(usabilityProbe);
    const broken = STATUS_BROKEN(rep);
    const ps = await popStatus();
    const evs = await probeEvents(yt);
    metric(`F6 ${name}: map adopted ms / notice shown ms`, { adopted: adopted.value ? adopted.ms : null, notice: noticeSeen.value ? noticeSeen.ms : null });
    check(P, `${name}: map adopted (GET_STATUS mapVersion)`, adopted.value === true, { mapVersion: rep.mapVersion, ms: adopted.ms });
    check(P, `${name}: exactly the expected features broken`, JSON.stringify(broken) === JSON.stringify(expectBroken), { broken, expected: expectBroken, endScreenNodes: use.endScreenNodes });
    check(P, `${name}: missingRoles reported`, expectMissing.every((r) => (rep.missingRoles || []).includes(r)), { missing: rep.missingRoles });
    check(P, `${name}: exactly one in-page notice`, use.notices.length === 1, { n: use.notices.length, text: use.notices[0] });
    check(P, `${name}: notice names the paused feature`, use.notices.length === 1 && expectBroken.length > 0 && /turned off/.test(use.notices[0]), use.notices[0]);
    check(P, `${name}: popup status says paused`, ps.state === 'paused' && /Paused:/.test(ps.text), ps);
    const offAttrs = Object.keys(use.attrs).filter((a) => a.startsWith('cd-off-')).sort();
    check(P, `${name}: html cd-off-* flags match`, JSON.stringify(offAttrs) === JSON.stringify(expectBroken.map((f) => `cd-off-${f}`.toLowerCase()).sort()), offAttrs);
    return { rep, use, evs, t0, noticeMs: noticeSeen.value ? noticeSeen.ms : null };
  };

  // (a1) comments role gone
  let r = await caseRun('a1 comments', { map: variantMap({ version: V(1), breakRoles: ['comments'] }), expectBroken: expectedBroken(['comments']), expectMissing: ['comments'] });
  check(P, 'a1 comments: rest of the theme still applied', r.use.attrs['cd-theme'] === 'cinema' && r.use.styleBytes > 10000 && r.rep.features.theme === 'on', { theme: r.use.attrs['cd-theme'], styleBytes: r.use.styleBytes, features: r.rep.features });
  check(P, 'a1 comments: page never blank or unusable', r.use.pageManager.visible && r.use.player && r.use.player.visible && r.use.mastheadVisible && r.use.bodyTextChars > 500, { pm: r.use.pageManager, player: r.use.player, chars: r.use.bodyTextChars });
  check(P, 'a1 comments: comments back to YouTube default (not hidden by Cinedrape)', r.use.commentsDisplay !== 'none', r.use.commentsDisplay);
  S.noticeA1 = r.use.notices[0];

  // (b) heal with a still-higher good map, no reload
  const good = variantMap({ version: V(2) });
  const env = await signMap(good);
  await resetProbe(yt);
  const w = await ctx.sw(swSet, { 'cd.selectorMap': env });
  const healed = await waitFor(async () => { const s = await statusOf(ctx, 'watch'); return s.mapVersion === good.mapVersion && STATUS_BROKEN(s).length === 0; }, 12000, 150);
  await sleep(600);
  rep = await statusOf(ctx, 'watch');
  use = await yt.evaluate(usabilityProbe);
  let ps = await popStatus();
  metric('F6 b heal: good map write -> feature healthy ms', healed.value ? healed.ms : null);
  check(P, 'b heal: feature heals without a reload', healed.value === true && rep.features['calm-hideComments'] === 'on', { ms: healed.ms, features: rep.features['calm-hideComments'] });
  check(P, 'b heal: cd-off-* flags cleared and missingRoles empty', Object.keys(use.attrs).every((a) => !a.startsWith('cd-off-')) && (rep.missingRoles || []).length === 0, { attrs: Object.keys(use.attrs), missing: rep.missingRoles });
  check(P, 'b heal: popup status back to Working', ps.state === 'ok' && ps.text === 'Working', ps);
  check(P, 'b heal: comments hidden again by the calm toggle', use.commentsDisplay === 'none' || use.commentsDisplay === null, use.commentsDisplay);
  check(P, 'b heal: stale "turned off" notice does not linger after the heal', use.notices.length === 0, { notices: use.notices });

  // re-break the same feature: announced once per session, never twice
  const noticesBefore = use.notices.length;
  r = await caseRunQuiet(ctx, yt, variantMap({ version: V(3), breakRoles: ['comments'] }), 9000);
  check(P, 'a1 again: same feature is broken again but not announced a second time (once per feature per session)', STATUS_BROKEN(r.rep).join() === 'calm-hideComments' && noticesBefore === 0 && r.notices === 0, { broken: STATUS_BROKEN(r.rep), noticesBefore, noticesAfter: r.notices });
  ps = await popStatus();
  check(P, 'a1 again: the popup still reports the paused feature', ps.state === 'paused' && /Paused:.*Hide comments/.test(ps.text), ps);

  // (a2) the watch player role gone: only the watch layout is paused
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(variantMap({ version: V(4) })) });
  await sleep(2500);
  await yt.evaluate(() => { for (const n of document.querySelectorAll('div.cd-notice')) n.remove(); try { sessionStorage.removeItem('cd:v1:noticeShown'); } catch { /* ignore */ } });
  note('between a1 and a2 the harness removed the notice element and its sessionStorage flag to allow a fresh announcement');
  r = await caseRun('a2 watchPlayer', { map: variantMap({ version: V(5), breakRoles: ['watchPlayer'] }), expectBroken: expectedBroken(['watchPlayer']), expectMissing: ['watchPlayer'] });
  check(P, 'a2 watchPlayer: player still visible and the theme intact', r.use.player && r.use.player.visible && r.use.player.w > 300 && r.use.attrs['cd-theme'] === 'cinema' && r.rep.features.theme === 'on', { player: r.use.player, theme: r.use.attrs['cd-theme'] });
  check(P, 'a2 watchPlayer: page usable', r.use.pageManager.visible && r.use.mastheadVisible && r.use.bodyTextChars > 500, { pm: r.use.pageManager, chars: r.use.bodyTextChars });

  // (a3) the app shell role gone: the whole theme feature is paused, the page falls back to YouTube's default look
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(variantMap({ version: V(6) })) });
  await sleep(2500);
  await yt.evaluate(() => { for (const n of document.querySelectorAll('div.cd-notice')) n.remove(); try { sessionStorage.removeItem('cd:v1:noticeShown'); } catch { /* ignore */ } });
  r = await caseRun('a3 app', { map: variantMap({ version: V(7), breakRoles: ['app'] }), expectBroken: expectedBroken(['app']), expectMissing: ['app'] });
  // The oracle for "YouTube's own look": the theme's colour tokens are gone from the stylesheet and the page background is not the
  // theme's. (Layout and calm rules are separate features and legitimately stay, so the stylesheet is not empty: 32 KB measured.)
  check(P, 'a3 app: theme feature off means YouTube default look, page not blank', r.use.pageManager.visible && r.use.player && r.use.player.visible && r.use.mastheadVisible && r.use.bodyTextChars > 500 && r.use.styleHasTokens === false && r.use.rootBg !== S.baselineRootBg && r.use.attrs['cd-off-theme'] !== undefined, { pm: r.use.pageManager, player: r.use.player, styleBytes: r.use.styleBytes, tokensInStyle: r.use.styleHasTokens, rootBg: r.use.rootBg, themedRootBg: S.baselineRootBg });

  // (a3b) the verdict is remembered (chrome.storage.local cd.health, per map version): a reload starts with the theme already off
  // instead of flashing it on for the ~6 s settle time, and it is still the settled picture afterwards.
  const stored = ((await ctx.sw(swGet, 'cd.health')).value || {})['cd.health'] || null;
  check(P, 'a3b: the settled verdict was stored (map version, theme id, broken features, time)', stored && stored.mapVersion === V(7) && stored.themeId === 'cinema' && stored.broken.includes('theme') && typeof stored.at === 'number', stored);
  await yt.reload({ waitUntil: 'domcontentloaded' });
  await sleep(1800);   // chrome.storage answers in milliseconds; the settle window is 6000 ms
  const early = await yt.evaluate(usabilityProbe);
  check(P, 'a3b reload: the theme is off from the first pass (no flash for the settle time)', early.attrs['cd-off-theme'] !== undefined && early.styleHasTokens === false, { off: early.attrs['cd-off-theme'], tokens: early.styleHasTokens });
  await sleep(6500);
  rep = await statusOf(ctx, 'watch');
  check(P, 'a3b reload: after the settle the same feature is still the paused one', STATUS_BROKEN(rep).includes('theme') && rep.mapVersion === V(7), { broken: STATUS_BROKEN(rep), mapVersion: rep.mapVersion });

  // (a4) the worst map that IS adopted: signed, newer, every role matches nothing on the page. Every judged feature pauses, once; the
  // page keeps YouTube's own look and stays usable.
  const clearNotices = () => yt.evaluate(() => { for (const n of document.querySelectorAll('div.cd-notice')) n.remove(); try { sessionStorage.removeItem('cd:v1:noticeShown'); } catch { /* ignore */ } });
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(variantMap({ version: V(8) })) });
  await sleep(2500);
  await clearNotices();
  const allRoles = Object.keys(loadSourceMap().roles);
  r = await caseRun('a4 every role missing', { map: variantMap({ version: V(9), breakRoles: allRoles }), expectBroken: expectedBroken(allRoles), expectMissing: ['app', 'comments', 'watchPlayer'] });
  check(P, 'a4 every role missing: page usable, YouTube default look, nothing blank', r.use.pageManager.visible && r.use.mastheadVisible && r.use.bodyTextChars > 500 && r.use.player && r.use.player.visible && r.use.styleHasTokens === false && r.use.rootBg !== S.baselineRootBg, { pm: r.use.pageManager, player: r.use.player, chars: r.use.bodyTextChars, tokensInStyle: r.use.styleHasTokens, rootBg: r.use.rootBg });
  metric('F6 a4 every role missing', { broken: STATUS_BROKEN(r.rep), notices: r.use.notices.length, styleBytes: r.use.styleBytes });

  // (a4b) a signed, newer map whose selectors are not even valid CSS is refused as a whole: the bundled map stays in force
  await clearNotices();
  const hostile = variantMap({ version: V(10) });
  for (const role of Object.keys(hostile.roles)) hostile.roles[role] = ['@@@ not css', '{{'];
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(hostile) });
  await sleep(3000);
  rep = await statusOf(ctx, 'watch');
  use = await yt.evaluate(usabilityProbe);
  check(P, 'a4b unparseable selectors: map refused, bundled map in force, nothing paused, page usable', rep.mapVersion === S.bundledVersion && STATUS_BROKEN(rep).length === 0 && use.notices.length === 0 && use.pageManager.visible && use.bodyTextChars > 500 && use.attrs['cd-theme'] === 'cinema', { mapVersion: rep.mapVersion, broken: STATUS_BROKEN(rep), notices: use.notices.length });

  // (c) reset: from an ADOPTED broken map back to the bundled one by removing the cached map (storage.onChanged with no new value)
  await clearNotices();
  const live = await signMap(variantMap({ version: V(11), breakRoles: ['comments'] }));
  await ctx.sw(swSet, { 'cd.selectorMap': live });
  const broke = await waitFor(async () => { const s2 = await statusOf(ctx, 'watch'); return s2.mapVersion === V(11) && STATUS_BROKEN(s2).join() === 'calm-hideComments'; }, 14000, 200);
  check(P, 'c reset: precondition, the adopted broken map pauses Hide comments', broke.value === true, { ms: broke.ms });
  const wr = await ctx.sw(swRemove, ['cd.selectorMap']);
  const back = await waitFor(async () => { const s2 = await statusOf(ctx, 'watch'); return s2.mapVersion === S.bundledVersion && STATUS_BROKEN(s2).length === 0; }, 12000, 100);
  metric('F6 c reset: map removed -> bundled map and healthy (ms)', back.value ? Date.now() - wr.t : null);
  check(P, 'c reset: removing the cached map returns to the bundled map and clears the breakage', back.value === true, { ms: back.ms });
  await sleep(500);
  use = await yt.evaluate(usabilityProbe);
  check(P, 'c reset: cd-off flag and notice are gone too', Object.keys(use.attrs).every((a) => !a.startsWith('cd-off-')) && use.notices.length === 0, { attrs: Object.keys(use.attrs).filter((a) => a.startsWith('cd-off-')), notices: use.notices.length });
  await clearNotices();
  const brokenMap = (version) => variantMap({ version, breakRoles: ['comments', 'app', 'watchPlayer'] });
  const signedOk = await signMap(brokenMap(V(21)));
  const tampered = { ...signedOk, payload: signedOk.payload.replace(V(21), V(22)) };
  const tampered2 = { ...signedOk, payload: signedOk.payload.replace('cd-e2e-missing-comments', 'cd-e2e-missing-comments2') };
  const invalidCases = [
    ['unsigned (no sig)', { payload: signedOk.payload, kid: signedOk.kid }],
    ['unsigned (empty sig)', { ...signedOk, sig: '' }],
    ['unsigned (bare map object)', brokenMap(V(23))],
    ['tampered (version bumped after signing)', tampered],
    ['tampered (selector changed after signing)', tampered2],
    ['older version, signed', await signMap(brokenMap('2026.10.06.1'))],
    ['equal version, signed', await signMap(brokenMap(S.bundledVersion))],
    ['signed with the licence key', await signMap(brokenMap(V(24)), { keyName: 'licence' })],
    ['garbage value', 'not an envelope'],
  ];
  for (const [name, value] of invalidCases) {
    await ctx.sw(swSet, { 'cd.selectorMap': value });
    await sleep(2200);
    rep = await statusOf(ctx, 'watch');
    use = await yt.evaluate(usabilityProbe);
    check(P, `c ignored: ${name}`, rep.mapVersion === S.bundledVersion && STATUS_BROKEN(rep).length === 0 && use.notices.length === 0, { mapVersion: rep.mapVersion, broken: STATUS_BROKEN(rep), notices: use.notices.length });
    check(P, `d usable after: ${name}`, use.pageManager.visible && use.mastheadVisible && use.bodyTextChars > 500 && use.player && use.player.visible && use.attrs['cd-theme'] === 'cinema', { pm: use.pageManager, player: use.player, theme: use.attrs['cd-theme'] });
  }
  await sleep(6500);
  rep = await statusOf(ctx, 'watch');
  use = await yt.evaluate(usabilityProbe);
  check(P, 'c ignored: still healthy after the full settle window (no late breakage)', STATUS_BROKEN(rep).length === 0 && use.notices.length === 0 && rep.mapVersion === S.bundledVersion, { broken: STATUS_BROKEN(rep), notices: use.notices.length });
  await ctx.sw(swRemove, ['cd.selectorMap']);

  // (d) one tile-heavy page: breaking a role there never removes tiles
  const ch = await ctx.newYouTube(CHANNEL_URL, { label: 'yt-channel-f6' });
  await waitTiles(ch);
  const baseUse = await ch.evaluate(usabilityProbe);
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(variantMap({ version: V(15), breakRoles: ['homeBrowse', 'app', 'pageManager', 'videoTile'] })) });
  await sleep(9500);
  const chRep = await statusOf(ctx, 'NatGeo');
  const brokenUse = await ch.evaluate(usabilityProbe);
  check(P, 'd channel page with several roles broken: tiles still visible, nothing blank', brokenUse.visibleTiles >= Math.min(baseUse.visibleTiles, 10) && brokenUse.pageManager.visible && brokenUse.bodyTextChars > 500, { tilesBefore: baseUse.visibleTiles, tilesAfter: brokenUse.visibleTiles, broken: STATUS_BROKEN(chRep), notices: brokenUse.notices.length });
  await ctx.sw(swRemove, ['cd.selectorMap']);
  await sleep(1500);
  await ch.close();
  await yt.bringToFront();
}

/** Writes a map, waits for the settle window and reports broken features and the number of notices created since. */
async function caseRunQuiet(ctx, yt, map, waitMs) {
  await ctx.sw(swSet, { 'cd.selectorMap': await signMap(map) });
  await sleep(waitMs);
  const rep = await statusOf(ctx, 'watch');
  const use = await yt.evaluate(usabilityProbe);
  return { rep, notices: use.notices.length };
}

// ---- first paint -----------------------------------------------------------------------------------------------------------------

/**
 * The look the page had at its first observable moment: the probe's snapshot plus, when the content script ran after the probe looked,
 * its synchronous burst (events within 5 ms of the first one). Everything after that is a change of look ("late"), i.e. a restyle.
 */
function analyseLook(l) {
  const evs = l.evFull || [];
  const attrs = { ...((l.snap0 && l.snap0.attrs) || {}) };
  let styleLen = l.snap0 ? l.snap0.styleLen : null;
  const burstEnd = !('cd-theme' in attrs) && evs.length ? evs[0].p + 5 : -1;
  const late = [];
  for (const e of evs) {
    if (e.p <= burstEnd) {
      if (e.k === 'attr') { if (e.v === null) delete attrs[e.n]; else attrs[e.n] = e.v; } else if (e.k === 'style-added' || e.k === 'style-text') styleLen = e.len;
    } else late.push(e);
  }
  return { attrs, styleLen, late };
}

async function phasePaint(ctx, S) {
  const P = 'first paint';
  if (S.yt) await S.yt.close().catch(() => {});
  if (S.bg) await S.bg.close().catch(() => {});
  await ctx.sw(swRemove, ['cd.selectorMap']);
  // every attribute the css depends on is non-default: theme, accent, density, animations off, three calm flags
  await ctx.sw(swSet, { 'cd.settings': baseSettings({ themeId: 'studio', accent: '#ff7a45', density: 2, animations: false, calm: { hideShorts: true, hideHomeRecs: true, hideComments: true } }) });
  if (!S.licence) S.licence = await mintLicence({});
  await ctx.sw(swSet, { 'cd.licence': { ...S.licence, checkedAt: Date.now() } });
  const EXPECTED_ATTRS = ['cd-theme', 'cd-page', 'cd-home', 'cd-watch', 'cd-density', 'cd-motion', 'cd-calm-hideshorts', 'cd-calm-hidehomerecs', 'cd-calm-hidecomments'];
  const CACHED_ATTRS = ['cd-calm-hidecomments', 'cd-calm-hidehomerecs', 'cd-calm-hideshorts', 'cd-density', 'cd-home', 'cd-motion', 'cd-watch'];
  const yt = S.yt = await ctx.newYouTube(CHANNEL_URL, { label: 'yt-paint' });
  const grab = async (label) => {
    await yt.waitForFunction(() => document.readyState !== 'loading', { timeout: 30000 }).catch(() => {});
    await sleep(2500);
    const d = await yt.evaluate(() => {
      const P = window.__cdProbe || {};
      const cache = (() => { try { const v = JSON.parse(localStorage.getItem('cd:v1:firstPaint') || 'null'); return v ? { key: v.key, bytes: (v.css || '').length } : null; } catch { return 'unreadable'; } })();
      const root = document.documentElement;
      const finalAttrs = Object.fromEntries([...root.attributes].filter((a) => a.name.startsWith('cd-')).map((a) => [a.name, a.value]));
      const style = document.getElementById('cinedrape-theme');
      const ev = P.ev || [];
      return {
        p0: P.p0, rootFirst: P.rootFirst, styleFirst: P.styleFirst, attrFirst: P.attrFirst, paint: P.paint, snap0: P.snap0, finalAttrs, finalStyleLen: style ? style.textContent.length : null,
        ev: ev.slice(0, 12).map((e) => ({ k: e.k, p: Math.round(e.p * 10) / 10, d: e.d && (e.d.n ? `${e.d.n}=${e.d.v}` : e.d.len) })),
        evFull: ev.slice(0, 120).map((e) => ({ k: e.k, p: e.p, n: e.d && e.d.n, v: e.d && e.d.v, len: e.d && e.d.len })),
        cache, cacheAttrs: (() => { try { const v = JSON.parse(localStorage.getItem('cd:v1:firstPaint') || 'null'); return v ? Object.keys(v.attrs || {}).sort() : null; } catch { return null; } })(), theme: root.getAttribute('cd-theme'),
      };
    });
    return { label, ...d };
  };
  const loads = [await grab('load 1 (after boot)')];
  await yt.reload({ waitUntil: 'domcontentloaded' });
  loads.push(await grab('reload 2'));
  await yt.reload({ waitUntil: 'domcontentloaded' });
  loads.push(await grab('reload 3'));
  metric('paint: attributes carried by the first-paint cache', loads[1] && loads[1].cacheAttrs);
  for (const l of loads) metric(`paint ${l.label}`, { initToStyleMs: l.styleFirst !== null && l.p0 !== undefined ? Math.round((l.styleFirst - l.p0) * 10) / 10 : null, attrAtMs: l.attrFirst && Math.round(l.attrFirst), styleAtMs: l.styleFirst && Math.round(l.styleFirst), firstPaintMs: l.paint && l.paint['first-paint'] && Math.round(l.paint['first-paint']), fcpMs: l.paint && l.paint['first-contentful-paint'] && Math.round(l.paint['first-contentful-paint']), cache: l.cache, firstEvents: l.ev });
  for (const l of loads.slice(1)) {
    const fp = l.paint && l.paint['first-paint'];
    const extra = l.styleFirst !== null ? l.styleFirst - l.p0 : null;
    check(P, `${l.label}: style element + cd-theme exist before first paint`, Boolean(fp) && l.styleFirst !== null && l.attrFirst !== null && l.styleFirst <= fp && l.attrFirst <= fp, { styleAt: l.styleFirst && Math.round(l.styleFirst), attrAt: l.attrFirst && Math.round(l.attrFirst), firstPaint: fp && Math.round(fp) });
    check(P, `${l.label}: stylesheet arrives < 50 ms after the document starts`, extra !== null && extra < 50, { initToStyleMs: extra && Math.round(extra * 10) / 10 });
    const look = analyseLook(l);
    const missingAtStart = EXPECTED_ATTRS.filter((n) => !(n in look.attrs));
    check(P, `${l.label}: every cd-* attribute the css depends on is there with the stylesheet, before anything can paint (the cache carries them)`, missingAtStart.length === 0 && look.styleLen > 1000 && JSON.stringify(l.cacheAttrs) === JSON.stringify(CACHED_ATTRS), { missingAtStart, styleLenAtStart: look.styleLen, cacheAttrs: l.cacheAttrs });
    const sameAttrs = JSON.stringify(Object.entries(look.attrs).sort()) === JSON.stringify(Object.entries(l.finalAttrs).sort());
    check(P, `${l.label}: no restyle: the first look is the final look and nothing was rewritten afterwards`, sameAttrs && look.styleLen === l.finalStyleLen && look.late.length === 0, { sameAttrs, styleAtStart: look.styleLen, styleFinal: l.finalStyleLen, lateEvents: look.late.slice(0, 6).map((e) => `${e.k}:${e.n || ''}=${e.v === undefined ? e.len : e.v}@${Math.round(e.p)}`), attrsAtStart: look.attrs, attrsFinal: l.finalAttrs });
  }
  // cold: no cache entry -> how long is the page unthemed
  await yt.evaluate(() => { try { localStorage.removeItem('cd:v1:firstPaint'); } catch { /* ignore */ } });
  await yt.reload({ waitUntil: 'domcontentloaded' });
  const cold = await grab('cold (cache removed)');
  const fpCold = cold.paint && cold.paint['first-paint'];
  metric('paint cold load (no cache)', { styleAtMs: cold.styleFirst && Math.round(cold.styleFirst), firstPaintMs: fpCold && Math.round(fpCold), cacheRewritten: Boolean(cold.cache && cold.cache.key) });
  check(P, 'cold load rewrites the cache', Boolean(cold.cache && cold.cache.key && /^studio:/.test(cold.cache.key)), cold.cache);
  note(`cold load (no cache): style at ${cold.styleFirst && Math.round(cold.styleFirst)} ms vs first paint ${fpCold && Math.round(fpCold)} ms`);
}

// ---- service worker restart ----------------------------------------------------------------------------------------------------

async function phaseSw(ctx, S) {
  const P = 'service worker';
  const yt = S.yt;
  const swTargets = () => ctx.browser.targets().filter((t) => t.type() === 'service_worker' && t.url().startsWith(`chrome-extension://${ctx.extId}/`));
  // A fresh, known state: Pro licence (just checked), studio theme.
  if (!S.licence) S.licence = await mintLicence({});
  await ctx.sw(swSet, { 'cd.licence': { ...S.licence, checkedAt: Date.now() }, 'cd.settings': baseSettings({ themeId: 'studio' }) });
  await yt.bringToFront();
  await waitFor(async () => (await ytAttr(yt, 'cd-theme')) === 'studio', 4000, 80);
  check(P, 'worker target present before', swTargets().length === 1, swTargets().map((t) => t.url()));

  // An MV3 worker is stopped by Chrome 30 s after its last event, but never while a debugging session is attached: let go of ours
  // (the bridge's and the network recorder's), then wait for the target to disappear.
  await ctx.rec.detachSw();
  await ctx.bridge.release();
  const t0 = Date.now();
  const gone = await waitFor(async () => swTargets().length === 0, 70000, 1000);
  metric('worker idle-stop after the last debugging session was released (ms)', gone.value ? gone.ms : null);
  check(P, 'the worker really stopped (Chrome idle timeout, no debugger attached)', gone.value === true, { waitedMs: Date.now() - t0 });
  if (!gone.value) note('the worker did not stop within 70 s: the checks below ran against a live worker');

  // 1. the popup while the worker is "restarting": Chrome rejects the message; the popup falls back to the stored licence record
  const tabTheme = await ytAttr(yt, 'cd-theme');
  const pop = await ctx.openPopup({ width: 360, height: 900, label: 'popup-sw-down', failWorkerMessages: true });
  const st0 = await pop.evaluate(popupState);
  const msgs = await pop.evaluate(() => window.__pt.msgs.filter((m) => m.type === 'cd:getLicence').length);
  const running1 = swTargets().length;
  check(P, 'popup with the worker unreachable: licence read from storage (two tries, then fallback), not "unavailable"', st0.proLabel === 'Pro active' && msgs === 2 && st0.themes.find((t) => t.id === 'studio').checked === 'true' && st0.themes.every((t) => t.disabled === null), { label: st0.proLabel, getLicenceTries: msgs, theme: tabTheme });
  check(P, 'the unreachable-worker popup did not start the worker (nothing else needed it)', gone.value ? running1 === 0 : 'warn', { workersRunning: running1 });
  const m = await actAndMeasure(pop, yt, () => pop.click('[data-theme-id="classic"]'), { k: 'attr', n: 'cd-theme', v: 'classic' });
  check(P, 'theme change works with no running worker (popup writes storage, the tab reacts)', m.ok && m.effectMs < 1000, m);
  check(P, 'still no worker after the theme change', gone.value ? swTargets().length === 0 : 'warn', { workersRunning: swTargets().length });
  await pop.close();

  // 2. the normal popup wakes the worker with its first message and gets a real answer
  const pop2 = await ctx.openPopup({ width: 360, height: 900, label: 'popup-sw-wake' });
  const st2 = await pop2.evaluate(popupState);
  check(P, 'popup with a sleeping worker: the first message wakes it and the licence is right', st2.proLabel === 'Pro active' && swTargets().length === 1, { label: st2.proLabel, workers: swTargets().length });
  const lic = await pop2.evaluate(() => chrome.runtime.sendMessage({ type: 'cd:getLicence' }));
  check(P, 'worker still knows the licence after the restart (GET_LICENCE)', Boolean(lic && lic.ok !== false && lic.plan === 'pro' && lic.status === 'active'), lic);
  const store = await ctx.sw(swGet, ['cd.settings', 'cd.licence']);
  check(P, 'settings and licence survived the restart', Boolean(store.value && store.value['cd.settings'] && store.value['cd.settings'].themeId === 'classic' && store.value['cd.licence'] && store.value['cd.licence'].token === S.licence.token), { theme: store.value && store.value['cd.settings'] && store.value['cd.settings'].themeId });
  const alarms = await ctx.sw(async () => { try { return { alarms: (await chrome.alarms.getAll()).map((a) => ({ name: a.name, period: a.periodInMinutes })) }; } catch (e) { return { error: String(e && e.message) }; } });
  check(P, 'alarms still registered after the restart (cd-licence weekly, cd-map 6 h)', Boolean(alarms.alarms && alarms.alarms.some((a) => a.name === 'cd-licence' && a.period === 10080) && alarms.alarms.some((a) => a.name === 'cd-map' && a.period === 360)), alarms);
  const rep = await ctx.sw(swStatus);
  const tabRep = ((rep.tabs || []).find((x) => x.url.includes('NatGeo')) || (rep.tabs || [])[0] || {}).reply || {};
  check(P, 'the open tab kept working through the restart (GET_STATUS answers, Pro on, theme follows)', tabRep.pro === true && tabRep.themeId === 'classic', { pro: tabRep.pro, themeId: tabRep.themeId });
  await pop2.close();
}

// ---- licence ageing -----------------------------------------------------------------------------------------------------------------

async function phaseLicence(ctx, S) {
  const P = 'licence ageing';
  if (!S.licence) S.licence = await mintLicence({});
  const yt = S.yt || (await ctx.newYouTube(CHANNEL_URL));
  await yt.bringToFront();
  await ctx.sw(swSet, { 'cd.settings': baseSettings({ themeId: 'studio', density: 4, calm: { hideShorts: true, hideViewCounts: true } }) });
  const popBg = await ctx.openPopup({ window: false, background: true, label: 'popup-licence', width: 360, height: 900 });
  const rows = [];
  for (const [days, expectStatus, expectPro] of [[3, 'active', true], [8, 'grace', true], [29, 'grace', true], [31, 'expired', false], [3, 'active', true]]) {
    await ctx.sw(swSet, { 'cd.licence': { ...S.licence, checkedAt: Date.now() - days * DAY } });
    const target = expectPro ? 'studio' : 'cinema';
    const got = await waitFor(async () => (await ytAttr(yt, 'cd-theme')) === target, 4000, 80);
    await sleep(500);
    const rep = await statusOf(ctx, 'youtube.com');
    const pst = await popBg.evaluate(popupState);
    const swLic = await popBg.evaluate(() => chrome.runtime.sendMessage({ type: 'cd:getLicence' })).catch(() => null);
    const row = { days, status: swLic && swLic.status, plan: swLic && swLic.plan, tabTheme: await ytAttr(yt, 'cd-theme'), tabDensity: rep.features && rep.features.density, tabCalmViews: rep.features && rep.features['calm-hideViewCounts'], enginePro: rep.pro, popupLabel: pst.proLabel, popupLocked: pst.themes.filter((t) => t.disabled).length };
    rows.push(row);
    check(P, `checkedAt ${days} d old -> ${expectStatus}, Pro features ${expectPro ? 'unlocked' : 'locked'} in the live tab`, got.value === true && row.status === expectStatus && row.enginePro === expectPro && (expectPro ? row.tabDensity === 'on' && row.tabCalmViews === 'on' : row.tabDensity === 'locked' && row.tabCalmViews === 'locked'), row);
  }
  check(P, 'popup labels: Pro active / offline grace / paused', true, rows.map((r) => `${r.days}d=${r.popupLabel}`).join('; '));
  // A record that was merely not re-checked for 31 days (the token itself has no expiry problem) is "paused", not "expired": the
  // wording must be accurate, since with no server nothing can re-check it except the worker's local re-verification.
  const expiredRow = rows.find((r) => r.days === 31);
  check(P, 'a licence not re-checked for 31 d is labelled "Pro paused" (not "expired", its token has no expiry problem)', expiredRow && /Pro paused/.test(expiredRow.popupLabel) && !/expired/i.test(expiredRow.popupLabel), expiredRow && expiredRow.popupLabel);
  // stored Pro choices come back after renewing (the last loop iteration already re-aged to 3 d)
  check(P, 'stored Pro choices return when the licence is fresh again', (await ytAttr(yt, 'cd-theme')) === 'studio' && (await ytAttr(yt, 'cd-density')) === '4', { theme: await ytAttr(yt, 'cd-theme'), density: await ytAttr(yt, 'cd-density') });
  await popBg.close();
}

// ---- trust and privacy audit --------------------------------------------------------------------------------------------------------------

async function phaseTrust(ctx, S) {
  const P = 'trust and privacy';
  const rec = ctx.rec;
  // recorder control: a request made from the worker must be seen by the recorder
  rec.swControl = true;
  const ctl = await ctx.sw(swFetchControl, 'https://www.youtube.com/robots.txt');
  await sleep(800);
  rec.swControl = false;
  const seenCtl = rec.sw.filter((x) => x.control && /robots\.txt/.test(x.url)).length;
  check(P, 'recorder control: a worker fetch is captured by the CDP Network recorder', seenCtl >= 1, { fetch: ctl, seen: seenCtl });
  const extReal = rec.sw.filter((x) => !x.control);
  check(P, 'service worker made zero network requests during the whole session', extReal.length === 0, { count: extReal.length, sample: extReal.slice(0, 3) });
  check(P, 'popup pages made zero network requests', rec.popup.length === 0, { count: rec.popup.length, sample: rec.popup.slice(0, 3) });
  check(P, 'content script (isolated world) initiated zero requests (CDP initiator stacks naming the extension)', rec.ytFromExt.length === 0 && rec.ws.length === 0, { fromExt: rec.ytFromExt.slice(0, 5), ws: rec.ws.length, pageRequestsObserved: rec.ytTotal });
  metric('requests seen on YouTube pages (all initiators)', rec.ytTotal);
  metric('top hosts the pages talked to', Object.entries(rec.ytHosts).sort((a, b) => b[1] - a[1]).slice(0, 8));

  // manifest + granted permissions
  const mf = await ctx.sw(swManifest);
  const m = mf.manifest;
  const perms = [...(m.permissions || [])].sort();
  check(P, 'installed manifest permissions are exactly storage + alarms', JSON.stringify(perms) === JSON.stringify(['alarms', 'storage']), perms);
  check(P, 'host permissions are exactly https://www.youtube.com/*', JSON.stringify(m.host_permissions) === JSON.stringify(['https://www.youtube.com/*']) && !m.optional_permissions && !m.optional_host_permissions, { host: m.host_permissions, optional: m.optional_permissions });
  check(P, 'granted at runtime: same set (chrome.permissions.getAll)', JSON.stringify([...(mf.granted.permissions || [])].sort()) === JSON.stringify(['alarms', 'storage']) && JSON.stringify(mf.granted.origins) === JSON.stringify(['https://www.youtube.com/*']), mf.granted);
  const cs = (m.content_scripts || [])[0] || {};
  check(P, 'content script only on youtube.com at document_start; no web_accessible_resources / externally_connectable', JSON.stringify(cs.matches) === JSON.stringify(['https://www.youtube.com/*']) && cs.run_at === 'document_start' && !m.web_accessible_resources && !m.externally_connectable, { matches: cs.matches, run_at: cs.run_at, war: m.web_accessible_resources, ec: m.externally_connectable });
  check(P, 'content security policy is not loosened', !m.content_security_policy, m.content_security_policy);

  // static: network, cookie and eval primitives in the shipped files
  const dist = resolve(REPO_ROOT, argv.extension);
  const scan = {};
  const walk = (d) => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
  for (const f of walk(dist).filter((x) => x.endsWith('.js'))) {
    const t = readFileSync(f, 'utf8');
    scan[f.slice(dist.length + 1).split(sep).join('/')] = {
      fetch: (t.match(/\bfetch\s*\(/g) || []).length, xhr: (t.match(/XMLHttpRequest/g) || []).length, beacon: (t.match(/sendBeacon/g) || []).length, ws: (t.match(/new\s+WebSocket|EventSource/g) || []).length,
      cookie: (t.match(/document\.cookie|chrome\.cookies/g) || []).length, evalLike: (t.match(/\beval\s*\(|new\s+Function\s*\(/g) || []).length, importScripts: (t.match(/importScripts/g) || []).length,
    };
  }
  const contentScan = scan['content.js'] || {};
  check(P, 'content.js has no fetch / XHR / beacon / WebSocket / cookie / eval', ['fetch', 'xhr', 'beacon', 'ws', 'cookie', 'evalLike'].every((k) => contentScan[k] === 0), contentScan);
  check(P, 'popup.js has no network, cookie or eval primitives', Boolean(scan['popup/popup.js']) && ['fetch', 'xhr', 'beacon', 'ws', 'cookie', 'evalLike'].every((k) => scan['popup/popup.js'][k] === 0), scan['popup/popup.js'] || 'popup/popup.js was not found in the extension directory');
  check(P, 'no file ships eval / new Function / importScripts', Object.values(scan).every((s) => s.evalLike === 0 && s.importScripts === 0), scan);
  metric('static scan of shipped js', scan);

  // page storage and cookies, against a control profile with no extension
  const yt = await ctx.newYouTube(CHANNEL_URL, { label: 'yt-trust' });
  await waitTiles(yt);
  const w = await ctx.newYouTube(WATCH_URL, { label: 'yt-trust-watch' });
  await sleep(4000);
  const dump = async (p) => p.evaluate(() => ({ ls: Object.keys(localStorage).sort(), ss: Object.keys(sessionStorage).sort(), cd: Object.keys(localStorage).concat(Object.keys(sessionStorage)).filter((k) => /^cd[:.\-_]|cinedrape/i.test(k)).sort() }));
  const d1 = await dump(yt);
  const d2 = await dump(w);
  const cookies = (await ctx.browser.cookies()).map((c) => `${c.domain}|${c.name}`).sort();
  const cdKeys = [...new Set([...d1.cd, ...d2.cd])].sort();
  check(P, 'localStorage on youtube.com holds exactly one Cinedrape key: cd:v1:firstPaint', JSON.stringify(d1.cd.filter((k) => localStorage_has(d1, k))) === JSON.stringify(['cd:v1:firstPaint']) && !d2.ls.some((k) => /^cd[:.\-_]/.test(k) && k !== 'cd:v1:firstPaint'), { localCd: d1.ls.filter((k) => /^cd/i.test(k)), watchLocalCd: d2.ls.filter((k) => /^cd/i.test(k)) });
  check(P, 'sessionStorage holds only the notice key (cd:v1:noticeShown) from Cinedrape', [...d1.ss, ...d2.ss].filter((k) => /^cd/i.test(k)).every((k) => k === 'cd:v1:noticeShown'), { sessionCd: [...d1.ss, ...d2.ss].filter((k) => /^cd/i.test(k)) });
  check(P, 'no cookie named like Cinedrape', !cookies.some((c) => /cinedrape|\|cd[:._-]/i.test(c)), { total: cookies.length });
  metric('cookies in the profile (domain|name)', cookies);
  // value of the first-paint key: css only, no identifiers
  const fpv = await yt.evaluate(() => { try { const v = JSON.parse(localStorage.getItem('cd:v1:firstPaint')); return { keys: Object.keys(v), key: v.key, attrNames: Object.keys(v.attrs || {}), cssBytes: (v.css || '').length, hasUrlOrImport: /@import|url\(\s*['"]?https?:/i.test(v.css || ''), hasLicenceOrEmail: /@|licen|token|eyJ/i.test((v.css || '').replace(/@media|@supports|@keyframes|@container|@layer|@property/g, '')) }; } catch (e) { return { error: String(e) }; } });
  check(P, 'first-paint cache value is css + key + the cd-* attribute set only (no token, no identity)', fpv.keys && JSON.stringify(fpv.keys) === JSON.stringify(['v', 'key', 'css', 'attrs']) && fpv.attrNames.every((n) => /^cd-(home|watch|density|motion|textscale|calm-[a-z]+)$/.test(n)) && !fpv.hasUrlOrImport && !fpv.hasLicenceOrEmail, fpv);
  metric('page storage keys that look like Cinedrape', cdKeys);

  // control profile: nothing but YouTube's own keys without the extension
  const { default: puppeteer } = await import('puppeteer-core');
  const { createSession, findChrome, launchChrome } = await import('./lib/browser.mjs');
  const ses = createSession();
  let control = null;
  try {
    const b = await launchChrome(puppeteer, { chromePath: findChrome(process.env.CHROME_PATH), headed: false, viewport: { width: 1280, height: 800 }, profile: ses.profile, extraArgs: [] });
    ses.attach(b);
    const p = await b.newPage();
    await p.goto(CHANNEL_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(5000);
    const p2 = await b.newPage();
    await p2.goto(WATCH_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await sleep(4000);
    control = { a: await p.evaluate(() => ({ ls: Object.keys(localStorage).sort(), ss: Object.keys(sessionStorage).sort() })), b: await p2.evaluate(() => ({ ls: Object.keys(localStorage).sort(), ss: Object.keys(sessionStorage).sort() })), cookies: (await b.cookies()).map((c) => `${c.domain}|${c.name}`).sort() };
  } catch (err) { note(`control profile failed: ${err.message}`); } finally { await ses.dispose(); }
  if (control) {
    const mine = new Set([...d1.ls, ...d2.ls]);
    const theirs = new Set([...control.a.ls, ...control.b.ls]);
    const onlyMine = [...mine].filter((k) => !theirs.has(k));
    const mineS = new Set([...d1.ss, ...d2.ss]);
    const theirsS = new Set([...control.a.ss, ...control.b.ss]);
    const onlyMineS = [...mineS].filter((k) => !theirsS.has(k));
    const onlyCookies = cookies.filter((c) => !control.cookies.includes(c));
    check(P, 'page localStorage vs a no-extension control: only cd:v1:firstPaint (plus YouTube timing noise) is extra', onlyMine.filter((k) => /^cd/i.test(k)).join() === 'cd:v1:firstPaint' && onlyMine.every((k) => k === 'cd:v1:firstPaint' || /yt/i.test(k)), { extraKeys: onlyMine, controlCount: theirs.size, mineCount: mine.size });
    check(P, 'page sessionStorage vs control: extras are only the notice key', onlyMineS.filter((k) => /^cd/i.test(k)).every((k) => k === 'cd:v1:noticeShown'), { extraKeys: onlyMineS });
    check(P, 'cookies vs control: nothing extra that looks extension-made', !onlyCookies.some((c) => /cd|cine/i.test(c.split('|')[1])), { extraCookies: onlyCookies });
    metric('control profile storage keys (no extension)', { local: [...theirs].length, session: [...theirsS].length, cookies: control.cookies.length });
  }
  await yt.close();
  await w.close();
}
const localStorage_has = (d, k) => d.ls.includes(k);

// ---- main ---------------------------------------------------------------------------------------------------------------------------

async function main() {
  const ctx0 = { ext: argv.extension };
  void ctx0;
  const ctx = await startRun({ extension: argv.extension, settings: null, licence: null });
  R.chrome = `Chrome ${await ctx.browser.version()}`;
  console.log(`started: ${R.chrome}, extension id ${ctx.extId}`);
  const S = {};
  const run = async (name, fn, gate = name) => {
    if (!PHASES.has(gate)) return;
    console.log(`\n=== ${name} ===`);
    try { await fn(ctx, S); } catch (err) { check(name, 'phase completed without a harness error', false, String(err && err.stack || err).slice(0, 500)); }
    save();
  };
  try {
    await run('F4', phaseF4, 'f4');
    await run('F4 status', phaseStatus, 'f4');
    await run('F6', phaseF6, 'f6');
    await run('first paint', phasePaint, 'paint');
    await run('service worker', phaseSw, 'sw');
    await run('licence', phaseLicence, 'licence');
    await run('trust', phaseTrust, 'trust');
    const errs = ctx.consoleLog.filter((l) => /cinedrape|chrome-extension:\/\//i.test(l.text + l.url));
    check('console', 'no Cinedrape errors or warnings in any page or popup console', errs.length === 0, errs.slice(0, 5));
    metric('console entries (all sources, incl. YouTube noise)', ctx.consoleLog.length);
    if (ctx.bridge.errors.length) note(`service worker console: ${ctx.bridge.errors.slice(0, 4).join(' | ')}`);
    check('console', 'service worker logged no errors', ctx.bridge.errors.length === 0, ctx.bridge.errors.slice(0, 4));
  } finally {
    save();
    await ctx.close();
  }
  const fails = R.checks.filter((c) => c.ok === false).length;
  console.log(`\nDONE: ${R.checks.filter((c) => c.ok === true).length} pass, ${R.checks.filter((c) => c.ok === 'warn').length} warn, ${fails} fail. Report: ${join(OUT, 'report.md')}`);
  process.exit(fails ? 1 : 0);
}

main().catch((err) => { console.error(err); try { save(); } catch { /* ignore */ } process.exit(6); });
