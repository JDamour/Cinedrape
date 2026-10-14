import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateProfile, validateSchedule, computeScheduledProfileId, resolveProfileSettings,
} from '../../src/shared/profiles.js';

describe('validateProfile', () => {
  test('accepts valid profile with full settings', () => {
    const raw = {
      id: 'day-clean',
      name: 'Day Clean',
      settings: {
        themeId: 'minimal',
        accent: '#0b57d0',
        density: 4,
        animations: false,
        textScale: 1.1,
        calm: { hideShorts: true, hideComments: false },
      },
    };
    const res = validateProfile(raw);
    assert.equal(res.ok, true);
    assert.deepEqual(res.profile, {
      id: 'day-clean',
      name: 'Day Clean',
      settings: {
        schema: 1,
        themeId: 'minimal',
        accent: '#0b57d0',
        density: 4,
        animations: false,
        textScale: 1.1,
        calm: { hideShorts: true, hideComments: false },
      },
    });
  });

  test('normalizes accent to lowercase', () => {
    const raw = {
      id: 'neon',
      name: 'Neon',
      settings: {
        themeId: 'arcade',
        accent: '#00FFCC',
      },
    };
    const res = validateProfile(raw);
    assert.equal(res.ok, true);
    assert.equal(res.profile.settings.accent, '#00ffcc');
  });

  test('rejects non-object or missing id/name', () => {
    assert.equal(validateProfile(null).ok, false);
    assert.equal(validateProfile('x').ok, false);
    assert.equal(validateProfile({ id: '', name: 'x', settings: {} }).ok, false);
    assert.equal(validateProfile({ id: 'bad id with spaces', name: 'x', settings: {} }).ok, false);
    assert.equal(validateProfile({ id: 'valid', name: '', settings: {} }).ok, false);
    assert.equal(validateProfile({ id: 'valid', name: '   ', settings: {} }).ok, false);
    assert.equal(validateProfile({ id: 'valid', name: 'a'.repeat(45), settings: {} }).ok, false);
  });

  test('rejects invalid settings', () => {
    assert.equal(validateProfile({ id: 'x', name: 'x', settings: null }).ok, false);
    assert.equal(validateProfile({ id: 'x', name: 'x', settings: { themeId: 'bad id!' } }).ok, false);
    assert.equal(validateProfile({ id: 'x', name: 'x', settings: { themeId: 'cinema', accent: 'not-hex' } }).ok, false);
    assert.equal(validateProfile({ id: 'x', name: 'x', settings: { themeId: 'cinema', density: 9 } }).ok, false);
    assert.equal(validateProfile({ id: 'x', name: 'x', settings: { themeId: 'cinema', textScale: 2.5 } }).ok, false);
  });
});

describe('validateSchedule', () => {
  test('accepts valid schedule', () => {
    const raw = {
      enabled: true,
      dayProfileId: 'day-clean',
      nightProfileId: 'cinema',
      dayTime: '07:30',
      nightTime: '19:45',
    };
    const res = validateSchedule(raw);
    assert.equal(res.ok, true);
    assert.deepEqual(res.schedule, {
      schema: 1,
      enabled: true,
      dayProfileId: 'day-clean',
      nightProfileId: 'cinema',
      dayTime: '07:30',
      nightTime: '19:45',
      manualOverrideUntil: null,
      lastError: null,
    });
  });

  test('rejects invalid times or non-object', () => {
    assert.equal(validateSchedule(null).ok, false);
    assert.equal(validateSchedule({ enabled: true, dayTime: '25:00', nightTime: '20:00' }).ok, false);
    assert.equal(validateSchedule({ enabled: true, dayTime: '08:00', nightTime: '20:60' }).ok, false);
    assert.equal(validateSchedule({ enabled: true, dayTime: '8:00', nightTime: '20:00' }).ok, false);
    assert.equal(validateSchedule({ enabled: true, dayTime: '08:00', nightTime: '08:00' }).ok, false);
    assert.equal(validateSchedule({ enabled: true, dayTime: '08:00', nightTime: '08:00' }).error, 'Choose different day and night start times.');
  });
});

describe('computeScheduledProfileId', () => {
  const schedule = {
    enabled: true,
    dayProfileId: 'day',
    nightProfileId: 'night',
    dayTime: '08:00',
    nightTime: '20:00',
  };

  test('returns null if disabled or invalid time', () => {
    assert.equal(computeScheduledProfileId({ ...schedule, enabled: false }, '12:00'), null);
    assert.equal(computeScheduledProfileId(schedule, 'invalid'), null);
    assert.equal(computeScheduledProfileId(null, '12:00'), null);
  });

  test('standard day/night range (08:00 to 20:00)', () => {
    assert.equal(computeScheduledProfileId(schedule, '07:59'), 'night');
    assert.equal(computeScheduledProfileId(schedule, '08:00'), 'day');
    assert.equal(computeScheduledProfileId(schedule, '12:00'), 'day');
    assert.equal(computeScheduledProfileId(schedule, '19:59'), 'day');
    assert.equal(computeScheduledProfileId(schedule, '20:00'), 'night');
    assert.equal(computeScheduledProfileId(schedule, '23:59'), 'night');
    assert.equal(computeScheduledProfileId(schedule, '00:00'), 'night');
  });

  test('overnight day range (22:00 to 06:00)', () => {
    const overnight = {
      enabled: true,
      dayProfileId: 'shift',
      nightProfileId: 'off',
      dayTime: '22:00',
      nightTime: '06:00',
    };
    assert.equal(computeScheduledProfileId(overnight, '21:59'), 'off');
    assert.equal(computeScheduledProfileId(overnight, '22:00'), 'shift');
    assert.equal(computeScheduledProfileId(overnight, '23:30'), 'shift');
    assert.equal(computeScheduledProfileId(overnight, '00:00'), 'shift');
    assert.equal(computeScheduledProfileId(overnight, '05:59'), 'shift');
    assert.equal(computeScheduledProfileId(overnight, '06:00'), 'off');
    assert.equal(computeScheduledProfileId(overnight, '12:00'), 'off');
  });
});

describe('resolveProfileSettings', () => {
  const profiles = {
    custom1: {
      settings: {
        schema: 1,
        themeId: 'studio',
        accent: '#123456',
        density: 2,
        animations: true,
        textScale: null,
        calm: {},
      },
    },
  };

  test('resolves custom profile', () => {
    const res = resolveProfileSettings('custom1', profiles);
    assert.equal(res.themeId, 'studio');
    assert.equal(res.accent, '#123456');
  });

  test('resolves built-in theme fallback', () => {
    const res = resolveProfileSettings('minimal', profiles);
    assert.equal(res.themeId, 'minimal');
  });

  test('returns null for unknown profile and non-theme', () => {
    assert.equal(resolveProfileSettings('unknown', profiles), null);
  });
});
