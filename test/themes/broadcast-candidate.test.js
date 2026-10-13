// Verification tests for the Broadcast theme candidate (docs/ENHANCEMENT-SPECS.md §S10, docs/TASKS.md E7).
// Verifies that Broadcast passes validateTheme, all contrast pairs, and the css-validator allow-list.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { validateTheme, FONT_STACKS } from '../../src/shared/theme-schema.js';
import { checkThemeContrast, contrastRatio } from '../../src/shared/contrast.js';
import { deriveTokens, buildTokenCss } from '../../src/shared/tokens.js';
import { validateCss, buildAllowList } from '../../src/shared/css-validator.js';
import { LIMITS } from '../../src/shared/constants.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const MAP = JSON.parse(readFileSync(path.join(ROOT, 'src', 'data', 'selector-map.source.json'), 'utf8'));
const BROADCAST_RAW = readFileSync(path.join(ROOT, 'src', 'themes', 'broadcast.json'), 'utf8');
const BROADCAST = JSON.parse(BROADCAST_RAW);

describe('Broadcast theme candidate (E7 / S10)', () => {
  test('passes validateTheme with the real selector map (schema + CSS)', () => {
    const res = validateTheme(BROADCAST, { selectorMap: MAP });
    assert.equal(res.ok, true, `validateTheme failed: ${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.errors, []);
    assert.deepEqual(res.warnings, []);
    assert.equal(res.cssValidated, true);
    assert.deepEqual(res.theme, BROADCAST, 'normalising changes nothing');
  });

  test('fulfils the S10 candidate brief: high-contrast dark, 16 px base, live-first hero', () => {
    assert.equal(BROADCAST.id, 'broadcast');
    assert.equal(BROADCAST.name, 'Broadcast');
    assert.equal(BROADCAST.author, 'Cinedrape');
    assert.equal(BROADCAST.version, '1.0.0');
    assert.equal(BROADCAST.tier, 'pro');

    // 16 px base font as specified
    assert.equal(BROADCAST.tokens.type.baseSize, 16);
    assert.equal(BROADCAST.tokens.type.headingWeight, 700);
    assert.equal(BROADCAST.tokens.type.family, 'System');
    assert.ok(Object.hasOwn(FONT_STACKS, BROADCAST.tokens.type.family));

    // Live-first hero layout
    assert.equal(BROADCAST.layout.home, 'hero-rows');
    assert.equal(BROADCAST.layout.watch, 'cinema');
    assert.equal(BROADCAST.layout.density, 3);

    // Shape
    assert.equal(BROADCAST.tokens.shape.radius, 4);
    assert.equal(BROADCAST.tokens.shape.shadow, true);
    assert.equal(BROADCAST.tokens.shape.spacing, 3);
  });

  test('passes all six WCAG AA contrast pairs with high-contrast headroom', () => {
    const results = checkThemeContrast(BROADCAST);
    assert.deepEqual(results.map((r) => r.pair), ['text/bg', 'text/surface', 'muted/bg', 'muted/surface', 'accent/bg', 'border/bg']);
    for (const r of results) {
      assert.ok(r.pass, `${r.pair}: ratio ${r.ratio} < ${r.required}`);
    }

    const c = BROADCAST.tokens.color;
    // High-contrast requirements: text/bg exceeds 15:1
    assert.ok(contrastRatio(c.text, c.bg) >= 15, `text/bg: ${contrastRatio(c.text, c.bg)}`);
    assert.ok(contrastRatio(c.text, c.surface) >= 15, `text/surface: ${contrastRatio(c.text, c.surface)}`);
    assert.ok(contrastRatio(c.muted, c.bg) >= 7, `muted/bg: ${contrastRatio(c.muted, c.bg)}`);
    assert.ok(contrastRatio(c.muted, c.surface) >= 7, `muted/surface: ${contrastRatio(c.muted, c.surface)}`);
    assert.ok(contrastRatio(c.accent, c.bg) >= 4.5, `accent/bg: ${contrastRatio(c.accent, c.bg)}`);
    assert.ok(contrastRatio(c.border, c.bg) >= 3.1, `border/bg: ${contrastRatio(c.border, c.bg)}`);
    assert.ok(contrastRatio(c.border, c.surface) >= 3.0, `border/surface: ${contrastRatio(c.border, c.surface)}`);

    // Accent label readability
    const tokens = deriveTokens(BROADCAST, {}, MAP);
    assert.ok(contrastRatio(tokens['--cd-accent-text'], c.accent) >= 4.5, 'accent label readable');
  });

  test('passes the strict CSS validator allow-list and protected rules', () => {
    const allowList = buildAllowList(MAP);
    const protectedSelectors = [...MAP.protected.ads, ...MAP.protected.sponsor, ...MAP.protected.playerControls];
    const r = validateCss(BROADCAST.css, { allowList, protectedSelectors });
    assert.equal(r.ok, true, `CSS validation failed: ${JSON.stringify(r.errors)}`);
    assert.deepEqual(r.errors, []);

    // Stays well within size limit
    assert.ok(Buffer.byteLength(BROADCAST.css) < LIMITS.cssMaxBytes / 4);
    assert.ok(!BROADCAST.css.includes('@'), 'no at-rules');
    assert.ok(!BROADCAST.css.includes('/*'), 'no comments');
  });

  test('produces valid token CSS with 16 px font-size variable', () => {
    const css = buildTokenCss(BROADCAST, {}, MAP);
    assert.ok(css.includes('--cd-font-size:16px'), '16 px font size emitted in tokens');
    assert.ok(css.includes('--cd-bg:#08080a'));
    assert.ok(css.includes('--cd-text:#ffffff'));
    assert.ok(css.includes('--cd-accent:#ff3b30'));
    assert.ok(css.includes('--cd-heading-weight:700'));
  });
});
