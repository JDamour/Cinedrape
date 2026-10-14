import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createChromeMock } from '../helpers/chrome-mock.js';
import { createSettingsStore } from '../../src/background/settings-store.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

function makeMockLicence(isPro = true) {
  return {
    async getState() {
      return isPro
        ? { plan: 'pro', status: 'active' }
        : { plan: 'free', status: 'none' };
    },
  };
}

describe('settings-store profile mutations', () => {
  test('rejects saveProfile for free users', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(false) });
    const res = await store.saveProfile({
      id: 'prof-test',
      name: 'Test',
      settings: { themeId: 'cinema' },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'requires-pro');
  });

  test('saves profile with revision increment and detects revision conflicts', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(true) });

    const p1 = {
      id: 'prof-1',
      name: 'Profile One',
      settings: { themeId: 'minimal', density: 3 },
    };
    const res1 = await store.saveProfile(p1);
    assert.equal(res1.ok, true);
    assert.equal(res1.revision, 1);
    assert.equal(res1.saved, 'prof-1');

    // Attempt save with stale revision
    const p2 = {
      id: 'prof-2',
      name: 'Profile Two',
      settings: { themeId: 'classic' },
    };
    const resConflict = await store.saveProfile(p2, 0); // expected 0, but current is 1
    assert.equal(resConflict.ok, false);
    assert.equal(resConflict.reason, 'conflict');
    assert.equal(resConflict.currentRevision, 1);

    // Save with matching revision succeeds
    const res2 = await store.saveProfile(p2, 1);
    assert.equal(res2.ok, true);
    assert.equal(res2.revision, 2);

    const stored = (await chrome.storage.local.get(STORAGE_KEYS.profiles))[STORAGE_KEYS.profiles];
    assert.equal(stored.items.length, 2);
  });

  test('deleteProfile removes profile and disables schedule if referenced', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(true) });

    await store.saveProfile({ id: 'prof-day', name: 'Day', settings: { themeId: 'minimal' } });
    await store.saveProfile({ id: 'prof-night', name: 'Night', settings: { themeId: 'cinema' } });

    await chrome.storage.local.set({
      [STORAGE_KEYS.schedule]: {
        schema: 1,
        enabled: true,
        dayProfileId: 'prof-day',
        nightProfileId: 'prof-night',
        dayTime: '08:00',
        nightTime: '20:00',
      },
    });

    // Delete prof-day
    const delRes = await store.deleteProfile('prof-day');
    assert.equal(delRes.ok, true);

    const sched = (await chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.equal(sched.enabled, false);
    assert.equal(sched.lastError, 'missing-profile');
  });

  test('applyProfile updates settings and sets manual override if schedule active', async () => {
    const { chrome } = createChromeMock();
    const now = () => new Date('2026-10-14T10:00:00').getTime();
    const store = createSettingsStore({ chrome, now, licence: makeMockLicence(true) });

    await store.saveProfile({
      id: 'prof-work',
      name: 'Work',
      settings: { themeId: 'studio', accent: '#aabbcc', density: 4 },
    });

    await chrome.storage.local.set({
      [STORAGE_KEYS.schedule]: {
        schema: 1,
        enabled: true,
        dayProfileId: 'prof-work',
        nightProfileId: 'cinema',
        dayTime: '08:00',
        nightTime: '20:00',
      },
    });

    const res = await store.applyProfile('prof-work');
    assert.equal(res.ok, true);
    assert.equal(res.applied, true);

    const settings = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(settings.themeId, 'studio');
    assert.equal(settings.accent, '#aabbcc');

    const sched = (await chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.ok(typeof sched.manualOverrideUntil === 'number');
    assert.ok(sched.manualOverrideUntil > now());
  });
});

describe('settings-store theme mutations', () => {
  const validTheme = {
    schema: 1,
    id: 'custom-gold',
    name: 'Gold Coast',
    author: 'Author',
    version: '1.0.0',
    tier: 'pro',
    tokens: {
      color: { bg: '#111216', surface: '#1b1d22', text: '#f2f2f5', muted: '#a3a3b2', accent: '#e8b04a', border: '#656572' },
      type: { family: 'System', baseSize: 14, headingWeight: 700 },
      shape: { radius: 10, shadow: true, spacing: 3 },
    },
    layout: { home: 'grid', watch: 'default', density: 3 },
    calm: {},
    css: '',
  };

  test('rejects reserved IDs', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(true) });
    const res = await store.saveTheme({ ...validTheme, id: 'cinema' });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'reserved-id');
  });

  test('saves custom theme and handles apply flag in single atomic write', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(true) });

    const res = await store.saveTheme(validTheme, { apply: true });
    assert.equal(res.ok, true);
    assert.equal(res.saved, 'custom-gold');
    assert.equal(res.selected, true);

    const storedThemes = (await chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
    assert.ok(storedThemes.items['custom-gold']);

    const storedSettings = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(storedSettings.themeId, 'custom-gold');
  });

  test('deleteTheme detects references and resets cleanly when requested', async () => {
    const { chrome } = createChromeMock();
    const store = createSettingsStore({ chrome, licence: makeMockLicence(true) });

    await store.saveTheme(validTheme, { apply: true });
    await store.saveProfile({
      id: 'prof-gold',
      name: 'Gold Profile',
      settings: { themeId: 'custom-gold' },
    });

    // Try delete without resetReferences -> rejected with details
    const delBlocked = await store.deleteTheme('custom-gold', { resetReferences: false });
    assert.equal(delBlocked.ok, false);
    assert.equal(delBlocked.reason, 'referenced');
    assert.equal(delBlocked.activeSettings, true);
    assert.deepEqual(delBlocked.affectedProfiles, ['Gold Profile']);

    // Delete with resetReferences: true -> resets settings and profile to 'cinema'
    const delClean = await store.deleteTheme('custom-gold', { resetReferences: true });
    assert.equal(delClean.ok, true);

    const themes = (await chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
    assert.equal(themes.items['custom-gold'], undefined);

    const settings = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(settings.themeId, 'cinema');

    const profiles = (await chrome.storage.local.get(STORAGE_KEYS.profiles))[STORAGE_KEYS.profiles];
    assert.equal(profiles.items[0].settings.themeId, 'cinema');
  });
});
