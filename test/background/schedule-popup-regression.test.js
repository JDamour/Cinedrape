import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChromeMock } from '../helpers/chrome-mock.js';
import { createPage } from '../helpers/dom.js';
import { createBackground, ALARM_SCHEDULE } from '../../src/background/service-worker.js';
import { createEngine } from '../../src/content/engine.js';
import { THEMES } from '../../src/themes/index.js';
import { STORAGE_KEYS, MSG } from '../../src/shared/constants.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { signEnvelope, toPublicJwk } from '../../src/shared/signing.js';

const SOURCE_MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const priv = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { priv, pub: toPublicJwk(priv) };
}

test('REGRESSION A01: scheduler resolves popup-created profiles and updates content engine', async () => {
  const LICENCE = await makeKeyPair('licence-test-1');
  const MAPKEY = await makeKeyPair('selector-map-test-1');

  const { chrome } = createChromeMock();
  const { window, document } = createPage('home');

  const map = structuredClone(SOURCE_MAP);
  map.mapVersion = '2026.10.14.1';
  const envelope = await signEnvelope(JSON.stringify(map), MAPKEY.priv, 'selector-map-test-1');

  // Fix local time to 09:00 (daytime)
  const fakeNow = () => new Date('2026-10-14T09:00:00').getTime();

  const token = await signLicenceToken(
    { v: 1, sub: 'user-1', plan: 'pro', iat: Math.floor(fakeNow() / 1000) - 60 },
    LICENCE.priv
  );

  const bg = createBackground({
    chrome,
    now: fakeNow,
    keys: { licence: LICENCE.pub, selectorMap: MAPKEY.pub },
    readBundledVersion: async () => '2026.10.14.1',
  });
  bg.register();
  await bg.handleInstalled();

  // Activate Pro
  const actRes = await chrome.runtime.sendMessage({ type: MSG.ACTIVATE_LICENCE, token });
  assert.equal(actRes?.ok, true);

  // Popup saves profiles as an array of validated profile objects (Defect A)
  const popupProducedProfiles = [
    {
      id: 'prof-popup-1',
      name: 'Work Mode',
      settings: {
        schema: 1,
        themeId: 'minimal',
        accent: '#0055ff',
        density: 4,
        animations: false,
        textScale: 1.1,
        calm: { hideShorts: true, hideComments: true },
      },
    },
  ];

  await chrome.storage.local.set({
    [STORAGE_KEYS.profiles]: popupProducedProfiles,
    [STORAGE_KEYS.schedule]: {
      enabled: true,
      dayProfileId: 'prof-popup-1',
      nightProfileId: 'cinema',
      dayTime: '08:00',
      nightTime: '20:00',
    },
  });

  // Start content engine on the page
  const engine = createEngine({
    doc: document,
    win: window,
    chrome,
    themes: THEMES,
    bundledEnvelope: envelope,
    publicKeys: { selectorMap: MAPKEY.pub, licence: LICENCE.pub },
  });
  engine.start();

  // Fire registered schedule alarm
  await chrome.alarms.fire(ALARM_SCHEDULE);

  // Check stored settings
  const stored = await chrome.storage.local.get(STORAGE_KEYS.settings);
  const currentSettings = stored[STORAGE_KEYS.settings];

  // This MUST assert the applied settings
  assert.equal(currentSettings.themeId, 'minimal', 'themeId must be applied from popup profile');
  assert.equal(currentSettings.accent, '#0055ff', 'accent must be applied from popup profile');
  assert.equal(currentSettings.density, 4, 'density must be applied from popup profile');
  assert.equal(currentSettings.animations, false, 'animations must be applied from popup profile');
  assert.equal(currentSettings.textScale, 1.1, 'textScale must be applied from popup profile');
  assert.equal(currentSettings.calm.hideShorts, true, 'calm.hideShorts must be applied');
});
