import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createChromeMock } from '../helpers/chrome-mock.js';
import {
  ALARM_LICENCE, ALARM_MAP, API_BASE, MANUAL_REFRESH_COOLDOWN_MS, createBackground, createChromeStore,
} from '../../src/background/service-worker.js';
import { parseMapVersion } from '../../src/background/map-updater.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { signEnvelope, toPublicJwk } from '../../src/shared/signing.js';
import { DEFAULT_SETTINGS, LIMITS, MSG, STORAGE_KEYS } from '../../src/shared/constants.js';

// The worker seeds calm empty on purpose: explicit false values would override a theme's own calm defaults.
const SEEDED = { ...DEFAULT_SETTINGS, calm: {} };
import * as publicKeys from '../../src/shared/public-keys.js';

const DAY = 864e5;
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const API = 'https://api.example.test';
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SOURCE_MAP = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const priv = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { priv, pub: toPublicJwk(priv) };
}
const LICENCE = await makeKeyPair('licence-test-1');
const MAPKEY = await makeKeyPair('selector-map-test-1');
const ATTACKER = await makeKeyPair('licence-test-1');

const secs = (ms) => Math.floor(ms / 1000);
const mintToken = (extra = {}, key = LICENCE.priv) => signLicenceToken(
  { v: 1, sub: 'user-1', plan: 'pro', iat: secs(T0) - 60, ...extra }, key,
);
function signedMap(version, edit) {
  const map = structuredClone(SOURCE_MAP);
  map.mapVersion = version;
  map.issuedAt = '2026-10-08T00:00:00Z';
  if (edit) edit(map);
  return signEnvelope(JSON.stringify(map), MAPKEY.priv, 'selector-map-test-1');
}

const respond = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const tick = () => new Promise((resolve) => setImmediate(resolve));

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}
const noNetwork = () => fakeFetch(async () => { throw new Error('no network call was expected'); });

function makeClock(start = T0) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; return clock.t; } };
  return clock;
}

/** A registered background on a fresh chrome mock. `apiBase: ''` is the MVP default (no network at all). */
function setup({ apiBase = '', fetch = noNetwork(), bundled = '2026.10.07.1', clock = makeClock(), register = true, ...rest } = {}) {
  const mock = createChromeMock({ now: clock.now });
  const bg = createBackground({
    chrome: mock.chrome, fetch, now: clock.now, apiBase,
    keys: { licence: LICENCE.pub, selectorMap: MAPKEY.pub },
    readBundledVersion: async () => bundled,
    ...rest,
  });
  if (register) bg.register();
  return { ...mock, bg, fetch, clock };
}

const local = (ctx) => ctx.chrome.storage.local;
const stored = async (ctx, key) => (await local(ctx).get(key))[key];
const send = (ctx, message) => ctx.chrome.runtime.sendMessage(message);
const fireAll = (event, ...args) => Promise.all(event.fire(...args));
const install = (ctx, reason = 'install') => fireAll(ctx.chrome.runtime.onInstalled, { reason });
const startup = (ctx) => fireAll(ctx.chrome.runtime.onStartup);
const clean = (ctx) => assert.deepEqual(ctx.listenerErrors, [], 'no listener threw');

const FRESH_TAB_SENDER = { tab: { id: 7 }, url: 'https://www.youtube.com/watch?v=abc' };
const POPUP_IN_TAB_SENDER = { tab: { id: 9 }, url: 'chrome-extension://test-id/popup/popup.html' };

// ---- the entry file ----------------------------------------------------------------------------------------------------------

test('API_BASE is empty in the MVP, which is what keeps the extension off the network', () => {
  assert.equal(API_BASE, '', 'set API_BASE only together with the manifest host permission and the privacy policy');
});

test('importing the worker module outside an extension has no side effects', () => {
  assert.equal(typeof globalThis.chrome, 'undefined');
});

test('the real bundled worker registers every listener synchronously and makes no network request', async () => {
  const out = await build({
    entryPoints: [fileURLToPath(new URL('../../src/background/service-worker.js', import.meta.url))],
    bundle: true, write: false, format: 'iife', platform: 'browser', target: 'chrome105',
    define: { __DEV__: 'false' }, absWorkingDir: ROOT, logLevel: 'silent',
  });
  const code = out.outputFiles[0].text;
  assert.doesNotMatch(code, /\beval\s*\(|new\s+Function\b|\bimport\s*\(/, 'no eval, new Function or dynamic import in the shipped worker');

  const mock = createChromeMock();
  const seen = [];
  const realFetch = globalThis.fetch;
  globalThis.chrome = mock.chrome;
  globalThis.fetch = async (url) => { seen.push(String(url)); throw new TypeError('offline'); };
  try {
    new vm.Script(code).runInThisContext();                        // synchronous: nothing may wait for a promise
    const { runtime, alarms } = mock.chrome;
    assert.equal(runtime.onInstalled.hasListeners(), true, 'onInstalled');
    assert.equal(runtime.onStartup.hasListeners(), true, 'onStartup');
    assert.equal(runtime.onMessage.hasListeners(), true, 'onMessage');
    assert.equal(alarms.onAlarm.hasListeners(), true, 'onAlarm');

    await fireAll(runtime.onInstalled, { reason: 'install' });
    assert.deepEqual((await mock.chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings], SEEDED);
    assert.deepEqual((await alarms.getAll()).map((a) => a.name).sort(), [ALARM_LICENCE, ALARM_MAP]);
    assert.deepEqual(await runtime.sendMessage({ type: MSG.GET_LICENCE }), {
      ok: true, state: { plan: 'free', status: 'none' }, plan: 'free', status: 'none',
    });
    assert.deepEqual(await runtime.sendMessage({ type: MSG.REFRESH_MAP }), { ok: true, skipped: true });
    await alarms.fire(ALARM_LICENCE);
    await alarms.fire(ALARM_MAP);
    assert.deepEqual(seen.filter((url) => !url.startsWith('chrome-extension://')), [], 'nothing left the browser');
    assert.deepEqual(mock.listenerErrors, []);
  } finally {
    delete globalThis.chrome;
    globalThis.fetch = realFetch;
  }
});

test('createBackground needs a chrome with storage, and works without the alarms permission', async () => {
  assert.throws(() => createBackground({}), TypeError);
  assert.throws(() => createBackground({ chrome: { runtime: {} } }), TypeError);
  const { chrome } = createChromeMock();
  const bare = { storage: chrome.storage, runtime: chrome.runtime };
  const bg = createBackground({ chrome: bare, keys: {}, readBundledVersion: async () => undefined });
  bg.register();
  await fireAll(chrome.runtime.onInstalled, { reason: 'install' });
  assert.deepEqual((await chrome.storage.local.get(STORAGE_KEYS.settings))[STORAGE_KEYS.settings], SEEDED);
});

test('the default keys are the shipped public keys: foreign signatures are refused, and the two keys differ', async () => {
  assert.notEqual(publicKeys.LICENCE_PUBLIC_KEY.x, publicKeys.SELECTOR_MAP_PUBLIC_KEY.x, 'licence and map keys must be separate');
  const { chrome } = createChromeMock();
  const bg = createBackground({ chrome, now: () => T0 });
  assert.deepEqual(await bg.licence.activate(await mintToken({}, ATTACKER.priv)), { ok: false, reason: 'bad-signature' });
  assert.deepEqual(await bg.licence.activate('garbage'), { ok: false, reason: 'malformed-token' });
});

// ---- install / startup -------------------------------------------------------------------------------------------------------

test('install writes the default settings when none exist', async () => {
  const ctx = setup();
  await install(ctx);
  assert.deepEqual(await stored(ctx, STORAGE_KEYS.settings), SEEDED);
  clean(ctx);
});

test('startup writes the defaults too (for example after the user cleared extension data)', async () => {
  const ctx = setup();
  await startup(ctx);
  assert.deepEqual(await stored(ctx, STORAGE_KEYS.settings), SEEDED);
});

test('existing settings are never overwritten, whatever the install reason', async () => {
  const mine = { schema: 1, themeId: 'minimal', accent: '#ff0066', density: 4, animations: false,
    calm: { hideShorts: true, hideHomeRecs: false, hideComments: true, hideEndScreens: false, hideViewCounts: false }, telemetryOptIn: true };
  const oldSchema = { themeId: 'classic' };
  for (const existing of [mine, oldSchema, {}, 'weird', 5, [], false, 0]) {
    for (const reason of ['install', 'update', 'chrome_update', 'shared_module_update']) {
      const ctx = setup();
      await local(ctx).set({ [STORAGE_KEYS.settings]: existing });
      const changes = [];
      ctx.chrome.storage.onChanged.addListener((c) => changes.push(c));
      ctx.spies['storage.local.set'].calls.length = 0;
      await install(ctx, reason);
      await startup(ctx);
      assert.deepEqual(await stored(ctx, STORAGE_KEYS.settings), existing, `${JSON.stringify(existing)} / ${reason}`);
      assert.equal(ctx.spies['storage.local.set'].callCount, 0, 'settings were not even rewritten');
      assert.deepEqual(changes, []);
    }
  }
});

test('a null settings value holds nothing and is replaced by the defaults', async () => {
  const ctx = setup();
  await local(ctx).set({ [STORAGE_KEYS.settings]: null });
  await install(ctx);
  assert.deepEqual(await stored(ctx, STORAGE_KEYS.settings), SEEDED);
});

test('the stored defaults are a copy: editing them never touches DEFAULT_SETTINGS', async () => {
  const ctx = setup();
  await install(ctx);
  const copy = await stored(ctx, STORAGE_KEYS.settings);
  copy.calm.hideShorts = true;
  await local(ctx).set({ [STORAGE_KEYS.settings]: copy });
  assert.equal(DEFAULT_SETTINGS.calm.hideShorts, false);
});

test('install creates the licence and map alarms with the contract periods, and only once', async () => {
  const ctx = setup();
  await install(ctx);
  const alarms = await ctx.chrome.alarms.getAll();
  const byName = Object.fromEntries(alarms.map((a) => [a.name, a]));
  assert.deepEqual(Object.keys(byName).sort(), ['cd-licence', 'cd-map']);
  assert.equal(ALARM_LICENCE, 'cd-licence');
  assert.equal(ALARM_MAP, 'cd-map');
  assert.equal(byName['cd-licence'].periodInMinutes, LIMITS.licenceRecheckMs / 60000);
  assert.equal(byName['cd-licence'].periodInMinutes, 7 * 24 * 60);
  assert.equal(byName['cd-map'].periodInMinutes, LIMITS.mapRefreshMs / 60000);
  assert.equal(byName['cd-map'].periodInMinutes, 360);
  assert.equal(ctx.spies['alarms.create'].callCount, 2);

  await startup(ctx);
  await install(ctx, 'update');
  await startup(ctx);
  assert.equal(ctx.spies['alarms.create'].callCount, 2, 'present alarms are left alone, so their schedule is not reset');
  clean(ctx);
});

test('only a missing or re-timed alarm is (re)created', async () => {
  const ctx = setup();
  await ctx.chrome.alarms.create('cd-licence', { periodInMinutes: 7 * 24 * 60 });
  await ctx.chrome.alarms.create('cd-map', { periodInMinutes: 5 });          // an older build used another period
  ctx.spies['alarms.create'].calls.length = 0;
  await startup(ctx);
  assert.deepEqual(ctx.spies['alarms.create'].calls, [['cd-map', { periodInMinutes: 360 }]]);

  ctx.spies['alarms.create'].calls.length = 0;
  await ctx.chrome.alarms.clear('cd-licence');
  await startup(ctx);
  assert.deepEqual(ctx.spies['alarms.create'].calls, [['cd-licence', { periodInMinutes: 10080 }]]);
});

test('install and startup firing together do the work once, not twice', async () => {
  const ctx = setup();
  await Promise.all([...ctx.chrome.runtime.onInstalled.fire({ reason: 'install' }), ...ctx.chrome.runtime.onStartup.fire()]);
  assert.equal(ctx.spies['alarms.create'].callCount, 2);
  assert.equal(ctx.spies['storage.local.set'].callCount, 1);
  clean(ctx);
});

test('one failing init step does not stop the others, and nothing throws out of the listeners', async () => {
  const ctx = setup();
  ctx.chrome.alarms.get = () => Promise.reject(new Error('alarms unavailable'));
  await install(ctx);
  assert.deepEqual(await stored(ctx, STORAGE_KEYS.settings), SEEDED);

  const other = setup();
  const realGet = other.chrome.storage.local.get;
  other.chrome.storage.local.get = () => Promise.reject(new Error('storage unavailable'));
  await install(other);
  other.chrome.storage.local.get = realGet;
  assert.equal((await other.chrome.alarms.getAll()).length, 2);
  clean(ctx);
  clean(other);
});

// ---- stale map housekeeping --------------------------------------------------------------------------------------------------

const envelopeAt = (mapVersion) => ({ payload: JSON.stringify({ mapVersion }), sig: 'x', kid: 'k' });

test('a stored map older than the bundled one (after an extension update) or unreadable is removed on startup', async () => {
  const cases = [
    [envelopeAt('2026.10.01.1'), true], [envelopeAt('2026.10.07.0'), true], [envelopeAt('2026.9.30.99'), true],
    [{ payload: 'not json', sig: 'x', kid: 'k' }, true], ['junk', true], [{ payload: JSON.stringify({ mapVersion: 'v7' }) }, true],
    [envelopeAt('2026.10.07.1'), false], [envelopeAt('2026.10.08.1'), false], [envelopeAt('2027.1.1.1'), false],
  ];
  for (const [envelope, removed] of cases) {
    const ctx = setup({ bundled: '2026.10.07.1' });
    await local(ctx).set({ [STORAGE_KEYS.selectorMap]: envelope });
    await startup(ctx);
    assert.equal((await stored(ctx, STORAGE_KEYS.selectorMap)) === undefined, removed, JSON.stringify(envelope).slice(0, 50));
  }
});

test('the stale-map cleanup leaves things alone when it cannot tell what is bundled, or there is nothing stored', async () => {
  for (const readBundledVersion of [async () => undefined, async () => null, async () => 'garbage', async () => { throw new Error('no file'); }]) {
    const ctx = setup({ readBundledVersion });
    await local(ctx).set({ [STORAGE_KEYS.selectorMap]: envelopeAt('2020.1.1.1') });
    await startup(ctx);
    assert.deepEqual(await stored(ctx, STORAGE_KEYS.selectorMap), envelopeAt('2020.1.1.1'));
  }
  const empty = setup();
  await startup(empty);
  assert.equal(empty.spies['storage.local.remove'].callCount, 0);
});

test('without a readBundledVersion override the bundled version comes from the packaged data file, not the network fetch', async () => {
  const packaged = await signedMap('2026.10.07.1');
  const realFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => { requested.push(String(url)); return respond(packaged); };
  try {
    const mock = createChromeMock();
    const injected = noNetwork();
    const bg = createBackground({ chrome: mock.chrome, fetch: injected, keys: { licence: LICENCE.pub, selectorMap: MAPKEY.pub } });
    bg.register();
    await mock.chrome.storage.local.set({ [STORAGE_KEYS.selectorMap]: envelopeAt('2026.10.01.1') });
    await fireAll(mock.chrome.runtime.onStartup);
    assert.deepEqual(requested, ['chrome-extension://test-id/data/selector-map.json']);
    assert.equal(injected.calls.length, 0);
    assert.equal((await mock.chrome.storage.local.get(STORAGE_KEYS.selectorMap))[STORAGE_KEYS.selectorMap], undefined);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- alarms --------------------------------------------------------------------------------------------------------------------

/** A tiny API: serves the given map and answers licence refreshes. */
function api({ map, licence = { status: 'active' } } = {}) {
  return fakeFetch(async (url) => {
    if (url === `${API}/selector-map.json`) return map ? respond(map) : respond('nope', { status: 404 });
    if (url === `${API}/licence/refresh`) return respond(licence);
    return respond('unexpected', { status: 418 });
  });
}

test('the map alarm refreshes the selector map; unknown alarms do nothing', async () => {
  const fetch = api({ map: await signedMap('2026.10.08.1') });
  const ctx = setup({ apiBase: API, fetch });
  await install(ctx);

  assert.deepEqual(await ctx.chrome.alarms.fire('some-other-alarm'), [undefined]);
  assert.deepEqual(await ctx.chrome.alarms.fire(''), [undefined]);
  assert.equal(fetch.calls.length, 0);

  const [result] = await ctx.chrome.alarms.fire(ALARM_MAP);
  assert.equal(result.ok, true);
  assert.equal(result.updated, true);
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, `${API}/selector-map.json`);
  assert.equal(fetch.calls[0].init.method, 'GET');
  assert.equal(parseMapVersion(await stored(ctx, STORAGE_KEYS.selectorMap)), '2026.10.08.1');
  clean(ctx);
});

test('the licence alarm re-checks the stored licence with the server, and only then', async () => {
  const fetch = api();
  const ctx = setup({ apiBase: API, fetch });
  await install(ctx);
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_LICENCE), [{ skipped: true, reason: 'no-licence' }]);
  assert.equal(fetch.calls.length, 0, 'no licence, nothing to send');

  const token = await mintToken();
  assert.equal((await send(ctx, { type: MSG.ACTIVATE_LICENCE, token })).ok, true);
  ctx.clock.advance(8 * DAY);
  const [result] = await ctx.chrome.alarms.fire(ALARM_LICENCE);
  assert.deepEqual(result, { ok: true, refreshed: true, state: { plan: 'pro', status: 'active' } });
  assert.equal(fetch.calls.length, 1);
  assert.equal(fetch.calls[0].url, `${API}/licence/refresh`);
  assert.deepEqual(JSON.parse(fetch.calls[0].init.body), { token });
  assert.equal((await stored(ctx, STORAGE_KEYS.licence)).checkedAt, ctx.clock.t);
  clean(ctx);
});

test('without an API_BASE no alarm ever causes a request, even with a licence and a stored map', async () => {
  const fetch = noNetwork();
  const ctx = setup({ apiBase: '', fetch });
  await install(ctx);
  await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() });
  await local(ctx).set({ [STORAGE_KEYS.selectorMap]: await signedMap('2026.10.08.1') });
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_LICENCE), [{ ok: true, refreshed: true, local: true, state: { plan: 'pro', status: 'active' } }],
    'the licence alarm only re-verifies the stored token on this machine');
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_MAP), [{ skipped: true }]);
  assert.equal(fetch.calls.length, 0);
});

test('without an API_BASE Pro does not lapse after 30 days: alarms and browser start-ups re-verify the token locally', async () => {
  const fetch = noNetwork();
  const ctx = setup({ apiBase: '', fetch });
  await install(ctx);
  assert.equal((await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() })).ok, true);
  const state = async () => (await send(ctx, { type: MSG.GET_LICENCE })).state;
  // Weekly alarms for a year: always active, never grace or expired.
  for (let week = 1; week <= 52; week++) {
    ctx.clock.advance(7 * DAY);
    await ctx.chrome.alarms.fire(ALARM_LICENCE);
    assert.deepEqual(await state(), { plan: 'pro', status: 'active' }, `week ${week}`);
  }
  // A browser that stayed closed for 400 days and has not fired its alarm yet is lapsed until the worker starts...
  ctx.clock.advance(400 * DAY);
  assert.deepEqual(await state(), { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  // ...and the start-up work (onStartup) re-verifies the token before any tab asks.
  await ctx.bg.handleStartup();
  assert.deepEqual(await state(), { plan: 'pro', status: 'active' });
  assert.equal(fetch.calls.length, 0);
});

test('a failing alarm job is contained: the listener resolves, nothing is thrown', async () => {
  const ctx = setup({ apiBase: API, fetch: fakeFetch(async () => { throw new TypeError('offline'); }) });
  await install(ctx);
  await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() });
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_LICENCE), [{ ok: false, reason: 'network' }]);
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_MAP), [{ ok: false, reason: 'network' }]);
  ctx.bg.licence.recheck = async () => { throw new Error('unexpected'); };
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_LICENCE), [{ ok: false, reason: 'error' }]);
  clean(ctx);
});

test('a map that fails verification never reaches storage through the alarm', async () => {
  const good = await signedMap('2026.10.08.1');
  const tampered = { ...good, payload: good.payload.replace('2026.10.08.1', '2026.10.09.1') };
  const ctx = setup({ apiBase: API, fetch: api({ map: tampered }) });
  await install(ctx);
  assert.deepEqual(await ctx.chrome.alarms.fire(ALARM_MAP), [{ ok: false, reason: 'bad-signature' }]);
  assert.equal(await stored(ctx, STORAGE_KEYS.selectorMap), undefined);
});

// ---- messages ----------------------------------------------------------------------------------------------------------------------

test('GET_LICENCE answers with the state, mirrored at the top level', async () => {
  const ctx = setup();
  await install(ctx);
  assert.deepEqual(await send(ctx, { type: MSG.GET_LICENCE }), { ok: true, state: { plan: 'free', status: 'none' }, plan: 'free', status: 'none' });
  assert.equal((await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() })).ok, true);
  assert.deepEqual(await send(ctx, { type: MSG.GET_LICENCE }), { ok: true, state: { plan: 'pro', status: 'active' }, plan: 'pro', status: 'active' });
  ctx.clock.advance(10 * DAY);
  assert.equal((await send(ctx, { type: MSG.GET_LICENCE })).status, 'grace');
  ctx.clock.advance(30 * DAY);
  assert.deepEqual((await send(ctx, { type: MSG.GET_LICENCE })).state, { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  clean(ctx);
});

test('ACTIVATE_LICENCE stores a valid token and reports the new state', async () => {
  const ctx = setup();
  await install(ctx);
  const token = await mintToken();
  const reply = await send(ctx, { type: MSG.ACTIVATE_LICENCE, token });
  assert.deepEqual(reply, { ok: true, state: { plan: 'pro', status: 'active' } });
  assert.deepEqual(await stored(ctx, STORAGE_KEYS.licence), {
    token, claims: { v: 1, sub: 'user-1', plan: 'pro', iat: secs(T0) - 60 }, checkedAt: T0,
  });
});

test('ACTIVATE_LICENCE with a bad token fails with a reason and changes nothing', async () => {
  const ctx = setup();
  await install(ctx);
  const good = await mintToken();
  await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: good });
  const bad = {
    garbage: ['not-a-token', 'malformed-token'],
    'foreign signature': [await mintToken({}, ATTACKER.priv), 'bad-signature'],
    expired: [await mintToken({ exp: secs(T0) - 5 }), 'expired'],
    'future issue date': [await mintToken({ iat: secs(T0) + 7200 }), 'not-yet-valid'],
  };
  for (const [label, [token, reason]] of Object.entries(bad)) {
    assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token }), { ok: false, reason }, label);
  }
  assert.equal((await stored(ctx, STORAGE_KEYS.licence)).token, good, 'the working licence survived');
  clean(ctx);
});

test('ACTIVATE_LICENCE with a missing or non-string token is "malformed", not a crash', async () => {
  const ctx = setup();
  await install(ctx);
  for (const message of [{ type: MSG.ACTIVATE_LICENCE }, { type: MSG.ACTIVATE_LICENCE, token: 42 }, { type: MSG.ACTIVATE_LICENCE, token: null },
    { type: MSG.ACTIVATE_LICENCE, token: { nested: 'x' } }, { type: MSG.ACTIVATE_LICENCE, token: ['a', 'b'] }, { type: MSG.ACTIVATE_LICENCE, token: '' },
    { type: MSG.ACTIVATE_LICENCE, token: '   ' }, { type: MSG.ACTIVATE_LICENCE, token: 'x'.repeat(100000) }]) {
    assert.deepEqual(await send(ctx, message), { ok: false, reason: 'malformed' }, JSON.stringify(message).slice(0, 60));
  }
  assert.equal(await stored(ctx, STORAGE_KEYS.licence), undefined);
  clean(ctx);
});

test('only our own pages may activate a licence: a content script on youtube.com is refused', async () => {
  const ctx = setup();
  await install(ctx);
  const token = await mintToken();
  ctx.setSender(FRESH_TAB_SENDER);
  assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token }), { ok: false, reason: 'forbidden' });
  ctx.setSender({ tab: { id: 7 } });                                                  // a tab sender with no url proves nothing
  assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token }), { ok: false, reason: 'forbidden' });
  ctx.setSender({ tab: { id: 7 }, url: 'chrome-extension://another-extension/page.html' });
  assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token }), { ok: false, reason: 'forbidden' });
  ctx.setSender({ id: 'some-other-extension' });
  assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token }), { ok: false, reason: 'forbidden' });
  assert.equal(await stored(ctx, STORAGE_KEYS.licence), undefined);

  ctx.setSender(POPUP_IN_TAB_SENDER);                                                 // our own page opened in a tab is fine
  assert.equal((await send(ctx, { type: MSG.ACTIVATE_LICENCE, token })).ok, true);
  ctx.setSender({});                                                                  // the popup: no tab
  assert.equal((await send(ctx, { type: MSG.ACTIVATE_LICENCE, token })).ok, true);
});

test('reading the licence state is allowed from a content script', async () => {
  const ctx = setup();
  ctx.setSender(FRESH_TAB_SENDER);
  assert.equal((await send(ctx, { type: MSG.GET_LICENCE })).ok, true);
});

test('messages that are not ours get no reply (other listeners may answer them) and never throw', async () => {
  const ctx = setup();
  await install(ctx);
  const unanswered = [
    undefined, null, 'cd:getLicence', 7, true, [], [MSG.GET_LICENCE], {}, { type: null }, { type: 5 }, { type: [MSG.GET_LICENCE] },
    { type: { toString: () => MSG.GET_LICENCE } }, { type: 'cd:getlicence' }, { type: ` ${MSG.GET_LICENCE}` }, { type: 'unknown' },
    { type: '__proto__' }, { type: 'constructor' }, { type: 'toString' }, { kind: MSG.GET_LICENCE }, { Type: MSG.GET_LICENCE },
    { type: MSG.GET_STATUS }, { type: MSG.STATUS_CHANGED },
  ];
  for (const message of unanswered) {
    await assert.rejects(send(ctx, message), /message port closed/, JSON.stringify(message));
  }
  assert.equal(await stored(ctx, STORAGE_KEYS.licence), undefined);
  clean(ctx);
});

test('replies are asynchronous: the channel stays open while a slow verifier works', async () => {
  const ctx = setup({
    verifyLicenceToken: async () => { await sleep(40); return { valid: true, reason: 'ok', claims: { v: 1, sub: 's', plan: 'pro', iat: 1 } }; },
  });
  const started = Date.now();
  const reply = await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: 'slow.token' });
  assert.equal(reply.ok, true);
  assert.ok(Date.now() - started >= 35);
  clean(ctx);
});

test('a handler that blows up still answers {ok:false}, and a dead reply channel is not an error', async () => {
  const ctx = setup();
  ctx.bg.licence.getState = async () => { throw new Error('boom'); };
  assert.deepEqual(await send(ctx, { type: MSG.GET_LICENCE }), { ok: false, reason: 'error' });
  ctx.bg.licence.activate = () => { throw new Error('sync boom'); };
  assert.deepEqual(await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: 'x' }), { ok: false, reason: 'error' });

  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    const keepOpen = ctx.bg.handleMessage({ type: MSG.GET_LICENCE }, {}, () => { throw new Error('The message port closed'); });
    assert.equal(keepOpen, true);
    await sleep(20);
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

// ---- REFRESH_MAP ---------------------------------------------------------------------------------------------------------------------

test('REFRESH_MAP without an API_BASE reports {ok:true, skipped:true} and never touches the network', async () => {
  const ctx = setup();
  assert.deepEqual(await send(ctx, { type: MSG.REFRESH_MAP }), { ok: true, skipped: true });
  assert.deepEqual(await send(ctx, { type: MSG.REFRESH_MAP }), { ok: true, skipped: true }, 'no cooldown applies when there is nothing to do');
  assert.equal(ctx.fetch.calls.length, 0);
});

test('REFRESH_MAP fetches, verifies and stores a newer map and returns the result object', async () => {
  const fetch = api({ map: await signedMap('2026.10.08.1') });
  const ctx = setup({ apiBase: API, fetch });
  const reply = await send(ctx, { type: MSG.REFRESH_MAP });
  assert.deepEqual(reply, { ok: true, updated: true, mapVersion: '2026.10.08.1', checkedAt: T0 });
  assert.equal(parseMapVersion(await stored(ctx, STORAGE_KEYS.selectorMap)), '2026.10.08.1');
  clean(ctx);
});

test('REFRESH_MAP reports every failure as {ok:false, reason} (tampered, unsigned, downgrade, offline, not found)', async () => {
  const good = await signedMap('2026.10.08.1');
  const cases = [
    [{ ...good, payload: good.payload.replace('2026.10.08.1', '2026.10.09.1') }, 'bad-signature'],
    [{ payload: good.payload, kid: good.kid }, 'unsigned'],
    [await signedMap('2026.10.06.1'), 'downgrade'],                         // older than the bundled 2026.10.07.1
  ];
  for (const [map, reason] of cases) {
    const ctx = setup({ apiBase: API, fetch: api({ map }) });
    assert.deepEqual(await send(ctx, { type: MSG.REFRESH_MAP }), { ok: false, reason });
    assert.equal(await stored(ctx, STORAGE_KEYS.selectorMap), undefined);
  }
  const offline = setup({ apiBase: API, fetch: fakeFetch(async () => { throw new TypeError('offline'); }) });
  assert.deepEqual(await send(offline, { type: MSG.REFRESH_MAP }), { ok: false, reason: 'network' });
  const missing = setup({ apiBase: API, fetch: api({}) });
  assert.deepEqual(await send(missing, { type: MSG.REFRESH_MAP }), { ok: false, reason: 'http-404' });
});

test('manual refreshes are limited to one per 30 s; alarms are not', async () => {
  assert.equal(MANUAL_REFRESH_COOLDOWN_MS, 30000);
  const fetch = api({ map: await signedMap('2026.10.08.1') });
  const ctx = setup({ apiBase: API, fetch });
  assert.equal((await send(ctx, { type: MSG.REFRESH_MAP })).updated, true);
  ctx.clock.advance(10000);
  assert.deepEqual(await send(ctx, { type: MSG.REFRESH_MAP }), { ok: false, reason: 'rate-limited' });
  assert.equal(fetch.calls.length, 1);
  const [viaAlarm] = await ctx.chrome.alarms.fire(ALARM_MAP);
  assert.equal(viaAlarm.reason, 'up-to-date', 'the alarm ran regardless of the cooldown');
  assert.equal(fetch.calls.length, 2);
  ctx.clock.advance(20000);
  assert.equal((await send(ctx, { type: MSG.REFRESH_MAP })).reason, 'up-to-date');
  assert.equal(fetch.calls.length, 3);
});

test('a failed manual refresh also counts toward the cooldown, and a clock that jumps back does not lock it out', async () => {
  const ctx = setup({ apiBase: API, fetch: fakeFetch(async () => { throw new TypeError('offline'); }) });
  assert.equal((await send(ctx, { type: MSG.REFRESH_MAP })).reason, 'network');
  assert.equal((await send(ctx, { type: MSG.REFRESH_MAP })).reason, 'rate-limited');
  ctx.clock.advance(-DAY);
  assert.equal((await send(ctx, { type: MSG.REFRESH_MAP })).reason, 'network', 'time went backwards: allow it');
});

test('overlapping refreshes (messages and the alarm) share a single network request', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const envelope = await signedMap('2026.10.08.1');
  const fetch = fakeFetch(async () => { await gate; return respond(envelope); });
  const ctx = setup({ apiBase: API, fetch });
  const first = send(ctx, { type: MSG.REFRESH_MAP });
  const second = send(ctx, { type: MSG.REFRESH_MAP });
  const alarm = ctx.chrome.alarms.fire(ALARM_MAP);
  await sleep(20);
  release();
  const [a, b, [c]] = await Promise.all([first, second, alarm]);
  assert.equal(fetch.calls.length, 1);
  assert.deepEqual([a.updated, b.updated, c.updated], [true, true, true]);
  clean(ctx);
});

test('the refresh floor is the bundled map: an older map than the one shipped is a downgrade', async () => {
  const ctx = setup({ apiBase: API, fetch: api({ map: await signedMap('2026.10.08.1') }), bundled: '2026.10.09.1' });
  assert.deepEqual(await send(ctx, { type: MSG.REFRESH_MAP }), { ok: false, reason: 'downgrade' });
  const noFloor = setup({ apiBase: API, fetch: api({ map: await signedMap('2020.1.1.1') }), readBundledVersion: async () => undefined });
  assert.equal((await send(noFloor, { type: MSG.REFRESH_MAP })).updated, true, 'unknown bundled version: any verified map is accepted');
});

// ---- statelessness -------------------------------------------------------------------------------------------------------------------

test('the worker keeps nothing in memory that matters: a freshly started worker sees the same licence, settings and map', async () => {
  const fetch = api({ map: await signedMap('2026.10.08.1') });
  const first = setup({ apiBase: API, fetch });
  await install(first);
  await send(first, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() });
  await send(first, { type: MSG.REFRESH_MAP });
  await local(first).set({ [STORAGE_KEYS.settings]: { ...DEFAULT_SETTINGS, themeId: 'minimal' } });

  // Chrome killed the worker: all listeners and closures are gone, storage and alarms persist.
  first.chrome.runtime.onMessage._clear();
  first.chrome.runtime.onInstalled._clear();
  first.chrome.runtime.onStartup._clear();
  first.chrome.alarms.onAlarm._clear();
  const reborn = createBackground({
    chrome: first.chrome, fetch, now: first.clock.now, apiBase: API, readBundledVersion: async () => '2026.10.07.1',
    keys: { licence: LICENCE.pub, selectorMap: MAPKEY.pub },
  });
  reborn.register();
  await startup(first);

  assert.deepEqual((await send(first, { type: MSG.GET_LICENCE })).state, { plan: 'pro', status: 'active' });
  assert.equal((await stored(first, STORAGE_KEYS.settings)).themeId, 'minimal', 'settings were not reset to defaults');
  assert.equal(parseMapVersion(await stored(first, STORAGE_KEYS.selectorMap)), '2026.10.08.1');
  assert.equal(first.spies['alarms.create'].callCount, 2, 'alarms survived, so none were recreated');
  clean(first);
});

// ---- the full year: an end-to-end walk with fake time ------------------------------------------------------------------------------

test('a user goes offline for six weeks: Pro lasts through the grace period, the map keeps its last good version', async () => {
  let online = true;
  const envelope = await signedMap('2026.10.08.1');
  const fetch = fakeFetch(async (url) => {
    if (!online) throw new TypeError('offline');
    return url.endsWith('/selector-map.json') ? respond(envelope) : respond({ status: 'active' });
  });
  const ctx = setup({ apiBase: API, fetch });
  await install(ctx);
  await send(ctx, { type: MSG.ACTIVATE_LICENCE, token: await mintToken() });
  await ctx.chrome.alarms.fire(ALARM_MAP);

  online = false;
  const statusAfter = async (days) => {
    ctx.clock.t = T0 + days * DAY;
    await ctx.chrome.alarms.fire(ALARM_LICENCE);
    await ctx.chrome.alarms.fire(ALARM_MAP);
    return (await send(ctx, { type: MSG.GET_LICENCE })).state;
  };
  assert.deepEqual(await statusAfter(6), { plan: 'pro', status: 'active' });
  assert.deepEqual(await statusAfter(14), { plan: 'pro', status: 'grace' });
  assert.deepEqual(await statusAfter(30), { plan: 'pro', status: 'grace' });
  assert.deepEqual(await statusAfter(31), { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  assert.equal(parseMapVersion(await stored(ctx, STORAGE_KEYS.selectorMap)), '2026.10.08.1');

  online = true;
  ctx.clock.t = T0 + 42 * DAY;
  await ctx.chrome.alarms.fire(ALARM_LICENCE);
  assert.deepEqual((await send(ctx, { type: MSG.GET_LICENCE })).state, { plan: 'pro', status: 'active' });
  clean(ctx);
});

// ---- the store adapter ------------------------------------------------------------------------------------------------------------

test('createChromeStore adapts chrome.storage to get/set/remove', async () => {
  const { chrome } = createChromeMock();
  const store = createChromeStore(chrome.storage.local);
  assert.equal(await store.get('k'), undefined);
  await store.set('k', { a: [1, 2] });
  assert.deepEqual(await store.get('k'), { a: [1, 2] });
  assert.deepEqual(await chrome.storage.local.get('k'), { k: { a: [1, 2] } });
  await store.remove('k');
  assert.equal(await store.get('k'), undefined);
  const odd = createChromeStore({ get: async () => undefined });
  assert.equal(await odd.get('k'), undefined);
});

// ---- schedule & profiles (Spec F8) ----------------------------------------------------------------------------------

test('schedule alarm: registers cd-schedule when enabled, removes it when disabled, applies scheduled profile', async () => {
  const clock = makeClock(T0); // T0 is 09:00 UTC
  const ctx = setup({ clock });
  await install(ctx);

  // Free user: checkSchedule does not apply
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.schedule]: {
      enabled: true,
      dayProfileId: 'minimal',
      nightProfileId: 'cinema',
      dayTime: '08:00',
      nightTime: '20:00',
    },
  });
  const resFree = await ctx.bg.checkSchedule();
  assert.equal(resFree.ok, false);
  assert.equal(resFree.reason, 'free');

  // Activate Pro
  const token = await mintToken();
  await send(ctx, { type: MSG.ACTIVATE_LICENCE, token });

  // Schedule alarm registered
  await ctx.bg.updateScheduleAlarm();
  const alarms = await ctx.chrome.alarms.getAll();
  assert.ok(alarms.some((a) => a.name === 'cd-schedule' && a.periodInMinutes === 1));

  // T0 is 09:00 (daytime) -> minimal
  const resDay = await ctx.bg.checkSchedule();
  assert.equal(resDay.ok, true);
  assert.equal(resDay.profileId, 'minimal');
  assert.equal(resDay.applied, true);

  const appliedSettings = await stored(ctx, STORAGE_KEYS.settings);
  assert.equal(appliedSettings.themeId, 'minimal');

  // Advance time to 21:00 (nighttime) -> cinema
  clock.advance(12 * 3600 * 1000);
  const resNight = await ctx.bg.checkSchedule();
  assert.equal(resNight.ok, true);
  assert.equal(resNight.profileId, 'cinema');
  assert.equal(resNight.applied, true);

  const nightSettings = await stored(ctx, STORAGE_KEYS.settings);
  assert.equal(nightSettings.themeId, 'cinema');

  // Disable schedule -> alarm cleared
  await ctx.chrome.storage.local.set({
    [STORAGE_KEYS.schedule]: { enabled: false },
  });
  await ctx.bg.updateScheduleAlarm();
  const alarmsAfter = await ctx.chrome.alarms.getAll();
  assert.ok(!alarmsAfter.some((a) => a.name === 'cd-schedule'));
});

