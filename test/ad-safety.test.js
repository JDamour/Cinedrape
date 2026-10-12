// Contract section 6.2, the rule nobody may break: nothing Cinedrape injects hides, collapses, covers or fades an ad, a
// sponsorship disclosure or the player controls, and nothing hides an element that can HOLD an ad without the
// :not(:has(<ads>)) guard.
//
// Layers over every composed stylesheet (6 themes x extreme configs):
//   1. static: the whole stylesheet goes through the css-validator (a real tokenizer; it classifies every hiding / overlay
//      declaration and every selector subject). Any hides-protected / hides-container / covers-page / syntax finding fails.
//      The scan is COMPLETE by construction: it records every finding (maxErrors Infinity; the validator's default cap of 50 once
//      made this layer vacuous, because the engine's own broad selectors used the 50 slots by line 22 of 153), it asserts that
//      the number of rules evaluated equals the number of rules present (also against jsdom's own parse), and a meta-test appends a
//      bad rule to the END of the longest sheet. Engine CSS is scanned with profile "engine" (safety layer only: it legitimately
//      styles YouTube geometry); the theme's own CSS is additionally held to the strict allow-list profile.
//   2. dynamic: the CSS is applied to jsdom pages that contain ads (home, watch, search). Every protected node keeps its
//      computed display / visibility / opacity, and every top-level rule that hides something is run against the page: what it
//      matches may neither be nor contain a protected node (display:none on an ancestor does not show in a child's computed
//      style). jsdom ignores @media, so top-level rules only; the static layer reads at-rules too.
//   3. the whole engine (Pro, every calm toggle, layouts mounted) on the same pages.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCss, scanCss, buildAllowList } from '../src/shared/css-validator.js';
import { composeStylesheet } from '../src/content/stylesheet.js';
import { computeEffectiveConfig } from '../src/shared/entitlements.js';
import { applyCalmAttributes } from '../src/content/calm.js';
import { CALM_KEYS } from '../src/shared/constants.js';
import { createPage } from './helpers/dom.js';
import { MAP, THEMES, createEnv, makeKeyPair, proLicence, waitFor } from './helpers/engine-env.js';

const PRO = { plan: 'pro', status: 'active' };
const ALL_CALM = Object.fromEntries(CALM_KEYS.map((k) => [k, true]));
const NO_CALM = Object.fromEntries(CALM_KEYS.map((k) => [k, false]));
const ALLOW = buildAllowList(MAP);
const PROTECTED_FLAT = [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls];
const SAFETY = new Set(['hides-protected', 'hides-container', 'covers-page', 'syntax']);

// The extremes the controls can reach. Home / watch layouts come from the theme, so they are forced on the config here.
const CONFIGS = [
  ['everything on: hero-rows, watch focus, density 1, every calm toggle, accent override',
    (cfg) => ({ ...cfg, home: 'hero-rows', watch: 'focus', density: 1, calm: ALL_CALM, accent: '#ff00aa' })],
  ['rows, watch cinema, density 5, every calm toggle',
    (cfg) => ({ ...cfg, home: 'rows', watch: 'cinema', density: 5, calm: ALL_CALM })],
  ['plain: grid, default watch, theme density, nothing calm',
    (cfg) => ({ ...cfg, home: 'grid', watch: 'default', calm: NO_CALM })],
];

function configFor(theme, shape) {
  return shape(computeEffectiveConfig({ settings: { themeId: theme.id }, licenceState: PRO, themes: THEMES }));
}
const compose = (cfg) => composeStylesheet({ map: MAP, cfg });
// The one engine rule that the safety layer names and that is benign: cinema turns #primary / #primary-inner into display:contents so
// the player box and the metadata box become grid items of #columns. The children stay visible (no <img>, <video> or <canvas> is the
// subject), and #primary / #primary-inner are boxes of the page layout, not ad containers (an ad inside is shown where it is).
const ALLOWED_ENGINE_RULES = [
  { code: 'hides-container', line: /^html\[cd-theme\]\[cd-page="watch"\]:not\(\[cd-off-layout-watch\]\) ytd-watch-flexy\[is-two-columns_\]:not\(\[theater\]\):not\(\[fullscreen\]\) #primary(?:-inner)?(?:,[^{]*)?\{display:contents\}$/ },
];
const SCAN_CTX = { allowList: ALLOW, protectedSelectors: PROTECTED_FLAT, maxBytes: 4 * 1024 * 1024, maxErrors: Infinity, profile: 'engine' };
/** Every finding of the whole sheet (engine profile, nothing capped), the documented exceptions removed, plus what was evaluated. */
function scan(css) {
  const r = scanCss(css, SCAN_CTX);
  const lines = css.split(/\r\n|\n|\r|\f/);
  const findings = r.errors.filter((e) => SAFETY.has(e.code)).filter((e) => !ALLOWED_ENGINE_RULES.some((a) => a.code === e.code && a.line.test(lines[e.line - 1] || '')));
  return { findings, stats: r.stats, errors: r.errors };
}
const safetyFindings = (css) => scan(css).findings;

/** CSSStyleRule count of a sheet as jsdom's own parser sees it, descending into @media / @supports. */
function jsdomRuleCount(css) {
  const { document, window } = createPage('home', { tiles: 1 });
  try {
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    const count = (rules) => { let n = 0; for (const rule of rules) { if (rule.selectorText !== undefined && rule.style) n++; else if (rule.cssRules) n += count(rule.cssRules); } return n; };
    return count(style.sheet.cssRules);
  } finally { window.close(); }
}

describe('static scan of every composed stylesheet', () => {
  test('the scanner itself flags the tricks it exists to catch', () => {
    const guard = `:not(:has(${MAP.protected.ads.join(', ')}))`;
    const bad = {
      'hides an ad': 'ytd-ad-slot-renderer { display: none }',
      'collapses an ad class': 'html[cd-theme] .ytp-ad-module { height: 0 }',
      'fades a sponsorship disclosure': 'html[cd-theme] .ytp-paid-content-overlay { opacity: 0 }',
      'hides the player controls': 'html[cd-theme] .ytp-chrome-bottom { visibility: hidden }',
      'hides a container without the guard': 'html[cd-theme] ytd-rich-item-renderer { display: none }',
      'hides the whole page': 'html { display: none }',
    };
    for (const [name, css] of Object.entries(bad)) assert.ok(safetyFindings(css).length > 0, `must flag: ${name}`);
    assert.deepEqual(safetyFindings(`html[cd-theme] ytd-rich-item-renderer${guard} { display: none }`), [], 'the guard is what makes a container hide legal');
  });

  test('the scan is complete: a deliberately bad rule appended at the END of the longest stylesheet is found, and so is one in the middle', () => {
    const theme = THEMES.find((t) => t.id === 'studio') || THEMES[0];
    const { css } = compose(configFor(theme, CONFIGS[0][1]));
    const base = scan(css);
    assert.deepEqual(base.findings, []);
    // engine rules really do use up the validator's default error budget; this is why the scan must not use it
    const noisy = scanCss(css, { allowList: ALLOW, protectedSelectors: PROTECTED_FLAT, maxBytes: 4 * 1024 * 1024, profile: 'engine' });
    assert.ok(noisy.errors.length >= 50, `the engine sheet has ${noisy.errors.length} non-safety findings; the default cap would have been reached`);
    const lines = css.split('\n');
    for (const [what, rule] of [['hides an ad', 'ytd-ad-slot-renderer{display:none}'], ['collapses an ad holder', 'html[cd-theme] ytd-rich-item-renderer{height:0}'],
      ['fades the sponsorship label', 'html[cd-theme] .ytp-paid-content-overlay{opacity:.2}'], ['covers the page', 'html[cd-theme] ytd-masthead::after{position:fixed;inset:0;background:#000}']]) {
      const atEnd = scan(`${css}\n${rule}\n`);
      assert.equal(atEnd.findings.length, 1, `${what} (end)`);
      assert.ok(atEnd.findings[0].line >= lines.length, `${what}: reported on line ${atEnd.findings[0].line} of at least ${lines.length}`);
      const middle = lines.slice();
      middle.splice(Math.floor(lines.length / 2), 0, rule);
      assert.equal(scan(middle.join('\n')).findings.length, 1, `${what} (middle)`);
      // the validator's own default cap does not hide it either (safety findings keep their own slots)
      const capped = validateCss(`${css}\n${rule}\n`, { allowList: ALLOW, protectedSelectors: PROTECTED_FLAT, maxBytes: 4 * 1024 * 1024, profile: 'engine' });
      assert.ok(capped.errors.some((e) => SAFETY.has(e.code)), `${what} (default cap)`);
    }
    assert.ok(scan(`${css}\n.cd-a{`).findings.length > 0, 'a stylesheet that does not even parse is reported (syntax), not scanned');
  });

  test('the documented exception is exactly one rule shape: display:contents on #primary / #primary-inner of the cinema layout', () => {
    const cinema = compose(configFor(THEMES[0], CONFIGS[1][1])).css;   // watch: cinema
    const raw = scanCss(cinema, SCAN_CTX).errors.filter((e) => SAFETY.has(e.code));
    assert.ok(raw.length >= 1, 'the validator still names it: the exception is an explicit entry, not a blind spot');
    assert.deepEqual(scan(cinema).findings, []);
    // the same declaration on anything else is not excused
    assert.equal(scan(`${cinema}\nhtml[cd-theme] ytd-rich-item-renderer{display:contents}`).findings.length, 1);
    assert.equal(scan(`${cinema}\nhtml[cd-theme][cd-page="watch"]:not([cd-off-layout-watch]) ytd-watch-flexy[is-two-columns_]:not([theater]):not([fullscreen]) #secondary{display:contents}`).findings.length, 1);
  });

  for (const theme of THEMES) {
    test(`${theme.id}: the theme's own css passes the strict allow-list profile (what a theme may do), unchanged`, () => {
      const r = validateCss(theme.css || '', { allowList: ALLOW, protectedSelectors: PROTECTED_FLAT });
      assert.deepEqual(r.errors.map((e) => `line ${e.line}: ${e.message}`), []);
    });
  }

  for (const theme of THEMES) {
    test(`${theme.id}: no composed stylesheet hides or covers anything protected`, () => {
      for (const [name, shape] of CONFIGS) {
        const { css, warnings } = compose(configFor(theme, shape));
        assert.deepEqual(warnings, [], `${theme.id} / ${name}`);
        assert.ok(css.length > 5000, `${theme.id} / ${name}: stylesheet is suspiciously small`);
        const { findings, stats } = scan(css);
        assert.deepEqual(findings.map((f) => `line ${f.line}: ${f.message}`), [], `${theme.id} / ${name}`);
        // Nothing was skipped: every rule of the sheet was evaluated, and the count agrees with a second, independent parser.
        assert.ok(stats.rules > 60, `${theme.id} / ${name}: only ${stats.rules} rules`);
        assert.equal(stats.skipped, 0, `${theme.id} / ${name}: rules whose selector did not parse`);
        assert.equal(stats.evaluated, stats.rules, `${theme.id} / ${name}`);
        assert.equal(stats.rules, jsdomRuleCount(css), `${theme.id} / ${name}: the validator and jsdom disagree about how many rules the sheet has`);
      }
    });
  }
});

// ---- dynamic: computed styles in jsdom ---------------------------------------------------------------------------------

const PAGES = {
  home: { tiles: 12, ads: true, shorts: true, tileStyle: 'home' },
  watch: { tiles: 10, ads: true },
  search: { tiles: 10, ads: true, shorts: true },
};
const EXPECT = { home: ['ads'], watch: ['ads', 'sponsor', 'playerControls'], search: ['ads'] };
// Every ad and sponsorship node, but only the player controls the task names (the validator covers the whole list): jsdom
// computes a style in milliseconds per node and the budget for this file is a few seconds.
const CONTROLS = ['.ytp-chrome-bottom', '.ytp-chrome-controls', '.ytp-progress-bar'];

/** [{group, node}] for every protected node on the page. */
function protectedNodes(doc) {
  const out = [];
  const groups = [['ads', MAP.protected.ads], ['sponsor', MAP.protected.sponsor], ['playerControls', CONTROLS]];
  for (const [group, selectors] of groups) {
    const seen = new Set();
    for (const selector of selectors) {
      for (const node of doc.querySelectorAll(selector)) if (!seen.has(node)) { seen.add(node); out.push({ group, node }); }
    }
  }
  return out;
}

function describeNode(n) {
  const cls = typeof n.className === 'string' && n.className.trim() ? `.${n.className.trim().split(/\s+/).join('.')}` : '';
  return `${n.localName}${n.id ? `#${n.id}` : ''}${cls}`;
}

/** Why the node's own computed style hides it (visibility is inherited, so an ancestor's visibility shows up here too). */
function computedReason(win, node) {
  const cs = win.getComputedStyle(node);
  if (cs.display === 'none') return 'display:none';
  if (cs.visibility === 'hidden' || cs.visibility === 'collapse') return `visibility:${cs.visibility}`;
  if (cs.opacity !== '' && Number(cs.opacity) < 1) return `opacity:${cs.opacity}`;
  return null;
}

const ZERO = /^0(\.0+)?(px|em|rem|%|vh|vw)?$/;
function declaresHiding(style) {
  const get = (p) => String(style.getPropertyValue(p) || '').replace(/\s*!important\s*$/i, '').trim().toLowerCase();
  if (get('display') === 'none') return 'display:none';
  if (['hidden', 'collapse'].includes(get('visibility'))) return 'visibility';
  if (get('opacity') !== '' && Number(get('opacity')) < 1) return 'opacity';
  for (const prop of ['height', 'width', 'max-height', 'max-width']) if (ZERO.test(get(prop))) return `${prop}:0`;
  return null;
}

/**
 * Every top-level hiding rule of OUR stylesheet, tested against each protected node and each of its ancestors (display:none on an
 * ancestor does not show in the node's own computed style): none of them may match.
 */
function hidingRuleFindings(nodes, sheet) {
  const chain = new Map();   // element -> the protected node it belongs to
  for (const { group, node } of nodes) {
    for (let el = node; el && el.nodeType === 1; el = el.parentElement) if (!chain.has(el)) chain.set(el, { group, node });
  }
  const found = [];
  for (const rule of sheet.cssRules) {
    if (!rule.selectorText || !rule.style) continue;
    const why = declaresHiding(rule.style);
    if (!why) continue;
    for (const [el, victim] of chain) {
      let hit = false;
      try { hit = el.matches(rule.selectorText); } catch { hit = false; }
      if (hit) found.push(`${why} by "${rule.selectorText.slice(0, 90)}" on ${describeNode(el)} hides ${victim.group} ${describeNode(victim.node)}`);
    }
  }
  return found;
}

function setPageAttributes(doc, cfg, kind) {
  const html = doc.documentElement;
  html.setAttribute('cd-theme', cfg.theme.id);
  html.setAttribute('cd-page', kind);
  html.setAttribute('cd-home', cfg.home);
  html.setAttribute('cd-watch', cfg.watch);
  html.setAttribute('cd-density', String(cfg.density));
  html.setAttribute('cd-motion', 'on');
  applyCalmAttributes(doc, cfg.calm, cfg.disabled);
}

function assertAllVisible(page, style, label, expectGroups, nodes = protectedNodes(page.document)) {
  for (const group of expectGroups) assert.ok(nodes.some((n) => n.group === group), `${label}: the fixture has no ${group} node to protect`);
  const hidden = [];
  for (const { group, node } of nodes) {
    const why = computedReason(page.window, node);
    if (why) hidden.push(`${group} ${describeNode(node)}: ${why}`);
  }
  hidden.push(...hidingRuleFindings(nodes, style.sheet));
  assert.deepEqual(hidden, [], `${label}: protected nodes lost their display`);
  return nodes.length;
}

describe('computed styles on pages that contain ads', () => {
  test('every theme, extreme configs: ads, sponsorship and player controls keep their display; the check has teeth', () => {
    // One page per kind for the whole test: the DOM never changes, only the stylesheet and the <html> attributes do.
    const pages = Object.fromEntries(Object.entries(PAGES).map(([kind, opts]) => {
      const page = createPage(kind, opts);
      const style = page.document.createElement('style');
      page.document.head.append(style);
      return [kind, { page, style, nodes: protectedNodes(page.document) }];
    }));
    try {
      let checked = 0;
      THEMES.forEach((theme, i) => {
        const [name, shape] = CONFIGS[i % 2];   // alternate the two extreme configs across themes (the static scan runs all three)
        const cfg = configFor(theme, shape);
        const { css } = compose(cfg);
        // watch carries the ads, the disclosure and the controls, so every theme gets it; home and search take turns (time budget).
        const kinds = ['watch', ...(i % 3 === 0 ? ['home'] : i % 3 === 1 ? ['search'] : [])];
        for (const kind of kinds) {
          const { page, style, nodes } = pages[kind];
          style.textContent = css;
          assert.ok(style.sheet.cssRules.length > 100, 'the stylesheet parsed into real rules');
          setPageAttributes(page.document, cfg, kind);
          checked += assertAllVisible(page, style, `${theme.id} / ${kind} / ${name}`, EXPECT[kind], nodes);
        }
      });
      assert.ok(checked > 40, `only ${checked} protected nodes were checked`);

      // Teeth: the same checks must fail when a stylesheet does hide an ad, the container of an ad, or the controls.
      for (const [kind, rule] of [['home', 'ytd-rich-item-renderer { display: none }'], ['watch', '.ytp-chrome-bottom { opacity: 0 }'],
        ['watch', 'ytd-ad-slot-renderer, .ytp-ad-module { display: none }']]) {
        const { page, style, nodes } = pages[kind];
        style.textContent = rule;
        assert.throws(() => assertAllVisible(page, style, 'sabotage', ['ads'], nodes), /protected nodes lost their display/, rule);
      }
    } finally { for (const { page } of Object.values(pages)) page.window.close(); }
  });
});

describe('the whole engine, Pro, every calm toggle, layouts mounted', () => {
  test('ownership holds: no YouTube element gets a cd- class or id, and none ends up inside a cd- element (the validator\x27s own-subtree rule depends on it)', async () => {
    const keys = await makeKeyPair('licence-1');
    const stored = {
      settings: { themeId: 'cinema', density: 3, calm: ALL_CALM },
      licence: await proLicence(keys.privateJwk),
    };
    const env = await createEnv('home', { page: PAGES.home, stored, engine: { publicKeys: { licence: keys.publicJwk } } });
    try {
      const original = [...env.document.querySelectorAll('*')];
      assert.ok(original.length > 50);
      await env.engine.start();
      await waitFor(() => env.document.querySelector('.cd-home'), 'home layout mounted');
      await new Promise((resolve) => setTimeout(resolve, 30));
      const isOwn = (el) => [...el.classList].some((c) => c.startsWith('cd-')) || (el.id || '').startsWith('cd-') || el.localName.startsWith('cd-');
      const offenders = [];
      for (const el of original) {
        if (!el.isConnected) continue;   // the engine may have removed nothing; a detached original would be a finding of its own
        if (isOwn(el)) offenders.push(`own name on a YouTube element: ${describeNode(el)}`);
        for (let a = el.parentElement; a; a = a.parentElement) if (isOwn(a)) { offenders.push(`${describeNode(el)} sits inside ${describeNode(a)}`); break; }
      }
      assert.deepEqual(offenders, []);
      assert.ok(env.document.querySelectorAll('[class*="cd-"]').length > 10, 'the fixture did mount own elements');
    } finally { env.close(); }
  });


  test('studio: ads stay visible on a home page with the hero-rows layout mounted', async () => {
    const keys = await makeKeyPair('licence-1');
    const stored = {
      settings: { themeId: 'studio', density: 1, accent: '#ff00aa', calm: ALL_CALM },
      licence: await proLicence(keys.privateJwk),
    };
    for (const kind of ['home']) {
      const env = await createEnv(kind, { page: PAGES[kind], stored, engine: { publicKeys: { licence: keys.publicJwk } } });
      try {
        await env.engine.start();
        if (kind === 'home') await waitFor(() => env.document.querySelector('.cd-home'), 'home layout mounted');
        await new Promise((resolve) => setTimeout(resolve, 30));
        assert.equal(env.engine.getStatus().pro, true);
        assertAllVisible(env.page, env.style(), `studio / ${kind}`, EXPECT[kind]);
      } finally { env.close(); }
    }
  });
});
