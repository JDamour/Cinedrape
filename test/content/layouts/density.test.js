// Tests for src/content/layouts/density.js (owner: layouts agent).
//
// What is proven: the table is monotonic (roomier never packs more in), normalizeDensity is total, the generated CSS sets
// exactly the three spacing variables per level, overrides the home grid's columns per breakpoint with !important only under
// html[cd-theme], touches search and channel spacing only through the variables, hides nothing, and degrades on a bare map.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPage } from '../../helpers/dom.js';
import {
  DENSITY_TABLE, DEFAULT_DENSITY, normalizeDensity, rowVisibleForDensity, rowChunkForDensity, isFeatureDisabled, roleEntries,
  buildDensityCss,
} from '../../../src/content/layouts/density.js';

const MAP = JSON.parse(readFileSync(new URL('../../../src/data/selector-map.source.json', import.meta.url), 'utf8'));
const LEVELS = [1, 2, 3, 4, 5];

const open = [];
after(() => { for (const p of open) p.window.close(); });

/** Minimal rule parser: [{ at: '', selector, body }] for plain rules and rules inside one level of @media. */
function rules(css) {
  const out = [];
  const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const walk = (src, at) => {
    let i = 0;
    while (i < src.length) {
      const open = src.indexOf('{', i);
      if (open < 0) break;
      const prelude = src.slice(i, open).trim();
      let depth = 1;
      let j = open + 1;
      while (j < src.length && depth) { if (src[j] === '{') depth++; else if (src[j] === '}') depth--; j++; }
      const body = src.slice(open + 1, j - 1);
      if (prelude.startsWith('@media')) walk(body, prelude);
      else out.push({ at, selector: prelude, body: body.trim() });
      i = j;
    }
  };
  walk(text, '');
  return out;
}

// ---- table and helpers -------------------------------------------------------------------------------------------------

test('the table is monotonic: roomier = bigger gaps and cards, fewer cards in view, fewer columns at every breakpoint', () => {
  for (const key of ['gap', 'cardMin', 'rowGap']) {
    for (const n of [1, 2, 3, 4]) assert.ok(DENSITY_TABLE[n][key] < DENSITY_TABLE[n + 1][key], `${key} ${n}->${n + 1}`);
  }
  for (const n of [1, 2, 3, 4]) {
    assert.ok(DENSITY_TABLE[n].visible > DENSITY_TABLE[n + 1].visible, `visible ${n}->${n + 1}`);
    for (const bp of ['xl', 'lg', 'md', 'sm']) assert.ok(DENSITY_TABLE[n].perRow[bp] >= DENSITY_TABLE[n + 1].perRow[bp], `perRow.${bp} ${n}->${n + 1}`);
  }
  for (const n of LEVELS) {
    const { xl, lg, md, sm } = DENSITY_TABLE[n].perRow;
    assert.ok(xl >= lg && lg >= md && md >= sm && sm >= 1, `breakpoints narrow with the viewport at density ${n}`);
  }
  assert.deepEqual(LEVELS.map(rowVisibleForDensity), [8, 7, 6, 5, 4], 'the task: 1 -> 8 ... 5 -> 4');
  assert.deepEqual(LEVELS.map(rowChunkForDensity), [16, 14, 12, 10, 8]);
  assert.ok(Object.isFrozen(DENSITY_TABLE) && Object.isFrozen(DENSITY_TABLE[3]) && Object.isFrozen(DENSITY_TABLE[3].perRow));
});

test('normalizeDensity is total: numbers round and clamp, junk becomes the default', () => {
  assert.equal(DEFAULT_DENSITY, 3);
  const cases = [[1, 1], [5, 5], [3, 3], [2.4, 2], [2.5, 3], [4.6, 5], [0, 1], [-7, 1], [99, 5], ['4', 4], [' 2 ', 2], ['5.2', 5],
    ['', 3], ['  ', 3], ['abc', 3], [NaN, 3], [Infinity, 3], [-Infinity, 3], [null, 3], [undefined, 3], [true, 3], [{}, 3], [[], 3], [[4], 3], [() => 4, 3], [Symbol('x'), 3], [10n, 3]];
  for (const [input, want] of cases) assert.equal(normalizeDensity(input), want, String(typeof input === 'symbol' ? 'symbol' : typeof input === 'bigint' ? '10n' : JSON.stringify(input)));
});

test('isFeatureDisabled and roleEntries read only what they are given', () => {
  assert.equal(isFeatureDisabled({ disabled: ['density'] }, 'density'), true);
  assert.equal(isFeatureDisabled({ disabled: ['layout-home'] }, 'density'), false);
  for (const bad of [null, undefined, {}, { disabled: 'density' }, { disabled: null }, 5]) assert.equal(isFeatureDisabled(bad, 'density'), false);
  assert.deepEqual(roleEntries(MAP, 'homeGrid'), MAP.roles.homeGrid);
  assert.deepEqual(roleEntries(MAP, 'nope'), []);
  assert.deepEqual(roleEntries(MAP, '__proto__'), []);
  assert.deepEqual(roleEntries(MAP, 'constructor'), []);
  assert.deepEqual(roleEntries({ roles: { x: [' a ', '', 3, null, 'b'] } }, 'x'), ['a', 'b']);
  assert.deepEqual(roleEntries({ roles: { x: 'a' } }, 'x'), []);
  assert.deepEqual(roleEntries(null, 'x'), []);
});

// ---- generated CSS -----------------------------------------------------------------------------------------------------

for (const n of LEVELS) {
  test(`density ${n}: variables, home grid columns per breakpoint, nothing else`, () => {
    const css = buildDensityCss(MAP, { density: n });
    const d = DENSITY_TABLE[n];
    const rs = rules(css);
    const vars = rs.find((r) => r.selector === 'html[cd-theme]');
    assert.ok(vars, 'variable block');
    assert.equal(vars.body, `--cd-gap:${d.gap}px;--cd-card-min:${d.cardMin}px;--cd-row-gap:${d.rowGap}px`);

    const colRules = rs.filter((r) => r.body.includes('--ytd-rich-grid-items-per-row'));
    assert.ok(colRules.length >= 2, 'one rule per grid selector in the map');
    for (const r of colRules) {
      assert.match(r.selector, /^html\[cd-theme\] ytd-(browse|two-column-browse-results-renderer)\[page-subtype="home"\] ytd-rich-grid-renderer$/);
      assert.match(r.body, /^--ytd-rich-grid-items-per-row:\d !important$/, 'only this declaration, and it must be !important to beat the inline style');
    }
    const at = (cond) => colRules.filter((r) => r.at.includes(cond)).map((r) => Number(r.body.match(/:(\d)/)[1]));
    const base = colRules.filter((r) => !r.at).map((r) => Number(r.body.match(/:(\d)/)[1]));
    assert.deepEqual([...new Set(base)], [d.perRow.lg]);
    if (d.perRow.xl !== d.perRow.lg) assert.deepEqual([...new Set(at('min-width:1700px'))], [d.perRow.xl]); else assert.equal(at('min-width:1700px').length, 0);
    if (d.perRow.md !== d.perRow.lg) assert.deepEqual([...new Set(at('max-width:1199px'))], [d.perRow.md]); else assert.equal(at('max-width:1199px').length, 0);
    if (d.perRow.sm !== d.perRow.md) assert.deepEqual([...new Set(at('max-width:699px'))], [d.perRow.sm]); else assert.equal(at('max-width:699px').length, 0);

    // What a browser would end up with at each width: later rules win at equal specificity.
    const effective = (width) => {
      let v = null;
      for (const r of colRules.slice(0, colRules.length)) {
        const min = /min-width:(\d+)px/.exec(r.at);
        const max = /max-width:(\d+)px/.exec(r.at);
        if ((min && width < Number(min[1])) || (max && width > Number(max[1]))) continue;
        v = Number(r.body.match(/:(\d)/)[1]);
      }
      return v;
    };
    assert.equal(effective(1800), d.perRow.xl);
    assert.equal(effective(1400), d.perRow.lg);
    assert.equal(effective(900), d.perRow.md);
    assert.equal(effective(500), d.perRow.sm);
  });
}

test('every selector is scoped under html[cd-theme] or targets only spacing on named page types', () => {
  const css = buildDensityCss(MAP, { density: 4 });
  for (const r of rules(css)) {
    assert.ok(r.selector.startsWith('html[cd-theme]'), r.selector);
    assert.ok(!r.selector.includes(','), `one selector per rule so one bad entry costs one rule: ${r.selector}`);
  }
  const spacing = rules(css).filter((r) => /margin/.test(r.body));
  assert.ok(spacing.length >= 3);
  // The read of --cd-row-gap is clamped (ad-safety review finding 2): a stylesheet that sets the variable cannot push a tile away.
  for (const r of spacing) {
    assert.match(r.body, /^margin-(top|bottom):(clamp\(0px,var\(--cd-row-gap,30px\),64px\)|calc\(clamp\(0px,var\(--cd-row-gap,30px\),64px\) \* 0\.55\))$/);
  }
});

test('density CSS hides, fades, clips and collapses nothing (so it needs no ad guard)', () => {
  for (const n of LEVELS) {
    const css = buildDensityCss(MAP, { density: n });
    for (const banned of ['display:none', 'visibility', 'opacity', 'clip', 'filter', 'pointer-events', 'transform', 'overflow', 'height:0', 'width:0', 'z-index', 'position:']) {
      assert.ok(!css.includes(banned), `${banned} in density ${n}`);
    }
  }
});

test('a missing, junk or disabled config: default level, no throw, disabled feature is empty', () => {
  const dflt = buildDensityCss(MAP, { density: 3 });
  for (const cfg of [undefined, null, {}, { density: null }, { density: 'x' }, { density: NaN }, { density: {} }]) assert.equal(buildDensityCss(MAP, cfg), dflt);
  assert.equal(buildDensityCss(MAP, { density: 4, disabled: ['density'] }), '');
  assert.notEqual(buildDensityCss(MAP, { density: 4, disabled: ['layout-home'] }), '');
  assert.equal(buildDensityCss(MAP, { density: 99 }), buildDensityCss(MAP, { density: 5 }));
  assert.equal(buildDensityCss(MAP, { density: '1' }), buildDensityCss(MAP, { density: 1 }));
});

test('a map without the home or search roles still yields the variable block and never throws', () => {
  for (const map of [undefined, null, {}, { roles: {} }, { roles: { homeGrid: 'oops', searchResults: null } }]) {
    const css = buildDensityCss(map, { density: 2 });
    assert.match(css, /html\[cd-theme\]\{--cd-gap:12px;--cd-card-min:170px;--cd-row-gap:22px\}/);
    assert.ok(!css.includes('--ytd-rich-grid-items-per-row'), 'nothing to override without the grid role');
  }
  const noSearch = structuredClone(MAP);
  delete noSearch.roles.searchResults;
  assert.ok(!buildDensityCss(noSearch, { density: 3 }).includes('ytd-video-renderer{'));
});

test('output is deterministic and small', () => {
  for (const n of LEVELS) {
    const a = buildDensityCss(MAP, { density: n });
    assert.equal(a, buildDensityCss(MAP, { density: n }));
    assert.ok(a.length < 2500, `${a.length} bytes at density ${n}`);
    assert.ok(a.endsWith('\n') && !a.includes('\r'));
  }
});

// ---- in a page ---------------------------------------------------------------------------------------------------------

function styled(kind, css, opts = {}) {
  const p = createPage(kind, { tiles: 4, ...opts });
  open.push(p);
  p.document.documentElement.setAttribute('cd-theme', 'cinema');
  const style = p.document.createElement('style');
  style.textContent = css;
  p.document.head.appendChild(style);
  return p;
}

test('in a page: the variables resolve on <html> and the !important override beats the grid\'s inline value', () => {
  for (const n of LEVELS) {
    const p = styled('home', buildDensityCss(MAP, { density: n }));
    const cs = p.window.getComputedStyle(p.document.documentElement);
    assert.equal(cs.getPropertyValue('--cd-gap'), `${DENSITY_TABLE[n].gap}px`);
    assert.equal(cs.getPropertyValue('--cd-card-min'), `${DENSITY_TABLE[n].cardMin}px`);
    assert.equal(cs.getPropertyValue('--cd-row-gap'), `${DENSITY_TABLE[n].rowGap}px`);
    const grid = p.document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
    grid.style.setProperty('--ytd-rich-grid-items-per-row', '9');
    // jsdom applies top-level rules only: the base (lg) value must win over the inline 9. (The @media blocks are checked above.)
    assert.equal(p.window.getComputedStyle(grid).getPropertyValue('--ytd-rich-grid-items-per-row'), String(DENSITY_TABLE[n].perRow.lg));
  }
});

test('in a page: without html[cd-theme] nothing applies (the engine can switch the look off in one attribute)', () => {
  const p = styled('home', buildDensityCss(MAP, { density: 5 }));
  p.document.documentElement.removeAttribute('cd-theme');
  assert.equal(p.window.getComputedStyle(p.document.documentElement).getPropertyValue('--cd-gap'), '');
  const grid = p.document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer');
  grid.style.setProperty('--ytd-rich-grid-items-per-row', '3');
  assert.equal(p.window.getComputedStyle(grid).getPropertyValue('--ytd-rich-grid-items-per-row'), '3');
});

test('in a page: the grid override does not leak to the channel grid, search or watch pages', () => {
  const css = buildDensityCss(MAP, { density: 5 });
  for (const kind of ['channel', 'search', 'watch', 'playlist']) {
    const p = styled(kind, css);
    const grid = p.document.querySelector('ytd-rich-grid-renderer');
    if (grid) {
      grid.style.setProperty('--ytd-rich-grid-items-per-row', '6');
      assert.equal(p.window.getComputedStyle(grid).getPropertyValue('--ytd-rich-grid-items-per-row'), '6', kind);
    }
  }
});

test('in a page: tile spacing follows --cd-row-gap on home, channel and search', () => {
  // jsdom drops a margin whose value is clamp(... var() ...) (its CSS parser cannot hold it), so the rule that applies to each element is
  // found by matching the generated selectors against it and read from the CSS text.
  const bodyFor = (css, el) => {
    const hit = rules(css).find((r) => /^margin-/.test(r.body) && el.matches(r.selector));
    assert.ok(hit, 'a spacing rule matches the element');
    return hit.body;
  };
  for (const n of [1, 5]) {
    const css = buildDensityCss(MAP, { density: n });
    const home = styled('home', css);
    const item = home.document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer');
    assert.equal(bodyFor(css, item), 'margin-bottom:clamp(0px,var(--cd-row-gap,30px),64px)', 'the read of the variable is clamped');
    const channel = styled('channel', css);
    const cItem = channel.document.querySelector('ytd-browse[page-subtype="channels"] ytd-rich-grid-renderer > #contents > ytd-rich-item-renderer');
    assert.equal(bodyFor(css, cItem), 'margin-bottom:clamp(0px,var(--cd-row-gap,30px),64px)');
    const search = styled('search', css);
    const row = search.document.querySelector('ytd-search ytd-item-section-renderer > #contents > ytd-video-renderer');
    assert.equal(bodyFor(css, row), 'margin-top:calc(clamp(0px,var(--cd-row-gap,30px),64px) * 0.55)');
  }
});
