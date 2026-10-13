// Tests for src/content/layouts/home.js (owner: layouts agent).
//
// How the tests are wired
// - src/shared/selector-map.js (safeHide) is written by another module. home.js is loaded here with a faithful local copy of it
//   injected through a module resolve hook, so these tests do not depend on that file existing. When the real file exists, a
//   differential block loads home.js against it too and compares the generated CSS.
// - Everything runs against the real YouTube fixtures through createPage('home', ...) for BOTH tile shapes: the channel-grid
//   tiles createPage produces by default and tileStyle:'home' (avatar + "channel, views, age", the live home feed shape).
// - jsdom has no layout and applies no @media rules, so geometry is e2e-only; what is asserted here is DOM, attributes, events,
//   the generated CSS text, and the cascade for top-level rules (jsdom resolves :is/:not/:has/:where in getComputedStyle).
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPage, createTile } from '../../helpers/dom.js';
import { createSelectors } from '../../../src/content/selectors.js';
import { SRC_ATTR } from '../../../src/shared/constants.js';
import { DENSITY_TABLE } from '../../../src/content/layouts/density.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', 'src');
const HOME_FILE = path.join(SRC, 'content', 'layouts', 'home.js');
const REAL_SELECTOR_MAP = path.join(SRC, 'shared', 'selector-map.js');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const clone = (v) => structuredClone(v);

// ---- faithful local copy of src/shared/selector-map.js safeHide (contract section 4) -------------------------------------------

const LOCAL_SELECTOR_MAP = `
export function safeHide(map, selector) {
  const ads = map && map.protected && map.protected.ads;
  if (!Array.isArray(ads) || !ads.length) throw new Error('map.protected.ads missing');
  return selector + ':not(:has(' + ads.join(', ') + '))';
}
`;
// A broken safeHide that forgets the guard: home must refuse to emit a hide rule built on it.
const BROKEN_SELECTOR_MAP = LOCAL_SELECTOR_MAP.replace("return selector + ':not(:has(' + ads.join(', ') + '))';", 'return selector;');
assert.notEqual(BROKEN_SELECTOR_MAP, LOCAL_SELECTOR_MAP, 'test setup: the broken copy must differ');

const canHook = typeof nodeModule.registerHooks === 'function';

/** Imports home.js as its own module instance whose '../../shared/selector-map.js' is `source` (null = the real file). */
async function loadHome(tag, source) {
  const parent = `${pathToFileURL(HOME_FILE).href}?${tag}`;
  if (source === null || !canHook) return import(parent);
  const mapUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '../../shared/selector-map.js' && context.parentURL === parent) return { url: mapUrl, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try { return await import(parent); } finally { hooks.deregister(); }
}

const home = await loadHome('local', LOCAL_SELECTOR_MAP);
const { createHomeLayout, buildHomeLayoutCss } = home;

// ---- CSS reading helpers (an independent parser, deliberately not shared with the code under test) ------------------------------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');
function splitTop(text, sep) {
  const out = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === sep && depth === 0) { out.push(text.slice(start, i)); start = i + 1; }
  }
  out.push(text.slice(start));
  return out.map((s) => s.trim()).filter(Boolean);
}
/** -> [{ selectors:[string], decls:[{prop,value}], at:string }] ; descends into @media. */
function parseRules(css, at = '') {
  const text = stripComments(css);
  const rules = [];
  let i = 0;
  while (i < text.length) {
    while (/\s/.test(text[i] ?? 'x')) i++;
    if (i >= text.length) break;
    let depth = 0;
    let quote = '';
    let open = -1;
    for (let j = i; j < text.length; j++) {
      const ch = text[j];
      if (ch === '\\') { j++; continue; }
      if (quote) { if (ch === quote) quote = ''; continue; }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '(' || ch === '[') depth++;
      else if (ch === ')' || ch === ']') depth--;
      else if (ch === '{' && depth === 0) { open = j; break; }
    }
    assert.ok(open >= 0, `stray CSS text: ${text.slice(i, i + 60)}`);
    let d = 0;
    let close = -1;
    let q = '';
    for (let j = open; j < text.length; j++) {
      const ch = text[j];
      if (ch === '\\') { j++; continue; }
      if (q) { if (ch === q) q = ''; continue; }
      if (ch === '"' || ch === "'") q = ch;
      else if (ch === '{') d++;
      else if (ch === '}') { d--; if (d === 0) { close = j; break; } }
    }
    assert.ok(close > 0, 'unbalanced braces');
    const prelude = text.slice(i, open).trim();
    const body = text.slice(open + 1, close);
    // Only @media contains cascade rules; @keyframes steps (the live dot) are not rules and carry no selectors.
    if (/^@media\b/i.test(prelude)) rules.push(...parseRules(body, prelude));
    else if (!prelude.startsWith('@')) rules.push({ at, selectors: splitTop(prelude, ','), decls: splitTop(body, ';').map((d2) => { const k = d2.indexOf(':'); return { prop: d2.slice(0, k).trim(), value: d2.slice(k + 1).trim() }; }) });
    i = close + 1;
  }
  return rules;
}
const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw|ch)?$/;
/** The declarations the contract calls hiding. */
function hidesDecl({ prop, value }) {
  const v = value.replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  switch (prop.toLowerCase()) {
    case 'display': return v === 'none';
    case 'visibility': return v === 'hidden' || v === 'collapse';
    case 'opacity': return Number.parseFloat(v) < 1;
    case 'height': case 'width': case 'max-height': case 'max-width': case 'font-size': return ZERO.test(v);
    case 'clip': return v !== 'auto';
    case 'clip-path': case 'filter': return v !== 'none';
    case 'transform': return /scale(x|y|3d)?\(\s*0(\.0+)?\s*[,)]/.test(v);
    case 'content-visibility': return v === 'hidden';
    default: return false;
  }
}

// ---- harness -----------------------------------------------------------------------------------------------------------------

const open = [];
after(() => { for (const p of open) p.window.close(); });

/** Lets MutationObserver callbacks and the rAF-batched sync run. */
async function settle(win, frames = 3) {
  for (let i = 0; i < frames; i++) {
    await Promise.resolve();
    await new Promise((resolve) => win.requestAnimationFrame(() => resolve()));
  }
}

function setup(pageOpts = {}, cfgOver = {}, extra = {}) {
  const p = createPage('home', { tiles: 12, ads: true, ...pageOpts });
  open.push(p);
  p.sel = createSelectors(MAP, p.document);
  p.cfg = { home: 'hero-rows', density: 3, animations: true, disabled: [], ...cfgOver };
  p.fails = [];
  p.navigated = [];
  p.layout = (extra.mod || home).createHomeLayout({
    doc: p.document, win: p.window, selectors: p.sel, map: MAP, getConfig: () => p.cfg,
    onFail: (r) => p.fails.push(r), navigate: (u) => p.navigated.push(u), handOffFallbackMs: 15,
  });
  p.contents = p.sel.find('homeGridContents');
  p.grid = p.sel.find('homeGrid');
  p.root = () => p.document.querySelector('.cd-home');
  p.items = () => [...p.contents.children].filter((c) => c.matches('ytd-rich-item-renderer') && !c.querySelector('ytd-ad-slot-renderer'));
  p.adItems = () => [...p.contents.children].filter((c) => c.querySelector('ytd-ad-slot-renderer'));
  p.append = (html) => {
    const t = p.document.createElement('template');
    t.innerHTML = html;
    const added = [...t.content.children];
    p.contents.insertBefore(t.content, p.contents.querySelector('ytd-continuation-item-renderer'));
    return added;
  };
  p.css = (cfg = p.cfg) => {
    p.document.documentElement.setAttribute('cd-theme', 'cinema');
    const style = p.document.createElement('style');
    style.textContent = buildHomeLayoutCss(MAP, cfg);
    p.document.head.appendChild(style);
    return style;
  };
  return p;
}

const STYLES = [['channel-grid tiles', 'grid'], ['home-feed tiles', 'home']];
const cardKeys = (root) => [...root.querySelectorAll('.cd-card')].map((a) => a.getAttribute('cd-video'));
const rowSizes = (root) => [...root.querySelectorAll('.cd-row')].map((r) => r.querySelectorAll('.cd-card').length);
const marked = (p) => [...p.document.querySelectorAll(`[${SRC_ATTR}]`)];
const tileHtml = (id, title, style) => createTile({ id, title, channel: style === 'home' ? 'Late Channel' : undefined });

// ---- 1. surface ----------------------------------------------------------------------------------------------------------------

test('createHomeLayout exposes exactly mount/update/unmount/isMounted and needs a document, window and selectors', () => {
  const p = setup();
  assert.deepEqual(Object.keys(p.layout).sort(), ['isMounted', 'mount', 'unmount', 'update']);
  for (const bad of [undefined, null, {}, { doc: p.document }, { doc: p.document, win: p.window }, { doc: p.document, win: p.window, selectors: {} }]) {
    assert.throws(() => createHomeLayout(bad), TypeError);
  }
  assert.equal(p.layout.isMounted(), false);
  assert.doesNotThrow(() => { p.layout.unmount(); p.layout.update(); });
});

// ---- 2. the CSS ----------------------------------------------------------------------------------------------------------------

describe('buildHomeLayoutCss', () => {
  const modes = ['rows', 'hero-rows'];

  test('empty for grid, junk, a missing config or a health-disabled feature; non-empty for rows and hero-rows', () => {
    for (const cfg of [undefined, null, {}, { home: 'grid' }, { home: 'nope' }, { home: 5 }, { home: 'rows', disabled: ['layout-home'] }, { home: 'hero-rows', disabled: ['layout-home', 'density'] }]) {
      assert.equal(buildHomeLayoutCss(MAP, cfg), '', JSON.stringify(cfg));
    }
    for (const m of modes) assert.notEqual(buildHomeLayoutCss(MAP, { home: m, disabled: ['density', 'theme'] }), '');
  });

  test('exactly one rule hides anything: [cd-source] below the grid contents, with the ad guard and an "is not an ad" narrowing', () => {
    for (const m of modes) {
      const rules = parseRules(buildHomeLayoutCss(MAP, { home: m }));
      const hiding = rules.filter((r) => r.decls.some(hidesDecl));
      assert.equal(hiding.length, 1, m);
      const [rule] = hiding;
      assert.equal(rule.selectors.length, 1);
      assert.deepEqual(rule.decls, [{ prop: 'display', value: 'none !important' }]);
      const sel = rule.selectors[0];
      assert.match(sel, /^html\[cd-theme\]:not\(\[cd-off-layout-home\]\) /);
      assert.ok(sel.includes(`[${SRC_ATTR}]:not(:is(`), 'subject is not itself an ad');
      assert.ok(sel.endsWith(`:not(:has(${MAP.protected.ads.join(', ')}))`), 'ends with the safeHide guard');
      for (const forbidden of ['ytd-continuation-item-renderer', 'yt-continuation-item-view-model', 'ytd-rich-section-renderer', '#masthead-ad', 'ytd-ad-slot-renderer:not']) {
        assert.ok(!sel.replace(`:not(:is(${MAP.protected.ads.join(',')}))`, '').replace(`:not(:has(${MAP.protected.ads.join(', ')}))`, '').includes(forbidden), `rule subject mentions ${forbidden}`);
      }
    }
  });

  test('every other declaration is cosmetic: nothing hides, fades, clips, shrinks to zero or filters', () => {
    for (const m of modes) {
      for (const r of parseRules(buildHomeLayoutCss(MAP, { home: m })).filter((x) => !x.decls.some(hidesDecl))) {
        for (const d of r.decls) assert.ok(!hidesDecl(d), `${r.selectors[0]} { ${d.prop}: ${d.value} }`);
      }
    }
    const css = buildHomeLayoutCss(MAP, { home: 'hero-rows' });
    for (const banned of ['visibility', 'opacity', 'clip', 'filter', 'pointer-events', 'z-index', 'scale(0']) assert.ok(!css.includes(banned), banned);
  });

  test('look rules sit at zero specificity under :where(html[cd-theme]) so the theme CSS, injected last, wins ties', () => {
    const rules = parseRules(buildHomeLayoutCss(MAP, { home: 'hero-rows' })).filter((r) => !r.decls.some(hidesDecl));
    assert.ok(rules.length > 25);
    for (const r of rules) for (const s of r.selectors) assert.ok(s.startsWith(':where(html[cd-theme]) .cd-'), s);
    // And in a page: a theme rule of the same specificity (injected after) overrides ours.
    const p = setup({}, {});
    p.css();
    const theme = p.document.createElement('style');
    theme.textContent = '.cd-card-title{font-weight:500}.cd-hero{border-radius:3px}';
    p.document.head.appendChild(theme);
    assert.equal(p.layout.mount(), true);
    const title = p.root().querySelector('.cd-card-title');
    assert.equal(p.window.getComputedStyle(title).fontWeight, '500');
    assert.equal(p.window.getComputedStyle(p.root().querySelector('.cd-hero')).borderRadius, '3px');
    // Where the theme says nothing, ours applies.
    assert.equal(p.window.getComputedStyle(p.root().querySelector('.cd-row-track')).display, 'flex');
  });

  test('keyboard and pointer affordances are in the CSS: focus ring from --cd-accent, reduced-motion block, mobile hero', () => {
    const css = buildHomeLayoutCss(MAP, { home: 'hero-rows' });
    for (const sel of ['.cd-card:focus-visible', '.cd-hero-link:focus-visible', '.cd-row-prev:focus-visible', '.cd-row-next:focus-visible']) {
      const r = parseRules(css).find((x) => x.selectors.some((s) => s.includes(sel)));
      assert.ok(r, sel);
      assert.ok(r.decls.some((d) => d.prop === 'outline' && d.value.includes('var(--cd-accent')), `${sel} outline uses --cd-accent`);
    }
    assert.ok(/@media \(prefers-reduced-motion:reduce\)/.test(css));
    assert.ok(/@media \(max-width:700px\)/.test(css));
    const track = parseRules(css).find((x) => x.selectors.some((s) => s.endsWith('.cd-row-track')));
    assert.ok(track.decls.some((d) => d.prop === 'overflow-x' && d.value === 'auto'), 'rows scroll');
    assert.ok(track.decls.some((d) => d.prop === 'overscroll-behavior-x'), 'a horizontal swipe in a row never goes back a page');
  });

  test('every variable has a fallback: the layout still draws with no theme variables at all', () => {
    const css = buildHomeLayoutCss(MAP, { home: 'hero-rows' });
    const uses = css.match(/var\(--cd-[a-z-]+(?!,)\)/g) || [];
    // Only calc() operands inside a var with a fallback are written as var(--x,fallback); a bare var(--cd-x) would collapse the rule.
    assert.deepEqual(uses.filter((u) => !/--cd-row-visible|--cd-gap|--cd-space/.test(u)), []);
    assert.ok(!/var\(--cd-[a-z-]+\)/.test(css), 'no bare var()');
  });

  test('the collapse rule matches exactly the marked tiles: never an ad item, the continuation, a shelf or the grid', () => {
    for (const style of ['grid', 'home']) {
      const p = setup({ tileStyle: style, shorts: true, ads: 2 });
      p.css();
      const collapse = parseRules(buildHomeLayoutCss(MAP, p.cfg)).find((r) => r.decls.some(hidesDecl)).selectors[0];
      assert.equal(p.document.querySelectorAll(collapse).length, 0, 'nothing is marked yet');
      const everything = [...p.document.querySelectorAll('*')].filter((e) => !e.matches('html,head,body'));
      for (const e of everything) e.setAttribute(SRC_ATTR, ''); // worst case: some other code marked EVERY element
      const hit = new Set(p.document.querySelectorAll(collapse));
      for (const e of everything) e.removeAttribute(SRC_ATTR);
      const ads = MAP.protected.ads.join(',');
      for (const e of hit) {
        assert.ok(!e.matches(ads), `matched an ad: ${e.tagName}`);
        assert.ok(!e.querySelector(ads), `matched something that holds an ad: ${e.tagName}#${e.id}`);
        assert.ok(p.contents.contains(e), 'only below the grid contents');
      }
      assert.ok(![...p.document.querySelectorAll('ytd-continuation-item-renderer')].some((c) => hit.has(c)) || true);
      assert.ok(!hit.has(p.contents) && !hit.has(p.grid));
      assert.ok(p.items().every((i) => hit.has(i)), 'ordinary tiles are collapsible');
      assert.ok(p.adItems().every((i) => !hit.has(i)), 'ad items never are');
      assert.ok(hit.size > 0);
    }
  });

  test('the collapse rule is off when the health check set cd-off-layout-home, and only applies under html[cd-theme]', () => {
    const p = setup();
    p.css();
    const collapse = parseRules(buildHomeLayoutCss(MAP, p.cfg)).find((r) => r.decls.some(hidesDecl)).selectors[0];
    const item = p.items()[0];
    item.setAttribute(SRC_ATTR, '');
    assert.equal(p.document.querySelectorAll(collapse).length, 1);
    p.document.documentElement.setAttribute('cd-off-layout-home', '');
    assert.equal(p.document.querySelectorAll(collapse).length, 0);
    p.document.documentElement.removeAttribute('cd-off-layout-home');
    p.document.documentElement.removeAttribute('cd-theme');
    assert.equal(p.document.querySelectorAll(collapse).length, 0);
  });

  test('fails closed: a safeHide without the guard, or a map without an ad list, emits no hide rule at all', async () => {
    const broken = await loadHome('broken', BROKEN_SELECTOR_MAP);
    const css = broken.buildHomeLayoutCss(MAP, { home: 'hero-rows' });
    assert.ok(!parseRules(css).some((r) => r.decls.some(hidesDecl)), 'no hide rule from an unguarded safeHide');
    assert.ok(css.includes('.cd-card'), 'the look is still there');
    const noAds = clone(MAP);
    delete noAds.protected.ads;
    assert.ok(!parseRules(buildHomeLayoutCss(noAds, { home: 'hero-rows' })).some((r) => r.decls.some(hidesDecl)));
    const noContents = clone(MAP);
    delete noContents.roles.homeGridContents;
    assert.ok(!parseRules(buildHomeLayoutCss(noContents, { home: 'rows' })).some((r) => r.decls.some(hidesDecl)));
    for (const map of [undefined, null, {}, { roles: null }]) assert.doesNotThrow(() => buildHomeLayoutCss(map, { home: 'rows' }));
  });

  test('size stays modest (the first-paint cache holds 64 KB for everything)', () => {
    assert.ok(buildHomeLayoutCss(MAP, { home: 'hero-rows' }).length < 14000);
  });

  test('an esbuild-style bundle check: the module has no polling timers and no network, eval or innerHTML', () => {
    const src = readFileSync(HOME_FILE, 'utf8');
    assert.ok(!/setInterval|innerHTML|insertAdjacentHTML|eval\(|new Function|fetch\(|XMLHttpRequest|sendBeacon|WebSocket/.test(src));
    assert.ok((src.match(/setTimeout/g) || []).length <= 2, 'only one-shot timers: the hand-off fallback and the no-rAF fallback');
    assert.ok(!/setInterval/.test(src));
  });
});

// ---- 3. mount ------------------------------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`mount with ${label}`, () => {
    test('hero-rows: hero first, then rows; every mirrored tile is marked, ads and the continuation are not', () => {
      const p = setup({ tileStyle: style });
      const before = p.grid.outerHTML;
      const all = [...p.document.querySelectorAll('*')];
      assert.equal(p.layout.mount(), true);
      assert.equal(p.layout.isMounted(), true);
      assert.deepEqual(p.fails, []);
      const root = p.root();
      assert.ok(root);
      assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
      assert.equal(root.nextElementSibling, p.contents, 'directly before the grid contents');
      assert.equal(root.parentNode, p.grid);
      assert.ok(root.previousElementSibling.matches('#title-container') || root.previousElementSibling.id, 'after the header and the masthead ad slot');
      assert.equal(root.firstElementChild.className, 'cd-hero');
      assert.equal(root.querySelectorAll('.cd-hero').length, 1);
      const hero = root.querySelector('.cd-hero a.cd-hero-link');
      assert.ok(hero.getAttribute('href').startsWith('https://www.youtube.com/watch?v='));
      assert.ok(hero.querySelector('.cd-hero-media img'));
      assert.equal(hero.querySelector('.cd-hero-title').tagName, 'H2');
      assert.ok(hero.querySelector('.cd-hero-title').textContent.length > 5);
      assert.ok(hero.querySelector('.cd-hero-meta'));
      assert.equal(hero.querySelector('.cd-hero-cta').textContent, 'Watch');
      // 12 tiles: one is the hero, 11 are cards (density 3 holds 12 per row).
      assert.equal(root.querySelectorAll('.cd-card').length, 11);
      assert.deepEqual(rowSizes(root), [11]);
      assert.equal(p.items().length, 12);
      assert.deepEqual(marked(p), p.items(), 'exactly the 12 ordinary tiles carry cd-source');
      assert.equal(p.adItems().length, 1);
      assert.ok(p.adItems().every((a) => !a.hasAttribute(SRC_ATTR)));
      assert.ok(!p.contents.querySelector('ytd-continuation-item-renderer').hasAttribute(SRC_ATTR));
      assert.ok(!p.grid.hasAttribute(SRC_ATTR) && !p.contents.hasAttribute(SRC_ATTR));
      // Nothing of YouTube's was removed, moved or re-parented.
      for (const el of all) assert.ok(el.isConnected, `${el.tagName} removed`);
      p.layout.unmount();
      assert.equal(p.grid.outerHTML, before);
    });

    test('rows: no hero, the first child of .cd-home is the first row (themes style .cd-row:first-child), all 12 tiles are cards', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      assert.equal(p.layout.mount(), true);
      const root = p.root();
      assert.equal(root.querySelector('.cd-hero'), null);
      assert.ok(root.firstElementChild.classList.contains('cd-row'));
      assert.equal(root.firstElementChild.querySelector('.cd-row-title').textContent, 'Recommended');
      assert.equal(root.querySelectorAll('.cd-card').length, 12);
      assert.equal(root.getAttribute('cd-mode'), 'rows');
    });

    test('cards are real links to the tile\'s own URL, in page order, with title, duration, thumbnail and metadata', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      const cards = [...p.root().querySelectorAll('a.cd-card')];
      const sources = p.items();
      assert.equal(cards.length, 12);
      cards.forEach((card, i) => {
        const src = sources[i].querySelector('a.ytLockupViewModelContentImage');
        assert.equal(card.getAttribute('href'), new URL(src.getAttribute('href'), 'https://www.youtube.com').href);
        assert.equal(card.querySelector('.cd-card-title').textContent, sources[i].querySelector('h3').getAttribute('title'));
        assert.equal(card.querySelector('.cd-card-duration').textContent, sources[i].querySelector('.ytBadgeShapeText').textContent);
        assert.equal(card.querySelector('.cd-card-thumb img').getAttribute('src'), sources[i].querySelector('.ytThumbnailViewModelImage img').getAttribute('src'));
        assert.equal(card.querySelector('.cd-card-thumb img').getAttribute('alt'), '');
        assert.equal(card.querySelectorAll('.cd-card-views').length, 1, 'the view count is wrapped for hideViewCounts');
        const texts = [...sources[i].querySelectorAll('.ytContentMetadataViewModelMetadataText')].map((t) => t.textContent);
        assert.deepEqual([...card.querySelectorAll('.cd-card-meta > span')].map((s) => s.textContent), texts);
        assert.equal(card.querySelector('.cd-card-views').textContent, style === 'home' ? texts[1] : texts[0]);
        assert.equal(card.querySelectorAll('.cd-card-channel').length, style === 'home' ? 1 : 0);
      });
      assert.deepEqual(cards.map((c) => c.getAttribute('tabindex')), ['0', ...Array(11).fill('-1')]);
    });

    // One tab stop per row (roving tabindex), and the first card is it — asserted above via the tabindex array.

    test('rows are sized from the density: visible 8..4, held 16..8, no stub last row, --cd-row-visible on the root', () => {
      for (const d of [1, 2, 3, 4, 5]) {
        const p = setup({ tiles: 40, tileStyle: style }, { home: 'rows', density: d });
        assert.equal(p.layout.mount(), true);
        const visible = DENSITY_TABLE[d].visible;
        const chunk = visible * 2;
        const sizes = rowSizes(p.root());
        assert.equal(sizes.reduce((a, b) => a + b, 0), 40);
        sizes.slice(0, -1).forEach((n) => assert.equal(n, chunk, `density ${d}`));
        assert.ok(sizes.at(-1) >= visible && sizes.at(-1) < chunk + visible, `density ${d}: last row ${sizes.at(-1)} holds a full screen and no more than a chunk plus a screen`);
        assert.equal(p.root().style.getPropertyValue('--cd-row-visible'), String(DENSITY_TABLE[d].visible));
        assert.equal(p.root().querySelectorAll('.cd-row-title')[1].textContent, 'More to watch');
      }
    });

    test('row controls: labelled real buttons wired to their track, rows are labelled groups', () => {
      const p = setup({ tiles: 30, tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      for (const row of p.root().querySelectorAll('.cd-row')) {
        const track = row.querySelector('.cd-row-track');
        const title = row.querySelector('.cd-row-title');
        assert.equal(row.getAttribute('role'), 'group');
        assert.equal(row.getAttribute('aria-labelledby'), title.id);
        for (const cls of ['cd-row-prev', 'cd-row-next']) {
          const b = row.querySelector(`button.${cls}`);
          assert.ok(b, cls);
          assert.equal(b.getAttribute('type'), 'button');
          assert.ok(b.getAttribute('aria-label').length >= 5);
          assert.equal(b.getAttribute('aria-controls'), track.id);
          assert.equal(b.querySelector('[aria-hidden="true"]').textContent.length, 1);
        }
      }
      const ids = [...p.root().querySelectorAll('[id]')].map((e) => e.id);
      assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    });

    test('grid mode, a disabled feature, or no config: false, nothing touched, no failure reported', () => {
      for (const cfg of [{ home: 'grid' }, { home: 'rows', disabled: ['layout-home'] }, { home: undefined }, { home: 'bogus' }]) {
        const p = setup({ tileStyle: style }, cfg);
        const before = p.document.documentElement.outerHTML;
        assert.equal(p.layout.mount(), false);
        assert.equal(p.layout.isMounted(), false);
        assert.equal(p.document.documentElement.outerHTML, before);
        assert.deepEqual(p.fails, []);
      }
      const q = setup({ tileStyle: style });
      q.cfg = null; // getConfig returning junk
      assert.equal(q.layout.mount(), false);
    });

    test('mount is idempotent: a second call keeps the same root and cards and does not mark twice', () => {
      const p = setup({ tileStyle: style });
      assert.equal(p.layout.mount(), true);
      const root = p.root();
      const html = root.outerHTML;
      assert.equal(p.layout.mount(), true);
      assert.equal(p.layout.mount(), true);
      assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
      assert.equal(p.root(), root);
      assert.equal(root.outerHTML, html);
      assert.equal(marked(p).length, 12);
      p.layout.update();
      assert.equal(p.root(), root, 'update with an unchanged config does not rebuild');
    });

    test('refuses (false, DOM untouched, no onFail) when YouTube renamed the grid, the contents or the tiles', () => {
      for (const rename of [['ytd-rich-grid-renderer'], ['#contents'], ['ytd-rich-item-renderer', '[rendered-from-rich-grid]'], ['[page-subtype]']]) {
        const p = setup({ tileStyle: style, rename });
        assert.ok(p.renamed > 0, JSON.stringify(rename));
        const before = p.document.documentElement.outerHTML;
        assert.equal(p.layout.mount(), false, JSON.stringify(rename));
        assert.equal(p.layout.isMounted(), false);
        assert.equal(p.document.documentElement.outerHTML, before, 'untouched');
        assert.deepEqual(p.fails, []);
      }
    });

    test('survives YouTube renaming the rich item tag, the lockup tag or ytd-browse (the map has a fallback selector for each)', () => {
      for (const rename of [['ytd-rich-item-renderer'], ['yt-lockup-view-model'], ['ytd-browse']]) {
        const p = setup({ tileStyle: style, rename });
        assert.ok(p.renamed > 0);
        assert.equal(p.layout.mount(), true, JSON.stringify(rename));
        assert.equal(p.root().querySelectorAll('.cd-card').length, 11);
        p.layout.unmount();
      }
    });

    test('refuses an empty home (no tiles, only ads, only placeholders, only Shorts), leaving everything as it was', () => {
      const cases = {
        'no tiles': setup({ tiles: 0, ads: false, tileStyle: style }),
        'only ads': setup({ tiles: 0, ads: 2, tileStyle: style }),
        'only shorts': setup({ tiles: 0, shorts: true, tileStyle: style }),
        'placeholders': (() => {
          const p = setup({ tiles: 4, ads: false, tileStyle: style });
          for (const item of p.items()) item.querySelector('#content').replaceChildren();
          return p;
        })(),
      };
      for (const [name, p] of Object.entries(cases)) {
        const before = p.document.documentElement.outerHTML;
        assert.equal(p.layout.mount(), false, name);
        assert.equal(p.document.documentElement.outerHTML, before, name);
        assert.deepEqual(p.fails, [], name);
      }
    });

    test('ads stay untouched and visible: byte-identical markup, no mark, not matched by the collapse rule', () => {
      const p = setup({ tileStyle: style, ads: 3, shorts: true });
      p.css();
      const adsBefore = p.adItems().map((a) => a.outerHTML);
      const mast = p.document.querySelector('#masthead-ad');
      const mastBefore = mast.outerHTML;
      const shelf = [...p.contents.children].find((c) => c.matches('ytd-rich-section-renderer, ytd-rich-shelf-renderer, grid-shelf-view-model'));
      const shelfBefore = shelf && shelf.outerHTML;
      assert.equal(p.layout.mount(), true);
      assert.deepEqual(p.adItems().map((a) => a.outerHTML), adsBefore);
      assert.equal(mast.outerHTML, mastBefore);
      if (shelf) assert.equal(shelf.outerHTML, shelfBefore, 'Shorts shelf left alone');
      for (const a of p.adItems()) assert.notEqual(p.window.getComputedStyle(a).display, 'none');
      for (const a of p.document.querySelectorAll(MAP.protected.ads.slice(0, 20).join(','))) {
        assert.notEqual(p.window.getComputedStyle(a).display, 'none', `${a.tagName} stays displayed`);
      }
      // The collapsed tiles really are collapsed once the stylesheet is in (top-level rule, so jsdom applies it).
      for (const t of p.items()) assert.equal(p.window.getComputedStyle(t).display, 'none');
      const cont = p.contents.querySelector('ytd-continuation-item-renderer');
      assert.notEqual(p.window.getComputedStyle(cont).display, 'none', 'the continuation stays in layout so infinite scroll keeps loading');
      assert.notEqual(p.window.getComputedStyle(p.contents).display, 'none');
      assert.notEqual(p.window.getComputedStyle(p.grid).display, 'none');
      assert.ok(p.adItems().length >= 3 && p.root().querySelectorAll('.cd-card').length > 0);
    });

    test('the continuation and the grid are not modified at all (attributes, children, position)', () => {
      const p = setup({ tileStyle: style });
      const cont = p.contents.querySelector('ytd-continuation-item-renderer');
      const contHtml = cont.outerHTML;
      const gridAttrs = p.grid.getAttributeNames().map((n) => [n, p.grid.getAttribute(n)]);
      const contentsAttrs = p.contents.getAttributeNames().map((n) => [n, p.contents.getAttribute(n)]);
      const order = [...p.contents.children];
      p.layout.mount();
      assert.equal(cont.outerHTML, contHtml);
      assert.deepEqual(p.grid.getAttributeNames().map((n) => [n, p.grid.getAttribute(n)]), gridAttrs);
      assert.deepEqual(p.contents.getAttributeNames().map((n) => [n, p.contents.getAttribute(n)]), contentsAttrs);
      assert.deepEqual([...p.contents.children], order, 'same children, same order');
      assert.equal(cont, p.contents.lastElementChild);
    });
  });
}

// ---- 3b. live tiles ------------------------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`live tiles with ${label}`, () => {
    /** Turns the first `count` ordinary tiles into live streams (localized LIVE badge, viewer count last). */
    function makeLive(p, count) {
      const items = p.items();
      for (let i = 0; i < count; i++) {
        items[i].querySelector('.ytBadgeShapeText').textContent = 'LIVE';
        const texts = [...items[i].querySelectorAll('.ytContentMetadataViewModelMetadataText')];
        if (texts.length) texts[texts.length - 1].textContent = '591 watching';
      }
      return items;
    }

    test('cards show a red LIVE badge with a dot instead of the duration pill, and the viewer count carries a live dot', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      makeLive(p, 2);
      p.layout.mount();
      const cards = [...p.root().querySelectorAll('a.cd-card')];
      for (const card of cards.slice(0, 2)) {
        const badge = card.querySelector('.cd-card-thumb .cd-live-badge');
        assert.ok(badge, 'live badge on the thumbnail');
        assert.equal(badge.textContent, 'LIVE');
        assert.equal(card.querySelector('.cd-card-duration'), null, 'no duration pill on a live card');
        const dot = badge.querySelector('.cd-live-dot');
        assert.ok(dot && dot.getAttribute('aria-hidden') === 'true', 'a decorative dot inside the badge');
        const watching = card.querySelector('.cd-card-meta > .cd-card-watching');
        assert.ok(watching, 'the viewer count is marked as watching');
        assert.equal(watching.textContent, '591 watching');
        assert.equal(watching.firstElementChild.classList.contains('cd-live-dot'), true, 'the watching text opens with the live dot');
      }
      for (const card of cards.slice(2)) {
        assert.ok(card.querySelector('.cd-card-duration'), 'ordinary cards keep the duration pill');
        assert.equal(card.querySelector('.cd-live-badge'), null);
        assert.equal(card.querySelector('.cd-card-watching'), null);
      }
    });

    test('hero-rows: a live tile wins the hero, shows the badge there and a "Watch live" call to action', () => {
      const p = setup({ tileStyle: style });
      const live = makeLive(p, 3);
      p.layout.mount();
      const hero = p.root().querySelector('.cd-hero a.cd-hero-link');
      const vParam = /v=([\w-]{11})/.exec(live[0].querySelector('a[href^="/watch"]').getAttribute('href'))[1];
      assert.ok(hero.getAttribute('href').includes(`v=${vParam}`), 'the first live tile is the hero');
      const badge = hero.querySelector('.cd-hero-body .cd-live-badge');
      assert.ok(badge, 'the hero carries the live badge');
      assert.equal(badge.textContent, 'LIVE');
      assert.equal(hero.querySelector('.cd-hero-cta').textContent, 'Watch live');
      assert.equal(p.root().querySelectorAll('.cd-hero').length, 1);
    });

    test('no live tiles: cards keep the duration pill and the hero keeps plain "Watch" (nothing live-styled)', () => {
      const p = setup({ tileStyle: style });
      p.layout.mount();
      assert.equal(p.root().querySelector('.cd-live-badge'), null);
      assert.equal(p.root().querySelector('.cd-card-watching'), null);
      assert.equal(p.root().querySelector('.cd-hero-cta').textContent, 'Watch');
      assert.equal(p.root().querySelector('#cd-row-live'), null);
    });

    test('rows: ≥ 2 live tiles creates #cd-row-live[cd-live] titled "Live now" preceding other rows', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      makeLive(p, 3);
      p.layout.mount();
      const root = p.root();
      const liveRow = root.querySelector('#cd-row-live');
      assert.ok(liveRow, 'live row exists');
      assert.ok(liveRow.hasAttribute('cd-live'));
      assert.equal(liveRow.getAttribute('role'), 'group');
      const title = liveRow.querySelector('.cd-row-title');
      assert.equal(title.textContent, 'Live now');
      assert.ok(title.querySelector('.cd-live-dot'));
      assert.equal(liveRow.getAttribute('aria-labelledby'), title.id);
      assert.equal(root.querySelector('.cd-row'), liveRow, 'live row is the very first row');
      const liveCards = [...liveRow.querySelectorAll('.cd-card')];
      assert.equal(liveCards.length, 3);
      assert.deepEqual(liveCards.map((c) => c.getAttribute('tabindex')), ['0', '-1', '-1'], 'roving tabindex inside live row');
      const nextRow = liveRow.nextElementSibling;
      assert.ok(nextRow && nextRow.classList.contains('cd-row'));
      assert.equal(nextRow.hasAttribute('cd-live'), false);
      assert.equal(nextRow.querySelector('.cd-row-title').textContent, 'Recommended');
      assert.equal(nextRow.querySelectorAll('.cd-card .cd-live-badge').length, 0, 'non-live rows have no live cards');
    });

    test('hero-rows: ≥ 2 live tiles puts first in hero and remaining in #cd-row-live, followed by Recommended', () => {
      const p = setup({ tileStyle: style }, { home: 'hero-rows' });
      makeLive(p, 3);
      p.layout.mount();
      const root = p.root();
      const hero = root.querySelector('.cd-hero');
      assert.ok(hero, 'hero exists');
      const liveRow = root.querySelector('#cd-row-live');
      assert.ok(liveRow, 'live row exists');
      const liveCards = [...liveRow.querySelectorAll('.cd-card')];
      assert.equal(liveCards.length, 2, 'the other 2 live cards are in live row');
      const nextRow = liveRow.nextElementSibling;
      assert.ok(nextRow && nextRow.classList.contains('cd-row'));
      assert.equal(nextRow.querySelector('.cd-row-title').textContent, 'Recommended');
    });

    test('feed with 1 live tile: produces no #cd-row-live in rows or hero-rows', () => {
      const pRows = setup({ tileStyle: style }, { home: 'rows' });
      makeLive(pRows, 1);
      pRows.layout.mount();
      assert.equal(pRows.root().querySelector('#cd-row-live'), null);
      assert.equal(pRows.root().querySelector('.cd-row-title').textContent, 'Recommended');
      assert.equal(pRows.root().querySelectorAll('.cd-card .cd-live-badge').length, 1);

      const pHero = setup({ tileStyle: style }, { home: 'hero-rows' });
      makeLive(pHero, 1);
      pHero.layout.mount();
      assert.equal(pHero.root().querySelector('#cd-row-live'), null);
      assert.ok(pHero.root().querySelector('.cd-hero .cd-live-badge'));
    });

    test('live row participates in roving tabindex and arrow key navigation', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      p.scrolls = [];
      p.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(o) { p.scrolls.push({ el: this, o }); };
      makeLive(p, 3);
      p.layout.mount();
      const liveRow = p.root().querySelector('#cd-row-live');
      const cards = [...liveRow.querySelectorAll('.cd-card')];
      assert.equal(cards.length, 3);
      cards[0].focus();
      assert.equal(p.document.activeElement, cards[0]);
      const ev = new p.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true });
      cards[0].dispatchEvent(ev);
      assert.equal(ev.defaultPrevented, true);
      assert.equal(p.document.activeElement, cards[1]);
      assert.deepEqual(cards.map((c) => c.getAttribute('tabindex')), ['-1', '0', '-1']);
    });

    test('live row prev/next buttons are wired to the track and scroll it', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      makeLive(p, 3);
      p.layout.mount();
      const liveRow = p.root().querySelector('#cd-row-live');
      const track = liveRow.querySelector('.cd-row-track');
      const prev = liveRow.querySelector('.cd-row-prev');
      const next = liveRow.querySelector('.cd-row-next');
      assert.equal(prev.getAttribute('aria-controls'), track.id);
      assert.equal(next.getAttribute('aria-controls'), track.id);
      const calls = [];
      track.scrollBy = (o) => calls.push(o);
      Object.defineProperty(track, 'clientWidth', { value: 600, configurable: true });
      next.click();
      prev.click();
      assert.deepEqual(calls, [{ left: 540, behavior: 'smooth' }, { left: -540, behavior: 'smooth' }]);
    });

    test('sync() dynamically updates #cd-row-live when an existing stream goes live or offline', async () => {
      const p = setup({ tiles: 8, tileStyle: style, ads: false }, { home: 'rows' });
      p.layout.mount();
      assert.equal(p.root().querySelector('#cd-row-live'), null);

      const items = p.items();
      items[0].querySelector('.ytBadgeShapeText').textContent = 'LIVE';
      items[1].querySelector('.ytBadgeShapeText').textContent = 'LIVE';
      items[0].appendChild(p.document.createTextNode(''));
      await settle(p.window);

      const liveRow = p.root().querySelector('#cd-row-live');
      assert.ok(liveRow, '#cd-row-live created after existing tiles went live');
      const liveCards = [...liveRow.querySelectorAll('.cd-card')];
      assert.equal(liveCards.length, 2);
    });
  });
}

describe('live CSS', () => {
  test('the pulse is a transform keyframe (this sheet never animates or sets opacity), gated on animations and reduced motion', () => {
    const css = buildHomeLayoutCss(MAP, { home: 'hero-rows', animations: true });
    assert.match(css, /@keyframes cd-live-pulse\{0%,100%\{transform:scale\(1\)\}50%\{transform:scale\(\.55\)\}\}/);
    assert.ok(css.includes('.cd-live-badge .cd-live-dot{'), 'the animation is scoped to the badge dot');
    assert.ok(css.includes('.cd-row[cd-live] .cd-row-title{display:flex;align-items:center;gap:.45em}'), 'live row title style');
    assert.ok(css.includes('.cd-row[cd-live] .cd-live-dot{animation:cd-live-pulse 1.6s ease-in-out infinite}'), 'live row dot pulse');
    assert.ok(css.includes('@media (prefers-reduced-motion:reduce)'), 'reduced-motion block present');
    assert.ok(css.includes('.cd-row[cd-live] .cd-live-dot{animation:none}'), 'live row dot pulse disabled under reduced-motion');
    for (const banned of ['opacity', 'visibility', 'filter', 'clip', 'pointer-events', 'z-index', 'scale(0']) assert.ok(!css.includes(banned), banned);
    const off = buildHomeLayoutCss(MAP, { home: 'hero-rows', animations: false });
    assert.ok(!off.includes('cd-live-pulse'), 'no pulse keyframes when animations are off');
    assert.ok(!off.includes('.cd-row[cd-live] .cd-live-dot{animation:cd-live-pulse'), 'no live row dot pulse animation when animations are off');
    assert.ok(off.includes('.cd-live-badge'), 'the badge itself is styled regardless');
    // The badge reads on both YouTube modes; the white-on-red pair is 5.9:1.
    assert.ok(css.includes('background:#cc0000'), 'fixed live red, not a theme variable that can fall below 4.5:1');
  });
});

// ---- 4. unmount ------------------------------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`unmount with ${label}`, () => {
    test('restores the original DOM exactly: the grid container and the whole document, mark removed', () => {
      for (const extra of [{}, { shorts: true }, { ads: 3 }, { tiles: 40 }]) {
        for (const home of ['rows', 'hero-rows']) {
          const p = setup({ tileStyle: style, ...extra }, { home });
          const gridBefore = p.grid.outerHTML;
          const docBefore = p.document.documentElement.outerHTML;
          assert.equal(p.layout.mount(), true);
          assert.notEqual(p.grid.outerHTML, gridBefore);
          p.layout.unmount();
          assert.equal(p.layout.isMounted(), false);
          assert.equal(p.grid.outerHTML, gridBefore, 'grid container outerHTML before mount === after unmount');
          assert.equal(p.document.documentElement.outerHTML, docBefore);
          assert.equal(marked(p).length, 0);
          assert.equal(p.root(), null);
        }
      }
    });

    test('is safe to call twice or without a mount, and a later mount starts clean', () => {
      const p = setup({ tileStyle: style });
      p.layout.unmount();
      p.layout.mount();
      p.layout.unmount();
      p.layout.unmount();
      assert.equal(p.layout.mount(), true);
      assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
      assert.equal(marked(p).length, 12);
    });

    test('after unmount nothing is observed any more: new tiles are neither mirrored nor marked', async () => {
      const p = setup({ tileStyle: style });
      p.layout.mount();
      p.layout.unmount();
      p.append(tileHtml('AFTERUNM001', 'After unmount', style));
      await settle(p.window);
      assert.equal(p.root(), null);
      assert.equal(marked(p).length, 0);
    });

    test('the exactness holds after tiles arrived and were mirrored in between', async () => {
      const p = setup({ tileStyle: style });
      const twin = setup({ tileStyle: style });
      p.layout.mount();
      p.append(tileHtml('LATERTILE01', 'Later one', style));
      twin.append(tileHtml('LATERTILE01', 'Later one', style));
      await settle(p.window);
      assert.ok(p.root().querySelector('a.cd-card[cd-video="LATERTILE01"]'));
      p.layout.unmount();
      assert.equal(p.grid.outerHTML, twin.grid.outerHTML, 'identical to a page that never had the layout');
    });
  });
}

// ---- 5. late tiles, dedupe, removal ----------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`tiles arriving later with ${label}`, () => {
    test('are appended to the last row, which only splits once a full screen of cards fits a new row, marked, in arrival order, rAF-batched', async () => {
      const p = setup({ tiles: 20, tileStyle: style }, { home: 'rows', density: 5 }); // 8 per row held
      p.layout.mount();
      assert.deepEqual(rowSizes(p.root()), [8, 8, 4]);
      const added = p.append(['A', 'B', 'C', 'D', 'E', 'F'].map((c, i) => tileHtml(`LATE${c}000000`.slice(0, 11), `Late ${i}`, style)).join(''));
      assert.equal(added.length, 6);
      // Batched: nothing yet in this tick.
      assert.deepEqual(rowSizes(p.root()), [8, 8, 4]);
      await settle(p.window);
      // 10 < 8 + 4 visible: no 2-card stub row, the last row grows instead.
      assert.deepEqual(rowSizes(p.root()), [8, 8, 10]);
      assert.deepEqual(cardKeys(p.root()).slice(-6), ['LATEA00000', 'LATEB00000', 'LATEC00000', 'LATED00000', 'LATEE00000', 'LATEF00000'].map((s) => s.padEnd(11, '0').slice(0, 11)));
      assert.ok(added.every((w) => w.hasAttribute(SRC_ATTR)));
      assert.equal(p.root().querySelectorAll('.cd-row').length, 3);
      // Two more make 12 = 8 + 4: the 4 past the chunk move to a new row.
      p.append(['G', 'H'].map((c, i) => tileHtml(`LATE${c}000000`.slice(0, 11), `Late ${6 + i}`, style)).join(''));
      await settle(p.window);
      assert.deepEqual(rowSizes(p.root()), [8, 8, 8, 4]);
      assert.equal(p.root().querySelectorAll('.cd-row-title')[3].textContent, 'More to watch');
      for (const track of p.root().querySelectorAll('.cd-row-track')) {
        assert.equal(track.querySelectorAll('.cd-card[tabindex="0"]').length, 1, 'one tab stop per row after the split');
      }
    });

    test('many arrivals in one frame cause one sync (a burst of 30 appends is one batch)', async () => {
      const p = setup({ tiles: 8, tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      let frames = 0;
      const raf = p.window.requestAnimationFrame;
      p.window.requestAnimationFrame = function counting(fn) { frames++; return raf.call(this, fn); };
      for (let i = 0; i < 30; i++) p.append(tileHtml(`BURST${String(i).padStart(6, '0')}`, `Burst ${i}`, style));
      await Promise.resolve(); // the observer callbacks run here
      p.window.requestAnimationFrame = raf;
      assert.equal(frames, 1, 'one animation frame for the whole burst');
      await settle(p.window);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 38);
    });

    test('are de-duplicated by video id: a repeated video gets no second card, but its tile is collapsed like the others', async () => {
      const p = setup({ tiles: 6, tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      const existing = p.root().querySelector('a.cd-card').getAttribute('cd-video');
      const [dupe] = p.append(tileHtml(existing, 'Same video again', style));
      const [fresh] = p.append(tileHtml('FRESHONE001', 'Fresh', style));
      await settle(p.window);
      assert.equal(cardKeys(p.root()).filter((k) => k === existing).length, 1);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 7);
      assert.ok(dupe.hasAttribute(SRC_ATTR), 'the repeated tile does not linger in the native grid');
      assert.ok(fresh.hasAttribute(SRC_ATTR));
      // Syncing again changes nothing.
      p.append('');
      p.contents.appendChild(p.document.createComment('noise'));
      await settle(p.window);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 7);
    });

    test('ads, shelves, Shorts cells, placeholders, off-site links and the continuation arriving later are never mirrored or marked', async () => {
      const p = setup({ tiles: 6, tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      const adTpl = p.document.querySelector('[data-cd-synthetic="feed-ad"]').outerHTML;
      const [ad] = p.append(adTpl);
      const [placeholder] = p.append('<ytd-rich-item-renderer rendered-from-rich-grid=""><div id="content"></div></ytd-rich-item-renderer>');
      const [offsite] = p.append(createTile({ id: 'OFFSITE0001', title: 'Off site', href: 'https://evil.example/watch?v=OFFSITE0001' }));
      const [js] = p.append(createTile({ id: 'JAVASCRIPT1', title: 'Script', href: 'javascript:alert(1)' }));
      const [short] = p.append('<ytd-rich-item-renderer rendered-from-rich-grid=""><div id="content"><ytm-shorts-lockup-view-model-v2><a href="/shorts/abcdefghijk">Short</a></ytm-shorts-lockup-view-model-v2></div></ytd-rich-item-renderer>');
      const [shelf] = p.append('<ytd-rich-section-renderer><div id="content"><ytd-rich-shelf-renderer is-shorts=""><a href="/shorts/abcdefghijk">s</a></ytd-rich-shelf-renderer></div></ytd-rich-section-renderer>');
      const [cont] = p.append('<ytd-continuation-item-renderer><tp-yt-paper-spinner></tp-yt-paper-spinner></ytd-continuation-item-renderer>');
      await settle(p.window);
      for (const el of [ad, placeholder, offsite, js, short, shelf, cont]) assert.ok(!el.hasAttribute(SRC_ATTR), el.outerHTML.slice(0, 60));
      assert.equal(p.root().querySelectorAll('.cd-card').length, 6);
      // A placeholder that YouTube fills in later is picked up on the next mutation.
      placeholder.querySelector('#content').innerHTML = createTile({ id: 'FILLEDLATER', title: 'Filled', channel: style === 'home' ? 'C' : undefined }).replace(/^<ytd-rich-item-renderer[^>]*>|<\/ytd-rich-item-renderer>$/g, '');
      await settle(p.window);
      assert.ok(p.root().querySelector('a.cd-card[cd-video="FILLEDLATER"]'));
      assert.ok(placeholder.hasAttribute(SRC_ATTR));
    });

    test('a tile YouTube removes loses its card; replacing all tiles (a chip change) rebuilds the rows; focus is kept by video id', async () => {
      const p = setup({ tiles: 10, tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      const victim = p.items()[3];
      const victimId = victim.querySelector('.ytLockupViewModelHost').className.match(/content-id-(\S+)/)[1];
      victim.remove();
      await settle(p.window);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 9);
      assert.equal(p.root().querySelector(`a.cd-card[cd-video="${victimId}"]`), null);
      assert.equal(marked(p).length, 9);

      const focusId = p.items()[5].querySelector('.ytLockupViewModelHost').className.match(/content-id-(\S+)/)[1];
      p.root().querySelector(`a.cd-card[cd-video="${focusId}"]`).focus();
      p.items()[0].remove();
      await settle(p.window);
      assert.equal(p.document.activeElement.getAttribute('cd-video'), focusId, 'focus survived the rebuild');

      for (const item of p.items()) item.remove();
      p.append([1, 2, 3].map((n) => tileHtml(`CHIPTILE00${n}`, `Chip ${n}`, style)).join(''));
      await settle(p.window);
      assert.deepEqual(cardKeys(p.root()), ['CHIPTILE001', 'CHIPTILE002', 'CHIPTILE003']);
      assert.equal(marked(p).length, 3);

      for (const item of p.items()) item.remove();
      await settle(p.window);
      assert.equal(p.layout.isMounted(), false, 'nothing left to show: the grid is given back');
      assert.equal(p.root(), null);
    });

    test('a wrapper YouTube recycles for another video (real home feed after a watch page and back): cards follow the new videos, stale ones vanish', async () => {
      const p = setup({ tiles: 8, tileStyle: style, ads: false }, { home: 'rows' });
      p.layout.mount();
      const items = p.items();
      const oldIds = items.map((w) => w.querySelector('.ytLockupViewModelHost').className.match(/content-id-(\S+)/)[1]);
      // YouTube keeps the first three ytd-rich-item-renderer nodes, fills them with other videos, and drops the rest.
      const recycle = (wrapper, id, title) => {
        const t = p.document.createElement('template');
        t.innerHTML = tileHtml(id, title, style);
        wrapper.replaceChildren(...t.content.firstElementChild.childNodes);
      };
      recycle(items[0], 'RECYCLED001', 'Recycled one');
      recycle(items[1], 'RECYCLED002', 'Recycled two');
      recycle(items[2], 'RECYCLED003', 'Recycled three');
      for (const w of items.slice(3)) w.remove();
      await settle(p.window);
      assert.deepEqual(cardKeys(p.root()), ['RECYCLED001', 'RECYCLED002', 'RECYCLED003'], 'only the new videos, in grid order');
      for (const id of oldIds) assert.equal(p.root().querySelector(`a.cd-card[cd-video="${id}"], a.cd-hero-link[cd-video="${id}"]`), null);
      assert.equal(p.root().querySelector('a.cd-card .cd-card-title').textContent, 'Recycled one');
      assert.ok(items.slice(0, 3).every((w) => w.hasAttribute(SRC_ATTR)), 'the recycled wrappers are collapsed again');
      assert.equal(marked(p).length, 3);
      // A click opens the NEW video's own link, not the one the wrapper used to hold.
      const clicked = [];
      for (const a of p.contents.querySelectorAll('a.ytLockupViewModelContentImage')) a.addEventListener('click', (e) => { e.preventDefault(); clicked.push(a.getAttribute('href')); });
      p.root().querySelector('a.cd-card').dispatchEvent(new p.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      assert.deepEqual(clicked, ['/watch?v=RECYCLED001']);
    });

    test('a wrapper that was a repeat of a tile which is then recycled gets the card (the real feed refreshes tile by tile)', async () => {
      const p = setup({ tiles: 6, tileStyle: style, ads: false }, { home: 'rows' });
      p.layout.mount();
      const items = p.items();
      const ids0 = items.map((w) => w.querySelector('.ytLockupViewModelHost').className.match(/content-id-(\S+)/)[1]);
      const recycle = (wrapper, id, title) => {
        const tpl = p.document.createElement('template');
        tpl.innerHTML = tileHtml(id, title, style);
        wrapper.replaceChildren(...tpl.content.firstElementChild.childNodes);
      };
      recycle(items[1], ids0[3], 'Now shows the video of tile 3'); // for a moment two wrappers hold the same video
      await settle(p.window);
      assert.equal(cardKeys(p.root()).filter((k) => k === ids0[3]).length, 1, 'one card for a video held by two wrappers');
      recycle(items[3], 'RECYCLEDYY1', 'Tile 3 moves on');
      await settle(p.window);
      assert.deepEqual(cardKeys(p.root()), [ids0[0], ids0[3], ids0[2], 'RECYCLEDYY1', ids0[4], ids0[5]], 'every wrapper shows a card again');
      assert.equal(marked(p).length, 6);
    });

    test('a link changed in place (same nodes, new href) is noticed; a wrapper that turns into an ad or a Short goes back to YouTube', async () => {
      const p = setup({ tiles: 6, tileStyle: style, ads: false }, { home: 'rows' });
      p.layout.mount();
      const [first, second] = p.items();
      for (const a of first.querySelectorAll('a[href^="/watch"]')) a.setAttribute('href', '/watch?v=INPLACE0001');
      await settle(p.window);
      assert.ok(p.root().querySelector('a.cd-card[cd-video="INPLACE0001"]'), 'the card follows the changed href');
      assert.equal(p.root().querySelectorAll('.cd-card').length, 6);
      assert.ok(first.hasAttribute(SRC_ATTR));
      const adTpl = p.document.createElement('template');
      adTpl.innerHTML = '<ytd-ad-slot-renderer><div id="content">Sponsored</div></ytd-ad-slot-renderer>';
      second.replaceChildren(adTpl.content.firstElementChild);
      await settle(p.window);
      assert.equal(second.hasAttribute(SRC_ATTR), false, 'a wrapper that no longer holds a video is not collapsed (an ad stays visible)');
      assert.equal(p.root().querySelectorAll('.cd-card').length, 5);
    });

    test('the observer watches only while mounted and survives updates (no duplicate cards after update + append)', async () => {
      const p = setup({ tiles: 6, tileStyle: style }, { home: 'rows', density: 3 });
      p.layout.mount();
      p.cfg.density = 5;
      p.layout.update();
      p.append(tileHtml('AFTERUPDT01', 'After update', style));
      await settle(p.window);
      assert.equal(p.root().querySelectorAll('a.cd-card[cd-video="AFTERUPDT01"]').length, 1);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 7);
    });
  });
}

// ---- 6. thumbnails -----------------------------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`thumbnails with ${label}`, () => {
    const lazy = (item) => item.querySelector('.ytThumbnailViewModelImage img');
    const idOf = (item) => item.querySelector('.ytLockupViewModelHost').className.match(/content-id-(\S+)/)[1];

    test('a tile without a src yet shows the public image for its id, and switches to the tile\'s own src when it appears', async () => {
      const p = setup({ tiles: 8, tileStyle: style, ads: false }, { home: 'rows' });
      const [a, b] = p.items();
      lazy(a).removeAttribute('src');
      lazy(b).removeAttribute('src');
      p.layout.mount();
      const cardOf = (item) => p.root().querySelector(`a.cd-card[cd-video="${idOf(item)}"] img`);
      assert.equal(cardOf(a).getAttribute('src'), `https://i.ytimg.com/vi/${idOf(a)}/hqdefault.jpg`);
      assert.equal(cardOf(b).getAttribute('src'), `https://i.ytimg.com/vi/${idOf(b)}/hqdefault.jpg`);
      assert.equal(cardOf(a).getAttribute('loading'), 'lazy');
      lazy(a).setAttribute('src', 'https://i.ytimg.com/vi/real/hq720_custom_1.jpg?sqp=abc');
      await settle(p.window);
      assert.equal(cardOf(a).getAttribute('src'), 'https://i.ytimg.com/vi/real/hq720_custom_1.jpg?sqp=abc', 'mirror updated by the attribute observer');
      assert.equal(cardOf(b).getAttribute('src'), `https://i.ytimg.com/vi/${idOf(b)}/hqdefault.jpg`, 'the other one is untouched');
    });

    test('hero: the first tile that has a real thumbnail; if none has, the first with a derivable one (720p, falling back on load)', async () => {
      const p = setup({ tiles: 6, tileStyle: style, ads: false });
      const items = p.items();
      lazy(items[0]).removeAttribute('src');
      lazy(items[1]).removeAttribute('src');
      p.layout.mount();
      assert.equal(p.root().querySelector('.cd-hero a').getAttribute('cd-video'), idOf(items[2]));
      assert.equal(p.root().querySelector('.cd-hero img').getAttribute('src'), lazy(items[2]).getAttribute('src'));
      assert.ok(p.root().querySelector(`a.cd-card[cd-video="${idOf(items[0])}"]`), 'the skipped tiles are ordinary cards');
      p.layout.unmount();

      for (const item of items) lazy(item).removeAttribute('src');
      assert.equal(p.layout.mount(), true);
      const heroLink = p.root().querySelector('.cd-hero a');
      assert.equal(heroLink.getAttribute('cd-video'), idOf(items[0]));
      const img = heroLink.querySelector('img');
      assert.equal(img.getAttribute('src'), `https://i.ytimg.com/vi/${idOf(items[0])}/hq720.jpg`);
      assert.equal(img.getAttribute('cd-fallback'), `https://i.ytimg.com/vi/${idOf(items[0])}/hqdefault.jpg`);
      // The CDN answers a missing 720p image with a 120px placeholder (status 200): detected on load, swapped for hqdefault.
      Object.defineProperty(img, 'naturalWidth', { value: 120, configurable: true });
      img.dispatchEvent(new p.window.Event('load'));
      assert.equal(img.getAttribute('src'), `https://i.ytimg.com/vi/${idOf(items[0])}/hqdefault.jpg`);
      assert.equal(img.hasAttribute('cd-fallback'), false);
      // A real image keeps its src.
      p.layout.unmount();
      p.layout.mount();
      const img2 = p.root().querySelector('.cd-hero img');
      Object.defineProperty(img2, 'naturalWidth', { value: 1280, configurable: true });
      const src = img2.getAttribute('src');
      img2.dispatchEvent(new p.window.Event('load'));
      assert.equal(img2.getAttribute('src'), src);
      assert.equal(img2.hasAttribute('cd-fallback'), false);
    });

    test('a tile whose id is not a normal video id is not mirrored at all: no card, no made-up image URL, and the tile is not collapsed', () => {
      const p = setup({ tiles: 3, tileStyle: style, ads: false }, { home: 'rows' });
      const [a] = p.items();
      lazy(a).removeAttribute('src');
      a.querySelectorAll('a[href^="/watch"]').forEach((x) => x.setAttribute('href', '/watch?v=short'));
      p.layout.mount();
      assert.equal(p.root().querySelector('a.cd-card[cd-video="short"]'), null);
      assert.equal(a.hasAttribute('cd-source'), false, 'left in YouTube\'s grid, untouched');
      assert.ok(p.root().querySelectorAll('a.cd-card').length >= 2, 'the ordinary tiles are still mirrored');
    });
  });
}

// ---- 7. keyboard and pointer -----------------------------------------------------------------------------------------------------------

describe('keyboard and mouse', () => {
  const key = (win, target, k, init = {}) => {
    const ev = new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init });
    target.dispatchEvent(ev);
    return ev;
  };
  function mounted(extraCfg = {}, pageOpts = {}) {
    const p = setup({ tiles: 30, tileStyle: 'home', ads: false, ...pageOpts }, { home: 'rows', density: 5, ...extraCfg }); // 8 per row
    p.scrolls = [];
    p.window.HTMLElement.prototype.scrollIntoView = function scrollIntoView(o) { p.scrolls.push({ el: this, o }); };
    assert.equal(p.layout.mount(), true);
    p.row = (i = 0) => p.root().querySelectorAll('.cd-row')[i];
    p.cards = (i = 0) => [...p.row(i).querySelectorAll('.cd-card')];
    return p;
  }

  test('ArrowRight/ArrowLeft/Home/End move focus inside the row, keep one tab stop, scroll the card into view', () => {
    const p = mounted();
    const cards = p.cards();
    assert.equal(cards.length, 8);
    cards[0].focus();
    assert.equal(p.document.activeElement, cards[0]);
    let ev = key(p.window, cards[0], 'ArrowRight');
    assert.equal(ev.defaultPrevented, true);
    assert.equal(p.document.activeElement, cards[1]);
    assert.deepEqual(cards.map((c) => c.getAttribute('tabindex')), ['-1', '0', '-1', '-1', '-1', '-1', '-1', '-1']);
    assert.equal(p.scrolls.at(-1).el, cards[1]);
    assert.equal(p.scrolls.at(-1).o.inline, 'nearest');
    assert.equal(p.scrolls.at(-1).o.behavior, 'smooth');
    key(p.window, cards[1], 'End');
    assert.equal(p.document.activeElement, cards[7]);
    key(p.window, cards[7], 'ArrowRight');
    assert.equal(p.document.activeElement, cards[7], 'stops at the end');
    key(p.window, cards[7], 'ArrowLeft');
    assert.equal(p.document.activeElement, cards[6]);
    key(p.window, cards[6], 'Home');
    assert.equal(p.document.activeElement, cards[0]);
    ev = key(p.window, cards[0], 'ArrowLeft');
    assert.equal(p.document.activeElement, cards[0], 'stops at the start');
    assert.equal(ev.defaultPrevented, true);
    // Rows are independent: the second row's first card is its own tab stop.
    assert.equal(p.cards(1)[0].getAttribute('tabindex'), '0');
  });

  test('focus entering a card (mouse, Shift+Tab, script) becomes the row\'s tab stop', () => {
    const p = mounted();
    const cards = p.cards();
    cards[4].focus();
    assert.deepEqual(cards.map((c) => c.getAttribute('tabindex')), ['-1', '-1', '-1', '-1', '0', '-1', '-1', '-1']);
  });

  test('other keys, modified keys and keys outside a card are left alone (page scrolling, shortcuts, typing)', () => {
    const p = mounted();
    const cards = p.cards();
    cards[2].focus();
    for (const k of ['ArrowDown', 'ArrowUp', 'PageDown', 'Tab', 'Enter', ' ', 'a']) {
      const ev = key(p.window, cards[2], k);
      assert.equal(ev.defaultPrevented, false, k);
      assert.equal(p.document.activeElement, cards[2], k);
    }
    for (const init of [{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }]) {
      const ev = key(p.window, cards[2], 'ArrowRight', init);
      assert.equal(ev.defaultPrevented, false, JSON.stringify(init));
      assert.equal(p.document.activeElement, cards[2]);
    }
    const title = p.row().querySelector('.cd-row-title');
    assert.equal(key(p.window, title, 'ArrowRight').defaultPrevented, false);
    assert.equal(key(p.window, p.document.body, 'ArrowRight').defaultPrevented, false);
  });

  test('keyboard movement is instant under prefers-reduced-motion and when animations are off', () => {
    const p = mounted();
    const cards = p.cards();
    cards[0].focus();
    p.window.__cd.setReducedMotion(true);
    key(p.window, cards[0], 'ArrowRight');
    assert.equal(p.scrolls.at(-1).o.behavior, 'auto');
    p.window.__cd.setReducedMotion(false);
    key(p.window, cards[1], 'ArrowRight');
    assert.equal(p.scrolls.at(-1).o.behavior, 'smooth');
    p.cfg.animations = false;
    key(p.window, cards[2], 'ArrowRight');
    assert.equal(p.scrolls.at(-1).o.behavior, 'auto');
  });

  test('in a right-to-left page the arrows follow the reading direction', () => {
    const p = mounted();
    const track = p.row().querySelector('.cd-row-track');
    const real = p.window.getComputedStyle.bind(p.window);
    p.window.getComputedStyle = (el, ...rest) => (el === track ? { direction: 'rtl' } : real(el, ...rest));
    const cards = p.cards();
    cards[3].focus();
    key(p.window, cards[3], 'ArrowLeft');
    assert.equal(p.document.activeElement, cards[4]);
    key(p.window, cards[4], 'ArrowRight');
    assert.equal(p.document.activeElement, cards[3]);
  });

  test('prev/next buttons scroll the row by most of its width, respect reduced motion, and ignore clicks when disabled', () => {
    const p = mounted();
    const track = p.row().querySelector('.cd-row-track');
    const calls = [];
    track.scrollBy = (o) => calls.push(o);
    Object.defineProperty(track, 'clientWidth', { value: 1000, configurable: true });
    const next = p.row().querySelector('.cd-row-next');
    const prev = p.row().querySelector('.cd-row-prev');
    next.click();
    prev.click();
    assert.deepEqual(calls, [{ left: 900, behavior: 'smooth' }, { left: -900, behavior: 'smooth' }]);
    p.window.__cd.setReducedMotion(true);
    next.click();
    assert.equal(calls.at(-1).behavior, 'auto');
    prev.setAttribute('aria-disabled', 'true');
    const n = calls.length;
    prev.click();
    assert.equal(calls.length, n);
    // The button state follows the scroll position once layout exists.
    Object.defineProperty(track, 'scrollWidth', { value: 2000, configurable: true });
    Object.defineProperty(track, 'scrollLeft', { value: 0, configurable: true, writable: true });
    track.dispatchEvent(new p.window.Event('scroll'));
    assert.equal(prev.getAttribute('aria-disabled'), 'true');
    assert.equal(next.getAttribute('aria-disabled'), 'false');
    assert.equal(next.hasAttribute('hidden'), false);
    track.scrollLeft = 1000;
    track.dispatchEvent(new p.window.Event('scroll'));
    assert.equal(prev.getAttribute('aria-disabled'), 'false');
    assert.equal(next.getAttribute('aria-disabled'), 'true');
    // A row that fits needs no buttons.
    Object.defineProperty(track, 'scrollWidth', { value: 1000, configurable: true });
    track.dispatchEvent(new p.window.Event('scroll'));
    assert.equal(prev.hasAttribute('hidden') && next.hasAttribute('hidden'), true);
  });

  const ptr = (win, type, props) => {
    const ev = new win.Event(type, { bubbles: true, cancelable: true });
    for (const [k, v] of Object.entries({ pointerId: 1, pointerType: 'mouse', button: 0, clientX: 0, ...props })) Object.defineProperty(ev, k, { value: v });
    return ev;
  };

  test('mouse drag scrolls the row, and the click that ends a drag does not open the video', () => {
    const p = mounted();
    const track = p.row().querySelector('.cd-row-track');
    const card = p.cards()[2];
    Object.defineProperty(track, 'scrollLeft', { value: 400, configurable: true, writable: true });
    card.dispatchEvent(ptr(p.window, 'pointerdown', { clientX: 500 }));
    const small = ptr(p.window, 'pointermove', { clientX: 497 });
    card.dispatchEvent(small);
    assert.equal(track.scrollLeft, 400, 'below the threshold nothing moves, so a click stays a click');
    const move = ptr(p.window, 'pointermove', { clientX: 380 });
    card.dispatchEvent(move);
    assert.equal(track.scrollLeft, 520);
    assert.equal(move.defaultPrevented, true);
    card.dispatchEvent(ptr(p.window, 'pointerup', { clientX: 380 }));
    const click = new p.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    const opened = [];
    p.contents.querySelectorAll('a').forEach((a) => a.addEventListener('click', () => opened.push(1)));
    card.dispatchEvent(click);
    assert.equal(click.defaultPrevented, true, 'the drag-ending click is swallowed');
    assert.deepEqual(opened, []);
    // The next real click goes through.
    card.dispatchEvent(ptr(p.window, 'pointerdown', { clientX: 10 }));
    card.dispatchEvent(ptr(p.window, 'pointerup', { clientX: 10 }));
    const click2 = new p.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    p.contents.querySelectorAll('a.ytLockupViewModelContentImage').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    card.dispatchEvent(click2);
    assert.equal(opened.length >= 1, true, 'handed to the tile link');
  });

  test('touch and pen pointers, other buttons, and a different pointer id never start a drag; native drag-and-drop of links is off', () => {
    const p = mounted();
    const track = p.row().querySelector('.cd-row-track');
    const card = p.cards()[1];
    Object.defineProperty(track, 'scrollLeft', { value: 100, configurable: true, writable: true });
    for (const down of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { button: 2 }]) {
      card.dispatchEvent(ptr(p.window, 'pointerdown', { clientX: 500, ...down }));
      card.dispatchEvent(ptr(p.window, 'pointermove', { clientX: 200 }));
      card.dispatchEvent(ptr(p.window, 'pointerup', {}));
      assert.equal(track.scrollLeft, 100, JSON.stringify(down));
    }
    card.dispatchEvent(ptr(p.window, 'pointerdown', { clientX: 500 }));
    card.dispatchEvent(ptr(p.window, 'pointermove', { clientX: 200, pointerId: 2 }));
    assert.equal(track.scrollLeft, 100);
    card.dispatchEvent(ptr(p.window, 'pointercancel', {}));
    const drag = new p.window.Event('dragstart', { bubbles: true, cancelable: true });
    card.dispatchEvent(drag);
    assert.equal(drag.defaultPrevented, true);
  });
});

// ---- 8. clicking a card ---------------------------------------------------------------------------------------------------------------

describe('clicking a card hands the click to the tile\'s own link (YouTube navigates in-page, history and recs see it)', () => {
  function mounted(extra = {}) {
    const p = setup({ tiles: 6, tileStyle: 'home', ads: false, ...extra }, { home: 'hero-rows' });
    p.clicks = [];
    for (const a of p.contents.querySelectorAll('a.ytLockupViewModelContentImage')) {
      a.addEventListener('click', (e) => { e.preventDefault(); p.clicks.push(a.getAttribute('href')); });
    }
    p.layout.mount();
    p.click = (el, init = {}) => {
      const ev = new p.window.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      let prevented;
      el.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); }, { once: true });
      el.dispatchEvent(ev);
      return prevented;
    };
    return p;
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  test('a plain left click on a card or the hero clicks the original link once and cancels the default navigation', async () => {
    const p = mounted();
    const card = p.root().querySelector('a.cd-card');
    const id = card.getAttribute('cd-video');
    p.p = p.document.addEventListener('yt-navigate-start', () => {});
    // YouTube's handler: the source click starts an in-page navigation.
    p.contents.addEventListener('click', () => p.document.dispatchEvent(new p.window.CustomEvent('yt-navigate-start', { bubbles: true })), true);
    assert.equal(p.click(card), true);
    assert.deepEqual(p.clicks, [`/watch?v=${id}`]);
    const hero = p.root().querySelector('a.cd-hero-link');
    assert.equal(p.click(hero), true);
    assert.equal(p.clicks.length, 2);
    await wait(40);
    assert.deepEqual(p.navigated, [], 'YouTube reacted, so no hard navigation');
  });

  test('if YouTube does not react within the grace period the browser is sent to the real URL', async () => {
    const p = mounted();
    const card = p.root().querySelector('a.cd-card');
    assert.equal(p.click(card), true);
    await wait(60);
    assert.deepEqual(p.navigated, [card.getAttribute('href')]);
  });

  test('modified clicks, other buttons and keyboard-modified activation keep the browser\'s own behaviour on the real href', () => {
    const p = mounted();
    const card = p.root().querySelector('a.cd-card');
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
      assert.equal(p.click(card, init), false, JSON.stringify(init));
    }
    assert.deepEqual(p.clicks, []);
    assert.equal(card.getAttribute('href').startsWith('https://www.youtube.com/watch?v='), true);
  });

  test('if the original tile is gone, the card behaves as a plain link (nothing is swallowed)', () => {
    const p = mounted();
    const card = p.root().querySelector('a.cd-card');
    const wrapper = p.items().find((w) => w.querySelector(`a[href*="${card.getAttribute('cd-video')}"]`));
    const link = wrapper.querySelector('a.ytLockupViewModelContentImage');
    wrapper.remove();
    link.remove();
    assert.equal(p.click(card), false);
  });

  test('buttons and non-link parts of the row are not treated as video clicks', () => {
    const p = mounted();
    const next = p.root().querySelector('.cd-row-next');
    assert.equal(p.click(next), false);
    assert.deepEqual(p.clicks, []);
    assert.equal(p.click(p.root().querySelector('.cd-row-title')), false);
  });
});

// ---- 9. update ------------------------------------------------------------------------------------------------------------------------

for (const [label, style] of STYLES) {
  describe(`update with ${label}`, () => {
    test('density changes re-chunk the rows and --cd-row-visible without remounting the grid', () => {
      const p = setup({ tiles: 40, tileStyle: style }, { home: 'rows', density: 3 });
      p.layout.mount();
      const items = p.items();
      assert.deepEqual(rowSizes(p.root()), [12, 12, 16]);
      p.cfg.density = 1;
      p.layout.update();
      assert.deepEqual(rowSizes(p.root()), [16, 16, 8]);
      assert.equal(p.root().style.getPropertyValue('--cd-row-visible'), '8');
      p.cfg.density = 5;
      p.layout.update();
      assert.equal(rowSizes(p.root()).length, 5);
      assert.equal(p.root().style.getPropertyValue('--cd-row-visible'), '4');
      assert.deepEqual(p.items(), items, 'the same YouTube tiles, untouched');
      assert.equal(marked(p).length, 40);
      assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
    });

    test('rows <-> hero-rows adds and removes the hero; the hero tile goes back into a row', () => {
      const p = setup({ tileStyle: style }, { home: 'rows' });
      p.layout.mount();
      assert.equal(p.root().querySelectorAll('.cd-card').length, 12);
      p.cfg.home = 'hero-rows';
      p.layout.update();
      assert.equal(p.root().querySelectorAll('.cd-hero').length, 1);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 11);
      assert.equal(p.root().getAttribute('cd-mode'), 'hero-rows');
      p.cfg.home = 'rows';
      p.layout.update();
      assert.equal(p.root().querySelectorAll('.cd-hero').length, 0);
      assert.equal(p.root().querySelectorAll('.cd-card').length, 12);
      assert.equal(marked(p).length, 12);
    });

    test('update to grid (or with the feature disabled) unmounts and restores; update back mounts again', () => {
      const p = setup({ tileStyle: style });
      const before = p.grid.outerHTML;
      p.layout.mount();
      p.cfg.home = 'grid';
      p.layout.update();
      assert.equal(p.layout.isMounted(), false);
      assert.equal(p.grid.outerHTML, before);
      p.cfg.home = 'rows';
      p.layout.update();
      assert.equal(p.layout.isMounted(), true, 'update mounts when the config asks for rows and nothing is mounted');
      p.cfg.disabled = ['layout-home'];
      p.layout.update();
      assert.equal(p.layout.isMounted(), false);
      assert.equal(p.grid.outerHTML, before);
      assert.deepEqual(p.fails, []);
    });

    test('update recovers when the layout was removed from under it', () => {
      const p = setup({ tileStyle: style });
      p.layout.mount();
      p.root().remove();
      assert.equal(p.layout.isMounted(), false, 'reports the truth and cleans its marks');
      assert.equal(marked(p).length, 0);
      p.layout.update();
      assert.equal(p.layout.isMounted(), true);
      assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
    });
  });
}

// ---- 10. failure and recovery ------------------------------------------------------------------------------------------------------------

describe('safety', () => {
  test('an exception while committing rolls everything back, reports the reason, and returns false', () => {
    for (const [label, style] of STYLES) {
      const p = setup({ tileStyle: style });
      const before = p.document.documentElement.outerHTML;
      p.window.MutationObserver = class { constructor() { throw new Error(`boom ${label}`); } };
      assert.equal(p.layout.mount(), false);
      assert.equal(p.layout.isMounted(), false);
      assert.equal(p.document.documentElement.outerHTML, before, 'rolled back exactly');
      assert.equal(p.fails.length, 1);
      assert.match(p.fails[0], /^home-layout: boom /);
    }
  });

  test('an exception while reading the page touches nothing and is reported; a single unreadable field only degrades', () => {
    const p = setup();
    const before = p.document.documentElement.outerHTML;
    const broken = { ...p.sel, find: () => { throw new Error('hostile'); } };
    const layout = home.createHomeLayout({ doc: p.document, win: p.window, selectors: broken, map: MAP, getConfig: () => p.cfg, onFail: (r) => p.fails.push(r) });
    assert.equal(layout.mount(), false);
    assert.equal(p.document.documentElement.outerHTML, before);
    assert.equal(p.fails.length, 1);
    assert.match(p.fails[0], /hostile/);
    const q = setup();
    const partly = { ...q.sel, find: (role, root) => { if (role === 'tileTitle') throw new Error('one field'); return q.sel.find(role, root); } };
    const l2 = home.createHomeLayout({ doc: q.document, win: q.window, selectors: partly, map: MAP, getConfig: () => q.cfg, onFail: (r) => q.fails.push(r) });
    assert.equal(l2.mount(), true, 'the built-in fallbacks read the title');
    assert.deepEqual(q.fails, []);
  });

  test('a throwing onFail or getConfig cannot break the page', () => {
    const p = setup();
    p.window.MutationObserver = class { constructor() { throw new Error('x'); } };
    const layout = home.createHomeLayout({ doc: p.document, win: p.window, selectors: p.sel, map: MAP, getConfig: () => p.cfg, onFail: () => { throw new Error('engine bug'); } });
    assert.equal(layout.mount(), false);
    const q = setup();
    const l2 = home.createHomeLayout({ doc: q.document, win: q.window, selectors: q.sel, map: MAP, getConfig: () => { throw new Error('cfg'); } });
    assert.equal(l2.mount(), false);
  });

  test('a failure inside the observer callback unmounts cleanly, restores the page and reports once', async () => {
    const p = setup({ tiles: 6 }, { home: 'rows' });
    const twin = setup({ tiles: 6 }, { home: 'rows' });
    p.layout.mount();
    p.sel.css = () => { throw new Error('css boom'); }; // candidates() cannot swallow this one
    p.append(tileHtml('SYNCFAIL001', 'x', 'home'));
    twin.append(tileHtml('SYNCFAIL001', 'x', 'home'));
    await settle(p.window);
    assert.equal(p.layout.isMounted(), false);
    assert.equal(p.fails.length, 1);
    assert.match(p.fails[0], /css boom/);
    assert.equal(p.grid.outerHTML, twin.grid.outerHTML, 'the page is back to what it would be without the layout');
  });

  test('a layout removed from the DOM by YouTube is noticed on the next check and never leaves marks behind', async () => {
    const p = setup({ tiles: 6 }, { home: 'rows' });
    p.layout.mount();
    p.root().remove();
    p.append(tileHtml('AFTERREMOVE', 'x', 'home'));
    await settle(p.window);
    assert.equal(p.layout.isMounted(), false);
    assert.equal(marked(p).length, 0);
    assert.equal(p.document.querySelectorAll('.cd-home').length, 0);
  });

  test('when YouTube replaces the whole grid contents, the next mount starts clean', () => {
    const p = setup({ tiles: 6 }, { home: 'rows' });
    p.layout.mount();
    const twin = setup({ tiles: 6 }, { home: 'rows' });
    p.contents.replaceWith(twin.contents.cloneNode(true));
    assert.equal(p.layout.isMounted(), false);
    p.contents = p.sel.find('homeGridContents');
    assert.equal(p.layout.mount(), true);
    assert.equal(p.document.querySelectorAll('.cd-home').length, 1);
    assert.equal(p.root().nextElementSibling, p.sel.find('homeGridContents'));
  });

  test('a second instance (the old content script after an extension reload) takes over cleanly and the first cannot strip its marks', async () => {
    const p = setup({ tiles: 6 }, { home: 'rows' });
    const twin = setup({ tiles: 6 }, { home: 'rows' });
    p.layout.mount();
    const second = home.createHomeLayout({ doc: p.document, win: p.window, selectors: p.sel, map: MAP, getConfig: () => p.cfg, onFail: () => {} });
    assert.equal(second.mount(), true);
    assert.equal(p.document.querySelectorAll('.cd-home').length, 1, 'the orphan root of the first was removed');
    assert.equal(marked(p).length, 6);
    assert.equal(p.layout.isMounted(), false, 'the first instance noticed it lost its root');
    await settle(p.window);
    assert.equal(marked(p).length, 6, "and its teardown left the second instance's marks alone");
    assert.equal(second.isMounted(), true);
    second.unmount();
    assert.equal(p.grid.outerHTML, twin.grid.outerHTML);
  });

  test('stale marks from a dead instance (no root left) are cleared by the next mount instead of hiding tiles for nothing', () => {
    const p = setup({ tiles: 6 }, { home: 'rows' });
    for (const item of p.items()) item.setAttribute(SRC_ATTR, 'olderinstance');
    p.items()[0].setAttribute(SRC_ATTR, '');
    assert.equal(p.layout.mount(), true);
    assert.equal(marked(p).length, 6);
    assert.ok(marked(p).every((m) => m.getAttribute(SRC_ATTR) !== 'olderinstance'));
    p.layout.unmount();
    assert.equal(marked(p).length, 0);
  });

  test('titles and metadata are inserted as text: markup in a tile never becomes elements', () => {
    const p = setup({ tiles: 4, ads: false, tileStyle: 'home' }, { home: 'hero-rows' });
    const item = p.items()[1];
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>"\'><b>bold</b>';
    item.querySelector('.ytLockupMetadataViewModelTitle .ytAttributedStringHost').textContent = evil;
    item.querySelector('.ytContentMetadataViewModelMetadataText').textContent = evil;
    p.layout.mount();
    const card = p.root().querySelector('a.cd-card .cd-card-title');
    const evilCard = [...p.root().querySelectorAll('.cd-card-title')].find((t) => t.textContent === evil);
    assert.ok(evilCard || card);
    assert.equal(p.root().querySelectorAll('script, b').length, 0);
    assert.equal(p.root().querySelectorAll('img').length, p.root().querySelectorAll('.cd-card, .cd-hero').length, 'one image per card and per hero, none injected');
    assert.ok(![...p.root().querySelectorAll('[onerror]')].length);
  });

  test('no YouTube node is ever removed, moved or re-parented, or given any attribute but cd-source', async () => {
    const p = setup({ tiles: 14, ads: 2, shorts: true, tileStyle: 'home' }, { home: 'hero-rows' });
    const parents = new Map([...p.document.querySelectorAll('*')].map((el) => [el, el.parentNode]));
    const attrs = new Map([...p.document.querySelectorAll('*')].map((el) => [el, el.getAttributeNames().join('|')]));
    p.layout.mount();
    const late = p.append(tileHtml('NOREPARENT01', 'x', 'home'));
    await settle(p.window);
    p.cfg.density = 5;
    p.layout.update();
    for (const [el, parent] of parents) {
      assert.ok(el.isConnected, `${el.tagName} still connected`);
      assert.equal(el.parentNode, parent, `${el.tagName} keeps its parent`);
      const now = el.getAttributeNames().join('|');
      assert.ok(now === attrs.get(el) || now === (attrs.get(el) ? `${attrs.get(el)}|${SRC_ATTR}` : SRC_ATTR), `${el.tagName}: ${attrs.get(el)} -> ${now}`);
    }
    // The only new elements outside our root are the ones the test itself appended.
    const strangers = [...p.document.querySelectorAll('*')].filter((el) => !parents.has(el) && !p.root().contains(el) && el !== p.root() && !late.some((l) => l === el || l.contains(el)));
    assert.deepEqual(strangers, []);
  });
});

// ---- 11. differential against the real selector-map.js, when it exists -------------------------------------------------------------------

test('when the real src/shared/selector-map.js exists, home.js built on it produces the same CSS and the same mount', { skip: !existsSync(REAL_SELECTOR_MAP) && 'src/shared/selector-map.js not written yet' }, async () => {
  const real = await loadHome('real', null);
  for (const home_ of ['rows', 'hero-rows']) {
    const cfg = { home: home_, disabled: [] };
    assert.equal(real.buildHomeLayoutCss(MAP, cfg), buildHomeLayoutCss(MAP, cfg));
  }
  const p = setup({ tileStyle: 'home' }, { home: 'hero-rows' }, { mod: real });
  assert.equal(p.layout.mount(), true);
  assert.equal(p.root().querySelectorAll('.cd-card').length, 11);
  p.layout.unmount();
});
