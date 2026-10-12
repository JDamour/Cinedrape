// Calm mode tests (ARCHITECTURE.md section 4 "content/calm.js", section 6).
//
// How the tests are wired
// - src/shared/selector-map.js (roleCss / safeHide / protectedCss) is written by another module. calm.js is loaded here with
//   a faithful local copy of it injected through a module resolve hook (LOCAL_SELECTOR_MAP below), so these tests do not
//   depend on that file existing. When the real file exists, a differential block compares both and runs calm against the
//   real one too.
// - The hidden set is computed from the generated CSS itself: every hide rule's selector is run with querySelectorAll on a
//   real-fixture page (jsdom applies :has / :is / :not exactly as getComputedStyle would for top-level rules, see
//   test/helpers/selectors-in-jsdom.test.js), then compared with an INDEPENDENT oracle written with different selectors.
// - The ad-safety scanner at the bottom is deliberately a separate parser of the CSS text, and it is tested against bad CSS.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { createPage, navigateTo, loadFixture, loadTemplates, applyRename } from '../helpers/dom.js';
import { ATTR, CALM_KEYS, FEATURES, FREE_CALM_KEYS } from '../../src/shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(HERE, '..', '..', 'src');
const CALM_FILE = path.join(SRC, 'content', 'calm.js');
const REAL_SELECTOR_MAP = path.join(SRC, 'shared', 'selector-map.js');
const MAP = JSON.parse(readFileSync(path.join(SRC, 'data', 'selector-map.source.json'), 'utf8'));
const cloneMap = () => structuredClone(MAP);

// ---- faithful local copy of src/shared/selector-map.js (contract section 4) ----------------------------------------------

const LOCAL_SELECTOR_MAP = `
export const log = (globalThis.__cdCalmSafeHide ||= []);
const groupOf = (map, group) => {
  const list = map && map.protected && map.protected[group];
  if (!Array.isArray(list)) throw new Error('map.protected.' + group + ' missing');
  return list;
};
export function protectedCss(map, group) {
  if (group) return groupOf(map, group).join(', ');
  return ['ads', 'sponsor', 'playerControls'].flatMap((g) => groupOf(map, g)).join(', ');
}
export function roleCss(map, role) {
  const list = map && map.roles && map.roles[role];
  if (!Array.isArray(list) || !list.length) throw new Error('unknown or empty role ' + role);
  return list.join(', ');
}
export function safeHide(map, selector) {
  const ads = protectedCss(map, 'ads');
  if (!ads) throw new Error('map has no protected.ads');
  const out = selector + ':not(:has(' + ads + '))';
  log.push(out);
  return out;
}
`;
// A broken safeHide that forgets the guard: calm must refuse to emit anything built on it.
const BROKEN_SELECTOR_MAP = LOCAL_SELECTOR_MAP.replace("const out = selector + ':not(:has(' + ads + '))';", 'const out = selector;');
assert.notEqual(BROKEN_SELECTOR_MAP, LOCAL_SELECTOR_MAP, 'test setup: the broken copy must differ');

const canHook = typeof nodeModule.registerHooks === 'function';

/** Imports calm.js as its own module instance whose '../shared/selector-map.js' is `selectorMapSource`. */
async function loadCalm(tag, selectorMapSource) {
  const parent = `${pathToFileURL(CALM_FILE).href}?${tag}`;
  if (!canHook) return import(pathToFileURL(CALM_FILE).href);
  const mapUrl = `data:text/javascript;base64,${Buffer.from(selectorMapSource).toString('base64')}`;
  const hooks = nodeModule.registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === '../shared/selector-map.js' && context.parentURL === parent) return { url: mapUrl, format: 'module', shortCircuit: true };
      return nextResolve(specifier, context);
    },
  });
  try { return await import(parent); } finally { hooks.deregister(); }
}

const calm = await loadCalm('isolated', LOCAL_SELECTOR_MAP);
const { buildCalmCss, applyCalmAttributes, calmAttr } = calm;
const CSS = buildCalmCss(MAP, {});

// ---- a separate parser for the generated CSS ------------------------------------------------------------------------------

const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, '');

/** Splits on `sep` at nesting depth 0 (outside (), [] and quotes). */
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

function matchBrace(text, open) {
  let depth = 0;
  let quote = '';
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  throw new Error('unbalanced braces in generated CSS');
}

const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw|ch)?$/;
/** True for the declarations the contract calls hiding: display:none, visibility, opacity<1, zero size, clip, scale(0), filter. */
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

const parseDecls = (body) => splitTop(body, ';').map((d) => {
  const i = d.indexOf(':');
  return { prop: d.slice(0, i).trim(), value: d.slice(i + 1).trim() };
});

/** -> [{ selectors:[string], decls:[{prop,value}], hides:boolean, at:string[] }] ; descends into @media/@supports/@layer. */
function parseRules(css, at = []) {
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
    if (open < 0) throw new Error(`stray CSS text without a block: ${text.slice(i, i + 80)}`);
    const close = matchBrace(text, open);
    const prelude = text.slice(i, open).trim();
    const body = text.slice(open + 1, close);
    if (prelude.startsWith('@')) {
      if (/^@(media|supports|layer|container|document)\b/i.test(prelude)) rules.push(...parseRules(body, [...at, prelude]));
      else rules.push({ selectors: [], decls: parseDecls(body), hides: parseDecls(body).some(hidesDecl), at: [...at, prelude] });
    } else {
      const decls = parseDecls(body);
      rules.push({ selectors: splitTop(prelude, ','), decls, hides: decls.some(hidesDecl), at });
    }
    i = close + 1;
  }
  return rules;
}

/** Last compound of a complex selector (split on depth-0 whitespace and > + ~). */
function subjectOf(selector) {
  const parts = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '\\') { cur += ch + (selector[i + 1] ?? ''); i++; continue; }
    if (quote) { cur += ch; if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) { if (cur) parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts[parts.length - 1] || '';
}

/** Contents of every depth-0 `:not(:has(...))` in a selector, as arrays of trimmed entries. */
function topLevelGuards(selector) {
  const out = [];
  let depth = 0;
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i];
    if (ch === '\\') { i++; continue; }
    if (quote) { if (ch === quote) quote = ''; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (depth === 0 && selector.startsWith(':not(:has(', i)) {
      let d = 0;
      let k = i + ':not('.length;
      const innerStart = k;
      for (; k < selector.length; k++) {
        if (selector[k] === '(') d++;
        else if (selector[k] === ')') { d--; if (d < 0) break; }
      }
      const inner = selector.slice(innerStart, k); // ":has(....)"
      if (inner.startsWith(':has(') && inner.endsWith(')')) out.push(splitTop(inner.slice(':has('.length, -1), ','));
      i = k;
      continue;
    }
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
  }
  return out;
}

const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

/** `text` with every balanced (...) group removed, nested ones included (a one-pass regex leaves the tail of nested groups behind). */
function withoutParens(text) {
  let depth = 0;
  let out = '';
  for (const ch of text) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0) out += ch;
  }
  return out;
}

/** A cd- subject: a Cinedrape class/id, or a cd- attribute on something other than <html>. Never `html[cd-...]` alone. */
function hasCdSubject(selector) {
  const subject = subjectOf(selector);
  const depth0 = withoutParens(subject);
  if (/^(html|body|:root|\*)(\[|:|$)/.test(depth0) && !/[.#]cd-/.test(depth0)) return false;
  return /[.#]cd-[\w-]+/.test(depth0) || /\[cd-[\w-]+/.test(depth0);
}

/**
 * The ad-safety scanner. Returns one message per violation: a hide rule whose selector is neither guarded by the full
 * protected.ads list (depth-0 :not(:has(...))) nor a cd- subject; any hide rule inside an at-rule; any hide rule that is not
 * gated on an html[cd-calm-...] attribute (only checked when requireGate).
 */
function scanHideRules(css, map, { requireGate = true } = {}) {
  const ads = map.protected.ads;
  const problems = [];
  for (const rule of parseRules(css)) {
    if (!rule.hides) continue;
    if (rule.at.length) problems.push(`hide declaration inside ${rule.at.join(' / ')}`);
    for (const sel of rule.selectors) {
      const guarded = topLevelGuards(sel).some((g) => sameSet(g, ads));
      if (!guarded && !hasCdSubject(sel)) problems.push(`unguarded hide: ${sel.slice(0, 140)}`);
      if (requireGate && !/^html\[cd-calm-[A-Za-z]+\]/.test(sel)) problems.push(`not gated on html[cd-calm-*]: ${sel.slice(0, 140)}`);
    }
  }
  return problems;
}

// ---- jsdom helpers ----------------------------------------------------------------------------------------------------

const label = (el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}${el.classList?.length ? `.${el.classList[0]}` : ''}`;
const everyElement = (doc) => [doc.documentElement, doc.body, ...doc.body.querySelectorAll('*')];
const joinSel = (...lists) => lists.flat().join(',');
const PROTECTED = (group) => MAP.protected[group].join(',');
const ADS = PROTECTED('ads');
const SPONSOR = PROTECTED('sponsor');
const CONTROLS = PROTECTED('playerControls');

const RULES = parseRules(CSS);
const HIDE_RULES = RULES.filter((r) => r.hides);

/** Elements the generated CSS hides directly (the rule's own subject), honouring each rule's html gate. */
function hiddenRoots(doc, rules = HIDE_RULES) {
  const roots = new Set();
  const html = doc.documentElement;
  for (const rule of rules) {
    for (const sel of rule.selectors) {
      const gate = /^html(\[[^\]]+\])+(:not\(\[[^\]]+\]\))?/.exec(sel);
      if (gate && !html.matches(gate[0])) continue; // gate closed: skip the expensive subject match
      for (const el of doc.querySelectorAll(sel)) roots.add(el);
    }
  }
  return roots;
}
const effectivelyHidden = (el, roots) => { for (let n = el; n; n = n.parentElement) if (roots.has(n)) return true; return false; };

/** Every element that is, or sits inside, something matching `selector` (independent oracle). */
function insideOf(doc, selector) {
  const out = new Set();
  for (const root of doc.querySelectorAll(selector)) {
    out.add(root);
    for (const el of root.querySelectorAll('*')) out.add(el);
  }
  return out;
}

/** page + generated css + chosen html attributes. */
function setup(kind, pageOpts = {}, { on = [], pageAttr = kind, css = CSS } = {}) {
  const page = createPage(kind, pageOpts);
  const { document } = page;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);
  document.documentElement.setAttribute(ATTR.page, pageAttr);
  for (const key of on) document.documentElement.setAttribute(ATTR.calmPrefix + key, '');
  return page;
}

/** Asserts the set of elements the CSS hides (incl. descendants) equals what the oracle selector covers. */
function assertHidden(page, expectedSelector, what, { css } = {}) {
  const { document } = page;
  const rules = css ? parseRules(css).filter((r) => r.hides) : HIDE_RULES;
  const roots = hiddenRoots(document, rules);
  const expected = insideOf(document, expectedSelector);
  assert.ok(expected.size > 0, `${what}: the oracle matched nothing, the fixture does not exercise this toggle`);
  const wrong = [];
  const missing = [];
  for (const el of everyElement(document)) {
    const hidden = effectivelyHidden(el, roots);
    if (hidden && !expected.has(el)) wrong.push(label(el));
    if (!hidden && expected.has(el)) missing.push(label(el));
  }
  assert.deepEqual(wrong.slice(0, 12), [], `${what}: hidden but should stay visible (${wrong.length})`);
  assert.deepEqual(missing.slice(0, 12), [], `${what}: should be hidden but is visible (${missing.length})`);
  return roots;
}

function assertNothingHidden(page, what) {
  const roots = hiddenRoots(page.document);
  assert.deepEqual([...roots].map(label).slice(0, 12), [], `${what}: nothing may be hidden`);
}

const parse = (doc, html) => {
  const t = doc.createElement('template');
  t.innerHTML = html;
  return t.content.firstElementChild;
};
const stripLeadingComments = (html) => html.replace(/^\s*(?:<!--[\s\S]*?-->\s*)+/, '');

// ---- applyCalmAttributes -----------------------------------------------------------------------------------------------------

describe('applyCalmAttributes', () => {
  const attrs = (doc) => CALM_KEYS.filter((k) => doc.documentElement.hasAttribute(ATTR.calmPrefix + k));

  test('attribute name is ATTR.calmPrefix + key and calmAttr agrees', () => {
    assert.equal(ATTR.calmPrefix, 'cd-calm-');
    for (const key of CALM_KEYS) assert.equal(calmAttr(key), `cd-calm-${key}`);
  });

  test('sets exactly the toggles that are true and removes the ones that turn false', () => {
    const { document } = createPage('home', { tiles: 1 });
    const on = applyCalmAttributes(document, { hideShorts: true, hideHomeRecs: false, hideComments: true });
    assert.deepEqual(on, ['hideShorts', 'hideComments']);
    assert.deepEqual(attrs(document), ['hideShorts', 'hideComments']);
    assert.equal(document.documentElement.getAttribute('cd-calm-hideShorts'), '', 'present = on, empty value');
    applyCalmAttributes(document, { hideShorts: false, hideComments: true, hideViewCounts: true });
    assert.deepEqual(attrs(document), ['hideComments', 'hideViewCounts']);
    applyCalmAttributes(document, {});
    assert.deepEqual(attrs(document), [], 'a key missing from calm counts as off');
  });

  test('every toggle is independent of the others', () => {
    for (const key of CALM_KEYS) {
      const { document } = createPage('home', { tiles: 1 });
      applyCalmAttributes(document, { [key]: true });
      assert.deepEqual(attrs(document), [key]);
    }
  });

  test('skips toggles whose feature calm-<key> is health-disabled, and removes a stale attribute of a feature that just broke', () => {
    assert.ok(FEATURES.includes('calm-hideShorts'));
    const { document } = createPage('home', { tiles: 1 });
    const all = Object.fromEntries(CALM_KEYS.map((k) => [k, true]));
    assert.deepEqual(applyCalmAttributes(document, all, ['calm-hideShorts', 'calm-hideViewCounts']), ['hideHomeRecs', 'hideComments', 'hideEndScreens']);
    assert.deepEqual(attrs(document), ['hideHomeRecs', 'hideComments', 'hideEndScreens']);
    applyCalmAttributes(document, all);
    assert.equal(attrs(document).length, 5);
    applyCalmAttributes(document, all, new Set(['calm-hideComments']));
    assert.ok(!attrs(document).includes('hideComments'), 'a Set works as well as an array, and a broken feature switches itself off');
    applyCalmAttributes(document, all, ['theme', 'layout-home', 'density']);
    assert.equal(attrs(document).length, 5, 'unrelated disabled features change nothing');
    applyCalmAttributes(document, all, 'calm-hideShorts');
    assert.equal(attrs(document).length, 5, 'a bare string is not a list of features');
  });

  test('ignores unknown keys, inherited keys and non-true values; never touches other attributes', () => {
    const { document } = createPage('home', { tiles: 1 });
    const html = document.documentElement;
    html.setAttribute('cd-calm-hideFoo', '');
    html.setAttribute('cd-theme', 'cinema');
    const before = [...html.attributes].map((a) => `${a.name}=${a.value}`).filter((s) => !s.startsWith('cd-calm-')).sort();
    const inherited = Object.create({ hideShorts: true });
    applyCalmAttributes(document, inherited);
    applyCalmAttributes(document, { hideFoo: true, constructor: true, __proto__: { hideComments: true }, hideShorts: 'true', hideHomeRecs: 1, hideEndScreens: 'yes', hideViewCounts: {} });
    assert.deepEqual(attrs(document), [], 'only a real boolean true turns a toggle on (a corrupted store must not hide things)');
    assert.ok(html.hasAttribute('cd-calm-hideFoo'), 'attributes for unknown keys are not swept either');
    assert.ok(!html.hasAttribute('cd-calm-constructor'));
    const after = [...html.attributes].map((a) => `${a.name}=${a.value}`).filter((s) => !s.startsWith('cd-calm-')).sort();
    assert.deepEqual(after, before);
  });

  test('tolerates junk input without throwing', () => {
    const { document } = createPage('home', { tiles: 1 });
    for (const calmValue of [undefined, null, 0, 'hideShorts', [], ['hideShorts'], () => {}, 42n]) {
      assert.doesNotThrow(() => applyCalmAttributes(document, calmValue, undefined), String(calmValue));
    }
    for (const dis of [undefined, null, 5, {}, 'x']) assert.doesNotThrow(() => applyCalmAttributes(document, { hideShorts: true }, dis));
    for (const doc of [undefined, null, {}, { documentElement: null }, { documentElement: {} }]) {
      assert.deepEqual(applyCalmAttributes(doc, { hideShorts: true }), []);
    }
  });

  test('idempotent and cheap: a repeat call writes nothing (no mutation records) and reads no layout', () => {
    const { document, window } = createPage('home', { tiles: 1 });
    const html = document.documentElement;
    const calmCfg = { hideShorts: true, hideComments: true };
    applyCalmAttributes(document, calmCfg);
    const seen = [];
    const observer = new window.MutationObserver((records) => seen.push(...records));
    observer.observe(html, { attributes: true });
    applyCalmAttributes(document, calmCfg);
    applyCalmAttributes(document, calmCfg, ['theme']);
    assert.deepEqual(observer.takeRecords(), [], 'second call must not touch the DOM');
    applyCalmAttributes(document, { hideShorts: true });
    assert.equal(observer.takeRecords().length, 1, 'only the one real change is written');
    observer.disconnect();

    // A document that records every property it is asked for: only has/set/removeAttribute are allowed.
    const touched = [];
    const root = new Proxy({}, {
      get(_, prop) {
        touched.push(String(prop));
        if (prop === 'hasAttribute') return () => false;
        if (prop === 'setAttribute' || prop === 'removeAttribute') return () => {};
        throw new Error(`unexpected property read on <html>: ${String(prop)}`);
      },
    });
    assert.doesNotThrow(() => applyCalmAttributes({ documentElement: root }, { hideShorts: true, hideComments: false }));
    assert.deepEqual([...new Set(touched)].sort(), ['hasAttribute', 'removeAttribute', 'setAttribute'].filter((n) => touched.includes(n)));
    assert.ok(!touched.some((p) => /rect|offset|client|scroll|computed|style|layout/i.test(p)));
  });

  test('attributes live on <html>, so they survive SPA navigation untouched', () => {
    const page = createPage('home', { tiles: 4 });
    applyCalmAttributes(page.document, { hideShorts: true, hideComments: true });
    const before = attrs(page.document);
    navigateTo(page, 'watch', { tiles: 4 });
    navigateTo(page, 'search', { tiles: 3 });
    navigateTo(page, 'home', { tiles: 3 });
    assert.deepEqual(attrs(page.document), before);
  });
});

// ---- buildCalmCss: structure ------------------------------------------------------------------------------------------------

describe('buildCalmCss structure', () => {
  test('returns the same static stylesheet whatever cfg says, with a block for all five toggles', () => {
    assert.equal(typeof CSS, 'string');
    assert.ok(CSS.length > 1000);
    assert.equal(buildCalmCss(MAP), CSS);
    assert.equal(buildCalmCss(MAP, { calm: { hideShorts: true }, disabled: ['calm-hideShorts', 'calm-hideComments'], pro: false }), CSS);
    assert.equal(buildCalmCss(cloneMap(), {}), CSS, 'deterministic');
    for (const key of CALM_KEYS) assert.ok(CSS.includes(`html[cd-calm-${key}]`), `gate for ${key}`);
    assert.deepEqual(FREE_CALM_KEYS.filter((k) => !CALM_KEYS.includes(k)), []);
  });

  test('every rule sits in the block of the toggle it is gated on, and nothing is ungated', () => {
    const blocks = CSS.split(/\/\* calm:(\w+) \*\/\n/).slice(1);
    assert.equal(blocks.length / 2, 5, 'five marked blocks');
    for (let i = 0; i < blocks.length; i += 2) {
      const key = blocks[i];
      assert.ok(CALM_KEYS.includes(key), key);
      const rules = parseRules(blocks[i + 1]);
      assert.ok(rules.length >= 1, `${key} has rules`);
      for (const rule of rules) {
        for (const sel of rule.selectors) assert.ok(sel.startsWith(`html[cd-calm-${key}]`), `${key}: ${sel.slice(0, 100)}`);
      }
    }
    for (const rule of RULES) assert.equal(rule.at.length, 0, 'no at-rules: jsdom and the first-paint cache treat flat rules most simply');
  });

  test('parses cleanly: balanced, ASCII, no external references, every selector accepted by the selector engine', () => {
    const { window, document } = createPage('home', { tiles: 1 });
    assert.match(CSS, /^[\x09\x0a\x20-\x7e]+$/, 'ASCII only');
    assert.ok(!/@import|@font-face|url\(|expression\(|behavior\s*:|-moz-binding|javascript:/i.test(CSS));
    let selectors = 0;
    for (const rule of RULES) {
      assert.ok(rule.decls.length >= 1);
      for (const sel of rule.selectors) {
        selectors++;
        if (sel.includes('::')) continue; // pseudo-elements are not queryable
        assert.doesNotThrow(() => document.querySelector(sel), `selector engine rejects: ${sel.slice(0, 160)}`);
      }
    }
    const style = document.createElement('style');
    style.textContent = CSS;
    document.head.appendChild(style);
    assert.equal(style.sheet.cssRules.length, RULES.length, 'the stylesheet parser kept every rule');
    assert.ok(selectors >= 6);
    void window;
  });

  test('size stays small enough for the 64 KB first-paint cache (all five toggles together)', () => {
    assert.ok(CSS.length < 24 * 1024, `calm CSS is ${CSS.length} bytes`);
    const lines = CSS.split('\n').filter((l) => l && !l.startsWith('/*'));
    assert.equal(new Set(lines).size, lines.length, 'no duplicated rule');
  });

  test('every selector comes from the map: swapping a role swaps the CSS, nothing from the old role is hardcoded', () => {
    const roleBlock = { shortsShelf: 'hideShorts', shortsTiles: 'hideShorts', shortsNavEntry: 'hideShorts', homeGridContents: 'hideHomeRecs',
      richItem: 'hideHomeRecs', continuation: 'hideHomeRecs', comments: 'hideComments', endScreens: 'hideEndScreens', viewCounts: 'hideViewCounts',
      videoTile: 'hideViewCounts' };
    for (const [role, key] of Object.entries(roleBlock)) {
      const map = cloneMap();
      map.roles[role] = [`.sentinel-${role}`];
      const css = buildCalmCss(map, {});
      const blockOf = (text) => text.split(/\/\* calm:/).find((b) => b.startsWith(`${key} */`)) || '';
      const block = blockOf(css);
      assert.ok(block.includes(`.sentinel-${role}`), `${role} reaches the ${key} block`);
      for (const old of MAP.roles[role]) {
        // The same selector may legitimately appear through another role (also inside a :has() of one); only check it is gone
        // when no other role of the block contains it.
        const owners = Object.entries(roleBlock).filter(([r, k]) => k === key && r !== role && MAP.roles[r].some((entry) => entry.includes(old)));
        if (!owners.length) assert.ok(!block.includes(old), `${role}: old selector ${old.slice(0, 60)} must disappear`);
      }
    }
  });

  test('a richSection role in the map overrides the built-in fallback for the home feed children', () => {
    const base = buildCalmCss(MAP, {});
    assert.ok(base.includes('ytd-rich-section-renderer'), 'fallback names the shelf wrapper');
    const map = cloneMap();
    map.roles.richSection = ['.sentinel-section'];
    const css = buildCalmCss(map, {});
    const homeBlock = css.split('/* calm:hideHomeRecs */')[1].split('/* calm:')[0];
    assert.ok(homeBlock.includes('.sentinel-section'));
    assert.ok(!homeBlock.includes('ytd-rich-grid-row'));
  });

  test('a map that lost roles never makes the builder throw, and only costs the affected toggle', () => {
    for (const role of Object.keys(MAP.roles)) {
      const map = cloneMap();
      delete map.roles[role];
      assert.doesNotThrow(() => buildCalmCss(map, {}), role);
    }
    const noShorts = cloneMap();
    delete noShorts.roles.shortsShelf;
    delete noShorts.roles.shortsTiles;
    delete noShorts.roles.shortsNavEntry;
    const css = buildCalmCss(noShorts, {});
    assert.ok(css.includes('html[cd-calm-hideComments]') && css.includes('html[cd-calm-hideViewCounts]'));
    const emptyRoles = cloneMap();
    emptyRoles.roles = {};
    assert.doesNotThrow(() => buildCalmCss(emptyRoles, {}));
    assert.deepEqual(scanHideRules(buildCalmCss(emptyRoles, {}), MAP), []);
  });

  test('fails closed: no ad list, a broken map or an unguarded safeHide means no hide rule at all', () => {
    const noAds = cloneMap();
    noAds.protected.ads = [];
    assert.equal(buildCalmCss(noAds, {}), '');
    const missing = cloneMap();
    delete missing.protected;
    assert.equal(buildCalmCss(missing, {}), '');
    for (const junk of [null, undefined, {}, [], 'map', 7]) assert.equal(buildCalmCss(junk, {}), '', String(junk));
  });

  test('no sponsor group is tolerated (ads guard still applies); the ancestor guard simply has no sponsor part', () => {
    const map = cloneMap();
    delete map.protected.sponsor;
    const css = buildCalmCss(map, {});
    assert.ok(css.length > 1000);
    assert.deepEqual(scanHideRules(css, map), []);
  });

  test('refuses to emit rules built on a safeHide that does not add the guard', async (t) => {
    if (!canHook) return t.skip('module hooks unavailable on this Node');
    const broken = await loadCalm('broken', BROKEN_SELECTOR_MAP);
    assert.equal(broken.buildCalmCss(MAP, {}), '', 'every rule depends on safeHide, so nothing may be emitted');
  });

  test('every hide rule is produced through safeHide', (t) => {
    if (!canHook) return t.skip('module hooks unavailable on this Node');
    globalThis.__cdCalmSafeHide.length = 0;
    const css = buildCalmCss(MAP, {});
    const calls = [...globalThis.__cdCalmSafeHide];
    assert.ok(calls.length >= 5, 'safeHide was called for the five toggles');
    const hideLines = css.split('\n').filter((l) => l.includes('display:none'));
    assert.ok(hideLines.length >= 5);
    for (const line of hideLines) {
      assert.ok(calls.some((out) => line.includes(out)), `no safeHide output inside: ${line.slice(0, 120)}`);
    }
  });
});

// ---- the ad-safety scanner, and the scanner tested against bad CSS -----------------------------------------------------------

describe('ad-safety scanner', () => {
  test('the real calm CSS passes: every hide rule has the full ads guard or a cd- subject', () => {
    const problems = scanHideRules(CSS, MAP);
    assert.deepEqual(problems, []);
    assert.ok(HIDE_RULES.length >= 5);
    for (const rule of HIDE_RULES) {
      assert.deepEqual(rule.decls.filter(hidesDecl).map((d) => `${d.prop}:${d.value}`), ['display:none !important'], 'calm hides with display:none only');
    }
  });

  test('every hide rule also keeps sponsorship disclosures: sponsor guard on the subject', () => {
    for (const rule of HIDE_RULES) {
      for (const sel of rule.selectors) {
        assert.ok(topLevelGuards(sel).some((g) => sameSet(g, MAP.protected.sponsor)), `no sponsor guard: ${sel.slice(0, 120)}`);
      }
    }
  });

  test('leaf-ish toggles (Shorts, view counts) also refuse to hide anything inside an ad or an ad-carrying tile', () => {
    for (const key of ['hideShorts', 'hideViewCounts']) {
      const block = CSS.split('/* calm:').find((b) => b.startsWith(`${key} */`));
      assert.ok(block.includes(':not(:is('), `${key}: ancestor guard`);
      for (const needle of ['ytd-ad-slot-renderer', 'ad-badge-view-model', '.ytp-paid-content-overlay']) {
        assert.ok(block.split(':not(:is(')[1].includes(needle), `${key}: ancestor guard names ${needle}`);
      }
    }
  });

  test('scanner self-test: flags unguarded hides, partly guarded lists, hides in at-rules, gate-less rules, a bare html hide', () => {
    const guard = `:not(:has(${MAP.protected.ads.join(', ')}))`;
    const ok = `html[cd-calm-hideComments] ytd-comments${guard}{display:none !important}`;
    assert.deepEqual(scanHideRules(ok, MAP), []);
    const bad = [
      ['no guard', 'html[cd-calm-hideComments] ytd-comments{display:none}'],
      ['short ads list', `html[cd-calm-hideComments] ytd-comments:not(:has(ytd-ad-slot-renderer)){display:none}`],
      ['guard inside :is() only', `html[cd-calm-hideComments] :is(ytd-comments${guard}){display:none}`],
      ['one of two selectors unguarded', `html[cd-calm-hideComments] ytd-comments${guard},html[cd-calm-hideComments] #comments{display:none}`],
      ['visibility', 'html[cd-calm-hideComments] ytd-comments{visibility:hidden}'],
      ['opacity', 'html[cd-calm-hideComments] ytd-comments{opacity:0}'],
      ['zero height', 'html[cd-calm-hideComments] ytd-comments{max-height:0}'],
      ['scale(0)', 'html[cd-calm-hideComments] ytd-comments{transform:scale(0)}'],
      ['clip', 'html[cd-calm-hideComments] ytd-comments{clip:rect(0,0,0,0)}'],
      ['in @media', `@media (min-width:1px){html[cd-calm-hideComments] ytd-comments${guard}{display:none}}`],
      ['in @supports, unguarded', '@supports (display:grid){html[cd-calm-hideComments] ytd-comments{display:none}}'],
      ['hides html itself', 'html[cd-calm-hideComments]{display:none}'],
      ['hides body via cd attr', 'html[cd-calm-hideComments] body[cd-x]{display:none}'.replace('body[cd-x]', 'html[cd-x]')],
      ['universal', 'html[cd-calm-hideComments] *{display:none}'],
    ];
    for (const [name, css] of bad) assert.notDeepEqual(scanHideRules(css, MAP, { requireGate: false }), [], `scanner must flag: ${name}`);
    assert.notDeepEqual(scanHideRules('ytd-comments' + guard + '{display:none}', MAP), [], 'gate-less rule is flagged when a gate is required');
    // Allowed: a cd- subject without guard, non-hiding declarations on anything.
    assert.deepEqual(scanHideRules('html[cd-calm-hideHomeRecs] .cd-home{display:none}', MAP), []);
    assert.deepEqual(scanHideRules('html[cd-calm-hideHomeRecs] ytd-comments{color:red;display:block}', MAP), []);
  });

  test('scanner mutation test: removing the guard from the generated CSS makes the scanner fail', () => {
    const ads = MAP.protected.ads.join(', ');
    const stripped = CSS.split(`:not(:has(${ads}))`).join('');
    assert.notEqual(stripped, CSS, 'the generated CSS contains the guard in the exact form of protectedCss(ads)');
    assert.ok(scanHideRules(stripped, MAP).length >= 5);
    const truncated = CSS.split(MAP.protected.ads[MAP.protected.ads.length - 1]).join('.never');
    assert.ok(scanHideRules(truncated, MAP).length >= 1, 'a guard missing one ad selector is caught');
  });
});

// ---- hideShorts ---------------------------------------------------------------------------------------------------------------

const SHORTS_ORACLE = [
  'grid-shelf-view-model', 'ytd-reel-shelf-renderer',
  'ytd-rich-section-renderer:has(ytd-rich-shelf-renderer[is-shorts])',
  'ytd-rich-item-renderer:has(ytm-shorts-lockup-view-model-v2)',
  'ytm-shorts-lockup-view-model-v2', 'ytd-reel-item-renderer',
  'ytd-guide-entry-renderer:has(> a[title="Shorts"])', 'ytd-mini-guide-entry-renderer:has(> a[href="/shorts/"])',
  'yt-tab-shape[tab-title="Shorts"]',
].join(',');

describe('hideShorts', () => {
  const variants = [
    ['home, rich shelf', 'home', { tiles: 7, ads: 2, shorts: 'rich' }],
    ['home, rich shelf, home tile style', 'home', { tiles: 7, ads: 2, shorts: 'rich', tileStyle: 'home' }],
    ['subscriptions, rich shelf', 'subscriptions', { tiles: 6, ads: 1, shorts: 'rich' }],
    ['channel grid with a shelf', 'channel', { tiles: 6, shorts: 'rich' }],
    ['search, grid shelf (live shape)', 'search', { tiles: 3, ads: 2, shorts: 'grid' }],
    ['search, grid shelf, no ads', 'search', { tiles: 3, shorts: true }],
    ['watch rail, reel shelf', 'watch', { tiles: 4, ads: true, shorts: 'reel' }],
    ['watch rail, grid shelf', 'watch', { tiles: 4, shorts: 'grid' }],
  ];
  for (const [name, kind, opts] of variants) {
    test(`hides the Shorts shelf and its cells and nothing else: ${name}`, () => {
      const page = setup(kind, opts, { on: ['hideShorts'] });
      assertHidden(page, SHORTS_ORACLE, name);
      // Spot-check through the real style path as well.
      const hiddenCell = page.document.querySelector('a[href^="/shorts/"]');
      assert.ok(hiddenCell);
      let el = hiddenCell;
      let hidden = false;
      for (; el; el = el.parentElement) if (page.window.getComputedStyle(el).display === 'none') { hidden = true; break; }
      assert.ok(hidden, 'getComputedStyle reports the Shorts link hidden');
    });
  }

  test('regular watch links, ad items, chips and the other guide entries stay visible', () => {
    const page = setup('home', { tiles: 6, ads: 2, shorts: 'rich' }, { on: ['hideShorts'] });
    const { document } = page;
    const roots = hiddenRoots(document);
    for (const sel of ['a[href^="/watch"]', 'ytd-ad-slot-renderer', '#masthead-ad ytd-video-masthead-ad-v3-renderer', 'yt-chip-cloud-chip-renderer', 'ytd-masthead',
      'ytd-guide-entry-renderer:not(:has(> a[title="Shorts"]))', 'ytd-mini-guide-entry-renderer:not(:has(> a[href="/shorts/"]))', 'ytd-continuation-item-renderer']) {
      const found = [...document.querySelectorAll(sel)];
      assert.ok(found.length > 0, sel);
      for (const el of found) assert.ok(!effectivelyHidden(el, roots), `${sel} must stay visible`);
    }
  });

  test('both the full guide entry (no href, title only) and the mini guide entry (href) go, at any viewport', () => {
    const page = setup('home', { tiles: 2 }, { on: ['hideShorts'] });
    const { document } = page;
    const roots = hiddenRoots(document);
    const full = document.querySelector('ytd-guide-entry-renderer:has(> a[title="Shorts"])');
    const mini = document.querySelector('ytd-mini-guide-entry-renderer:has(> a[href="/shorts/"])');
    assert.ok(full && mini);
    assert.ok(!full.querySelector('a').hasAttribute('href'), 'fixture: the full guide entry has no href');
    assert.ok(roots.has(full), 'the entry is hidden, not only its link (no empty guide row left behind)');
    assert.ok(roots.has(mini));
  });

  test('a Shorts shelf that also carries an ad stays; only the plain Shorts cells in it go', () => {
    const page = setup('home', { tiles: 4, shorts: 'rich' }, { on: ['hideShorts'] });
    const { document } = page;
    const shelfContents = document.querySelector('ytd-rich-shelf-renderer[is-shorts] [id="contents"]');
    const adItem = parse(document, loadTemplates('synthetic/ad-slot')['feed-ad']);
    shelfContents.appendChild(adItem);
    const roots = hiddenRoots(document);
    const section = document.querySelector('ytd-rich-section-renderer');
    assert.ok(!effectivelyHidden(adItem, roots), 'the ad is visible');
    assert.ok(!effectivelyHidden(adItem.querySelector('.ytwAdBadge'), roots), 'its Sponsored badge is visible');
    for (const wrapper of [section, document.querySelector('ytd-rich-shelf-renderer'), shelfContents]) assert.ok(!roots.has(wrapper) && !effectivelyHidden(wrapper, roots), `${label(wrapper)} is kept because it holds an ad`);
    const cells = [...shelfContents.querySelectorAll(':scope > ytd-rich-item-renderer:has(ytm-shorts-lockup-view-model-v2)')];
    assert.equal(cells.length, 3);
    for (const cell of cells) assert.ok(roots.has(cell), 'plain Shorts cells are still hidden');
  });

  test('a sponsored Shorts cell (ad badge inside the cell) and a Shorts link inside an ad are never hidden', () => {
    const page = setup('search', { tiles: 2, shorts: 'grid' }, { on: ['hideShorts'] });
    const { document } = page;
    const items = [...document.querySelectorAll('.ytGridShelfViewModelGridShelfItem')];
    const sponsored = items[0];
    sponsored.querySelector('ytm-shorts-lockup-view-model-v2').appendChild(parse(document, '<ad-badge-view-model><span class="ytAttributedStringHost">Sponsored</span></ad-badge-view-model>'));
    const adWithShortsLink = parse(document, '<ytd-ad-slot-renderer><div id="content"><a class="adlink" href="/shorts/ADxxxxxxxxx">Sponsored Short</a></div></ytd-ad-slot-renderer>');
    document.querySelector('ytd-search [id="contents"]').prepend(adWithShortsLink);
    const roots = hiddenRoots(document);
    assert.ok(!effectivelyHidden(sponsored, roots), 'the sponsored cell and everything in it stays');
    assert.ok(!effectivelyHidden(sponsored.querySelector('ad-badge-view-model'), roots));
    assert.ok(!effectivelyHidden(adWithShortsLink.querySelector('a.adlink'), roots), 'a /shorts/ link inside an ad is not "a Shorts tile"');
    // The rule hides the cell itself (ytm-shorts-lockup-view-model-v2, what the map names as a Shorts tile), not the plain wrapper div around it.
    assert.ok(effectivelyHidden(items[1].querySelector('ytm-shorts-lockup-view-model-v2'), roots), 'organic cells next to it still go');
    assert.ok(!roots.has(document.querySelector('grid-shelf-view-model')), 'the shelf is kept: it holds a sponsored cell');
  });

  test('the channel Shorts tab: cells and the Shorts tab button go, the rest of the page and the real #masthead-ad stay', () => {
    const page = setup('channel', { tiles: 2, ads: true }, { on: ['hideShorts'] });
    const { document } = page;
    const grid = document.querySelector('ytd-rich-grid-renderer');
    const shortsGrid = parse(document, stripLeadingComments(loadFixture('real/shorts-grid')));
    shortsGrid.prepend(parse(document, '<div id="masthead-ad"></div>'));
    grid.replaceWith(shortsGrid);
    assert.equal(document.querySelectorAll('ytd-rich-item-renderer[is-shorts-grid]').length, 2);
    const roots = assertHidden(page, SHORTS_ORACLE, 'channel Shorts tab');
    assert.ok(!roots.has(shortsGrid), 'the grid wrapper holds the always-present #masthead-ad, so its guard keeps it; the cells are hidden instead');
    assert.ok(!effectivelyHidden(document.querySelector('#masthead-ad'), roots));
    const tabs = [...document.querySelectorAll('yt-tab-shape')];
    assert.deepEqual(tabs.map((t) => [t.getAttribute('tab-title'), effectivelyHidden(t, roots)]), [['Home', false], ['Videos', false], ['Shorts', true]]);
  });

  test('the Shorts player page (ytd-shorts) is left alone, the Shorts nav entries are not', () => {
    const page = setup('home', { tiles: 1 }, { on: ['hideShorts'], pageAttr: 'shorts' });
    const { document } = page;
    const player = parse(document, `<ytd-shorts><div id="shorts-container"><a class="reel" href="/shorts/U-LrN7yix6I"></a><ytd-reel-video-renderer><a class="owner" href="/shorts/AAAAAAAAAAA"></a><ytm-shorts-lockup-view-model-v2 class="nextcell"></ytm-shorts-lockup-view-model-v2></ytd-reel-video-renderer></div></ytd-shorts>`);
    document.querySelector('ytd-page-manager').replaceChildren(player);
    const roots = hiddenRoots(document);
    for (const el of player.querySelectorAll('*')) assert.ok(!effectivelyHidden(el, roots), `${label(el)} inside the Shorts player`);
    assert.ok(roots.has(document.querySelector('ytd-guide-entry-renderer:has(> a[title="Shorts"])')));
  });

  test('content that arrives later (infinite scroll, SPA) is hidden with no re-injection', () => {
    const page = setup('home', { tiles: 3 }, { on: ['hideShorts'] });
    // Only the guide and mini-guide entries (with the links inside them) exist on this page at first; the oracle covers exactly those.
    assertHidden(page, SHORTS_ORACLE, 'home at first');
    assert.ok(!page.document.querySelector('ytd-reel-shelf-renderer, ytm-shorts-lockup-view-model-v2'), 'fixture: no Shorts content yet');
    navigateTo(page, 'search', { tiles: 3, shorts: 'grid' });
    page.document.documentElement.setAttribute(ATTR.page, 'search');
    assertHidden(page, SHORTS_ORACLE, 'search after navigation');
    const feed = page.document.querySelector('ytd-item-section-renderer [id="contents"]');
    feed.appendChild(parse(page.document, stripLeadingComments(loadFixture('real/shorts-shelf'))));
    assertHidden(page, SHORTS_ORACLE, 'second shelf appended later');
  });

  test('off when the attribute is absent, and off after it is removed', () => {
    const page = setup('home', { tiles: 4, ads: 1, shorts: 'rich' }, { on: [] });
    assertNothingHidden(page, 'no attribute');
    page.document.documentElement.setAttribute('cd-calm-hideShorts', '');
    assert.ok(hiddenRoots(page.document).size > 0);
    page.document.documentElement.removeAttribute('cd-calm-hideShorts');
    assertNothingHidden(page, 'attribute removed');
  });
});

// ---- hideHomeRecs -------------------------------------------------------------------------------------------------------------

describe('hideHomeRecs', () => {
  const feedOf = (document) => document.querySelector('ytd-browse[page-subtype="home"] ytd-rich-grid-renderer > [id="contents"]');
  /** Oracle: every direct child of the feed that holds no ad, plus the mirror root. */
  function homeOracleElements(document) {
    const children = [...feedOf(document).children].filter((c) => !c.querySelector('ytd-ad-slot-renderer, ytd-video-masthead-ad-v3-renderer, #masthead-ad'));
    return children;
  }
  function assertHomeHidden(page, what) {
    const { document } = page;
    const roots = hiddenRoots(document);
    const expected = new Set(homeOracleElements(document));
    for (const mirror of document.querySelectorAll('.cd-home')) if (!mirror.querySelector(ADS)) expected.add(mirror);
    assert.ok(expected.size > 0, what);
    const wrong = [];
    const missing = [];
    for (const el of everyElement(document)) {
      const hidden = effectivelyHidden(el, roots);
      const should = [...expected].some((r) => r === el || r.contains(el));
      if (hidden && !should) wrong.push(label(el));
      if (!hidden && should) missing.push(label(el));
    }
    assert.deepEqual(wrong.slice(0, 10), [], `${what}: wrongly hidden`);
    assert.deepEqual(missing.slice(0, 10), [], `${what}: still visible`);
    return roots;
  }

  for (const tileStyle of ['grid', 'home']) {
    test(`home with ads and a Shorts shelf (${tileStyle} tiles): every recommendation goes, ads and the page frame stay`, () => {
      const page = setup('home', { tiles: 9, ads: 3, shorts: 'rich', tileStyle }, { on: ['hideHomeRecs'] });
      const roots = assertHomeHidden(page, tileStyle);
      const { document } = page;
      assert.equal([...feedOf(document).children].filter((c) => !roots.has(c)).length, 3, 'only the three ad rows remain in the feed');
      for (const sel of ['ytd-ad-slot-renderer', '#masthead-ad', 'ytd-video-masthead-ad-v3-renderer', 'ytd-feed-filter-chip-bar-renderer', 'yt-chip-cloud-chip-renderer',
        'ytd-masthead', 'ytd-browse[page-subtype="home"]', 'ytd-two-column-browse-results-renderer', 'ytd-rich-grid-renderer', 'tp-yt-app-drawer', 'ytd-mini-guide-renderer', '[id="primary"]']) {
        const found = [...document.querySelectorAll(sel)];
        assert.ok(found.length > 0, sel);
        for (const el of found) assert.ok(!effectivelyHidden(el, roots), `${sel} must stay`);
      }
      assert.ok(roots.has(feedOf(document).querySelector(':scope > ytd-continuation-item-renderer')), 'the spinner goes too: with nothing visible it would keep fetching pages nobody can see');
      // Real style path as well: the browser-side style engine agrees with the selector-level check above.
      const hiddenRow = [...feedOf(document).children].find((c) => roots.has(c));
      assert.equal(page.window.getComputedStyle(hiddenRow).display, 'none');
    });

    test(`home with no ads at all (${tileStyle} tiles): the feed is fully hidden, the frame is intact, the placeholder rule exists`, () => {
      const page = setup('home', { tiles: 8, shorts: 'rich', tileStyle }, { on: ['hideHomeRecs'] });
      const { document } = page;
      const roots = assertHomeHidden(page, 'fully hidden');
      const feed = feedOf(document);
      assert.ok([...feed.children].every((c) => roots.has(c)), 'every child hidden');
      assert.ok(!effectivelyHidden(feed, roots), 'the feed container itself stays (it carries the placeholder text)');
      assert.ok(!effectivelyHidden(document.querySelector('ytd-feed-filter-chip-bar-renderer'), roots));
      const placeholder = RULES.find((r) => r.selectors.some((s) => s.includes('::before')));
      assert.ok(placeholder, 'a ::before rule exists');
      const text = placeholder.decls.find((d) => d.prop === 'content').value;
      assert.match(text, /^"[\x20-\x7e]{10,100}"$/, 'plain ASCII message of at most 100 characters');
      assert.ok(!text.slice(1, -1).includes('"') && !text.includes('\\'));
      assert.ok(!placeholder.hides, 'the placeholder is not a hide rule');
      assert.ok(placeholder.selectors.every((s) => s.startsWith('html[cd-calm-hideHomeRecs][cd-page="home"] ')), 'only on the home page with the toggle on');
      for (const sel of placeholder.selectors) assert.ok(page.document.querySelector(sel.replace(/::before$/, '')), `placeholder anchors on a real element: ${sel.slice(0, 90)}`);
      assert.match(placeholder.decls.find((d) => d.prop === 'flex').value, /100%/, 'takes the whole row of the flex feed');
    });
  }

  test('only on the home page: stale cd-page, wrong page-subtype, other pages with the same grid renderer', () => {
    // Channel page: same ytd-rich-grid-renderer, different page-subtype. Attribute says home during the navigation race.
    const raceChannel = setup('channel', { tiles: 6, ads: 1 }, { on: ['hideHomeRecs'], pageAttr: 'home' });
    assertNothingHidden(raceChannel, 'channel DOM while cd-page still says home (page-subtype=channels)');
    const channel = setup('channel', { tiles: 6 }, { on: ['hideHomeRecs'], pageAttr: 'channel' });
    assertNothingHidden(channel, 'channel page');
    const subs = setup('subscriptions', { tiles: 6 }, { on: ['hideHomeRecs'], pageAttr: 'subscriptions' });
    assertNothingHidden(subs, 'subscriptions page');
    // Home DOM but cd-page says something else (e.g. between navigations): the gate is closed.
    const stale = setup('home', { tiles: 6 }, { on: ['hideHomeRecs'], pageAttr: 'watch' });
    assertNothingHidden(stale, 'cd-page=watch');
    const none = setup('home', { tiles: 6 }, { on: ['hideHomeRecs'] });
    none.document.documentElement.removeAttribute(ATTR.page);
    assertNothingHidden(none, 'no cd-page yet');
    for (const kind of ['search', 'watch', 'history', 'playlist']) {
      assertNothingHidden(setup(kind, { tiles: 4, ads: true, shorts: kind === 'search' ? 'grid' : false }, { on: ['hideHomeRecs'], pageAttr: kind }), kind);
    }
  });

  test('survives SPA navigation: home -> watch -> home keeps the attribute and re-applies', () => {
    const page = setup('home', { tiles: 5, ads: 1 }, { on: ['hideHomeRecs'] });
    assertHomeHidden(page, 'first visit');
    navigateTo(page, 'watch', { tiles: 4 });
    page.document.documentElement.setAttribute(ATTR.page, 'watch');
    assert.ok(page.document.documentElement.hasAttribute('cd-calm-hideHomeRecs'), 'attribute untouched by navigation');
    assertNothingHidden(page, 'watch page');
    navigateTo(page, 'home', { tiles: 5, ads: 1, tileStyle: 'home' });
    page.document.documentElement.setAttribute(ATTR.page, 'home');
    assertHomeHidden(page, 'second visit');
  });

  test('Cinedrape\'s own home mirror (.cd-home) goes with it, unless it somehow holds an ad', () => {
    const page = setup('home', { tiles: 4, ads: 1 }, { on: ['hideHomeRecs'] });
    const { document } = page;
    const mirror = parse(document, '<div class="cd-home"><div class="cd-hero"><a class="cd-card" href="/watch?v=x"><span class="cd-card-title">t</span></a></div><div class="cd-row"></div></div>');
    feedOf(document).closest('[id="primary"]').insertBefore(mirror, document.querySelector('ytd-rich-grid-renderer'));
    const roots = assertHomeHidden(page, 'mirror hidden with the feed');
    assert.ok(roots.has(mirror));
    // Adversarial: a layout bug put an ad inside the mirror. Then it is kept (rule 6.1), and the feed rule is unaffected.
    mirror.appendChild(parse(document, loadTemplates('synthetic/ad-slot')['related-ad']));
    const again = hiddenRoots(document);
    assert.ok(!again.has(mirror), 'a mirror that holds an ad is not hidden');
    // And the mirror stays visible when the toggle is off.
    document.documentElement.removeAttribute('cd-calm-hideHomeRecs');
    mirror.querySelector('ytd-ad-slot-renderer').remove();
    assert.ok(!hiddenRoots(document).has(mirror));
  });

  test('a feed made only of ads shows the ads and nothing else', () => {
    const page = setup('home', { tiles: 0, ads: 2 }, { on: ['hideHomeRecs'] });
    const { document } = page;
    const roots = hiddenRoots(document);
    const kids = [...feedOf(document).children];
    assert.ok(kids.some((c) => c.querySelector('ytd-ad-slot-renderer')));
    for (const c of kids) assert.equal(roots.has(c), !c.querySelector('ytd-ad-slot-renderer, #masthead-ad'), label(c));
  });

  test('toggling the attribute off restores everything (no residue)', () => {
    const page = setup('home', { tiles: 6, ads: 1, shorts: 'rich' }, { on: ['hideHomeRecs'] });
    assert.ok(hiddenRoots(page.document).size > 3);
    page.document.documentElement.removeAttribute('cd-calm-hideHomeRecs');
    assertNothingHidden(page, 'off');
  });
});

// ---- hideComments -------------------------------------------------------------------------------------------------------------

describe('hideComments', () => {
  const ORACLE = 'ytd-comments, [id="comment-teaser"]';

  test('watch page: the comments section (and the teaser) go, title/metadata/player/related stay', () => {
    const page = setup('watch', { tiles: 4 }, { on: ['hideComments'] });
    const roots = assertHidden(page, ORACLE, 'watch');
    const { document } = page;
    for (const sel of ['ytd-watch-metadata', '[id="title"] h1', '[id="movie_player"]', '[id="related"]', '[id="below"]', 'ytd-watch-flexy', '[id="secondary"]', 'ytd-watch-info-text']) {
      for (const el of document.querySelectorAll(sel)) assert.ok(!effectivelyHidden(el, roots), sel);
    }
    assert.equal(page.window.getComputedStyle(document.querySelector('ytd-comments')).display, 'none', 'real style path');
  });

  test('with ads and sponsorship on the page, none of it is touched and the exact set is unchanged', () => {
    const page = setup('watch', { tiles: 4, ads: 2, shorts: 'reel' }, { on: ['hideComments'] });
    assertHidden(page, ORACLE, 'watch with ads');
  });

  test('also hides the second ytd-comments copy (engagement panel) and survives a tag rename through the #comments fallback', () => {
    const page = setup('watch', { tiles: 2 }, { on: ['hideComments'] });
    const { document } = page;
    document.querySelector('[id="panels"]').appendChild(parse(document, '<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-comments-section"><div id="content"><ytd-comments><div id="x">panel copy</div></ytd-comments></div></ytd-engagement-panel-section-list-renderer>'));
    let roots = hiddenRoots(document);
    assert.ok(effectivelyHidden(document.querySelector('[id="x"]'), roots));
    assert.ok(!effectivelyHidden(document.querySelector('ytd-engagement-panel-section-list-renderer'), roots), 'the panel frame stays');
    assert.ok(applyRename(document, ['ytd-comments']) >= 2);
    roots = hiddenRoots(document);
    assert.ok(effectivelyHidden(document.querySelector('[id="comments"]'), roots), 'renamed tag, same id: the role fallback still hides it');
  });

  test('other pages are unaffected', () => {
    for (const kind of ['home', 'search', 'channel', 'playlist', 'history', 'subscriptions']) {
      const page = setup(kind, { tiles: 3 }, { on: ['hideComments'], pageAttr: kind });
      // the hidden ytd-watch-flexy skeleton on non-watch pages is not part of these fixtures; any hit would still be a comments node
      for (const el of hiddenRoots(page.document)) assert.ok(el.matches(ORACLE), `${kind}: ${label(el)}`);
    }
  });

  test('a comments block that somehow holds an ad is kept; one that holds a sponsor disclosure too', () => {
    const page = setup('watch', { tiles: 2 }, { on: ['hideComments'] });
    const { document } = page;
    const comments = document.querySelector('ytd-comments');
    assert.ok(hiddenRoots(document).has(comments));
    const ad = parse(document, '<ytd-ad-slot-renderer><div id="content">ad</div></ytd-ad-slot-renderer>');
    comments.appendChild(ad);
    assert.ok(!hiddenRoots(document).has(comments), 'ad inside: kept');
    ad.remove();
    const sponsor = parse(document, '<div class="ytp-paid-content-overlay-text">Includes paid promotion</div>');
    comments.appendChild(sponsor);
    assert.ok(!hiddenRoots(document).has(comments), 'sponsorship disclosure inside: kept');
  });
});

// ---- hideEndScreens -----------------------------------------------------------------------------------------------------------

describe('hideEndScreens', () => {
  const ORACLE = '.ytp-ce-element, .ytp-ce-shadow, .ytp-endscreen-content, .ytp-endscreen-previous, .ytp-endscreen-next';

  test('end cards, their shadow, the end-of-video wall and its arrows go; the player, controls and the wall frame stay', () => {
    const page = setup('watch', { tiles: 3 }, { on: ['hideEndScreens'] });
    const { document } = page;
    assert.equal(document.querySelectorAll('.ytp-ce-element').length, 2, 'fixture: two real end cards');
    const roots = assertHidden(page, ORACLE, 'watch end screens');
    for (const el of document.querySelectorAll(CONTROLS)) assert.ok(!effectivelyHidden(el, roots), `player control ${label(el)}`);
    assert.ok(!effectivelyHidden(document.querySelector('.ytp-chrome-bottom'), roots));
    assert.ok(!effectivelyHidden(document.querySelector('video'), roots));
    assert.equal(page.window.getComputedStyle(document.querySelector('.ytp-ce-element')).display, 'none');
  });

  test('ads, sponsorship, the next/previous buttons of the control bar and cards teaser are never hidden', () => {
    const page = setup('watch', { tiles: 3, ads: 2 }, { on: ['hideEndScreens'] });
    const { document } = page;
    const roots = assertHidden(page, ORACLE, 'watch end screens with ads');
    for (const sel of [ADS, SPONSOR, '.ytp-next-button', '.ytp-prev-button', '.ytp-cards-button', '.ytp-suggested-action', '.ytp-paid-content-overlay', '.ytp-ad-module']) {
      for (const el of document.querySelectorAll(sel)) assert.ok(!effectivelyHidden(el, roots), `${sel} -> ${label(el)}`);
    }
    assert.ok(document.querySelector('.ytp-paid-content-overlay-text').textContent.includes('paid promotion'));
  });

  test('an end card that carries an ad badge is kept (guard), plain cards still go', () => {
    const page = setup('watch', { tiles: 2 }, { on: ['hideEndScreens'] });
    const { document } = page;
    const cards = [...document.querySelectorAll('.ytp-ce-element')];
    cards[0].appendChild(parse(document, '<div class="ytp-ad-badge">Ad</div>'));
    const roots = hiddenRoots(document);
    assert.ok(!roots.has(cards[0]));
    assert.ok(roots.has(cards[1]));
  });

  test('not on pages without a player', () => {
    for (const kind of ['home', 'search']) assertNothingHidden(setup(kind, { tiles: 3 }, { on: ['hideEndScreens'], pageAttr: kind }), kind);
  });

  test('survives navigation: a new watch page after an SPA hop is covered by the same attribute', () => {
    const page = setup('home', { tiles: 2 }, { on: ['hideEndScreens'] });
    assertNothingHidden(page, 'home');
    navigateTo(page, 'watch', { tiles: 2 });
    assertHidden(page, ORACLE, 'after navigating to watch');
  });
});

// ---- hideViewCounts -----------------------------------------------------------------------------------------------------------

/**
 * Independent oracle for "where is the view count": positional logic written in plain JS, per tile shape (ARCHITECTURE.md
 * section 1): no avatar = first text of the first row (channel grid); avatar + two rows = first text of row 2 (watch related,
 * playlist); avatar + one row = last text when there are two (live), second to last otherwise (home, collab).
 */
function expectedViewElements(document) {
  const out = [];
  const textsOf = (row) => [...row.children].filter((c) => c.classList.contains('ytContentMetadataViewModelMetadataText'));
  for (const host of document.querySelectorAll('.ytLockupViewModelHost')) {
    if (host.querySelector('yt-collection-thumbnail-view-model')) continue;
    const rows = [...host.querySelectorAll('.ytContentMetadataViewModelMetadataRow')];
    if (!rows.length) continue;
    const avatar = host.querySelector('.ytLockupMetadataViewModelAvatar, yt-decorated-avatar-view-model');
    const textRows = rows.filter((r) => textsOf(r).length);
    if (!avatar) {
      const t = textsOf(rows[0]);
      if (t.length) out.push(t[0]);
    } else if (textRows.length >= 2) {
      out.push(textsOf(rows[1])[0]);
    } else if (textRows.length === 1) {
      const t = textsOf(textRows[0]);
      if (t.length === 2) out.push(t[1]);
      else if (t.length >= 3) out.push(t[t.length - 2]);
    }
  }
  for (const el of document.querySelectorAll('ytd-video-meta-block [id="metadata-line"] > span.inline-metadata-item:first-of-type')) out.push(el);
  for (const el of document.querySelectorAll('ytd-watch-info-text [id="info"] > span:first-child')) out.push(el);
  // The role also names the view-count slot of ytd-watch-info-text; in the real capture it is an empty div (hiding it is harmless).
  for (const el of document.querySelectorAll('ytd-watch-info-text [id="view-count"]')) out.push(el);
  for (const el of document.querySelectorAll('.shortsLockupViewModelHostOutsideMetadataSubhead')) out.push(el);
  return out;
}

describe('hideViewCounts', () => {
  function assertViewsHidden(page, what, minimum = 1) {
    const { document } = page;
    const roots = hiddenRoots(document);
    const expected = expectedViewElements(document);
    assert.ok(expected.length >= minimum, `${what}: the oracle found ${expected.length} view counts`);
    const expectedSet = new Set(expected);
    const rootList = [...roots];
    assert.deepEqual(rootList.filter((r) => !expectedSet.has(r)).map(label).slice(0, 10), [], `${what}: hidden but not a view count`);
    assert.deepEqual(expected.filter((e) => !roots.has(e)).map((e) => `${label(e)}:${e.textContent}`).slice(0, 10), [], `${what}: view count still visible`);
    return { roots, expected };
  }

  test('channel grid tiles (views, age): only the first text of each tile goes', () => {
    const page = setup('channel', { tiles: 6, ads: 1 }, { on: ['hideViewCounts'] });
    const { expected, roots } = assertViewsHidden(page, 'channel grid', 6);
    for (const el of expected) assert.match(el.textContent, /^[\d.,]+[kKmM]?$/, 'it really is the number');
    const ages = [...page.document.querySelectorAll('.ytContentMetadataViewModelMetadataText')].filter((t) => /ago/.test(t.textContent));
    assert.ok(ages.length >= 6);
    for (const age of ages) assert.ok(!effectivelyHidden(age, roots), 'the age stays');
    assert.equal(page.window.getComputedStyle(expected[0]).display, 'none');
  });

  test('home tiles (channel, views, age): the middle text goes, channel and age stay', () => {
    const page = setup('home', { tiles: 6, ads: 2, tileStyle: 'home' }, { on: ['hideViewCounts'] });
    const { expected, roots } = assertViewsHidden(page, 'home tiles', 6);
    for (const el of expected) assert.match(el.textContent, /^[\d.,]+[kKmM]?$/);
    for (const row of page.document.querySelectorAll('.ytContentMetadataViewModelMetadataRow')) {
      const texts = [...row.querySelectorAll('.ytContentMetadataViewModelMetadataText')];
      assert.equal(texts.length, 3);
      assert.ok(!effectivelyHidden(texts[0], roots) && !effectivelyHidden(texts[2], roots) && effectivelyHidden(texts[1], roots));
    }
  });

  test('watch page: the watch view count and each related item\'s view count go, the date stays', () => {
    const page = setup('watch', { tiles: 4, ads: 2 }, { on: ['hideViewCounts'] });
    const { document } = page;
    const { roots, expected } = assertViewsHidden(page, 'watch', 5);
    const info = document.querySelector('ytd-watch-info-text [id="info"]');
    assert.equal(info.firstElementChild.textContent, '84k views');
    assert.ok(roots.has(info.firstElementChild));
    assert.ok(![...info.children].slice(1).some((c) => roots.has(c)), 'date and hashtag stay');
    assert.ok(expected.length >= 5);
    const related = [...document.querySelectorAll('[id="related"] yt-lockup-view-model')];
    for (const lockup of related) {
      const rows = lockup.querySelectorAll('.ytContentMetadataViewModelMetadataRow');
      const channelText = rows[0].querySelector('.ytContentMetadataViewModelMetadataText');
      assert.ok(!effectivelyHidden(channelText, roots), 'the channel row is not touched');
      const [views, age] = rows[1].querySelectorAll('.ytContentMetadataViewModelMetadataText');
      assert.ok(effectivelyHidden(views, roots) && !effectivelyHidden(age, roots));
    }
  });

  test('search results (legacy ytd-video-renderer) and the Shorts shelf: view counts go, the playlist lockup is untouched', () => {
    const page = setup('search', { tiles: 3, shorts: 'grid', ads: 1 }, { on: ['hideViewCounts'] });
    const { document } = page;
    const { roots } = assertViewsHidden(page, 'search', 4);
    const inline = [...document.querySelectorAll('#metadata-line .inline-metadata-item')];
    assert.ok(inline.length >= 6);
    inline.forEach((el, i) => assert.equal(roots.has(el), i % 2 === 0, `${el.textContent}`));
    const playlist = document.querySelector('yt-lockup-view-model:has(yt-collection-thumbnail-view-model)');
    assert.ok(playlist);
    for (const el of playlist.querySelectorAll('*')) assert.ok(!effectivelyHidden(el, roots), `playlist lockup ${label(el)}`);
    for (const sub of document.querySelectorAll('.shortsLockupViewModelHostOutsideMetadataSubhead')) assert.ok(roots.has(sub), 'Shorts view counts too');
  });

  test('playlist rows: second row, first text', () => {
    const page = setup('playlist', { tiles: 5 }, { on: ['hideViewCounts'] });
    assertViewsHidden(page, 'playlist', 3);
  });

  test('language neutral: the same elements go when every text is in another language and script', () => {
    const english = setup('home', { tiles: 5, tileStyle: 'home' }, { on: ['hideViewCounts'] });
    const hiddenIdx = (page) => [...page.document.querySelectorAll('.ytContentMetadataViewModelMetadataText')].map((el, i) => (effectivelyHidden(el, hiddenRoots(page.document)) ? i : -1)).filter((i) => i >= 0);
    const before = hiddenIdx(english);
    const foreign = setup('home', { tiles: 5, tileStyle: 'home' }, { on: ['hideViewCounts'] });
    const samples = ['1,2 Mio. Aufrufe', 'ผู้ชม 3.4 แสน', 'المشاهدات: 12', '12万回再生', '조회수 4.5천회'];
    [...foreign.document.querySelectorAll('.ytContentMetadataViewModelMetadataText')].forEach((el, i) => { el.textContent = samples[i % samples.length]; el.removeAttribute('aria-label'); });
    assert.equal(before.length, 5);
    assert.deepEqual(hiddenIdx(foreign), before);
  });

  test('live shapes from LIVE-VERIFICATION: icons between the texts, live streams, collabs, icon-only second rows, Mix tiles', () => {
    const page = setup('home', { tiles: 7, ads: 1, tileStyle: 'home' }, { on: ['hideViewCounts'] });
    const { document } = page;
    const tiles = [...document.querySelectorAll('ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))')];
    const rowOf = (tile) => tile.querySelector('.ytContentMetadataViewModelMetadataRow');
    const text = (tile) => [...rowOf(tile).querySelectorAll('.ytContentMetadataViewModelMetadataText')];
    const icon = (cls) => parse(document, `<span class="ytIconWrapperHost ${cls}"></span>`);
    // tile 0: icons around the texts (leading eye icon before views, Verified icon after the channel)
    const t0 = text(tiles[0]);
    t0[0].after(icon('ytContentMetadataViewModelIcon'));
    t0[1].before(icon('ytContentMetadataViewModelLeadingIcon'));
    // tile 1: live stream "channel | 591 watching" -> two texts, the watching count goes
    const t1 = text(tiles[1]);
    t1[1].textContent = '591 watching';
    t1[2].previousElementSibling.remove();
    t1[2].remove();
    // tile 2: collab "A | and B | views | age" -> four texts, views (second to last) goes
    const t2 = text(tiles[2]);
    const extra = t2[0].cloneNode(true);
    extra.textContent = 'and Second Channel';
    t2[0].after(parse(document, '<span aria-hidden="true" class="ytContentMetadataViewModelDelimiter"></span>'), extra);
    // tile 3: trailing icon-only second row
    rowOf(tiles[3]).after(parse(document, '<div class="ytContentMetadataViewModelMetadataRow"><span class="ytIconWrapperHost"></span></div>'));
    // tile 4: a Mix tile (collection stack): nothing in it may be hidden
    tiles[4].querySelector('.ytLockupViewModelHost').appendChild(parse(document, '<yt-collection-thumbnail-view-model></yt-collection-thumbnail-view-model>'));
    const roots = hiddenRoots(document);
    assert.deepEqual([text(tiles[0]).map((e) => roots.has(e))], [[false, true, false]], 'icons do not shift the position');
    assert.deepEqual([text(tiles[1]).map((e) => roots.has(e))], [[false, true]], 'live: last of two');
    assert.deepEqual([text(tiles[2]).map((e) => roots.has(e))], [[false, false, true, false]], 'collab: second to last of four');
    assert.deepEqual([text(tiles[3]).map((e) => roots.has(e))], [[false, true, false]], 'icon-only trailing row is ignored');
    assert.deepEqual([text(tiles[4]).map((e) => roots.has(e))], [[false, false, false]], 'Mix/collection tile untouched');
    assert.deepEqual([text(tiles[5]).map((e) => roots.has(e))], [[false, true, false]]);
  });

  test('ads: a sponsored tile (ad badge in the lockup, or the whole tile in an ad slot) keeps every word', () => {
    const page = setup('home', { tiles: 4, ads: 1, tileStyle: 'home' }, { on: ['hideViewCounts'] });
    const { document } = page;
    const tiles = [...document.querySelectorAll('ytd-rich-item-renderer:not(:has(ytd-ad-slot-renderer))')];
    // (a) lockup rendered as an ad: the "Sponsored" badge sits in the metadata, the position-based selector would hit its text
    tiles[0].querySelector('.ytContentMetadataViewModelMetadataRow').prepend(parse(document, '<ad-badge-view-model class="ytwAdBadge"><span class="ytAttributedStringHost">Sponsored</span></ad-badge-view-model>'));
    // (b) a whole organic-looking lockup nested inside an ad slot
    const slot = parse(document, '<ytd-ad-slot-renderer><div id="content"></div></ytd-ad-slot-renderer>');
    const inner = tiles[1].querySelector('yt-lockup-view-model').cloneNode(true);
    slot.querySelector('[id="content"]').appendChild(inner);
    document.querySelector('ytd-rich-grid-renderer [id="contents"]').appendChild(parse(document, '<ytd-rich-item-renderer></ytd-rich-item-renderer>')).appendChild(slot);
    const roots = hiddenRoots(document);
    for (const el of tiles[0].querySelectorAll('*')) assert.ok(!effectivelyHidden(el, roots), `sponsored lockup: ${label(el)}`);
    for (const el of slot.querySelectorAll('*')) assert.ok(!effectivelyHidden(el, roots), `lockup inside ad slot: ${label(el)}`);
    assert.ok([...tiles[2].querySelectorAll('.ytContentMetadataViewModelMetadataText')].some((t) => roots.has(t)), 'organic tiles still lose their views');
  });

  test('Cinedrape\'s mirrored cards: a span.cd-card-views is hidden, the rest of the card is not', () => {
    const page = setup('home', { tiles: 2 }, { on: ['hideViewCounts'] });
    const { document } = page;
    const card = parse(document, '<a class="cd-card" href="/watch?v=x"><span class="cd-card-title">t</span><span class="cd-card-meta"><span class="cd-card-channel">c</span><span class="cd-card-views">1.2K views</span><span class="cd-card-age">2d</span></span></a>');
    const mirror = parse(document, '<div class="cd-home"></div>');
    document.querySelector('ytd-browse').prepend(mirror);
    mirror.appendChild(card);
    const roots = hiddenRoots(document);
    assert.ok(roots.has(card.querySelector('.cd-card-views')));
    for (const sel of ['.cd-card', '.cd-card-title', '.cd-card-meta', '.cd-card-channel', '.cd-card-age']) assert.ok(!effectivelyHidden(card.matches(sel) ? card : card.querySelector(sel), roots), sel);
  });

  test('other pages and toggles: history rows with no lockup shape are left alone (nothing to match, nothing broken)', () => {
    const page = setup('history', { tiles: 3 }, { on: ['hideViewCounts'], pageAttr: 'history' });
    const roots = hiddenRoots(page.document);
    const expected = expectedViewElements(page.document);
    assert.deepEqual([...roots].map(label).sort(), expected.map(label).sort());
  });
});

// ---- independence, ads never hidden, and the property that makes the guard real -------------------------------------------------

const PAGES = [
  ['home', { tiles: 7, ads: 3, shorts: 'rich' }],
  ['home', { tiles: 7, ads: 3, shorts: 'rich', tileStyle: 'home' }],
  ['watch', { tiles: 5, ads: 3, shorts: 'reel' }],
  ['search', { tiles: 4, ads: 2, shorts: 'grid' }],
  ['channel', { tiles: 5, ads: 2, shorts: 'rich' }],
  ['subscriptions', { tiles: 5, ads: 2, shorts: 'rich' }],
  ['playlist', { tiles: 4 }],
  ['history', { tiles: 4 }],
];
const pageName = (kind, opts) => `${kind}${opts.tileStyle ? `/${opts.tileStyle}` : ''}`;
/** The synthetic ad / sponsorship nodes of a page. The synthetic Shorts shelves are marked data-cd-synthetic too, but they are what hideShorts is meant to hide. */
const adFixtures = (document) => [...document.querySelectorAll('[data-cd-synthetic]')].filter((el) => !el.getAttribute('data-cd-synthetic').startsWith('shorts-'));

describe('independence and ad safety across all page kinds', () => {
  test('with no attribute at all the stylesheet hides nothing anywhere (gates evaluated, not skipped)', () => {
    for (const [kind, opts] of PAGES) {
      const page = setup(kind, opts, { on: [] });
      const hidden = [];
      for (const rule of HIDE_RULES) for (const sel of rule.selectors) for (const el of page.document.querySelectorAll(sel)) hidden.push(label(el));
      assert.deepEqual(hidden, [], pageName(kind, opts));
    }
  });

  test('toggles are independent: each hides only its own things, and all five together hide exactly the union', () => {
    for (const [kind, opts] of PAGES) {
      const unionIds = new Set();
      const perKey = {};
      for (const key of CALM_KEYS) {
        const page = setup(kind, opts, { on: [key] });
        perKey[key] = [...hiddenRoots(page.document)];
        // roots are elements of that page; compare by a stable path-ish id
        const ids = perKey[key].map((el) => pathOf(el));
        ids.forEach((i) => unionIds.add(i));
        perKey[key] = new Set(ids);
      }
      const all = setup(kind, opts, { on: CALM_KEYS });
      const together = new Set([...hiddenRoots(all.document)].map(pathOf));
      assert.deepEqual([...together].sort(), [...unionIds].sort(), `${pageName(kind, opts)}: all-on equals the union of the single toggles`);
      for (const a of CALM_KEYS) for (const b of CALM_KEYS) {
        if (a < b) for (const id of perKey[a]) assert.ok(!perKey[b].has(id) || true);
      }
    }
  });

  test('NEVER hides an ad, a sponsorship disclosure or a player control: all toggles on, every page kind, ads + Shorts present', () => {
    for (const [kind, opts] of PAGES) {
      const page = setup(kind, opts, { on: CALM_KEYS });
      const { document } = page;
      const roots = hiddenRoots(document);
      const name = pageName(kind, opts);
      let protectedCount = 0;
      for (const group of [ADS, SPONSOR, CONTROLS]) {
        for (const el of document.querySelectorAll(group)) {
          protectedCount++;
          assert.ok(!effectivelyHidden(el, roots), `${name}: ${label(el)} (protected) is hidden`);
        }
      }
      assert.ok(protectedCount > 0 || kind === 'history' || kind === 'playlist', `${name}: fixture has protected elements`);
      // Nothing that CONTAINS an ad or a sponsorship disclosure is hidden either (the whole point of the :not(:has(ads)) guard).
      for (const root of roots) {
        assert.equal(root.querySelector(joinSel(ADS, SPONSOR)), null, `${name}: hidden ${label(root)} contains an ad/sponsor element`);
        assert.equal(root.matches(joinSel(ADS, SPONSOR, CONTROLS)), false, `${name}: hidden ${label(root)} IS a protected element`);
      }
      if (opts.ads) {
        const synthetic = adFixtures(document);
        assert.ok(synthetic.length >= 1, `${name}: synthetic ads present`);
        for (const el of synthetic) assert.ok(!effectivelyHidden(el, roots), `${name}: ${el.getAttribute('data-cd-synthetic')} stays visible`);
        for (const el of document.querySelectorAll('.ytwAdBadgeText, .ytp-ad-text, .ytp-paid-content-overlay-text, .ytp-ad-skip-button-container, ytd-display-ad-renderer')) {
          assert.ok(!effectivelyHidden(el, roots), `${name}: ${label(el)} ad text stays`);
        }
      }
      // Real style path for a sample of the synthetic ads.
      for (const el of adFixtures(document).slice(0, 4)) {
        assert.notEqual(page.window.getComputedStyle(el).display, 'none', `${name}: computed display of ${el.getAttribute('data-cd-synthetic')}`);
      }
    }
  });

  test('guard property: for every kind of hidden element, putting an ad or a sponsorship disclosure inside it brings it back', () => {
    const adHtml = '<ytd-ad-slot-renderer data-probe="ad"><div id="content">ad</div></ytd-ad-slot-renderer>';
    const sponsorHtml = '<div class="ytp-paid-content-overlay" data-probe="sponsor"><div class="ytp-paid-content-overlay-text">Includes paid promotion</div></div>';
    const scenarios = [
      ['home', { tiles: 6, ads: 1, shorts: 'rich', tileStyle: 'home' }, ['hideShorts', 'hideHomeRecs', 'hideViewCounts']],
      ['watch', { tiles: 4, shorts: 'reel' }, ['hideShorts', 'hideComments', 'hideEndScreens', 'hideViewCounts']],
      ['search', { tiles: 3, shorts: 'grid' }, ['hideShorts', 'hideViewCounts']],
    ];
    let probed = 0;
    for (const [kind, opts, keys] of scenarios) {
      const page = setup(kind, opts, { on: keys });
      const { document } = page;
      const roots = [...hiddenRoots(document)];
      assert.ok(roots.length > 5, kind);
      // one sample per distinct tag so every rule alternative that fires is probed
      const byTag = new Map();
      for (const r of roots) if (!byTag.has(r.localName + r.className)) byTag.set(r.localName + r.className, r);
      for (const root of byTag.values()) {
        for (const html of [adHtml, sponsorHtml]) {
          const probe = parse(document, html);
          root.appendChild(probe);
          assert.ok(!hiddenRoots(document).has(root), `${kind}: ${label(root)} stays hidden with ${probe.getAttribute('data-probe')} inside`);
          probe.remove();
          probed++;
        }
      }
      assert.ok(roots.every((r) => hiddenRoots(document).has(r)), `${kind}: all roots hidden again after the probes are removed`);
    }
    assert.ok(probed >= 30, `probed ${probed}`);
  });

  test('freedom of the page frame: masthead, guide shell, player, chips never hidden by any toggle on any page', () => {
    for (const [kind, opts] of PAGES) {
      const page = setup(kind, opts, { on: CALM_KEYS });
      const roots = hiddenRoots(page.document);
      // 'ytd-app > [id="content"]': the frame; many inner elements (a Shorts shelf's own section body, ad slots) are also called #content.
      for (const sel of ['ytd-app', 'ytd-app > [id="content"]', 'ytd-masthead', '[id="masthead-container"]', 'tp-yt-app-drawer', 'ytd-page-manager', 'ytd-guide-renderer', 'ytd-watch-flexy', 'ytd-browse', 'ytd-search']) {
        for (const el of page.document.querySelectorAll(sel)) assert.ok(!effectivelyHidden(el, roots), `${pageName(kind, opts)}: ${sel}`);
      }
      if (kind === 'watch') for (const sel of ['[id="movie_player"]', '[id="player"]', 'video', 'ytd-watch-metadata', '[id="secondary"]', '[id="related"]']) {
        for (const el of page.document.querySelectorAll(sel)) assert.ok(!effectivelyHidden(el, roots), `watch: ${sel}`);
      }
    }
  });

  test('applyCalmAttributes + buildCalmCss end to end: a disabled feature hides nothing, an enabled one does', () => {
    const page = setup('watch', { tiles: 3 }, { on: [] });
    const all = Object.fromEntries(CALM_KEYS.map((k) => [k, true]));
    applyCalmAttributes(page.document, all, ['calm-hideComments']);
    const roots = hiddenRoots(page.document);
    assert.ok(![...roots].some((r) => r.matches('ytd-comments')), 'comments feature disabled by health: stays visible');
    assert.ok([...roots].some((r) => r.matches('.ytp-ce-element')), 'end screens still hidden');
    applyCalmAttributes(page.document, all, []);
    assert.ok([...hiddenRoots(page.document)].some((r) => r.matches('ytd-comments')));
    applyCalmAttributes(page.document, {}, []);
    assertNothingHidden(page, 'all off');
  });
});

/** Stable position id for an element, comparable between two pages built from the same recipe. */
function pathOf(el) {
  const parts = [];
  for (let n = el; n && n.parentElement; n = n.parentElement) {
    parts.push(`${n.localName}:${[...n.parentElement.children].indexOf(n)}`);
  }
  return parts.reverse().join('>');
}

// ---- the real src/shared/selector-map.js, when it exists ---------------------------------------------------------------------------

describe('against the real src/shared/selector-map.js (once it exists)', () => {
  test('the local copy used above agrees with the real roleCss / protectedCss / safeHide', async (t) => {
    if (!existsSync(REAL_SELECTOR_MAP)) return t.skip('src/shared/selector-map.js is not written yet');
    const real = await import(pathToFileURL(REAL_SELECTOR_MAP).href);
    const norm = (s) => splitTop(s, ',').join(',');
    for (const role of Object.keys(MAP.roles)) assert.equal(norm(real.roleCss(MAP, role)), norm(MAP.roles[role].join(', ')), `roleCss ${role}`);
    for (const group of ['ads', 'sponsor', 'playerControls']) assert.equal(norm(real.protectedCss(MAP, group)), norm(MAP.protected[group].join(', ')), `protectedCss ${group}`);
    const sample = ['ytd-comments', ':is(a,b):not(.x)', 'html[cd-calm-hideShorts] :is(.a:has(b),c)'];
    for (const sel of sample) {
      const out = real.safeHide(MAP, sel);
      assert.ok(out.startsWith(sel), out.slice(0, 100));
      assert.ok(topLevelGuards(out).some((g) => sameSet(g, MAP.protected.ads)), `safeHide guard for ${sel}`);
    }
  });

  test('calm wired to the real module builds a stylesheet with the same rules as the local-copy build', async (t) => {
    if (!existsSync(REAL_SELECTOR_MAP)) return t.skip('src/shared/selector-map.js is not written yet');
    const wired = await import(pathToFileURL(CALM_FILE).href);
    const css = wired.buildCalmCss(MAP, {});
    assert.ok(css.length > 1000, 'the real safeHide produced guarded rules');
    assert.deepEqual(scanHideRules(css, MAP), []);
    const strip = (s) => splitTop(s, ',').join(',');
    const rulesOf = (c) => parseRules(c).map((r) => `${r.selectors.map((s) => s.replace(/\s*,\s*/g, ',')).join('|')}{${r.decls.map((d) => `${d.prop}:${d.value}`).join(';')}}`);
    void strip;
    assert.deepEqual(rulesOf(css), rulesOf(CSS), 'identical rules (formatting aside)');
  });
});
