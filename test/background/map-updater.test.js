import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FETCH_TIMEOUT_MS, MAP_MAX_BYTES, NetError, checkMapShape, fetchTextCapped, parseMapVersion,
  refreshSelectorMap, resolveApiUrl,
} from '../../src/background/map-updater.js';
import { signEnvelope, toPublicJwk, verifyEnvelope } from '../../src/shared/signing.js';
import { STORAGE_KEYS } from '../../src/shared/constants.js';

const KID = 'selector-map-test-1';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const API = 'https://api.example.test';
const BUNDLED = '2026.10.07.1';
const MAP_KEY = STORAGE_KEYS.selectorMap;
const SOURCE = JSON.parse(readFileSync(new URL('../../src/data/selector-map.source.json', import.meta.url), 'utf8'));

async function makeKeyPair(kid) {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey);
  const priv = { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { priv, pub: toPublicJwk(priv) };
}
const SERVER = await makeKeyPair(KID);
const ATTACKER = await makeKeyPair(KID);          // same kid on purpose: only the key material may tell them apart

/** The real selector map with a new version, optionally edited. */
function mapAt(version, edit) {
  const map = structuredClone(SOURCE);
  map.mapVersion = version;
  map.issuedAt = '2026-10-08T00:00:00Z';
  if (edit) edit(map);
  return map;
}
const sign = (map, key = SERVER.priv, kid = KID) => signEnvelope(typeof map === 'string' ? map : JSON.stringify(map), key, kid);
const respond = (body, init) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, ...init });
const never = () => new Promise(() => {});

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
const serving = (envelopeOrBody) => fakeFetch(async () => respond(envelopeOrBody));

const run = (overrides = {}) => refreshSelectorMap({
  apiBase: API, now: () => NOW, publicKey: SERVER.pub, bundledVersion: BUNDLED, ...overrides,
});

// ---- no network without an apiBase -------------------------------------------------------------------------------------

test('without an apiBase the refresh is a no-op: no fetch, no storage access', async () => {
  for (const apiBase of ['', '   ', undefined, null, false]) {
    const fetch = fakeFetch(async () => { throw new Error('must not be called'); });
    const store = memoryStore();
    store.get = async () => { throw new Error('must not be read'); };
    assert.deepEqual(await run({ apiBase, fetch, store }), { skipped: true }, `apiBase ${JSON.stringify(apiBase)}`);
    assert.equal(fetch.calls.length, 0);
    assert.deepEqual(store.log, []);
  }
});

test('an unusable apiBase is refused before any request (https only, no credentials, no query)', async () => {
  for (const apiBase of [
    'http://api.example.test', 'ftp://api.example.test', 'api.example.test', 'https://user:pw@api.example.test',
    'https://api.example.test/?key=1', 'https://api.example.test/#x', 'javascript:alert(1)', 42, {},
  ]) {
    const fetch = serving({});
    assert.deepEqual(await run({ apiBase, fetch, store: memoryStore() }), { ok: false, reason: 'bad-api-base' }, String(apiBase));
    assert.equal(fetch.calls.length, 0);
  }
});

test('resolveApiUrl joins paths, tolerates trailing slashes and allows plain http only on localhost', () => {
  assert.equal(resolveApiUrl('https://api.example.test', 'selector-map.json'), 'https://api.example.test/selector-map.json');
  assert.equal(resolveApiUrl('https://api.example.test///', 'selector-map.json'), 'https://api.example.test/selector-map.json');
  assert.equal(resolveApiUrl('  https://api.example.test/v1/  ', 'licence/refresh'), 'https://api.example.test/v1/licence/refresh');
  assert.equal(resolveApiUrl('http://localhost:8787', 'selector-map.json'), 'http://localhost:8787/selector-map.json');
  assert.equal(resolveApiUrl('http://127.0.0.1:8787/api', 'x'), 'http://127.0.0.1:8787/api/x');
  assert.equal(resolveApiUrl('http://[::1]:8787', 'x'), 'http://[::1]:8787/x');
  assert.equal(resolveApiUrl('http://dev.localhost', 'x'), 'http://dev.localhost/x');
  assert.equal(resolveApiUrl('http://localhost.evil.test', 'x'), null);
  assert.equal(resolveApiUrl('', 'x'), null);
  assert.equal(resolveApiUrl(undefined, 'x'), null);
});

test('without a public key nothing is requested (it could not be verified anyway)', async () => {
  const fetch = serving(await sign(mapAt('2026.10.08.1')));
  for (const publicKey of [undefined, null, 'jwk', []]) {
    assert.deepEqual(await run({ fetch, store: memoryStore(), publicKey }), { ok: false, reason: 'no-key' });
  }
  assert.equal(fetch.calls.length, 0);
});

// ---- accepting a good map ----------------------------------------------------------------------------------------------

test('a correctly signed newer map is verified, stored, and reported', async () => {
  const envelope = await sign(mapAt('2026.10.08.1'));
  const fetch = serving({ ...envelope, extra: 'dropped', nested: { x: 1 } });
  const store = memoryStore();
  const result = await run({ fetch, store });
  assert.deepEqual(result, { ok: true, updated: true, mapVersion: '2026.10.08.1', checkedAt: NOW });
  assert.deepEqual(store.log, [['set', MAP_KEY]]);
  const stored = store.data.get(MAP_KEY);
  assert.deepEqual(stored, envelope, 'exactly payload, sig, kid; nothing else the server sent');
  assert.equal((await verifyEnvelope(stored, SERVER.pub)).ok, true, 'what is stored verifies on its own');
});

test('the request is a plain GET: fixed URL, no body, no headers, no cookies, no referrer, no query', async () => {
  const fetch = serving(await sign(mapAt('2026.10.08.1')));
  await run({ fetch, store: memoryStore() });
  assert.equal(fetch.calls.length, 1);
  const { url, init } = fetch.calls[0];
  assert.equal(url, `${API}/selector-map.json`);
  assert.equal(new URL(url).search, '');
  assert.deepEqual(Object.keys(init).sort(), ['cache', 'credentials', 'method', 'referrerPolicy', 'signal']);
  assert.equal(init.method, 'GET');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.referrerPolicy, 'no-referrer');
  assert.equal(init.cache, 'no-store');
  assert.ok(init.signal instanceof AbortSignal);
});

test('newer / equal / older against the bundled and the stored map (numeric, not string, comparison)', async () => {
  const cases = [
    // bundled, stored, fetched, expected
    ['2026.10.07.1', null, '2026.10.07.2', 'updated'],
    ['2026.10.07.1', null, '2026.10.07.1', 'up-to-date'],
    ['2026.10.07.1', null, '2026.10.06.9', 'downgrade'],
    ['2026.10.07.1', '2026.10.09.1', '2026.10.08.1', 'downgrade'],
    ['2026.10.07.1', '2026.10.09.1', '2026.10.09.1', 'up-to-date'],
    ['2026.10.07.1', '2026.10.09.1', '2026.10.09.2', 'updated'],
    ['2026.10.09.1', '2026.10.07.1', '2026.10.08.1', 'downgrade'],     // the bundled map is newer than the stored one
    ['2026.10.07.9', null, '2026.10.07.10', 'updated'],
    ['2026.10.07.10', null, '2026.10.07.9', 'downgrade'],
    ['2026.10.07', null, '2026.10.07.0', 'up-to-date'],                // a missing segment counts as 0
    [undefined, null, '2026.10.07.1', 'updated'],                      // nothing to compare with
  ];
  for (const [bundled, stored, fetched, expected] of cases) {
    const store = memoryStore(stored ? { [MAP_KEY]: await sign(mapAt(stored)) } : {});
    const before = structuredClone(store.data.get(MAP_KEY));
    const result = await run({ fetch: serving(await sign(mapAt(fetched))), store, bundledVersion: bundled });
    const label = `bundled ${bundled}, stored ${stored}, fetched ${fetched}`;
    if (expected === 'updated') {
      assert.deepEqual(result, { ok: true, updated: true, mapVersion: fetched, checkedAt: NOW }, label);
      assert.equal(parseMapVersion(store.data.get(MAP_KEY)), fetched, label);
    } else if (expected === 'up-to-date') {
      assert.deepEqual(result, { ok: true, updated: false, reason: 'up-to-date', mapVersion: fetched, checkedAt: NOW }, label);
      assert.deepEqual(store.data.get(MAP_KEY), before, label);
    } else {
      assert.deepEqual(result, { ok: false, reason: 'downgrade' }, label);
      assert.deepEqual(store.data.get(MAP_KEY), before, label);
    }
    if (expected !== 'updated') assert.deepEqual(store.log, [], `${label}: no write`);
  }
});

test('a corrupted or planted stored map with a huge version cannot block updates', async () => {
  const planted = { ...(await sign(mapAt('2026.10.09.1'))), payload: JSON.stringify(mapAt('9999.1.1')) };   // payload swapped after signing
  const garbage = { payload: '{"mapVersion":"9999.9.9"', sig: 'x', kid: KID };
  const foreign = await sign(mapAt('9999.1.1'), ATTACKER.priv);
  for (const stored of [planted, garbage, foreign, 'a string', 42, [], { payload: 5 }]) {
    const store = memoryStore({ [MAP_KEY]: stored });
    const result = await run({ fetch: serving(await sign(mapAt('2026.10.08.1'))), store });
    assert.equal(result.updated, true, JSON.stringify(stored).slice(0, 60));
    assert.equal(parseMapVersion(store.data.get(MAP_KEY)), '2026.10.08.1');
  }
});

test('an unreadable store is treated as "nothing stored", and a failing write is reported, never thrown', async () => {
  const broken = memoryStore();
  broken.get = async () => { throw new Error('storage unavailable'); };
  assert.equal((await run({ fetch: serving(await sign(mapAt('2026.10.08.1'))), store: broken })).updated, true);

  const full = memoryStore();
  full.set = async () => { throw new Error('QUOTA_BYTES quota exceeded'); };
  assert.deepEqual(await run({ fetch: serving(await sign(mapAt('2026.10.08.1'))), store: full }), { ok: false, reason: 'storage-error' });
});

// ---- rejecting bad maps ------------------------------------------------------------------------------------------------

test('a tampered payload, a tampered signature, a foreign key and a wrong kid are all rejected and nothing is stored', async () => {
  const good = await sign(mapAt('2026.10.08.1'));
  const flip = (s) => `${s.slice(0, 10)}${s[10] === 'A' ? 'B' : 'A'}${s.slice(11)}`;
  const bad = {
    'payload edited after signing': { ...good, payload: good.payload.replace('2026.10.08.1', '2026.10.09.1') },
    'payload gained a byte': { ...good, payload: `${good.payload} ` },
    'signature edited': { ...good, sig: flip(good.sig) },
    'signature from another payload': { ...good, sig: (await sign(mapAt('2026.10.08.2'))).sig },
    'signed by a different key (same kid)': await sign(mapAt('2026.10.08.1'), ATTACKER.priv),
    'wrong kid': await sign(mapAt('2026.10.08.1'), SERVER.priv, 'someone-else'),
    'truncated signature': { ...good, sig: good.sig.slice(0, 40) },
    'non-base64 signature': { ...good, sig: '!!!!' },
  };
  for (const [label, envelope] of Object.entries(bad)) {
    const store = memoryStore();
    const result = await run({ fetch: serving(envelope), store });
    assert.equal(result.ok, false, label);
    assert.match(result.reason, /signature|kid|payload/, label);
    assert.deepEqual(store.log, [], label);
  }
});

test('unsigned and malformed envelopes are rejected before any verification', async () => {
  const good = await sign(mapAt('2026.10.08.1'));
  const cases = [
    ['no sig', { payload: good.payload, kid: KID }, 'unsigned'],
    ['empty sig', { ...good, sig: '' }, 'unsigned'],
    ['sig not a string', { ...good, sig: 5 }, 'unsigned'],
    ['no payload', { sig: good.sig, kid: KID }, 'bad-envelope'],
    ['payload is an object', { ...good, payload: JSON.parse(good.payload) }, 'bad-envelope'],
    ['bare map, no envelope', mapAt('2026.10.08.1'), 'bad-envelope'],
    ['array', [good], 'bad-envelope'],
    ['null', null, 'bad-envelope'],
    ['string', JSON.stringify('hello'), 'bad-envelope'],
    ['number', 7, 'bad-envelope'],
  ];
  for (const [label, body, reason] of cases) {
    const store = memoryStore();
    const result = await run({ fetch: serving(label === 'string' ? body : JSON.stringify(body)), store });
    assert.deepEqual(result, { ok: false, reason }, label);
    assert.deepEqual(store.log, [], label);
  }
});

test('non-JSON responses are rejected (HTML error page, empty body, truncated JSON, BOM garbage)', async () => {
  const good = JSON.stringify(await sign(mapAt('2026.10.08.1')));
  for (const body of ['<!doctype html><title>502</title>', '', 'null,', good.slice(0, good.length - 5), '\u0000\u0001']) {
    const store = memoryStore();
    assert.deepEqual(await run({ fetch: serving(body), store }), { ok: false, reason: 'not-json' }, body.slice(0, 20));
    assert.deepEqual(store.log, []);
  }
});

test('a correctly signed payload that is not JSON is rejected', async () => {
  const store = memoryStore();
  assert.deepEqual(await run({ fetch: serving(await sign('this is {not json')), store }), { ok: false, reason: 'bad-payload' });
  assert.deepEqual(store.log, []);
});

test('a signed but structurally broken map is rejected, in particular one that would empty the ad guard', async () => {
  const cases = {
    'schema from the future': [(m) => { m.schema = 2; }, 'unsupported-schema'],
    'no schema': [(m) => { delete m.schema; }, 'unsupported-schema'],
    'garbage version': [(m) => { m.mapVersion = 'latest'; }, 'bad-version'],
    'numeric version': [(m) => { m.mapVersion = 20261008; }, 'bad-version'],
    'no issuedAt': [(m) => { delete m.issuedAt; }, 'bad-issued-at'],
    'unparsable issuedAt': [(m) => { m.issuedAt = 'yesterday'; }, 'bad-issued-at'],
    'roles missing': [(m) => { delete m.roles; }, 'bad-roles'],
    'roles empty': [(m) => { m.roles = {}; }, 'bad-roles'],
    'a role without selectors': [(m) => { m.roles.homeGrid = []; }, 'bad-roles'],
    'a role with a non-string selector': [(m) => { m.roles.homeGrid = [42]; }, 'bad-roles'],
    'a role that is a string': [(m) => { m.roles.homeGrid = 'ytd-rich-grid-renderer'; }, 'bad-roles'],
    'a role with a blank selector': [(m) => { m.roles.homeGrid = ['  ']; }, 'bad-roles'],
    'pageRoles missing': [(m) => { delete m.pageRoles; }, 'bad-page-roles'],
    'vars missing': [(m) => { delete m.vars; }, 'bad-vars'],
    'requires of the wrong type': [(m) => { m.requires = []; }, 'bad-requires'],
    'protected missing': [(m) => { delete m.protected; }, 'bad-protected'],
    'protected.ads missing': [(m) => { delete m.protected.ads; }, 'bad-protected'],
    'protected.ads emptied': [(m) => { m.protected.ads = []; }, 'bad-protected'],
    'protected.sponsor emptied': [(m) => { m.protected.sponsor = []; }, 'bad-protected'],
    'protected.containers of the wrong type': [(m) => { m.protected.containers = 'x'; }, 'bad-protected'],
  };
  for (const [label, [edit, reason]] of Object.entries(cases)) {
    const store = memoryStore();
    const result = await run({ fetch: serving(await sign(mapAt('2026.10.08.1', edit))), store });
    assert.deepEqual(result, { ok: false, reason }, label);
    assert.deepEqual(store.log, [], label);
  }
});

test('checkMapShape accepts the real map and nothing broken', () => {
  assert.equal(checkMapShape(SOURCE), null);
  assert.equal(checkMapShape(mapAt('2026.10.08.1')), null);
  for (const junk of [null, undefined, 'map', 5, [], () => {}]) assert.equal(checkMapShape(junk), 'not-an-object');
  assert.equal(checkMapShape(mapAt('1', (m) => { m.roles = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`r${i}`, ['a']])); })), 'bad-roles');
  assert.equal(checkMapShape(mapAt('1', (m) => { m.roles.x = Array.from({ length: 65 }, (_, i) => `.a${i}`); })), 'bad-roles');
  assert.equal(checkMapShape(mapAt('1', (m) => { m.roles.x = ['a'.repeat(1001)]; })), 'bad-roles');
});

test("the shared deep validator has the last word: a rejected, falsy-ok, error-listing or throwing validator rejects the map", async () => {
  const fetchFor = async () => serving(await sign(mapAt('2026.10.08.1')));
  const rejecting = [
    () => ({ ok: false, errors: [{ path: 'roles', message: 'bad' }] }),
    () => false,
    () => ['an error'],
    () => ({ errors: ['an error'] }),
    () => { throw new Error('validator crashed'); },
    async () => ({ ok: false }),
  ];
  for (const validateMapShape of rejecting) {
    const store = memoryStore();
    assert.deepEqual(await run({ fetch: await fetchFor(), store, validateMapShape }), { ok: false, reason: 'invalid-map' });
    assert.deepEqual(store.log, []);
  }
  for (const validateMapShape of [() => ({ ok: true, errors: [] }), () => true, () => undefined, () => [], async () => ({ ok: true })]) {
    const store = memoryStore();
    assert.equal((await run({ fetch: await fetchFor(), store, validateMapShape })).updated, true);
  }
});

test('the real map, re-versioned, passes the real shared validator end to end', async () => {
  // No validator override: this is what ships.
  const store = memoryStore();
  const result = await run({ fetch: serving(await sign(mapAt('2026.10.08.1'))), store });
  assert.deepEqual(result, { ok: true, updated: true, mapVersion: '2026.10.08.1', checkedAt: NOW });
});

// ---- the network misbehaving ---------------------------------------------------------------------------------------------

test('HTTP errors and redirects-to-nowhere are failures that store nothing', async () => {
  for (const status of [301, 400, 401, 403, 404, 429, 500, 502, 503]) {
    const store = memoryStore();
    const fetch = fakeFetch(async () => respond(JSON.stringify(await sign(mapAt('2026.10.08.1'))), { status }));
    assert.deepEqual(await run({ fetch, store }), { ok: false, reason: `http-${status}` });
    assert.deepEqual(store.log, []);
  }
});

test('network failures never throw: rejected fetch, synchronous throw, non-Response value, null', async () => {
  const fetches = [
    fakeFetch(() => Promise.reject(new TypeError('Failed to fetch'))),
    fakeFetch(() => { throw new Error('boom'); }),
    fakeFetch(() => ({ not: 'a response' })),
    fakeFetch(() => null),
    fakeFetch(() => undefined),
    () => { throw new Error('thrown before a promise exists'); },          // a plain function, not an async wrapper
  ];
  for (const fetch of fetches) {
    const store = memoryStore();
    assert.deepEqual(await run({ fetch, store }), { ok: false, reason: 'network' });
    assert.deepEqual(store.log, []);
  }
});

test('a verifier that throws is contained as a failed refresh', async () => {
  const result = await run({
    fetch: serving(await sign(mapAt('2026.10.08.1'))), store: memoryStore(),
    verifyEnvelope: async () => { throw new Error('crypto exploded'); },
  });
  assert.deepEqual(result, { ok: false, reason: 'error' });
});

test('a server that never answers is cut off by the timeout, even if it ignores the abort signal', async () => {
  const started = Date.now();
  const fetch = fakeFetch(never);
  const result = await run({ fetch, store: memoryStore(), timeoutMs: 40 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
  assert.ok(Date.now() - started < 2000);
  assert.equal(fetch.calls[0].init.signal.aborted, true, 'the request is also aborted');
});

test('a server that sends headers and then stalls on the body also times out', async () => {
  const stalled = () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('{"payload":"')); },
  }), { status: 200 });
  const store = memoryStore();
  assert.deepEqual(await run({ fetch: fakeFetch(async () => stalled()), store, timeoutMs: 40 }), { ok: false, reason: 'timeout' });
  assert.deepEqual(store.log, []);
});

test('the default deadline is 10 s', async (t) => {
  assert.equal(FETCH_TIMEOUT_MS, 10000);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let settled = false;
  const pending = run({ fetch: fakeFetch(never), store: memoryStore() }).then((r) => { settled = true; return r; });
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(FETCH_TIMEOUT_MS - 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false, 'still waiting at 9.999 s');
  t.mock.timers.tick(1);
  assert.deepEqual(await pending, { ok: false, reason: 'timeout' });
});

test('oversized responses are refused: streamed body, declared Content-Length, and a body that lies about its length', async () => {
  const store = memoryStore();
  const huge = 'x'.repeat(MAP_MAX_BYTES + 1);
  assert.deepEqual(await run({ fetch: fakeFetch(async () => respond(huge)), store }), { ok: false, reason: 'too-large' });
  assert.deepEqual(
    await run({ fetch: fakeFetch(async () => respond('{}', { headers: { 'content-length': String(MAP_MAX_BYTES + 1) } })), store }),
    { ok: false, reason: 'too-large' },
  );
  assert.deepEqual(
    await run({ fetch: fakeFetch(async () => respond(huge, { headers: { 'content-length': '10' } })), store }),
    { ok: false, reason: 'too-large' },
  );
  assert.deepEqual(await run({ fetch: fakeFetch(async () => respond('x'.repeat(200))), store, maxBytes: 100 }), { ok: false, reason: 'too-large' });
  assert.deepEqual(store.log, []);
});

test('the size cap counts bytes, not characters, and a plain text() response is capped too', async () => {
  const multibyte = '€'.repeat(40);                                        // 120 bytes, 40 characters
  const store = memoryStore();
  assert.equal((await run({ fetch: fakeFetch(async () => respond(multibyte)), store, maxBytes: 100 })).reason, 'too-large');
  const noBody = { ok: true, status: 200, headers: { get: () => null }, text: async () => multibyte };
  assert.equal((await run({ fetch: fakeFetch(async () => noBody), store, maxBytes: 100 })).reason, 'too-large');
  const small = { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(await sign(mapAt('2026.10.08.1'))) };
  assert.equal((await run({ fetch: fakeFetch(async () => small), store })).updated, true);
});

test('a map just under the cap is fine', async () => {
  const padded = mapAt('2026.10.08.1', (m) => { m._padding = 'x'.repeat(200 * 1024); });
  const body = JSON.stringify(await sign(padded));
  assert.ok(body.length > 200 * 1024 && body.length < MAP_MAX_BYTES, `test body is ${body.length} bytes`);
  const result = await run({ fetch: serving(body), store: memoryStore(), validateMapShape: () => ({ ok: true }) });
  assert.equal(result.updated, true);
});

// ---- helpers ---------------------------------------------------------------------------------------------------------------

test('fetchTextCapped resolves any HTTP status instead of throwing, and reports typed failures', async () => {
  const seen = await fetchTextCapped(async () => respond('nope', { status: 418 }), 'https://x.test/', {});
  assert.deepEqual(seen, { ok: false, status: 418, text: 'nope' });
  await assert.rejects(fetchTextCapped(async () => { throw new TypeError('offline'); }, 'https://x.test/', {}),
    (err) => err instanceof NetError && err.reason === 'network');
  await assert.rejects(fetchTextCapped(never, 'https://x.test/', {}, { timeoutMs: 20 }),
    (err) => err instanceof NetError && err.reason === 'timeout');
  await assert.rejects(fetchTextCapped(async () => respond('x'.repeat(50)), 'https://x.test/', {}, { maxBytes: 10 }),
    (err) => err instanceof NetError && err.reason === 'too-large');
});

test('fetchTextCapped leaves no unhandled rejection behind when the request fails after the deadline', async () => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  try {
    await assert.rejects(fetchTextCapped(
      () => new Promise((_, reject) => setTimeout(() => reject(new Error('late failure')), 60)),
      'https://x.test/', {}, { timeoutMs: 10 },
    ), (err) => err.reason === 'timeout');
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off('unhandledRejection', onUnhandled);
  }
});

test('parseMapVersion reads the version without trusting the envelope, and returns null for anything odd', async () => {
  assert.equal(parseMapVersion(await sign(mapAt('2026.10.08.1'))), '2026.10.08.1');
  for (const junk of [null, undefined, 'x', 5, [], {}, { payload: 5 }, { payload: 'not json' }, { payload: '[]' },
    { payload: '{}' }, { payload: '{"mapVersion":7}' }, { payload: '{"mapVersion":"v1"}' }, { payload: '{"mapVersion":"1.2.3.4.5.6.7.8.9"}' }]) {
    assert.equal(parseMapVersion(junk), null, JSON.stringify(junk));
  }
});
