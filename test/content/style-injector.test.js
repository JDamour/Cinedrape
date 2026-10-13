// Style injection (one <style>, document_start, CSP fallback) and the first-paint cache.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createStyleInjector, sanitizePaintAttrs, sanitizePaintVerdict, isUnsafeCachedCss, FIRST_PAINT_MAX_BYTES } from '../../src/content/style-injector.js';
import { FIRST_PAINT_LS_KEY, STYLE_ID } from '../../src/shared/constants.js';
import { composeStylesheet } from '../../src/content/stylesheet.js';
import { computeEffectiveConfig } from '../../src/shared/entitlements.js';
import { parseEnvelopePayload } from '../../src/shared/selector-map.js';
import { THEMES } from '../../src/themes/index.js';
import { readFileSync } from 'node:fs';

const CSS = 'html[cd-theme] body { color: red }\nhtml[cd-theme] a { color: blue }';

function make({ bare = false } = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><p>x</p></body></html>', { url: 'https://www.youtube.com/' });
  const { window } = dom;
  if (bare) window.document.documentElement.replaceChildren(); // document_start: <html> and nothing else
  return { window, document: window.document, injector: createStyleInjector({ doc: window.document, win: window }), close: () => window.close() };
}
const styles = (doc) => [...doc.querySelectorAll(`style#${STYLE_ID}`)];

describe('apply / remove', () => {
  test('one <style id> under <html> with real rules; updates replace it in place; remove() and empty css take it out', () => {
    const t = make();
    try {
      assert.equal(t.injector.apply(CSS), 'style');
      const [style] = styles(t.document);
      assert.equal(styles(t.document).length, 1);
      assert.equal(style.parentNode, t.document.documentElement);
      assert.equal(style.sheet.cssRules.length, 2);

      const watcher = new t.window.MutationObserver(() => {});
      watcher.observe(t.document.documentElement, { childList: true });
      assert.equal(t.injector.apply('html[cd-theme] b { color: green }'), 'style');
      assert.deepEqual(watcher.takeRecords(), [], 'the element is not removed and re-added');
      assert.equal(styles(t.document)[0], style);
      assert.equal(style.sheet.cssRules.length, 1);

      t.injector.remove();
      assert.equal(styles(t.document).length, 0);
      assert.equal(t.injector.mode(), 'none');
      t.injector.apply(CSS);
      assert.equal(styles(t.document).length, 1);
      assert.equal(t.injector.apply(''), 'none');
      assert.equal(styles(t.document).length, 0);
    } finally { t.close(); }
  });

  test('works at document_start, when only documentElement exists', () => {
    const t = make({ bare: true });
    try {
      assert.equal(t.document.head, null);
      assert.equal(t.injector.apply(CSS), 'style');
      assert.equal(t.document.documentElement.children.length, 1);
      assert.equal(styles(t.document)[0].parentNode, t.document.documentElement);
      assert.equal(styles(t.document)[0].sheet.cssRules.length, 2);
    } finally { t.close(); }
  });

  test('takes over a leftover <style> from a dead content script instead of duplicating it', () => {
    const t = make();
    try {
      t.document.documentElement.insertAdjacentHTML('beforeend', `<style id="${STYLE_ID}">old{}</style>`);
      t.injector.apply(CSS);
      assert.equal(styles(t.document).length, 1);
      assert.equal(styles(t.document)[0].textContent, CSS);
    } finally { t.close(); }
  });

  test('CSP fallback: a <style> that yields no rules moves the CSS into an adopted stylesheet and the <style> goes', () => {
    const t = make();
    try {
      class FakeSheet {
        constructor() { this.cssRules = []; this.text = ''; }
        replaceSync(text) { this.text = text; this.cssRules = text.split('}').filter((s) => s.trim()); }
      }
      t.window.CSSStyleSheet = FakeSheet;
      t.document.adoptedStyleSheets = [];
      Object.defineProperty(t.window.HTMLStyleElement.prototype, 'sheet', { configurable: true, get: () => ({ cssRules: { length: 0 } }) });

      assert.equal(t.injector.apply(CSS), 'adopted');
      assert.equal(styles(t.document).length, 0);
      assert.equal(t.document.adoptedStyleSheets.length, 1);
      assert.equal(t.document.adoptedStyleSheets[0].text, CSS);

      assert.equal(t.injector.apply('html[cd-theme] b { color: green }'), 'adopted');
      assert.equal(t.document.adoptedStyleSheets.length, 1, 'replaced, not stacked');
      assert.equal(t.document.adoptedStyleSheets[0].text, 'html[cd-theme] b { color: green }');
      assert.equal(styles(t.document).length, 0);

      t.injector.remove();
      assert.equal(t.document.adoptedStyleSheets.length, 0);
    } finally { t.close(); }
  });

  test('with no way to verify or adopt, the <style> is kept (best effort) and nothing throws', () => {
    const t = make();
    try {
      Object.defineProperty(t.window.HTMLStyleElement.prototype, 'sheet', { configurable: true, get: () => null });
      assert.equal(t.injector.apply(CSS), 'style');
      assert.equal(styles(t.document).length, 1);
    } finally { t.close(); }
  });
});

describe('first-paint cache', () => {
  const put = (t, value) => t.window.localStorage.setItem(FIRST_PAINT_LS_KEY, typeof value === 'string' ? value : JSON.stringify(value));

  test('write then read round-trips {key, css}; clear removes it', () => {
    const t = make();
    try {
      assert.equal(t.injector.readFirstPaint(), null);
      assert.equal(t.injector.writeFirstPaint('cinema:abc', CSS), true);
      assert.deepEqual(JSON.parse(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY)), { v: 1, key: 'cinema:abc', css: CSS });
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS });
      t.injector.clearFirstPaint();
      assert.equal(t.injector.readFirstPaint(), null);
    } finally { t.close(); }
  });

  test('malformed, wrong-version, empty and oversized entries are ignored', () => {
    const t = make();
    try {
      const bad = ['not json', '{"v":2,"key":"k","css":"a{}"}', '{"v":1,"key":"","css":"a{}"}', '{"v":1,"key":"k","css":""}',
        '{"v":1,"key":"k"}', '[]', 'null', '"x"', JSON.stringify({ v: 1, key: 'k', css: 'a{}'.repeat(FIRST_PAINT_MAX_BYTES) })];
      for (const raw of bad) {
        put(t, raw);
        assert.equal(t.injector.readFirstPaint(), null, raw.slice(0, 40));
      }
      assert.equal(t.injector.writeFirstPaint('cinema:big', 'a{}'.repeat(FIRST_PAINT_MAX_BYTES)), false);
      assert.equal(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY), null, 'an oversized write also drops the stale entry');
    } finally { t.close(); }
  });

  test('css that the validator would refuse is not trusted: imports, remote url(), script hooks', () => {
    const t = make();
    try {
      for (const css of ['@import "https://evil.example/a.css";', 'a{background:url(https://evil.example/x.png)}', 'a{width:expression(alert(1))}',
        'a{-moz-binding:url(x)}', '</style><script>1</script>']) {
        put(t, { v: 1, key: 'cinema:x', css });
        assert.equal(t.injector.readFirstPaint(), null, css);
      }
      put(t, { v: 1, key: 'cinema:x', css: 'a{background:url(data:image/png;base64,AAAA)}' });
      assert.notEqual(t.injector.readFirstPaint(), null, 'inline images are fine');
    } finally { t.close(); }
  });

  test('escapes, image-set() and at-rules other than @media/@keyframes/@supports are refused; the engine\'s own css (with its \\2022 bullet) is not', () => {
    const t = make();
    const BS = String.fromCharCode(92);
    try {
      const hostile = [
        `@${BS}69mport "https://evil.example/a.css";`,                      // an escaped @import
        `a{background:u${BS}72l(https://evil.example/p.png)}`,                // an escaped url(
        'a{background:image-set("https://evil.example/p.png" 1x)}',
        'a{background:-webkit-image-set(url(data:image/png;base64,AAAA) 1x)}',
        '@property --x{syntax:"*";inherits:false}',
        '@container (min-width:1px){a{color:red}}',
        '@layer x{a{color:red}}',
        'a{content:"unterminated}',
        `a{color:r${BS}ed}`,
      ];
      for (const css of hostile) {
        put(t, { v: 1, key: 'cinema:x', css });
        assert.equal(t.injector.readFirstPaint(), null, css);
      }
      const fine = [
        'html[cd-theme]{--cd-bg:#0f0f0f}@media (max-width:700px){a{color:red}}',
        `.cd-card-meta > span:not(:first-child)::before{content:"${BS}2022";margin:0 .4em}`,
        '@keyframes cd-pulse{from{opacity:1}to{opacity:1}}',
        '@supports (display:grid){a{display:grid}}',
      ];
      for (const css of fine) {
        put(t, { v: 1, key: 'cinema:x', css });
        assert.notEqual(t.injector.readFirstPaint(), null, css);
      }
      assert.equal(isUnsafeCachedCss(5), true);
    } finally { t.close(); }
  });

  test('a forged entry that hides an ad slot (a rule with a hiding declaration and no ad guard) is refused; guarded hides and keyframes are fine', () => {
    const t = make();
    try {
      const guard = ':not(:has(ytd-ad-slot-renderer, #masthead-ad))';
      const forged = [
        'ytd-ad-slot-renderer,#masthead-ad,ytd-in-feed-ad-layout-renderer{display:none!important}',
        '@media (min-width:1px){#masthead-ad{visibility:hidden}}',
        'ytd-rich-item-renderer{height:0;overflow:hidden}',
        '.a{opacity:0}',
      ];
      for (const css of forged) {
        put(t, { v: 1, key: 'cinema:x', css, attrs: { 'cd-calm-hidehomerecs': '' } });
        assert.equal(t.injector.readFirstPaint(), null, css);
      }
      const fine = [
        `html[cd-calm-hideshorts] ytd-rich-shelf-renderer${guard}{display:none !important}`,
        `@media (max-width:700px){html[cd-calm-hidecomments] #comments${guard}{display:none !important}}`,
        '@keyframes cd-fade{from{opacity:0}to{opacity:1}}',
        'a{opacity:.5;height:10px;display:block}',
      ];
      for (const css of fine) {
        put(t, { v: 1, key: 'cinema:x', css });
        assert.notEqual(t.injector.readFirstPaint(), null, css);
      }
    } finally { t.close(); }
  });

  const ATTRS = { 'cd-home': 'hero-rows', 'cd-watch': 'focus', 'cd-density': '4', 'cd-motion': 'on', 'cd-calm-hideshorts': '', 'cd-calm-hideviewcounts': '' };

  test('the html attributes the css depends on travel with it: written beside {key, css}, read back, and absent when none were given', () => {
    const t = make();
    try {
      assert.equal(t.injector.writeFirstPaint('cinema:abc', CSS, ATTRS), true);
      assert.deepEqual(JSON.parse(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY)), { v: 1, key: 'cinema:abc', css: CSS, attrs: ATTRS });
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS, attrs: ATTRS });
      assert.equal(t.injector.writeFirstPaint('cinema:abc', CSS, {}), true);
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS, attrs: {} }, 'an explicit empty set is a valid set');
      assert.equal(t.injector.writeFirstPaint('cinema:abc', CSS), true);
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS }, 'old entries without attrs still read');
    } finally { t.close(); }
  });

  test('attrs are validated strictly: one unknown name or value rejects the whole set, but the css of the entry is still judged on its own', () => {
    const t = make();
    try {
      const bad = [
        { 'cd-home': 'columns' }, { 'cd-watch': 'wide' }, { 'cd-density': '0' }, { 'cd-density': '6' }, { 'cd-density': '3.5' }, { 'cd-density': 3 },
        { 'cd-motion': 'auto' }, { 'cd-motion': '' }, { 'cd-calm-hideshorts': '1' }, { 'cd-calm-hideads': '' }, { 'cd-calm-hideShorts': '' },
        { 'cd-off-theme': '' }, { 'cd-theme': 'cinema' }, { 'cd-page': 'home' }, { style: 'display:none' }, { onclick: 'x()' }, { __proto__: null, 'cd-home': 'grid', evil: '1' },
        { 'cd-home': 'grid', 'cd-evil': '' },
      ];
      for (const attrs of bad) {
        put(t, { v: 1, key: 'cinema:x', css: CSS, attrs: JSON.parse(JSON.stringify(attrs)) });
        assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:x', css: CSS }, JSON.stringify(attrs));
        assert.equal(t.injector.writeFirstPaint('cinema:x', CSS, attrs), true, 'a bad set is dropped on write, the css is still cached');
        assert.deepEqual(JSON.parse(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY)), { v: 1, key: 'cinema:x', css: CSS });
      }
      for (const attrs of [null, 7, 'cd-home=grid', ['cd-home'], true]) {
        put(t, { v: 1, key: 'cinema:x', css: CSS, attrs });
        assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:x', css: CSS }, String(attrs));
      }
      put(t, { v: 1, key: 'cinema:x', css: '@import "https://evil.example/a.css";', attrs: ATTRS });
      assert.equal(t.injector.readFirstPaint(), null, 'good attrs do not rescue unsafe css');
    } finally { t.close(); }
  });

  test('sanitizePaintAttrs: every allowed value of every attribute passes, and nothing inherited or prototype-shaped does', () => {
    for (const [name, values] of Object.entries({ 'cd-home': ['grid', 'rows', 'hero-rows'], 'cd-watch': ['default', 'cinema', 'focus'], 'cd-density': ['1', '2', '3', '4', '5'], 'cd-motion': ['on', 'off'], 'cd-textscale': ['0.9', '1', '1.1', '1.25', '1.5'] })) {
      for (const v of values) assert.deepEqual(sanitizePaintAttrs({ [name]: v }), { [name]: v });
    }
    for (const key of ['hideshorts', 'hidehomerecs', 'hidecomments', 'hideendscreens', 'hideviewcounts', 'hidelive']) assert.deepEqual(sanitizePaintAttrs({ [`cd-calm-${key}`]: '' }), { [`cd-calm-${key}`]: '' });
    for (const bad of ['0.8', '2', 'foo', 1, null]) assert.equal(sanitizePaintAttrs({ 'cd-textscale': bad }), null);
    assert.equal(sanitizePaintAttrs({ constructor: 'x' }), null);
    assert.equal(sanitizePaintAttrs(JSON.parse('{"__proto__": {"cd-home": "grid"}}')), null);
    assert.equal(sanitizePaintAttrs(undefined), null);
    assert.equal(sanitizePaintAttrs(Object.create({ 'cd-home': 'grid' })).constructor, Object, 'inherited keys are not read: an empty set results');
  });

  const VERDICT = {
    mapVersion: '2026.10.13.4', themeId: 'cinema', broken: ['layout-home'], pages: { home: ['layout-home'] }, unreadable: false, at: 12345678,
  };

  test('health verdict travels beside {key, css, attrs}: written, read back, updated, cleared, and absent when none was given', () => {
    const t = make();
    try {
      assert.equal(t.injector.writeFirstPaint('cinema:abc', CSS, ATTRS, VERDICT), true);
      assert.deepEqual(JSON.parse(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY)), { v: 1, key: 'cinema:abc', css: CSS, attrs: ATTRS, verdict: VERDICT });
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS, attrs: ATTRS, verdict: VERDICT });

      // Updating verdict on an existing entry
      const nextVerdict = { ...VERDICT, broken: ['calm-hideShorts', 'layout-home'], pages: { home: ['calm-hideShorts', 'layout-home'] } };
      assert.equal(t.injector.writeFirstPaintVerdict(nextVerdict), true);
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS, attrs: ATTRS, verdict: nextVerdict });

      // Clearing verdict on a healthy settle
      assert.equal(t.injector.writeFirstPaintVerdict(null), true);
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:abc', css: CSS, attrs: ATTRS }, 'verdict removed from entry');
      assert.equal(JSON.parse(t.window.localStorage.getItem(FIRST_PAINT_LS_KEY)).verdict, undefined);

      // Clearing when no entry exists returns false
      t.injector.clearFirstPaint();
      assert.equal(t.injector.writeFirstPaintVerdict(VERDICT), false);
    } finally { t.close(); }
  });

  test('sanitizePaintVerdict: valid shape passes; invalid or tampered verdicts are rejected field by field', () => {
    assert.deepEqual(sanitizePaintVerdict(VERDICT), VERDICT);
    assert.equal(sanitizePaintVerdict(null), null);
    assert.equal(sanitizePaintVerdict('junk'), null);
    assert.equal(sanitizePaintVerdict([]), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, mapVersion: '' }), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, mapVersion: 'a'.repeat(45) }), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, themeId: 'unknown-theme' }), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, at: -1 }), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, at: Infinity }), null);
    assert.equal(sanitizePaintVerdict({ ...VERDICT, at: 'now' }), null);

    // Bad features in pages or broken are dropped, valid ones kept
    const dirty = { ...VERDICT, broken: ['layout-home', 'evil-feature'], pages: { home: ['layout-home', 'evil-feature'], evilPage: ['layout-home'] } };
    const cleaned = sanitizePaintVerdict(dirty);
    assert.deepEqual(cleaned.broken, ['layout-home']);
    assert.deepEqual(cleaned.pages, { home: ['layout-home'] });
    assert.equal(cleaned.pages.evilPage, undefined);

    // Prototype pollution is rejected
    assert.equal(sanitizePaintVerdict(JSON.parse('{"__proto__": {"mapVersion": "1"}}')), null);
  });

  test('a tampered verdict in storage does not spoil the cached css or attrs', () => {
    const t = make();
    try {
      put(t, { v: 1, key: 'cinema:x', css: CSS, attrs: ATTRS, verdict: 'tampered-payload' });
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:x', css: CSS, attrs: ATTRS }, 'css and attrs survive bad verdict');

      put(t, { v: 1, key: 'cinema:x', css: CSS, attrs: ATTRS, verdict: { mapVersion: 'ok', themeId: 'bad-theme', broken: [], pages: {}, at: 1 } });
      assert.deepEqual(t.injector.readFirstPaint(), { key: 'cinema:x', css: CSS, attrs: ATTRS });
    } finally { t.close(); }
  });

  test('blocked or throwing storage: reads give null, writes give false, nothing throws', () => {
    const t = make();
    try {
      Object.defineProperty(t.window, 'localStorage', { configurable: true, get() { throw new t.window.DOMException('denied', 'SecurityError'); } });
      assert.equal(t.injector.readFirstPaint(), null);
      assert.equal(t.injector.writeFirstPaint('cinema:a', CSS), false);
      t.injector.clearFirstPaint();

      Object.defineProperty(t.window, 'localStorage', { configurable: true, get: () => ({
        getItem() { throw new Error('quota'); }, setItem() { throw new Error('quota'); }, removeItem() { throw new Error('quota'); },
      }) });
      assert.equal(t.injector.readFirstPaint(), null);
      assert.equal(t.injector.writeFirstPaint('cinema:a', CSS), false);
      t.injector.clearFirstPaint();
    } finally { t.close(); }
  });
});

test('everything the engine itself can build (6 themes x 3 home layouts x 3 watch layouts, every calm toggle) passes the first-paint filter', () => {
  const map = parseEnvelopePayload(JSON.parse(readFileSync(new URL('../../src/data/selector-map.signed.json', import.meta.url), 'utf8')));
  const pro = { plan: 'pro', status: 'active' };
  let built = 0;
  for (const theme of THEMES) {
    for (const home of ['grid', 'rows', 'hero-rows']) {
      for (const watch of ['default', 'cinema', 'focus']) {
        const base = computeEffectiveConfig({ settings: { themeId: theme.id, density: 4, calm: { hideShorts: true, hideHomeRecs: true, hideComments: true, hideEndScreens: true, hideViewCounts: true, hideLive: true } }, licenceState: pro, themes: THEMES });
        const { css } = composeStylesheet({ map, cfg: { ...base, home, watch } });
        assert.ok(css.length > 1000);
        assert.equal(isUnsafeCachedCss(css), false, `${theme.id} ${home} ${watch}`);
        built++;
      }
    }
  }
  assert.equal(built, 54);
});
