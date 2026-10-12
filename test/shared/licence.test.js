// src/shared/licence.js: token verification (signature, claim shape, time rules) and the none/active/grace/expired
// state machine with exact boundaries. Tokens are minted with throw-away keys; nothing here touches .keys/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOCK_SKEW_MS, LAPSE_REASONS, PLANS, claimsMatch, lapseReason, licenceState, parseClaims, signLicenceToken, verifiedLicenceState,
  verifyLicenceToken,
} from '../../src/shared/licence.js';
import { LIMITS } from '../../src/shared/constants.js';
import { base64urlDecode, base64urlEncode, signPayload, toPublicJwk } from '../../src/shared/signing.js';

const DAY = 864e5;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);       // a whole second, so second-based claims hit the boundaries exactly
const sec = (ms) => Math.floor(ms / 1000);

async function newKeyPair(kid) {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const jwk = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateJwk = { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d, kid };
  return { privateJwk, publicJwk: toPublicJwk(privateJwk) };
}

const LICENCE = await newKeyPair('licence-1');
const OTHER = await newKeyPair('licence-1');

const claimsOf = (over = {}) => ({
  v: 1, sub: 'buyer@example.com', plan: 'pro', iat: sec(NOW) - 3600, exp: sec(NOW) + 30 * 86400, devices: 3, ...over,
});
const mint = (over, key = LICENCE) => signLicenceToken(claimsOf(over), key.privateJwk);
/** Token whose claim segment is exactly `bytes` (to build claims JSON that JSON.stringify cannot produce). */
const mintRaw = async (bytes, key = LICENCE) => `${base64urlEncode(bytes)}.${await signPayload(bytes, key.privateJwk)}`;
const verify = (token, now = NOW, key = LICENCE) => verifyLicenceToken(token, now, key.publicJwk);

function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function assertInvalid(token, reason, { now = NOW, key = LICENCE, label = '' } = {}) {
  let result;
  await assert.doesNotReject(async () => { result = await verify(token, now, key); }, `${label} must not throw`);
  assert.equal(result.valid, false, `${label} must be invalid`);
  assert.equal(result.reason, reason, label);
  return result;
}

// ---- verifyLicenceToken: accepted --------------------------------------------------------------------------------

test('a valid pro token verifies and yields exactly the known claims', async () => {
  const token = await mint();
  assert.match(token, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/);
  assert.deepEqual(await verify(token), { valid: true, reason: 'ok', claims: claimsOf() });
});

test('free tokens, lifetime tokens (no exp) and no-devices tokens are valid', async () => {
  assert.equal((await verify(await mint({ plan: 'free' }))).claims.plan, 'free');
  const lifetime = await verify(await mint({ exp: undefined }), Date.UTC(3000, 0, 1));
  assert.equal(lifetime.valid, true);
  assert.ok(!('exp' in lifetime.claims));
  const noDevices = await verify(await mint({ devices: undefined }));
  assert.equal(noDevices.valid, true);
  assert.ok(!('devices' in noDevices.claims));
});

test('unknown claims are dropped and cannot pollute prototypes', async () => {
  const bytes = new TextEncoder().encode('{"v":1,"sub":"a@b.c","plan":"free","iat":1,"admin":true,"__proto__":{"plan":"pro","polluted":1},"constructor":{"x":1}}');
  const result = await verify(await mintRaw(bytes));
  assert.equal(result.valid, true);
  assert.deepEqual(result.claims, { v: 1, sub: 'a@b.c', plan: 'free', iat: 1 });
  assert.equal(({}).polluted, undefined);
  assert.equal(Object.getPrototypeOf(result.claims), Object.prototype);
});

test('surrounding whitespace from a paste is tolerated, inner whitespace is not', async () => {
  const token = await mint();
  assert.equal((await verify(`  ${token}\n`)).valid, true);
  assert.equal((await verify(`\t${token}\r\n`)).valid, true);
  const [claims, sig] = token.split('.');
  await assertInvalid(`${claims.slice(0, 5)} ${claims.slice(5)}.${sig}`, 'malformed-token', { label: 'space inside claims' });
  await assertInvalid(`${claims}\n.${sig}`, 'malformed-token', { label: 'newline before the dot' });
});

// ---- verifyLicenceToken: structure --------------------------------------------------------------------------------

test('non-strings and structurally broken tokens are malformed', async () => {
  const good = await mint();
  const [claims, sig] = good.split('.');
  const bad = {
    undefined: undefined, null: null, number: 12345, object: {}, array: [good], boolean: true,
    empty: '', blank: '   ', 'one part': claims, 'no sig': `${claims}.`, 'no claims': `.${sig}`, 'only dot': '.',
    'three parts (JWT shaped)': `${claims}.${claims}.${sig}`, 'four parts': `a.b.c.d`,
    'bad base64 in claims': `${claims}!.${sig}`, 'bad base64 in sig': `${claims}.${sig}!`,
    'padded claims': `${claims}==.${sig}`, 'standard alphabet': `${claims}+/.${sig}`,
    'impossible length claims': `${'A'.repeat(5)}.${sig}`, 'impossible length sig': `${claims}.${'A'.repeat(85)}`,
    'alg none style': `${claims}.`, 'huge': `${'A'.repeat(5000)}.${sig}`,
  };
  for (const [label, token] of Object.entries(bad)) {
    await assertInvalid(token, 'malformed-token', { label });
  }
});

// ---- verifyLicenceToken: signature -------------------------------------------------------------------------------

test('edited claims with the old signature are rejected (plan upgrade, longer expiry, other owner)', async () => {
  const [claims, sig] = (await mint({ plan: 'free', exp: sec(NOW) + 86400 })).split('.');
  const parsed = JSON.parse(new TextDecoder().decode(base64urlDecode(claims)));
  const edits = [{ ...parsed, plan: 'pro' }, { ...parsed, exp: parsed.exp + 10 * 365 * 86400 }, { ...parsed, sub: 'thief@example.com' }, { ...parsed, devices: 999 }];
  for (const edit of edits) {
    await assertInvalid(`${base64urlEncode(JSON.stringify(edit))}.${sig}`, 'bad-signature', { label: JSON.stringify(edit) });
  }
  const { exp, ...noExp } = parsed;
  await assertInvalid(`${base64urlEncode(JSON.stringify(noExp))}.${sig}`, 'bad-signature', { label: 'exp removed (lifetime upgrade)' });
});

test('every flipped bit of the signature segment and of the claims bytes is rejected', async () => {
  const [claims, sig] = (await mint()).split('.');
  const sigBytes = base64urlDecode(sig);
  for (let bit = 0; bit < sigBytes.length * 8; bit += 5) {
    const flipped = sigBytes.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    await assertInvalid(`${claims}.${base64urlEncode(flipped)}`, 'bad-signature', { label: `sig bit ${bit}` });
  }
  const claimBytes = base64urlDecode(claims);
  for (let bit = 0; bit < claimBytes.length * 8; bit += 7) {
    const flipped = claimBytes.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    await assertInvalid(`${base64urlEncode(flipped)}.${sig}`, 'bad-signature', { label: `claims bit ${bit}` });
  }
});

test('truncated, extended and zero signatures are rejected', async () => {
  const [claims, sig] = (await mint()).split('.');
  const raw = base64urlDecode(sig);
  const wrongLength = {
    'half (32 bytes)': base64urlEncode(raw.subarray(0, 32)), '63 bytes': base64urlEncode(raw.subarray(0, 63)),
    '65 bytes': base64urlEncode(Uint8Array.from([...raw, 1])), 'zeros': base64urlEncode(new Uint8Array(64)),
  };
  for (const [label, bad] of Object.entries(wrongLength)) {
    await assertInvalid(`${claims}.${bad}`, 'bad-signature', { label });
  }
  const notBase64url = {
    'short by a char (85 chars cannot be base64url)': sig.slice(0, -1),
    'non-canonical last char (padding bits set)': sig.slice(0, -1) + ALPHABET[(ALPHABET.indexOf(sig.at(-1)) & ~3) | 1],
  };
  for (const [label, bad] of Object.entries(notBase64url)) {
    await assertInvalid(`${claims}.${bad}`, 'malformed-token', { label });
  }
});

test('a token from another key, or signed for another purpose, is rejected', async () => {
  await assertInvalid(await mint({}, OTHER), 'bad-signature', { label: 'other key' });
  const selectorMapKey = await newKeyPair('selector-map-1');
  await assertInvalid(await mint({}, selectorMapKey), 'bad-signature', { label: 'selector-map key' });
});

test('the signature covers the claim bytes, not their base64url text (JWT-style signing is not accepted)', async () => {
  const claims = base64urlEncode(JSON.stringify(claimsOf()));
  const jwtStyle = `${claims}.${await signPayload(claims, LICENCE.privateJwk)}`;
  await assertInvalid(jwtStyle, 'bad-signature');
});

test('bad public keys are reported as bad-key', async () => {
  const token = await mint();
  for (const jwk of [null, undefined, {}, 'key', { ...LICENCE.publicJwk, crv: 'P-384' }, LICENCE.privateJwk]) {
    const result = await verifyLicenceToken(token, NOW, jwk);
    assert.deepEqual(result, { valid: false, reason: 'bad-key', claims: null });
  }
});

// ---- verifyLicenceToken: claims -----------------------------------------------------------------------------------

test('validly signed but malformed claims are rejected with a specific reason', async () => {
  const cases = [
    ['version 2', { v: 2 }, 'unsupported-version'],
    ['version 0', { v: 0 }, 'unsupported-version'],
    ['version "1" (string)', { v: '1' }, 'bad-claims'],
    ['version missing', { v: undefined }, 'bad-claims'],
    ['version null', { v: null }, 'bad-claims'],
    ['plan enterprise', { plan: 'enterprise' }, 'bad-plan'],
    ['plan PRO (case)', { plan: 'PRO' }, 'bad-plan'],
    ['plan missing', { plan: undefined }, 'bad-plan'],
    ['plan number', { plan: 1 }, 'bad-plan'],
    ['plan array', { plan: ['pro'] }, 'bad-plan'],
    ['sub missing', { sub: undefined }, 'bad-claims'],
    ['sub empty', { sub: '' }, 'bad-claims'],
    ['sub number', { sub: 7 }, 'bad-claims'],
    ['sub too long', { sub: 'a'.repeat(321) }, 'bad-claims'],
    ['iat missing', { iat: undefined }, 'bad-claims'],
    ['iat string', { iat: '1790000000' }, 'bad-claims'],
    ['iat null (NaN in JSON)', { iat: null }, 'bad-claims'],
    ['iat negative', { iat: -1 }, 'bad-claims'],
    ['iat in milliseconds', { iat: NOW }, 'bad-claims'],
    ['exp string', { exp: String(sec(NOW) + 1000) }, 'bad-claims'],
    ['exp null', { exp: null }, 'bad-claims'],
    ['exp negative', { exp: -5 }, 'bad-claims'],
    ['exp in milliseconds (would never expire)', { exp: NOW + 30 * DAY }, 'bad-claims'],
    ['devices zero', { devices: 0 }, 'bad-claims'],
    ['devices negative', { devices: -1 }, 'bad-claims'],
    ['devices fractional', { devices: 1.5 }, 'bad-claims'],
    ['devices string', { devices: '3' }, 'bad-claims'],
    ['devices huge', { devices: 1e9 }, 'bad-claims'],
  ];
  for (const [label, over, reason] of cases) {
    await assertInvalid(await mint(over), reason, { label });
  }
});

test('claims that are not a JSON object, not JSON, or not UTF-8 are rejected', async () => {
  const enc = (text) => new TextEncoder().encode(text);
  const cases = {
    'array': enc('[1,2,3]'), 'string': enc('"pro"'), 'null': enc('null'), 'number': enc('7'), 'true': enc('true'),
    'not json': enc('{v:1}'), 'truncated json': enc('{"v":1,"sub":"a","plan":"pro","iat":1'),
    'trailing garbage': enc('{"v":1,"sub":"a","plan":"pro","iat":1}x'),
    'invalid utf-8': Uint8Array.of(0x7b, 0xff, 0xfe, 0x7d), 'bom prefix': Uint8Array.from([0xef, 0xbb, 0xbf, ...enc('{"v":1,"sub":"a","plan":"pro","iat":1}')]),
  };
  for (const [label, bytes] of Object.entries(cases)) {
    await assertInvalid(await mintRaw(bytes), 'bad-claims', { label });
  }
});

// ---- verifyLicenceToken: time rules --------------------------------------------------------------------------------

test('iat may be at most 5 minutes ahead of now (inclusive), not one millisecond more', async () => {
  assert.equal(CLOCK_SKEW_MS, 5 * 60 * 1000);
  const iat = sec(NOW) + 10_000;
  const token = await mint({ iat, exp: undefined });
  assert.equal((await verify(token, iat * 1000 - CLOCK_SKEW_MS)).valid, true, 'exactly 5 min ahead');
  const late = await assertInvalid(token, 'not-yet-valid', { now: iat * 1000 - CLOCK_SKEW_MS - 1, label: '5 min + 1 ms ahead' });
  assert.equal(late.claims.iat, iat, 'claims are still reported for diagnostics');
  assert.equal((await verify(token, iat * 1000)).valid, true, 'iat == now');
  assert.equal((await verify(token, iat * 1000 + 40 * DAY)).valid, true, 'old iat is fine');
  await assertInvalid(await mint({ iat: sec(NOW) + 3600, exp: undefined }), 'not-yet-valid', { label: 'an hour ahead' });
});

test('exp: valid until the instant exp is reached, expired from then on (claims still reported)', async () => {
  const exp = sec(NOW) + 100;
  const token = await mint({ exp });
  assert.equal((await verify(token, exp * 1000 - 1)).valid, true, '1 ms before exp');
  const atExp = await assertInvalid(token, 'expired', { now: exp * 1000, label: 'at exp' });
  assert.equal(atExp.claims.exp, exp);
  await assertInvalid(token, 'expired', { now: exp * 1000 + 1, label: '1 ms after exp' });
  await assertInvalid(token, 'expired', { now: exp * 1000 + 400 * DAY, label: 'long after exp' });
});

test('an expired token with a bad signature is a bad signature, not an expiry', async () => {
  const [claims, sig] = (await mint({ exp: sec(NOW) - 100 })).split('.');
  const flipped = base64urlDecode(sig);
  flipped[0] ^= 1;
  const result = await verify(`${claims}.${base64urlEncode(flipped)}`);
  assert.deepEqual(result, { valid: false, reason: 'bad-signature', claims: null });
});

test('a nowMs that is not a finite number is rejected, not guessed', async () => {
  const token = await mint();
  for (const now of [undefined, null, NaN, Infinity, -Infinity, '1790000000000', {}]) {
    assert.deepEqual(await verifyLicenceToken(token, now, LICENCE.publicJwk), { valid: false, reason: 'bad-time', claims: null }, String(now));
  }
});

test('fuzz: 300 garbage tokens never throw and are never valid', async () => {
  const next = prng(99);
  const good = await mint();
  const [claims, sig] = good.split('.');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.=+/ \n';
  const randomText = (n) => Array.from({ length: n }, () => alphabet[Math.floor(next() * alphabet.length)]).join('');
  for (let i = 0; i < 300; i++) {
    const pieces = [claims.slice(0, Math.floor(next() * claims.length)), sig.slice(0, Math.floor(next() * sig.length)), randomText(Math.floor(next() * 40))];
    const token = [pieces[Math.floor(next() * 3)], pieces[Math.floor(next() * 3)]].join(next() < 0.8 ? '.' : '..');
    const result = await verify(token);
    assert.equal(result.valid, false, `case ${i}: ${token.slice(0, 60)}`);
    assert.equal(result.claims, null);
    assert.equal(typeof result.reason, 'string');
  }
});

// ---- parseClaims ------------------------------------------------------------------------------------------------

test('parseClaims copies only known fields and rejects non-objects', () => {
  assert.deepEqual(parseClaims({ ...claimsOf(), extra: 1 }), { ok: true, claims: claimsOf() });
  const input = claimsOf();
  assert.notEqual(parseClaims(input).claims, input, 'a fresh object');
  for (const bad of [null, undefined, 'x', 5, [], [claimsOf()], true]) {
    assert.deepEqual(parseClaims(bad), { ok: false, reason: 'bad-claims' });
  }
  assert.deepEqual(PLANS, ['free', 'pro']);
});

// ---- licenceState ------------------------------------------------------------------------------------------------

const TOKEN = await mint();
const record = (over = {}) => ({ token: TOKEN, claims: claimsOf(), checkedAt: NOW, ...over });
const state = (rec, now = NOW) => licenceState(rec, now);
const FREE_NONE = { plan: 'free', status: 'none' };
const FREE_EXPIRED = { plan: 'free', status: 'expired' };

test('the limits this module relies on are 7 days (re-check) and 30 days (offline grace)', () => {
  assert.equal(LIMITS.licenceRecheckMs, 7 * DAY);
  assert.equal(LIMITS.offlineGraceMs, 30 * DAY);
});

test('no usable record means none/free', () => {
  for (const rec of [undefined, null, 0, 'token', [], {}, { claims: claimsOf(), checkedAt: NOW }, record({ token: '' }), record({ token: '   ' }),
    record({ token: 5 }), record({ token: null }), record({ claims: undefined }), record({ claims: null }), record({ claims: 'pro' }),
    record({ claims: claimsOf({ plan: 'gold' }) }), record({ claims: claimsOf({ v: 2 }) }), record({ claims: claimsOf({ sub: '' }) }),
    record({ claims: claimsOf({ iat: NOW }) })]) {
    assert.deepEqual(state(rec), FREE_NONE, JSON.stringify(rec));
  }
});

test('a freshly checked pro token is active/pro', () => {
  assert.deepEqual(state(record()), { plan: 'pro', status: 'active' });
  assert.deepEqual(state(record({ checkedAt: NOW - 1 })), { plan: 'pro', status: 'active' });
  assert.deepEqual(state(record({ claims: claimsOf({ exp: undefined }) })), { plan: 'pro', status: 'active' }, 'lifetime');
});

test('re-check window boundary: day 7 is still active, 7 days + 1 ms is grace', () => {
  assert.deepEqual(state(record({ checkedAt: NOW - 7 * DAY + 1 })), { plan: 'pro', status: 'active' });
  assert.deepEqual(state(record({ checkedAt: NOW - 7 * DAY })), { plan: 'pro', status: 'active' }, 'exactly day 7');
  assert.deepEqual(state(record({ checkedAt: NOW - 7 * DAY - 1 })), { plan: 'pro', status: 'grace' }, 'day 7 + 1 ms');
});

test('offline grace boundary: day 30 is still grace, 30 days + 1 ms is expired/free', () => {
  assert.deepEqual(state(record({ checkedAt: NOW - 20 * DAY })), { plan: 'pro', status: 'grace' });
  assert.deepEqual(state(record({ checkedAt: NOW - 30 * DAY + 1 })), { plan: 'pro', status: 'grace' });
  assert.deepEqual(state(record({ checkedAt: NOW - 30 * DAY })), { plan: 'pro', status: 'grace' }, 'exactly day 30');
  assert.deepEqual(state(record({ checkedAt: NOW - 30 * DAY - 1 })), FREE_EXPIRED, 'day 30 + 1 ms');
  assert.deepEqual(state(record({ checkedAt: NOW - 400 * DAY })), FREE_EXPIRED);
});

test('claims.exp ends the licence at the exact instant, in every window', () => {
  const exp = sec(NOW);
  for (const checkedAt of [NOW, NOW - 8 * DAY, NOW - 29 * DAY]) {
    assert.deepEqual(state(record({ claims: claimsOf({ exp }), checkedAt })), FREE_EXPIRED, `exp == now, checked ${(NOW - checkedAt) / DAY}d ago`);
    assert.notDeepEqual(state(record({ claims: claimsOf({ exp: exp + 1 }), checkedAt })), FREE_EXPIRED, 'one second left');
  }
  assert.deepEqual(state(record({ claims: claimsOf({ exp: exp - 86400 }) })), FREE_EXPIRED, 'a day ago');
  assert.deepEqual(state(record({ claims: claimsOf({ exp }) }), NOW - 1), { plan: 'pro', status: 'active' }, '1 ms before exp');
});

test('a free-plan licence stays free whatever its status', () => {
  const claims = claimsOf({ plan: 'free' });
  assert.deepEqual(state(record({ claims })), { plan: 'free', status: 'active' });
  assert.deepEqual(state(record({ claims, checkedAt: NOW - 10 * DAY })), { plan: 'free', status: 'grace' });
  assert.deepEqual(state(record({ claims, checkedAt: NOW - 31 * DAY })), FREE_EXPIRED);
});

test('unusable or untrustworthy checkedAt fails closed to expired/free', () => {
  for (const checkedAt of [undefined, null, NaN, Infinity, -Infinity, '1790000000000', {}, -1, NOW + CLOCK_SKEW_MS + 1, NOW + 400 * DAY]) {
    assert.deepEqual(state(record({ checkedAt })), FREE_EXPIRED, String(checkedAt));
  }
  assert.deepEqual(state(record({ checkedAt: NOW + CLOCK_SKEW_MS })), { plan: 'pro', status: 'active' }, 'small clock skew is tolerated');
  assert.deepEqual(state(record({ checkedAt: NOW + 1000 })), { plan: 'pro', status: 'active' });
  const { checkedAt, ...noChecked } = record();
  assert.deepEqual(state(noChecked), FREE_EXPIRED);
});

test('a nowMs that is not a finite number fails closed (but "no token" stays none)', () => {
  for (const now of [undefined, null, NaN, Infinity, '2026', {}]) {
    assert.deepEqual(licenceState(record(), now), FREE_EXPIRED, String(now));
    assert.deepEqual(licenceState({}, now), FREE_NONE, `none first: ${now}`);
  }
});

test('licenceState is pure: it does not mutate the record and returns fresh objects', () => {
  const rec = Object.freeze({ token: TOKEN, claims: Object.freeze(claimsOf()), checkedAt: NOW });
  const one = state(rec);
  const two = state(rec);
  assert.deepEqual(one, two);
  assert.notEqual(one, two);
  assert.deepEqual(Object.keys(one), ['plan', 'status']);
  one.plan = 'hacked';
  assert.deepEqual(state(rec), { plan: 'pro', status: 'active' });
  assert.notEqual(state({}), state({}), 'also for none');
});

test('property: "pro" is only ever reported while active or in grace', () => {
  const next = prng(2026);
  const pickTime = () => NOW + Math.floor((next() - 0.7) * 80 * DAY);
  for (let i = 0; i < 2000; i++) {
    const rec = {
      token: next() < 0.95 ? TOKEN : '',
      claims: claimsOf({ plan: next() < 0.8 ? 'pro' : 'free', exp: next() < 0.5 ? undefined : sec(pickTime()) }),
      checkedAt: next() < 0.95 ? pickTime() : undefined,
    };
    const now = NOW + Math.floor((next() - 0.2) * 60 * DAY);
    const result = state(rec, now);
    assert.deepEqual(Object.keys(result), ['plan', 'status']);
    assert.ok(['none', 'active', 'grace', 'expired'].includes(result.status));
    if (result.plan === 'pro') {
      assert.ok(result.status === 'active' || result.status === 'grace', JSON.stringify({ rec, now, result }));
      assert.equal(rec.claims.plan, 'pro');
      assert.ok(rec.claims.exp === undefined || now < rec.claims.exp * 1000);
      assert.ok(now - rec.checkedAt <= LIMITS.offlineGraceMs);
    } else {
      assert.equal(result.plan, 'free');
    }
    if (result.status === 'expired' || result.status === 'none') assert.equal(result.plan, 'free');
  }
});

test('end to end: a verified token stored as a record walks active -> grace -> expired as time passes', async () => {
  const token = await mint({ exp: sec(NOW) + 90 * 86400 });
  const verified = await verify(token);
  assert.equal(verified.valid, true);
  const stored = { token, claims: verified.claims, checkedAt: NOW };
  assert.equal(state(stored, NOW + 6 * DAY).status, 'active');
  assert.equal(state(stored, NOW + 8 * DAY).status, 'grace');
  assert.equal(state(stored, NOW + 29 * DAY).status, 'grace');
  assert.equal(state(stored, NOW + 31 * DAY).status, 'expired');
  const rechecked = { ...stored, checkedAt: NOW + 29 * DAY };
  assert.equal(state(rechecked, NOW + 31 * DAY).status, 'active', 'a re-check resets the window');
  assert.equal(state(rechecked, NOW + 91 * DAY).status, 'expired', 'but never past exp');
});

// ---- claims bound to the signed token: claimsMatch, lapseReason, verifiedLicenceState -----------------------------------------

test('claimsMatch: plan, subscriber, issue and expiry time must all be the signed ones', () => {
  const c = claimsOf();
  assert.equal(claimsMatch({ ...c }, { ...c }), true);
  assert.equal(claimsMatch({ ...c, devices: 9 }, c), true, 'devices is not an entitlement');
  for (const [name, edit] of Object.entries({ plan: { plan: 'free' }, sub: { sub: 'someone@else' }, iat: { iat: c.iat + 1 }, exp: { exp: c.exp + 1 } })) {
    assert.equal(claimsMatch({ ...c, ...edit }, c), false, name);
  }
  assert.equal(claimsMatch({ ...c, exp: undefined }, c), false, 'removing the expiry is an edit');
  assert.equal(claimsMatch(null, c), false);
  assert.equal(claimsMatch(c, { plan: 'pro' }), false);
});

test('lapseReason: a signed exp that passed is "token-expired"; a token with no exp can only be "not-rechecked"', () => {
  const rec = (claims, checkedAt) => ({ token: 't', claims, checkedAt });
  const lifetime = claimsOf({ exp: undefined });
  assert.deepEqual(LAPSE_REASONS, ['token-expired', 'not-rechecked', 'invalid']);
  assert.equal(lapseReason(rec(lifetime, NOW - 400 * DAY), NOW), 'not-rechecked');
  assert.equal(lapseReason(rec(claimsOf({ exp: sec(NOW) - 1 }), NOW), NOW), 'token-expired');
  assert.equal(lapseReason(null, NOW), 'not-rechecked');
});

test('verifiedLicenceState: Pro needs a verifying token AND stored claims that agree with it; the reason says why not', async () => {
  const token = await mint();
  const good = { token, claims: parseClaims(claimsOf()).claims, checkedAt: NOW - DAY };
  const state = (record, now = NOW, key = LICENCE) => verifiedLicenceState(record, now, key.publicJwk);
  assert.deepEqual(await state(good), { plan: 'pro', status: 'active' });
  assert.deepEqual(await state({ ...good, checkedAt: NOW - 10 * DAY }), { plan: 'pro', status: 'grace' });
  assert.deepEqual(await state({ ...good, checkedAt: NOW - 31 * DAY }), { plan: 'free', status: 'expired', reason: 'not-rechecked' });
  assert.deepEqual(await state(good, NOW + 31 * DAY), { plan: 'free', status: 'expired', reason: 'token-expired' }, 'past the signed exp');
  // A free token with hand-edited claims.plan = pro (the review finding): the stored copy does not match the signed one.
  const freeToken = await mint({ plan: 'free' });
  assert.deepEqual(await state({ token: freeToken, claims: parseClaims(claimsOf()).claims, checkedAt: NOW }), { plan: 'free', status: 'expired', reason: 'invalid' });
  // Same plan, edited expiry (a longer life than the token has).
  assert.deepEqual(await state({ ...good, claims: { ...good.claims, exp: good.claims.exp + 400 * 86400 } }), { plan: 'free', status: 'expired', reason: 'invalid' });
  // Signed by someone else, and garbage.
  assert.deepEqual(await state(good, NOW, OTHER), { plan: 'free', status: 'expired', reason: 'invalid' });
  assert.deepEqual(await state({ ...good, token: 'aaaa.bbbb' }), { plan: 'free', status: 'expired', reason: 'invalid' });
  // Nothing usable stays "none"; a free signed token is just free.
  assert.deepEqual(await state(null), { plan: 'free', status: 'none' });
  assert.deepEqual(await state({ token: freeToken, claims: parseClaims(claimsOf({ plan: 'free' })).claims, checkedAt: NOW }), { plan: 'free', status: 'active' });
});

test('verifiedLicenceState never throws: a verifier that throws or answers junk is "invalid"', async () => {
  const record = { token: 'x.y', claims: claimsOf(), checkedAt: NOW };
  for (const verify of [async () => { throw new Error('boom'); }, async () => null, async () => ({ valid: true }), async () => ({ valid: 'yes', claims: claimsOf() })]) {
    assert.deepEqual(await verifiedLicenceState(record, NOW, {}, { verify }), { plan: 'free', status: 'expired', reason: 'invalid' });
  }
});
