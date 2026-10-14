import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeProfiles,
  normalizeCustomThemes,
  findProfile,
  resolveProfileSettings,
  validateSettingsSnapshot,
  isReservedThemeId,
  slugifyThemeId,
  RESERVED_THEME_IDS,
} from '../../src/shared/collections.js';

describe('normalizeProfiles', () => {
  test('returns empty envelope for null or undefined', () => {
    const res1 = normalizeProfiles(null);
    assert.deepEqual(res1.record, { schema: 1, revision: 0, items: [] });
    assert.equal(res1.changed, false);

    const res2 = normalizeProfiles(undefined);
    assert.deepEqual(res2.record, { schema: 1, revision: 0, items: [] });
    assert.equal(res2.changed, false);
  });

  test('migrates legacy array with changed: true and revision 0', () => {
    const legacy = [
      {
        id: 'prof-1',
        name: 'Profile One',
        settings: {
          themeId: 'cinema',
          accent: '#112233',
          density: 3,
          animations: true,
          textScale: null,
          calm: { hideShorts: true },
        },
      },
    ];
    const res = normalizeProfiles(legacy);
    assert.equal(res.changed, true);
    assert.equal(res.record.schema, 1);
    assert.equal(res.record.revision, 0);
    assert.equal(res.record.items.length, 1);
    assert.equal(res.record.items[0].id, 'prof-1');
    assert.equal(res.record.items[0].settings.schema, 1);
  });

  test('migrates legacy map with changed: true', () => {
    const legacyMap = {
      'prof-a': {
        name: 'Profile A',
        settings: { themeId: 'minimal' },
      },
      'prof-b': {
        id: 'prof-b',
        name: 'Profile B',
        settings: { themeId: 'classic' },
      },
    };
    const res = normalizeProfiles(legacyMap);
    assert.equal(res.changed, true);
    assert.equal(res.record.items.length, 2);
    assert.equal(res.record.items[0].id, 'prof-a');
    assert.equal(res.record.items[1].id, 'prof-b');
  });

  test('preserves existing envelope and revision', () => {
    const envelope = {
      schema: 1,
      revision: 7,
      items: [
        {
          id: 'prof-7',
          name: 'Lucky',
          settings: { schema: 1, themeId: 'arcade', accent: null, density: 2, animations: false, textScale: 1.25, calm: {} },
        },
      ],
    };
    const res = normalizeProfiles(envelope);
    assert.equal(res.changed, false);
    assert.equal(res.record.revision, 7);
    assert.equal(res.record.items.length, 1);
  });

  test('handles unknown future schema safely (read-only, no downgrade)', () => {
    const future = { schema: 2, revision: 10, items: [{ someNewField: 'abc' }] };
    const res = normalizeProfiles(future);
    assert.equal(res.unknownSchema, true);
    assert.equal(res.changed, false);
    assert.deepEqual(res.record, future);
  });

  test('deduplicates duplicate IDs and enforces limits', () => {
    const duplicates = [
      { id: 'dup', name: 'First', settings: { themeId: 'cinema' } },
      { id: 'dup', name: 'Second', settings: { themeId: 'minimal' } },
    ];
    const res = normalizeProfiles(duplicates);
    assert.equal(res.record.items.length, 1);
    assert.equal(res.record.items[0].name, 'First');
    assert.equal(res.issues.length, 1);
  });
});

describe('normalizeCustomThemes', () => {
  test('returns empty envelope for null/undefined', () => {
    const res = normalizeCustomThemes(null);
    assert.deepEqual(res.record, { schema: 1, revision: 0, items: {} });
    assert.equal(res.changed, false);
  });

  test('migrates legacy map to envelope with changed: true', () => {
    const validCustom = {
      schema: 1,
      id: 'custom-nord',
      name: 'Nord Theme',
      author: 'Creator',
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
    const legacy = { 'custom-nord': validCustom };
    const res = normalizeCustomThemes(legacy);
    assert.equal(res.changed, true);
    assert.equal(res.record.schema, 1);
    assert.equal(res.record.revision, 0);
    assert.equal(res.record.items['custom-nord'].id, 'custom-nord');
  });

  test('rejects reserved bundled IDs from being stored as custom themes', () => {
    const invalid = {
      cinema: {
        schema: 1,
        id: 'cinema',
        name: 'Spoofed Cinema',
        author: 'Attacker',
        version: '1.0.0',
        tier: 'free',
        tokens: { color: { bg: '#000', surface: '#111', text: '#fff', muted: '#aaa', accent: '#f00', border: '#222' } },
      },
    };
    const res = normalizeCustomThemes(invalid);
    assert.equal(Object.keys(res.record.items).length, 0);
    assert.ok(res.issues.some((i) => i.id === 'cinema'));
  });

  test('preserves valid envelope with revision', () => {
    const envelope = {
      schema: 1,
      revision: 4,
      items: {},
    };
    const res = normalizeCustomThemes(envelope);
    assert.equal(res.changed, false);
    assert.equal(res.record.revision, 4);
  });
});

describe('findProfile & resolveProfileSettings', () => {
  const profileList = [
    {
      id: 'prof-day',
      name: 'Day Profile',
      settings: {
        schema: 1,
        themeId: 'minimal',
        accent: '#112233',
        density: 2,
        animations: true,
        textScale: null,
        calm: { hideShorts: true },
      },
    },
  ];

  test('findProfile works on raw array or envelope', () => {
    assert.equal(findProfile(profileList, 'prof-day')?.name, 'Day Profile');
    assert.equal(findProfile({ schema: 1, revision: 2, items: profileList }, 'prof-day')?.name, 'Day Profile');
    assert.equal(findProfile(profileList, 'nonexistent'), null);
  });

  test('resolveProfileSettings resolves saved profile from array and envelope', () => {
    const s1 = resolveProfileSettings('prof-day', profileList);
    assert.equal(s1?.themeId, 'minimal');
    assert.equal(s1?.accent, '#112233');

    const s2 = resolveProfileSettings('prof-day', { schema: 1, revision: 1, items: profileList });
    assert.equal(s2?.themeId, 'minimal');
    assert.equal(s2?.accent, '#112233');
  });

  test('resolveProfileSettings falls back to bundled theme defaults', () => {
    const s = resolveProfileSettings('classic', profileList);
    assert.equal(s?.themeId, 'classic');
    assert.equal(s?.animations, true);
  });

  test('resolveProfileSettings does not treat arbitrary custom theme IDs as profile IDs', () => {
    assert.equal(resolveProfileSettings('custom-test', profileList), null);
  });
});

describe('slugifyThemeId & reserved IDs', () => {
  test('isReservedThemeId identifies launch themes and broadcast', () => {
    assert.equal(isReservedThemeId('cinema'), true);
    assert.equal(isReservedThemeId('arcade'), true);
    assert.equal(isReservedThemeId('broadcast'), true);
    assert.equal(isReservedThemeId('custom-neon'), false);
  });

  test('slugifyThemeId generates custom- prefix and handles uniqueness', () => {
    const id1 = slugifyThemeId('Cyberpunk Glow');
    assert.equal(id1, 'custom-cyberpunk-glow');

    const id2 = slugifyThemeId('Cyberpunk Glow', ['custom-cyberpunk-glow']);
    assert.equal(id2, 'custom-cyberpunk-glow-2');

    const id3 = slugifyThemeId('Cyberpunk Glow', ['custom-cyberpunk-glow', 'custom-cyberpunk-glow-2']);
    assert.equal(id3, 'custom-cyberpunk-glow-3');
  });
});
