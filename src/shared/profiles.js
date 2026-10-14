// Profile and time-based schedule helpers (Spec F8, WP1, WP2, ARCHITECTURE.md §3.2).
import { DEFAULT_SCHEDULE } from './constants.js';
import {
  isPlainObject,
  validateSettingsSnapshot,
  validateProfile as validateProfileCollection,
  normalizeProfiles,
  findProfile,
  resolveProfileSettings as resolveProfileSettingsCollection,
} from './collections.js';

export {
  validateSettingsSnapshot,
  normalizeProfiles,
  findProfile,
};

export const validateProfile = validateProfileCollection;
export const resolveProfileSettings = resolveProfileSettingsCollection;

const SAFE_ID_RE = /^[a-z0-9_-]{1,32}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Validates a schedule configuration.
 * @param {unknown} raw
 * @returns {{ ok: true, schedule: object } | { ok: false, error: string }}
 */
export function validateSchedule(raw) {
  if (!isPlainObject(raw)) return { ok: false, error: 'Schedule must be an object' };

  if (typeof raw.enabled !== 'boolean') {
    return { ok: false, error: 'Schedule enabled must be a boolean' };
  }

  const enabled = raw.enabled;

  if (typeof raw.dayTime !== 'string' || !TIME_RE.test(raw.dayTime)) {
    return { ok: false, error: 'dayTime must be in HH:MM 24-hour format' };
  }
  if (typeof raw.nightTime !== 'string' || !TIME_RE.test(raw.nightTime)) {
    return { ok: false, error: 'nightTime must be in HH:MM 24-hour format' };
  }

  if (raw.dayTime === raw.nightTime) {
    return { ok: false, error: 'Choose different day and night start times.' };
  }

  const dayProfileId = typeof raw.dayProfileId === 'string' && SAFE_ID_RE.test(raw.dayProfileId)
    ? raw.dayProfileId : null;
  const nightProfileId = typeof raw.nightProfileId === 'string' && SAFE_ID_RE.test(raw.nightProfileId)
    ? raw.nightProfileId : null;

  if (enabled && (!dayProfileId || !nightProfileId)) {
    return { ok: false, error: 'Schedule requires valid day and night profile references' };
  }

  const manualOverrideUntil = typeof raw.manualOverrideUntil === 'number' && Number.isFinite(raw.manualOverrideUntil)
    ? raw.manualOverrideUntil
    : null;

  const lastError = typeof raw.lastError === 'string' && raw.lastError.length <= 100
    ? raw.lastError
    : null;

  return {
    ok: true,
    schedule: {
      schema: 1,
      enabled,
      dayProfileId: dayProfileId || DEFAULT_SCHEDULE.dayProfileId,
      nightProfileId: nightProfileId || DEFAULT_SCHEDULE.nightProfileId,
      dayTime: raw.dayTime,
      nightTime: raw.nightTime,
      manualOverrideUntil,
      lastError,
    },
  };
}

/**
 * Returns which profile ID should be active according to schedule and current time.
 * @param {{ enabled: boolean, dayProfileId: string, nightProfileId: string, dayTime: string, nightTime: string }} schedule
 * @param {string} currentTimeString 'HH:MM'
 * @returns {string|null}
 */
export function computeScheduledProfileId(schedule, currentTimeString) {
  if (!schedule || !schedule.enabled) return null;
  if (typeof currentTimeString !== 'string' || !TIME_RE.test(currentTimeString)) return null;

  const { dayTime, nightTime, dayProfileId, nightProfileId } = schedule;

  if (dayTime <= nightTime) {
    if (currentTimeString >= dayTime && currentTimeString < nightTime) {
      return dayProfileId;
    }
    return nightProfileId;
  }

  // Overnight range (e.g. day starts at 20:00, night starts at 06:00)
  if (currentTimeString >= dayTime || currentTimeString < nightTime) {
    return dayProfileId;
  }
  return nightProfileId;
}
