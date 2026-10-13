// Pure popup logic: validation, gating, derived view, copy. No DOM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ALL_THEME_IDS, CALM_KEYS, DEFAULT_SETTINGS, FEATURES, FREE_CALM_KEYS, PAGE_TYPES,
} from '../../src/shared/constants.js';
import { contrastRatio } from '../../src/shared/contrast.js';
import {
  ACCENT_SWATCHES, CALM_COPY, DENSITY_LABELS, FEATURE_LABELS, LICENCE_COPY, PAGE_LABELS,
  accentWarning, activationErrorCopy, checkEntitlement, deriveView, isTextScale, licenceFromRecord, licenceKey, lockedCopy, mergeSettings,
  normalizeToken, parseActivateResponse, parseHex, parseLicence, safeCssColor, sanitizePatch, statusCopy,
  strictHex, summarizeStatus, usableThemes, withDefaults,
} from '../../src/popup/model.js';
import { EXPIRED, FAKE_THEMES, FREE, GRACE, PRO } from './_harness.js';

const view = (settings, licence = FREE, themes = FAKE_THEMES) => deriveView({ settings, licence, themes });

test('parseHex accepts 3 or 6 hex digits with or without #, and nothing else', () => {
  assert.equal(parseHex('#E8B04A'), '#e8b04a');
  assert.equal(parseHex('e8b04a'), '#e8b04a');
  assert.equal(parseHex('  #abc '), '#aabbcc');
  assert.equal(parseHex('fff'), '#ffffff');
  for (const bad of ['', '#', '#12', '#1234', '#12345', '#1234567', '#gggggg', 'red', 'rgb(1,2,3)', '#abc;', '#e8b04a<b>',
    '##abcdef', '0x112233', null, undefined, 123, {}, ['#abcdef']]) {
    assert.equal(parseHex(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('strictHex is the stricter stored form: exactly #rrggbb', () => {
  assert.equal(strictHex('#ABCDEF'), '#abcdef');
  for (const bad of ['#abc', 'abcdef', '#abcdefff', '#abcdeg', null, 5]) assert.equal(strictHex(bad), null);
});

test('safeCssColor lets plain colours through and refuses anything that could carry more than a colour', () => {
  for (const ok of ['#fff', '#0b0b0f', '#0b0b0fcc', 'rgb(1, 2, 3)', 'rgba(0,0,0,.5)', 'hsl(210 40% 50%)', 'hsla(120, 50%, 50%, 0.3)']) {
    assert.equal(safeCssColor(ok), ok);
  }
  for (const bad of ['red', 'url(https://x)', 'var(--x)', 'rgb(1,2,3); background:url(x)', '#12', 'expression(1)', 'rgb(1,2,3)}', 5, null, 'x'.repeat(80)]) {
    assert.equal(safeCssColor(bad), null, `rejects ${String(bad).slice(0, 30)}`);
  }
});

// ---- sanitizePatch ----------------------------------------------------------------------------------------------------

test('sanitizePatch accepts every valid setting and normalises the accent', () => {
  assert.deepEqual(sanitizePatch({ themeId: 'studio' }), { ok: true, patch: { themeId: 'studio' } });
  assert.deepEqual(sanitizePatch({ accent: '#E8B04A' }), { ok: true, patch: { accent: '#e8b04a' } });
  assert.deepEqual(sanitizePatch({ accent: null }), { ok: true, patch: { accent: null } });
  assert.deepEqual(sanitizePatch({ density: 1 }), { ok: true, patch: { density: 1 } });
  assert.deepEqual(sanitizePatch({ density: 5 }), { ok: true, patch: { density: 5 } });
  assert.deepEqual(sanitizePatch({ density: null }), { ok: true, patch: { density: null } });
  assert.deepEqual(sanitizePatch({ animations: false }), { ok: true, patch: { animations: false } });
  assert.deepEqual(sanitizePatch({ textScale: 0.9 }), { ok: true, patch: { textScale: 0.9 } });
  assert.deepEqual(sanitizePatch({ textScale: 1 }), { ok: true, patch: { textScale: 1 } });
  assert.deepEqual(sanitizePatch({ textScale: 1.1 }), { ok: true, patch: { textScale: 1.1 } });
  assert.deepEqual(sanitizePatch({ textScale: 1.25 }), { ok: true, patch: { textScale: 1.25 } });
  assert.deepEqual(sanitizePatch({ textScale: 1.5 }), { ok: true, patch: { textScale: 1.5 } });
  assert.deepEqual(sanitizePatch({ textScale: null }), { ok: true, patch: { textScale: null } });
  assert.deepEqual(sanitizePatch({ calm: { hideShorts: true } }), { ok: true, patch: { calm: { hideShorts: true } } });
  for (const id of ALL_THEME_IDS) assert.equal(sanitizePatch({ themeId: id }).ok, true);
});

test('sanitizePatch rejects invalid values and unknown keys', () => {
  const bad = [
    { themeId: 'hacker' }, { themeId: 'CINEMA' }, { themeId: '' }, { themeId: 7 }, { themeId: null }, { themeId: ['cinema'] },
    { themeId: '__proto__' }, { themeId: 'constructor' },
    { accent: 'red' }, { accent: '#fff' }, { accent: '#12345' }, { accent: 'e8b04a' }, { accent: '#e8b04a; x:y' }, { accent: 12 },
    { density: 0 }, { density: 6 }, { density: -1 }, { density: 2.5 }, { density: '3' }, { density: NaN }, { density: Infinity }, { density: true },
    { animations: 'true' }, { animations: 1 }, { animations: null }, { animations: undefined },
    { textScale: 0.8 }, { textScale: 2 }, { textScale: -1 }, { textScale: '1' }, { textScale: NaN }, { textScale: Infinity }, { textScale: true },
    { calm: { hideEverything: true } }, { calm: { hideShorts: 'yes' } }, { calm: { __proto__x: true } }, { calm: [] }, { calm: null }, { calm: 'hideShorts' },
    { schema: 2 }, { telemetryOptIn: true }, { constructor: 1 }, { __proto__: { themeId: 'cinema' }, nope: 1 },
    {}, null, undefined, 'themeId', 5, [],
  ];
  for (const patch of bad) assert.equal(sanitizePatch(patch).ok, false, `rejects ${JSON.stringify(patch)}`);
});

test('sanitizePatch refuses a patch when any one key is bad, and does not alias its input', () => {
  assert.equal(sanitizePatch({ themeId: 'minimal', density: 9 }).ok, false);
  const input = { calm: { hideShorts: true } };
  const out = sanitizePatch(input);
  out.patch.calm.hideShorts = false;
  assert.equal(input.calm.hideShorts, true);
});

// ---- mergeSettings ----------------------------------------------------------------------------------------------------

test('mergeSettings merges into what is stored and keeps keys it does not own', () => {
  const stored = { schema: 1, themeId: 'minimal', accent: null, density: 2, animations: true, telemetryOptIn: true,
    futureThing: { a: 1 }, calm: { hideShorts: true, hideComments: true } };
  const merged = mergeSettings(stored, { accent: '#e8b04a', calm: { hideHomeRecs: true } });
  assert.deepEqual(merged, { ...stored, accent: '#e8b04a', calm: { hideShorts: true, hideComments: true, hideHomeRecs: true } });
  assert.equal(stored.accent, null, 'the stored object is not mutated');
  assert.equal(stored.calm.hideHomeRecs, undefined);
});

test('mergeSettings starts from the defaults when nothing usable is stored', () => {
  for (const nothing of [undefined, null, 'x', 5, [], true]) {
    const merged = mergeSettings(nothing, { themeId: 'classic' });
    assert.deepEqual(merged, { ...DEFAULT_SETTINGS, themeId: 'classic', calm: { ...DEFAULT_SETTINGS.calm } });
  }
  assert.deepEqual(DEFAULT_SETTINGS.calm.hideShorts, false, 'the shared defaults are untouched');
});

test('mergeSettings repairs a calm value of the wrong type instead of spreading it', () => {
  assert.deepEqual(mergeSettings({ themeId: 'cinema', calm: 'oops' }, { themeId: 'minimal' }).calm, DEFAULT_SETTINGS.calm);
  assert.deepEqual(mergeSettings({ themeId: 'cinema', calm: ['x'] }, { calm: { hideShorts: true } }).calm,
    { ...DEFAULT_SETTINGS.calm, hideShorts: true });
  assert.deepEqual(mergeSettings({ themeId: 'cinema' }, { themeId: 'minimal' }).calm, DEFAULT_SETTINGS.calm);
});

test('withDefaults fills gaps without trusting types', () => {
  assert.deepEqual(withDefaults(undefined), { ...DEFAULT_SETTINGS, calm: { ...DEFAULT_SETTINGS.calm } });
  assert.equal(withDefaults({ calm: 'x' }).calm.hideShorts, false);
  assert.equal(withDefaults({ calm: { hideShorts: true } }).calm.hideComments, false);
});

// ---- themes and the derived view --------------------------------------------------------------------------------------

test('usableThemes keeps known ids with a real tier, once each', () => {
  const junk = [null, 5, 'x', { id: 'cinema' }, { id: 'nope', tier: 'free' }, { id: 'studio', tier: 'gold' }, FAKE_THEMES[0], { ...FAKE_THEMES[0], name: 'Dup' }];
  assert.deepEqual(usableThemes(junk).map((t) => t.id), ['cinema']);
  assert.equal(usableThemes(junk)[0].name, 'Cinema');
  assert.deepEqual(usableThemes(undefined), []);
  assert.deepEqual(usableThemes(FAKE_THEMES).map((t) => t.id), ALL_THEME_IDS);
});

test('view: a free user sees free themes selectable and Pro themes locked, Cinema selected by default', () => {
  const v = view(undefined, FREE);
  assert.deepEqual(v.themes.map((t) => [t.id, t.pro, t.locked, t.checked]), [
    ['cinema', false, false, true], ['minimal', false, false, false], ['classic', false, false, false],
    ['primetime', true, true, false], ['studio', true, true, false], ['arcade', true, true, false]]);
  assert.equal(v.licenceKey, 'free');
  assert.equal(v.pro, false);
});

test('view: Pro unlocks every theme; grace counts as Pro; expired does not', () => {
  for (const [licence, key, pro] of [[PRO, 'active', true], [GRACE, 'grace', true], [EXPIRED, 'expired', false], [FREE, 'free', false]]) {
    const v = view({ themeId: 'studio' }, licence);
    assert.equal(v.licenceKey, key);
    assert.equal(v.pro, pro);
    assert.equal(v.themes.find((t) => t.id === 'studio').locked, !pro);
    assert.equal(v.theme.id, pro ? 'studio' : 'cinema');
  }
});

test('view: a saved Pro choice is shown as suppressed, not erased, when the licence lapses', () => {
  const settings = { themeId: 'arcade', density: 4, calm: { ...DEFAULT_SETTINGS.calm, hideComments: true, hideShorts: true } };
  const v = view(settings, EXPIRED);
  assert.equal(v.theme.id, 'cinema');
  assert.equal(v.density.locked, true);
  assert.equal(v.density.suppressed, true);
  assert.equal(v.density.value, 3, 'free users get the theme own density');
  assert.equal(v.calm.find((c) => c.key === 'hideComments').on, false);
  assert.equal(v.calm.find((c) => c.key === 'hideComments').suppressed, true);
  assert.equal(v.calm.find((c) => c.key === 'hideShorts').on, true, 'a free calm key is unaffected');
  assert.deepEqual(v.suppressed, ['Arcade theme', 'density', 'hide comments']);
  // ... and comes straight back with Pro.
  const back = view(settings, PRO);
  assert.equal(back.theme.id, 'arcade');
  assert.equal(back.density.value, 4);
  assert.equal(back.density.custom, true);
  assert.equal(back.calm.find((c) => c.key === 'hideComments').on, true);
  assert.deepEqual(back.suppressed, []);
});

test('view: density is the theme default until Pro sets one', () => {
  assert.equal(view({ themeId: 'classic' }, PRO).density.value, 2);
  assert.equal(view({ themeId: 'classic' }, PRO).density.custom, false);
  assert.equal(view({ themeId: 'classic', density: 5 }, PRO).density.value, 5);
  assert.equal(view({ themeId: 'classic', density: 5 }, PRO).density.label, DENSITY_LABELS[4]);
  assert.equal(view({ themeId: 'classic' }, FREE).density.locked, true);
});

test('view: textScale is 1 (not custom) by default, and reflects stored valid scale', () => {
  const def = view(undefined, FREE);
  assert.equal(def.textScale.value, 1);
  assert.equal(def.textScale.custom, false);

  for (const s of [0.9, 1, 1.1, 1.25, 1.5]) {
    const v = view({ textScale: s }, FREE);
    assert.equal(v.textScale.value, s);
    assert.equal(v.textScale.custom, true);
  }

  const bad = view({ textScale: 2.5 }, FREE);
  assert.equal(bad.textScale.value, 1);
  assert.equal(bad.textScale.custom, false);
});

test('view: the calm keys are the six contract keys; exactly the non-free ones lock for free users', () => {
  const v = view(undefined, FREE);
  assert.deepEqual(v.calm.map((c) => c.key), CALM_KEYS);
  assert.deepEqual(v.calm.filter((c) => !c.locked).map((c) => c.key), FREE_CALM_KEYS);
  assert.ok(view(undefined, PRO).calm.every((c) => !c.locked));
});

test('view: corrupt stored settings fall back to defaults instead of throwing', () => {
  const corrupt = [
    { themeId: 42, accent: 'red', density: 99, animations: 'yes', calm: 'x' },
    { themeId: { toString() { throw new Error('boom'); } }, calm: { hideShorts: 'true' } },
    'string', 5, null, [], { calm: [] },
  ];
  for (const settings of corrupt) {
    const v = view(settings, PRO);
    assert.equal(v.theme.id, 'cinema');
    assert.equal(v.accent, null);
    assert.equal(v.animations, true);
    assert.equal(v.density.custom, false);
    assert.ok(v.calm.every((c) => c.on === false));
  }
});

test('view: with no usable themes it still builds an empty list', () => {
  const v = view(undefined, FREE, []);
  assert.deepEqual(v.themes, []);
  assert.equal(v.theme, null);
  assert.equal(accentWarning(v), null);
});

test('view: an unnamed theme falls back to its id; colours come only from tokens.color', () => {
  const themes = [{ ...FAKE_THEMES[0], name: '   ' }, { ...FAKE_THEMES[1], tokens: { color: 'nope' } }];
  const v = view(undefined, FREE, themes);
  assert.equal(v.themes[0].name, 'cinema');
  assert.deepEqual(v.themes[1].colors, {});
});

// ---- entitlements -----------------------------------------------------------------------------------------------------

test('checkEntitlement blocks exactly what the tier forbids', () => {
  const ctx = (licence) => ({ licence, themes: FAKE_THEMES });
  assert.deepEqual(checkEntitlement({ themeId: 'minimal' }, ctx(FREE)), { ok: true });
  assert.deepEqual(checkEntitlement({ themeId: 'studio' }, ctx(FREE)), { ok: false, kind: 'theme', key: 'studio', name: 'Studio' });
  assert.deepEqual(checkEntitlement({ themeId: 'studio' }, ctx(EXPIRED)), { ok: false, kind: 'theme', key: 'studio', name: 'Studio' });
  assert.deepEqual(checkEntitlement({ themeId: 'studio' }, ctx(PRO)), { ok: true });
  assert.deepEqual(checkEntitlement({ themeId: 'studio' }, ctx(GRACE)), { ok: true });
  assert.equal(checkEntitlement({ density: 4 }, ctx(FREE)).kind, 'density');
  assert.equal(checkEntitlement({ density: null }, ctx(FREE)).kind, 'density');
  assert.equal(checkEntitlement({ density: 4 }, ctx(PRO)).ok, true);
  assert.equal(checkEntitlement({ calm: { hideShorts: true } }, ctx(FREE)).ok, true);
  assert.equal(checkEntitlement({ calm: { hideComments: true } }, ctx(FREE)).kind, 'calm');
  assert.equal(checkEntitlement({ calm: { hideShorts: true, hideViewCounts: true } }, ctx(FREE)).key, 'hideViewCounts');
  assert.equal(checkEntitlement({ calm: { hideViewCounts: true } }, ctx(PRO)).ok, true);
  assert.equal(checkEntitlement({ calm: { hideShorts: true, hideLive: true } }, ctx(FREE)).key, 'hideLive');
  assert.equal(checkEntitlement({ calm: { hideLive: true } }, ctx(PRO)).ok, true);
  assert.equal(checkEntitlement({ accent: '#e8b04a', animations: false }, ctx(FREE)).ok, true, 'accent and animations are free');
  assert.equal(checkEntitlement({ themeId: 'studio', density: 3 }, ctx(FREE)).kind, 'theme', 'first violation wins');
});

test('checkEntitlement refuses a theme the popup does not know, even for Pro', () => {
  assert.equal(checkEntitlement({ themeId: 'studio' }, { licence: PRO, themes: FAKE_THEMES.slice(0, 3) }).kind, 'unknown-theme');
  assert.equal(checkEntitlement({ themeId: 'studio' }, { licence: PRO, themes: [] }).ok, false);
});

test('checkEntitlement treats a theme the contract names as Pro as Pro even when its data says free', () => {
  const lie = FAKE_THEMES.map((t) => (t.id === 'arcade' ? { ...t, tier: 'free' } : t));
  assert.equal(checkEntitlement({ themeId: 'arcade' }, { licence: FREE, themes: lie }).kind, 'theme');
  assert.equal(view(undefined, FREE, lie).themes.find((t) => t.id === 'arcade').pro, true);
});

test('lockedCopy explains the lock and mentions an expired licence only when it is one', () => {
  assert.equal(lockedCopy({ kind: 'theme', name: 'Studio' }, 'free'), 'Studio is a Pro theme. Activate Pro to use it.');
  assert.match(lockedCopy({ kind: 'theme', name: 'Studio' }, 'expired'), /^Your Pro licence has expired\. Studio is a Pro theme/);
  assert.match(lockedCopy({ kind: 'density' }, 'free'), /Density is a Pro setting/);
  assert.match(lockedCopy({ kind: 'calm', name: 'Hide comments' }, 'free'), /^Hide comments is a Pro setting\. Activate Pro/);
  assert.doesNotMatch(lockedCopy({ kind: 'calm', name: 'Hide comments' }, 'free'), /expired/);
});

// ---- licence ----------------------------------------------------------------------------------------------------------

test('parseLicence reads a bare or wrapped {plan,status} and nothing else', () => {
  assert.deepEqual(parseLicence({ plan: 'pro', status: 'grace' }), { plan: 'pro', status: 'grace' });
  assert.deepEqual(parseLicence({ state: { plan: 'free', status: 'expired' } }), { plan: 'free', status: 'expired' });
  assert.deepEqual(parseLicence({ plan: 'pro', status: 'active', token: 'secret', claims: {} }), { plan: 'pro', status: 'active' });
  for (const bad of [null, undefined, 'pro', 5, [], {}, { plan: 'pro' }, { status: 'active' }, { plan: 'enterprise', status: 'active' },
    { plan: 'pro', status: 'lifetime' }, { state: 'x' }, { state: { plan: 'pro' } }, { hello: 'world' }]) {
    assert.equal(parseLicence(bad), null, `rejects ${JSON.stringify(bad)}`);
  }
});

test('licenceFromRecord: the stored record gives the same states as the background (7 d active, 30 d grace, then expired) and junk is "no licence"', () => {
  const DAY = 86400000;
  const NOW = Date.UTC(2026, 9, 9, 12);
  const rec = (ageDays, extra = {}) => ({ token: 'a.b', claims: { v: 1, sub: 's', plan: 'pro', iat: Math.floor(NOW / 1000) - 99999, exp: Math.floor(NOW / 1000) + 90 * 86400 }, checkedAt: NOW - ageDays * DAY, ...extra });
  assert.deepEqual(licenceFromRecord(rec(0), NOW), { plan: 'pro', status: 'active' });
  assert.deepEqual(licenceFromRecord(rec(7), NOW), { plan: 'pro', status: 'active' });
  assert.deepEqual(licenceFromRecord(rec(7.01), NOW), { plan: 'pro', status: 'grace' });
  assert.deepEqual(licenceFromRecord(rec(30), NOW), { plan: 'pro', status: 'grace' });
  assert.deepEqual(licenceFromRecord(rec(30.01), NOW), { plan: 'free', status: 'expired' });
  assert.deepEqual(licenceFromRecord(rec(1, { claims: { v: 1, sub: 's', plan: 'pro', iat: 1, exp: Math.floor(NOW / 1000) - 1 } }), NOW), { plan: 'free', status: 'expired' }, 'a token past its own exp');
  for (const junk of [undefined, null, 'x', 5, [], {}, { token: 'a.b' }, { token: '', claims: {}, checkedAt: 1 }, { token: 'a.b', claims: {}, checkedAt: 'now' }, { token: 'a.b', claims: [], checkedAt: 1 },
    { token: 'a.b', claims: { v: 1 }, checkedAt: NaN }, { token: 'a.b', claims: { v: 9, plan: 'pro' }, checkedAt: NOW }]) {
    assert.deepEqual(licenceFromRecord(junk, NOW), { plan: 'free', status: 'none' }, JSON.stringify(junk));
  }
  assert.deepEqual(licenceFromRecord(rec(1), Number.NaN), { plan: 'free', status: 'expired' }, 'an unusable clock never grants Pro');
});

test('licenceKey names the four states plus unknown; plan pro with a non-active status is not Pro', () => {
  assert.equal(licenceKey(FREE), 'free');
  assert.equal(licenceKey(PRO), 'active');
  assert.equal(licenceKey(GRACE), 'grace');
  assert.equal(licenceKey(EXPIRED), 'expired');
  assert.equal(licenceKey({ plan: 'pro', status: 'expired' }), 'expired');
  assert.equal(licenceKey({ plan: 'pro', status: 'none' }), 'free');
  assert.equal(licenceKey(PRO, false), 'unknown');
  assert.equal(licenceKey(null), 'unknown');
  for (const key of ['free', 'active', 'grace', 'expired', 'unknown']) assert.ok(LICENCE_COPY[key].label && LICENCE_COPY[key].detail);
  assert.equal(LICENCE_COPY.free.label, 'Free');
  assert.equal(LICENCE_COPY.active.label, 'Pro active');
  assert.equal(LICENCE_COPY.grace.label, 'Pro (offline grace)');
  assert.match(LICENCE_COPY.expired.label, /expired/i);
});

test('normalizeToken strips pasted whitespace and quotes, and checks the shape', () => {
  assert.deepEqual(normalizeToken('  abc_DEF-123.xyz-456_789 \n'), { ok: true, token: 'abc_DEF-123.xyz-456_789' });
  assert.deepEqual(normalizeToken('abc.\n  def'), { ok: true, token: 'abc.def' });
  assert.deepEqual(normalizeToken('"abc.def"'), { ok: true, token: 'abc.def' });
  assert.deepEqual(normalizeToken('\'abc.def\''), { ok: true, token: 'abc.def' });
  for (const [bad, code] of [['', 'empty'], ['   \n ', 'empty'], [null, 'empty'], [42, 'empty'], [{}, 'empty'], ['nodot', 'format'],
    ['a.b.c', 'format'], ['.abc', 'format'], ['abc.', 'format'], ['ab+c.def', 'format'], ['<script>.alert(1)', 'format'],
    ['abc.def?x=1', 'format'], ['a'.repeat(5000) + '.b', 'too-long'], ['x'.repeat(20000), 'too-long']]) {
    const r = normalizeToken(bad);
    assert.equal(r.ok, false, `rejects ${String(bad).slice(0, 20)}`);
    assert.equal(r.code, code);
    assert.ok(r.message.length > 10);
  }
  assert.equal(normalizeToken(`${'a'.repeat(4000)}.${'b'.repeat(90)}`).ok, true, 'just under the background limit');
  assert.equal(normalizeToken(`${'a'.repeat(4000)}.${'b'.repeat(97)}`).code, 'too-long', 'one over');
});

test('parseActivateResponse accepts ok/valid, carries the new state, and bounds the reason', () => {
  assert.deepEqual(parseActivateResponse({ ok: true, state: PRO }), { ok: true, reason: '', state: { plan: 'pro', status: 'active' } });
  assert.equal(parseActivateResponse({ valid: true }).ok, true);
  assert.deepEqual(parseActivateResponse({ ok: false, reason: 'expired' }), { ok: false, reason: 'expired', state: null });
  assert.equal(parseActivateResponse({ ok: false }).reason, 'invalid');
  assert.equal(parseActivateResponse({ ok: false, reason: 'x'.repeat(500) }).reason.length, 64);
  for (const junk of [undefined, null, 'ok', 7, [], true]) assert.deepEqual(parseActivateResponse(junk), { ok: false, reason: 'no-response', state: null });
  assert.equal(parseActivateResponse({ ok: 'true' }).ok, false, 'a truthy string is not success');
  assert.equal(parseActivateResponse({ ok: 1 }).ok, false);
});

test('activationErrorCopy covers every reason the licence code can produce and never repeats the input', () => {
  const reasons = ['bad-time', 'malformed-token', 'bad-key', 'bad-signature', 'bad-claims', 'unsupported-version', 'bad-plan',
    'not-yet-valid', 'expired', 'verify-error', 'malformed', 'no-key', 'invalid', 'storage-error', 'no-response', 'timeout'];
  const seen = new Set();
  for (const r of reasons) {
    const copy = activationErrorCopy(r);
    assert.ok(copy.length > 15 && copy.length < 160, r);
    if (r.includes('-')) assert.doesNotMatch(copy, new RegExp(r.replace(/-/g, '[- ]'), 'i'), `the raw code ${r} is not shown`);
    seen.add(copy);
  }
  assert.ok(seen.size >= 6, 'distinct situations get distinct advice');
  assert.match(activationErrorCopy('expired'), /expired/);
  for (const hostile of ['<img src=x onerror=alert(1)>', 'eyJ2IjoxfQ.sig', '', undefined, null, 5, 'x'.repeat(100)]) {
    const copy = activationErrorCopy(hostile);
    assert.doesNotMatch(copy, /[<>]|eyJ|onerror/);
    assert.ok(copy.length > 10);
  }
});

// ---- accent contrast --------------------------------------------------------------------------------------------------

test('accentWarning fires below 3:1 on the active theme background and names the ratio and theme', () => {
  const dark = view({ accent: '#222222' }, FREE);
  const warning = accentWarning(dark);
  assert.match(warning, /^Low contrast on Cinema: \d\.\d:1, and 3:1 is needed\./);
  assert.match(warning, /keep the theme.s own accent/);
  assert.equal(accentWarning(view({ accent: '#e8b04a' }, FREE)), null, 'gold on near-black passes');
  assert.equal(accentWarning(view({ accent: null }, FREE)), null, 'no override, nothing to warn about');
  // The same colour judged against a light theme.
  assert.ok(accentWarning(view({ themeId: 'minimal', accent: '#e8b04a' }, FREE)), 'gold on a near-white theme fails');
  assert.equal(accentWarning(view({ themeId: 'minimal', accent: '#222222' }, FREE)), null);
});

test('accentWarning follows the effective theme, not the stored one', () => {
  // Stored Studio (light) but free: the tab shows Cinema (dark), so a dark accent is the problem.
  assert.ok(accentWarning(view({ themeId: 'studio', accent: '#222222' }, FREE)).includes('Cinema'));
  assert.ok(accentWarning(view({ themeId: 'studio', accent: '#e8b04a' }, PRO)).includes('Studio'));
});

test('accentWarning boundary is exactly 3:1 and the shown ratio is floored, never rounded up to the limit', () => {
  const bg = '#ffffff';
  const themes = [{ ...FAKE_THEMES[0], tokens: { ...FAKE_THEMES[0].tokens, color: { ...FAKE_THEMES[0].tokens.color, bg } } }];
  const at = (hex) => view({ accent: hex }, FREE, themes);
  assert.ok(contrastRatio('#949494', bg) >= 3 && contrastRatio('#959595', bg) < 3, 'fixture sanity: the colours straddle 3:1');
  assert.equal(accentWarning(at('#949494')), null);
  const below = accentWarning(at('#959595'));
  assert.ok(below);
  assert.match(below, /: 2\.9:1,/, 'floored: 2.99 shows as 2.9, not 3.0');
});

test('accentWarning does not throw on an unreadable theme background', () => {
  const themes = [{ ...FAKE_THEMES[0], tokens: { color: { ...FAKE_THEMES[0].tokens.color, bg: 'not-a-colour' } } }];
  assert.equal(accentWarning(view({ accent: '#222222' }, FREE, themes)), null);
});

// ---- health status ----------------------------------------------------------------------------------------------------

test('summarizeStatus lists broken features in contract order and labels unknown ones safely', () => {
  const s = summarizeStatus({
    themeId: 'cinema', pageType: 'home',
    features: { 'calm-hideComments': 'broken', theme: 'on', 'layout-home': 'broken', density: 'locked', 'mystery-feature': 'broken', 'calm-hideShorts': 'off' },
  });
  assert.deepEqual(s.broken.map((b) => b.id), ['layout-home', 'calm-hideComments', 'mystery-feature']);
  assert.deepEqual(s.broken.map((b) => b.label), ['Home layout', 'Hide comments', 'mystery-feature']);
  assert.equal(s.themeId, 'cinema');
  assert.equal(s.pageType, 'home');
});

test('summarizeStatus accepts a wrapped reply and rejects things that are not statuses', () => {
  const inner = { themeId: 'minimal', pageType: 'watch', features: { theme: 'on' } };
  assert.deepEqual(summarizeStatus({ ok: true, status: inner }), { broken: [], themeId: 'minimal', pageType: 'watch' });
  for (const bad of [undefined, null, 'ok', 5, [], {}, { features: 'x' }, { features: null }, { status: { features: [] } }, { features: [] }]) {
    assert.equal(summarizeStatus(bad), null, JSON.stringify(bad));
  }
});

test('summarizeStatus truncates a hostile feature id and ignores unknown page types', () => {
  const long = `x${'y'.repeat(300)}`;
  const s = summarizeStatus({ pageType: '<b>', themeId: 7, features: { [long]: 'broken', __proto__: 'broken', constructor: 'broken' } });
  assert.ok(s.broken.every((b) => b.label.length <= 40));
  assert.equal(s.pageType, null);
  assert.equal(s.themeId, null);
});

test('statusCopy: working, paused (exact wording), idle, unreachable, checking', () => {
  const ok = summarizeStatus({ themeId: 'minimal', pageType: 'home', features: { theme: 'on' } });
  assert.deepEqual(statusCopy('ok', { summary: ok, themes: FAKE_THEMES }), { text: 'Working', detail: 'Minimal theme on the Home page' });
  assert.deepEqual(statusCopy('ok', { summary: { broken: [], themeId: null, pageType: null }, themes: FAKE_THEMES }), { text: 'Working', detail: '' });
  const paused = summarizeStatus({ features: { 'layout-home': 'broken' } });
  assert.equal(statusCopy('paused', { summary: paused }).text, 'Paused: Home layout — YouTube changed, a fix is on the way');
  assert.equal(statusCopy('paused', { summary: paused }).detail, 'Everything else keeps working.');
  assert.equal(statusCopy('idle').text, 'Open a YouTube tab to see status');
  assert.match(statusCopy('unreachable').detail, /Reload the YouTube tab/);
  assert.match(statusCopy('checking').text, /^Checking/);
  assert.deepEqual(statusCopy('nonsense'), { text: '', detail: '' });
});

test('statusCopy summarises many broken features instead of running on', () => {
  const many = summarizeStatus({ features: Object.fromEntries(FEATURES.map((f) => [f, 'broken'])) });
  const { text } = statusCopy('paused', { summary: many });
  assert.match(text, /^Paused: Theme, Home layout, Watch page layout and 7 more — YouTube changed/);
  assert.ok(text.length < 130);
});

test('copy tables cover every contract name', () => {
  assert.deepEqual(Object.keys(FEATURE_LABELS), FEATURES);
  assert.deepEqual(Object.keys(CALM_COPY), CALM_KEYS);
  assert.deepEqual(Object.keys(PAGE_LABELS).sort(), [...PAGE_TYPES].sort());
  assert.equal(DENSITY_LABELS.length, 5);
});

test('accent swatches: 6 to 8 distinct, well-formed colours with unique names', () => {
  assert.ok(ACCENT_SWATCHES.length >= 6 && ACCENT_SWATCHES.length <= 8);
  assert.equal(new Set(ACCENT_SWATCHES.map((s) => s.hex)).size, ACCENT_SWATCHES.length);
  assert.equal(new Set(ACCENT_SWATCHES.map((s) => s.name)).size, ACCENT_SWATCHES.length);
  for (const s of ACCENT_SWATCHES) assert.equal(strictHex(s.hex), s.hex);
  assert.ok(ACCENT_SWATCHES.some((s) => s.hex === '#e8b04a'), 'the brand gold is offered');
  assert.ok(Object.isFrozen(ACCENT_SWATCHES));
  // Each curated colour must work on the default (dark) theme, otherwise it would offer a warning out of the box.
  for (const s of ACCENT_SWATCHES) assert.ok(contrastRatio(s.hex, FAKE_THEMES[0].tokens.color.bg) >= 3, `${s.name} on Cinema`);
});

// ---- licence wording: "expired" only when the token itself has expired ----------------------------------------------------

test('parseLicence keeps a known lapse reason on an expired state and drops anything else', () => {
  assert.deepEqual(parseLicence({ state: { plan: 'free', status: 'expired', reason: 'token-expired' } }), { plan: 'free', status: 'expired', reason: 'token-expired' });
  assert.deepEqual(parseLicence({ plan: 'free', status: 'expired', reason: 'not-rechecked' }), { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  assert.deepEqual(parseLicence({ plan: 'free', status: 'expired', reason: '<img onerror=x>' }), { plan: 'free', status: 'expired' });
  assert.deepEqual(parseLicence({ plan: 'pro', status: 'active', reason: 'token-expired' }), { plan: 'pro', status: 'active' }, 'a reason only belongs to a lapse');
});

test('licenceKey and copy: a token with no expiry problem is never called "expired"', () => {
  const lapse = (reason) => ({ plan: 'free', status: 'expired', ...(reason ? { reason } : {}) });
  assert.equal(licenceKey(lapse('token-expired')), 'expired');
  assert.equal(licenceKey(lapse()), 'expired', 'no reason keeps the old wording');
  assert.equal(licenceKey(lapse('not-rechecked')), 'lapsed');
  assert.equal(licenceKey(lapse('invalid')), 'invalid');
  for (const key of ['lapsed', 'invalid']) {
    assert.doesNotMatch(LICENCE_COPY[key].label + LICENCE_COPY[key].detail, /expired/i, key);
    assert.match(LICENCE_COPY[key].detail, /paste your token again/i);
  }
  assert.match(lockedCopy({ kind: 'theme', name: 'Studio' }, 'lapsed'), /^Your Pro licence is paused. Studio is a Pro theme/);
  assert.doesNotMatch(lockedCopy({ kind: 'theme', name: 'Studio' }, 'lapsed'), /expired/);
});
