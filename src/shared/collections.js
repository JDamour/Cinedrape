// Shared collection normalisation, validation, migration, and lookup interfaces (Spec WP1, ARCHITECTURE.md §3).
import { ALL_THEME_IDS, CALM_KEYS, LIMITS } from './constants.js';
import { validateTheme } from './theme-schema.js';

export const RESERVED_THEME_IDS = Object.freeze([...ALL_THEME_IDS, 'broadcast']);

const SAFE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const HEX_RE = /^#[0-9a-fA-F]{6}$/;
const VALID_DENSITIES = new Set([1, 2, 3, 4, 5]);
const VALID_TEXT_SCALES = new Set([0.9, 1, 1.1, 1.25, 1.5]);

export const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * Validates a profile settings snapshot against the whitelist.
 * @param {unknown} raw
 * @param {{ knownThemeIds?: string[] }} [options]
 * @returns {{ ok: true, settings: object } | { ok: false, error: string }}
 */
export function validateSettingsSnapshot(raw, options = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: 'Settings snapshot must be an object' };

  const { themeId, accent, density, animations, textScale, calm } = raw;

  if (typeof themeId !== 'string' || !SAFE_ID_RE.test(themeId)) {
    return { ok: false, error: 'Invalid themeId in settings snapshot' };
  }
  if (Array.isArray(options.knownThemeIds) && options.knownThemeIds.length > 0) {
    if (!options.knownThemeIds.includes(themeId)) {
      return { ok: false, error: `Unknown themeId "${themeId}" in settings snapshot` };
    }
  }

  let cleanAccent = null;
  if (accent !== null && accent !== undefined) {
    if (typeof accent !== 'string' || !HEX_RE.test(accent)) {
      return { ok: false, error: 'Accent must be #rrggbb hex or null' };
    }
    cleanAccent = accent.toLowerCase();
  }

  let cleanDensity = null;
  if (density !== null && density !== undefined) {
    if (!VALID_DENSITIES.has(density)) {
      return { ok: false, error: 'Density must be an integer 1-5 or null' };
    }
    cleanDensity = density;
  }

  const cleanAnimations = animations !== false;

  let cleanTextScale = null;
  if (textScale !== null && textScale !== undefined) {
    if (!VALID_TEXT_SCALES.has(textScale)) {
      return { ok: false, error: 'textScale must be 0.9, 1, 1.1, 1.25, 1.5 or null' };
    }
    cleanTextScale = textScale;
  }

  const cleanCalm = {};
  if (isPlainObject(calm)) {
    for (const k of CALM_KEYS) {
      if (typeof calm[k] === 'boolean') {
        cleanCalm[k] = calm[k];
      }
    }
  }

  return {
    ok: true,
    settings: {
      schema: 1,
      themeId,
      accent: cleanAccent,
      density: cleanDensity,
      animations: cleanAnimations,
      textScale: cleanTextScale,
      calm: cleanCalm,
    },
  };
}

/**
 * Validates a single profile: { id, name, settings }.
 * @param {unknown} raw
 * @param {{ knownThemeIds?: string[] }} [options]
 * @returns {{ ok: true, profile: { id: string, name: string, settings: object } } | { ok: false, error: string }}
 */
export function validateProfile(raw, options = {}) {
  if (!isPlainObject(raw)) return { ok: false, error: 'Profile must be an object' };

  if (typeof raw.id !== 'string' || !SAFE_ID_RE.test(raw.id)) {
    return { ok: false, error: 'Profile ID must be 1-32 alphanumeric characters, dashes or underscores' };
  }

  if (typeof raw.name !== 'string' || raw.name.trim().length === 0 || raw.name.trim().length > 40) {
    return { ok: false, error: 'Profile name must be 1-40 characters' };
  }

  const settingsVal = validateSettingsSnapshot(raw.settings, options);
  if (!settingsVal.ok) {
    return { ok: false, error: settingsVal.error };
  }

  return {
    ok: true,
    profile: {
      id: raw.id,
      name: raw.name.trim(),
      settings: settingsVal.settings,
    },
  };
}

/**
 * Normalises raw profiles storage into a canonical versioned envelope.
 * Handles:
 *  - Envelope: { schema: 1, revision: N, items: [...] }
 *  - Legacy array: [ { id, name, settings }, ... ]
 *  - Legacy map: { [id]: { id?, name, settings } }
 *  - Future unknown schemas (schema > 1): returned as-is with issue and unknownSchema: true.
 *
 * @param {unknown} raw
 * @param {{ knownThemeIds?: string[] }} [options]
 * @returns {{ record: { schema: number, revision: number, items: Array<{ id: string, name: string, settings: object }> }, issues: Array<{ id?: string, message: string }>, changed: boolean, unknownSchema?: boolean }}
 */
export function normalizeProfiles(raw, options = {}) {
  if (raw === null || raw === undefined) {
    return {
      record: { schema: 1, revision: 0, items: [] },
      issues: [],
      changed: false,
    };
  }

  // Future schema check: do not downgrade or mutate unknown schema
  if (isPlainObject(raw) && typeof raw.schema === 'number' && raw.schema > 1) {
    return {
      record: raw,
      issues: [{ message: `unknown-schema: ${raw.schema}` }],
      changed: false,
      unknownSchema: true,
    };
  }

  const issues = [];
  let changed = false;
  let revision = 0;
  let rawList = [];

  if (Array.isArray(raw)) {
    // Legacy array representation
    rawList = raw;
    changed = true;
  } else if (isPlainObject(raw)) {
    if (Array.isArray(raw.items)) {
      // Standard envelope
      rawList = raw.items;
      if (Number.isInteger(raw.revision) && raw.revision >= 0) {
        revision = raw.revision;
      } else {
        changed = true;
      }
      if (raw.schema !== 1) changed = true;
    } else {
      // Legacy ID-keyed object map
      rawList = Object.entries(raw).map(([key, val]) => {
        if (isPlainObject(val) && !val.id) return { ...val, id: key };
        return val;
      });
      changed = true;
    }
  } else {
    // Corrupted non-object / non-array value
    issues.push({ message: 'Corrupted profiles collection replaced with empty envelope' });
    return {
      record: { schema: 1, revision: 0, items: [] },
      issues,
      changed: true,
    };
  }

  const items = [];
  const seenIds = new Set();
  const maxProfiles = LIMITS.maxProfiles || 10;

  for (const entry of rawList) {
    if (items.length >= maxProfiles) {
      issues.push({ id: entry?.id, message: `Dropped profile exceeding max limit of ${maxProfiles}` });
      changed = true;
      continue;
    }

    const val = validateProfile(entry, options);
    if (!val.ok) {
      issues.push({ id: entry?.id, message: val.error });
      changed = true;
      continue;
    }

    if (seenIds.has(val.profile.id)) {
      issues.push({ id: val.profile.id, message: `Duplicate profile ID "${val.profile.id}" dropped` });
      changed = true;
      continue;
    }

    seenIds.add(val.profile.id);
    items.push(val.profile);
  }

  return {
    record: {
      schema: 1,
      revision,
      items,
    },
    issues,
    changed,
  };
}

/**
 * Normalises raw customThemes storage into a canonical versioned envelope.
 * Handles:
 *  - Envelope: { schema: 1, revision: N, items: { [id]: theme } }
 *  - Legacy map: { [id]: theme }
 *  - Future unknown schemas (schema > 1): returned as-is with unknownSchema: true.
 *
 * @param {unknown} raw
 * @param {{ selectorMap?: object, bundledIds?: string[] }} [options]
 * @returns {{ record: { schema: number, revision: number, items: Record<string, object> }, issues: Array<{ id?: string, message: string }>, changed: boolean, unknownSchema?: boolean }}
 */
export function normalizeCustomThemes(raw, options = {}) {
  if (raw === null || raw === undefined) {
    return {
      record: { schema: 1, revision: 0, items: {} },
      issues: [],
      changed: false,
    };
  }

  // Future schema check
  if (isPlainObject(raw) && typeof raw.schema === 'number' && raw.schema > 1) {
    return {
      record: raw,
      issues: [{ message: `unknown-schema: ${raw.schema}` }],
      changed: false,
      unknownSchema: true,
    };
  }

  const issues = [];
  let changed = false;
  let revision = 0;
  let rawMap = {};

  if (isPlainObject(raw)) {
    if (isPlainObject(raw.items)) {
      rawMap = raw.items;
      if (Number.isInteger(raw.revision) && raw.revision >= 0) {
        revision = raw.revision;
      } else {
        changed = true;
      }
      if (raw.schema !== 1) changed = true;
    } else {
      // Legacy ID map without envelope
      rawMap = raw;
      changed = true;
    }
  } else {
    issues.push({ message: 'Corrupted customThemes collection replaced with empty envelope' });
    return {
      record: { schema: 1, revision: 0, items: {} },
      issues,
      changed: true,
    };
  }

  const items = {};
  const maxCustomThemes = LIMITS.maxCustomThemes || 10;
  const reserved = new Set(options.bundledIds || RESERVED_THEME_IDS);

  for (const [id, theme] of Object.entries(rawMap)) {
    if (Object.keys(items).length >= maxCustomThemes) {
      issues.push({ id, message: `Dropped custom theme exceeding limit of ${maxCustomThemes}` });
      changed = true;
      continue;
    }

    if (reserved.has(id)) {
      issues.push({ id, message: `Custom theme cannot use reserved bundled ID "${id}"` });
      changed = true;
      continue;
    }

    if (!isPlainObject(theme) || theme.id !== id) {
      issues.push({ id, message: 'Invalid theme object or mismatched ID' });
      changed = true;
      continue;
    }

    const val = validateTheme(theme, options);
    if (!val.ok || !val.theme) {
      issues.push({ id, message: val.errors?.[0]?.message || 'Schema validation failure' });
      changed = true;
      continue;
    }

    items[id] = val.theme;
  }

  return {
    record: {
      schema: 1,
      revision,
      items,
    },
    issues,
    changed,
  };
}

/**
 * Finds a profile by ID in any supported collection shape (envelope, array, or legacy map).
 * @param {unknown} collection
 * @param {string} id
 * @returns {{ id: string, name: string, settings: object } | null}
 */
export function findProfile(collection, id) {
  if (!id || typeof id !== 'string') return null;
  if (!collection) return null;

  if (Array.isArray(collection)) {
    const found = collection.find((p) => p && p.id === id);
    return found || null;
  }

  if (isPlainObject(collection)) {
    if (Array.isArray(collection.items)) {
      const found = collection.items.find((p) => p && p.id === id);
      return found || null;
    }
    if (isPlainObject(collection[id])) {
      return collection[id];
    }
  }

  return null;
}

/**
 * Resolves settings for a profile ID:
 * 1. Saved profile lookup first (from envelope, array, or map).
 * 2. Bundled theme defaults if applicable (for backward compatibility).
 * Does NOT treat arbitrary custom theme IDs as profile IDs.
 *
 * @param {string} profileId
 * @param {unknown} [profilesRecord]
 * @param {object[]} [themeCatalog]
 * @returns {object | null}
 */
export function resolveProfileSettings(profileId, profilesRecord, themeCatalog) {
  if (typeof profileId !== 'string') return null;

  // 1. Saved profile lookup
  const profile = findProfile(profilesRecord, profileId);
  if (profile && isPlainObject(profile.settings)) {
    const snap = validateSettingsSnapshot(profile.settings);
    if (snap.ok) return snap.settings;
  }

  // 2. Bundled theme defaults fallback
  if (ALL_THEME_IDS.includes(profileId)) {
    return {
      schema: 1,
      themeId: profileId,
      accent: null,
      density: null,
      animations: true,
      textScale: null,
      calm: {},
    };
  }

  return null;
}

/**
 * Checks whether a theme ID is a reserved launch/template ID.
 * @param {string} id
 * @returns {boolean}
 */
export function isReservedThemeId(id) {
  return typeof id === 'string' && RESERVED_THEME_IDS.includes(id);
}

/**
 * Generates a stable unique custom theme ID from a human-readable name.
 * Format: 'custom-<slug>' (2-40 chars, ^[a-z0-9-]{2,40}$).
 *
 * @param {string} name
 * @param {string[]} [existingIds=[]]
 * @returns {string}
 */
export function slugifyThemeId(name, existingIds = []) {
  const baseSlug = typeof name === 'string'
    ? name
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
    : '';

  const prefix = 'custom-';
  let core = baseSlug.length > 0 ? baseSlug : 'theme';
  // Clamp core length so prefix + core fits within 40 characters
  core = core.slice(0, 40 - prefix.length).replace(/-+$/, '');
  let candidate = `${prefix}${core}`;

  if (!existingIds.includes(candidate)) {
    return candidate;
  }

  // Deduplicate with suffix
  let counter = 2;
  while (counter < 1000) {
    const suffix = `-${counter}`;
    const truncatedCore = core.slice(0, 40 - prefix.length - suffix.length).replace(/-+$/, '');
    candidate = `${prefix}${truncatedCore}${suffix}`;
    if (!existingIds.includes(candidate)) {
      return candidate;
    }
    counter++;
  }
  return `custom-${Date.now().toString(36)}`;
}
