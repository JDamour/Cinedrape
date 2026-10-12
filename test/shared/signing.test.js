// src/shared/signing.js: base64url, envelope verification (must reject everything bad without throwing),
// interop with an independent ECDSA implementation (node:crypto), and map-version ordering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, createVerify, createPublicKey, generateKeyPairSync, randomBytes } from 'node:crypto';
import {
  SIGNATURE_BYTES, base64urlDecode, base64urlEncode, compareMapVersions, isWellFormed, signEnvelope, signPayload,
  toPublicJwk, verifyEnvelope, verifySignature,
} from '../../src/shared/signing.js';

async function newKeyPair(kid = 'test-1') {
  const pair = await globalThis.crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const priv = await globalThis.crypto.subtle.exportKey('jwk', pair.privateKey);
  const privateJwk = { kty: priv.kty, crv: priv.crv, x: priv.x, y: priv.y, d: priv.d, kid };
  return { privateJwk, publicJwk: toPublicJwk(privateJwk) };
}

const A = await newKeyPair('test-1');
const B = await newKeyPair('test-1');            // different key, same kid
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const PAYLOAD = JSON.stringify({ schema: 1, mapVersion: '2026.10.07.1', note: 'café ✓ 🎬' });
const ENVELOPE = await signEnvelope(PAYLOAD, A.privateJwk, 'test-1');

// Deterministic PRNG so a fuzz failure can be replayed.
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

async function assertRejects(envelope, jwk, reason, label = '') {
  let result;
  await assert.doesNotReject(async () => { result = await verifyEnvelope(envelope, jwk); }, `${label} must not throw`);
  assert.equal(result.ok, false, `${label} must be rejected`);
  assert.equal(typeof result.reason, 'string', `${label} must carry a reason`);
  assert.ok(!('payload' in result), `${label} must not hand back a payload`);
  if (reason) assert.equal(result.reason, reason, label);
  return result;
}

// ---- base64url ----------------------------------------------------------------------------------------------------

test('base64url matches RFC 4648 vectors (url alphabet, no padding)', () => {
  const vectors = { '': '', f: 'Zg', fo: 'Zm8', foo: 'Zm9v', foob: 'Zm9vYg', fooba: 'Zm9vYmE', foobar: 'Zm9vYmFy' };
  for (const [text, encoded] of Object.entries(vectors)) {
    assert.equal(base64urlEncode(text), encoded);
    assert.equal(new TextDecoder().decode(base64urlDecode(encoded)), text);
  }
  assert.equal(base64urlEncode(Uint8Array.of(0xfb, 0xff, 0xfe)), '-__-');
  assert.equal(base64urlEncode(Uint8Array.of(0xfb, 0xff)), '-_8');
});

test('base64url agrees with node:crypto for every length 0..130 and random bytes', () => {
  const next = prng(7);
  for (let len = 0; len <= 130; len++) {
    const bytes = Uint8Array.from({ length: len }, () => Math.floor(next() * 256));
    const expected = Buffer.from(bytes).toString('base64url');
    assert.equal(base64urlEncode(bytes), expected, `encode length ${len}`);
    assert.deepEqual(base64urlDecode(expected), bytes, `decode length ${len}`);
  }
});

test('base64urlEncode accepts ArrayBuffer, typed-array views with an offset, Buffer and UTF-8 strings', () => {
  const bytes = Uint8Array.of(1, 2, 3, 4, 5, 6, 7);
  const view = bytes.subarray(2, 6);                         // shares a larger buffer: byteOffset 2
  assert.equal(base64urlEncode(view), Buffer.from([3, 4, 5, 6]).toString('base64url'));
  assert.equal(base64urlEncode(bytes.buffer), Buffer.from(bytes).toString('base64url'));
  assert.equal(base64urlEncode(Buffer.from('hi')), 'aGk');
  assert.equal(base64urlEncode('é✓🎬'), Buffer.from('é✓🎬', 'utf8').toString('base64url'));
  assert.equal(base64urlEncode(new Uint16Array([0x0102])), Buffer.from([2, 1]).toString('base64url'));
});

test('base64urlEncode rejects values that are not bytes or strings', () => {
  for (const bad of [undefined, null, 1, true, {}, [1, 2, 3], Symbol('x')]) {
    assert.throws(() => base64urlEncode(bad), TypeError, String(typeof bad));
  }
});

test('base64urlDecode accepts only canonical unpadded base64url', () => {
  const bad = {
    'padding': 'Zg==',
    'plus': 'ab+c',
    'slash': 'ab/c',
    'space inside': 'Zm 9v',
    'newline': 'Zm9v\n',
    'leading space': ' Zm9v',
    'impossible length (1 mod 4)': 'Zm9vY',
    'single char': 'A',
    'non-ascii': 'Zm9é',
    'non-zero trailing bits (2 chars)': 'Zh',        // would decode to the same byte as 'Zg'
    'non-zero trailing bits (3 chars)': 'Zm9',
    'dollar': 'Zm$v',
    'nul': 'Zm\u0000v',
  };
  for (const [label, input] of Object.entries(bad)) {
    assert.throws(() => base64urlDecode(input), TypeError, label);
  }
  for (const input of [undefined, null, 5, {}, Uint8Array.of(1), ['Zg']]) {
    assert.throws(() => base64urlDecode(input), TypeError);
  }
});

test('base64url handles a large payload without stack or length problems', () => {
  const big = randomBytes(300_000);
  const encoded = base64urlEncode(big);
  assert.equal(encoded, big.toString('base64url'));
  assert.deepEqual(Buffer.from(base64urlDecode(encoded)), big);
});

test('every 1- and 2-byte input round-trips and no other spelling of the same bytes decodes', () => {
  for (const len of [1, 2]) {
    for (let v = 0; v < 256; v++) {
      const bytes = len === 1 ? Uint8Array.of(v) : Uint8Array.of(v, 255 - v);
      const canonical = base64urlEncode(bytes);
      assert.deepEqual(base64urlDecode(canonical), bytes);
      const last = canonical[canonical.length - 1];
      for (const other of 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_') {
        if (other === last) continue;
        const variant = canonical.slice(0, -1) + other;
        let decoded = null;
        try { decoded = base64urlDecode(variant); } catch { /* rejected: fine */ }
        if (decoded) assert.notDeepEqual(decoded, bytes, `${variant} must not alias ${canonical}`);
      }
    }
  }
});

// ---- verifyEnvelope: happy path -----------------------------------------------------------------------------------

test('verifyEnvelope accepts a correctly signed envelope and returns the payload', async () => {
  assert.deepEqual(await verifyEnvelope(ENVELOPE, A.publicJwk), { ok: true, payload: PAYLOAD });
  assert.equal(ENVELOPE.sig.length, 86, '64 bytes -> 86 base64url chars');
  assert.equal(base64urlDecode(ENVELOPE.sig).length, SIGNATURE_BYTES);
  assert.deepEqual(Object.keys(ENVELOPE).sort(), ['kid', 'payload', 'sig']);
});

test('verifyEnvelope accepts empty, unicode, NUL-containing and 200 KB payloads', async () => {
  for (const payload of ['', '\u0000', 'é✓🎬', 'a\u0000b\r\n\t', 'x'.repeat(200_000)]) {
    const envelope = await signEnvelope(payload, A.privateJwk, 'test-1');
    assert.deepEqual(await verifyEnvelope(envelope, A.publicJwk), { ok: true, payload });
  }
});

test('verifyEnvelope ignores unrelated envelope members and unrelated JWK members', async () => {
  const noisy = { ...ENVELOPE, extra: { a: 1 }, version: 3 };
  const jwk = { ...A.publicJwk, alg: 'ES256', use: 'sig', key_ops: ['sign'], ext: false };
  assert.equal((await verifyEnvelope(noisy, jwk)).ok, true);
});

test('a public JWK without a kid verifies any envelope kid; one with a kid pins it', async () => {
  const { kid, ...noKid } = A.publicJwk;
  assert.equal(kid, 'test-1');
  const other = { ...ENVELOPE, kid: 'anything-9' };
  assert.equal((await verifyEnvelope(other, noKid)).ok, true, 'kid is only checked when the key declares one');
  await assertRejects(other, A.publicJwk, 'kid-mismatch', 'declared kid pins the envelope kid');
});

// ---- verifyEnvelope: interop with an independent implementation ---------------------------------------------------

test('a signature made by node:crypto (IEEE-P1363) verifies; ours verifies in node:crypto', async () => {
  const payload = '{"kat":true,"text":"café ✓"}';
  const pub = { kty: 'EC', crv: 'P-256', x: 'bs5IckVOXyWo4wz-GB_PhO1tWzTvbt9MfqEhcON1Fkw', y: 'y5dAw25lYO5v6tvOTHyZaE895ktB03EOtPaZL7WFq10' };
  const sig = '2eXCJ6M0gKHNI2iIEMFeMJv_mxenPX9-BGVhshKxVEpUhR1N2EDPaH6883O47C4QevFZ-h8eNCC5MmDEEE5Hfg';
  assert.deepEqual(await verifyEnvelope({ payload, sig, kid: 'kat' }, pub), { ok: true, payload }, 'known-answer vector from node:crypto');
  await assertRejects({ payload: payload.replace('true', 'fals'), sig, kid: 'kat' }, pub, 'bad-signature', 'KAT with altered payload');

  // fresh signature from node:crypto over the same bytes the extension verifies
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const text = 'node-made ✓ payload';
  const nodeSig = createSign('SHA256').update(text, 'utf8').sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const jwk = publicKey.export({ format: 'jwk' });
  assert.equal((await verifyEnvelope({ payload: text, sig: nodeSig, kid: 'n' }, jwk)).ok, true);

  // and the other direction: our signature checks out in node:crypto, as raw r||s
  const mine = await signEnvelope(text, A.privateJwk, 'test-1');
  const { kid: ignoredKid, ...bareJwk } = A.publicJwk;
  const nodeKey = createPublicKey({ key: bareJwk, format: 'jwk' });
  assert.equal(createVerify('SHA256').update(text, 'utf8').verify({ key: nodeKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(mine.sig, 'base64url')), true);
  assert.equal(createVerify('SHA256').update(`${text}!`, 'utf8').verify({ key: nodeKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(mine.sig, 'base64url')), false);
});

test('signatures are over the payload string, not over a parsed or normalised form', async () => {
  const pretty = '{\n  "a": 1\n}';
  const envelope = await signEnvelope(pretty, A.privateJwk, 'test-1');
  await assertRejects({ ...envelope, payload: JSON.stringify(JSON.parse(pretty)) }, A.publicJwk, 'bad-signature', 're-serialised JSON');
  await assertRejects({ ...envelope, payload: `${pretty} ` }, A.publicJwk, 'bad-signature', 'trailing space');
  await assertRejects({ ...envelope, payload: pretty.replace(/\n/g, '\r\n') }, A.publicJwk, 'bad-signature', 'CRLF');
  const decomposed = await signEnvelope('café', A.privateJwk, 'test-1');
  await assertRejects({ ...decomposed, payload: 'café' }, A.publicJwk, 'bad-signature', 'NFC vs NFD');
});

// ---- verifyEnvelope: rejects everything else, never throws --------------------------------------------------------

test('non-object envelopes are rejected as malformed', async () => {
  for (const bad of [undefined, null, 0, 1, '', 'abc', true, [], [ENVELOPE], () => ENVELOPE, Symbol('e'), 1n]) {
    await assertRejects(bad, A.publicJwk, 'malformed-envelope', String(typeof bad));
  }
});

test('missing or wrongly typed envelope fields are rejected', async () => {
  for (const field of ['payload', 'sig', 'kid']) {
    const copy = { ...ENVELOPE };
    delete copy[field];
    await assertRejects(copy, A.publicJwk, null, `missing ${field}`);
  }
  for (const bad of [undefined, null, 5, true, {}, [], ['x'], Uint8Array.of(1, 2), new String('x')]) {
    await assertRejects({ ...ENVELOPE, payload: bad }, A.publicJwk, 'bad-payload', `payload ${typeof bad}`);
    await assertRejects({ ...ENVELOPE, sig: bad }, A.publicJwk, 'bad-signature', `sig ${typeof bad}`);
    await assertRejects({ ...ENVELOPE, kid: bad }, A.publicJwk, 'bad-kid', `kid ${typeof bad}`);
  }
  await assertRejects({ ...ENVELOPE, sig: '' }, A.publicJwk, 'bad-signature', 'empty sig');
  await assertRejects({ ...ENVELOPE, kid: '' }, A.publicJwk, 'bad-kid', 'empty kid');
  await assertRejects({}, A.publicJwk, null, 'empty object');
});

test('bad signature encodings are rejected', async () => {
  const bad = {
    'not base64': 'not base64!!',
    'padded': `${ENVELOPE.sig}==`,
    'standard alphabet': ENVELOPE.sig.replace(/-/g, '+').replace(/_/g, '/') + (ENVELOPE.sig.includes('-') || ENVELOPE.sig.includes('_') ? '' : '+'),
    'whitespace inside': `${ENVELOPE.sig.slice(0, 10)} ${ENVELOPE.sig.slice(10)}`,
    'trailing newline': `${ENVELOPE.sig}\n`,
    'single char': 'A',
    // same 64 bytes as the real signature, spelled with the padding bits set: a lenient decoder would accept it
    'non-canonical alias of the valid signature': ENVELOPE.sig.slice(0, -1) + ALPHABET[(ALPHABET.indexOf(ENVELOPE.sig.at(-1)) & ~3) | 1],
  };
  for (const [label, sig] of Object.entries(bad)) {
    await assertRejects({ ...ENVELOPE, sig }, A.publicJwk, 'bad-signature', label);
  }
});

test('wrong-length signatures are rejected: truncated, extended, zeroed', async () => {
  const raw = base64urlDecode(ENVELOPE.sig);
  const variants = {
    'one char short': ENVELOPE.sig.slice(0, -1),
    'half': ENVELOPE.sig.slice(0, 43),
    '63 bytes': base64urlEncode(raw.subarray(0, 63)),
    '65 bytes': base64urlEncode(Uint8Array.from([...raw, 0])),
    '96 bytes (DER-sized)': base64urlEncode(Uint8Array.from([...raw, ...raw.subarray(0, 32)])),
    'doubled': ENVELOPE.sig + ENVELOPE.sig,
    '64 zero bytes': base64urlEncode(new Uint8Array(64)),
    'r = 0': base64urlEncode(Uint8Array.from([...new Uint8Array(32), ...raw.subarray(32)])),
    's = 0': base64urlEncode(Uint8Array.from([...raw.subarray(0, 32), ...new Uint8Array(32)])),
    '64 x 0xff': base64urlEncode(new Uint8Array(64).fill(255)),
  };
  for (const [label, sig] of Object.entries(variants)) {
    await assertRejects({ ...ENVELOPE, sig }, A.publicJwk, 'bad-signature', label);
  }
});

test('every single flipped bit of the signature is rejected (all 512)', async () => {
  const raw = base64urlDecode(ENVELOPE.sig);
  for (let bit = 0; bit < raw.length * 8; bit++) {
    const flipped = raw.slice();
    flipped[bit >> 3] ^= 1 << (bit & 7);
    const result = await verifyEnvelope({ ...ENVELOPE, sig: base64urlEncode(flipped) }, A.publicJwk);
    assert.equal(result.ok, false, `bit ${bit}`);
    assert.equal(result.reason, 'bad-signature', `bit ${bit}`);
  }
});

test('any single changed payload character is rejected', async () => {
  for (let i = 0; i < PAYLOAD.length; i += 3) {
    const tampered = PAYLOAD.slice(0, i) + String.fromCharCode(PAYLOAD.charCodeAt(i) ^ 1) + PAYLOAD.slice(i + 1);
    if (!isWellFormed(tampered)) continue;
    await assertRejects({ ...ENVELOPE, payload: tampered }, A.publicJwk, 'bad-signature', `payload char ${i}`);
  }
  await assertRejects({ ...ENVELOPE, payload: PAYLOAD.slice(1) }, A.publicJwk, 'bad-signature', 'truncated head');
  await assertRejects({ ...ENVELOPE, payload: PAYLOAD.slice(0, -1) }, A.publicJwk, 'bad-signature', 'truncated tail');
  await assertRejects({ ...ENVELOPE, payload: `${PAYLOAD}\n` }, A.publicJwk, 'bad-signature', 'appended');
  await assertRejects({ ...ENVELOPE, payload: ` ${PAYLOAD}` }, A.publicJwk, 'bad-signature', 'prepended');
  await assertRejects({ ...ENVELOPE, payload: '' }, A.publicJwk, 'bad-signature', 'emptied');
});

test('a payload swapped between two validly signed envelopes is rejected', async () => {
  const other = await signEnvelope('{"mapVersion":"9999"}', A.privateJwk, 'test-1');
  await assertRejects({ ...ENVELOPE, payload: other.payload }, A.publicJwk, 'bad-signature');
  await assertRejects({ ...other, sig: ENVELOPE.sig }, A.publicJwk, 'bad-signature');
});

test('a lone surrogate cannot stand in for the U+FFFD that was actually signed', async () => {
  const signed = await signEnvelope('price: �5', A.privateJwk, 'test-1');
  assert.equal((await verifyEnvelope(signed, A.publicJwk)).ok, true);
  // UTF-8 encoding would turn the lone surrogate into the very same bytes, so without the guard this would verify.
  await assertRejects({ ...signed, payload: 'price: \ud8005' }, A.publicJwk, 'bad-payload', 'lone high surrogate');
  await assertRejects({ ...signed, payload: 'price: \udc005' }, A.publicJwk, 'bad-payload', 'lone low surrogate');
  await assert.rejects(signEnvelope('bad \ud800', A.privateJwk, 'test-1'), TypeError);
  assert.equal(isWellFormed('ok 🎬'), true);
  assert.equal(isWellFormed('\ud83c'), false);
  assert.equal(isWellFormed('\udfac\ud83c'), false);
  assert.equal(isWellFormed('\ud83c🎬'), false);
  assert.equal(isWellFormed(42), false);
});

test('wrong kid, wrong key and wrong purpose are rejected', async () => {
  await assertRejects({ ...ENVELOPE, kid: 'test-2' }, A.publicJwk, 'kid-mismatch', 'wrong kid');
  await assertRejects({ ...ENVELOPE, kid: 'TEST-1' }, A.publicJwk, 'kid-mismatch', 'kid is case sensitive');
  await assertRejects({ ...ENVELOPE, kid: ' test-1' }, A.publicJwk, 'kid-mismatch', 'kid is not trimmed');
  await assertRejects(ENVELOPE, B.publicJwk, 'bad-signature', 'same kid, different key');
  const licence = await newKeyPair('licence-1');
  const map = await newKeyPair('selector-map-1');
  const signedByLicence = await signEnvelope(PAYLOAD, licence.privateJwk, 'selector-map-1');
  await assertRejects(signedByLicence, map.publicJwk, 'bad-signature', 'licence key must not satisfy the map key');
});

test('invalid public keys are rejected as bad-key, including a private JWK', async () => {
  const { x, y } = A.publicJwk;
  const bad = {
    'null': null,
    'undefined': undefined,
    'string': 'not a key',
    'empty': {},
    'array': [A.publicJwk],
    'wrong kty': { ...A.publicJwk, kty: 'RSA' },
    'wrong curve': { ...A.publicJwk, crv: 'P-384' },
    'missing x': { kty: 'EC', crv: 'P-256', y },
    'missing y': { kty: 'EC', crv: 'P-256', x },
    'numeric x': { kty: 'EC', crv: 'P-256', x: 5, y },
    'short x': { kty: 'EC', crv: 'P-256', x: x.slice(0, 20), y },
    'long y': { kty: 'EC', crv: 'P-256', x, y: `${y}AAAA` },
    'bad base64 in x': { kty: 'EC', crv: 'P-256', x: `${x.slice(0, 40)}!!!`, y },
    'padded x': { kty: 'EC', crv: 'P-256', x: `${x}=`, y },
    'point not on the curve': { kty: 'EC', crv: 'P-256', x, y: base64urlEncode(new Uint8Array(32).fill(7)) },
    'private key (has d)': A.privateJwk,
    'public with empty d': { ...A.publicJwk, d: '' },
  };
  for (const [label, jwk] of Object.entries(bad)) {
    await assertRejects(ENVELOPE, jwk, 'bad-key', label);
  }
});

test('verifyEnvelope and verifySignature never throw on hostile objects', async () => {
  const boom = () => { throw new Error('boom'); };
  const hostileEnvelope = new Proxy({}, { get: boom, has: boom, ownKeys: boom });
  const hostileKey = new Proxy({}, { get: boom, has: boom, ownKeys: boom });
  const getterEnvelope = Object.defineProperty({ sig: ENVELOPE.sig, kid: 'test-1' }, 'payload', { get: boom, enumerable: true });
  for (const [label, envelope, jwk] of [
    ['proxy envelope', hostileEnvelope, A.publicJwk],
    ['proxy key', ENVELOPE, hostileKey],
    ['throwing getter', getterEnvelope, A.publicJwk],
  ]) {
    const result = await verifyEnvelope(envelope, jwk);
    assert.equal(result.ok, false, label);
  }
  assert.equal((await verifySignature('x', 'AAAA', hostileKey)).ok, false);
  assert.equal((await verifySignature(Symbol('x'), ENVELOPE.sig, A.publicJwk)).ok, false);
  assert.equal((await verifySignature(undefined, ENVELOPE.sig, A.publicJwk)).ok, false);
});

test('fuzz: 400 random garbage envelopes and keys are all rejected without throwing', async () => {
  const next = prng(1234);
  const pick = (list) => list[Math.floor(next() * list.length)];
  const junkString = () => Array.from({ length: Math.floor(next() * 90) }, () => String.fromCharCode(Math.floor(next() * 0x250))).join('');
  const junk = () => pick([
    undefined, null, 0, -1, NaN, 1e308, true, [], {}, junkString(), junkString(), `${ENVELOPE.payload}x`,
    ENVELOPE.sig.slice(0, Math.floor(next() * 86)), base64urlEncode(randomBytes(Math.floor(next() * 100))), [junkString()], { a: junkString() },
  ]);
  for (let i = 0; i < 400; i++) {
    const envelope = pick([null, undefined, junk(), { payload: junk(), sig: junk(), kid: junk() }, { payload: ENVELOPE.payload, sig: junk(), kid: 'test-1' },
      { payload: junk(), sig: ENVELOPE.sig, kid: 'test-1' }]);
    const jwk = pick([A.publicJwk, A.publicJwk, junk(), { kty: junk(), crv: junk(), x: junk(), y: junk() }]);
    const result = await verifyEnvelope(envelope, jwk);
    assert.equal(result.ok, false, `case ${i}: ${JSON.stringify(envelope)?.slice(0, 80)}`);
    assert.equal(typeof result.reason, 'string');
  }
});

test('without WebCrypto the answer is a rejection, not a crash', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  try {
    Object.defineProperty(globalThis, 'crypto', { value: undefined, configurable: true, writable: true });
    await assertRejects(ENVELOPE, A.publicJwk, 'crypto-unavailable', 'no crypto');
    Object.defineProperty(globalThis, 'crypto', { value: {}, configurable: true, writable: true });
    await assertRejects(ENVELOPE, A.publicJwk, 'crypto-unavailable', 'no subtle');
  } finally {
    if (original) Object.defineProperty(globalThis, 'crypto', original);
  }
  assert.equal((await verifyEnvelope(ENVELOPE, A.publicJwk)).ok, true, 'crypto restored');
});

test('verifyEnvelope does not mutate its arguments', async () => {
  const envelope = Object.freeze({ ...ENVELOPE });
  const jwk = Object.freeze({ ...A.publicJwk });
  assert.equal((await verifyEnvelope(envelope, jwk)).ok, true);
});

// ---- signing helpers ----------------------------------------------------------------------------------------------

test('signPayload / signEnvelope refuse bad input and produce randomised but valid signatures', async () => {
  const one = await signPayload('same', A.privateJwk);
  const two = await signPayload('same', A.privateJwk);
  assert.notEqual(one, two, 'ECDSA is randomised');
  assert.equal((await verifySignature('same', one, A.publicJwk)).ok, true);
  assert.equal((await verifySignature(new TextEncoder().encode('same'), two, A.publicJwk)).ok, true, 'bytes and string agree');
  await assert.rejects(signPayload('x', A.publicJwk), TypeError, 'a public JWK cannot sign');
  await assert.rejects(signPayload('x', null), TypeError);
  await assert.rejects(signPayload('x', { ...A.privateJwk, crv: 'P-384' }), TypeError);
  await assert.rejects(signEnvelope(5, A.privateJwk, 'k'), TypeError);
  await assert.rejects(signEnvelope('x', A.privateJwk, ''), TypeError);
  await assert.rejects(signEnvelope('x', A.privateJwk, undefined), TypeError);
});

test('toPublicJwk drops the private part and every other member, and keeps a kid when known', () => {
  const pub = toPublicJwk({ ...A.privateJwk, alg: 'ES256', key_ops: ['sign'] });
  assert.deepEqual(pub, { kty: 'EC', crv: 'P-256', x: A.privateJwk.x, y: A.privateJwk.y, kid: 'test-1' });
  assert.ok(!('d' in pub));
  assert.deepEqual(toPublicJwk(A.privateJwk, 'other'), { ...pub, kid: 'other' });
  const noKid = toPublicJwk({ kty: 'EC', crv: 'P-256', x: pub.x, y: pub.y });
  assert.ok(!('kid' in noKid));
  assert.throws(() => toPublicJwk(null), TypeError);
  assert.throws(() => toPublicJwk({ kty: 'RSA' }), TypeError);
});

// ---- compareMapVersions -------------------------------------------------------------------------------------------

test('compareMapVersions compares segments as numbers, not as text', () => {
  assert.equal(compareMapVersions('2026.10.07.1', '2026.10.07.1'), 0);
  assert.equal(compareMapVersions('2026.10.07.2', '2026.10.07.1'), 1);
  assert.equal(compareMapVersions('2026.10.07.1', '2026.10.07.2'), -1);
  assert.equal(compareMapVersions('2026.10.07.10', '2026.10.07.9'), 1, '10 > 9 although "10" < "9" as text');
  assert.equal(compareMapVersions('2026.10.08.1', '2026.10.07.99'), 1);
  assert.equal(compareMapVersions('2027.1.1.1', '2026.12.31.99'), 1);
  assert.equal(compareMapVersions('2026.10.07', '2026.10.07.0'), 0, 'missing segments count as 0');
  assert.equal(compareMapVersions('2026.10.07', '2026.10.07.1'), -1);
  assert.equal(compareMapVersions('2026.10.07.01', '2026.10.07.1'), 0, 'leading zeros are the same number');
});

test('compareMapVersions answers NaN for anything that is not a dotted numeric version', () => {
  for (const bad of [undefined, null, 5, '', '.', '1.', '.1', '1..2', 'a.b', '1.2.x', '1.2-3', ' 1.2', '1.2 ', '1e3', '-1', '1,2',
    '1234567890.1', '1.2.3.4.5.6.7.8.9', {}, ['1.2']]) {
    assert.ok(Number.isNaN(compareMapVersions(bad, '1.0')), `left ${JSON.stringify(bad)}`);
    assert.ok(Number.isNaN(compareMapVersions('1.0', bad)), `right ${JSON.stringify(bad)}`);
  }
});
