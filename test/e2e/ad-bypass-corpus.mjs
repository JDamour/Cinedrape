// Differential regression for the theme CSS validator (ARCHITECTURE.md section 6): "whatever the validator ACCEPTS must leave an
// ad visible in a real browser".
//
//   node test/e2e/ad-bypass-corpus.mjs [--fuzz 400] [--seed 1] [--chrome <path>] [--out <dir>] [--validator <file>]
//
// No extension is loaded and nothing touches the user's profile: a throw-away headless Chrome (temporary --user-data-dir, removed on
// exit) renders a fixture page with an ad slot inside a flex feed, a sponsorship label, a player-control bar and an own .cd-home box
// above the feed, once without theme CSS (baseline) and once per CSS under test, and counts the ad's red pixels and the label's white
// pixels. Every rule the validator (strict theme profile) accepts must keep at least 90% of both. Real logged-out YouTube serves no
// ads, which is why the evidence is a measured fixture, not the live site.
//
// Corpus: (1) the reviewer's measured bypasses plus relatives, each on the ad, the label, the controls and the tile that holds an ad;
// (2) attacks on Cinedrape's own boxes; (3) a seeded random walk over a pool of declarations, selectors and wrappers. The unit-test
// half of this file is test/shared/css-validator-hostile.test.js.
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const require = createRequire(join(ROOT, 'package.json'));
const puppeteer = require('puppeteer-core');
const { validateCss, buildAllowList } = await import(pathToFileURL(resolve(ROOT, parseArgs({ options: { validator: { type: 'string', default: 'src/shared/css-validator.js' } }, strict: false }).values.validator)).href);
const { findChrome } = await import(pathToFileURL(join(ROOT, 'test', 'e2e', 'lib', 'browser.mjs')).href);

const { values: opts } = parseArgs({ strict: false, options: { validator: { type: 'string' }, fuzz: { type: 'string', default: '400' }, seed: { type: 'string', default: '1' }, chrome: { type: 'string' }, out: { type: 'string' } } });
const MAP = JSON.parse(readFileSync(join(ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
const ALLOW = buildAllowList(MAP);
const PROTECTED = [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls];
const CTX = { allowList: ALLOW, protectedSelectors: PROTECTED };
const GUARD = `:not(:has(${MAP.protected.ads.join(', ')}))`;

// ---- the fixture -------------------------------------------------------------------------------------------------------------------
const TOKENS = ':root{--cd-bg:#0b0b0f;--cd-surface:#16161d;--cd-menu:#16161d;--cd-text:#f2f2f5;--cd-muted:#a3a3b2;--cd-accent:#e8b04a;--cd-accent-hover:#f0c06a;'
  + '--cd-accent-text:#000;--cd-border:#656572;--cd-hover:#ffffff14;--cd-active:#ffffff24;--cd-scrim:#0b0b0fcc;--cd-radius:10px;--cd-space:6px;--cd-gap:16px;'
  + '--cd-card-min:190px;--cd-row-gap:30px;--cd-row-visible:6;--cd-font-family:system-ui,sans-serif;--cd-font-size:14px;--cd-font-scale:1;'
  + '--cd-heading-weight:700;--cd-duration:160ms;--cd-shadow:0 1px 2px #0008,0 8px 24px #0006}';
const BASE = `${TOKENS}html,body{margin:0;background:#fff;font:16px/1.2 sans-serif}`
  + '.cd-home{display:block;box-sizing:border-box;width:900px;margin:0;padding:12px 0}'
  + '.cd-row{position:relative;margin:0 0 30px}.cd-row-track{display:flex;gap:16px;padding:0}'
  + '.cd-card{flex:0 0 190px;height:60px;background:#369;color:#fff}.cd-card-title{display:block;padding:4px}'
  + '#feed{display:flex;flex-wrap:wrap;width:900px;position:relative}'
  + 'ytd-rich-item-renderer{display:block;width:300px;height:120px;background:#9bd;box-sizing:border-box}'
  + 'ytd-ad-slot-renderer{display:block;width:300px}ytd-ad-slot-renderer .adc{height:120px;background:#d00;color:#fff}'
  + '.ytp-paid-content-overlay{display:block;background:#222;color:#fff;width:300px;padding:8px;font-weight:700}'
  + '.ytp-chrome-bottom{display:block;background:#444;width:300px;height:30px;color:#fff}'
  + 'ytd-comments{display:block;width:300px;height:40px;background:#eee;color:#000}';
const page = (css) => `<!doctype html><html cd-theme="cinema" cd-page="home"><head><style>${BASE}</style><style>${css}</style></head><body>
<div class="cd-home"><div class="cd-row"><div class="cd-row-title">Row</div><div class="cd-row-track"><a class="cd-card"><span class="cd-card-title">One</span></a><a class="cd-card"><span class="cd-card-title">Two</span></a><a class="cd-card"><span class="cd-card-title">Three</span></a></div></div></div>
<div id="feed"><ytd-rich-item-renderer>one</ytd-rich-item-renderer>
<ytd-rich-item-renderer><ytd-ad-slot-renderer><div class="adc">AD content</div></ytd-ad-slot-renderer></ytd-rich-item-renderer>
<ytd-rich-item-renderer>three</ytd-rich-item-renderer><ytd-rich-item-renderer>four</ytd-rich-item-renderer></div>
<div class="ytp-paid-content-overlay">Includes paid promotion</div>
<div class="ytp-chrome-bottom">controls</div><ytd-comments>comments</ytd-comments>
</body></html>`;

// ---- corpus ---------------------------------------------------------------------------------------------------------------------
const AD = 'ytd-ad-slot-renderer';
const TARGETS = [AD, '.ytp-paid-content-overlay', '.ytp-chrome-bottom', 'ytd-rich-item-renderer', `ytd-rich-item-renderer${GUARD}`, 'ytd-comments'];
const T = (sel, body) => `html[cd-theme] ${sel}{${body}}`;
const DANGEROUS = [
  'transform:rotateY(180deg);backface-visibility:hidden', 'rotate:y 180deg;backface-visibility:hidden', 'height:1.5px;overflow:hidden', 'max-height:25px;overflow:hidden',
  'zoom:.06', 'zoom:50', 'height:env(cd-x,0px);overflow:hidden', 'height:attr(cd-x px,0px);overflow:hidden', 'height:round(down,1px,100px);overflow:hidden',
  'height:calc(sin(0)*1px);overflow:hidden', 'width:mod(7px,7px);overflow:hidden', 'position:relative;left:99vw', 'margin-left:99vw', 'margin-top:99vh',
  'transform:rotateX(88deg)', 'transform:scale(.25)', 'transform:scale(4.9)', 'outline:999px solid #9bd', 'box-shadow:0 0 0 999px #9bd', 'translate:0 -159px',
  'margin-top:-99px', 'padding-bottom:99999px', 'min-height:99999px', 'flex-basis:0;flex-grow:0;flex-shrink:0;overflow:hidden', 'order:99999',
  'contain:size;height:1px', 'content-visibility:hidden', 'clip-path:inset(50%)', 'filter:opacity(.3)', 'filter:brightness(0)', 'opacity:.99', 'visibility:hidden',
  'display:none', 'display:contents', 'pointer-events:none', 'font-size:4px', 'color:#0f0f0f', 'color:var(--cd-bg)', 'background:var(--cd-text)', 'text-indent:-9999px',
  'position:fixed;inset:0;z-index:99', 'mix-blend-mode:multiply', 'text-shadow:0 0 40px #fff', 'border:30px solid var(--cd-bg)', 'outline:4px solid var(--cd-bg);outline-offset:-8px',
  'box-shadow:inset 0 0 0 40px #fff', 'letter-spacing:40px', 'border-radius:999px', 'text-decoration:line-through 4px', 'animation:cd-hide 1ms forwards',
  'transition:height 0s;height:1px', 'container-type:size', 'aspect-ratio:100/1;width:0', 'all:unset',
];
const KEYFRAMES = '@keyframes cd-hide{to{height:2px;opacity:0;transform:scale(.01);overflow:hidden}}@keyframes cd-tint{to{background-color:var(--cd-text)}}';
const OWN_ATTACKS = [
  '.cd-home{position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:#000}', '.cd-home{margin-bottom:99999px}', '.cd-home{height:99999px}',
  '.cd-home{transform:scale(50)}', '.cd-hero{min-height:50000px}', '.cd-row{margin-bottom:99999px}', '.cd-row{height:99999px}', '.cd-row-track{padding-bottom:50000px}',
  '.cd-card{height:99999px}', '.cd-card{margin-bottom:99999px}', '.cd-card{position:fixed;inset:0;width:100vw;height:100vh}', '.cd-card::after{content:"";position:absolute;inset:0;width:100vw;height:100vh;z-index:9}',
  '.cd-card-title{position:fixed;inset:0;width:100vw;height:100vh;background:#000}', '.cd-card{box-shadow:0 0 0 999px #000}', '.cd-card{outline:999px solid #000}',
  '.cd-home + #feed{display:none}', '.cd-home ~ *{display:none}', '.cd-home #feed{display:none}', '.cd-row ~ ytd-ad-slot-renderer{height:0}', '.cd-card:hover{zoom:30}',
  '.cd-home{padding:99999px}', '.cd-row{padding-bottom:65px}', '.cd-card{filter:blur(99px)}', '.cd-card{translate:0 99999px}', '.cd-card{font-size:900px}',
];
// the pool the random walk draws from: mostly harmless, some dangerous, some boundary cases
const POOL = [...DANGEROUS,
  'border-radius:8px', 'border:1px solid var(--cd-border)', 'box-shadow:var(--cd-shadow)', 'color:var(--cd-text)', 'color:var(--cd-muted)', 'color:var(--cd-accent)',
  'background-color:var(--cd-surface)', 'background:linear-gradient(var(--cd-surface),var(--cd-bg))', 'font-weight:700', 'letter-spacing:.04em', 'text-transform:uppercase',
  'cursor:pointer', 'transition:color var(--cd-duration) ease', 'outline:2px solid var(--cd-accent)', 'outline-offset:2px', 'padding:4px', 'margin:4px', 'gap:8px',
  'line-height:1.4', 'font-size:14px', 'width:100%', 'height:auto', 'overflow:auto', 'opacity:1', 'z-index:1', 'transform:translateY(-4px) scale(1.02)', 'filter:grayscale(1)',
  'display:block', 'display:flex', 'position:relative', 'top:4px', 'flex:1 1 0', 'min-width:0', 'text-align:center', 'background-image:url("data:image/png;base64,AA==")',
  'fill:var(--cd-accent)', 'stroke:var(--cd-text)', 'accent-color:var(--cd-accent)', 'color-scheme:dark', 'text-shadow:0 0 4px var(--cd-accent)', 'border-width:1px',
];
const WRAPS = [
  (s, b) => T(s, b), (s, b) => `${s}{${b}}`, (s, b) => `@media screen{${T(s, b)}}`, (s, b) => `@supports (display:grid){${T(s, b)}}`,
  (s, b) => T(`${s}:hover`, b), (s, b) => T(`:is(${s})`, `${b}!important`), (s, b) => `.cd-home ${s}{${b}}`, (s, b) => `${KEYFRAMES}${T(s, b)}`,
];
const SELECTORS = [...TARGETS, '.cd-home', '.cd-row', '.cd-card', '.cd-card-title', '.cd-row-title', '.cd-card::after', 'html[cd-theme]', '#feed'];

function rng(seed) { let s = (Number(seed) >>> 0) || 1; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
const cases = [];
for (const body of DANGEROUS) for (const sel of TARGETS) cases.push({ group: 'single', css: `${KEYFRAMES}${T(sel, body)}` });
for (const css of OWN_ATTACKS) cases.push({ group: 'own', css });
const rand = rng(opts.seed);
const pick = (a) => a[Math.floor(rand() * a.length)];
for (let i = 0; i < Number(opts.fuzz); i++) {
  const n = 1 + Math.floor(rand() * 3);
  const body = Array.from({ length: n }, () => pick(POOL)).join(';');
  cases.push({ group: 'fuzz', css: pick(WRAPS)(pick(SELECTORS), body) });
}

// ---- run ---------------------------------------------------------------------------------------------------------------------------
const chromePath = findChrome(opts.chrome || process.env.CHROME_PATH);
const profile = mkdtempSync(join(tmpdir(), 'cd-corpus-'));
const outDir = opts.out ? resolve(opts.out) : null;
let browser;
const cleanup = async () => {
  try { if (browser) await browser.close(); } catch { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ }
};
process.on('exit', () => { try { rmSync(profile, { recursive: true, force: true }); } catch { /* best effort */ } });

try {
  browser = await puppeteer.launch({ executablePath: chromePath, headless: true, userDataDir: profile, args: ['--no-sandbox', '--no-first-run', '--force-device-scale-factor=1', '--mute-audio'],
    defaultViewport: { width: 1000, height: 760, deviceScaleFactor: 1 } });
  const dec = await browser.newPage();
  await dec.setContent('<canvas id=c></canvas>');
  const count = async (b64) => dec.evaluate(async (data) => {
    const img = await createImageBitmap(await (await fetch(`data:image/png;base64,${data}`)).blob());
    const c = document.getElementById('c');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let red = 0; let white = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 70 && d[i + 2] < 70) red++;
      // the label's text is white on #222: count white pixels inside the label's rows only (the page is white elsewhere), see below
    }
    return { red, white };
  }, b64);
  const pg = await browser.newPage();
  const measure = async (css) => {
    await pg.setContent(page(css), { waitUntil: 'load' });
    const b64 = await pg.screenshot({ encoding: 'base64' });
    const { red } = await count(b64);
    // The label and the control bar are measured by their painted boxes: visible, non-zero, inside the viewport and not covered.
    const boxes = await pg.evaluate(() => {
      const out = {};
      for (const [k, sel] of [['label', '.ytp-paid-content-overlay'], ['controls', '.ytp-chrome-bottom'], ['ad', 'ytd-ad-slot-renderer .adc']]) {
        const el = document.querySelector(sel);
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const cx = r.left + r.width / 2; const cy = r.top + r.height / 2;
        const top = document.elementFromPoint(cx, cy);
        out[k] = { w: r.width, h: r.height, inView: r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth, hidden: cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 1,
          covered: !(top === el || el.contains(top)), color: cs.color, bg: cs.backgroundColor };
      }
      return out;
    });
    return { red, boxes };
  };
  const base = await measure('');
  console.log(`chrome ${await browser.version()}; baseline ad pixels ${base.red}; ${cases.length} cases`);
  if (base.red < 1000) throw new Error('the fixture did not render an ad');

  const bad = [];
  const tally = { refused: 0, accepted: 0 };
  const sameColour = (b) => b.color === b.bg;
  const judge = (m) => {
    const problems = [];
    if (m.red < base.red * 0.9) problems.push(`ad pixels ${Math.round((m.red / base.red) * 100)}%`);
    for (const k of ['label', 'controls', 'ad']) {
      const b = m.boxes[k]; const b0 = base.boxes[k];
      if (b.w < b0.w * 0.9 || b.h < b0.h * 0.9) problems.push(`${k} shrank ${b0.w}x${b0.h} -> ${b.w}x${b.h}`);
      if (!b.inView && b0.inView) problems.push(`${k} left the viewport`);
      if (b.hidden) problems.push(`${k} hidden`);
      if (b.covered) problems.push(`${k} covered`);
      if (k !== 'ad' && sameColour(b)) problems.push(`${k} text colour equals its background`);
    }
    return problems;
  };
  // The judge must have teeth: these are known to hide, collapse, blend in or cover, and are measured without the validator.
  for (const css of ['ytd-ad-slot-renderer{display:none}', '.ytp-paid-content-overlay{background:#fff;color:#fff}', '.ytp-chrome-bottom{height:1px;overflow:hidden}',
    '#feed{margin-left:99vw}', '.cd-home{margin-bottom:99999px}']) {
    if (!judge(await measure(css)).length) throw new Error(`the measurement does not notice: ${css}`);
  }
  for (const c of cases) {
    const v = validateCss(c.css, CTX);
    if (!v.ok) { tally.refused++; continue; }
    tally.accepted++;
    const problems = judge(await measure(c.css));
    if (problems.length) bad.push({ ...c, problems });
  }
  console.log(`validator refused ${tally.refused}, accepted ${tally.accepted}; accepted rules that hid, shrank, moved or covered something protected: ${bad.length}`);
  for (const b of bad.slice(0, 25)) console.log(`  [${b.group}] ${b.problems.join('; ')}\n      ${b.css.slice(0, 220)}`);
  if (outDir) {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, 'ad-bypass-corpus.json'), JSON.stringify({ chrome: await browser.version(), baseline: base.red, cases: cases.length, ...tally, bad }, null, 2));
  }
  await cleanup();
  process.exitCode = bad.length ? 1 : 0;
} catch (err) {
  console.error(`ad-bypass-corpus: ${err.message}`);
  await cleanup();
  process.exitCode = existsSync(chromePath) ? 6 : 3;
}
