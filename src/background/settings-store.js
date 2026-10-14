// Centralized, serialized settings and collection mutation manager (Spec WP1 & WP2).
import { LIMITS, RESERVED_THEME_IDS, STORAGE_KEYS } from '../shared/constants.js';
import {
  findProfile,
  normalizeCustomThemes,
  normalizeProfiles,
  resolveProfileSettings,
  validateProfile,
} from '../shared/collections.js';
import { validateSchedule } from '../shared/profiles.js';
import { validateTheme } from '../shared/theme-schema.js';

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function utf8Bytes(str) {
  return new TextEncoder().encode(str).length;
}

/**
 * Calculates the next schedule boundary timestamp (in ms) given dayTime and nightTime ('HH:MM')
 * relative to the current local time.
 * @param {string} dayTime 'HH:MM'
 * @param {string} nightTime 'HH:MM'
 * @param {number} nowMs
 * @returns {number}
 */
export function calculateNextBoundaryMs(dayTime, nightTime, nowMs) {
  const d = new Date(nowMs);
  const year = d.getFullYear();
  const month = d.getMonth();
  const date = d.getDate();

  const [dHH, dMM] = dayTime.split(':').map(Number);
  const [nHH, nMM] = nightTime.split(':').map(Number);

  const candidates = [];
  // Today's dayTime and nightTime
  candidates.push(new Date(year, month, date, dHH, dMM, 0, 0).getTime());
  candidates.push(new Date(year, month, date, nHH, nMM, 0, 0).getTime());
  // Tomorrow's dayTime and nightTime
  candidates.push(new Date(year, month, date + 1, dHH, dMM, 0, 0).getTime());
  candidates.push(new Date(year, month, date + 1, nHH, nMM, 0, 0).getTime());

  // Filter candidates strictly in the future
  const future = candidates.filter((t) => t > nowMs).sort((a, b) => a - b);
  return future[0] || (nowMs + 12 * 3600 * 1000);
}

/**
 * Factory for serialized settings and collection store.
 * @param {object} deps
 * @param {object} deps.chrome
 * @param {() => number} [deps.now]
 * @param {{ getState: () => Promise<{ plan: string, status: string }> }} deps.licence
 * @param {() => Promise<object | null>} [deps.getSelectorMap]
 */
export function createSettingsStore(deps) {
  const { chrome, licence, now = () => Date.now(), getSelectorMap } = deps;
  if (!chrome || !chrome.storage || !chrome.storage.local) {
    throw new TypeError('createSettingsStore: chrome.storage.local is required');
  }

  let queue = Promise.resolve();
  const serial = (fn) => {
    const run = queue.then(fn);
    queue = run.catch(() => {});
    return run;
  };

  async function checkPro() {
    if (!licence || typeof licence.getState !== 'function') return false;
    const lic = await licence.getState();
    return lic.plan === 'pro' && (lic.status === 'active' || lic.status === 'grace');
  }

  // ---- Read Methods (transparently normalise legacy shapes) ---------------------------------------------

  async function getProfilesRecord() {
    const got = await chrome.storage.local.get(STORAGE_KEYS.profiles);
    const raw = got ? got[STORAGE_KEYS.profiles] : undefined;
    const { record, changed } = normalizeProfiles(raw);
    if (changed) {
      await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: record });
    }
    return record;
  }

  async function getCustomThemesRecord() {
    const got = await chrome.storage.local.get(STORAGE_KEYS.customThemes);
    const raw = got ? got[STORAGE_KEYS.customThemes] : undefined;
    const selectorMap = getSelectorMap ? await getSelectorMap() : null;
    const { record, changed } = normalizeCustomThemes(raw, { selectorMap });
    if (changed) {
      await chrome.storage.local.set({ [STORAGE_KEYS.customThemes]: record });
    }
    return record;
  }

  async function getScheduleRecord() {
    const got = await chrome.storage.local.get(STORAGE_KEYS.schedule);
    const raw = got ? got[STORAGE_KEYS.schedule] : undefined;
    const val = validateSchedule(raw);
    return val.ok ? val.schedule : null;
  }

  async function getSettingsRecord() {
    const got = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return (got && isPlainObject(got[STORAGE_KEYS.settings])) ? got[STORAGE_KEYS.settings] : null;
  }

  // ---- Mutation Methods (serialized) --------------------------------------------------------------------

  async function saveProfile(profile, expectedRevision) {
    return serial(async () => {
      const isPro = await checkPro();
      if (!isPro) return { ok: false, reason: 'requires-pro' };

      const val = validateProfile(profile);
      if (!val.ok) return { ok: false, reason: 'invalid', error: val.error };

      const current = await getProfilesRecord();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision, record: current };
      }

      const existingIndex = current.items.findIndex((p) => p.id === val.profile.id);
      const isNew = existingIndex === -1;
      const maxProfiles = LIMITS.maxProfiles || 10;

      if (isNew && current.items.length >= maxProfiles) {
        return { ok: false, reason: 'limit', message: `Maximum ${maxProfiles} profiles allowed` };
      }

      const updatedItems = [...current.items];
      if (isNew) {
        updatedItems.push(val.profile);
      } else {
        updatedItems[existingIndex] = val.profile;
      }

      const newRecord = {
        schema: 1,
        revision: current.revision + 1,
        items: updatedItems,
      };

      await chrome.storage.local.set({ [STORAGE_KEYS.profiles]: newRecord });
      return { ok: true, revision: newRecord.revision, saved: val.profile.id, record: newRecord };
    });
  }

  async function deleteProfile(id, expectedRevision) {
    return serial(async () => {
      const isPro = await checkPro();
      if (!isPro) return { ok: false, reason: 'requires-pro' };

      const current = await getProfilesRecord();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision, record: current };
      }

      const updatedItems = current.items.filter((p) => p.id !== id);
      const newRecord = {
        schema: 1,
        revision: current.revision + 1,
        items: updatedItems,
      };

      const writes = { [STORAGE_KEYS.profiles]: newRecord };

      // Reference integrity: if schedule uses this profile, disable schedule and record lastError
      const schedule = await getScheduleRecord();
      if (schedule && (schedule.dayProfileId === id || schedule.nightProfileId === id)) {
        writes[STORAGE_KEYS.schedule] = {
          ...schedule,
          enabled: false,
          lastError: 'missing-profile',
        };
      }

      await chrome.storage.local.set(writes);
      return { ok: true, revision: newRecord.revision, record: newRecord };
    });
  }

  async function applyProfile(id) {
    return serial(async () => {
      const isPro = await checkPro();
      if (!isPro) return { ok: false, reason: 'requires-pro' };

      const profilesRecord = await getProfilesRecord();
      const profile = findProfile(profilesRecord, id);
      if (!profile || !profile.settings) {
        return { ok: false, reason: 'not-found' };
      }

      const currentSettings = (await getSettingsRecord()) || {};
      const { schema, ...patch } = profile.settings;
      const merged = { ...currentSettings, ...patch };

      // If schedule is active, applying a profile manually pauses schedule application until next boundary
      const schedule = await getScheduleRecord();
      const writes = { [STORAGE_KEYS.settings]: merged };

      if (schedule && schedule.enabled) {
        const nextBoundary = calculateNextBoundaryMs(schedule.dayTime, schedule.nightTime, now());
        writes[STORAGE_KEYS.schedule] = {
          ...schedule,
          manualOverrideUntil: nextBoundary,
        };
      }

      await chrome.storage.local.set(writes);
      return { ok: true, applied: true, settings: merged };
    });
  }

  async function saveTheme(theme, options = {}) {
    const { mode = 'create', expectedRevision, apply = false } = options;
    return serial(async () => {
      const isPro = await checkPro();
      if (!isPro) return { ok: false, reason: 'requires-pro' };

      if (RESERVED_THEME_IDS.includes(theme?.id)) {
        return { ok: false, reason: 'reserved-id', message: `Cannot use reserved theme ID "${theme.id}"` };
      }

      const selectorMap = getSelectorMap ? await getSelectorMap() : null;
      if (theme?.css && !selectorMap) {
        return { ok: false, reason: 'map-unavailable', message: 'Selector map unavailable for CSS validation' };
      }

      const val = validateTheme(theme, { selectorMap });
      if (!val.ok || !val.theme) {
        return { ok: false, reason: 'invalid', issues: val.errors };
      }

      const current = await getCustomThemesRecord();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision, record: current };
      }

      const exists = Boolean(current.items[val.theme.id]);
      if (mode === 'create' && exists) {
        return { ok: false, reason: 'conflict', exists: true, message: `Theme ID "${val.theme.id}" already exists` };
      }

      const maxThemes = LIMITS.maxCustomThemes || 10;
      if (!exists && Object.keys(current.items).length >= maxThemes) {
        return { ok: false, reason: 'limit', message: `Maximum ${maxThemes} custom themes allowed` };
      }

      const serialized = JSON.stringify(val.theme);
      const maxBytes = LIMITS.maxCustomThemeBytes || 65536;
      if (utf8Bytes(serialized) > maxBytes) {
        return { ok: false, reason: 'limit', message: `Theme exceeds maximum allowed size of ${maxBytes / 1024} KB` };
      }

      const updatedItems = { ...current.items, [val.theme.id]: val.theme };
      const newRecord = {
        schema: 1,
        revision: current.revision + 1,
        items: updatedItems,
      };

      const writes = { [STORAGE_KEYS.customThemes]: newRecord };

      if (apply) {
        const currentSettings = (await getSettingsRecord()) || {};
        writes[STORAGE_KEYS.settings] = { ...currentSettings, themeId: val.theme.id };

        // Manual theme change while schedule is active triggers manual override
        const schedule = await getScheduleRecord();
        if (schedule && schedule.enabled) {
          const nextBoundary = calculateNextBoundaryMs(schedule.dayTime, schedule.nightTime, now());
          writes[STORAGE_KEYS.schedule] = { ...schedule, manualOverrideUntil: nextBoundary };
        }
      }

      await chrome.storage.local.set(writes);
      return {
        ok: true,
        revision: newRecord.revision,
        saved: val.theme.id,
        selected: Boolean(apply),
        record: newRecord,
      };
    });
  }

  async function deleteTheme(id, options = {}) {
    const { expectedRevision, resetReferences = false } = options;
    return serial(async () => {
      const isPro = await checkPro();
      if (!isPro) return { ok: false, reason: 'requires-pro' };

      const current = await getCustomThemesRecord();
      if (expectedRevision !== undefined && expectedRevision !== current.revision) {
        return { ok: false, reason: 'conflict', currentRevision: current.revision, record: current };
      }

      if (!current.items[id]) {
        return { ok: false, reason: 'not-found' };
      }

      // Check references: settings.themeId and profiles
      const settings = (await getSettingsRecord()) || {};
      const profilesRecord = await getProfilesRecord();

      const isActiveInSettings = settings.themeId === id;
      const affectedProfiles = profilesRecord.items
        .filter((p) => p.settings && p.settings.themeId === id)
        .map((p) => p.name);

      const isReferenced = isActiveInSettings || affectedProfiles.length > 0;

      if (isReferenced && !resetReferences) {
        return {
          ok: false,
          reason: 'referenced',
          affectedProfiles,
          activeSettings: isActiveInSettings,
        };
      }

      const writes = {};

      if (isReferenced && resetReferences) {
        if (isActiveInSettings) {
          writes[STORAGE_KEYS.settings] = { ...settings, themeId: 'cinema' };
        }
        if (affectedProfiles.length > 0) {
          const repairedItems = profilesRecord.items.map((p) => {
            if (p.settings && p.settings.themeId === id) {
              return { ...p, settings: { ...p.settings, themeId: 'cinema' } };
            }
            return p;
          });
          writes[STORAGE_KEYS.profiles] = {
            schema: 1,
            revision: profilesRecord.revision + 1,
            items: repairedItems,
          };
        }
      }

      const updatedItems = { ...current.items };
      delete updatedItems[id];

      const newRecord = {
        schema: 1,
        revision: current.revision + 1,
        items: updatedItems,
      };
      writes[STORAGE_KEYS.customThemes] = newRecord;

      await chrome.storage.local.set(writes);
      return { ok: true, revision: newRecord.revision, record: newRecord };
    });
  }

  async function updateSchedule(scheduleInput) {
    return serial(async () => {
      const val = validateSchedule(scheduleInput);
      if (!val.ok) return { ok: false, reason: 'invalid', error: val.error };

      const schedule = val.schedule;
      if (schedule.enabled) {
        const isPro = await checkPro();
        if (!isPro) return { ok: false, reason: 'requires-pro' };

        // Reference check: both dayProfileId and nightProfileId must be resolvable
        const profilesRecord = await getProfilesRecord();
        const daySettings = resolveProfileSettings(schedule.dayProfileId, profilesRecord);
        const nightSettings = resolveProfileSettings(schedule.nightProfileId, profilesRecord);

        if (!daySettings || !nightSettings) {
          return { ok: false, reason: 'invalid-reference', error: 'Day and night profiles must resolve to valid profiles' };
        }

        // Editing or updating schedule explicitly clears any manual override and lastError
        schedule.manualOverrideUntil = null;
        schedule.lastError = null;
      }

      await chrome.storage.local.set({ [STORAGE_KEYS.schedule]: schedule });
      return { ok: true, schedule };
    });
  }

  async function saveSettings(patch) {
    return serial(async () => {
      if (!isPlainObject(patch)) return { ok: false, reason: 'invalid' };

      const current = (await getSettingsRecord()) || {};
      const merged = { ...current, ...patch };

      const writes = { [STORAGE_KEYS.settings]: merged };

      // If schedule is active and manual changes were made to theme/layout/density/calm
      const schedule = await getScheduleRecord();
      if (schedule && schedule.enabled) {
        const nextBoundary = calculateNextBoundaryMs(schedule.dayTime, schedule.nightTime, now());
        writes[STORAGE_KEYS.schedule] = {
          ...schedule,
          manualOverrideUntil: nextBoundary,
        };
      }

      await chrome.storage.local.set(writes);
      return { ok: true };
    });
  }

  return {
    getProfilesRecord,
    getCustomThemesRecord,
    getScheduleRecord,
    getSettingsRecord,
    saveProfile,
    deleteProfile,
    applyProfile,
    saveTheme,
    deleteTheme,
    updateSchedule,
    saveSettings,
  };
}
