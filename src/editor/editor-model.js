// Pure model logic for Cinedrape Visual Theme Editor (Spec F7).
// Pure: no DOM, no chrome.*. Fully unit-testable.

import { LATEST_SCHEMA, validateTheme } from '../shared/theme-schema.js';
import { checkThemeContrast } from '../shared/contrast.js';
import { deriveTokens } from '../shared/tokens.js';
import { validateCss } from '../shared/css-validator.js';
import { CALM_KEYS, LAYOUT_HOME, LAYOUT_WATCH } from '../shared/constants.js';

export const STARTER_THEME = Object.freeze({
  schema: LATEST_SCHEMA,
  id: 'my-custom-theme',
  name: 'My Custom Theme',
  author: 'Theme Creator',
  version: '1.0.0',
  tier: 'pro',
  tokens: {
    color: {
      bg: '#111216',
      surface: '#1b1d22',
      text: '#f2f2f5',
      muted: '#a3a3b2',
      accent: '#e8b04a',
      border: '#656572',
    },
    type: {
      family: 'System',
      baseSize: 14,
      headingWeight: 700,
    },
    shape: {
      radius: 10,
      shadow: true,
      spacing: 3,
    },
  },
  layout: {
    home: 'hero-rows',
    watch: 'cinema',
    density: 3,
  },
  calm: {
    hideShorts: false,
    hideHomeRecs: false,
    hideComments: false,
    hideEndScreens: false,
    hideViewCounts: false,
    hideLive: false,
  },
  css: '',
});

/**
 * Creates a fresh deep copy of the starter theme or a custom template.
 * @param {Partial<import('../shared/theme-schema.js').NormalizedTheme>} [overrides]
 */
export function createDefaultTheme(overrides = {}) {
  const base = JSON.parse(JSON.stringify(STARTER_THEME));
  return { ...base, ...overrides };
}

/**
 * Generates a valid slug ID from a human-readable theme name.
 * @param {string} name
 * @returns {string}
 */
export function slugifyThemeName(name) {
  if (typeof name !== 'string') return 'custom-theme';
  const clean = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (clean.length < 2) return 'custom-theme';
  return clean.slice(0, 40);
}

/**
 * Immutably updates a nested property in a theme object.
 * Paths: 'name', 'author', 'tokens.color.bg', 'tokens.type.family', 'tokens.shape.radius',
 *        'layout.home', 'layout.watch', 'layout.density', 'calm.hideShorts', 'css', etc.
 * @param {object} theme
 * @param {string} path
 * @param {any} value
 * @param {{ preserveId?: boolean }} [options]
 * @returns {object}
 */
export function updateThemeProperty(theme, path, value, options = {}) {
  if (!theme || typeof theme !== 'object') return theme;
  const segments = path.split('.');
  if (segments.some((s) => s === '__proto__' || s === 'constructor' || s === 'prototype')) {
    return theme;
  }
  const clone = JSON.parse(JSON.stringify(theme));
  let target = clone;
  for (let i = 0; i < segments.length - 1; i++) {
    const key = segments[i];
    if (!target[key] || typeof target[key] !== 'object') {
      target[key] = {};
    }
    target = target[key];
  }
  target[segments[segments.length - 1]] = value;

  // Auto-slugify id when name changes ONLY if not an existing saved theme and not preserving ID
  const preserveId = options.preserveId ?? Boolean(theme._isExisting);
  if (path === 'name' && typeof value === 'string' && !preserveId) {
    clone.id = slugifyThemeName(value);
  }

  return clone;
}

/**
 * Creates a duplicate of an existing theme with a fresh ID and (Copy) label.
 * @param {object} theme
 * @returns {object}
 */
export function cloneTheme(theme) {
  if (!theme || typeof theme !== 'object') return createDefaultTheme();
  const base = JSON.parse(JSON.stringify(theme));
  const baseName = base.name || 'Custom Theme';
  const newName = baseName.endsWith(' (Copy)') ? baseName : `${baseName} (Copy)`;
  const newId = slugifyThemeName(base.id ? `${base.id}-copy` : newName);
  return {
    ...base,
    id: newId,
    name: newName,
    _isExisting: false,
  };
}

/**
 * Runs contrast check against all 6 required WCAG AA pairs and formats the result.
 * @param {object} theme
 * @returns {{passed: boolean, passCount: number, totalCount: number, pairs: Array<{pair: string, ratio: number|null, required: number, pass: boolean}>}}
 */
export function evaluateContrast(theme) {
  const pairs = checkThemeContrast(theme);
  const totalCount = pairs.length;
  const passCount = pairs.filter((p) => p.pass).length;
  return {
    passed: passCount === totalCount,
    passCount,
    totalCount,
    pairs,
  };
}

/**
 * Validates a theme in progress for the editor.
 * Returns both schema validation report and contrast report.
 * @param {object} theme
 * @param {{selectorMap?: object}} [options]
 * @returns {{ok: boolean, theme: object|null, errors: Array<{path: string, message: string}>, warnings: Array<{path: string, message: string}>, contrast: ReturnType<typeof evaluateContrast>}}
 */
export function validateEditorTheme(theme, options = {}) {
  const contrast = evaluateContrast(theme);
  const result = validateTheme(theme, options);
  return {
    ok: result.ok,
    theme: result.theme,
    errors: result.errors,
    warnings: result.warnings,
    contrast,
  };
}

/**
 * Derives live CSS variables for the live preview iframe / container.
 * @param {object} theme
 * @param {{accent?: string|null, animations?: boolean}} [options]
 * @returns {Record<string, string>}
 */
export function computePreviewTokens(theme, options = {}) {
  return deriveTokens(theme, options);
}

/**
 * Formats a theme as an indented JSON string ready for file export.
 * @param {object} theme
 * @returns {string}
 */
export function exportThemeToJson(theme) {
  const clean = {
    schema: theme.schema || LATEST_SCHEMA,
    id: theme.id || 'custom-theme',
    name: theme.name || 'Custom Theme',
    author: theme.author || 'Anonymous',
    version: theme.version || '1.0.0',
    tier: theme.tier || 'pro',
    tokens: theme.tokens || {},
    layout: theme.layout || {},
    calm: theme.calm || {},
    css: theme.css || '',
  };
  return JSON.stringify(clean, null, 2);
}
