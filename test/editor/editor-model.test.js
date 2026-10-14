import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createDefaultTheme,
  slugifyThemeName,
  updateThemeProperty,
  evaluateContrast,
  validateEditorTheme,
  computePreviewTokens,
  exportThemeToJson,
  STARTER_THEME,
} from '../../src/editor/editor-model.js';
import { validateTheme } from '../../src/shared/theme-schema.js';

test('createDefaultTheme returns a valid Schema v1 theme', () => {
  const theme = createDefaultTheme();
  assert.equal(theme.schema, 1);
  assert.equal(theme.tier, 'pro');
  assert.equal(typeof theme.id, 'string');
  assert.equal(typeof theme.name, 'string');
  assert.equal(typeof theme.author, 'string');
  assert.equal(typeof theme.tokens.color.bg, 'string');
  assert.equal(typeof theme.tokens.color.surface, 'string');
  assert.equal(typeof theme.tokens.color.text, 'string');

  const val = validateTheme(theme);
  assert.equal(val.ok, true, `validateTheme failed: ${JSON.stringify(val.errors)}`);
});

test('slugifyThemeName produces clean alphanumeric slugs', () => {
  assert.equal(slugifyThemeName('My Custom Theme'), 'my-custom-theme');
  assert.equal(slugifyThemeName('  Cyber_Neon 2026!  '), 'cyber-neon-2026');
  assert.equal(slugifyThemeName('A'), 'custom-theme'); // minimum length 2
  assert.equal(slugifyThemeName('---hello---world---'), 'hello-world');
  assert.equal(slugifyThemeName(''), 'custom-theme');
  assert.equal(slugifyThemeName(null), 'custom-theme');
  assert.ok(slugifyThemeName('a'.repeat(60)).length <= 40);
});

test('updateThemeProperty updates nested properties immutably', () => {
  const original = createDefaultTheme();
  const updated1 = updateThemeProperty(original, 'name', 'Sunset Boulevard');

  assert.notEqual(original, updated1);
  assert.equal(original.name, 'My Custom Theme');
  assert.equal(updated1.name, 'Sunset Boulevard');
  assert.equal(updated1.id, 'sunset-boulevard');

  const updated2 = updateThemeProperty(updated1, 'tokens.color.bg', '#000000');
  assert.equal(updated2.tokens.color.bg, '#000000');
  assert.equal(updated1.tokens.color.bg, '#111216');

  const updated3 = updateThemeProperty(updated2, 'tokens.shape.radius', 16);
  assert.equal(updated3.tokens.shape.radius, 16);

  const updated4 = updateThemeProperty(updated3, 'calm.hideShorts', true);
  assert.equal(updated4.calm.hideShorts, true);
});

test('evaluateContrast checks all 6 WCAG AA pairs', () => {
  const theme = createDefaultTheme();
  const res = evaluateContrast(theme);
  assert.equal(res.totalCount, 6);
  assert.equal(res.passed, true);
  assert.equal(res.passCount, 6);

  // Set unreadable text on bg
  const badTheme = updateThemeProperty(theme, 'tokens.color.text', '#121216');
  const badRes = evaluateContrast(badTheme);
  assert.equal(badRes.passed, false);
  assert.ok(badRes.passCount < 6);
  const textBg = badRes.pairs.find((p) => p.pair === 'text/bg');
  assert.ok(textBg);
  assert.equal(textBg.pass, false);
});

test('validateEditorTheme returns validation status and contrast details', () => {
  const theme = createDefaultTheme();
  const res = validateEditorTheme(theme);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.contrast.passed, true);

  // Invalid color format
  const brokenTheme = updateThemeProperty(theme, 'tokens.color.bg', 'not-a-color');
  const brokenRes = validateEditorTheme(brokenTheme);
  assert.equal(brokenRes.ok, false);
  assert.ok(brokenRes.errors.some((e) => e.path.includes('color.bg')));
});

test('computePreviewTokens derives live CSS variables for preview', () => {
  const theme = createDefaultTheme();
  const tokens = computePreviewTokens(theme);
  assert.ok(tokens['--cd-bg']);
  assert.ok(tokens['--cd-surface']);
  assert.ok(tokens['--cd-text']);
  assert.ok(tokens['--cd-accent']);
  assert.ok(tokens['--cd-radius']);
  assert.ok(tokens['--cd-font-family']);
  assert.equal(tokens['--cd-radius'], '10px');
});

test('exportThemeToJson produces valid indented JSON string', () => {
  const theme = createDefaultTheme();
  const jsonStr = exportThemeToJson(theme);
  assert.equal(typeof jsonStr, 'string');
  const parsed = JSON.parse(jsonStr);
  assert.equal(parsed.id, theme.id);
  assert.equal(parsed.name, theme.name);
  assert.deepEqual(parsed.tokens, theme.tokens);
});
