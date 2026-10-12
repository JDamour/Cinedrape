// composeStylesheet: contract order, theme-CSS gating and caching, disabled features, failure containment.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { composeStylesheet } from '../../src/content/stylesheet.js';
import { buildTokenCss, TOKEN_SELECTOR } from '../../src/shared/tokens.js';
import { computeEffectiveConfig } from '../../src/shared/entitlements.js';
import { buildSkinCss } from '../../src/content/skin.js';
import { buildDensityCss } from '../../src/content/layouts/density.js';
import { buildHomeLayoutCss } from '../../src/content/layouts/home.js';
import { buildWatchLayoutCss } from '../../src/content/layouts/watch.js';
import { buildCalmCss } from '../../src/content/calm.js';
import { MAP, THEMES } from '../helpers/engine-env.js';

const PRO = { plan: 'pro', status: 'active' };
const cfgFor = (themeId, extra = {}, licenceState = PRO) => computeEffectiveConfig({
  settings: { themeId, calm: { hideShorts: true }, ...extra }, licenceState, themes: THEMES,
});
const withCss = (theme, css) => ({ ...structuredClone(theme), css });

describe('composeStylesheet', () => {
  test('joins the builders in contract order, theme css last', () => {
    const cfg = cfgFor('cinema', { density: 4, accent: '#ff8800' });
    const { css, warnings } = composeStylesheet({ map: MAP, cfg });
    const expected = [
      buildTokenCss(cfg.theme, { accent: cfg.accent, animations: cfg.animations }, MAP),
      buildSkinCss(MAP, cfg), buildDensityCss(MAP, cfg), buildHomeLayoutCss(MAP, cfg),
      buildWatchLayoutCss(MAP, cfg), buildCalmCss(MAP, cfg), cfg.theme.css,
    ].map((s) => s.trim()).filter(Boolean).join('\n');
    assert.equal(css, expected);
    assert.deepEqual(warnings, []);
    assert.ok(css.trim().endsWith(cfg.theme.css.trim()), 'theme css is last');
    assert.ok(css.startsWith('html[cd-theme]'), 'tokens first');
  });

  test('every launch theme composes with no warnings and inside the first-paint cache size', () => {
    for (const theme of THEMES) {
      const { css, warnings } = composeStylesheet({ map: MAP, cfg: cfgFor(theme.id, { density: 5, calm: { hideShorts: true, hideHomeRecs: true, hideComments: true, hideEndScreens: true, hideViewCounts: true } }) });
      assert.deepEqual(warnings, [], theme.id);
      assert.ok(css.length > 1000 && css.length < 60 * 1024, `${theme.id}: ${css.length}`);
    }
  });

  test('a theme whose css fails validation is composed without it, with a warning', () => {
    const cfg = cfgFor('cinema');
    const bad = withCss(cfg.theme, 'ytd-ad-slot-renderer { display: none }');
    const { css, warnings } = composeStylesheet({ map: MAP, cfg: { ...cfg, theme: bad } });
    assert.ok(!css.includes('ytd-ad-slot-renderer{display') && !css.includes('display: none'));
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /theme css skipped for "cinema"/);
    assert.ok(css.includes('html[cd-theme]'), 'the rest of the stylesheet is still there');

    const imp = withCss(cfg.theme, '@import url(https://evil.example/x.css);');
    assert.ok(!composeStylesheet({ map: MAP, cfg: { ...cfg, theme: imp } }).css.includes('evil.example'));
  });

  test('the css verdict is cached per theme id + mapVersion, and re-judged when the css changes', () => {
    const base = cfgFor('classic');
    const rule = 'html[cd-theme] .cd-card { border-radius: 3px }';
    const theme = withCss(base.theme, `${rule}\nhtml[cd-theme] zz-new-element { color: var(--cd-text) }`);
    const noElement = structuredClone(MAP);
    noElement.mapVersion = '2099.01.01.1';
    const withElement = structuredClone(noElement);
    withElement.roles.zzRole = ['zz-new-element'];
    const compose = (map, t) => composeStylesheet({ map, cfg: { ...base, theme: t } });

    assert.ok(compose(withElement, theme).css.includes('zz-new-element'), 'valid against a map that knows the element');
    assert.ok(compose(noElement, theme).css.includes('zz-new-element'), 'same id + mapVersion: the cached verdict is reused');
    const bumped = { ...noElement, mapVersion: '2099.01.02.1' };
    const res = compose(bumped, theme);
    assert.ok(!res.css.includes('zz-new-element'), 'a new mapVersion re-validates');
    assert.equal(res.warnings.length, 1);
    const edited = withCss(base.theme, rule);
    assert.ok(compose(bumped, edited).css.includes('border-radius: 3px') || compose(bumped, edited).css.includes('border-radius:3px'), 'different css under the same id is judged again');
  });

  test('cfg.disabled reaches the builders', () => {
    const full = composeStylesheet({ map: MAP, cfg: cfgFor('cinema') }).css;
    const noLayout = composeStylesheet({ map: MAP, cfg: { ...cfgFor('cinema'), disabled: ['layout-home'] } }).css;
    assert.ok(full.includes('[cd-source]') && !noLayout.includes('[cd-source]'));
    assert.ok(noLayout.includes('--cd-bg'), 'unrelated parts survive');

    const noTheme = composeStylesheet({ map: MAP, cfg: { ...cfgFor('cinema'), disabled: ['theme'] } }).css;
    assert.ok(!noTheme.includes(TOKEN_SELECTOR) && !noTheme.includes('--cd-bg:') && !noTheme.includes(cfgFor('cinema').theme.css.trim()), 'tokens and theme css are gone');
    assert.ok(noTheme.length < full.length * 0.8, 'skin is gone too');
    assert.ok(noTheme.includes('[cd-source]'), 'layouts are separate features');
  });

  test('a builder that throws costs its own part and leaves a warning; junk input never throws', () => {
    const cfg = cfgFor('cinema');
    const hostile = { ...cfg, get density() { throw new Error('boom'); } };
    const { css, warnings } = composeStylesheet({ map: MAP, cfg: hostile });
    assert.ok(warnings.some((w) => /density: boom/.test(w)), warnings.join('|'));
    assert.ok(css.includes('--cd-bg') && css.includes('[cd-source]'));

    for (const input of [undefined, {}, { map: null, cfg: null }, { map: {}, cfg: cfg }, { map: MAP, cfg: { theme: null } }]) {
      const res = composeStylesheet(input);
      assert.equal(typeof res.css, 'string');
      assert.ok(Array.isArray(res.warnings));
    }
  });
});
