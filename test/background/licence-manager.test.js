import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLicenceManager, MAX_TOKEN_CHARS, REFRESH_MAX_BYTES } from '../../src/background/licence-manager.js';
import { signLicenceToken } from '../../src/shared/licence.js';
import { base64urlEncode, toPublicJwk } from '../../src/shared/signing.js';
import { LIMITS, STORAGE_KEYS } from '../../src/shared/constants.js';

const DAY = 864e5;
const T0 = Date.UTC(2026, 9, 8, 9, 0, 0);
const API = 'https://api.example.test';
const KEY = STORAGE_KEYS.licence;

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const priv = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { priv, pub: toPublicJwk(priv) };
}
const SERVER = await makeKeyPair('licence-test-1');
const ATTACKER = await makeKeyPair('licence-test-1');

const secs = (ms) => Math.floor(ms / 1000);
/** Licence claims as the server would issue them at time `t` (iat/exp are Unix SECONDS). */
const claimsAt = (extra = {}, t = T0) => ({ v: 1, sub: 'user-1', plan: 'pro', iat: secs(t) - 60, ...extra });
const mint = (extra, { key = SERVER.priv, t = T0 } = {}) => signLicenceToken(claimsAt(extra, t), key);
const isPro = (state) => state.plan === 'pro' && (state.status === 'active' || state.status === 'grace');

function makeClock(start = T0) {
  const clock = { t: start, now: () => clock.t, advance(ms) { clock.t += ms; return clock.t; } };
  return clock;
}

function memoryStore(initial = {}) {
  const data = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const log = [];
  return {
    data,
    log,
    async get(key) { const v = data.get(key); return v === undefined ? undefined : structuredClone(v); },
    async set(key, value) { log.push(['set', key]); data.set(key, structuredClone(value)); },
    async remove(key) { log.push(['remove', key]); data.delete(key); },
  };
}

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, init) => { calls.push({ url, init }); return handler(url, init, calls.length); };
  fn.calls = calls;
  return fn;
}
const respond = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
const serving = (body, init) => fakeFetch(async () => respond(body, init));
const offline = () => fakeFetch(async () => { throw new TypeError('Failed to fetch'); });
const never = () => new Promise(() => {});

function setup({ apiBase = '', clock = makeClock(), fetch, store = memoryStore(), ...rest } = {}) {
  const manager = createLicenceManager({ store, now: clock.now, apiBase, fetch, publicKey: SERVER.pub, ...rest });
  return { manager, store, clock, fetch };
}

/** Activates a fresh pro token and returns everything a recheck test needs. */
async function activated({ fetch, extra, ...rest } = {}) {
  const ctx = setup({ apiBase: API, fetch, ...rest });
  const token = await mint(extra);
  assert.equal((await ctx.manager.activate(token)).ok, true);
  return { ...ctx, token };
}

// ---- activate ----------------------------------------------------------------------------------------------------------

test('activating a valid token stores {token, claims, checkedAt} and reports the state', async () => {
  const { manager, store } = setup();
  const token = await mint();
  const result = await manager.activate(token);
  assert.deepEqual(result, { ok: true, state: { plan: 'pro', status: 'active' } });
  assert.ok(!JSON.stringify(result).includes(token), 'the reply does not echo the token back');
  assert.deepEqual(store.log, [['set', KEY]]);
  assert.deepEqual(store.data.get(KEY), { token, claims: claimsAt(), checkedAt: T0 });
});

test('the licence survives a restart: a brand new manager on the same storage sees it', async () => {
  const { store, clock } = setup();
  await setup({ store, clock }).manager.activate(await mint());
  const reborn = setup({ store, clock }).manager;
  assert.deepEqual(await reborn.getState(), { plan: 'pro', status: 'active' });
});

test('a token pasted with line breaks, spaces or tabs is cleaned up before it is verified and stored', async () => {
  const { manager, store } = setup();
  const token = await mint();
  const wrapped = `  \n${token.match(/.{1,40}/g).join('\r\n')}\t\n `;
  assert.equal((await manager.activate(wrapped)).ok, true);
  assert.equal(store.data.get(KEY).token, token);
});

test('only the known claim fields are stored; anything extra in a signed token is dropped', async () => {
  const { manager, store } = setup();
  const token = await signLicenceToken({ ...claimsAt(), admin: true, plan2: 'pro', nested: { x: 1 } }, SERVER.priv);
  assert.equal((await manager.activate(token)).ok, true);
  assert.deepEqual(store.data.get(KEY).claims, claimsAt());
});

test('free-plan, devices and exp claims round-trip', async () => {
  const { manager, store } = setup();
  const token = await mint({ plan: 'free', devices: 3, exp: secs(T0) + 365 * 86400 });
  assert.deepEqual(await manager.activate(token), { ok: true, state: { plan: 'free', status: 'active' } });
  assert.equal(store.data.get(KEY).claims.devices, 3);
});

test('invalid tokens are refused with the verifier\'s reason and never written', async () => {
  const good = await mint();
  const [claimsPart, sigPart] = good.split('.');
  const forgedClaims = base64urlEncode(JSON.stringify({ ...claimsAt(), sub: 'someone-else' }));
  const cases = {
    'not a token at all': ['hello world', 'malformed-token'],
    'one segment': [claimsPart, 'malformed-token'],
    'three segments (JWT shape)': [`${claimsPart}.${claimsPart}.${sigPart}`, 'malformed-token'],
    'alg:none JWT': ['eyJhbGciOiJub25lIn0.eyJ2IjoxfQ.', 'malformed-token'],
    'not base64url': ['@@@.@@@', 'malformed-token'],
    'claims swapped, signature kept': [`${forgedClaims}.${sigPart}`, 'bad-signature'],
    'signature of another token': [`${claimsPart}.${(await mint({ sub: 'user-2' })).split('.')[1]}`, 'bad-signature'],
    'signed by someone else': [await mint({}, { key: ATTACKER.priv }), 'bad-signature'],
    'expired': [await mint({ exp: secs(T0) - 10 }), 'expired'],
    'issued in the future': [await mint({ iat: secs(T0) + 3600 }), 'not-yet-valid'],
    'unknown claims version': [await mint({ v: 2 }), 'unsupported-version'],
    'unknown plan': [await mint({ plan: 'enterprise' }), 'bad-plan'],
    'no subject': [await mint({ sub: '' }), 'bad-claims'],
  };
  for (const [label, [token, reason]] of Object.entries(cases)) {
    const { manager, store } = setup();
    assert.deepEqual(await manager.activate(token), { ok: false, reason }, label);
    assert.deepEqual(store.log, [], `${label}: nothing written`);
    assert.deepEqual(await manager.getState(), { plan: 'free', status: 'none' }, label);
  }
});

test('non-string, empty and oversized input is "malformed" without reaching the verifier', async () => {
  let verified = 0;
  const { manager, store } = setup({ verifyLicenceToken: async () => { verified++; return { valid: true, claims: claimsAt() }; } });
  const inputs = [undefined, null, 123, true, {}, [], ['a.b'], '', '   ', '\n\t', 'x'.repeat(MAX_TOKEN_CHARS + 1), `${'a'.repeat(9000)}.${'b'.repeat(9000)}`];
  for (const input of inputs) {
    assert.deepEqual(await manager.activate(input), { ok: false, reason: 'malformed' }, String(input).slice(0, 20));
  }
  assert.equal(verified, 0);
  assert.deepEqual(store.log, []);
});

test('a failed activation leaves a working licence alone', async () => {
  const { manager, store } = setup();
  const good = await mint();
  await manager.activate(good);
  const before = structuredClone(store.data.get(KEY));
  for (const bad of ['garbage', await mint({}, { key: ATTACKER.priv }), await mint({ exp: secs(T0) - 1 }), '']) {
    assert.equal((await manager.activate(bad)).ok, false);
  }
  assert.deepEqual(store.data.get(KEY), before);
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' });
});

test('activating again replaces the stored licence', async () => {
  const { manager, store, clock } = setup();
  await manager.activate(await mint({ sub: 'user-1' }));
  clock.advance(3 * DAY);
  const second = await mint({ sub: 'user-2' }, { t: clock.t });
  assert.equal((await manager.activate(second)).ok, true);
  assert.deepEqual(store.data.get(KEY), { token: second, claims: claimsAt({ sub: 'user-2' }, clock.t), checkedAt: clock.t });
});

test('a broken verifier, a verifier that lies, a failing store and a missing key all end as {ok:false}', async () => {
  const token = await mint();
  const throwing = setup({ verifyLicenceToken: async () => { throw new Error('crypto exploded'); } });
  assert.deepEqual(await throwing.manager.activate(token), { ok: false, reason: 'verify-error' });

  for (const verdict of [undefined, null, {}, { valid: 'yes', claims: claimsAt() }, { valid: true }, { valid: true, claims: 'x' },
    { valid: false, reason: 'x'.repeat(200) }, { valid: false, reason: 5 }]) {
    const lying = setup({ verifyLicenceToken: async () => verdict });
    const result = await lying.manager.activate(token);
    assert.equal(result.ok, false, JSON.stringify(verdict));
    assert.ok(typeof result.reason === 'string' && result.reason.length <= 64);
    assert.deepEqual(lying.store.log, []);
  }

  const full = setup();
  full.store.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  assert.deepEqual(await full.manager.activate(token), { ok: false, reason: 'storage-error' });

  const keyless = createLicenceManager({ store: memoryStore(), now: () => T0, publicKey: undefined });
  assert.deepEqual(await keyless.activate(token), { ok: false, reason: 'no-key' });
});

// ---- getState ------------------------------------------------------------------------------------------------------------

test('getState: nothing stored means free/none, and so does anything that is not a licence record', async () => {
  assert.deepEqual(await setup().manager.getState(), { plan: 'free', status: 'none' });
  const token = await mint();
  const good = { token, claims: claimsAt(), checkedAt: T0 };
  const broken = [
    'a string', 5, [], null, {}, { token },
    { ...good, token: '' }, { ...good, token: 7 }, { ...good, claims: 'pro' }, { ...good, claims: null }, { ...good, checkedAt: 'yesterday' },
    { ...good, checkedAt: null }, { ...good, claims: { plan: 'pro' } },                   // hand-edited claims that are not a licence
    { ...good, claims: { ...claimsAt(), plan: 'platinum' } },
  ];
  for (const record of broken) {
    const { manager } = setup({ store: memoryStore({ [KEY]: record }) });
    assert.deepEqual(await manager.getState(), { plan: 'free', status: 'none' }, JSON.stringify(record).slice(0, 60));
  }
});

test('getState reports only plan and status, and throwing shared code or storage cannot escape', async () => {
  const { manager } = setup();
  await manager.activate(await mint({ devices: 3 }));
  assert.deepEqual(Object.keys(await manager.getState()).sort(), ['plan', 'status']);

  const crashing = setup({ licenceState: () => { throw new Error('boom'); }, store: memoryStore({ [KEY]: { token: 't', claims: claimsAt(), checkedAt: T0 } }) });
  assert.deepEqual(await crashing.manager.getState(), { plan: 'free', status: 'none' });

  const unreadable = setup();
  unreadable.store.get = async () => { throw new Error('storage gone'); };
  assert.deepEqual(await unreadable.manager.getState(), { plan: 'free', status: 'none' });
});

test('a stored check time in the future (clock fiddling) does not buy Pro', async () => {
  const token = await mint();
  const store = memoryStore({ [KEY]: { token, claims: claimsAt(), checkedAt: T0 + 30 * DAY } });
  const { manager } = setup({ store });
  assert.equal(isPro(await manager.getState()), false);
});

// ---- recheck: when it must do nothing -------------------------------------------------------------------------------------

test('recheck without an apiBase never touches the network: it re-verifies the stored token locally and moves checkedAt', async () => {
  for (const apiBase of ['', '   ', undefined, null]) {
    const fetch = fakeFetch(async () => { throw new Error('must not be called'); });
    const clock = makeClock();
    const { manager, store } = setup({ apiBase, fetch, clock });
    const token = await mint();
    await manager.activate(token);
    clock.advance(10 * DAY);
    store.log.length = 0;
    assert.deepEqual(await manager.recheck(), { ok: true, refreshed: true, local: true, state: { plan: 'pro', status: 'active' } });
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(store.log, [['set', KEY]]);
    assert.deepEqual(store.data.get(KEY), { token, claims: claimsAt(), checkedAt: T0 + 10 * DAY });
  }
});

test('no server: the weekly local re-check keeps a lifetime token Pro past the 7 and 30 day boundaries, for as long as the alarm runs', async () => {
  const clock = makeClock();
  const { manager, store } = setup({ apiBase: '', clock });
  assert.equal((await manager.activate(await mint())).ok, true);
  // Without the re-check the record ages exactly like the server machinery says (the unintended lock this fixes).
  clock.t = T0 + 7 * DAY;
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' });
  clock.t = T0 + 7 * DAY + 1;
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'grace' });
  clock.t = T0 + 30 * DAY + 1;
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'expired', reason: 'not-rechecked' }, 'nobody re-checked it');
  // A start-up / alarm re-check revives it, because the token itself is still good.
  assert.equal((await manager.recheck()).ok, true);
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' });
  for (let week = 1; week <= 60; week++) {
    clock.t += 7 * DAY;
    assert.equal((await manager.recheck()).ok, true);
    assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' }, `week ${week}`);
  }
  assert.equal(store.data.get(KEY).checkedAt, clock.t);
});

test("no server: the token's own exp is the only expiry, and it is reported as such", async () => {
  const clock = makeClock();
  const { manager, store } = setup({ apiBase: '', clock });
  assert.equal((await manager.activate(await mint({ exp: secs(T0) + 40 * 86400 }))).ok, true);
  for (const week of [1, 2, 3, 4, 5]) {
    clock.t = T0 + week * 7 * DAY;
    assert.equal((await manager.recheck()).ok, true, `week ${week}`);
  }
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' }, 'day 35 of a 40 day token');
  clock.t = T0 + 40 * DAY;
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'expired', reason: 'token-expired' });
  const before = structuredClone(store.data.get(KEY));
  assert.deepEqual(await manager.recheck(), { ok: false, reason: 'expired' }, 'an expired token is not refreshed');
  assert.deepEqual(store.data.get(KEY), before);
});

test('no server: a record edited by hand is not believed and not blessed; a failing signature is left alone', async () => {
  const clock = makeClock();
  const free = await mint({ plan: 'free' });
  const store = memoryStore({ [KEY]: { token: free, claims: claimsAt({ plan: 'pro' }), checkedAt: T0 } });
  const { manager } = setup({ apiBase: '', clock, store });
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'expired', reason: 'invalid' }, 'stored plan pro, signed plan free');
  // The local re-check rewrites claims from the signed token: the edit is gone and the licence is simply free.
  assert.equal((await manager.recheck()).ok, true);
  assert.equal(store.data.get(KEY).claims.plan, 'free');
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'active' });

  const forged = await mint({}, { key: ATTACKER.priv });
  const store2 = memoryStore({ [KEY]: { token: forged, claims: claimsAt(), checkedAt: T0 } });
  const second = setup({ apiBase: '', clock, store: store2 }).manager;
  assert.deepEqual(await second.getState(), { plan: 'free', status: 'expired', reason: 'invalid' });
  assert.deepEqual(await second.recheck(), { ok: false, reason: 'bad-signature' });
  assert.equal(store2.data.get(KEY).checkedAt, T0, 'a token that does not verify is never refreshed');
});

test('recheck with an apiBase but no licence has nothing to check and does not call out', async () => {
  const fetch = serving({ status: 'active' });
  const { manager } = setup({ apiBase: API, fetch });
  assert.deepEqual(await manager.recheck(), { skipped: true, reason: 'no-licence' });
  assert.equal(fetch.calls.length, 0);
});

test('an unusable apiBase never receives the token (plain http, credentials, query)', async () => {
  for (const apiBase of ['http://api.example.test', 'https://u:p@api.example.test', 'https://api.example.test?x=1', 'not a url', 7]) {
    const fetch = serving({ status: 'active' });
    const { manager } = await activated({ fetch, apiBase });
    assert.deepEqual(await manager.recheck(), { ok: false, reason: 'bad-api-base' }, String(apiBase));
    assert.equal(fetch.calls.length, 0);
  }
});

test('without a public key recheck refuses before sending anything', async () => {
  const fetch = serving({ status: 'active' });
  const store = memoryStore({ [KEY]: { token: await mint(), claims: claimsAt(), checkedAt: T0 } });
  const manager = createLicenceManager({ store, now: () => T0, apiBase: API, fetch, publicKey: undefined });
  assert.deepEqual(await manager.recheck(), { ok: false, reason: 'no-key' });
  assert.equal(fetch.calls.length, 0);
});

// ---- recheck: what it sends ------------------------------------------------------------------------------------------------

test('recheck POSTs only the licence token: fixed URL, JSON body {token}, no cookies, no referrer, no redirects', async () => {
  const fetch = serving({ status: 'active' });
  const { manager, token } = await activated({ fetch });
  await manager.recheck();
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, `${API}/licence/refresh`);
  assert.equal(new URL(url).search, '');
  assert.equal(init.method, 'POST');
  assert.deepEqual(JSON.parse(init.body), { token });
  assert.deepEqual(init.headers, { 'content-type': 'application/json' });
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.redirect, 'error');
  assert.equal(init.cache, 'no-store');
  assert.deepEqual(Object.keys(init).sort(), ['body', 'cache', 'credentials', 'headers', 'method', 'redirect', 'referrerPolicy', 'signal']);
});

// ---- recheck: success -------------------------------------------------------------------------------------------------------

test('a server "active" re-verifies the stored token and moves checkedAt to now', async () => {
  const { manager, store, clock, token } = await activated({ fetch: serving({ status: 'active' }) });
  clock.advance(8 * DAY);
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'grace' });
  const result = await manager.recheck();
  assert.deepEqual(result, { ok: true, refreshed: true, state: { plan: 'pro', status: 'active' } });
  assert.deepEqual(store.data.get(KEY), { token, claims: claimsAt(), checkedAt: clock.t });
});

test('a server "active" with a fresh signed token of the same subscriber replaces the stored token', async () => {
  const clock = makeClock();
  const fresh = await mint({ exp: secs(T0) + 400 * 86400, devices: 3 }, { t: T0 });
  const { manager, store } = await activated({ clock, fetch: serving({ status: 'active', token: `${fresh.slice(0, 30)}\n${fresh.slice(30)}` }) });
  clock.advance(10 * DAY);
  const result = await manager.recheck();
  assert.equal(result.ok, true);
  assert.deepEqual(store.data.get(KEY), { token: fresh, claims: claimsAt({ exp: secs(T0) + 400 * 86400, devices: 3 }), checkedAt: clock.t });
});

test('the server cannot grant anything with a bare field: plan, claims and extra properties in the reply are ignored', async () => {
  const { manager, store, token } = await activated({
    extra: { plan: 'free' },
    fetch: serving({ status: 'active', plan: 'pro', claims: { plan: 'pro', exp: 9e9 }, checkedAt: 9e15, devices: 100 }),
  });
  await manager.recheck();
  const record = store.data.get(KEY);
  assert.equal(record.token, token);
  assert.equal(record.claims.plan, 'free');
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'active' });
});

// ---- recheck: every way it can fail leaves the cached licence exactly as it was ----------------------------------------------

test('failures of any kind change nothing: the cached licence keeps working', async () => {
  const bigBody = JSON.stringify({ status: 'active', pad: 'x'.repeat(REFRESH_MAX_BYTES + 1) });
  const cases = {
    'offline': [offline(), 'network'],
    'fetch throws synchronously': [() => { throw new Error('boom'); }, 'network'],
    'timeout': [fakeFetch(never), 'timeout', { timeoutMs: 30 }],
    '500': [serving('oops', { status: 500 }), 'http-500'],
    '502 with HTML': [serving('<html>bad gateway</html>', { status: 502 }), 'http-502'],
    '503': [serving({ status: 'active' }, { status: 503 }), 'http-503'],
    '404 with HTML': [serving('<h1>Not found</h1>', { status: 404 }), 'http-404'],
    '401 with JSON': [serving({ error: 'nope' }, { status: 401 }), 'http-401'],
    '429': [serving({ status: 'active' }, { status: 429 }), 'http-429'],
    'captive portal 200 HTML': [serving('<html>Please sign in to the wifi</html>'), 'invalid-response'],
    'empty 200': [serving(''), 'invalid-response'],
    '200 {}': [serving({}), 'invalid-response'],
    '200 unknown status': [serving({ status: 'pending' }), 'invalid-response'],
    '200 array': [serving('[]'), 'invalid-response'],
    '200 null': [serving('null'), 'invalid-response'],
    '200 status:active as a string in an array': [serving('["active"]'), 'invalid-response'],
    'oversized reply': [serving(bigBody), 'too-large'],
    'token field that is not a string': [serving({ status: 'active', token: 5 }), 'invalid-response'],
    'token field that is an object': [serving({ status: 'active', token: { x: 1 } }), 'invalid-response'],
    'garbage token': [serving({ status: 'active', token: 'garbage' }), 'token-invalid'],
    'fresh token signed by someone else': [fakeFetch(async () => respond({ status: 'active', token: await mint({}, { key: ATTACKER.priv }) })), 'token-invalid'],
    'fresh token for another subscriber': [fakeFetch(async () => respond({ status: 'active', token: await mint({ sub: 'user-2' }) })), 'invalid-response'],
    'fresh token already expired': [fakeFetch(async () => respond({ status: 'active', token: await mint({ exp: secs(T0) + 1 }) })), 'token-invalid'],
  };
  for (const [label, [fetch, reason, rest]] of Object.entries(cases)) {
    const ctx = await activated({ fetch, ...rest });
    ctx.clock.advance(9 * DAY);                                          // past the weekly check, inside grace
    const before = structuredClone(ctx.store.data.get(KEY));
    ctx.store.log.length = 0;
    const result = await ctx.manager.recheck();
    assert.deepEqual(result, { ok: false, reason }, label);
    assert.deepEqual(ctx.store.data.get(KEY), before, `${label}: record untouched`);
    assert.deepEqual(ctx.store.log, [], `${label}: no storage writes`);
    assert.deepEqual(await ctx.manager.getState(), { plan: 'pro', status: 'grace' }, `${label}: still Pro inside grace`);
  }
});

test('"active" cannot extend a token whose own expiry has passed', async () => {
  const exp = secs(T0) + 10 * 86400;
  const ctx = await activated({ extra: { exp }, fetch: serving({ status: 'active' }) });
  ctx.clock.advance(9 * DAY);
  assert.equal((await ctx.manager.recheck()).ok, true, 'still inside its term');
  ctx.clock.advance(2 * DAY);
  assert.deepEqual(await ctx.manager.recheck(), { ok: false, reason: 'token-invalid' });
  assert.equal(isPro(await ctx.manager.getState()), false);
});

// ---- recheck: revocation -----------------------------------------------------------------------------------------------------

test('an explicit "revoked" answer removes the licence', async () => {
  for (const status of [200, 400, 403, 404, 410]) {
    const ctx = await activated({ fetch: serving({ status: 'revoked' }, { status }) });
    ctx.store.log.length = 0;
    assert.deepEqual(await ctx.manager.recheck(), { ok: true, revoked: true, state: { plan: 'free', status: 'none' } }, String(status));
    assert.deepEqual(ctx.store.log, [['remove', KEY]]);
    assert.deepEqual(await ctx.manager.getState(), { plan: 'free', status: 'none' });
  }
});

test('anything that merely looks like a rejection is not a revocation (server errors, captive portals, proxies)', async () => {
  const lookalikes = [
    serving({ status: 'revoked' }, { status: 500 }),
    serving({ status: 'revoked' }, { status: 503 }),
    serving('<html>Access denied by proxy</html>', { status: 403 }),
    serving({ error: 'forbidden' }, { status: 403 }),
    serving('revoked', { status: 410 }),
    serving({ revoked: true }, { status: 200 }),
    serving({ status: 'Revoked' }, { status: 200 }),
  ];
  for (const fetch of lookalikes) {
    const ctx = await activated({ fetch });
    assert.equal((await ctx.manager.recheck()).ok, false);
    assert.equal(ctx.store.data.has(KEY), true);
    assert.equal(isPro(await ctx.manager.getState()), true);
  }
});

// ---- recheck racing activate -------------------------------------------------------------------------------------------------

test('a recheck that was in flight when the user activated a new token does not overwrite it', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = fakeFetch(async () => { await gate; return respond({ status: 'active' }); });
  const ctx = await activated({ fetch });
  const pending = ctx.manager.recheck();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = await mint({ sub: 'user-2' });
  assert.equal((await ctx.manager.activate(replacement)).ok, true);
  release();
  assert.deepEqual(await pending, { ok: false, reason: 'superseded' });
  assert.equal(ctx.store.data.get(KEY).token, replacement);
});

test('a revocation that arrives after the user activated a different token does not remove the new one', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetch = fakeFetch(async () => { await gate; return respond({ status: 'revoked' }); });
  const ctx = await activated({ fetch });
  const pending = ctx.manager.recheck();
  await new Promise((resolve) => setImmediate(resolve));
  const replacement = await mint({ sub: 'user-2' });
  await ctx.manager.activate(replacement);
  release();
  assert.deepEqual(await pending, { ok: false, reason: 'superseded' });
  assert.equal(ctx.store.data.get(KEY).token, replacement);
});

// ---- grace, end to end with fake time ----------------------------------------------------------------------------------------

test('offline grace: Pro stays on for 30 days without a successful check, then lapses, and a later check revives it', async () => {
  const clock = makeClock();
  let online = false;
  const fetch = fakeFetch(async () => { if (!online) throw new TypeError('Failed to fetch'); return respond({ status: 'active' }); });
  const { manager, store, token } = await activated({ clock, fetch });
  assert.equal(LIMITS.licenceRecheckMs, 7 * DAY);
  assert.equal(LIMITS.offlineGraceMs, 30 * DAY);
  const stateAt = async (offsetMs) => { clock.t = T0 + offsetMs; return manager.getState(); };

  assert.deepEqual(await stateAt(0), { plan: 'pro', status: 'active' });
  assert.deepEqual(await stateAt(7 * DAY), { plan: 'pro', status: 'active' }, 'inclusive');
  assert.deepEqual(await stateAt(7 * DAY + 1), { plan: 'pro', status: 'grace' });

  // The weekly alarms fire while the user is offline: every one fails and nothing changes.
  for (const week of [1, 2, 3, 4]) {
    clock.t = T0 + week * 7 * DAY + 1000;
    assert.deepEqual(await manager.recheck(), { ok: false, reason: 'network' });
    assert.equal(store.data.get(KEY).checkedAt, T0, `week ${week}: checkedAt was not moved by a failed check`);
    assert.equal(store.data.get(KEY).token, token);
  }
  assert.deepEqual(await stateAt(29 * DAY), { plan: 'pro', status: 'grace' });
  assert.deepEqual(await stateAt(30 * DAY), { plan: 'pro', status: 'grace' }, 'inclusive');
  assert.deepEqual(await stateAt(30 * DAY + 1), { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  assert.equal(store.data.has(KEY), true, 'the token is kept, only the entitlement lapses');

  online = true;
  clock.t = T0 + 45 * DAY;
  assert.deepEqual(await manager.recheck(), { ok: true, refreshed: true, state: { plan: 'pro', status: 'active' } });
  assert.deepEqual(await stateAt(45 * DAY + 6 * DAY), { plan: 'pro', status: 'active' });
});

test('with the weekly check succeeding, the licence never leaves "active"', async () => {
  const clock = makeClock();
  const { manager } = await activated({ clock, fetch: serving({ status: 'active' }) });
  for (let week = 1; week <= 20; week++) {
    clock.t = T0 + week * 7 * DAY;
    assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' }, `week ${week} before the check`);
    assert.equal((await manager.recheck()).ok, true);
  }
});

test('one missed week is invisible; a flaky server alternating fail/succeed keeps Pro on', async () => {
  const clock = makeClock();
  let n = 0;
  const fetch = fakeFetch(async () => (++n % 2 ? respond('oops', { status: 500 }) : respond({ status: 'active' })));
  const { manager } = await activated({ clock, fetch });
  for (let week = 1; week <= 12; week++) {
    clock.t = T0 + week * 7 * DAY;
    assert.equal(isPro(await manager.getState()), true, `week ${week}`);
    await manager.recheck();
  }
});

test('a licence that has its own expiry date ends then, however recently it was checked', async () => {
  const clock = makeClock();
  const { manager } = await activated({ clock, extra: { exp: secs(T0) + 10 * 86400 }, fetch: serving({ status: 'active' }) });
  clock.t = T0 + 9 * DAY;
  assert.equal((await manager.recheck()).ok, true);
  assert.deepEqual(await manager.getState(), { plan: 'pro', status: 'active' });
  clock.t = T0 + 10 * DAY;
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'expired', reason: 'token-expired' });
});

test('a revoked licence ends immediately even in the middle of the grace window', async () => {
  const clock = makeClock();
  let revoked = false;
  const fetch = fakeFetch(async () => (revoked ? respond({ status: 'revoked' }) : respond({ status: 'active' })));
  const { manager } = await activated({ clock, fetch });
  clock.t = T0 + 14 * DAY;
  assert.equal((await manager.recheck()).ok, true);
  revoked = true;
  clock.t = T0 + 21 * DAY;
  assert.equal((await manager.recheck()).revoked, true);
  assert.deepEqual(await manager.getState(), { plan: 'free', status: 'none' });
});
