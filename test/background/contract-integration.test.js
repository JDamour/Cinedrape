import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChromeMock } from '../helpers/chrome-mock.js';
import { createBackground, ALARM_SCHEDULE } from '../../src/background/service-worker.js';
import { STORAGE_KEYS, MSG, DEFAULT_SCHEDULE } from '../../src/shared/constants.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { signEnvelope, toPublicJwk } from '../../src/shared/signing.js';
import { messages, isWorkerReply, describeFailure } from '../../src/shared/messages.js';

const SOURCE_MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const priv = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { priv, pub: toPublicJwk(priv) };
}

describe('F1-F5 integration: popup & editor worker contract and scheduling', () => {
  async function setupIntegration(clockTime = '2026-10-14T09:00:00') {
    let nowMs = new Date(clockTime).getTime();
    const now = () => nowMs;
    const advance = (ms) => { nowMs += ms; return nowMs; };

    const LICENCE = await makeKeyPair('lic-key');
    const MAPKEY = await makeKeyPair('map-key');

    const { chrome } = createChromeMock({ now });
    const map = structuredClone(SOURCE_MAP);
    map.mapVersion = '2026.10.14.1';
    const envelope = await signEnvelope(JSON.stringify(map), MAPKEY.priv, 'map-key');

    const bg = createBackground({
      chrome,
      now,
      keys: { licence: LICENCE.pub, selectorMap: MAPKEY.pub },
      readBundledVersion: async () => '2026.10.14.1',
      readBundledMap: async () => map,
    });
    bg.register();
    await bg.handleInstalled();

    const token = await signLicenceToken(
      { v: 1, sub: 'user-pro', plan: 'pro', iat: Math.floor(now() / 1000) - 60 },
      LICENCE.priv
    );
    const act = await chrome.runtime.sendMessage({ type: MSG.ACTIVATE_LICENCE, token });
    assert.equal(act.ok, true);

    return { chrome, now, advance, map };
  }

  test('F1: popup deleteTheme removes custom theme and resets active settings to cinema', async () => {
    const { chrome } = await setupIntegration();

    // Save a custom theme
    const customTheme = {
      schema: 1,
      id: 'custom-vapor',
      name: 'Vaporwave',
      author: 'Author',
      version: '1.0.0',
      tier: 'pro',
      tokens: {
        color: { bg: '#08080f', surface: '#141423', text: '#fbfbff', muted: '#9b9bb2', accent: '#ff2d6c', border: '#72728f' },
        type: { family: 'System', baseSize: 14, headingWeight: 700 },
        shape: { radius: 8, shadow: true, spacing: 3 },
      },
      layout: { home: 'grid', watch: 'default', density: 3 },
      calm: {},
      css: '',
    };

    const saveRes = await chrome.runtime.sendMessage(messages.saveTheme(customTheme, { apply: true }));
    assert.equal(saveRes.ok, true);

    const settingsAfterSave = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(settingsAfterSave.themeId, 'custom-vapor');

    // Popup sends deleteTheme with resetReferences: true
    const delRes = await chrome.runtime.sendMessage(messages.deleteTheme('custom-vapor', { resetReferences: true }));
    assert.equal(delRes.ok, true);
    assert.equal(delRes.record.items['custom-vapor'], undefined);

    const settingsAfterDelete = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(settingsAfterDelete.themeId, 'cinema');
  });

  test('F1: popup applyProfile updates settings and deleteProfile cleans up references', async () => {
    const { chrome } = await setupIntegration();

    const profile = {
      id: 'prof-chill',
      name: 'Chill',
      settings: {
        schema: 1,
        themeId: 'classic',
        accent: '#22bb33',
        density: 2,
        animations: true,
        textScale: 1.25,
        calm: { hideShorts: true },
      },
    };

    const saveProf = await chrome.runtime.sendMessage(messages.saveProfile(profile));
    assert.equal(saveProf.ok, true);

    // Apply profile
    const applyRes = await chrome.runtime.sendMessage(messages.applyProfile('prof-chill'));
    assert.equal(applyRes.ok, true);
    assert.equal(applyRes.applied, true);

    const settings = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(settings.themeId, 'classic');
    assert.equal(settings.accent, '#22bb33');
    assert.equal(settings.density, 2);
    assert.equal(settings.textScale, 1.25);
    assert.equal(settings.calm.hideShorts, true);

    // Set schedule referencing this profile
    const schedRes = await chrome.runtime.sendMessage(messages.updateSchedule({
      schema: 1,
      enabled: true,
      dayProfileId: 'prof-chill',
      nightProfileId: 'cinema',
      dayTime: '08:00',
      nightTime: '20:00',
    }));
    assert.equal(schedRes.ok, true);

    // Delete profile -> schedule disabled and marked missing-profile
    const delProf = await chrome.runtime.sendMessage(messages.deleteProfile('prof-chill'));
    assert.equal(delProf.ok, true);
    assert.equal(delProf.record.items.length, 0);

    const schedAfter = (await chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.equal(schedAfter.enabled, false);
    assert.equal(schedAfter.lastError, 'missing-profile');
  });

  test('F2 & F3: editor saves theme with valid CSS and applies atomically', async () => {
    const { chrome } = await setupIntegration();

    const customWithCss = {
      schema: 1,
      id: 'custom-neon',
      name: 'Neon',
      author: 'Tester',
      version: '1.0.0',
      tier: 'pro',
      tokens: {
        color: { bg: '#000000', surface: '#111111', text: '#ffffff', muted: '#888888', accent: '#00ffcc', border: '#888888' },
        type: { family: 'System', baseSize: 14, headingWeight: 700 },
        shape: { radius: 4, shadow: true, spacing: 2 },
      },
      layout: { home: 'grid', watch: 'default', density: 1 },
      calm: {},
      css: '.cd-card{border:1px solid var(--cd-accent)}',
    };

    const saveRes = await chrome.runtime.sendMessage(messages.saveTheme(customWithCss, { apply: true }));
    assert.equal(saveRes.ok, true, `Save should succeed: ${JSON.stringify(saveRes)}`);

    const storedThemes = (await chrome.storage.local.get(STORAGE_KEYS.customThemes))[STORAGE_KEYS.customThemes];
    assert.ok(storedThemes.items['custom-neon']);
    assert.equal(storedThemes.items['custom-neon'].css, '.cd-card{border:1px solid var(--cd-accent)}');

    const storedSettings = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(storedSettings.themeId, 'custom-neon');
  });

  test('F4 & F5: manual settings change triggers manualOverrideUntil and alarm does not overwrite', async () => {
    const { chrome, advance, now } = await setupIntegration('2026-10-14T09:00:00'); // daytime (08:00 - 20:00)

    // Create day profile (classic) and night profile (cinema)
    await chrome.runtime.sendMessage(messages.saveProfile({
      id: 'prof-day',
      name: 'Day Profile',
      settings: { schema: 1, themeId: 'classic' },
    }));

    await chrome.runtime.sendMessage(messages.updateSchedule({
      schema: 1,
      enabled: true,
      dayProfileId: 'prof-day',
      nightProfileId: 'cinema',
      dayTime: '08:00',
      nightTime: '20:00',
    }));

    // Trigger schedule check (applies day profile: classic)
    await chrome.alarms.fire(ALARM_SCHEDULE);
    let s = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(s.themeId, 'classic');

    // User manually switches to arcade theme via SAVE_SETTINGS
    const manualChange = await chrome.runtime.sendMessage(messages.saveSettings({ themeId: 'arcade' }));
    assert.equal(manualChange.ok, true);

    s = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(s.themeId, 'arcade');

    const sched = (await chrome.storage.local.get(STORAGE_KEYS.schedule))[STORAGE_KEYS.schedule];
    assert.ok(typeof sched.manualOverrideUntil === 'number');
    assert.ok(sched.manualOverrideUntil > now(), 'manualOverrideUntil must be in the future (next boundary)');

    // 1-minute alarm fires 5 minutes later during the daytime: must NOT revert user's arcade choice!
    advance(5 * 60 * 1000);
    await chrome.alarms.fire(ALARM_SCHEDULE);

    s = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(s.themeId, 'arcade', 'User choice must remain preserved while manualOverride is active');

    // Advance past the 20:00 boundary to 20:01
    const msUntilNight = new Date('2026-10-14T20:01:00').getTime() - now();
    advance(msUntilNight);

    // Alarm fires at night: override has expired, schedule applies night profile (cinema)
    await chrome.alarms.fire(ALARM_SCHEDULE);

    s = (await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings];
    assert.equal(s.themeId, 'cinema', 'Night schedule must apply after boundary passes');
  });
});
