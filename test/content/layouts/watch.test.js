// Tests for src/content/layouts/watch.js (owner: layouts agent).
//
// How the tests are wired
// - src/shared/selector-map.js (safeHide) is written by another module. watch.js is loaded here with a faithful local copy of it
//   injected through a module resolve hook, and a differential block compares it with the real file when that exists.
// - Selectors from the generated CSS are RUN against real watch-page fixtures (createPage('watch', ...), with synthetic ads in
//   the player, the sponsorship overlay, #player-ads and between the related items), so "what gets hidden" is measured, not
//   guessed. jsdom resolves :is/:not/:has/:where, but no @media and no layout, so geometry (the actual grid) is e2e-only.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPage } from '../../helpers/dom.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', '..', 'src');
const WATCH_FILE = path.join(SRC, 'content', 'layouts', 'watch.js');
const REAL_SELECTOR_MAP = path.join(SRC, 'shared', 'selector-map.js');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const clone = (v) => structuredClone(v);

const LOCAL_SELECTOR_MAP = `
export function safeHide(map, selector) {
  const ads = map && map.protected && map.protected.ads;
  if (!Array.isArray(ads) || !ads.length) throw new Error('map.protected.ads missing');
  return selector + ':not(:has(' + ads.join(', ') + '))';
}
`;
const BROKEN_SELECTOR_MAP = LOCAL_SELECTOR_MAP.replace("return selector + ':not(:has(' + ads.join(', ') + '))';", 'return selector;');
assert.notEqual(BROKEN_SELECTOR_MAP, LOCAL_SELECTOR_MAP, 'test setup: the broken copy must differ');
const canHook = typeof nodeModule.registerHooks === 'function';

async function loadWatch(tag, source) {
  const parent = `${pathToFileURL(WATCH_FILE).href}?${tag}`;
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

const watch = await loadWatch('local', LOCAL_SELECTOR_MAP);
const { buildWatchLayoutCss, buildWatchLiveCss, isWatchLive, hasWatchMetadata, LIVE_WATCH_RE } = watch;

// ---- CSS reading helpers (independent of the code under test) ---------------------------------------------------------------------

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
function parseRules(css) {
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
    const close = text.indexOf('}', open);
    assert.ok(close > 0, 'unbalanced braces');
    assert.ok(!text.slice(open + 1, close).includes('{'), 'no nested rules expected in watch CSS');
    rules.push({
      selectors: splitTop(text.slice(i, open), ','),
      decls: splitTop(text.slice(open + 1, close), ';').map((d) => { const k = d.indexOf(':'); return { prop: d.slice(0, k).trim(), value: d.slice(k + 1).trim() }; }),
    });
    i = close + 1;
  }
  return rules;
}
const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw|ch)?$/;
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
/** Runs a generated selector (pseudo-elements removed) and returns the elements it matches. */
const run = (doc, selector) => [...doc.querySelectorAll(selector.replace(/::(before|after)$/, ''))];

// ---- harness -----------------------------------------------------------------------------------------------------------------------

const open = [];
after(() => { for (const p of open) p.window.close(); });

const GATE = 'html[cd-theme][cd-page="watch"]:not([cd-off-layout-watch])';
function setup(pageOpts = {}, attrs = {}) {
  const p = createPage('watch', { tiles: 8, ads: 2, ...pageOpts });
  open.push(p);
  const root = p.document.documentElement;
  root.setAttribute('cd-theme', 'cinema');
  root.setAttribute('cd-page', 'watch');
  for (const [k, v] of Object.entries(attrs)) root.setAttribute(k, v);
  p.flexy = p.document.querySelector('ytd-watch-flexy');
  p.inject = (css) => {
    const style = p.document.createElement('style');
    style.textContent = css;
    p.document.head.appendChild(style);
    return style;
  };
  p.q = (sel) => p.flexy.querySelector(sel);
  p.display = (el) => p.window.getComputedStyle(el).display;
  return p;
}
const adsCss = MAP.protected.ads.join(',');
const sponsorCss = MAP.protected.sponsor.join(',');

// ---- 1. which modes produce CSS -------------------------------------------------------------------------------------------------------

test('default, an unknown mode, a missing config and a paused feature produce no CSS; cinema and focus do', () => {
  for (const cfg of [undefined, null, {}, { watch: 'default' }, { watch: 'theatre' }, { watch: 5 }, { watch: 'cinema', disabled: ['layout-watch'] },
    { watch: 'focus', disabled: ['layout-watch', 'density'] }]) {
    assert.equal(buildWatchLayoutCss(MAP, cfg), '', JSON.stringify(cfg));
  }
  for (const watch_ of ['cinema', 'focus']) {
    const css = buildWatchLayoutCss(MAP, { watch: watch_, disabled: ['density', 'layout-home'] });
    assert.ok(css.length > 100 && css.endsWith('\n') && !css.includes('\r'), watch_);
  }
  for (const map of [undefined, null, {}, { roles: null }, { roles: {}, protected: {} }]) {
    assert.doesNotThrow(() => buildWatchLayoutCss(map, { watch: 'focus' }));
    assert.doesNotThrow(() => buildWatchLayoutCss(map, { watch: 'cinema' }));
  }
});

test('the module has no timers, network or DOM access of its own', () => {
  const src = readFileSync(WATCH_FILE, 'utf8');
  assert.ok(!/setTimeout|setInterval|fetch\(|document\.|window\.|eval\(|new Function/.test(src.replace(/\/\/.*$/gm, '')));
});

// ---- 2. cinema ----------------------------------------------------------------------------------------------------------------------------

describe('cinema', () => {
  const css = buildWatchLayoutCss(MAP, { watch: 'cinema' });
  const rules = parseRules(css);

  test('every rule is scoped: watch page, feature not paused, flexy not fullscreen; layout rules also two columns and not theatre', () => {
    assert.ok(rules.length >= 7);
    for (const r of rules) {
      for (const s of r.selectors) {
        assert.ok(s.startsWith(`${GATE} ytd-watch-flexy`), s);
        assert.ok(s.includes(':not([fullscreen])'), `fullscreen is excluded: ${s}`);
        assert.ok(s.includes('[is-two-columns_]:not([theater])'), `two-column, non-theatre only: ${s}`);
      }
    }
  });

  test('the player is never touched: no .ytp-*, #movie_player, video, ytd-player or player container selector', () => {
    for (const banned of ['.ytp-', 'movie_player', 'video', 'ytd-player', 'player-container', 'html5', 'ytd-watch-metadata', 'comments', 'related']) {
      assert.ok(!css.includes(banned) || banned === 'video' && !/(^|[^-\w])video($|[^-\w])/.test(css), banned);
    }
    for (const r of rules) for (const s of r.selectors) assert.ok(!/#player-container|#movie_player|ytd-player/.test(s));
  });

  test('nothing is hidden, faded, clipped or shrunk to zero', () => {
    for (const r of rules) for (const d of r.decls) assert.ok(!hidesDecl(d), `${r.selectors[0]} { ${d.prop}: ${d.value} }`);
    for (const banned of ['display:none', 'visibility', 'opacity', 'clip', 'filter', 'pointer-events', 'transform', 'z-index']) assert.ok(!css.includes(banned), banned);
    // a zero height/width on its own is a collapse; "min-width:0" (the grid overflow reset) is not
    assert.ok(!/(^|[^-\w])(height|width|max-height|max-width):\s*0(?![.\d])/i.test(css), 'no zero height or width');
  });

  test('re-flows the columns: #primary and #primary-inner become display:contents, #columns a two-column grid, #player spans both', () => {
    const find = (pred) => rules.filter((r) => r.selectors.some(pred));
    const contents = find((s) => /#primary$|#primary-inner$/.test(s));
    assert.equal(contents.length, 1);
    assert.deepEqual(contents[0].decls, [{ prop: 'display', value: 'contents' }]);
    const cols = find((s) => s.endsWith(' #columns'))[0];
    assert.ok(cols.decls.some((d) => d.prop === 'display' && d.value === 'grid'));
    assert.ok(cols.decls.some((d) => d.prop === 'grid-template-columns' && /minmax\(0,1fr\) auto/.test(d.value)));
    const player = find((s) => s.endsWith(' #player'))[0];
    assert.ok(player.decls.some((d) => d.prop === 'grid-column' && d.value === '1 / -1'));
    assert.ok(find((s) => s.endsWith(' #below')).length === 1 && find((s) => s.endsWith(' #secondary')).length === 1);
  });

  test('the darkened surround derives from --cd-bg, with a plain fallback for a browser without color-mix', () => {
    const band = rules.find((r) => r.selectors.some((s) => s.endsWith('#columns::before')));
    assert.ok(band);
    const bgs = band.decls.filter((d) => d.prop === 'background').map((d) => d.value);
    assert.equal(bgs.length, 2);
    assert.equal(bgs[0], '#000', 'fallback first');
    assert.match(bgs[1], /^color-mix\(in srgb,var\(--cd-bg,#[0-9a-f]{3,6}\) \d+%,#000\)$/);
    assert.ok(band.decls.some((d) => d.prop === 'content' && d.value === '""'));
  });

  test('in a page: two-column watch page becomes a grid; fullscreen, theatre, single column, off-watch pages and a paused feature do not', () => {
    const baseline = (attrs, flexyAttrs = {}) => {
      const p = setup({}, attrs);
      for (const [k, v] of Object.entries(flexyAttrs)) { if (v === null) p.flexy.removeAttribute(k); else p.flexy.setAttribute(k, v); }
      p.inject(css);
      return p;
    };
    const on = baseline({});
    assert.ok(on.flexy.hasAttribute('is-two-columns_'), 'fixture is the two-column layout');
    assert.equal(on.display(on.q('#columns')), 'grid');
    assert.equal(on.display(on.q('#primary')), 'contents');
    assert.equal(on.display(on.q('#primary-inner')), 'contents');
    assert.equal(on.window.getComputedStyle(on.q('#player')).gridColumn, '1 / -1');
    assert.equal(on.window.getComputedStyle(on.q('#below')).gridColumn, '1');
    assert.equal(on.window.getComputedStyle(on.q('#secondary')).gridColumn, '2');
    for (const [label, p] of [
      ['fullscreen', baseline({}, { fullscreen: '' })],
      ['theatre', baseline({}, { theater: '' })],
      ['single column', baseline({}, { 'is-two-columns_': null })],
      ['not the watch page', baseline({ 'cd-page': 'home' })],
      ['feature paused by the health check', baseline({ 'cd-off-layout-watch': '' })],
      ['no theme', (() => { const q = baseline({}); q.document.documentElement.removeAttribute('cd-theme'); return q; })()],
    ]) {
      assert.notEqual(p.display(p.q('#columns')), 'grid', label);
      assert.notEqual(p.display(p.q('#primary')), 'contents', label);
    }
  });

  test('the rules reach only the page-level boxes: nothing inside #player, the player, ads, sponsorship or comments is matched', () => {
    const p = setup({ tiles: 8, ads: 3 });
    const matched = new Set();
    for (const r of rules) for (const s of r.selectors) for (const el of run(p.document, s)) matched.add(el);
    assert.ok(matched.size >= 5);
    const allowed = new Set(['columns', 'primary', 'primary-inner', 'player', 'below', 'secondary']);
    for (const el of matched) {
      assert.ok(allowed.has(el.id), `unexpected element ${el.tagName}#${el.id}`);
      assert.ok(!el.matches(adsCss) && !el.matches(sponsorCss), 'not an ad or disclosure');
    }
    const player = p.q('#movie_player');
    assert.ok(player);
    for (const el of matched) assert.ok(!player.contains(el) && el !== player);
    assert.ok(!matched.has(p.q('video')));
  });
});

// ---- 3. focus -----------------------------------------------------------------------------------------------------------------------------

describe('focus', () => {
  const css = buildWatchLayoutCss(MAP, { watch: 'focus' });
  const rules = parseRules(css);
  const hideRules = rules.filter((r) => r.decls.some(hidesDecl));
  const leavesOf = (selector) => selector.replace(`:not(:has(${MAP.protected.ads.join(', ')}))`, '')
    .replace(`:not(:is(${[...MAP.protected.ads, ...MAP.protected.sponsor].join(',')}) *)`, '')
    .replace(`:not(:has(${MAP.protected.sponsor.join(',')}))`, '');

  test('exactly one rule hides, with the ad guard, "not inside an ad or disclosure" and "holds no disclosure" narrowings', () => {
    assert.equal(hideRules.length, 1);
    const [rule] = hideRules;
    assert.deepEqual(rule.decls, [{ prop: 'display', value: 'none !important' }]);
    assert.equal(rule.selectors.length, 1);
    const sel = rule.selectors[0];
    assert.ok(sel.startsWith(`${GATE} ytd-watch-flexy:not([fullscreen]) `), 'scoped like cinema');
    assert.ok(sel.endsWith(`:not(:has(${MAP.protected.ads.join(', ')}))`), 'safeHide guard last');
    assert.ok(sel.includes(`:not(:is(${[...MAP.protected.ads, ...MAP.protected.sponsor].join(',')}) *)`), 'not inside an ad or disclosure');
    assert.ok(sel.includes(`:not(:has(${MAP.protected.sponsor.join(',')}))`), 'holds no disclosure');
  });

  test('what it hides is only leaves: comments, related tiles/shelves/chips; never a column, a wrapper, the player or the metadata', () => {
    const leaves = leavesOf(hideRules[0].selectors[0]);
    for (const banned of ['.ytp-', 'movie_player', 'ytd-player', '#player', 'video,', '#secondary,', '#secondary)', '#columns', '#primary', 'ytd-watch-metadata,', 'ytd-engagement']) {
      assert.ok(!leaves.replace('ytd-watch-metadata #comment-teaser', '').includes(banned), `${banned} in ${leaves}`);
    }
    assert.ok(!/ytd-watch-flexy[^:]*ytd-watch-flexy/.test(leaves), 'no nested flexy from an unstripped role entry');
    assert.ok(leaves.includes('ytd-comments#comments') && leaves.includes('yt-lockup-view-model'));
  });

  test('in a page: comments and every ordinary related item are hidden; wrappers, columns, the player and all ads stay', () => {
    const p = setup({ tiles: 8, ads: 3 });
    const sel = hideRules[0].selectors[0];
    const hit = run(p.document, sel);
    const hitSet = new Set(hit);
    const lockups = [...p.q('#related').querySelectorAll('yt-lockup-view-model')];
    assert.equal(lockups.length, 8);
    for (const l of lockups) assert.ok(hitSet.has(l), 'related item hidden');
    assert.ok(hitSet.has(p.q('ytd-comments#comments')), 'comments hidden');
    for (const keep of ['#columns', '#primary', '#primary-inner', '#secondary', '#secondary-inner', '#related', '#player', '#below', '#player-ads', 'ytd-watch-metadata',
      'ytd-watch-next-secondary-results-renderer', '#movie_player', 'video']) {
      assert.ok(!hitSet.has(p.q(keep)), `${keep} must stay`);
    }
    // Nothing hidden holds an ad or a disclosure, nothing hidden sits inside one, and every ad / disclosure in the page is displayed.
    for (const el of hit) {
      assert.equal(el.querySelector(adsCss), null, `${el.tagName} holds an ad`);
      assert.equal(el.querySelector(sponsorCss), null, `${el.tagName} holds a disclosure`);
      assert.equal(el.closest(adsCss), null, `${el.tagName} sits in an ad`);
      assert.equal(el.closest(sponsorCss), null, `${el.tagName} sits in a disclosure`);
    }
    p.inject(css);
    const adNodes = p.document.querySelectorAll(`${adsCss},${sponsorCss}`);
    assert.ok(adNodes.length >= 6, `fixture has ads and a disclosure (${adNodes.length})`);
    for (const ad of adNodes) assert.notEqual(p.display(ad), 'none', `${ad.tagName}.${ad.className} stays displayed`);
    for (const l of lockups) assert.equal(p.display(l), 'none');
    assert.equal(p.display(p.q('ytd-comments#comments')), 'none');
    for (const keep of ['#secondary', '#related', '#player-ads', '#player', '#primary', '#columns', 'ytd-watch-metadata', '#movie_player']) assert.notEqual(p.display(p.q(keep)), 'none', keep);
    assert.ok(p.q('.ytp-paid-content-overlay'), 'the sponsorship disclosure is in the page');
  });

  test('ads between the related items survive, with every neighbour hidden', () => {
    const p = setup({ tiles: 6, ads: 4 });
    p.inject(css);
    const related = p.q('ytd-watch-next-secondary-results-renderer');
    const ads = [...related.querySelectorAll('ytd-ad-slot-renderer')];
    assert.ok(ads.length >= 3, `ads placed among the items (${ads.length})`);
    for (const ad of ads) {
      assert.notEqual(p.display(ad), 'none');
      for (let a = ad.parentElement; a && a !== related; a = a.parentElement) assert.notEqual(p.display(a), 'none', `ancestor ${a.tagName}`);
    }
    assert.equal(related.querySelectorAll('yt-lockup-view-model').length, 6);
    assert.ok([...related.querySelectorAll('yt-lockup-view-model')].every((l) => p.display(l) === 'none'));
  });

  test('an ad that is itself a lockup, or sits inside an ad slot among the related items, is left visible', () => {
    const p = setup({ tiles: 4, ads: 1 });
    const slot = p.q('#related ytd-ad-slot-renderer');
    assert.ok(slot);
    const lockup = p.document.createElement('yt-lockup-view-model');
    lockup.innerHTML = '<a href="/watch?v=abcdefghijk">sponsored lookalike</a>';
    slot.appendChild(lockup);
    p.inject(css);
    assert.notEqual(p.display(lockup), 'none', 'a lockup inside an ad slot is part of the ad');
    const sponsor = p.q('.ytp-paid-content-overlay');
    const inner = p.document.createElement('ytd-comments');
    sponsor.appendChild(inner);
    assert.notEqual(p.display(inner), 'none', 'anything inside a sponsorship disclosure is part of it');
    // And a related tile that HOLDS a disclosure is not hidden either.
    const tile = p.q('#related yt-lockup-view-model');
    const holder = p.document.createElement('div');
    holder.className = 'ytp-paid-content-overlay';
    tile.appendChild(holder);
    assert.notEqual(p.display(tile), 'none');
  });

  test('the comment teaser inside the metadata and related chips are hidden; the rest of the metadata and other chips are not', () => {
    const p = setup({ tiles: 4, ads: false });
    const meta = p.q('ytd-watch-metadata');
    const teaser = p.document.createElement('div');
    teaser.id = 'comment-teaser';
    teaser.textContent = 'Comments 12';
    meta.appendChild(teaser);
    const chip = p.document.createElement('yt-related-chip-cloud-renderer');
    p.q('#related').insertBefore(chip, p.q('#related').firstChild);
    const chips2 = p.document.createElement('yt-chip-cloud-renderer');
    p.q('#related').appendChild(chips2);
    const outside = p.document.createElement('yt-chip-cloud-renderer');
    p.q('#primary-inner').appendChild(outside);
    p.inject(css);
    assert.equal(p.display(teaser), 'none');
    assert.equal(p.display(chip), 'none');
    assert.equal(p.display(chips2), 'none');
    assert.notEqual(p.display(outside), 'none', 'chips outside the related list are not ours');
    assert.notEqual(p.display(meta), 'none');
    assert.notEqual(p.display(p.q('ytd-watch-metadata #title, ytd-watch-metadata')), 'none');
  });

  test('nothing is hidden in fullscreen, off the watch page, with the feature paused, or without the theme', () => {
    const cases = {
      fullscreen: setup({ tiles: 5, ads: 1 }),
      'home page': setup({ tiles: 5, ads: 1 }, { 'cd-page': 'home' }),
      paused: setup({ tiles: 5, ads: 1 }, { 'cd-off-layout-watch': '' }),
      'no theme': (() => { const q = setup({ tiles: 5, ads: 1 }); q.document.documentElement.removeAttribute('cd-theme'); return q; })(),
    };
    cases.fullscreen.flexy.setAttribute('fullscreen', '');
    for (const [label, p] of Object.entries(cases)) {
      assert.equal(run(p.document, hideRules[0].selectors[0]).length, 0, label);
      p.inject(css);
      assert.notEqual(p.display(p.q('ytd-comments#comments')), 'none', label);
      assert.notEqual(p.display(p.q('yt-lockup-view-model')), 'none', label);
    }
  });

  test('theatre mode is hidden too (focus is about content, not the player size) but fullscreen never', () => {
    const p = setup({ tiles: 5, ads: 1 });
    p.flexy.setAttribute('theater', '');
    p.inject(css);
    assert.equal(p.display(p.q('ytd-comments#comments')), 'none');
    assert.notEqual(p.display(p.q('#columns')), 'grid');
  });

  test('the column re-flow only moves things: no declaration hides, and the right column keeps its content', () => {
    const layoutRules = rules.filter((r) => !r.decls.some(hidesDecl));
    assert.ok(layoutRules.length >= 3);
    for (const r of layoutRules) {
      for (const s of r.selectors) assert.ok(s.includes('[is-two-columns_]'), s);
      for (const d of r.decls) assert.ok(['flex-wrap', 'justify-content', 'flex', 'max-width', 'width', 'min-width'].includes(d.prop), d.prop);
    }
    const p = setup({ tiles: 4, ads: 2 });
    p.inject(css);
    assert.equal(p.window.getComputedStyle(p.q('#columns')).flexWrap, 'wrap');
    assert.equal(p.window.getComputedStyle(p.q('#primary')).flex, '1 0 100%');
    assert.equal(p.window.getComputedStyle(p.q('#secondary')).flex, '1 0 100%');
    p.flexy.removeAttribute('is-two-columns_');
    assert.notEqual(p.window.getComputedStyle(p.q('#columns')).flexWrap, 'wrap', 'single-column pages are not re-flowed');
  });

  test('fails closed: an unguarded safeHide, a map without ads, or without any usable leaf yields no hide rule', async () => {
    const broken = await loadWatch('broken', BROKEN_SELECTOR_MAP);
    assert.ok(!parseRules(broken.buildWatchLayoutCss(MAP, { watch: 'focus' })).some((r) => r.decls.some(hidesDecl)));
    const noAds = clone(MAP);
    delete noAds.protected.ads;
    assert.ok(!parseRules(buildWatchLayoutCss(noAds, { watch: 'focus' })).some((r) => r.decls.some(hidesDecl)));
    const emptyAds = clone(MAP);
    emptyAds.protected.ads = [];
    assert.ok(!parseRules(buildWatchLayoutCss(emptyAds, { watch: 'focus' })).some((r) => r.decls.some(hidesDecl)));
  });

  test('a map that lost its comments / related / tile roles still hides comments and related items through the built-in names', () => {
    const slim = clone(MAP);
    for (const role of ['comments', 'watchRelated', 'videoTile', 'chips', 'shortsShelf']) delete slim.roles[role];
    const rule = parseRules(buildWatchLayoutCss(slim, { watch: 'focus' })).find((r) => r.decls.some(hidesDecl));
    assert.ok(rule);
    const p = setup({ tiles: 6, ads: 2 });
    const hit = new Set(run(p.document, rule.selectors[0]));
    assert.ok(hit.has(p.q('ytd-comments#comments')));
    assert.equal([...p.q('#related').querySelectorAll('yt-lockup-view-model')].filter((l) => hit.has(l)).length, 6);
  });

  test('a sponsor list is optional: without one the ad narrowing still applies', () => {
    const noSponsor = clone(MAP);
    delete noSponsor.protected.sponsor;
    const rule = parseRules(buildWatchLayoutCss(noSponsor, { watch: 'focus' })).find((r) => r.decls.some(hidesDecl));
    assert.ok(rule);
    assert.ok(rule.selectors[0].includes(`:not(:is(${MAP.protected.ads.join(',')}) *)`));
  });

  test('size stays modest', () => {
    assert.ok(css.length < 9000, `${css.length} bytes`);
    assert.ok(buildWatchLayoutCss(MAP, { watch: 'cinema' }).length < 2500);
  });
});

// ---- 4. live watch presentation -------------------------------------------------------------------------------------------------------

describe('live watch presentation', () => {
  test('buildWatchLiveCss produces rules scoped under cd-watch-live and targets viewCounts', () => {
    const css = buildWatchLiveCss(MAP, {});
    assert.ok(css.length > 50);
    assert.ok(css.includes('html[cd-theme][cd-page="watch"][cd-watch-live]:not([cd-off-layout-watch]) ytd-watch-flexy:not([fullscreen])'));
    assert.ok(css.includes('#cc0000'));
    assert.ok(css.includes('cd-live-pulse'));
    assert.ok(css.includes('@keyframes cd-live-pulse'));
    assert.ok(css.includes('prefers-reduced-motion:reduce'));

    // Disabled when layout-watch is in disabled list
    assert.equal(buildWatchLiveCss(MAP, { disabled: ['layout-watch'] }), '');

    // Disabled when map has no viewCounts
    const noViews = clone(MAP);
    delete noViews.roles.viewCounts;
    assert.equal(buildWatchLiveCss(noViews, {}), '');

    // When animations: false, pulse animation and @keyframes are omitted
    const noAnimCss = buildWatchLiveCss(MAP, { animations: false });
    assert.ok(!noAnimCss.includes('@keyframes cd-live-pulse'));
    assert.ok(!noAnimCss.includes('animation:cd-live-pulse'));
    assert.ok(noAnimCss.includes('#cc0000'));

    // The player is never touched
    for (const banned of ['.ytp-', 'movie_player', 'ytd-player', '#player-container']) {
      assert.ok(!css.includes(banned), banned);
    }
    assert.ok(!/(^|[^-\w])video($|[^-\w])/.test(css), 'video tag not targeted');
  });

  test('isWatchLive identifies live stream viewer count indicators and rejects VODs', () => {
    assert.equal(isWatchLive(null), false);
    assert.equal(isWatchLive({}), false);

    const p = setup({ tiles: 4 });
    const viewSpan = p.flexy.querySelector('ytd-watch-info-text #info-container #info > span:first-child');
    assert.ok(viewSpan, 'viewSpan found in fixture');
    // Default page has '84k views' (VOD)
    assert.equal(isWatchLive(p.document), false);

    // Live stream texts
    const liveSamples = [
      '591 watching',
      '8,460 watching now',
      '1.2K watching',
      '25 watching right now',
      '1,234 spectateurs',
      '500 espectadores en directo',
      '300 зрителей',
      '150 waiting',
      'Live stream started 20 minutes ago',
    ];
    for (const text of liveSamples) {
      viewSpan.textContent = text;
      assert.equal(isWatchLive(p.document), true, `Failed for text: "${text}"`);
    }

    // Non-live texts
    const vodSamples = [
      '1,234 views',
      '84k views',
      '1.2M views',
      'Streamed 2 days ago',
      'Premiered Sep 10, 2026',
      'No views',
    ];
    for (const text of vodSamples) {
      viewSpan.textContent = text;
      assert.equal(isWatchLive(p.document), false, `Should be false for VOD text: "${text}"`);
    }

    // When flexy has hidden attribute, returns false
    p.flexy.setAttribute('hidden', '');
    viewSpan.textContent = '591 watching';
    assert.equal(isWatchLive(p.document), false);
    p.flexy.removeAttribute('hidden');
  });

  test('hasWatchMetadata returns true when view count or info text has rendered', () => {
    assert.equal(hasWatchMetadata(null), false);
    const p = setup({ tiles: 4 });
    // Fixture already has '84k views', so metadata is present
    assert.equal(hasWatchMetadata(p.document), true);

    // Remove metadata elements
    const infoText = p.flexy.querySelector('ytd-watch-info-text');
    infoText.remove();
    assert.equal(hasWatchMetadata(p.document), false);

    const viewCountEl = p.document.createElement('ytd-video-view-count-renderer');
    viewCountEl.textContent = '   ';
    p.flexy.appendChild(viewCountEl);
    assert.equal(hasWatchMetadata(p.document), false);

    viewCountEl.textContent = '1,000 views';
    assert.equal(hasWatchMetadata(p.document), true);
  });
});

// ---- 5. differential against the real selector-map.js, when it exists -------------------------------------------------------------------

test('when the real src/shared/selector-map.js exists, watch.js built on it produces the same CSS', { skip: !existsSync(REAL_SELECTOR_MAP) && 'src/shared/selector-map.js not written yet' }, async () => {
  const real = await loadWatch('real', null);
  for (const mode of ['cinema', 'focus', 'default']) assert.equal(real.buildWatchLayoutCss(MAP, { watch: mode }), buildWatchLayoutCss(MAP, { watch: mode }), mode);
  assert.equal(real.buildWatchLiveCss(MAP, {}), buildWatchLiveCss(MAP, {}), 'live CSS matches');
});

